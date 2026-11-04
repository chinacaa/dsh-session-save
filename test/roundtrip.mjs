/**
 * 往返保真 / 附件回填 / 覆盖前备份开关（backup=0|1）。
 *
 * 这一套补的是「打包—导入」链上最容易被忽略的三件事：
 *   1. 往返：真实会话（本机 session-403aa63e… 取前 80 帧）与合成会话，导出再导入后
 *      会话 id / createdAt / cwd / 帧数 / 解压文本都必须原样回来；
 *   2. 附件：包里的对象按内容哈希回填，缺的记账，坏的一个字节都不写；
 *   3. 备份开关：四个会盖掉用户文件的落点（导入冲突选覆盖、磁盘内容被改后强制覆盖、
 *      合并记忆 restore、bili 状态回填）都必须受同一个 backup 开关控制——默认留 .bak，
 *      backup=0 时不多留一份。
 *
 * 全部在临时目录里跑（自己设 DSH_HOME / BILI_SESSIONS_DIR），不碰真实的 ~/.dsh。
 * 真实会话只读：只取前 80 帧拼成本地样本，不写回原文件。
 *
 * 运行：node test/roundtrip.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { createHash, randomUUID } from 'node:crypto';

import { autoCleanup, loadRoutes, makeFixture } from './fixture.mjs';

const fx = makeFixture({ mark: 'rt' });
autoCleanup(fx);

const { mod, routes } = await loadRoutes('../index.js');
const { ROUTE, OPEN_ROUTE, scanZstdFrames, zipRead, zipWrite, projectKey } = mod;
const saveRoute = routes.get(ROUTE);
const openRoute = routes.get(OPEN_ROUTE);
if (saveRoute === undefined || openRoute === undefined) {
  throw new Error(`路由没注册：${[...routes.keys()].join(', ')}`);
}

let failed = 0;
let passed = 0;
const ok = (label, detail) => {
  passed += 1;
  console.log(`✅ ${label}${detail === undefined ? '' : ` · ${detail}`}`);
};
const bad = (label, detail) => {
  failed += 1;
  console.error(`✗ ${label}${detail === undefined ? '' : ` · ${detail}`}`);
};
const check = (condition, label, detail) => (condition === true ? ok(label, detail) : bad(label, detail));

/* ── 基础工具 ── */

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const ZSTD = { params: { [zlib.constants.ZSTD_c_checksumFlag]: 1 } };
const frame = (text) => zlib.zstdCompressSync(Buffer.from(text, 'utf8'), ZSTD);
const headerOf = (id, cwd, createdAt = 1792903201877) =>
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
const bodyOf = (mark) => {
  const at = 1792903201900;
  return `${[
    JSON.stringify({ type: 'turn/start', at, turn: 1 }),
    JSON.stringify({ type: 'message', at: at + 1, role: 'user', content: [{ type: 'text', text: `往返样本 ${mark}` }] }),
    JSON.stringify({ type: 'message', at: at + 2, role: 'assistant', content: [{ type: 'text', text: '收到' }] }),
    JSON.stringify({ type: 'turn/end', at: at + 3, turn: 1 }),
  ].join('\n')}\n`;
};

/** 解压整段会话日志（多帧拼接）。 */
const textOf = (buf) => {
  const frames = scanZstdFrames(buf);
  return frames
    .map((item) => {
      try {
        return zlib.zstdDecompressSync(buf.subarray(item.start, item.end)).toString('utf8');
      } catch {
        return '';
      }
    })
    .join('');
};
const headerOfBuf = (buf) => {
  const frames = scanZstdFrames(buf);
  const text = zlib.zstdDecompressSync(buf.subarray(frames[0].start, frames[0].end)).toString('utf8');
  return JSON.parse(text.slice(0, text.indexOf('\n')));
};

/** 在夹具 DSH_HOME 里写一份会话。 */
const writeSession = ({ id = `session-${randomUUID()}`, cwd = fx.cwd, createdAt = 1792903201877, bodyFrames = 4, mark = 'rt', extraFrames = [] } = {}) => {
  const dir = path.join(fx.sessions, projectKey(cwd), id);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'session.v4.jsonl.zstd');
  const parts = [frame(`${headerOf(id, cwd, createdAt)}\n`)];
  for (let i = 0; i < bodyFrames; i += 1) parts.push(frame(bodyOf(`${mark}#${i}`)));
  for (const extra of extraFrames) parts.push(frame(extra));
  const buf = Buffer.concat(parts);
  fs.writeFileSync(file, buf);
  return { id, dir, file, buf, header: JSON.parse(headerOf(id, cwd, createdAt)), frames: parts.length };
};

/** 以「浏览器在回环地址上」的身份调路由。 */
const call = async (handler, route, query) => {
  const url = new URL(`http://127.0.0.1:3080${route}?${new URLSearchParams(query).toString()}`);
  const response = await handler(new Request(url));
  let body;
  try {
    body = await response.json();
  } catch {
    body = undefined;
  }
  return { status: response.status, body };
};

/** 保存路由只让写到「上次用的目录」下：把 lastDir 指到临时 out。 */
const stateFile = path.join(fx.home, 'storages', 'session-save.json');
const setLastDir = (dir) => {
  const state = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : {};
  state.lastDir = dir;
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
};
setLastDir(fx.out);

/** 目录里以某个前缀开头的备份文件。 */
const baks = (dir, prefix) => {
  try {
    return fs.readdirSync(dir).filter((name) => name.startsWith(prefix) && name.includes('.bak-'));
  } catch {
    return [];
  }
};

