/*
 * 安全审计第 4 轮：CHANGELOG「已知边界」里五条遗留缺陷的常驻回归（F80–F84）。
 *
 * 每条断言都能独立变红——把实现改回旧版，对应那一行就会失败：
 *   F80  全解路径（estimateContext / trimSession）累计到上限就停，报「包太大」而不是「包坏了」；
 *   F81  末帧被截断（缺 checksum）不再被当成「正好覆盖到文件末尾」；
 *   F82  状态文件只在返回体成型之后提交，而且只动本次会话的键；
 *   F83  isInside 比解析后的路径：链接逃出 root 要判否，合法的 junction 工作区照旧判是；
 *   F84  记忆来自另一个工作区时，返回体带出 memoryForeign 与实际落点。
 *
 * 全部在临时目录里跑（fixture 自建 DSH_HOME），不碰真实的 ~/.dsh。
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
const {
  OPEN_ROUTE,
  projectKey,
  estimateContext,
  trimSession,
  repairSession,
  rewriteHeader,
  scanZstdFrames,
  scanZstdFramesDetailed,
  isInside,
  zipWrite,
} = mod;
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

const ZSTD_FRAME_OPTS = { params: { [zlib.constants.ZSTD_c_checksumFlag]: 1 } };
const frameOf = (text) => zlib.zstdCompressSync(Buffer.from(text, 'utf8'), ZSTD_FRAME_OPTS);
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const OUT = path.join(fx.base, 'out');
fs.mkdirSync(OUT, { recursive: true });
// 保存/打开只认「用过的目录」，先把 lastDir 指到临时输出目录。
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

const thrownOf = (fn) => {
  try {
    fn();
    return undefined;
  } catch (error) {
    return error;
  }
};

const headerOf = (id, cwd) =>
  JSON.stringify({
    type: 'session',
    version: 4,
    id,
    createdAt: 1792340086210,
    cwd,
    isSeeded: false,
    delegationDepth: 0,
    agentPreset: 'standard',
  }) + '\n';

/** 造一个包：session + 可选记忆条目，manifest.parts 与内容同步。 */
const buildPackage = ({ sessionId, log, cwd, memory = [] }) => {
  const sessionName = 'session/session.v4.jsonl.zstd';
  const manifest = {
    format: 'dshproj/1',
    exportedAt: new Date().toISOString(),
    exportedBy: 'audit-r4',
    session: { id: sessionId, version: 4, cwd, createdAt: 1792340086210, fileName: 'session.v4.jsonl.zstd', frames: 1, lines: 1, bytes: log.length },
    memoryFiles: memory.map((entry) => entry.name),
  };
  const parts = { [sessionName]: { sha256: sha256(log), bytes: log.length } };
  for (const entry of memory) parts[entry.name] = { sha256: sha256(entry.data), bytes: entry.data.length };
  manifest.parts = parts;
  return zipWrite([
    { name: 'manifest.json', data: Buffer.from(JSON.stringify(manifest, null, 2), 'utf8') },
    { name: sessionName, data: log, store: true },
    ...memory,
  ]);
};

const writePackage = (name, bytes) => {
  const file = path.join(OUT, `${name}-${randomUUID()}.dsproj`);
  fs.writeFileSync(file, bytes);
  return file;
};

