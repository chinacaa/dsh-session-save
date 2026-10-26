/**
 * 测试夹具：在临时目录里自建一个 DSH_HOME 和一份人造会话。
 *
 * 为什么需要它：
 *   smoke / open / conflict 三套测试原来靠扫描 `~/.dsh/sessions` 找「本机恰好存在的真实会话」。
 *   这个前提在干净机器上不成立（干净 runner 的 sessions 目录不存在 → readdirSync 抛 ENOENT /
 *   报「本机没有会话文件可测」），而本机因为攒了很多会话反而看不出问题。
 *   测试不该依赖运行环境里「碰巧有什么」，所以这里自己造一份。
 *
 * 用法：
 *   import { makeFixture } from './fixture.mjs';
 *   const fx = makeFixture();          // 建临时 DSH_HOME + 会话，并设好 process.env.DSH_HOME
 *   fx.home                            // 临时 DSH_HOME 绝对路径
 *   fx.session                         // { id, project, dir, file, size, header }
 *   fx.writeSession({ id, createdAt }) // 再造一份会话（冲突用例用）
 *   fx.cleanup()                       // 删掉整个临时根
 *
 * 顺序很重要：index.js 在模块顶层读 DSH_HOME 决定数据根，所以测试里必须
 * 「先 import 本模块 → 调 makeFixture() → 再 import '../index.js'」。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { randomUUID } from 'node:crypto';

/** zstd 帧参数：带 checksum，与 DSH 真实写出的帧一致。 */
const ZSTD_OPTS = { params: { [zlib.constants.ZSTD_c_checksumFlag]: 1 } };

/** 压缩一帧（会话日志是「多帧 zstd 顺序追加」，不是一个流）。 */
const frame = (text) => zlib.zstdCompressSync(Buffer.from(text, 'utf8'), ZSTD_OPTS);

/**
 * 项目目录名 —— 必须和 index.js 里的 projectKey() **逐字一致**，
 * 否则 findSessionFile() 扫不到夹具会话，open 会误判成「本机没有这个会话」。
 */
const projectKeyOf = (cwd) => {
  const raw = String(cwd ?? '');
  if (raw === '') return '_no-cwd';
  const folded = raw.replace(/[/\\:]+/g, '-').replace(/^-+/, '');
  let safe = '';
  for (const ch of folded) {
    if (/[A-Za-z0-9._-]/.test(ch)) safe += ch;
    else safe += '~' + ch.codePointAt(0).toString(16).toUpperCase().padStart(4, '0');
  }
  return `--${safe.slice(0, 251).replace(/-+$/, '')}--`;
};

/** 会话 header。字段对齐 DSH v4 会话格式。 */
const headerOf = (id, cwd, createdAt) =>
  JSON.stringify({
    type: 'session',
    version: 4,
    id,
    createdAt,
    cwd,
    isSeeded: false,
    delegationDepth: 0,
    agentPreset: 'standard',
  });

/** 一段事件体：含 turn 起止和两条消息，足够读出标题与行数。 */
const eventsOf = (mark) => {
  const at = 1792340086211;
  return `${[
    JSON.stringify({ type: 'turn/start', at, turn: 1 }),
    JSON.stringify({
      type: 'message',
      at: at + 1,
      role: 'user',
      content: [{ type: 'text', text: `fixture 会话 ${mark}` }],
    }),
    JSON.stringify({
      type: 'message',
      at: at + 2,
      role: 'assistant',
      content: [{ type: 'text', text: 'fixture 应答' }],
    }),
    JSON.stringify({ type: 'turn/end', at: at + 3, turn: 1 }),
  ].join('\n')}\n`;
};

/**
 * 建一个临时 DSH_HOME 并写入一份会话。
 * @param {{ extraSessions?: number, mark?: string, cwd?: string }} [opts]
 */
export function makeFixture(opts = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'dshss-fx-'));
  const home = path.join(base, 'dsh');
  const sessions = path.join(home, 'sessions');
  const memory = path.join(home, 'memory', 'workspaces');
  const storages = path.join(home, 'storages');
  const out = path.join(base, 'out');
  for (const dir of [sessions, memory, storages, out]) fs.mkdirSync(dir, { recursive: true });

  process.env.DSH_HOME = home;

  /**
   * cwd 必须是**本机真实存在的目录**：index.js 的 landingCwd() 会检查它，
   * 不存在就换成 process.cwd()，「保存 → 打开」链上 cwd 对不上，「复用现有会话」会假失败。
   * 默认用临时根自己（一定存在，且不是当前工作区）。
   */
  const cwd = opts.cwd ?? base;

  const writeSession = ({
    id = `session-${randomUUID()}`,
    sessionCwd = cwd,
    createdAt = 1792340086210,
    bodyFrames = 2,
    mark = 'main',
  } = {}) => {
    const project = projectKeyOf(sessionCwd);
    const dir = path.join(sessions, project, id);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'session.v4.jsonl.zstd');
    const parts = [frame(`${headerOf(id, sessionCwd, createdAt)}\n`)];
    for (let i = 0; i < bodyFrames; i += 1) parts.push(frame(eventsOf(`${mark}#${i}`)));
    const buf = Buffer.concat(parts);
    fs.writeFileSync(file, buf);
    return { id, project, dir, file, size: buf.length, header: JSON.parse(headerOf(id, sessionCwd, createdAt)) };
  };

  const session = writeSession({ mark: opts.mark ?? 'main' });
  const extras = [];
  for (let i = 0; i < (opts.extraSessions ?? 0); i += 1) extras.push(writeSession({ mark: `extra${i}` }));

  return {
    base,
    home,
    sessions,
    memory,
    storages,
    out,
    cwd,
    session,
    extras,
    writeSession,
    /** 删掉整个临时根。 */
    cleanup() {
      try {
        fs.rmSync(base, { recursive: true, force: true });
      } catch {
        /* 临时目录清不掉不影响判定 */
      }
    },
  };
}

/**
 * 进程退出时自动删临时根 —— 测试中途失败（或忘了调 fx.cleanup()）也不留垃圾。
 * 健壮性：只挂一次，且不在 handler 里随便抛。
 */
export function autoCleanup(fx) {
  let done = false;
  const once = () => {
    if (done) return;
    done = true;
    fx.cleanup();
  };
  process.once('exit', once);
  process.once('SIGINT', () => {
    once();
    process.exit(130);
  });
  process.once('SIGTERM', () => {
    once();
    process.exit(143);
  });
  return once;
}

/** 造一个「这个 DSH_HOME 里不存在」的会话 id。 */
export const freshSessionId = () => `session-${randomUUID()}`;
/**
 * 挂上 index.js 的真实路由处理器。
 *
 * index.js 注册的是 `{ path, methods, requestBody, fetch }` 整个 spec 对象，
 * 真正的处理函数在 `spec.fetch` 上 —— 别把 spec 本身当 handler 调。
 */
export async function loadRoutes(indexPath = '../index.js') {
  const mod = await import(indexPath);
  const routes = new Map();
  mod.apply({
    connection: {
      fetch: {
        register: (spec) => {
          routes.set(spec.path, spec.fetch);
        },
      },
    },
  });
  return { mod, routes };
}
