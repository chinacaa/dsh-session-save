/**
 * 安全回归：审计报告（AUDIT.md）里那几条「能被远程请求或恶意包打穿」的洞。
 *
 * 全部在临时目录里跑（自己设 DSH_HOME），不碰真实的 ~/.dsh。
 * 运行：node test/security.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { randomUUID } from 'node:crypto';
import { apply, zipRead, zipWrite } from '../index.js';

let failed = 0;
const ok = (label, detail) => console.log(`✅ ${label}${detail === undefined ? '' : ` · ${detail}`}`);
const bad = (label, detail) => {
  failed += 1;
  console.error(`✗ ${label}${detail === undefined ? '' : ` · ${detail}`}`);
};
const check = (condition, label, detail) => (condition ? ok(label, detail) : bad(label, detail));

/* ── 隔离的运行根 ── */
const BASE = fs.mkdtempSync(path.join(os.tmpdir(), 'dshss-sec-'));
const DSH_HOME = path.join(BASE, 'dsh');
const SESSIONS = path.join(DSH_HOME, 'sessions');
const MEMORY = path.join(DSH_HOME, 'memory', 'workspaces');
const STORAGE = path.join(DSH_HOME, 'storages');
const OUT = path.join(BASE, 'out');
for (const dir of [SESSIONS, MEMORY, STORAGE, OUT]) fs.mkdirSync(dir, { recursive: true });
process.env.DSH_HOME = DSH_HOME;

const ZSTD = { params: { [zlib.constants.ZSTD_c_checksumFlag]: 1 } };
const frame = (text) => zlib.zstdCompressSync(Buffer.from(text, 'utf8'), ZSTD);
const headerOf = (id, cwd = 'C:\\demo') =>
  JSON.stringify({
    type: 'session',
    version: 4,
    id,
    createdAt: 1792340086210,
    cwd,
    isSeeded: false,
    delegationDepth: 0,
    agentPreset: 'standard',
  });

/* ── 抓路由 ── */
const routes = new Map();
apply({
  connection: {
    fetch: {
      register: (spec) => {
        routes.set(spec.path, spec.fetch);
      },
    },
  },
});
const save = routes.get('/api/session.save');
const open = routes.get('/api/session.open');
const autosave = routes.get('/api/session.autosave');
const workspaces = routes.get('/api/session.workspaces');
check(
  save !== undefined && open !== undefined && autosave !== undefined && workspaces !== undefined,
  '四条路由都已注册',
  `${routes.size} 条`,
);

/** 以「浏览器在回环地址上」的身份调路由。传 host 可以假装别的站点来。 */
const call = async (handler, route, query, host = '127.0.0.1:3080') => {
  const url = new URL(`http://${host}${route}?${new URLSearchParams(query).toString()}`);
  const response = await handler(new Request(url));
  let body;
  try {
    body = await response.json();
  } catch {
    body = undefined;
  }
  return { status: response.status, body };
};

const write = (file, data) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, data);
};

/** 造一个最小的 .dsproj：只有 header 一帧。 */
function buildPackage({ sessionId, fileName, entryName = undefined, cwd = 'C:\\demo', memory = [] }) {
  const log = frame(`${headerOf(sessionId, cwd)}\n`);
  const manifest = {
    format: 'dshproj/1',
    exportedAt: new Date().toISOString(),
    exportedBy: 'dshproj on test',
    session: {
      id: sessionId,
      version: 4,
      cwd,
      createdAt: 1792340086210,
      fileName,
      frames: 1,
      lines: 1,
      bytes: log.length,
    },
    memoryFiles: memory.map(([name]) => name),
  };
  const entries = [
    { name: 'manifest.json', data: Buffer.from(JSON.stringify(manifest, null, 2), 'utf8') },
    { name: entryName ?? `session/${fileName}`, data: log, store: true },
    ...memory.map(([name, data]) => ({ name, data })),
  ];
  return zipWrite(entries);
}

const exists = (file) => {
  try {
    fs.statSync(file);
    return true;
  } catch {
    return false;
  }
};

/* ── V1：ZIP Slip ───────────────────────────────────────────────── */
{
  const escape = '../../pwned-by-dsproj.txt';
  const pkg = buildPackage({
    sessionId: `session-${randomUUID()}`,
    fileName: 'session.v4.jsonl.zstd',
    memory: [[`memory/workspaces/--demo--/${escape}`, Buffer.from('pwned', 'utf8')]],
  });
  const escapeTarget = path.resolve(MEMORY, '--demo--', escape);

  let threw = false;
  try {
    zipRead(pkg);
  } catch {
    threw = true;
  }
  check(threw, 'V1 带 .. 的条目名在读包阶段就被拒绝');

  const file = path.join(BASE, 'slip.dsproj');
  write(file, pkg);
  const opened = await call(open, '/api/session.open', { path: file });
  check(opened.status === 500, 'V1 导入返回失败', `HTTP ${opened.status}`);
  check(!exists(escapeTarget), 'V1 目标目录外没有出现文件', escapeTarget);
  check(!exists(path.join(MEMORY, 'pwned-by-dsproj.txt')), 'V1 记忆目录里也没有残留文件');
}