/* ── F80：全解路径的累计上限 ─────────────────────────────────────────── */
{
  const id = `session-${randomUUID()}`;
  const chunk = (mark) => frameOf(JSON.stringify({ type: 'message', mark, text: 'x'.repeat(1500) }) + '\n');
  const log = Buffer.concat([frameOf(headerOf(id, fx.cwd)), chunk('a'), chunk('b'), chunk('c')]);

  const over = thrownOf(() => estimateContext(log, { maxBytes: 1200 }));
  check(over !== undefined, 'F80 estimateContext 累计超上限时抛错', String(over?.code ?? 'no-throw'));
  check(over?.code === 'E_LOG_TOO_LARGE', 'F80 报错带独立 code，能被上层与「包坏了」分开', String(over?.code ?? ''));
  check(
    String(over?.message ?? '').includes('太大') && String(over?.message ?? '').includes('不是文件损坏'),
    'F80 文案说清「包太大，不是坏了」',
    String(over?.message ?? '').slice(0, 40),
  );
  check(
    String(over?.message ?? '').includes('已停止读取'),
    'F80 文案说明已经停下，不是静默截断',
  );

  const overTrim = thrownOf(() => trimSession(log, { budget: 150000, maxBytes: 1200 }));
  check(overTrim?.code === 'E_LOG_TOO_LARGE', 'F80 trimSession 同样受累计上限约束', String(overTrim?.code ?? 'no-throw'));

  // 正常包不能被误杀：默认额度下三帧全解出来。
  const okEstimate = estimateContext(log);
  check(
    okEstimate.frames === 4 && okEstimate.bytes > 4000,
    'F80 默认额度下正常多帧包照常估算',
    `${okEstimate.frames} 帧 / ${okEstimate.bytes} 字节`,
  );
  const okTrim = thrownOf(() => trimSession(log, { budget: 150000 }));
  check(okTrim === undefined, 'F80 默认额度下 trimSession 不抛错', String(okTrim?.code ?? ''));
}

/* ── F81：末帧缺 checksum 必须如实报截断 ─────────────────────────────── */
{
  const id = `session-${randomUUID()}`;
  const a = frameOf(headerOf(id, fx.cwd));
  const b = frameOf(JSON.stringify({ type: 'turn/start', turn: 1 }) + '\n');
  const intact = Buffer.concat([a, b]);
  // 砍掉末帧最后 4 字节：那正是 checksum。以前扫描把 end 夹回文件末尾，看起来「覆盖完整」。
  const truncated = intact.subarray(0, intact.length - 4);

  const intactScan = scanZstdFramesDetailed(intact);
  check(intactScan.frames.length === 2 && intactScan.truncated === false, 'F81 完好的日志：两帧、无截断标记');

  const cut = scanZstdFramesDetailed(truncated);
  check(cut.frames.length === 1, 'F81 被砍掉 checksum 的末帧不再计入帧表', `${cut.frames.length} 帧`);
  check(cut.truncated === true, 'F81 识别出末帧不完整', String(cut.truncated));
  check(
    scanZstdFrames(truncated).length === 1,
    'F81 旧的帧边界接口照样只返回完整帧',
  );

  const repaired = repairSession(truncated);
  check(repaired.report.frames.truncated === true, 'F81 体检报告带出 truncated 标记');
  check(repaired.report.frames.total === 1, 'F81 体检报告的帧数不含半截帧', String(repaired.report.frames.total));

  const rewrite = thrownOf(() => rewriteHeader(truncated, { id: `${id}-x` }));
  check(
    String(rewrite?.message ?? '').includes('不完整') && String(rewrite?.message ?? '').includes('截断'),
    'F81 覆盖率闸拒绝重写，且说清末帧被截断',
    String(rewrite?.message ?? '').slice(0, 30),
  );
}

