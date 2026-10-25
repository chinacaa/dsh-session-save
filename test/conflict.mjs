/**
 * 冲突 + 锁 + 自动保存自检。
 *
 * 覆盖四件事：
 *   1. 保存出的包带 LOCK.json（host / pid / at / writes），manifest 里也有镜像；
 *   2. 本机存在同 id 但不同会话（createdAt 不同）时的四种处理：
 *        ask → 409 conflict、reuse → 指向本机、overwrite → 覆盖并留 .bak、copy → 换新 id；
 *   3. 包内锁挡住跨机写入（409 locked），--force 可越过；
 *   4. 自动保存开关：开启后 step/end 钩子会去抖写回记住的文件，且锁计数递增。
 *
 * 运行：node plugins/dsh-session-save/test/conflict.mjs
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { apply, scanZstdFrames, zipRead, zipWrite, lockBlocks, cloudMarkOf, staleOf, LOCK_FORMAT } from '../index.js';

const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
const SESSIONS = path.join(DSH_HOME, 'sessions');
const MEMORY = path.join(DSH_HOME, 'memory', 'workspaces');
const STATE_FILE = path.join(DSH_HOME, 'storages', 'session-save.json');

const handlers = new Map();
const hooks = new Map();
apply({
  connection: { fetch: { register: (spec) => handlers.set(spec.path, spec.fetch) } },
  effect: (fn) => {
    fn();
    return () => {};
  },
  on: (name, handler) => {
    hooks.set(name, handler);
    return () => {};
  },
});

const save = handlers.get('/api/session.save');
const open = handlers.get('/api/session.open');
const autosave = handlers.get('/api/session.autosave');
if (save === undefined || open === undefined || autosave === undefined) {
  console.error('✗ 路由未注册');
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

const readHeaderOf = (file) => {
  const buf = fs.readFileSync(file);
  const frames = scanZstdFrames(buf);
  const text = zlib.zstdDecompressSync(buf.subarray(frames[0].start, frames[0].end)).toString('utf8');
  return JSON.parse(text.slice(0, text.indexOf('\n')));
};

const failures = [];
const check = (ok, label, detail = '') => {
  console.log(`${ok ? '✅' : '✗'} ${label}${detail === '' ? '' : ` · ${detail}`}`);
  if (!ok) failures.push(label);
};

const sessionsBefore = listDirs(SESSIONS);
const memoryBefore = listDirs(MEMORY);

const target = pickSession();
if (target === undefined) {
  console.error('✗ 本机没有会话文件可测');
  process.exit(1);
}
const packageHeader = readHeaderOf(target.file);
console.log(`会话：${target.id} · ${(target.size / 1024).toFixed(1)} KB`);

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshss-conflict-'));
const pkg = path.join(tmpDir, 'base.dsproj');

// 保存路由只允许写到「上次用的目录」或已记住文件的目录下。测试前把 lastDir 指到本次临时目录，
// 结束时把状态文件整份还原（原来没有就删掉），保证不弄丢用户真实记住的路径。
const STATE_BACKUP = fs.existsSync(STATE_FILE) ? fs.readFileSync(STATE_FILE, 'utf8') : undefined;
const restoreState = () => {
  if (STATE_BACKUP === undefined) fs.rmSync(STATE_FILE, { force: true });
  else fs.writeFileSync(STATE_FILE, STATE_BACKUP);
};
{
  const state = STATE_BACKUP === undefined ? {} : JSON.parse(STATE_BACKUP);
  state.lastDir = tmpDir;
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

/* ── 1) 包内锁 ── */
const saved = await call(save, { sessionId: target.id, path: pkg });
check(saved.body.status === 'saved', '保存出包', `${(saved.body.bytes / 1024).toFixed(1)} KB`);
check(saved.body.lock?.format === LOCK_FORMAT, '响应带锁', saved.body.lock?.format ?? '(无)');
check(saved.body.lock?.host === os.hostname(), '锁记本机名', String(saved.body.lock?.host));
check(saved.body.lock?.pid === process.pid, '锁记 pid', String(saved.body.lock?.pid));
check(saved.body.lock?.writes === 1, '首次写入计数 1', String(saved.body.lock?.writes));