/** 临时切 DSH_HOME，跑完切回来。 */
const withHome = async (home, fn) => {
  const before = process.env.DSH_HOME;
  fs.mkdirSync(path.join(home, 'sessions'), { recursive: true });
  process.env.DSH_HOME = home;
  try {
    return await fn();
  } finally {
    process.env.DSH_HOME = before;
  }
};

/** 手搓一个 .dsproj（内容自己声明 parts，走真实校验）。 */
const buildPackage = ({ sessionId, cwd, createdAt = 1792903201877, extraEntries = [], attachments, lock } = {}) => {
  const log = Buffer.concat([frame(`${headerOf(sessionId, cwd, createdAt)}\n`), frame(bodyOf(`pack#${sessionId.slice(-6)}`))]);
  const sessionName = 'session/session.v4.jsonl.zstd';
  const entries = [{ name: sessionName, data: log }, ...extraEntries];
  const parts = { [sessionName]: { sha256: sha256(log), bytes: log.length } };
  for (const entry of extraEntries) parts[entry.name] = { sha256: sha256(Buffer.from(entry.data)), bytes: Buffer.from(entry.data).length };
  const manifest = {
    format: 'dshproj/1',
    plugin: { name: 'dsh-session-save', version: '0.4.2' },
    exportedAt: new Date().toISOString(),
    exportedBy: 'dshproj on test',
    session: { id: sessionId, title: '往返测试', cwd, createdAt, fileName: 'session.v4.jsonl.zstd', frames: 2, lines: 2, bytes: log.length },
    memoryFiles: extraEntries.filter((entry) => entry.name.startsWith('memory/')).map((entry) => entry.name),
    workspaceFiles: [],
    attachments: attachments ?? { objects: [], files: [], missing: [] },
    lock,
    parts,
  };
  return zipWrite([...entries, { name: 'manifest.json', data: Buffer.from(JSON.stringify(manifest), 'utf8') }]);
};

/* ───────────────────────── A. 真实会话往返 ───────────────────────── */
/* 样本：本机 session-403aa63e…（4708 帧 / 21 MB）取头部 80 帧。只读原文件。 */

const REAL_SESSION =
  process.env.DSH_RT_SESSION ??
  path.join(
    os.homedir(),
    '.dsh',
    'sessions',
    '--C-Users-aa-OneDrive~0020-~0020njtech.edu.cn-~6587~6863-dsh-workspace--',
    'session-403aa63e-080f-42f4-9e89-708110772440',
    'session.v4.jsonl.zstd',
  );

const realAvailable = fs.existsSync(REAL_SESSION);
let sample;
if (realAvailable === true) {
  const realBuf = fs.readFileSync(REAL_SESSION);
  const realFrames = scanZstdFrames(realBuf);
  const realHeader = headerOfBuf(realBuf);
  /* 只取 10 帧：默认上下文预算 150k token（约 480 KB 文本），取多了会被 trimSession 裁掉，
     那是另一条被测行为（见 A18），不该混进「往返保真」里。 */
  const take = Math.min(10, Math.max(1, realFrames.length - 1));
  const body = Buffer.concat(realFrames.slice(1, 1 + take).map((item) => realBuf.subarray(item.start, item.end)));
  const dir = path.join(fx.sessions, projectKey(fx.cwd), realHeader.id);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'session.v4.jsonl.zstd');
  const buf = Buffer.concat([frame(`${headerOf(realHeader.id, fx.cwd, realHeader.createdAt)}\n`), body]);
  fs.writeFileSync(file, buf);
  sample = { id: realHeader.id, dir, file, buf, header: { ...realHeader, cwd: fx.cwd }, frames: 1 + take, realFrames: realFrames.length, realBytes: realBuf.length };
  check(take >= 8, 'A0 真实会话样本已截取', `${REAL_SESSION} · 共 ${realFrames.length} 帧，取 ${take} 帧`);
} else {
  sample = writeSession({ id: `session-${randomUUID()}`, bodyFrames: 80, mark: 'real-fallback' });
  check(true, 'A0 真实会话不可用，退回 80 帧合成样本', REAL_SESSION);
}

