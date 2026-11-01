/**
 * 打开前体检（F52）。
 *
 * 为什么要这一步：会话日志是外部输入。坏行、引用了本机没有的附件对象、缺尺寸的图片，
 * 都会在 DSH 里变成「一打开就报错」——而导入是一次性迁移，用户没机会回头补。
 * 所以 importPackage 在落盘前跑一遍 repairSession，能确定坏的就地修掉。
 *
 * 这里验的边界（都不碰网络、不碰真实 ~/.dsh）：
 *   1. 干净的日志一个字节都不改（changed=false，buffer 原样返回）；
 *   2. 引用了不存在的对象 → 换成文字占位，不让它变成 ATTACHMENT_NOT_FOUND；
 *   3. 对象在但尺寸/字节数缺失 → 按对象文件的真实头部补上；
 *   4. 读不懂的行丢掉（留着整条会话打不开）；
 *   5. 帧结构保持不变 —— 没改的帧沿用原字节，改过的帧才重压；
 *   6. keepMissing=true 时只报告不动手（用于「先看看」的场景）。
 *
 *   node plugins/dsh-session-save/test/repair.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { createHash } from 'node:crypto';

import { autoCleanup, loadRoutes, makeFixture } from './fixture.mjs';

const fx = makeFixture();
autoCleanup(fx);

const { mod } = await loadRoutes('../index.js');
const { repairSession, scanZstdFrames } = mod;
if (typeof repairSession !== 'function') throw new Error('repairSession 没有导出');

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const ZSTD_OPTS = { params: { [zlib.constants.ZSTD_c_checksumFlag]: 1 } };
const frame = (text) => zlib.zstdCompressSync(Buffer.from(text, 'utf8'), ZSTD_OPTS);
const decodeAll = (buffer) =>
  scanZstdFrames(buffer)
    .map((item) => {
      try {
        return zlib.zstdDecompressSync(buffer.subarray(item.start, item.end)).toString('utf8');
      } catch {
        return '';
      }
    })
    .join('');

/* ── 夹具：一张真 PNG 头（只有头，够读尺寸）+ 一张断链 ── */

const pngHead = (width, height) => {
  const buf = Buffer.alloc(64, 0x11);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0);
  buf.writeUInt32BE(13, 8);
  buf.write('IHDR', 12, 'ascii');
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  return buf;
};

const objectsRoot = path.join(fx.home, 'attachments', 'v1', 'objects');
const putObject = (sha, data) => {
  const file = path.join(objectsRoot, sha.slice(0, 2), sha);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, data);
  return { file, bytes: data.length };
};

const goodPng = pngHead(640, 480);
const goodSha = sha256(goodPng);
const good = putObject(goodSha, goodPng);
const absentSha = sha256(Buffer.from('这一份从来没在这台机器上存在过', 'utf8'));

const header = (id) =>
  JSON.stringify({
    type: 'session',
    id,
    cwd: fx.session.header.cwd,
    createdAt: fx.session.header.createdAt,
  });

const imagePart = (sha, extra = {}) => ({
  type: 'image',
  attachment: {
    attachmentId: `sha256:${sha}`,
    mediaType: 'image/png',
    bytes: extra.bytes ?? good.bytes,
    width: extra.width ?? 640,
    height: extra.height ?? 480,
    name: extra.name ?? 'page-1.png',
  },
});

const message = (part) =>
  JSON.stringify({
    type: 'message',
    id: `msg-${Math.random().toString(16).slice(2)}`,
    message: { role: 'user', content: [{ type: 'text', text: '看图' }, part] },
  });

const build = (lines) => Buffer.concat(lines.map((line) => frame(line + '\n')));

/* ── 1. 干净日志：一个字节都不改 ── */

const clean = build([header('session-clean-0001'), message(imagePart(goodSha))]);
const cleanFramesBefore = scanZstdFrames(clean).length;
const cleanOut = repairSession(clean);
if (cleanOut.report.changed !== false) throw new Error('干净日志被改动了');
if (cleanOut.buffer.equals(clean) === false) throw new Error('干净日志返回的字节不一致');
if (cleanOut.report.parts.total !== 1) throw new Error('没数到那个 image part');
if (cleanOut.report.parts.missing !== 0) throw new Error('把健康的图判成缺失了');
if (cleanOut.report.frames.total !== cleanFramesBefore) throw new Error('帧数被改了');
console.log('✅ 干净日志原样返回：changed=false、字节一致、帧数不变');

/* ── 2. 断链：换成文字占位，不给 ATTACHMENT_NOT_FOUND 留机会 ── */

const broken = build([
  header('session-broken-0002'),
  message(imagePart(absentSha, { name: 'lost.png' })),
]);
const brokenOut = repairSession(broken);
const brokenText = decodeAll(brokenOut.buffer);
if (brokenOut.report.changed !== true) throw new Error('断链没有被修');
if (brokenOut.report.parts.missing !== 1) throw new Error('没数到缺失的图片');
if (brokenOut.report.parts.dropped !== 1) throw new Error('没换掉那个图');
if (brokenText.includes('"type":"image"')) throw new Error('断链的 image part 还在');
if (brokenText.includes('[图片已丢失：lost.png]') === false) throw new Error('占位文字没写上');
if (brokenOut.report.notes.length === 0) throw new Error('没给用户留说明');
console.log('✅ 断链图片换成文字占位，并留下可读说明');