const entries = zipRead(fs.readFileSync(pkg));
const lockEntry = entries.get('LOCK.json');
check(lockEntry !== undefined, '包里有 LOCK.json');
if (lockEntry !== undefined) {
  const lock = JSON.parse(lockEntry.toString('utf8'));
  check(lock.sessionId === target.id, 'LOCK.json 记会话 id', String(lock.sessionId));
  check(lockBlocks(lock) === undefined, '自己的锁不挡自己');
}
const manifest = JSON.parse(entries.get('manifest.json').toString('utf8'));
check(manifest.lock !== undefined && manifest.lock.format === LOCK_FORMAT, 'manifest 里也有锁镜像');
check(lockBlocks(undefined) === undefined, '无锁可写');

/* ── 2) 同 id 不同会话 → 四种冲突处理 ──
 * 本机那份必须是「同 id、不同 createdAt」才算真冲突。真实会话仍占着 target.id，
 * 所以另做一个改过 id 的包（id 换新、内容照旧），再在本机伪造同 id 的旧会话。
 */
const ZSTD_OPTS = { params: { [zlib.constants.ZSTD_c_checksumFlag]: 1 } };
const sessionKey = [...entries.keys()].find((name) => /^session\/.*\.jsonl\.zstd$/.test(name));
const conflictId = `session-${crypto.randomUUID()}`;
const conflictEntries = new Map(entries);
{
  const buf = conflictEntries.get(sessionKey);
  const frames = scanZstdFrames(buf);
  const text = zlib.zstdDecompressSync(buf.subarray(frames[0].start, frames[0].end)).toString('utf8');
  const nl = text.indexOf('\n');
  const head = JSON.parse(text.slice(0, nl));
  const rewritten = `${JSON.stringify({ ...head, id: conflictId })}${text.slice(nl)}`;
  const frame0 = zlib.zstdCompressSync(Buffer.from(rewritten, 'utf8'), ZSTD_OPTS);
  const rest = frames.length > 1 ? buf.subarray(frames[1].start) : Buffer.alloc(0);
  conflictEntries.set(sessionKey, Buffer.concat([frame0, rest]));
  const mirrored = JSON.parse(conflictEntries.get('manifest.json').toString('utf8'));
  mirrored.session = { ...mirrored.session, id: conflictId };
  // 改过内容就不能再留着旧的指纹，否则 verifyPackage 会判「内容被改动过」。
  if (mirrored.parts !== undefined) delete mirrored.parts[sessionKey];
  conflictEntries.set('manifest.json', Buffer.from(JSON.stringify(mirrored), 'utf8'));
}
const conflictPkg = path.join(tmpDir, 'conflict.dsproj');
fs.writeFileSync(
  conflictPkg,
  zipWrite([...conflictEntries.entries()].map(([name, data]) => ({ name, data, store: name.endsWith('.zstd') }))),
);

const fakeCwd = path.join(tmpDir, 'other-machine');
fs.mkdirSync(fakeCwd, { recursive: true });
const fakeProject = path.join(SESSIONS, `--dshss-conflict-${Date.now()}--`);
const fakeDir = path.join(fakeProject, conflictId);
fs.mkdirSync(fakeDir, { recursive: true });
const fakeFile = path.join(fakeDir, 'session.v4.jsonl.zstd');
const fakeHeader = {
  type: 'session',
  version: 4,
  id: conflictId,
  createdAt: 111111,
  cwd: fakeCwd,
  isSeeded: false,
  delegationDepth: 0,
};
fs.writeFileSync(fakeFile, zlib.zstdCompressSync(Buffer.from(`${JSON.stringify(fakeHeader)}\n`, 'utf8')));
const fakeBytes = fs.readFileSync(fakeFile);

