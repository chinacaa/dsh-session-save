/**
 * 打开功能自检：save 出一个包 → open 回本机（应复用现有会话）→
 * open 到新 cwd（应复制一份并改写 header）→ 比对帧、清理残留。
 *
 * 运行：node plugins/dsh-session-save/test/open.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { createHash, randomUUID } from 'node:crypto';
import { apply, scanZstdFrames, zipRead, zipWrite } from '../index.js';

const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
const SESSIONS = path.join(DSH_HOME, 'sessions');
const MEMORY = path.join(DSH_HOME, 'memory', 'workspaces');

const handlers = new Map();
apply({
  connection: {
    fetch: {
      register: (spec) => {
        handlers.set(spec.path, spec.fetch);
      },
    },
  },
});

const save = handlers.get('/api/session.save');
const open = handlers.get('/api/session.open');
if (save === undefined || open === undefined) {
  console.error(`✗ 路由未注册：save=${save !== undefined} open=${open !== undefined}`);
  process.exit(1);
}

const call = async (handler, query) => {
  const url = new URL(`http://127.0.0.1:3080/x?${new URLSearchParams(query).toString()}`);
  const response = await handler(new Request(url));
  return { status: response.status, body: await response.json() };
};

const listDirs = (root) => {
  try {
    return new Set(fs.readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name));
  } catch {
    return new Set();
  }
};

/** 最小会话文件（不够小则用现有的最小者） */
function pickSession() {
  const found = [];
  for (const project of fs.readdirSync(SESSIONS, { withFileTypes: true })) {
    if (!project.isDirectory()) continue;
    const projectDir = path.join(SESSIONS, project.name);
    for (const session of fs.readdirSync(projectDir, { withFileTypes: true })) {
      if (!session.isDirectory()) continue;
      const dir = path.join(projectDir, session.name);
      for (const name of fs.readdirSync(dir)) {
        if (!/^session(\.[0-9A-Za-z]+)?\.jsonl(\.zstd)?$/.test(name)) continue;
        const file = path.join(dir, name);
        found.push({ id: session.name, file, size: fs.statSync(file).size });
      }
    }
  }
  found.sort((a, b) => a.size - b.size);
  return found[0];
}

const decodeFirstLine = (file) => {
  const buf = fs.readFileSync(file);
  const frames = scanZstdFrames(buf);
  const text = zlib.zstdDecompressSync(buf.subarray(frames[0].start, frames[0].end)).toString('utf8');
  return { header: JSON.parse(text.slice(0, text.indexOf('\n'))), frames: frames.length };
};

const sessionsBefore = listDirs(SESSIONS);
const memoryBefore = listDirs(MEMORY);

const target = pickSession();
if (target === undefined) {
  console.error('✗ 本机没有会话文件可测');
  process.exit(1);
}
console.log(`会话：${target.id} · ${(target.size / 1024).toFixed(1)} KB`);

const tmpDir = path.join(os.tmpdir(), `dshss-open-${Date.now()}`);
fs.mkdirSync(tmpDir, { recursive: true });
const pkg = path.join(tmpDir, 'round.dsproj');

// 保存路由只允许写到「上次用的目录」或已记住文件的目录下，测试前把 lastDir 指到本次临时目录，
// 结束时把状态文件恢复原样（原来没有就删掉）。
const stateFile = path.join(DSH_HOME, 'storages', 'session-save.json');
const stateBackup = fs.existsSync(stateFile) ? fs.readFileSync(stateFile, 'utf8') : undefined;
const restoreState = () => {
  if (stateBackup === undefined) fs.rmSync(stateFile, { force: true });
  else fs.writeFileSync(stateFile, stateBackup);
};
{
  const state = stateBackup === undefined ? {} : JSON.parse(stateBackup);
  state.lastDir = tmpDir;
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
}

const failures = [];
const check = (ok, label, detail = '') => {
  console.log(`${ok ? '✅' : '✗'} ${label}${detail === '' ? '' : ` · ${detail}`}`);
  if (!ok) failures.push(label);
};

// 1) 先存一个包
const saved = await call(save, { sessionId: target.id, path: pkg });
check(saved.body.status === 'saved', '保存出包', `${(saved.body.bytes / 1024).toFixed(1)} KB`);

