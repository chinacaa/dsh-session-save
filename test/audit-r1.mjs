/**
 * 安全审计第 1 轮（AUDIT-R1.md）的常驻回归：F1–F7 每条都能独立变红。
 *
 * 这些用例不是「再跑一遍正常流程」，而是把报告里实测过的攻击/损坏形态固化下来：
 * RLE 帧扫描、炸弹覆盖率闸、0 字节残留、ADS/尾点/设备名、保存路径不自建目录、
 * relocate 后 bili 不写原槽位、header.id 形态。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { createHash, randomUUID } from 'node:crypto';

import { autoCleanup, loadRoutes, makeFixture } from './fixture.mjs';

const fx = makeFixture();
autoCleanup(fx);

const { mod, routes } = await loadRoutes('../index.js');
const { ROUTE, OPEN_ROUTE, zipRead, zipWrite, scanZstdFrames, rewriteHeader } = mod;
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
// 保存只认「用过的目录」，先把 lastDir 指到临时输出目录，seed 包才存得下去。
fs.mkdirSync(path.join(fx.home, 'storages'), { recursive: true });
fs.writeFileSync(
  path.join(fx.home, 'storages', 'session-save.json'),
  JSON.stringify({ paths: {}, lastDir: OUT, autosave: {}, stamps: {}, stale: {}, missing: {} }),
);

const call = async (handler, route, query = {}) => {
  const search = new URLSearchParams(query);
  const url = `http://127.0.0.1:3080${route}${search.toString() === '' ? '' : '?' + search.toString()}`;
  const request = new Request(url, { headers: { origin: 'http://127.0.0.1:3080' } });
  const response = await handler(request);
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

/** 造一个合法包（走 saveRoute），再把 session 日志与记忆条目换掉，parts 重算。 */
const buildPackage = async ({ log, memory = [], id }) => {
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
  manifest.parts = {};
  for (const [name, data] of entries) {
    if (/^(session\/|memory\/workspaces\/|attachments\/)/.test(name) !== true) continue;
    manifest.parts[name] = { sha256: createHash('sha256').update(data).digest('hex'), bytes: data.length };
  }
  entries.set('manifest.json', Buffer.from(JSON.stringify(manifest), 'utf8'));

  const out = path.join(OUT, `probe-${randomUUID()}.dsproj`);
  fs.writeFileSync(
    out,
    zipWrite([...entries].map(([name, data]) => ({ name, data }))),
  );
  return out;
};

/* ── F1：RLE 块载荷恒 1 字节，扫描不能错位 ── */
{
  const rle = zlib.zstdCompressSync(Buffer.alloc(300 * 1024, 0x20), ZSTD_OPTS);
  const frames = scanZstdFrames(rle);
  check(frames.length === 1, 'F1 含 300KB 连续空格的 RLE 帧能被认出来', `frames=${frames.length}`);
  check(
    frames.length === 1 && frames[0].end === rle.length,
    'F1 RLE 帧扫描覆盖到字节末尾',
    frames.length === 1 ? `${frames[0].end}/${rle.length}` : '-',
  );

  const id = `session-${randomUUID()}`;
  const three = Buffer.concat([frameOf(header(id, 'C:\\demo')), rle, frameOf('{"type":"turn/end"}\n')]);
  const scanned = scanZstdFrames(three);
  check(scanned.length === 3, 'F1 三帧日志（中间是 RLE）扫出三帧', `frames=${scanned.length}`);

  const rewritten = rewriteHeader(three, { id: `session-${randomUUID()}` });
  const after = scanZstdFrames(rewritten.buffer);
  check(after.length === 3, 'F1 重写 header 后正文帧没被丢掉', `frames=${after.length}`);
  check(
    rewritten.buffer.length > rle.length,
    'F1 重写后的长度不小于原正文帧',
    `${three.length} -> ${rewritten.buffer.length}`,
  );
}