const ask = await call(open, { path: conflictPkg });
check(ask.status === 409 && ask.body.status === 'conflict', 'ask 返回 409 conflict', String(ask.status));
check(ask.body.conflict === true, '标记为冲突');
check(ask.body.existing?.createdAt === 111111, '给出本机那份的 createdAt', String(ask.body.existing?.createdAt));
check(ask.body.incoming?.createdAt === packageHeader.createdAt, '给出文件里的 createdAt', String(ask.body.incoming?.createdAt));
check(
  path.resolve(ask.body.existing?.target ?? '') === path.resolve(fakeFile),
  '指认本机那份的路径',
  ask.body.existing?.target ?? '',
);
check(fs.readFileSync(fakeFile).equals(fakeBytes), 'ask 不改动任何文件');

const reuse = await call(open, { path: conflictPkg, onConflict: 'reuse' });
check(reuse.body.status === 'opened' && reuse.body.conflictResolved === 'reuse', 'reuse 用本机的', reuse.body.message ?? '');
check(path.resolve(reuse.body.target ?? '') === path.resolve(fakeFile), 'reuse 指向本机文件');
check(fs.readFileSync(fakeFile).equals(fakeBytes), 'reuse 不动本机文件');

// copy 必须在 overwrite 之前：overwrite 会把本机那份改成包里的 createdAt，
// 之后就不再算「不同会话」，conflict 也就不会出现。
const copied = await call(open, { path: conflictPkg, onConflict: 'copy' });
check(copied.body.status === 'opened' && copied.body.conflictResolved === 'copy', 'copy 另存为副本');
check(copied.body.renamed === true, 'copy 换了新 id');
check(copied.body.sessionId !== conflictId, '新 id 与原 id 不同', copied.body.sessionId ?? '');
check(copied.body.replacedId === conflictId, '记录被替换的 id', String(copied.body.replacedId));
check(fs.readFileSync(fakeFile).equals(fakeBytes), 'copy 不动本机那份');

const overwrite = await call(open, { path: conflictPkg, onConflict: 'overwrite' });
check(overwrite.body.status === 'opened' && overwrite.body.conflictResolved === 'overwrite', 'overwrite 覆盖本机');
check(path.resolve(overwrite.body.target ?? '') === path.resolve(fakeFile), 'overwrite 写回本机目录');
const backups = fs.readdirSync(fakeDir).filter((n) => n.includes('.bak-'));
check(backups.length === 1, '覆盖前留了 .bak', backups[0] ?? '(无)');
const overwritten = readHeaderOf(fakeFile);
check(overwritten.createdAt === packageHeader.createdAt, '覆盖后是本文件的会话', String(overwritten.createdAt));
check(overwritten.cwd === packageHeader.cwd, '覆盖后 cwd 是包里的', String(overwritten.cwd));

fs.rmSync(fakeProject, { recursive: true, force: true });

/* ── 3) 跨机锁挡住写入 ── */
const foreign = new Map(entries);
const foreignLock = {
  format: LOCK_FORMAT,
  sessionId: target.id,
  host: 'OTHER-MACHINE',
  pid: 4242,
  at: new Date().toISOString(),
  writes: 7,
};
foreign.set('LOCK.json', Buffer.from(JSON.stringify(foreignLock), 'utf8'));
const foreignManifest = { ...manifest, lock: foreignLock };
foreign.set('manifest.json', Buffer.from(JSON.stringify(foreignManifest), 'utf8'));
const foreignPkg = path.join(tmpDir, 'foreign.dsproj');
fs.writeFileSync(
  foreignPkg,
  zipWrite([...foreign.entries()].map(([name, data]) => ({ name, data, store: name.endsWith('.zstd') }))),
);

check(typeof lockBlocks(foreignLock) === 'string', '异机新鲜锁给出理由', String(lockBlocks(foreignLock)));
const staleLock = { ...foreignLock, at: new Date(Date.now() - 60 * 60 * 1000).toISOString() };
check(lockBlocks(staleLock) === undefined, '异机过期锁可接管');

