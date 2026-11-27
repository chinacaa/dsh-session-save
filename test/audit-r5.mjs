/*
 * 安全审计第 5 轮：2026-11-27「会话覆盖好像有问题」的常驻回归。
 *
 * 真实现场：一个工程包被四个会话共用，磁盘上只剩最后一份，前三个会话的内容没了，
 * 旁边一个 .bak 都没有。四条根因：
 *   OV-1  copy / relocate 换了新 session id，却把「用户打开的那个源包」记成新会话的
 *         保存目标；副本第一次保存就静默覆盖原件（stamps 里刚写进去的 sha 与磁盘一致，
 *         所以 staleOf 什么也没看出来）。
 *   OV-2  没有任何反向索引，回答不了「这个包现在归哪个会话」，同一个包可以被反复
 *         导入成 N 个会话而毫无提示。
 *   OV-3  保存前不读目标包的 header.id，包属于谁无从判断。
 *   OV-4  copy / relocate 落盘前不留备份。
 * 另加本轮新查到的 OV-6：relocate 换完 id 之后控制流还会落进 reuse 分支，返回体里
 * sessionId 是新的、target 却指着另一个会话的目录。
 *
 * 每条断言都能独立变红：把实现改回旧版，对应那行就会失败。
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
const { ROUTE, OPEN_ROUTE, normalizePathKey, staleOf, zipWrite, zipRead } = mod;
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

const ZSTD_FRAME_OPTS = { params: { [zlib.constants.ZSTD_c_checksumFlag]: 1 } };
const frameOf = (text) => zlib.zstdCompressSync(Buffer.from(text, 'utf8'), ZSTD_FRAME_OPTS);
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const OUT = path.join(fx.base, 'out');
fs.mkdirSync(OUT, { recursive: true });

const STATE_FILE = path.join(fx.home, 'storages', 'session-save.json');
const writeStateFile = (state) => {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
};
const readStateFile = () => JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
writeStateFile({ paths: {}, lastDir: OUT, autosave: {}, stamps: {}, stale: {}, missing: {} });

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

const CREATED_AT = 1792340086210;
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
  }) + '\n';

/** 造一个最小合法工程包：manifest + 一帧 header + 一帧事件。 */
const buildPackage = ({ sessionId, createdAt = CREATED_AT, cwd = fx.cwd, mark = 'x' }) => {
  const sessionName = 'session/session.v4.jsonl.zstd';
  const log = Buffer.concat([
    frameOf(headerOf(sessionId, cwd, createdAt)),
    frameOf(JSON.stringify({ type: 'message', mark, text: 'y'.repeat(64) }) + '\n'),
  ]);
  const manifest = {
    format: 'dshproj/1',
    exportedAt: new Date().toISOString(),
    exportedBy: 'audit-r5',
    session: {
      id: sessionId,
      version: 4,
      cwd,
      createdAt,
      fileName: 'session.v4.jsonl.zstd',
      frames: 2,
      lines: 2,
      bytes: log.length,
    },
    memoryFiles: [],
    parts: { [sessionName]: { sha256: sha256(log), bytes: log.length } },
  };
  return zipWrite([
    { name: 'manifest.json', data: Buffer.from(JSON.stringify(manifest, null, 2), 'utf8') },
    { name: sessionName, data: log, store: true },
  ]);
};

const writePackage = (name, bytes) => {
  const file = path.join(OUT, `${name}-${randomUUID()}.dsproj`);
  fs.writeFileSync(file, bytes);
  return file;
};

/** 磁盘上同一个包旁边的备份：`<名>.bak-<ts>`。 */
const baksBeside = (file) =>
  fs
    .readdirSync(path.dirname(file))
    .filter((name) => name.startsWith(`${path.basename(file)}.bak-`))
    .sort();

const ownersOf = (state) => state.owners ?? {};
const sharedOf = (state) => state.shared ?? {};