{
  const target = path.join(fx.out, 'real-sample.dsproj');
  const saved = await call(saveRoute, ROUTE, { sessionId: sample.id, path: target });
  check(saved.body?.status === 'saved', 'A1 真实样本导出成功', `HTTP ${saved.status} · ${saved.body?.status}`);
  check(fs.existsSync(target) === true && fs.statSync(target).size > 0, 'A2 产物落盘且非空', `${fs.existsSync(target) ? fs.statSync(target).size : 0} 字节`);

  const entries = zipRead(fs.readFileSync(target));
  const manifest = JSON.parse(entries.get('manifest.json').toString('utf8'));
  check(manifest?.format === 'dshproj/1', 'A3 manifest 格式标注正确', String(manifest?.format));
  check(manifest?.session?.id === sample.id, 'A4 manifest 记下了会话 id', String(manifest?.session?.id));
  check(
    Number(manifest?.session?.frames) === sample.frames,
    'A5 manifest 帧数与源文件一致',
    `${manifest?.session?.frames} vs ${sample.frames}`,
  );
  const declaredOk = Object.entries(manifest?.parts ?? {}).every(([name, meta]) => {
    const data = entries.get(name);
    return data !== undefined && sha256(data) === meta.sha256 && data.length === meta.bytes;
  });
  check(declaredOk, 'A6 parts 里每条 sha256/bytes 都与包内实体一致');

  // 导进第二个 DSH_HOME：不能只验证「原机能打开」
  const home2 = path.join(fx.base, 'home-real');
  const opened = await withHome(home2, () => call(openRoute, OPEN_ROUTE, { path: target, cwd: fx.cwd }));
  check(opened.body?.status === 'opened', 'A7 另一台「机器」能导入', `HTTP ${opened.status} · ${opened.body?.status}`);
  const landed = String(opened.body?.target ?? '');
  const landedOk = landed !== '' && landed.startsWith(home2) && fs.existsSync(landed);
  check(landedOk, 'A8 落点在目标 DSH_HOME 的 sessions 下', landed);

  const landedBuf = landedOk ? fs.readFileSync(landed) : Buffer.alloc(0);
  const landedHeader = landedOk ? headerOfBuf(landedBuf) : {};
  check(landedHeader.id === sample.header.id, 'A9 会话 id 原样保留', String(landedHeader.id));
  check(Number(landedHeader.createdAt) === Number(sample.header.createdAt), 'A10 createdAt 原样保留', String(landedHeader.createdAt));
  check(path.resolve(String(landedHeader.cwd)) === path.resolve(fx.cwd), 'A11 cwd 落到指定工作区', String(landedHeader.cwd));
  const landedFrames = landedOk ? scanZstdFrames(landedBuf).length : -1;
  /* 体检（repairSession）只在确实要改的时候重排帧：没改时帧结构必须原样，改过就必须有记账。
     真实会话里有些附件对象本机没有，导入时会被换成文字占位——那是预期行为，不是丢数据。 */
  const repair = opened.body?.repair ?? {};
  const repairChanged = repair?.changed === true;
  const trim = opened.body?.context?.trim ?? {};
  const trimmedAway = trim?.trimmed === true;
  check(
    trimmedAway === true || repairChanged === true ? landedFrames >= 1 : landedFrames === sample.frames,
    'A12 没被裁剪、体检也没动过时帧数一帧不少',
    `frames=${landedFrames} / source=${sample.frames} / repair.changed=${repairChanged} / trimmed=${trimmedAway}`,
  );

  const linesOf = (buf) => textOf(buf).split(String.fromCharCode(10)).filter((line) => line.trim() !== '').length;
  const srcLines = linesOf(sample.buf);
  const landedLines = linesOf(landedBuf);
  const droppedLines = Number(repair?.lines?.dropped ?? 0);
  check(
    trimmedAway === true
      ? landedLines < srcLines && Number(trim?.droppedTurns) > 0
      : landedLines === srcLines - droppedLines,
    'A13 行数账目对得上（体检丢的行、被裁的轮次都单独记账）',
    `${srcLines} 行 → ${landedLines} 行 · repair.drop=${droppedLines} · trim.droppedTurns=${trim?.droppedTurns ?? 0}`,
  );
  check(
    textOf(landedBuf) === textOf(sample.buf) || repairChanged === true || trimmedAway === true,
    'A14 文本有出入必须由体检/裁剪报告解释（不能悄悄改内容）',
    repairChanged === true ? JSON.stringify(repair?.notes ?? []).slice(0, 140) : `trimmed=${trimmedAway}`,
  );
  check(
    repairChanged === false || (Array.isArray(repair?.notes) === true && repair.notes.length > 0),
    'A15 体检改过就要说明改了什么（repair.notes 非空）',
    JSON.stringify(repair?.notes ?? []).slice(0, 140),
  );
  check(
    fs.existsSync(path.join(home2, 'attachments')) === false,
    'A16 没有附件引用时不写空目录',
    fs.existsSync(path.join(home2, 'attachments')) ? '已建' : '未建',
  );

  const again = await withHome(home2, () => call(openRoute, OPEN_ROUTE, { path: target, cwd: fx.cwd }));
  check(again.body?.reused === true, 'A17 同机同工作区再打开复用本机这份', String(again.body?.reused));

  /* 预算这一刀必须自己说出来：超预算时只保留尾部完整 turn，并在日志里留一条说明。 */
  const home5 = path.join(fx.base, 'home-budget');
  const trimmed = await withHome(home5, () => call(openRoute, OPEN_ROUTE, { path: target, cwd: fx.cwd, contextBudget: '3000' }));
  const trimReport = trimmed.body?.context?.trim ?? {};
  check(
    trimReport?.trimmed === true && Number(trimReport?.droppedTurns) > 0,
    'A18 超预算导入时按整轮裁掉并给出裁剪报告',
    `droppedTurns=${trimReport?.droppedTurns} kept=${trimReport?.keptTurns}/${trimReport?.turns}`,
  );
  const trimmedBuf = fs.existsSync(String(trimmed.body?.target)) ? fs.readFileSync(String(trimmed.body?.target)) : Buffer.alloc(0);
  const turnStarts = textOf(trimmedBuf)
    .split(String.fromCharCode(10))
    .filter((line) => line.trim() !== '')
    .filter((line) => {
      try {
        return JSON.parse(line).type === 'turn/start';
      } catch {
        return false;
      }
    }).length;
  check(
    turnStarts === Number(trimReport?.keptTurns) && Number(trimReport?.keptTurns) + Number(trimReport?.droppedTurns) === Number(trimReport?.turns),
    'A19 裁剪后落盘的就是「保留的那几轮完整 turn」（账目自洽）',
    `turn/start=${turnStarts} kept=${trimReport?.keptTurns} + dropped=${trimReport?.droppedTurns} = ${trimReport?.turns}`,
  );
  check(
    textOf(trimmedBuf).includes('没有带进上下文'),
    'A20 被裁掉的轮次在日志里留了说明（用户看得到）',
  );
}