/* ── V2：manifest.session.fileName 穿越 ─────────────────────────── */
{
  const sessionId = `session-${randomUUID()}`;
  // 条目名本身是正常的，坏的是 manifest 里声明的落盘文件名 —— 这才是真实的攻击形状。
  const pkg = buildPackage({
    sessionId,
    fileName: '..\\..\\pwned-by-filename.jsonl',
    entryName: 'session/session.v4.jsonl.zstd',
  });
  const file = path.join(BASE, 'filename.dsproj');
  write(file, pkg);

  const opened = await call(open, '/api/session.open', { path: file, cwd: OUT });
  check(opened.status === 200, 'V2 恶意 fileName 的包仍可打开（文件名被收敛）', `HTTP ${opened.status}`);
  const target = String(opened.body?.target ?? '');
  const insideSessions = target !== '' && path.resolve(target).startsWith(path.resolve(SESSIONS) + path.sep);
  check(insideSessions, 'V2 落点仍在 sessions 根里', target);
  check(!exists(path.join(BASE, 'pwned-by-filename.jsonl')), 'V2 上层目录没有出现文件');
  check(!exists(path.join(SESSIONS, 'pwned-by-filename.jsonl')), 'V2 sessions 根也没有散落文件');
}

/* ── V3：解压炸弹 ───────────────────────────────────────────────── */
{
  const sessionId = `session-${randomUUID()}`;
  const pkg = buildPackage({ sessionId, fileName: 'session.v4.jsonl.zstd' });
  // 直接把中央目录里那条 session 条目的 usize 改成 200MB：
  // 解压前的尺寸检查必须先炸，不能真的去 inflate 200MB。
  const eocd = pkg.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = pkg.readUInt16LE(eocd + 10);
  let p = pkg.readUInt32LE(eocd + 16);
  let patched = false;
  for (let i = 0; i < count; i += 1) {
    const nlen = pkg.readUInt16LE(p + 28);
    const elen = pkg.readUInt16LE(p + 30);
    const clen = pkg.readUInt16LE(p + 32);
    const name = pkg.toString('utf8', p + 46, p + 46 + nlen);
    if (name.startsWith('session/')) {
      pkg.writeUInt32LE(200 * 1024 * 1024, p + 24);
      patched = true;
      break;
    }
    p += 46 + nlen + elen + clen;
  }
  check(patched, 'V3 准备好带假 usize 的包');

  const started = Date.now();
  let message = '';
  let threw = false;
  try {
    zipRead(pkg);
  } catch (error) {
    threw = true;
    message = String(error?.message ?? error);
  }
  const spent = Date.now() - started;
  check(threw, 'V3 200MB 的条目在解压前被拒绝', message);
  check(spent < 1500, 'V3 没有真的去解压（耗时正常）', `${spent} ms`);

  const file = path.join(BASE, 'bomb.dsproj');
  write(file, pkg);
  const opened = await call(open, '/api/session.open', { path: file, cwd: OUT });
  check(opened.status === 500, 'V3 通过路由打开同样失败', `HTTP ${opened.status}`);
  check(!String(opened.body?.message ?? '').includes(file), 'V3 错误响应里没有回显绝对路径');
}

/* ── V6：open 只收 .dsproj，且不回显路径 ────────────────────────── */
{
  const notPackage = path.join(BASE, 'notes.txt');
  write(notPackage, 'hello');
  const rejected = await call(open, '/api/session.open', { path: notPackage });
  check(rejected.status === 400, 'V6 非 .dsproj 直接拒绝', `HTTP ${rejected.status}`);

  const missing = path.join(BASE, 'nope.dsproj');
  const gone = await call(open, '/api/session.open', { path: missing });
  check(gone.status === 404, 'V6 不存在的文件报 404', `HTTP ${gone.status}`);
  check(!JSON.stringify(gone.body ?? {}).includes(missing), 'V6 404 响应不回显绝对路径');
}