/* ── F2：扫描不完整时拒写；炸弹不许当坏帧吞掉 ── */
{
  const id = `session-${randomUUID()}`;
  const truncated = Buffer.concat([frameOf(header(id, 'C:\\demo')), Buffer.from([0x28, 0xb5, 0x2f, 0xfd])]);
  let threw;
  try {
    rewriteHeader(truncated, { id: `session-${randomUUID()}` });
  } catch (error) {
    threw = String(error?.message ?? error);
  }
  check(typeof threw === 'string' && threw.includes('不完整'), 'F2 帧扫描不完整时拒绝重写', String(threw));

  // 7 KB 的包，正文帧解开 200 MB：以前扫描认不出 → 体检当没事 → 原样落盘。
  const bombLog = Buffer.concat([
    frameOf(header(`session-${randomUUID()}`, 'C:\\demo')),
    zlib.zstdCompressSync(Buffer.alloc(200 * 1024 * 1024, 0x20), ZSTD_OPTS),
  ]);
  const bombPkg = await buildPackage({ log: bombLog });
  const opened = await call(openRoute, OPEN_ROUTE, { path: bombPkg, cwd: OUT });
  check(opened.status !== 200, 'F2 解压炸弹包被拒绝', `HTTP ${opened.status} ${opened.body?.status ?? ''}`);

  const sessionsDir = path.join(fx.home, 'sessions');
  const leftovers = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.size === 0) leftovers.push(full);
    }
  };
  if (fs.existsSync(sessionsDir)) walk(sessionsDir);
  check(leftovers.length === 0, 'F3 导入失败后不留 0 字节会话文件', leftovers.length === 0 ? '' : leftovers[0]);
}

/* ── F4：记忆条目名不许是 ADS / 尾点 / 设备名 ── */
{
  const slug = '--audit--';
  for (const [name, label] of [
    [`memory/workspaces/${slug}/MEMORY.md:audit`, 'F4 ADS（冒号）'],
    [`memory/workspaces/${slug}/MEMORY.md.`, 'F4 尾点'],
    [`memory/workspaces/${slug}/NUL`, 'F4 设备名'],
  ]) {
    const pkg = await buildPackage({
      log: Buffer.concat([frameOf(header(`session-${randomUUID()}`, OUT)), frameOf('{"type":"turn/end"}\n')]),
      memory: [[name, 'x']],
    });
    const opened = await call(openRoute, OPEN_ROUTE, { path: pkg, cwd: OUT, memory: 'new' });
    check(opened.status !== 200, `${label} 被拒绝`, `HTTP ${opened.status}`);
  }
}

/* ── F5：保存到不存在的多级目录不许自动建 ── */
{
  const deep = path.join(OUT, 'a', 'b', 'c', 'orphan.dsproj');
  const saved = await call(saveRoute, ROUTE, { sessionId: fx.session.id, path: deep, force: '1' });
  check(saved.status !== 200, 'F5 保存到不存在的目录被拒绝', `HTTP ${saved.status}`);
  check(!fs.existsSync(path.join(OUT, 'a')), 'F5 没有把 a/b/c 建出来');
}

/* ── F6：relocate 之后 bili 状态不写回原槽位 ── */
{
  const id = `session-${randomUUID()}`;
  const log = Buffer.concat([frameOf(header(id, 'C:\\elsewhere')), frameOf('{"type":"turn/end"}\n')]);
  const pkg = await buildPackage({ log, id });
  const opened = await call(openRoute, OPEN_ROUTE, { path: pkg, cwd: OUT });
  check(opened.status === 200, 'F6 换工作区能打开', `HTTP ${opened.status}`);
  const bili = opened.body?.bili;
  check(
    bili === undefined || bili.reason !== 'ok',
    'F6 relocate 之后不按原 id 写 bili 状态',
    JSON.stringify(bili),
  );
}

/* ── F7：header.id 必须是会话 id 形态 ── */
{
  const log = Buffer.concat([frameOf(header('__proto__', OUT)), frameOf('{"type":"turn/end"}\n')]);
  const pkg = await buildPackage({ log, id: '__proto__' });
  const opened = await call(openRoute, OPEN_ROUTE, { path: pkg, cwd: OUT });
  check(opened.status !== 200, 'F7 header.id 不是会话 id 时拒绝导入', `HTTP ${opened.status}`);
}

fs.rmSync(path.join(fx.home, 'out'), { recursive: true, force: true });

if (failed > 0) {
  console.error(`\n✗ audit-r1 自检失败：${failed} 条`);
  process.exit(1);
}
console.log(`\n✅ audit-r1 自检通过（${passed} 条）`);