/* ── 1) 反向断言：单个会话正常保存，任何新闸都不许拦 ─────────────────── */
const local = fx.session;
// 目标文件先不许存在：handleSave 对「这个位置已经有别人的文件」走的是 confirm-overwrite
// 那条老闸，这里要验的是正常保存，所以给一个干净的新路径。
const pkgOwn = path.join(OUT, `own-${randomUUID()}.dsproj`);
{
  const first = await call(saveRoute, ROUTE, { sessionId: local.id, path: pkgOwn });
  check(first.body.status === 'saved', '单会话保存照旧成功', first.body.status ?? '');
  const state = readStateFile();
  check(state.paths[local.id] === pkgOwn, '状态里记下本会话的保存目标', state.paths[local.id] ?? '(无)');
  check(ownersOf(state)[normalizePathKey(pkgOwn)] === local.id, '反向索引记下这个包归本会话');

  // 同一会话再存一次（覆盖自己的包）：老行为就该直接写，不许冒出新闸。
  const again = await call(saveRoute, ROUTE, { sessionId: local.id });
  check(again.body.status === 'saved', '同一会话覆盖自己的包不被拦', again.body.status ?? '');
  check(baksBeside(pkgOwn).length === 0, '覆盖自己那份不留备份（旧行为不变）', String(baksBeside(pkgOwn).length));
}

/* ── 2) OV-1A：copy 导入不许继承源包路径 ─────────────────────────────── */
const pkgCopy = writePackage(
  'copy',
  // 同 id、不同 createdAt：本机另有一个同名会话，必须另开一份。
  buildPackage({ sessionId: local.id, createdAt: CREATED_AT + 777 }),
);
let copyId = '';
{
  // 真实现场的前提：这个包本来是原会话的保存目标（paths 上记着它）。
  // 直接摆状态而不是先写一版再改 header —— 改 header 会破坏 manifest.parts。
  writeStateFile({
    paths: { [local.id]: pkgCopy },
    lastDir: OUT,
    autosave: {},
    stamps: {
      [local.id]: { path: pkgCopy, sha256: sha256(fs.readFileSync(pkgCopy)), at: '2026-11-11T18:33:45.000Z' },
    },
    stale: {},
    missing: {},
  });

  const before = sha256(fs.readFileSync(pkgCopy));
  const opened = await call(openRoute, OPEN_ROUTE, { path: pkgCopy, cwd: fx.cwd, onConflict: 'copy' });
  copyId = String(opened.body.sessionId ?? '');
  check(opened.body.status === 'opened', 'copy 导入成功', opened.body.status ?? '');
  check(opened.body.conflictResolved === 'copy', '记为「另存为副本」', String(opened.body.conflictResolved));
  check(copyId !== '' && copyId !== local.id, '副本换了新 id', copyId);
  const state = readStateFile();
  check(state.paths[copyId] === undefined, 'OV-1A 副本没有继承源包路径', String(state.paths[copyId]));
  check(state.stamps?.[copyId] === undefined, 'OV-1A 副本也没有继承 sha 基线');
  check(ownersOf(state)[normalizePathKey(pkgCopy)] === local.id, 'OV-2A 源包仍然归原会话');
  check(opened.body.saveTarget === null || opened.body.saveTarget === undefined, '返回体不把源包当保存目标', String(opened.body.saveTarget));
  check(opened.body.sourcePath === pkgCopy, '返回体仍然记着「从哪个包来的」');
  check(sha256(fs.readFileSync(pkgCopy)) === before, '导入过程一个字节都不改源包');
}

/* ── 3) OV-1B / OV-4：从副本保存不许落到源包上 ─────────────────────── */
{
  const before = sha256(fs.readFileSync(pkgCopy));
  // 用户手动把保存位置指回源包（最容易犯的错）：先被「已被占用」拦下。
  const blocked = await call(saveRoute, ROUTE, { sessionId: copyId, path: pkgCopy });
  check(blocked.status === 409 && blocked.body.status === 'shared-target', '副本保存指向源包 → 409 shared-target', String(blocked.status));
  check(blocked.body.holder?.id === local.id, '被拦时点名占着这个包的会话', String(blocked.body.holder?.id));
  check(sha256(fs.readFileSync(pkgCopy)) === before, 'OV-1B 源包 sha 没变');
  check(baksBeside(pkgCopy).length === 0, 'OV-4A 源包没被写，就不该有备份', String(baksBeside(pkgCopy).length));
  // 副本身上不该存在任何「默认保存位置」：那正是旧版本静默覆盖原件的入口。
  check(readStateFile().paths[copyId] === undefined, '副本身上没有可落盘的默认位置');

  // 反向：首次另存到一个新位置必须通得过。
  const fresh = path.join(OUT, `fresh-${randomUUID()}.dsproj`);
  const asNew = await call(saveRoute, ROUTE, { sessionId: copyId, path: fresh });
  check(asNew.body.status === 'saved', '首次另存照旧成功（新闸不误伤）', asNew.body.status ?? '');
  check(fs.existsSync(fresh), '另存的文件真的落了盘');
  const state = readStateFile();
  check(state.paths[copyId] === fresh, '另存之后才记下新的保存目标', state.paths[copyId] ?? '(无)');
  check(ownersOf(state)[normalizePathKey(fresh)] === copyId, '新文件归这个副本');
}

