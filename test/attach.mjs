/**
 * 附件对象随包走、导入时回填（F51）。
 *
 * 为什么需要这一套：会话日志里图片/文件只留 `sha256:` 引用，字节在
 * `DSH_HOME/attachments/v1/{objects,file-objects}/<前两位>/<sha>` 里。
 * 只打包日志，换台机器打开就是 ATTACHMENT_NOT_FOUND —— 而且重试不会自愈，
 * 因为引用指向的是一段固定哈希。所以打包必须把命中的对象一起带走，
 * 导入必须按哈希回填。
 *
 * 这里同时在验三件事：
 *   1. 打包：命中的对象进包、缺的对象进 manifest.attachments.missing 并写进 SUMMARY.md；
 *   2. 回填：对象被删掉之后重新打开这个包，字节能按哈希回到原路径；
 *   3. 幂等：再打开一次只会记 skipped —— 内容寻址下「已存在」就是「同一份」。
 *
 *   node plugins/dsh-session-save/test/attach.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { createHash } from 'node:crypto';

import { autoCleanup, loadRoutes, makeFixture } from './fixture.mjs';

// fixture 必须先建好：index.js 的 dshHome() 在运行时读 DSH_HOME。
const fx = makeFixture();
autoCleanup(fx);

const { mod, routes } = await loadRoutes('../index.js');
const { ROUTE, OPEN_ROUTE, scanZstdFrames, zipRead } = mod;
const saveRoute = routes.get(ROUTE);
const openRoute = routes.get(OPEN_ROUTE);
if (saveRoute === undefined) throw new Error(`route was not registered: ${ROUTE}`);
if (openRoute === undefined) throw new Error(`route was not registered: ${OPEN_ROUTE}`);

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const ZSTD_OPTS = { params: { [zlib.constants.ZSTD_c_checksumFlag]: 1 } };
const frame = (text) => zlib.zstdCompressSync(Buffer.from(text, 'utf8'), ZSTD_OPTS);

/* ── 1. 造两个真实对象：一张「图」、一个「文件」 ── */

const imgBytes = Buffer.from('fake-png-bytes-for-attachment-test-0123456789', 'utf8');
const imgSha = sha256(imgBytes);
const fileBytes = Buffer.from('hello from a text attachment\n', 'utf8');
const fileSha = sha256(fileBytes);
// 故意引用一个本机没有的对象：打包时要进 missing，而不是报错或静默当成有
const missingSha = sha256(Buffer.from('this object never existed on this machine', 'utf8'));

const objectsRoot = path.join(fx.home, 'attachments', 'v1', 'objects');
const fileObjectsRoot = path.join(fx.home, 'attachments', 'v1', 'file-objects');
const objectPath = (root, sha) => path.join(root, sha.slice(0, 2), sha);
const putObject = (root, sha, data) => {
  const file = objectPath(root, sha);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, data);
  return file;
};

const imgFile = putObject(objectsRoot, imgSha, imgBytes);
const fileFile = putObject(fileObjectsRoot, fileSha, fileBytes);
console.log('✅ 夹具里准备好两个内容寻址对象（图片 objects / 文件 file-objects）');

/* ── 2. 把这三个引用写进会话日志（真实日志里就是这么引用的） ── */

const original = fs.readFileSync(fx.session.file);
const frames = scanZstdFrames(original);
if (frames.length === 0) throw new Error('夹具会话不是 zstd 帧');
const headerFrame = original.subarray(frames[0].start, frames[0].end);
const bodyText = `${[
  JSON.stringify({ type: 'turn/start', at: 1792340086211, turn: 1 }),
  JSON.stringify({
    type: 'message',
    at: 1792340086212,
    role: 'user',
    content: [
      { type: 'text', text: '看看这张图和这个文件' },
      { type: 'image', attachmentId: `sha256:${imgSha}` },
      { type: 'file', fileId: `sha256:${fileSha}` },
      { type: 'image', attachmentId: `sha256:${missingSha}` },
    ],
  }),
  JSON.stringify({ type: 'turn/end', at: 1792340086213, turn: 1 }),
].join('\n')}\n`;
fs.writeFileSync(fx.session.file, Buffer.concat([headerFrame, frame(bodyText)]));
console.log('✅ 会话日志里写入 3 个引用（2 个本机有、1 个本机没有）');

/* ── 3. 保存：包里要带上那两个对象 ── */

const tmp = fs.mkdtempSync(path.join(fx.base, 'attach-'));
const target = path.join(tmp, 'attach.dsproj');
const stateFile = path.join(fx.home, 'storages', 'session-save.json');
const stateBackup = fs.existsSync(stateFile) ? fs.readFileSync(stateFile, 'utf8') : undefined;
const restoreState = () => {
  if (stateBackup === undefined) fs.rmSync(stateFile, { force: true });
  else fs.writeFileSync(stateFile, stateBackup);
};
{
  const state = stateBackup === undefined ? {} : JSON.parse(stateBackup);
  state.lastDir = tmp;
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
}