const blocked = await call(save, { sessionId: target.id, path: foreignPkg });
check(blocked.status === 409 && blocked.body.status === 'locked', '锁住时保存返回 409 locked', String(blocked.status));
check(
  String(blocked.body.message ?? '').includes('OTHER-MACHINE'),
  '报错里点出占用者',
  String(blocked.body.message ?? ''),
);
const forced = await call(save, { sessionId: target.id, path: foreignPkg, force: '1' });
check(forced.body.status === 'saved', 'force 越过锁', `${(forced.body.bytes / 1024).toFixed(1)} KB`);
check(forced.body.lock?.writes === 8, '写入计数在旧锁上递增', String(forced.body.lock?.writes));
check(fs.existsSync(`${foreignPkg}.lock`) === false, '写完后侧车锁已清掉');

/* ── 4) 自动保存 ── */
const auto = path.join(tmpDir, 'auto.dsproj');
const autoSaved = await call(save, { sessionId: target.id, path: auto });
check(autoSaved.body.status === 'saved', '为自动保存先存一份');

const off = await call(autosave, { sessionId: target.id });
check(off.body.enabled === false, '默认未开启', `path=${off.body.path ?? '(无)'}`);

const on = await call(autosave, { sessionId: target.id, enabled: '1' });
check(on.body.status === 'ok' && on.body.enabled === true, '开启自动保存');
check(path.resolve(on.body.path ?? '') === path.resolve(auto), '记住的路径就是刚存的包', String(on.body.path));

const mtimeBefore = fs.statSync(auto).mtimeMs;
const hook = hooks.get('session/event');
check(typeof hook === 'function', '注册了 session/event 钩子');
if (typeof hook === 'function') {
  hook({ id: target.id }, { type: 'step/start' }); // 非结束事件，应被忽略
  hook({ id: target.id }, { type: 'step/end' }); // 触发去抖
  await new Promise((resolve) => setTimeout(resolve, 2600));
  const mtimeAfter = fs.statSync(auto).mtimeMs;
  check(mtimeAfter > mtimeBefore, '钩子触发了写盘', `${Math.round(mtimeAfter - mtimeBefore)} ms 后`);
  const autoEntries = zipRead(fs.readFileSync(auto));
  const autoLock = JSON.parse(autoEntries.get('LOCK.json').toString('utf8'));
  check(autoLock.writes === 2, '自动保存把写入计数加一', String(autoLock.writes));
  check(autoLock.sessionId === target.id, '自动保存的锁记同一会话');
}

const turnedOff = await call(autosave, { sessionId: target.id, enabled: '0' });
check(turnedOff.body.enabled === false, '关闭自动保存');
const afterOffMtime = fs.statSync(auto).mtimeMs;
if (typeof hook === 'function') {
  hook({ id: target.id }, { type: 'step/end' });
  await new Promise((resolve) => setTimeout(resolve, 2200));
}
check(fs.statSync(auto).mtimeMs === afterOffMtime, '关闭后不再写盘');

/* ── 5) 别处改过（CAS）：同步盘里被别人写过的文件不许直接盖 ── */
check(cloudMarkOf('C:/Users/someone/OneDrive/会话.dsproj') === 'OneDrive', '认出 OneDrive 路径');
check(cloudMarkOf('C:/Users/someone/坚果云/会话.dsproj') === '坚果云', '认出坚果云路径');
check(cloudMarkOf('C:/Users/someone/Desktop/会话.dsproj') === undefined, '普通目录不算同步盘');

const cas = path.join(tmpDir, 'cas.dsproj');
const casSaved = await call(save, { sessionId: target.id, path: cas });
check(casSaved.body.status === 'saved', 'CAS 前置：先存一份', `${(casSaved.body.bytes / 1024).toFixed(1)} KB`);

// 模拟另一台机器/同步盘把内容换掉了
fs.writeFileSync(cas, Buffer.concat([fs.readFileSync(cas), Buffer.from('\n/* written elsewhere */')]));
const staleSave = await call(save, { sessionId: target.id, path: cas });
check(staleSave.status === 409 && staleSave.body.status === 'stale', '被别处改过后保存返回 409 stale', String(staleSave.status));
check(
  typeof staleSave.body.stale?.actual === 'string' && staleSave.body.stale.actual.length === 64,
  '报出磁盘上的 sha256',
  String(staleSave.body.stale?.actual ?? '').slice(0, 12),
);
check(staleSave.body.stale?.expected !== staleSave.body.stale?.actual, '和本机上次写的 sha256 不同');