/* ── 4) overwrite 导入仍然能覆盖本机那份，并且留一个 .bak ─────────────── */
{
  const pkgOver = writePackage('over', buildPackage({ sessionId: local.id, createdAt: CREATED_AT }));
  const beforeBaks = baksBeside(local.file).length;
  const opened = await call(openRoute, OPEN_ROUTE, { path: pkgOver, cwd: fx.cwd, onConflict: 'overwrite' });
  check(opened.body.status === 'opened' && opened.body.conflictResolved === 'overwrite', 'overwrite 导入覆盖本机那份', String(opened.body.conflictResolved));
  check(path.resolve(opened.body.target ?? '') === path.resolve(local.file), '覆盖的是本机那份会话文件');
  const baks = baksBeside(local.file);
  check(baks.length === beforeBaks + 1, 'OV-4 覆盖前留了一个 .bak', String(baks.length - beforeBaks));
  // 覆盖进去的是会话日志（第 0 帧 header + 事件帧），不是 zip：直接解第一帧看 id。
  const frames = mod.scanZstdFrames(fs.readFileSync(local.file));
  const head = JSON.parse(
    zlib.zstdDecompressSync(fs.readFileSync(local.file).subarray(frames[0].start, frames[0].end)).toString('utf8').split('\n')[0],
  );
  check(head.id === local.id, '覆盖后文件里仍是这个会话');
}

/* ── 5) OV-2：一个包被两个会话记着 → 导入与保存都先问一句 ────────────── */
const other = fx.writeSession({ mark: 'other' });
const strangerId = `session-${randomUUID()}`;
const pkgShare = writePackage('share', buildPackage({ sessionId: strangerId, createdAt: CREATED_AT + 5 }));
let migrateProbeId = '';
{
  // 复刻真实现场：旧版本留下的状态就是「同一条路径被两个 id 记着」。
  // 迁移只允许把它照原样读出来，不许悄悄改用户的 paths。
  const shareSha = sha256(fs.readFileSync(pkgShare));
  writeStateFile({
    paths: { [local.id]: pkgShare, [other.id]: pkgShare },
    lastDir: OUT,
    autosave: {},
    stamps: {
      [local.id]: { path: pkgShare, sha256: shareSha, at: '2026-11-11T18:33:45.000Z' },
      [other.id]: { path: pkgShare, sha256: shareSha, at: '2026-11-10T09:00:00.000Z' },
    },
    stale: {},
    missing: {},
  });

  // 读一遍状态：随便哪个成功保存都会顺手把迁移后的形状写回去。用第三个会话写一个
  // 无关的新路径，这样共用现场不受影响，正好能验「迁移只增不改」。
  const probe = fx.writeSession({ mark: 'migrate-probe' });
  migrateProbeId = probe.id;
  await call(saveRoute, ROUTE, { sessionId: probe.id, path: path.join(OUT, `probe-${randomUUID()}.dsproj`) });
  const migrated = readStateFile();
  const key = normalizePathKey(pkgShare);
  check(migrated.paths[local.id] === pkgShare && migrated.paths[other.id] === pkgShare, '迁移没有动用户已有的 paths（两条都还在）');
  check(ownersOf(migrated)[key] === local.id, '反向索引只留一个 holder（最近一次写入的）', String(ownersOf(migrated)[key]));
  check(Array.isArray(sharedOf(migrated)[key]) && sharedOf(migrated)[key].length === 2, '共用关系记进 shared，供界面提示', JSON.stringify(sharedOf(migrated)[key]));
}