/* ── F82：状态文件只在成功路径提交 ──────────────────────────────────── */
{
  const brokenId = `session-${randomUUID()}`;
  const log = frameOf(headerOf(brokenId, fx.cwd));
  const manifest = {
    format: 'dshproj/1',
    session: { id: brokenId, version: 4, cwd: fx.cwd, createdAt: 1792340086210, fileName: 'session.v4.jsonl.zstd', frames: 1, lines: 1 },
    // 故意写错的 sha：过不了 verifyPackage。
    parts: { 'session/session.v4.jsonl.zstd': { sha256: 'deadbeef'.repeat(8), bytes: log.length } },
  };
  const broken = writePackage(
    'broken',
    zipWrite([
      { name: 'manifest.json', data: Buffer.from(JSON.stringify(manifest), 'utf8') },
      { name: 'session/session.v4.jsonl.zstd', data: log, store: true },
    ]),
  );
  const bad = await call(openRoute, OPEN_ROUTE, { path: broken, cwd: fx.cwd });
  const stateAfterFail = JSON.parse(fs.readFileSync(path.join(fx.home, 'storages', 'session-save.json'), 'utf8'));
  check(bad.body?.status === 'package-broken', 'F82 校验失败的包 → package-broken', String(bad.body?.status ?? ''));
  check(
    stateAfterFail.paths?.[brokenId] === undefined,
    'F82 校验失败后状态里没有这个会话的 paths 条目',
    JSON.stringify(Object.keys(stateAfterFail.paths ?? {})),
  );

  // 成功路径：来源与指纹都要落到状态里。指纹是旧实现会在 handleOpen 尾部被旧快照抹掉的字段。
  const okId = `session-${randomUUID()}`;
  const okLog = frameOf(headerOf(okId, fx.cwd));
  const okFile = writePackage('ok', buildPackage({ sessionId: okId, log: okLog, cwd: fx.cwd }));
  const opened = await call(openRoute, OPEN_ROUTE, { path: okFile, cwd: fx.cwd });
  check(opened.body?.status === 'opened', 'F82 正常包能打开', String(opened.body?.status ?? ''));
  const stateAfterOk = JSON.parse(fs.readFileSync(path.join(fx.home, 'storages', 'session-save.json'), 'utf8'));
  check(stateAfterOk.paths?.[okId] === okFile, 'F82 成功打开后记住包路径', String(stateAfterOk.paths?.[okId] ?? ''));
  check(
    stateAfterOk.stamps?.[okId]?.sha256 === sha256(fs.readFileSync(okFile)),
    'F82 成功打开后记下包内容指纹（旧实现会被打开前的快照抹掉）',
    String(stateAfterOk.stamps?.[okId]?.sha256 ?? 'missing'),
  );

  // 只动本次会话的键：导入期间别的会话那条不能被整表覆盖抹掉。
  const other = `session-${randomUUID()}`;
  const before = JSON.parse(fs.readFileSync(path.join(fx.home, 'storages', 'session-save.json'), 'utf8'));
  before.paths[other] = 'C:/somewhere/other.dsproj';
  before.lastDir = OUT;
  fs.writeFileSync(path.join(fx.home, 'storages', 'session-save.json'), JSON.stringify(before));
  const okId2 = `session-${randomUUID()}`;
  const okLog2 = frameOf(headerOf(okId2, fx.cwd));
  const okFile2 = writePackage('ok2', buildPackage({ sessionId: okId2, log: okLog2, cwd: fx.cwd }));
  await call(openRoute, OPEN_ROUTE, { path: okFile2, cwd: fx.cwd });
  const scoped = JSON.parse(fs.readFileSync(path.join(fx.home, 'storages', 'session-save.json'), 'utf8'));
  check(scoped.paths?.[other] === 'C:/somewhere/other.dsproj', 'F82 别的会话的键原样保留');
  check(scoped.paths?.[okId2] === okFile2, 'F82 本次会话的键写进去了');
}