/* ── V5 + V8：sessionId 形态与跨站请求 ─────────────────────────── */
{
  const weird = await call(save, '/api/session.save', { sessionId: '../../etc/passwd' });
  check(weird.status === 400, 'V5 形态不对的 sessionId 被拒绝', `HTTP ${weird.status}`);

  const crossSite = await call(save, '/api/session.save', { sessionId: `session-${randomUUID()}` }, 'evil.example');
  check(crossSite.status === 403, 'V8 非回环 Host 被拒绝', `HTTP ${crossSite.status}`);

  const crossSiteOpen = await call(open, '/api/session.open', {}, 'evil.example');
  check(crossSiteOpen.status === 403, 'V8 open 路由同样拒绝', `HTTP ${crossSiteOpen.status}`);

  const crossSiteWs = await call(workspaces, '/api/session.workspaces', {}, 'evil.example');
  check(crossSiteWs.status === 403, 'V8 workspaces 路由同样拒绝', `HTTP ${crossSiteWs.status}`);
}

/* ── V4：保存落点必须落在用过的目录里 ──────────────────────────── */
{
  const sessionId = `session-${randomUUID()}`;
  write(path.join(SESSIONS, '--demo--', sessionId, 'session.v4.jsonl.zstd'), frame(`${headerOf(sessionId)}\n`));
  // 记住一个「上次保存目录」，让 OUT 成为合法根。
  write(path.join(STORAGE, 'session-save.json'), JSON.stringify({ lastDir: OUT }, null, 2));

  const outside = path.join(BASE, 'elsewhere', 'x.dsproj');
  const denied = await call(save, '/api/session.save', { sessionId, path: outside });
  check(denied.status === 400, 'V4 目录外的路径被拒绝', `HTTP ${denied.status}`);
  check(!exists(path.join(BASE, 'elsewhere')), 'V4 没有顺手在目录外建树');

  // 覆盖一个不是工程包的同名文件：先要确认，确认了也照样拒绝。
  const foreign = path.join(OUT, 'foreign.dsproj');
  write(foreign, 'not a package');
  const ask = await call(save, '/api/session.save', { sessionId, path: foreign });
  check(ask.status === 409 && ask.body?.status === 'confirm-overwrite', 'V4 覆盖陌生文件要先确认', `HTTP ${ask.status}`);
  const forced = await call(save, '/api/session.save', { sessionId, path: foreign, force: '1' });
  check(forced.status === 409 && forced.body?.status === 'not-dsproj', 'V4 force 也拒绝覆盖非工程包', `HTTP ${forced.status}`);
  check(fs.readFileSync(foreign, 'utf8') === 'not a package', 'V4 那个文件原样没动');

  // 正常路径：写进 OUT 应该成功。
  const fine = path.join(OUT, 'ok.dsproj');
  const saved = await call(save, '/api/session.save', { sessionId, path: fine });
  check(saved.status === 200 && saved.body?.status === 'saved', 'V4 允许目录内的正常保存', `HTTP ${saved.status}`);
  check(exists(fine), 'V4 文件确实写出来了');
  check(saved.body?.memoryFiles === 0 || saved.body?.memoryFiles === undefined, 'V11 默认不打包工作区记忆', String(saved.body?.memoryFiles));

  // 再存一次同一个位置：这是「本会话记住的文件」，不该再要确认。
  const again = await call(save, '/api/session.save', { sessionId });
  check(again.status === 200 && again.body?.status === 'saved', 'V4 记住的路径可以直接覆盖', `HTTP ${again.status}`);
}

/* ── V7：manifest.parts 的哈希被复核 ───────────────────────────── */
{
  const sessionId = `session-${randomUUID()}`;
  const fileName = 'session.v4.jsonl.zstd';
  const log = frame(`${headerOf(sessionId)}\n`);
  const manifest = {
    format: 'dshproj/1',
    exportedAt: new Date().toISOString(),
    session: { id: sessionId, version: 4, cwd: 'C:\\demo', createdAt: 1792340086210, fileName, frames: 1, lines: 1, bytes: log.length },
    parts: { [`session/${fileName}`]: { sha256: 'deadbeef'.repeat(8), bytes: log.length } },
  };
  const pkg = zipWrite([
    { name: 'manifest.json', data: Buffer.from(JSON.stringify(manifest), 'utf8') },
    { name: `session/${fileName}`, data: log, store: true },
  ]);
  const file = path.join(BASE, 'tampered.dsproj');
  write(file, pkg);
  const opened = await call(open, '/api/session.open', { path: file, cwd: OUT });
  check(opened.status === 500, 'V7 内容与 manifest.parts 不符的包被拒绝', `HTTP ${opened.status}`);
}

/* ── 收拾 ──────────────────────────────────────────────────────── */
fs.rmSync(BASE, { recursive: true, force: true });
check(!exists(BASE), '临时目录已清理', BASE);

if (failed > 0) {
  console.error(`\n✗ security 自检失败：${failed} 条`);
  process.exit(1);
}
console.log('\n✅ security 自检通过');
