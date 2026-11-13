/**
 * 打开之后取消归档。
 *
 * 背景：DSH 的归档集合（`workspaceRegistry.archivedSessionIds`）是 `agent/pre-step`
 * gate 读的那一份。会话在里头时文件在、工作区也认，但唤醒会被挡下——用户看到的就是
 * 「点了打开没反应」。所以导入成功后顺手把 id 从集合里摘掉。
 *
 * 三个边界必须成立：
 * - 宿主没装 workspace 插件时不能报错，只能少做一件事；
 * - 没归档时调用是幂等的，不许写盘、也不许把 `unarchived` 说成 true；
 * - 取服务或写状态失败只回一个字段，导入本身照常成功（包已经落盘了）。
 *
 * 全部在临时目录里跑（自己设 DSH_HOME），不碰真实的 ~/.dsh。
 * 运行：node test/archive.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { createHash, randomUUID } from 'node:crypto';
import { apply, unarchiveInDsh, zipWrite } from '../index.js';

let failed = 0;
const ok = (label, detail) => console.log(`✅ ${label}${detail === undefined ? '' : ` · ${detail}`}`);
const bad = (label, detail) => {
  failed += 1;
  console.error(`✗ ${label}${detail === undefined ? '' : ` · ${detail}`}`);
};
const check = (condition, label, detail) => (condition ? ok(label, detail) : bad(label, detail));

/* ── 隔离的运行根 ── */
const BASE = fs.mkdtempSync(path.join(os.tmpdir(), 'dshss-arch-'));
const DSH_HOME = path.join(BASE, 'dsh');
const SESSIONS = path.join(DSH_HOME, 'sessions');
const STORAGE = path.join(DSH_HOME, 'storages');
const OUT = path.join(BASE, 'out');
for (const dir of [SESSIONS, STORAGE, OUT]) fs.mkdirSync(dir, { recursive: true });
process.env.DSH_HOME = DSH_HOME;

const ZSTD = { params: { [zlib.constants.ZSTD_c_checksumFlag]: 1 } };
const frame = (text) => zlib.zstdCompressSync(Buffer.from(text, 'utf8'), ZSTD);
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
  });

/** 造一个最小 .dsproj（只有 header 一帧）。 */
function buildPackage(sessionId, cwd) {
  const log = frame(`${headerOf(sessionId, cwd)}\n`);
  const manifest = {
    format: 'dshproj/1',
    exportedAt: new Date().toISOString(),
    exportedBy: 'dshproj on test',
    session: { id: sessionId, cwd, createdAt: 1792340086210, frames: 1, lines: 1, bytes: log.length },
    memorySlug: '--demo--',
    memoryFiles: [],
    workspaceFiles: [],
    parts: { 'session/session.v4.jsonl.zstd': { sha256: createHash('sha256').update(log).digest('hex'), bytes: log.length } },
  };
  return zipWrite([
    { name: 'manifest.json', data: Buffer.from(JSON.stringify(manifest), 'utf8') },
    { name: 'session/session.v4.jsonl.zstd', data: log, store: true },
  ]);
}

/** 记一次 host 侧假 registry：默认幂等、默认真把 id 摘掉。 */
function makeRegistry(archived, options = {}) {
  const state = {
    archivedSessionIds: [...archived],
    calls: [],
    async unarchiveSession(sessionId) {
      state.calls.push(sessionId);
      if (options.throwOn === true) throw new Error('写状态失败：磁盘只读');
      state.archivedSessionIds = state.archivedSessionIds.filter((id) => id !== sessionId);
    },
  };
  return state;
}

/** 挂一套路由，`get(name)` 只认 workspaceRegistry。 */
function mount(registry) {
  const routes = new Map();
  const ctx = {
    get: (name) => (name === 'workspaceRegistry' ? registry : undefined),
    connection: {
      fetch: {
        register: (spec) => {
          routes.set(spec.path, spec.fetch);
        },
      },
    },
  };
  apply(ctx);
  return routes;
}

async function call(handler, route, query) {
  const url = new URL(`http://127.0.0.1:3080${route}?${new URLSearchParams(query).toString()}`);
  const response = await handler(new Request(url, { headers: new Headers() }));
  const buffer = Buffer.from(await response.arrayBuffer());
  let body;
  try {
    body = JSON.parse(buffer.toString('utf8'));
  } catch {
    body = undefined;
  }
  return { status: response.status, body };
}

/* ── 1. 纯函数层：三种边界 ── */
check(typeof unarchiveInDsh === 'function', 'unarchiveInDsh 是导出的');