{
  // 上面那次 force 保存已经让 other 接管了这个包，先把它还原成「别人占着」的现场。
  const shareSha = sha256(fs.readFileSync(pkgShare));
  writeStateFile({
    paths: { [local.id]: pkgShare, [other.id]: pkgShare },
    lastDir: OUT,
    autosave: {},
    stamps: {
      [local.id]: { path: pkgShare, sha256: shareSha, at: '2026-11-11T18:33:45.000Z' },
      [other.id]: { path: pkgShare, sha256: shareSha, at: '2026-11-10T09:00:00.000Z' },
    },
    stale: {},
    missing: {},
  });

  const before = sha256(fs.readFileSync(pkgShare));
  const first = await call(openRoute, OPEN_ROUTE, { path: pkgShare, cwd: fx.cwd, onConflict: 'copy' });
  check(first.status === 409 && first.body.status === 'shared-target', '导入已被占用的包返回 409 shared-target', String(first.status));
  check(first.body.holder?.id === local.id, '提示里指名占用者', String(first.body.holder?.id));
  check(first.body.canForce === true, '给界面留了「仍要覆盖」的口子');

  // 同一个包再导两次：仍然只提醒、不落新占用，磁盘包一个字节都不动。
  const second = await call(openRoute, OPEN_ROUTE, { path: pkgShare, cwd: fx.cwd, onConflict: 'copy' });
  const third = await call(openRoute, OPEN_ROUTE, { path: pkgShare, cwd: fx.cwd, onConflict: 'copy' });
  check(second.body.status === 'shared-target' && third.body.status === 'shared-target', '连续导入仍然返回 shared-target');
  // 反向索引只在成功写盘时才落盘（被拦的导入一个字节都不写，这也是要的），
  // 所以先逼一次落盘，再看落下来的形状。
  await call(saveRoute, ROUTE, { sessionId: migrateProbeId, path: path.join(OUT, `probe2-${randomUUID()}.dsproj`) });
  const after = readStateFile();
  const key = normalizePathKey(pkgShare);
  check(after.paths[local.id] === pkgShare && after.paths[other.id] === pkgShare, '三次导入没有给这个包添新的占用者');
  check(ownersOf(after)[key] === local.id, '占用者没被后来的导入顶掉', String(ownersOf(after)[key]));
  check(sharedOf(after)[key]?.length === 2, '共用关系还是那两个会话', JSON.stringify(sharedOf(after)[key]));
  check(sha256(fs.readFileSync(pkgShare)) === before, '三次导入磁盘包 sha 都不变');

  // 保存侧：另一个会话想把包写回这个位置，同样要先问。
  const blocked = await call(saveRoute, ROUTE, { sessionId: other.id });
  check(blocked.status === 409 && blocked.body.status === 'shared-target', '保存到已被别人占用的包返回 409 shared-target', String(blocked.status));
  check(blocked.body.holder?.id === local.id, '保存侧也指名占用者', String(blocked.body.holder?.id));
  check(sha256(fs.readFileSync(pkgShare)) === before, '被拦下的保存没有写盘');

  // 用户看过提示后坚持覆盖：放行，并且必须留备份。
  const forced = await call(saveRoute, ROUTE, { sessionId: other.id, force: '1' });
  check(forced.body.status === 'saved', 'force=1 时放行', forced.body.status ?? '');
  check(baksBeside(pkgShare).length === 1, 'force 接管别人的包先留一个 .bak', String(baksBeside(pkgShare).length));
  check(ownersOf(readStateFile())[key] === other.id, '接管之后占用者变成新写入的会话');
}

/* ── 6) OV-3：包里的 header.id 不是本会话 → 409 foreign-package ──────── */
const third = fx.writeSession({ mark: 'third' });
{
  const pkgForeign = path.join(OUT, `foreign-${randomUUID()}.dsproj`);
  const own = await call(saveRoute, ROUTE, { sessionId: third.id, path: pkgForeign });
  check(own.body.status === 'saved', '先让这个会话记下一个保存目标', own.body.status ?? '');

  // 文件被换成了另一个会话的包（真实现场：别的会话把它覆盖了）。
  fs.writeFileSync(pkgForeign, buildPackage({ sessionId: local.id, createdAt: CREATED_AT + 9 }));
  const before = sha256(fs.readFileSync(pkgForeign));

  const blocked = await call(saveRoute, ROUTE, { sessionId: third.id });
  check(blocked.status === 409 && blocked.body.status === 'foreign-package', '保存到别人的包返回 409 foreign-package', String(blocked.status));
  check(blocked.body.headerId === local.id, '提示里带出包里记的会话 id', String(blocked.body.headerId));
  check(blocked.body.canForce === true, '同样留了 force 的口子');
  check(sha256(fs.readFileSync(pkgForeign)) === before, '被拦下的保存没有写盘');

  const forced = await call(saveRoute, ROUTE, { sessionId: third.id, force: '1' });
  check(forced.body.status === 'saved', 'force=1 时照旧写入', forced.body.status ?? '');
  check(baksBeside(pkgForeign).length === 1, 'force 覆盖别人的包也留一个 .bak', String(baksBeside(pkgForeign).length));
  const back = JSON.parse(zipRead(fs.readFileSync(pkgForeign)).get('manifest.json').toString('utf8'));
  check(back.session.id === third.id, '写回去的包记的是本会话');

  // 反向：接下来这一次是「覆盖自己刚写的包」，不许再拦。
  const again = await call(saveRoute, ROUTE, { sessionId: third.id });
  check(again.body.status === 'saved', '再存自己的包不再拦（旧行为不变）', again.body.status ?? '');
}