/* ───────────────────────── B. 合成干净会话：字节级往返 ───────────────────────── */

{
  const clean = writeSession({ bodyFrames: 6, mark: 'clean' });
  const target = path.join(fx.out, 'clean.dsproj');
  const saved = await call(saveRoute, ROUTE, { sessionId: clean.id, path: target });
  check(saved.body?.status === 'saved', 'B1 干净会话导出成功', String(saved.body?.status));

  // 先挪走原会话，逼导入走「本机没有 → 新建」那条路
  fs.rmSync(clean.dir, { recursive: true, force: true });
  const opened = await call(openRoute, OPEN_ROUTE, { path: target, cwd: fx.cwd });
  check(opened.body?.status === 'opened', 'B2 原会话删掉后仍能导入', String(opened.body?.status));
  const landed = String(opened.body?.target ?? '');
  const landedBuf = fs.existsSync(landed) ? fs.readFileSync(landed) : Buffer.alloc(0);
  check(textOf(landedBuf) === textOf(clean.buf), 'B3 解压文本逐字一致', `${textOf(landedBuf).length} 字符`);
  check(scanZstdFrames(landedBuf).length === scanZstdFrames(clean.buf).length, 'B4 帧数一致', `${scanZstdFrames(landedBuf).length}`);
  check(landedBuf.equals(clean.buf), 'B5 干净日志字节级一致（体检没有多改一个字节）', landedBuf.equals(clean.buf) ? 'identical' : `diff ${landedBuf.length} vs ${clean.buf.length}`);

  // 二次保存：复用记住的路径，不弹对话框
  const second = await call(saveRoute, ROUTE, { sessionId: clean.id });
  check(second.body?.status === 'saved' && path.resolve(String(second.body?.path)) === path.resolve(target), 'B6 二次保存复用同一路径', String(second.body?.path));

  // 包自带一份人可读的 SUMMARY.md：帧数/行数/体积都在里面
  const entries = zipRead(fs.readFileSync(target));
  const summary = entries.get('SUMMARY.md');
  const summaryText = summary === undefined ? '' : summary.toString('utf8');
  check(
    summaryText.includes('个 zstd 帧') && summaryText.includes(String(scanZstdFrames(clean.buf).length)),
    'B7 SUMMARY.md 记下帧数与行数',
    summary === undefined ? '(missing)' : summaryText.split(String.fromCharCode(10))[0],
  );
}

/* ───────────────────────── C. 附件回填 ───────────────────────── */

{
  const objectsRoot = path.join(fx.home, 'attachments', 'v1', 'objects');
  const filesRoot = path.join(fx.home, 'attachments', 'v1', 'file-objects');
  const objectPath = (root, sha) => path.join(root, sha.slice(0, 2), sha);
  const putObject = (root, data) => {
    const sha = sha256(data);
    const file = objectPath(root, sha);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, data);
    return sha;
  };

  const imgBytes = Buffer.from('fake-png-bytes-roundtrip-suite-0123456789', 'utf8');
  const fileBytes = Buffer.from('attachment payload for roundtrip test\n', 'utf8');
  const imgSha = putObject(objectsRoot, imgBytes);
  const fileSha = putObject(filesRoot, fileBytes);
  const missingSha = sha256(Buffer.from('never existed on this machine', 'utf8'));

  const refLine = (sha) =>
    JSON.stringify({
      type: 'message',
      at: 1792903201999,
      role: 'user',
      content: [
        { type: 'image', attachmentId: `sha256:${sha}` },
        { type: 'file', fileId: `sha256:${fileSha}` },
      ],
    });
  const refs = `${refLine(imgSha)}\n${JSON.stringify({ type: 'message', at: 1792903202000, role: 'assistant', content: [{ type: 'image', attachmentId: `sha256:${missingSha}` }] })}\n`;

  const withAttach = writeSession({ bodyFrames: 2, mark: 'attach', extraFrames: [refs] });
  const target = path.join(fx.out, 'attach.dsproj');
  const saved = await call(saveRoute, ROUTE, { sessionId: withAttach.id, path: target });
  check(saved.body?.status === 'saved', 'C1 带附件的会话导出成功', String(saved.body?.status));

  const entries = zipRead(fs.readFileSync(target));
  const imgEntry = `attachments/objects/${imgSha.slice(0, 2)}/${imgSha}`;
  const fileEntry = `attachments/files/${fileSha.slice(0, 2)}/${fileSha}`;
  check(entries.has(imgEntry), 'C2 图片对象进包（按 sha 分片命名）', imgEntry);
  check(entries.has(fileEntry), 'C3 文件对象进包', fileEntry);
  const manifest = JSON.parse(entries.get('manifest.json').toString('utf8'));
  check(
    (manifest?.attachments?.missing ?? []).some((item) => String(item).includes(missingSha)),
    'C4 本机缺的对象记进 manifest.missing',
    JSON.stringify(manifest?.attachments?.missing).slice(0, 120),
  );

  // 删掉本机对象，逼导入回填
  fs.rmSync(objectPath(objectsRoot, imgSha), { force: true });
  fs.rmSync(objectPath(filesRoot, fileSha), { force: true });
  const home3 = path.join(fx.base, 'home-attach');
  const opened = await withHome(home3, () => call(openRoute, OPEN_ROUTE, { path: target, cwd: fx.cwd }));
  check(opened.body?.status === 'opened', 'C5 附件对象缺失的包也能打开', String(opened.body?.status));
  check(Number(opened.body?.attachmentsWritten) === 2, 'C6 两个对象都回填了', String(opened.body?.attachmentsWritten));
  const backImg = path.join(home3, 'attachments', 'v1', 'objects', imgSha.slice(0, 2), imgSha);
  const backFile = path.join(home3, 'attachments', 'v1', 'file-objects', fileSha.slice(0, 2), fileSha);
  check(fs.existsSync(backImg) && fs.readFileSync(backImg).equals(imgBytes), 'C7 图片字节按哈希原样回来');
  check(fs.existsSync(backFile) && fs.readFileSync(backFile).equals(fileBytes), 'C8 文件字节按哈希原样回来');

  const twice = await withHome(home3, () => call(openRoute, OPEN_ROUTE, { path: target, cwd: fx.cwd }));
  check(Number(twice.body?.attachmentsWritten) === 0 && Number(twice.body?.attachmentsSkipped) === 2, 'C9 再导入幂等：0 写 2 跳过', `written=${twice.body?.attachmentsWritten} skipped=${twice.body?.attachmentsSkipped}`);

  // 篡改：文件名对、内容不对 → 拒绝写入，但会话照开
  const forged = Buffer.from('forged bytes claiming to be an object', 'utf8');
  const forgedName = `attachments/objects/${imgSha.slice(0, 2)}/${imgSha}`;
  const tampered = zipWrite([
    ...(() => {
      const bad = buildPackage({
        sessionId: `session-${randomUUID()}`,
        cwd: fx.cwd,
        extraEntries: [{ name: forgedName, data: forged }],
      });
      return [...zipRead(bad)].map(([name, data]) => ({ name, data }));
    })(),
  ]);
  const tamperedPath = path.join(fx.out, 'tampered.dsproj');
  fs.writeFileSync(tamperedPath, tampered);
  const home4 = path.join(fx.base, 'home-forged');
  const forgedOpen = await withHome(home4, () => call(openRoute, OPEN_ROUTE, { path: tamperedPath, cwd: fx.cwd }));
  check(forgedOpen.body?.status === 'opened', 'C10 被篡改的附件不阻断打开', String(forgedOpen.body?.status));
  check(Number(forgedOpen.body?.attachmentsRejected) >= 1, 'C11 伪造对象被拒（hash 与文件名不符）', String(forgedOpen.body?.attachmentsRejected));
  check(
    fs.existsSync(path.join(home4, 'attachments', 'v1', 'objects', imgSha.slice(0, 2), imgSha)) === false,
    'C12 伪造对象一个字节都没落盘',
  );
}