try {
  const saved = await saveRoute(
    new Request(
      `http://127.0.0.1:3080${ROUTE}?sessionId=${encodeURIComponent(fx.session.id)}&path=${encodeURIComponent(target)}`,
    ),
  );
  const savedBody = await saved.json();
  if (saved.status !== 200 || savedBody.status !== 'saved') {
    throw new Error(`保存失败: ${saved.status} ${JSON.stringify(savedBody)}`);
  }
  console.log('✅ 保存成功 · HTTP 200 saved');

  const entries = zipRead(fs.readFileSync(target));
  const imgEntry = `attachments/objects/${imgSha.slice(0, 2)}/${imgSha}`;
  const fileEntry = `attachments/files/${fileSha.slice(0, 2)}/${fileSha}`;
  if (!entries.has(imgEntry)) throw new Error(`包里缺图片对象条目 ${imgEntry}`);
  if (!entries.has(fileEntry)) throw new Error(`包里缺文件对象条目 ${fileEntry}`);
  console.log('✅ 两个对象都进包了（attachments/objects/<2>/<sha> 与 attachments/files/<2>/<sha>）');

  if (!entries.get(imgEntry).equals(imgBytes)) throw new Error('包里的图片对象字节不一致');
  if (!entries.get(fileEntry).equals(fileBytes)) throw new Error('包里的文件对象字节不一致');
  console.log('✅ 包里的对象字节与原对象逐字节一致');

  const manifest = JSON.parse(entries.get('manifest.json').toString('utf8'));
  const att = manifest.attachments ?? {};
  if ((att.objects ?? []).length !== 1) throw new Error(`manifest.attachments.objects 应为 1，实际 ${(att.objects ?? []).length}`);
  if ((att.files ?? []).length !== 1) throw new Error(`manifest.attachments.files 应为 1，实际 ${(att.files ?? []).length}`);
  if (!(att.missing ?? []).includes(`sha256:${missingSha}`)) {
    throw new Error(`manifest.attachments.missing 没记下本机缺的那个: ${JSON.stringify(att.missing)}`);
  }
  console.log('✅ manifest 记下 1 图 / 1 文件 / 1 个本机就缺的引用');

  const summary = entries.get('SUMMARY.md').toString('utf8');
  if (!summary.includes('随包带走 2 个')) throw new Error('SUMMARY.md 没写随包带了几个附件');
  if (!summary.includes(missingSha)) throw new Error('SUMMARY.md 没列出打包时就缺的对象');
  console.log('✅ SUMMARY.md 说明了随包数量，并列出打包时就缺的那个');

  /* ── 4. 把本机这两个对象删掉，再从包里打开 —— 应该按哈希回填 ── */

  fs.rmSync(imgFile, { force: true });
  fs.rmSync(fileFile, { force: true });
  if (fs.existsSync(imgFile) || fs.existsSync(fileFile)) throw new Error('对象没删掉，后面的回填验证没有意义');

  const opened = await openRoute(
    new Request(
      `http://127.0.0.1:3080${OPEN_ROUTE}?path=${encodeURIComponent(target)}&cwd=${encodeURIComponent(fx.cwd)}`,
    ),
  );
  const openedBody = await opened.json();
  if (opened.status !== 200) throw new Error(`打开失败: ${opened.status} ${JSON.stringify(openedBody)}`);
  if (openedBody.attachmentsWritten !== 2) {
    throw new Error(`应回填 2 个对象，实际 ${openedBody.attachmentsWritten}（${JSON.stringify(openedBody)}）`);
  }
  if (openedBody.attachmentsRejected !== 0) throw new Error('不应该有被拒的对象');
  console.log('✅ 打开时按内容哈希回填 2 个对象 · attachmentsWritten=2');

  if (!fs.existsSync(imgFile)) throw new Error('图片对象没回到原路径');
  if (!fs.existsSync(fileFile)) throw new Error('文件对象没回到原路径');
  if (!fs.readFileSync(imgFile).equals(imgBytes)) throw new Error('回填的图片对象字节不对');
  if (!fs.readFileSync(fileFile).equals(fileBytes)) throw new Error('回填的文件对象字节不对');
  if (fs.existsSync(objectPath(objectsRoot, missingSha))) throw new Error('本机本来就没有的对象不该被凭空造出来');
  console.log('✅ 字节回到 <前两位>/<sha>，本机本来没有的那个没有被凭空造出来');

  /* ── 5. 再打开一次：内容寻址天然幂等，只记 skipped ── */

  const again = await openRoute(
    new Request(
      `http://127.0.0.1:3080${OPEN_ROUTE}?path=${encodeURIComponent(target)}&cwd=${encodeURIComponent(fx.cwd)}`,
    ),
  );
  const againBody = await again.json();
  if (again.status !== 200) throw new Error(`第二次打开失败: ${again.status} ${JSON.stringify(againBody)}`);
  if (againBody.attachmentsWritten !== 0) throw new Error(`第二次不该再写，实际写了 ${againBody.attachmentsWritten}`);
  if (againBody.attachmentsSkipped !== 2) throw new Error(`第二次应跳过 2 个，实际 ${againBody.attachmentsSkipped}`);
  if (!fs.readFileSync(imgFile).equals(imgBytes)) throw new Error('第二次打开把已有对象改坏了');
  console.log('✅ 重复导入幂等：attachmentsWritten=0 / attachmentsSkipped=2');

  console.log('✅ attach 自检通过（7 条）');
} finally {
  restoreState();
  fx.cleanup();
}