/* ── 7) 远程 deliver=download 只看包，不写 stamps / owners ─────────────── */
{
  const remote = fx.writeSession({ mark: 'remote' });
  const before = readStateFile();
  const download = await call(saveRoute, ROUTE, { sessionId: remote.id, deliver: 'download' });
  check(download.status === 200, '下载分支返回 200', String(download.status));
  const after = readStateFile();
  check(after.paths[remote.id] === undefined, '下载分支不写 paths');
  check(after.stamps?.[remote.id] === undefined, '下载分支不写 stamps');
  check(
    JSON.stringify(Object.keys(ownersOf(before)).sort()) === JSON.stringify(Object.keys(ownersOf(after)).sort()),
    '下载分支不动反向索引',
    `${Object.keys(ownersOf(after)).length} 个键`,
  );
}

/* ── 8) OV-6：relocate 的返回体必须自洽（target 属于新 id） ───────────── */
{
  const pkgReloc = writePackage('reloc', buildPackage({ sessionId: local.id, createdAt: CREATED_AT }));
  const otherCwd = path.join(fx.base, 'other-cwd');
  fs.mkdirSync(otherCwd, { recursive: true });
  const opened = await call(openRoute, OPEN_ROUTE, { path: pkgReloc, cwd: otherCwd, onConflict: 'reuse' });
  const relocId = String(opened.body.sessionId ?? '');
  check(opened.body.status === 'opened', '换个工作区打开成功', opened.body.status ?? '');
  check(opened.body.renamed === true, '换了新 id（id 在一个 DSH_HOME 内必须唯一）');
  check(relocId !== '' && relocId !== local.id, 'relocate 后是新 id', relocId);
  check(
    String(opened.body.target ?? '').includes(relocId),
    'OV-6 返回的落点属于新 id，不是另一个会话的目录',
    String(opened.body.target ?? ''),
  );
  check(readStateFile().paths[relocId] === undefined, 'OV-1A relocate 也不继承源包路径');
}

/* ── 9) 反向断言：所有权判据只拦「别人的包」，自己的一律放行 ──────────── */
{
  const state = readStateFile();
  const mine = state.paths[third.id];
  check(staleOf(state, third.id, mine) === undefined, '自己的包：staleOf 不报 foreign-package', String(staleOf(state, third.id, mine)?.reason ?? '(无)'));

  const foreignPkg = writePackage('sanity', buildPackage({ sessionId: strangerId, createdAt: CREATED_AT + 11 }));
  const foreign = staleOf(state, third.id, foreignPkg);
  check(foreign?.reason === 'foreign-package', '别人的包：staleOf 报 foreign-package', String(foreign?.reason ?? '(无)'));
  check(foreign?.headerId === strangerId, '报错里带出包内的会话 id', String(foreign?.headerId));

  // 不是工程包（比如 DSH 自己的会话日志）判不出归属，必须当作「不拦」，否则
  // 第一次保存就会被自己挡住。
  const notPackage = path.join(OUT, `plain-${randomUUID()}.bin`);
  fs.writeFileSync(notPackage, Buffer.from('not a zip', 'utf8'));
  check(staleOf(state, third.id, notPackage) === undefined, '读不出归属的文件不误拦');
}

console.log(`共 ${passed + failed} 条：${passed} 过，${failed} 败`);
assert.equal(failed, 0);