// 2) 打开：本机已有同一会话 → 复用，不复制
const reused = await call(open, { path: pkg });
check(reused.body.status === 'opened', '打开（本机复用）', reused.body.message ?? '');
check(reused.body.reused === true, '判定为复用现有会话');
check(path.resolve(reused.body.target ?? '') === path.resolve(target.file), '指向原会话文件', reused.body.target ?? '');

// 3) 打开到新 cwd → 复制一份并改写 header
const newCwd = path.join(tmpDir, 'landed');
fs.mkdirSync(newCwd, { recursive: true });
const landed = await call(open, { path: pkg, cwd: newCwd });
check(landed.body.status === 'opened', '打开（新 cwd）', landed.body.message ?? '');
check(landed.body.reused !== true, '新 cwd 下不复用');

if (landed.body.status === 'opened') {
  const written = landed.body.target;
  check(fs.existsSync(written), '会话文件已落地', written);
  const src = decodeFirstLine(target.file);
  const dst = decodeFirstLine(written);
  // 本机已有同一会话（同 id + 同 createdAt）时，落到别的工作区会另开一份并换新 id，
  // 因为 id 必须在一个 DSH_HOME 内唯一。
  check(landed.body.renamed === true, '换了新 id（id 需全机唯一）');
  check(landed.body.replacedId === src.header.id, '记录原 id', String(landed.body.replacedId));
  check(dst.header.id === landed.body.sessionId, '文件里的 id 与返回一致', dst.header.id);
  check(dst.header.cwd === newCwd, 'cwd 改写为目标路径', dst.header.cwd);
  check(dst.header.createdAt === src.header.createdAt, 'createdAt 不变');
  check(dst.frames === src.frames, '帧数一致', `${dst.frames} == ${src.frames}`);

  // 帧 1..n 原字节一致（header 帧被重写）
  const a = fs.readFileSync(target.file);
  const b = fs.readFileSync(written);
  const fa = scanZstdFrames(a);
  const fb = scanZstdFrames(b);
  const restA = a.subarray(fa[1].start);
  const restB = b.subarray(fb[1].start);
  check(restA.equals(restB), '帧 1..n 原字节一致', `${restA.length} 字节`);

  // 每帧解压后文本一致
  let sameText = true;
  for (let i = 1; i < Math.min(fa.length, fb.length); i += 1) {
    const ta = zlib.zstdDecompressSync(a.subarray(fa[i].start, fa[i].end));
    const tb = zlib.zstdDecompressSync(b.subarray(fb[i].start, fb[i].end));
    if (!ta.equals(tb)) {
      sameText = false;
      break;
    }
  }
  check(sameText, '帧 1..n 解压内容一致');
  check(typeof landed.body.title === 'string' || landed.body.title === undefined, '能读出标题', String(landed.body.title));
  check((landed.body.stats?.lines ?? 0) > 0, '事件行数可读', `${landed.body.stats?.lines}`);
  // 记忆通道：打开默认是 copy（落副本），只有显式 memory=restore 才落原名
  check(landed.body.memoryMode === 'copy', '默认按 copy 处理记忆', String(landed.body.memoryMode));
  check(landed.body.memoryWritten === 0, '包里没有记忆时不写记忆', String(landed.body.memoryWritten));
}

// 3b) 显式 memory=restore 也要能正常打开（包里没记忆时是空操作，不能报错）
const restoreCwd = path.join(tmpDir, 'restore-mode');
fs.mkdirSync(restoreCwd, { recursive: true });
const restoreRun = await call(open, { path: pkg, cwd: restoreCwd, memory: 'restore' });
check(restoreRun.body.status === 'opened', 'memory=restore 也能打开', restoreRun.body.message ?? '');
check(restoreRun.body.memoryMode === 'restore', 'restore 模式被服务端识别', String(restoreRun.body.memoryMode));
check(restoreRun.body.memoryWritten === 0, 'restore 在没有记忆条目时不写盘', String(restoreRun.body.memoryWritten));