/* ───────────────────────── D. 备份开关：四个覆盖点 ───────────────────────── */

/* D-1 导入冲突选「覆盖」：默认留 .bak，backup=0 不留 */
{
  const id = `session-${randomUUID()}`;
  const homeA = path.join(fx.base, 'home-ov');
  const firstPack = path.join(fx.out, 'ov-first.dsproj');
  const secondPack = path.join(fx.out, 'ov-second.dsproj');
  fs.writeFileSync(firstPack, buildPackage({ sessionId: id, cwd: fx.cwd }));
  const opened = await withHome(homeA, () => call(openRoute, OPEN_ROUTE, { path: firstPack, cwd: fx.cwd }));
  const target = String(opened.body?.target ?? '');
  check(opened.body?.status === 'opened' && fs.existsSync(target), 'D1 第一份包正常落盘', target);
  const before = fs.readFileSync(target);
  fs.writeFileSync(secondPack, buildPackage({ sessionId: id, cwd: fx.cwd, createdAt: 1792903201888 }));

  const withBackup = await withHome(homeA, () => call(openRoute, OPEN_ROUTE, { path: secondPack, cwd: fx.cwd, onConflict: 'overwrite' }));
  check(withBackup.body?.status === 'opened' && withBackup.body?.conflictResolved === 'overwrite', 'D2 选「覆盖」结论正确', String(withBackup.body?.conflictResolved));
  const dir = path.dirname(target);
  const baksAfter = baks(dir, path.basename(target));
  check(baksAfter.length === 1, 'D3 默认留了一份 .bak', baksAfter.join(', ') || '(none)');
  const bakBytes = baksAfter.length === 1 ? fs.readFileSync(path.join(dir, baksAfter[0])) : Buffer.alloc(0);
  check(bakBytes.equals(before), 'D4 .bak 里是被覆盖前的原始字节');
  check(fs.readFileSync(target).equals(before) === false, 'D5 目标文件内容确实换了');

  const countBefore = baks(dir, path.basename(target)).length;
  fs.writeFileSync(secondPack, buildPackage({ sessionId: id, cwd: fx.cwd, createdAt: 1792903201899 }));
  const noBackup = await withHome(homeA, () => call(openRoute, OPEN_ROUTE, { path: secondPack, cwd: fx.cwd, onConflict: 'overwrite', backup: '0' }));
  check(noBackup.body?.status === 'opened', 'D6 关掉备份后覆盖仍然成功', String(noBackup.body?.status));
  check(baks(dir, path.basename(target)).length === countBefore, 'D7 关掉备份后没多出 .bak', `${countBefore} -> ${baks(dir, path.basename(target)).length}`);
}