const noService = await unarchiveInDsh({}, 'session-x');
check(noService.skipped === 'no-service', '没有 workspaceRegistry 时不报错，只跳过', JSON.stringify(noService));

const notArchived = makeRegistry([]);
const plain = await unarchiveInDsh({ get: () => notArchived }, 'session-a');
check(plain.unarchived === false, '没归档时 unarchived 是 false', JSON.stringify(plain));
check(notArchived.calls.length === 1, '没归档也照样调一次（接口本身幂等）', String(notArchived.calls.length));

const archived = makeRegistry(['session-b', 'session-other']);
const restored = await unarchiveInDsh({ get: () => archived }, 'session-b');
check(restored.unarchived === true, '在归档集合里时 unarchived 是 true', JSON.stringify(restored));
check(archived.calls[0] === 'session-b', '传过去的就是这条会话 id', archived.calls[0]);
check(!archived.archivedSessionIds.includes('session-b'), '归档集合里已经没有它了', archived.archivedSessionIds.join(','));
check(archived.archivedSessionIds.includes('session-other'), '别的会话一个没动', archived.archivedSessionIds.join(','));

const broken = makeRegistry(['session-c'], { throwOn: true });
const failedWrite = await unarchiveInDsh({ get: () => broken }, 'session-c');
check(typeof failedWrite.error === 'string' && failedWrite.error.includes('磁盘只读'), '写状态失败只回一个 error 字段', failedWrite.error);

/* ── 2. 路由层：打开成功后带上 archive 报告 ── */
const sessionId = `session-${randomUUID()}`;
const pkg = path.join(OUT, 'arch.dsproj');
fs.writeFileSync(pkg, buildPackage(sessionId, OUT));

const registry = makeRegistry([sessionId]);
const routes = mount(registry);
const open = routes.get('/api/session.open');
check(open !== undefined, '打开路由已注册');

const first = await call(open, '/api/session.open', { path: pkg, mode: 'auto', cwd: OUT, contextBudget: '0' });
check(first.status === 200 && first.body?.status === 'opened', '打开成功后导入照常完成', `HTTP ${first.status}`);
check(first.body?.archive?.unarchived === true, '返回体带上 archive.unarchived=true', JSON.stringify(first.body?.archive));
check(registry.calls.includes(sessionId), '取消归档收到的是刚落盘的那条会话', registry.calls.join(','));

const second = await call(open, '/api/session.open', { path: pkg, mode: 'auto', cwd: OUT, contextBudget: '0' });
check(second.status === 200, '再打开同一个包仍然成功', `HTTP ${second.status}`);
check(second.body?.archive?.unarchived === false, '第二次不在归档集合里，报告 false', JSON.stringify(second.body?.archive));

/* ── 3. 宿主没有这个服务：打开不能因此失败 ── */
const bareRoutes = (() => {
  const map = new Map();
  apply({
    connection: {
      fetch: {
        register: (spec) => {
          map.set(spec.path, spec.fetch);
        },
      },
    },
  });
  return map;
})();
const bareOpen = bareRoutes.get('/api/session.open');
const bare = await call(bareOpen, '/api/session.open', { path: pkg, mode: 'auto', cwd: OUT, contextBudget: '0' });
check(bare.status === 200 && bare.body?.status === 'opened', '没有 workspaceRegistry 时打开照样 200', `HTTP ${bare.status}`);
check(bare.body?.archive?.skipped === 'no-service', '只是在报告里注明跳过', JSON.stringify(bare.body?.archive));

/* ── 4. 客户端静态：读了报告，也有中英文案 ── */
const clientSource = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8');
check(clientSource.includes("payload.archive?.unarchived === true"), '客户端会读 archive.unarchived');
check(
  clientSource.split("archiveRestored:").length - 1 === 1,
  '中文兜底表里有 archiveRestored',
  String(clientSource.split("archiveRestored:").length - 1),
);
const zh = JSON.parse(fs.readFileSync(new URL('../locales/zh-CN.json', import.meta.url), 'utf8'));
const en = JSON.parse(fs.readFileSync(new URL('../locales/en-US.json', import.meta.url), 'utf8'));
check(
  typeof zh.archiveRestored === 'string' && typeof en.archiveRestored === 'string',
  '两份语言包都有 archiveRestored',
  `${zh.archiveRestored} / ${en.archiveRestored}`,
);

/* ── 收拾 ── */
fs.rmSync(BASE, { recursive: true, force: true });
check(!fs.existsSync(BASE), '临时目录已清理');

if (failed > 0) {
  console.error(`\n${failed} 条失败`);
  process.exit(1);
}
console.log('\narchive 自检通过');