// 4) 本机没有这个 id 的会话 → 先问「打开到哪个工作区」，给了 cwd 才落地
const ZSTD_OPTS = { params: { [zlib.constants.ZSTD_c_checksumFlag]: 1 } };
const foreignId = `session-${randomUUID()}`;
const entries = zipRead(fs.readFileSync(pkg));
const sessionName = [...entries.keys()].find((name) => name.startsWith('session/') && name.endsWith('.zstd'));
const rawSession = entries.get(sessionName);
const frames = scanZstdFrames(rawSession);
const headText = zlib.zstdDecompressSync(rawSession.subarray(frames[0].start, frames[0].end)).toString('utf8');
const headJson = JSON.parse(headText.slice(0, headText.indexOf('\n')));
const newline = headText.indexOf('\n');
const patchedHead = zlib.zstdCompressSync(
  Buffer.from(`${JSON.stringify({ ...headJson, id: foreignId })}\n${headText.slice(newline + 1)}`, 'utf8'),
  ZSTD_OPTS,
);
const foreignRaw = Buffer.concat([patchedHead, rawSession.subarray(frames[1].start)]);
entries.set(sessionName, foreignRaw);
const manifestEntry = entries.get('manifest.json');
if (manifestEntry !== undefined) {
  const manifest = JSON.parse(manifestEntry.toString('utf8'));
  manifest.session = { ...manifest.session, id: foreignId };
  // 换了 id 就要重算这条的指纹（不是删掉）：parts 得覆盖每个内容条目。
  if (manifest.parts !== undefined) {
    manifest.parts[sessionName] = {
      sha256: createHash('sha256').update(foreignRaw).digest('hex'),
      bytes: foreignRaw.length,
    };
  }
  entries.set('manifest.json', Buffer.from(JSON.stringify(manifest, null, 2), 'utf8'));
}
const foreign = path.join(tmpDir, 'foreign.dsproj');
fs.writeFileSync(
  foreign,
  zipWrite([...entries].map(([name, data]) => ({ name, data, store: name.endsWith('.zstd') }))),
);

const askWhere = await call(open, { path: foreign });
check(askWhere.body.status === 'need-workspace', '本机没有这个 id → 询问工作区', askWhere.body.status);
check(askWhere.body.sessionId === foreignId, '问的时候带上会话 id', String(askWhere.body.sessionId));
check(Array.isArray(askWhere.body.workspaces), '返回工作区列表', `${askWhere.body.workspaces?.length ?? 0} 个`);
check(
  (askWhere.body.workspaces ?? []).every((w) => typeof w.path === 'string' && typeof w.title === 'string'),
  '工作区条目有 title / path',
  (askWhere.body.workspaces ?? []).map((w) => w.title).join('、'),
);
check(askWhere.body.originalCwd === decodeFirstLine(target.file).header.cwd, '带上包里的原工作区', String(askWhere.body.originalCwd));

const wsRoute = handlers.get('/api/session.workspaces');
const listed = await wsRoute(new Request(new URL('http://127.0.0.1:3080/x')));
const listedBody = await listed.json();
check(listedBody.status === 'ok' && Array.isArray(listedBody.workspaces), '工作区路由可用', `${listedBody.workspaces?.length ?? 0} 个`);

const chosen = path.join(tmpDir, 'chosen');
fs.mkdirSync(chosen, { recursive: true });
const placed = await call(open, { path: foreign, cwd: chosen });
check(placed.body.status === 'opened', '选好工作区后打开成功', placed.body.message ?? '');
check(placed.body.sessionId === foreignId, 'id 保持（本机本来没有）', String(placed.body.sessionId));
if (placed.body.status === 'opened') {
  const dst = decodeFirstLine(placed.body.target);
  check(dst.header.cwd === chosen, 'cwd 是选定的工作区', dst.header.cwd);
}

// 5) 错误路径
const missing = await call(open, { path: path.join(tmpDir, 'nope.dsproj') });
check(missing.status === 404 && missing.body.status === 'error', '不存在的文件报 404', missing.body.message ?? '');

// 6) 清理
const sessionsAfter = listDirs(SESSIONS);
for (const name of sessionsAfter) {
  if (sessionsBefore.has(name)) continue;
  fs.rmSync(path.join(SESSIONS, name), { recursive: true, force: true });
}
const memoryAfter = listDirs(MEMORY);
for (const name of memoryAfter) {
  if (memoryBefore.has(name)) continue;
  fs.rmSync(path.join(MEMORY, name), { recursive: true, force: true });
}
fs.rmSync(tmpDir, { recursive: true, force: true });
restoreState();
check(listDirs(SESSIONS).size === sessionsBefore.size, '会话目录已复原', `${listDirs(SESSIONS).size} 个`);
check(listDirs(MEMORY).size === memoryBefore.size, '记忆目录已复原', `${listDirs(MEMORY).size} 个`);

if (failures.length > 0) {
  console.error(`\n✗ ${failures.length} 项失败：${failures.join('、')}`);
  process.exit(1);
}
console.log('\n✅ open 自检通过');