/* D-2 合并记忆（restore）：默认先备份、backup=0 直接盖 */
{
  const memoryRel = 'MEMORY.md';
  const memoryDir = path.join(fx.memory, projectKey(fx.cwd));
  fs.mkdirSync(memoryDir, { recursive: true });
  fs.writeFileSync(path.join(memoryDir, memoryRel), 'LOCAL-OLD\n');

  const packOf = (sessionId, text) =>
    path.join(fx.out, `mem-${sessionId.slice(-6)}.dsproj`);
  const writeMemPack = (sessionId, text) => {
    const file = packOf(sessionId, text);
    fs.writeFileSync(
      file,
      buildPackage({
        sessionId,
        cwd: fx.cwd,
        extraEntries: [{ name: `memory/workspaces/${path.basename(memoryDir)}/${memoryRel}`, data: Buffer.from(text, 'utf8') }],
      }),
    );
    return file;
  };

  const id1 = `session-${randomUUID()}`;
  const merged = await call(openRoute, OPEN_ROUTE, { path: writeMemPack(id1, 'REMOTE-NEW\n'), cwd: fx.cwd, memory: 'restore' });
  check(merged.body?.status === 'opened', 'D8 合并记忆成功', String(merged.body?.status));
  check(fs.readFileSync(path.join(memoryDir, memoryRel), 'utf8') === 'REMOTE-NEW\n', 'D9 本机记忆被换成包里的内容');
  const memBaks = baks(memoryDir, memoryRel);
  check(memBaks.length === 1, 'D10 默认先备份了一份记忆', memBaks.join(', ') || '(none)');
  check(
    memBaks.length === 1 && fs.readFileSync(path.join(memoryDir, memBaks[0]), 'utf8') === 'LOCAL-OLD\n',
    'D11 备份里是被覆盖前的原文',
  );
  const conflictEntry = (merged.body?.memoryConflicts ?? [])[0];
  check(
    conflictEntry !== undefined && typeof conflictEntry?.backup === 'string' && fs.existsSync(conflictEntry.backup) === true,
    'D12 返回体带出备份路径（界面要显示给用户）',
    String(conflictEntry?.backup),
  );

  const countBefore = baks(memoryDir, memoryRel).length;
  const id2 = `session-${randomUUID()}`;
  const noBak = await call(openRoute, OPEN_ROUTE, { path: writeMemPack(id2, 'REMOTE-2\n'), cwd: fx.cwd, memory: 'restore', backup: '0' });
  check(noBak.body?.status === 'opened', 'D13 关掉备份后合并仍然成功', String(noBak.body?.status));
  check(fs.readFileSync(path.join(memoryDir, memoryRel), 'utf8') === 'REMOTE-2\n', 'D14 内容照样换成包里的');
  check(baks(memoryDir, memoryRel).length === countBefore, 'D15 关掉备份后没多出 .bak', `${countBefore} -> ${baks(memoryDir, memoryRel).length}`);
  const noBakEntry = (noBak.body?.memoryConflicts ?? [])[0];
  check(noBakEntry === undefined || noBakEntry?.backup === undefined, 'D16 不备份时返回体里不再报备份路径', JSON.stringify(noBakEntry));
}