/* ── F83：isInside 比解析后的路径，但不误杀合法 junction ──────────────── */
{
  const lab = path.join(fx.base, 'r4-link');
  const realRoot = path.join(lab, 'real-root');
  const outside = path.join(lab, 'outside');
  fs.mkdirSync(path.join(realRoot, 'sub'), { recursive: true });
  fs.mkdirSync(outside, { recursive: true });

  // ① root 自己是链接（本机插件与工作区就常是 junction）：合法落点必须判是。
  const linkedRoot = path.join(lab, 'linked-root');
  let linked = true;
  try {
    fs.symlinkSync(realRoot, linkedRoot, 'junction');
  } catch {
    linked = false;
  }
  check(linked, 'F83 能建 junction（Windows 上不需要管理员）');
  if (linked) {
    check(
      isInside(linkedRoot, path.join(linkedRoot, 'sub', 'MEMORY.md')) === true,
      'F83 root 自己是链接时，root 内的落点仍判是',
    );
    check(
      isInside(linkedRoot, path.join(linkedRoot, 'sub')) === true,
      'F83 root 自己是链接时，已存在的子目录仍判是',
    );
  }

  // ② dest 自己是链接，指向 root 内的目录：解析后仍在里面，判是。
  const alias = path.join(realRoot, 'alias');
  let aliased = true;
  try {
    fs.symlinkSync(path.join(realRoot, 'sub'), alias, 'junction');
  } catch {
    aliased = false;
  }
  check(aliased, 'F83 能在 root 内建指向 root 内的链接');
  if (aliased) {
    check(isInside(realRoot, path.join(alias, 'MEMORY.md')) === true, 'F83 dest 是链接但仍在 root 内 → 判是');
  }

  // ③ dest 经链接逃出 root：字面路径在里面，真实落点在外面。必须判否。
  const jump = path.join(realRoot, 'jump');
  let jumped = true;
  try {
    fs.symlinkSync(outside, jump, 'junction');
  } catch {
    jumped = false;
  }
  check(jumped, 'F83 能在 root 内建指向外部的链接');
  if (jumped) {
    check(
      isInside(realRoot, path.join(jump, 'pwned.md')) === false,
      'F83 dest 经链接逃出 root → 判否（旧实现只看字面路径，会判是）',
    );
  }

  check(isInside(realRoot, realRoot) === false, 'F83 root 自身不算「之内」');
  check(isInside(realRoot, path.join(lab, 'elsewhere.md')) === false, 'F83 平级目录判否');
}

/* ── F84：跨工作区的记忆必须在返回体里说出来 ─────────────────────────── */
{
  const otherSlug = '--r4-other-workspace--';
  const foreignId = `session-${randomUUID()}`;
  const foreignLog = frameOf(headerOf(foreignId, fx.cwd));
  const foreignFile = writePackage(
    'foreign',
    buildPackage({
      sessionId: foreignId,
      log: foreignLog,
      cwd: fx.cwd,
      memory: [{ name: `memory/workspaces/${otherSlug}/MEMORY.md`, data: Buffer.from('# 别人的笔记\n', 'utf8') }],
    }),
  );
  const foreign = await call(openRoute, OPEN_ROUTE, { path: foreignFile, cwd: fx.cwd, memory: 'restore' });
  check(foreign.body?.status === 'opened', 'F84 带别工区记忆的包能打开', String(foreign.body?.status ?? ''));
  check(foreign.body?.memoryForeign === true, 'F84 memoryForeign 标出「这次写的是别的工区」', String(foreign.body?.memoryForeign));
  check(foreign.body?.memoryForeignSlug === otherSlug, 'F84 返回体带出包里的 slug', String(foreign.body?.memoryForeignSlug ?? ''));
  const foreignDir = String(foreign.body?.memoryDir ?? '');
  check(
    foreignDir !== '' && path.dirname(foreignDir) === path.join(fx.home, 'memory', 'workspaces'),
    'F84 同时带出实际落点（本机工作区记忆目录下）',
    foreignDir,
  );

  // 同一个工作区：不许误报。slug 取本机解析出来的那个目录名 ——
  // 另一台机器上同一工作区的记忆目录就是这个名字，包里记的也是它。
  const sameId = `session-${randomUUID()}`;
  const sameLog = frameOf(headerOf(sameId, fx.cwd));
  const sameDir = path.basename(foreignDir);
  const sameFile = writePackage(
    'same',
    buildPackage({
      sessionId: sameId,
      log: sameLog,
      cwd: fx.cwd,
      memory: [{ name: `memory/workspaces/${sameDir}/MEMORY.md`, data: Buffer.from('# 本工区笔记\n', 'utf8') }],
    }),
  );
  const same = await call(openRoute, OPEN_ROUTE, { path: sameFile, cwd: fx.cwd, memory: 'restore' });
  check(same.body?.status === 'opened', 'F84 同工区的包能打开', String(same.body?.status ?? ''));
  check(same.body?.memoryForeign === false, 'F84 同工区不误报 memoryForeign', String(same.body?.memoryForeign));
}

console.log(`\n共 ${passed + failed} 条：${passed} 过，${failed} 败`);
assert.equal(failed, 0, `有 ${failed} 条断言失败`);