/* ── 3. 缺尺寸/字节数：按对象文件补回真实值 ── */

const thin = build([
  header('session-thin-0003'),
  message({ type: 'image', attachment: { attachmentId: `sha256:${goodSha}`, mediaType: 'image/png', name: 'thin.png' } }),
]);
const thinOut = repairSession(thin);
if (thinOut.report.parts.patched !== 1) throw new Error('没有补齐缺失字段');
const thinText = decodeAll(thinOut.buffer);
const thinEvent = JSON.parse(thinText.split('\n')[1]);
const thinAtt = thinEvent.message.content[1].attachment;
if (thinAtt.width !== 640 || thinAtt.height !== 480) {
  throw new Error(`尺寸没按 PNG 头补对：${thinAtt.width}x${thinAtt.height}`);
}
if (thinAtt.bytes !== good.bytes) throw new Error(`字节数没补对：${thinAtt.bytes} != ${good.bytes}`);
if (thinAtt.attachmentId !== `sha256:${goodSha}`) throw new Error('attachmentId 被改坏了');
console.log('✅ 缺尺寸的图片按对象文件头补成 640x480、字节数对齐');

/* ── 4. 坏行：丢掉，但同帧其余行保住 ── */

const dirty = build([
  header('session-dirty-0004'),
  message(imagePart(goodSha)),
  '{ 这一行不是 JSON',
]);
const dirtyOut = repairSession(dirty);
if (dirtyOut.report.lines.dropped !== 1) throw new Error('坏行没被丢掉');
if (dirtyOut.report.lines.total !== 3) throw new Error('总行数不对');
const dirtyText = decodeAll(dirtyOut.buffer);
for (const line of dirtyText.split('\n')) {
  if (line.trim() === '') continue;
  JSON.parse(line); // 一行都不许剩
}
if (dirtyText.includes('这一行不是 JSON')) throw new Error('坏行还在');
console.log('✅ 读不懂的行被丢掉，同帧其余行仍是合法 JSON');

/* ── 5. 帧结构：没改的帧沿用原字节 ── */

const twoFrames = Buffer.concat([
  frame(header('session-frames-0005') + '\n' + message(imagePart(goodSha)) + '\n'),
  frame(message(imagePart(absentSha)) + '\n'),
]);
const framesIn = scanZstdFrames(twoFrames);
const framesOut = repairSession(twoFrames);
const afterFrames = scanZstdFrames(framesOut.buffer);
if (afterFrames.length !== framesIn.length) throw new Error('帧数变了');
const firstBefore = twoFrames.subarray(framesIn[0].start, framesIn[0].end);
const firstAfter = framesOut.buffer.subarray(afterFrames[0].start, afterFrames[0].end);
if (firstBefore.equals(firstAfter) === false) throw new Error('没改的第一帧被重压了');
console.log('✅ 帧结构保持：只剩第二帧被重写，第一帧字节不变');

/* ── 6. keepMissing：只报告不动手 ── */

const quiet = repairSession(broken, { keepMissing: true });
if (quiet.report.changed !== false) throw new Error('keepMissing 下还是改了');
if (quiet.report.parts.missing !== 1) throw new Error('keepMissing 下没数到缺失');
if (decodeAll(quiet.buffer).includes('"type":"image"') === false) throw new Error('keepMissing 下图被删了');
console.log('✅ keepMissing=true 时只报告、不改字节');

/* ── 6b. 扁平形状（早期日志把 attachmentId 直接挂在 part 上）也要认 ── */

const flatBroken = build([
  header('session-flat-0006'),
  message({ type: 'image', attachmentId: `sha256:${absentSha}` }),
]);
const flatOut = repairSession(flatBroken);
if (flatOut.report.parts.missing !== 1) throw new Error('扁平形状的断链没被识别');
if (decodeAll(flatOut.buffer).includes('"type":"image"')) throw new Error('扁平断链的图还在');
const flatOk = build([
  header('session-flat-0007'),
  message({ type: 'image', attachmentId: `sha256:${goodSha}` }),
]);
const flatOkOut = repairSession(flatOk);
if (flatOkOut.report.changed !== false) throw new Error('健康的扁平引用被改动了');
console.log('✅ 扁平 attachmentId 与嵌套 attachment 两种形状都认：断链换占位、健康的不动');

/* ── 7. 修完的日志仍是一份能读的会话 ── */

const headerAfter = JSON.parse(decodeAll(brokenOut.buffer).split('\n')[0]);
if (headerAfter.type !== 'session' || headerAfter.id !== 'session-broken-0002') {
  throw new Error('修完之后 header 读不出来了');
}
const stat = fs.statSync(path.join(fx.home, 'attachments', 'v1', 'objects', goodSha.slice(0, 2), goodSha));
if (stat.size !== good.bytes) throw new Error('对象文件被体检动过');
console.log('✅ 修完仍是合法会话，且体检不碰对象库里的字节');

console.log('\n✅ repair 自检通过');