/* D-3 bili 状态回填：默认留 .bak，backup=0 不留 */
{
  const biliRoot = path.join(fx.base, 'bili-sessions');
  const before = process.env.BILI_SESSIONS_DIR;
  process.env.BILI_SESSIONS_DIR = biliRoot;
  try {
    const id = `session-${randomUUID()}`;
    const host = 'api.deepseek.com';
    const idHash = sha256(Buffer.from(id, 'utf8')).slice(0, 24);
    const dir = path.join(biliRoot, 'anthropic');
    const dest = path.join(dir, `${host}_${idHash}.json`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(dest, JSON.stringify({ id, savedAt: 1000, marker: 'LOCAL' }));
    // 回填代码会给「刚被写过」的文件让路（mtime 2 秒内 → busy）。把它往前拨一分钟。
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(dest, old, old);

    const packOf = (savedAt, marker) => {
      const file = path.join(fx.out, `bili-${marker}.dsproj`);
      const wrapper = Buffer.from(
        JSON.stringify({
          plugin: 'billion-context',
          schema: 3,
          sessionId: id,
          protocol: 'anthropic',
          host,
          savedAt,
          state: { id, savedAt, meta: { protocol: 'anthropic', upstreamOrigin: `https://${host}` }, marker },
        }),
        'utf8',
      );
      fs.writeFileSync(file, buildPackage({ sessionId: id, cwd: fx.cwd, extraEntries: [{ name: 'bili/session.json', data: wrapper }] }));
      return file;
    };

    const first = await call(openRoute, OPEN_ROUTE, { path: packOf(2000, 'PACK2'), cwd: fx.cwd });
    check(first.body?.status === 'opened' && Number(first.body?.bili?.written) === 1, 'D17 bili 状态回填成功', JSON.stringify(first.body?.bili));
    check(JSON.parse(fs.readFileSync(dest, 'utf8')).marker === 'PACK2', 'D18 本机状态换成包里的那份');
    const biliBaks = baks(dir, path.basename(dest));
    check(biliBaks.length === 1, 'D19 默认先备份 bili 状态', biliBaks.join(', ') || '(none)');
    check(biliBaks.length === 1 && JSON.parse(fs.readFileSync(path.join(dir, biliBaks[0]), 'utf8')).marker === 'LOCAL', 'D20 备份里是覆盖前的旧状态');

    // 第二份：把本机状态改成更晚的时间，才能再走一次覆盖；备份计数不应增加
    const countBefore = baks(dir, path.basename(dest)).length;
    fs.writeFileSync(dest, JSON.stringify({ id, savedAt: 2500, marker: 'LOCAL2' }));
    const old2 = new Date(Date.now() - 60_000);
    fs.utimesSync(dest, old2, old2);
    const second = await call(openRoute, OPEN_ROUTE, { path: packOf(3000, 'PACK3'), cwd: fx.cwd, backup: '0' });
    check(second.body?.status === 'opened' && Number(second.body?.bili?.written) === 1, 'D21 关掉备份后 bili 回填仍然成功', JSON.stringify(second.body?.bili));
    check(JSON.parse(fs.readFileSync(dest, 'utf8')).marker === 'PACK3', 'D22 状态内容照样换成包里的');
    check(baks(dir, path.basename(dest)).length === countBefore, 'D23 关掉备份后没多出 bili 备份', `${countBefore} -> ${baks(dir, path.basename(dest)).length}`);
  } finally {
    if (before === undefined) delete process.env.BILI_SESSIONS_DIR;
    else process.env.BILI_SESSIONS_DIR = before;
  }
}

/* D-4 保存：磁盘内容被改过（stale）后强制覆盖 */
{
  const session = writeSession({ bodyFrames: 3, mark: 'stale' });
  const target = path.join(fx.out, 'stale.dsproj');
  const first = await call(saveRoute, ROUTE, { sessionId: session.id, path: target });
  check(first.body?.status === 'saved', 'D24 首次保存成功', String(first.body?.status));
  const writtenBytes = fs.readFileSync(target);

  // 模拟「另一台机器/同步盘改过」：换个字节再写回，sha 变了就是 stale
  const tampered = Buffer.concat([writtenBytes.subarray(0, 4), Buffer.from([0x00]), writtenBytes.subarray(5)]);
  fs.writeFileSync(target, tampered);
  const stale = await call(saveRoute, ROUTE, { sessionId: session.id });
  check(stale.body?.status === 'stale' && stale.status === 409, 'D25 内容被改过时停下来问（409 stale）', `HTTP ${stale.status} · ${stale.body?.status}`);
  check(typeof stale.body?.stale?.expected === 'string' && typeof stale.body?.stale?.actual === 'string', 'D26 stale 载荷带 expected/actual 指纹');

  const countBefore = baks(path.dirname(target), path.basename(target)).length;
  const forced = await call(saveRoute, ROUTE, { sessionId: session.id, force: '1' });
  check(forced.body?.status === 'saved', 'D27 确认覆盖后写入成功', String(forced.body?.status));
  const afterBaks = baks(path.dirname(target), path.basename(target));
  check(afterBaks.length === countBefore + 1, 'D28 stale 强制覆盖、勾着备份 → 留了一份 .bak', `${countBefore} -> ${afterBaks.length}`);
  const newestBak = afterBaks.length > 0 ? fs.readFileSync(path.join(path.dirname(target), afterBaks.sort().slice(-1)[0])) : Buffer.alloc(0);
  check(newestBak.equals(tampered), 'D29 .bak 里是「被换掉的那份」（不是我们刚写的那份）');

  // 再来一次：这次关掉备份
  fs.writeFileSync(target, Buffer.concat([fs.readFileSync(target).subarray(0, 4), Buffer.from([0x11]), fs.readFileSync(target).subarray(5)]));
  const count2 = baks(path.dirname(target), path.basename(target)).length;
  const forcedNoBak = await call(saveRoute, ROUTE, { sessionId: session.id, force: '1', backup: '0' });
  check(forcedNoBak.body?.status === 'saved', 'D30 关掉备份后强制覆盖仍成功', String(forcedNoBak.body?.status));
  check(baks(path.dirname(target), path.basename(target)).length === count2, 'D31 关掉备份后没多出 .bak', `${count2} -> ${baks(path.dirname(target), path.basename(target)).length}`);
}

/* D-5 保存到「陌生同名文件」：覆盖别人放在那儿的包 */
{
  const session = writeSession({ bodyFrames: 2, mark: 'foreign' });
  const mine = path.join(fx.out, 'foreign-mine.dsproj');
  const foreign = path.join(fx.out, 'foreign-other.dsproj');
  const first = await call(saveRoute, ROUTE, { sessionId: session.id, path: mine });
  check(first.body?.status === 'saved', 'D32 先保存一份自己的包', String(first.body?.status));
  fs.copyFileSync(mine, foreign);
  const foreignBefore = fs.readFileSync(foreign);

  const ask = await call(saveRoute, ROUTE, { sessionId: session.id, path: foreign });
  check(ask.body?.status === 'confirm-overwrite' && ask.status === 409, 'D33 覆盖陌生文件前先问（409 confirm-overwrite）', `HTTP ${ask.status} · ${ask.body?.status}`);
  const notDsproj = path.join(fx.out, 'not-a-package.dsproj');
  fs.writeFileSync(notDsproj, 'this is not a zip at all, just text');
  const refused = await call(saveRoute, ROUTE, { sessionId: session.id, path: notDsproj, force: '1' });
  check(refused.body?.status === 'not-dsproj', 'D34 不是工程包的文件拒绝覆盖', String(refused.body?.status));

  const countBefore = baks(path.dirname(foreign), path.basename(foreign)).length;
  const forced = await call(saveRoute, ROUTE, { sessionId: session.id, path: foreign, force: '1' });
  check(forced.body?.status === 'saved', 'D35 确认后覆盖陌生包成功', String(forced.body?.status));
  const afterBaks = baks(path.dirname(foreign), path.basename(foreign));
  check(afterBaks.length === countBefore + 1, 'D36 覆盖陌生包前留了 .bak', `${countBefore} -> ${afterBaks.length}`);
  check(
    afterBaks.length === countBefore + 1 && fs.readFileSync(path.join(path.dirname(foreign), afterBaks.sort().slice(-1)[0])).equals(foreignBefore),
    'D37 .bak 里是那个陌生文件的原始字节',
  );

  fs.copyFileSync(mine, foreign);
  const count2 = baks(path.dirname(foreign), path.basename(foreign)).length;
  const forcedNoBak = await call(saveRoute, ROUTE, { sessionId: session.id, path: foreign, force: '1', backup: '0' });
  check(forcedNoBak.body?.status === 'saved', 'D38 关掉备份后覆盖陌生包仍成功', String(forcedNoBak.body?.status));
  check(baks(path.dirname(foreign), path.basename(foreign)).length === count2, 'D39 关掉备份后没多出 .bak', `${count2} -> ${baks(path.dirname(foreign), path.basename(foreign)).length}`);
}

/* ───────────────────────── E. 冲突 / 记忆清单的返回体 ───────────────────────── */
{
  const id = `session-${randomUUID()}`;
  const homeC = path.join(fx.base, 'home-conflict');
  const packA = path.join(fx.out, 'c-a.dsproj');
  const packB = path.join(fx.out, 'c-b.dsproj');
  fs.writeFileSync(packA, buildPackage({ sessionId: id, cwd: fx.cwd }));
  const opened = await withHome(homeC, () => call(openRoute, OPEN_ROUTE, { path: packA, cwd: fx.cwd }));
  check(opened.body?.status === 'opened', 'E1 冲突用例的第一份包先落盘', String(opened.body?.status));

  const lockedAt = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
  fs.writeFileSync(
    packB,
    buildPackage({
      sessionId: id,
      cwd: fx.cwd,
      createdAt: 1792903201899,
      lock: { format: 'dshproj-lock/1', host: 'test-host', pid: 4242, at: lockedAt, writes: 3, writer: '往返测试' },
    }),
  );
  const conflict = await withHome(homeC, () => call(openRoute, OPEN_ROUTE, { path: packB, cwd: fx.cwd }));
  check(conflict.body?.status === 'conflict' && conflict.status === 409, 'E2 同 id 不同内容 → 409 conflict', `HTTP ${conflict.status} · ${conflict.body?.status}`);
  check(
    conflict.body?.existing?.id === id && conflict.body?.incoming?.id === id,
    'E3 冲突载荷两侧 id 都在（界面要对账）',
    `${conflict.body?.existing?.createdAt} vs ${conflict.body?.incoming?.createdAt}`,
  );
  check(
    conflict.body?.incoming?.lock?.host === 'test-host' && Number(conflict.body?.incoming?.lock?.writes) === 3,
    'E4 冲突载荷带出包里的写锁信息（写了几次、在谁那儿）',
    JSON.stringify(conflict.body?.incoming?.lock ?? null).slice(0, 120),
  );

  // 记忆默认只落副本：返回体要给「将覆盖 / 将新建」清单
  const memoryDir = path.join(fx.memory, projectKey(fx.cwd));
  const memRel = 'handoff/PLAN.md';
  fs.mkdirSync(path.join(memoryDir, 'handoff'), { recursive: true });
  fs.writeFileSync(path.join(memoryDir, memRel), 'PLAN-LOCAL\n');
  const id2 = `session-${randomUUID()}`;
  const memPack = path.join(fx.out, 'c-mem.dsproj');
  fs.writeFileSync(
    memPack,
    buildPackage({
      sessionId: id2,
      cwd: fx.cwd,
      extraEntries: [
        { name: `memory/workspaces/${path.basename(memoryDir)}/${memRel}`, data: Buffer.from('PLAN-REMOTE\n', 'utf8') },
        { name: `memory/workspaces/${path.basename(memoryDir)}/handoff/NEW.md`, data: Buffer.from('NEW\n', 'utf8') },
      ],
    }),
  );
  const copyMode = await call(openRoute, OPEN_ROUTE, { path: memPack, cwd: fx.cwd });
  check(copyMode.body?.status === 'opened', 'E5 默认导入（只落副本）成功', String(copyMode.body?.status));
  const planned = Array.isArray(copyMode.body?.memoryPlanned) ? copyMode.body.memoryPlanned : [];
  check(planned.length === 2, 'E6 返回体摊出全部记忆清单', JSON.stringify(planned));
  check(planned.some((item) => item.rel === memRel && item.exists === true), 'E7 已存在的文件标 exists=true（将被覆盖）');
  check(
    planned.some((item) => item.rel === 'handoff/NEW.md' && item.exists === false),
    'E8 本机没有的文件标 exists=false（将新建）',
    JSON.stringify(planned),
  );
  check(
    fs.readFileSync(path.join(memoryDir, memRel), 'utf8') === 'PLAN-LOCAL\n',
    'E9 默认模式绝不覆盖原名（只落 .from-dsproj- 副本）',
  );
}

/* ───────────────────────── 收尾 ───────────────────────── */
fs.rmSync(fx.base, { recursive: true, force: true });
check(!fs.existsSync(fx.base), '临时目录已清理', fx.base);

console.log(`\n往返/备份：通过 ${passed} 条，失败 ${failed} 条`);
if (failed > 0) {
  console.error(`\n✗ roundtrip 自检失败：${failed} 条`);
  process.exit(1);
}
console.log('\n✅ roundtrip 自检通过');
