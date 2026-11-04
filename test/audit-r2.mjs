/**
 * 安全审计第 2 轮（AUDIT-R2.md）的常驻回归。
 *
 * 三条 P1 都是「修复本身带来的新缺陷」：上下文预算对单个超大 turn 失效、按字节卡 255
 * 误拒中文长名、NFC 硬校验拒 macOS 的 NFD 名。这里把它们连同 P2 一起钉住，
 * 并且专门assert「合法包不被误拒」——误拒比放过更糟。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { createHash, randomUUID } from 'node:crypto';

import { autoCleanup, loadRoutes, makeFixture } from './fixture.mjs';

const fx = makeFixture();
autoCleanup(fx);

const { mod, routes } = await loadRoutes('../index.js');
const { ROUTE, OPEN_ROUTE, zipRead, zipWrite, trimSession } = mod;
const saveRoute = routes.get(ROUTE);
const openRoute = routes.get(OPEN_ROUTE);

let passed = 0;
let failed = 0;
const check = (ok, label, extra = '') => {
  if (ok) {
    passed += 1;
    console.log(`✅ ${label}${extra === '' ? '' : ' · ' + extra}`);
  } else {
    failed += 1;
    console.error(`✗ ${label}${extra === '' ? '' : ' · ' + extra}`);
  }
};

const ZSTD_OPTS = { params: { [zlib.constants.ZSTD_c_checksumFlag]: 1 } };
const frameOf = (text) => zlib.zstdCompressSync(Buffer.from(text, 'utf8'), ZSTD_OPTS);
const OUT = path.join(fx.home, 'out');
fs.mkdirSync(OUT, { recursive: true });
fs.mkdirSync(path.join(fx.home, 'storages'), { recursive: true });
fs.writeFileSync(
  path.join(fx.home, 'storages', 'session-save.json'),
  JSON.stringify({ paths: {}, lastDir: OUT, autosave: {}, stamps: {}, stale: {}, missing: {} }),
);

const call = async (handler, route, query = {}) => {
  const search = new URLSearchParams(query);
  const url = `http://127.0.0.1:3080${route}${search.toString() === '' ? '' : '?' + search.toString()}`;
  const response = await handler(new Request(url, { headers: { origin: 'http://127.0.0.1:3080' } }));
  let body;
  try {
    body = await response.json();
  } catch {
    body = undefined;
  }
  return { status: response.status, body };
};

const header = (id, cwd) =>
  JSON.stringify({ type: 'session', version: 4, id, cwd, createdAt: 1792340086210, title: '审计样本' }) + '\n';

const buildPackage = async ({ log, memory = [], id, bili }) => {
  const seedId = id ?? `session-${randomUUID()}`;
  const target = path.join(OUT, `seed-${randomUUID()}.dsproj`);
  const saved = await call(saveRoute, ROUTE, { sessionId: fx.session.id, path: target, force: '1' });
  assert.equal(saved.status, 200, 'seed 包保存失败：' + JSON.stringify(saved.body));

  const entries = zipRead(fs.readFileSync(target));
  const logName = [...entries.keys()].find((name) => /^session\/.+\.jsonl(\.zstd)?$/.test(name));
  entries.set(logName, log);
  for (const [name, data] of memory) entries.set(name, Buffer.from(data));

  const manifest = JSON.parse(entries.get('manifest.json').toString('utf8'));
  manifest.session.id = seedId;
  if (bili !== undefined) manifest.bili = bili;
  manifest.parts = {};
  for (const [name, data] of entries) {
    if (/^(session\/|memory\/workspaces\/|attachments\/|bili\/)/.test(name) !== true) continue;
    manifest.parts[name] = { sha256: createHash('sha256').update(data).digest('hex'), bytes: data.length };
  }
  entries.set('manifest.json', Buffer.from(JSON.stringify(manifest), 'utf8'));

  const out = path.join(OUT, `probe-${randomUUID()}.dsproj`);
  fs.writeFileSync(out, zipWrite([...entries].map(([name, data]) => ({ name, data }))));
  return out;
};

const turn = (seq, body) =>
  [
    JSON.stringify({ type: 'turn/start', seq, time: Date.now(), data: { turn: 1 } }),
    JSON.stringify({ type: 'user/message', seq: seq + 1, time: Date.now(), data: { content: [{ type: 'text', text: body }], role: 'user' } }),
    JSON.stringify({ type: 'turn/end', seq: seq + 2, time: Date.now(), data: { turn: 1 } }),
  ].join('\n') + '\n';

/* ── R2-1：单个超大 turn 也要被预算管住 ── */
{
  const fat = 'x'.repeat(3 * 1024 * 1024);
  const log = Buffer.concat([
    frameOf(header(`session-${randomUUID()}`, 'C:\\demo')),
    frameOf(turn(10, fat)),
  ]);
  const trimmed = trimSession(log, { budget: 100 });
  check(trimmed.report.trimmed === true, 'R2-1 单个巨轮也会被裁', JSON.stringify(trimmed.report));
  check(trimmed.report.oversizeTurn === true, 'R2-1 如实标出「这一轮本身超预算」');
  check(
    trimmed.report.tokensAfter < trimmed.report.tokensBefore,
    'R2-1 裁完 tokensAfter 确实变小',
    `${trimmed.report.tokensBefore} -> ${trimmed.report.tokensAfter}`,
  );

  const twoTurns = Buffer.concat([
    frameOf(header(`session-${randomUUID()}`, 'C:\\demo')),
    frameOf(turn(10, 'small') + turn(20, fat)),
  ]);
  const t2 = trimSession(twoTurns, { budget: 100 });
  check(t2.report.oversizeTurn === true, 'R2-1 尾轮超大时同样标记', JSON.stringify(t2.report));
}