const forcedCas = await call(save, { sessionId: target.id, path: cas, force: '1' });
check(forcedCas.body.status === 'saved', 'force 可以覆盖被别处改过的文件');
check(zipRead(fs.readFileSync(cas)).has('manifest.json'), '覆盖后仍是合法包');
const casAfter = await call(save, { sessionId: target.id, path: cas });
check(casAfter.body.status === 'saved', '覆盖后恢复成「本机最新」，再存不再报 stale');

/* 自动保存撞上别处改动：自己停掉并记下来，不写盘 */
const guard = path.join(tmpDir, 'guard.dsproj');
await call(save, { sessionId: target.id, path: guard });
await call(autosave, { sessionId: target.id, enabled: '1' });
fs.writeFileSync(guard, Buffer.concat([fs.readFileSync(guard), Buffer.from('\n/* written elsewhere */')]));
const guardMtime = fs.statSync(guard).mtimeMs;
if (typeof hook === 'function') {
  hook({ id: target.id }, { type: 'step/end' });
  await new Promise((resolve) => setTimeout(resolve, 2600));
}
check(fs.statSync(guard).mtimeMs === guardMtime, '别处改过后自动保存不写盘');
const afterStale = await call(autosave, { sessionId: target.id });
check(afterStale.body.enabled === false, '自动保存自己关掉了');
check(String(afterStale.body.stale?.path ?? '') === guard, '记下了冲突的文件', String(afterStale.body.stale?.path ?? ''));

/* 打开工程时就把指纹记下来：之后别处改动它，本机再存要能发现 */
const openPkg = path.join(tmpDir, 'open-cas.dsproj');
const openSaved = await call(save, { sessionId: target.id, path: openPkg });
check(openSaved.body.status === 'saved', '打开前先存一份', `${(openSaved.body.bytes / 1024).toFixed(1)} KB`);
const reopened = await call(open, { path: openPkg });
check(reopened.body.status === 'opened', '打开这份包', String(reopened.body.status));
check(reopened.body.cloud === undefined, '普通目录打开时不报同步盘');
fs.writeFileSync(openPkg, Buffer.concat([fs.readFileSync(openPkg), Buffer.from('\n/* another machine */')]));
const afterOpenSave = await call(save, { sessionId: target.id });
check(
  afterOpenSave.status === 409 && afterOpenSave.body.status === 'stale',
  '打开时记了指纹 → 别处改动后保存要 409 stale',
  String(afterOpenSave.status),
);

/* ── 6) 清理 ── */
for (const name of listDirs(SESSIONS)) {
  if (sessionsBefore.has(name)) continue;
  fs.rmSync(path.join(SESSIONS, name), { recursive: true, force: true });
}
for (const name of listDirs(MEMORY)) {
  if (memoryBefore.has(name)) continue;
  fs.rmSync(path.join(MEMORY, name), { recursive: true, force: true });
}
fs.rmSync(tmpDir, { recursive: true, force: true });
restoreState();
check(listDirs(SESSIONS).size === sessionsBefore.size, '会话目录已复原', `${listDirs(SESSIONS).size} 个`);
check(listDirs(MEMORY).size === memoryBefore.size, '记忆目录已复原', `${listDirs(MEMORY).size} 个`);
check(
  STATE_BACKUP === undefined ? fs.existsSync(STATE_FILE) === false : fs.readFileSync(STATE_FILE, 'utf8') === STATE_BACKUP,
  '测试写入的状态文件已复原',
);

if (failures.length > 0) {
  console.error(`\n✗ ${failures.length} 项失败：${failures.join('、')}`);
  process.exit(1);
}
console.log('\n✅ conflict / lock / autosave 自检通过');