/* ── R2-2 / R2-3：合法名字不许被整包拒 ── */
{
  const long86 = '汉'.repeat(86);
  const long84 = '汉'.repeat(84);
  const nfd = 'e\u0301tude.md';

  for (const [name, label] of [
    [long86, 'R2-2 86 个汉字（258 字节）'],
    [long84, 'R2-2 84 个汉字 + copy 后缀'],
    [nfd, 'R2-3 macOS 的 NFD 文件名'],
  ]) {
    const pkg = await buildPackage({
      log: Buffer.concat([frameOf(header(`session-${randomUUID()}`, OUT)), frameOf(turn(10, 'hi'))]),
      memory: [[`memory/workspaces/--audit--/${name}`, 'x']],
    });
    const opened = await call(openRoute, OPEN_ROUTE, { path: pkg, cwd: OUT, memory: 'copy' });
    check(opened.status === 200, `${label} 不被误拒`, `HTTP ${opened.status} ${opened.body?.status ?? ''}`);
  }
}

/* ── R2-4：bili host 带端口要写进正确槽位 ── */
{
  const id = `session-${randomUUID()}`;
  const state = { id, savedAt: 1, meta: { protocol: 'anthropic', upstreamOrigin: 'https://api.example.com:8443' }, seq: 0 };
  const biliDir = path.join(fx.home, 'bili-sessions', 'anthropic');
  fs.mkdirSync(biliDir, { recursive: true });
  process.env.BILI_SESSIONS_DIR = path.join(fx.home, 'bili-sessions');

  const pkg = await buildPackage({
    log: Buffer.concat([frameOf(header(id, OUT)), frameOf(turn(10, 'hi'))]),
    id,
    memory: [['bili/session.json', JSON.stringify({ plugin: 'billion-context', schema: 3, sessionId: id, state })]],
  });
  const opened = await call(openRoute, OPEN_ROUTE, { path: pkg, cwd: OUT });
  const written = fs.readdirSync(biliDir);
  check(
    opened.body?.bili?.reason === 'bad-host',
    'R2-4 带端口的 host 如实报 bad-host（不静默写错槽位）',
    JSON.stringify(opened.body?.bili),
  );
  check(
    !written.some((name) => name.startsWith('api.deepseek.com_')),
    'R2-4 不再串到默认 host 槽位',
    `HTTP ${opened.status}`,
  );
  delete process.env.BILI_SESSIONS_DIR;
}

/* ── R2-5：失败不留空会话目录 ── */
{
  const bombLog = Buffer.concat([
    frameOf(header(`session-${randomUUID()}`, 'C:\\demo')),
    zlib.zstdCompressSync(Buffer.alloc(200 * 1024 * 1024, 0x20), ZSTD_OPTS),
  ]);
  const pkg = await buildPackage({ log: bombLog });
  const opened = await call(openRoute, OPEN_ROUTE, { path: pkg, cwd: OUT });
  check(opened.status !== 200, 'R2-5 炸弹包仍被拒', `HTTP ${opened.status}`);

  const sessionsDir = path.join(fx.home, 'sessions');
  const emptyDirs = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory() === true) {
        const inner = fs.readdirSync(full);
        if (inner.length === 0) emptyDirs.push(full);
        else walk(full);
      }
    }
  };
  if (fs.existsSync(sessionsDir)) walk(sessionsDir);
  check(emptyDirs.length === 0, 'R2-5 失败后不留空会话目录', emptyDirs.join(',') || '');
}

/* ── R2-6：turn 之间的行不许提到文件开头 ── */
{
  const id = `session-${randomUUID()}`;
  const twoTurns = Buffer.concat([
    frameOf(header(id, 'C:\\demo')),
    frameOf(
      turn(10, 'first') +
        JSON.stringify({ type: 'session/title', seq: 15, time: Date.now(), data: { title: '中途改的标题' } }) + '\n' +
        turn(20, 'second'),
    ),
  ]);
  const trimmed = trimSession(twoTurns, { budget: 30 });
  const text = zlib.zstdDecompressSync(trimmed.buffer).toString('utf8');
  const titleAt = text.indexOf('中途改的标题');
  const lastTurnAt = text.lastIndexOf('turn/start');
  // 标题要么跟着它那一轮被一起裁掉，要么留在 turn 内部；绝不能被提到文件最前面。
  check(titleAt === -1 || titleAt > lastTurnAt, 'R2-6 标题没被提到文件最前面', `${titleAt} vs ${lastTurnAt}`);
}

/* ── R2-7 / F8 / F11：静态判据（这些实现里没有可观察的运行时副作用） ── */
{
  const src = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8');
  check(!src.includes('Atomics.wait('), 'R2-7 restoreBili 不再同步阻塞事件循环');
  check(src.includes("options.scoped"), 'F11 状态写入支持按会话合并');
  check(!/function isDsprojFile[\s\S]{0,600}?fs\.readFileSync\(file\)/.test(src), 'F8 判「是不是包」不再整文件读入');
  check(src.includes('readUInt32LE(eocd + 12)'), 'F8 改为读 EOCD + 中央目录');
  check(src.includes('host.startsWith'), 'F9 host 按 [v6] 形态剥端口');
}

if (failed > 0) {
  console.error(`\n✗ audit-r2 自检失败：${failed} 条`);
  process.exit(1);
}
console.log(`\n✅ audit-r2 自检通过（${passed} 条）`);
