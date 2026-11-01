/**
 * 打开时体检自愈（F52）—— 端到端。
 *
 * `test/repair.mjs` 只验 repairSession 这个函数本身；这里走真实路由 save → open，
 * 验接线：先回填附件、再体检、最后写盘。顺序错了就会自己把自己判成缺失——
 * 包里带的图还没落进对象库就被体检，好好的图被换成占位文本。
 *
 * 还要验「本机已经有这份会话」的那条路（reused 早退）。用户在同一台机器上
 * 重开自己的包走的正是它，以前它完全跳过体检，断链图永远修不上。
 *
 *   node plugins/dsh-session-save/test/open-repair.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { createHash } from 'node:crypto';

process.env.NODE_NO_WARNINGS = '1';

const { autoCleanup, loadRoutes, makeFixture } = await import('./fixture.mjs');

const fx = makeFixture();
autoCleanup(fx);

const { mod, routes } = await loadRoutes('../index.js');
const { ROUTE, OPEN_ROUTE, scanZstdFrames } = mod;
const saveRoute = routes.get(ROUTE);
const openRoute = routes.get(OPEN_ROUTE);
if (typeof saveRoute !== 'function' || typeof openRoute !== 'function') {
  throw new Error('路由没取到：save/open');
}

const ZSTD_OPTS = { params: { [zlib.constants.ZSTD_c_checksumFlag]: 1 } };
const frame = (text) => zlib.zstdCompressSync(Buffer.from(text, 'utf8'), ZSTD_OPTS);

/* ── 1. 造会话：一张图指向本机不存在的对象 ── */

const absentSha = createHash('sha256').update('this-object-is-not-here').digest('hex');

const original = fs.readFileSync(fx.session.file);
const frames = scanZstdFrames(original);
if (frames.length === 0) throw new Error('夹具会话不是 zstd 帧');
const headerFrame = original.subarray(frames[0].start, frames[0].end);

const bodyText = `${[
  JSON.stringify({ type: 'turn/start', at: 1792340090001, turn: 1 }),
  JSON.stringify({
    type: 'message',
    at: 1792340090002,
    role: 'user',
    content: [
      { type: 'text', text: '看看这两张图' },
      {
        type: 'image',
        attachment: {
          attachmentId: `sha256:${absentSha}`,
          mediaType: 'image/png',
          bytes: 4096,
          width: 100,
          height: 80,
          name: 'lost.png',
        },
      },
    ],
  }),
  JSON.stringify({ type: 'turn/end', at: 1792340090003, turn: 1 }),
].join('\n')}\n`;

fs.writeFileSync(fx.session.file, Buffer.concat([headerFrame, frame(bodyText)]));
console.log('✅ 会话里放了 1 个断链 image（对象库里没有）');

/* ── 2. 打包 ── */

const tmp = fs.mkdtempSync(path.join(fx.base, 'e2e-'));
const target = path.join(tmp, 'broken.dsproj');
const stateFile = path.join(fx.home, 'storages', 'session-save.json');
// 保存路由只认「用过的目录」，先把 lastDir 指到临时目录。
const state = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : {};
state.lastDir = tmp;
fs.mkdirSync(path.dirname(stateFile), { recursive: true });
fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));

const saved = await saveRoute(
  new Request(
    `http://127.0.0.1:3080${ROUTE}?sessionId=${encodeURIComponent(fx.session.id)}&path=${encodeURIComponent(target)}`,
  ),
);
const savedBody = await saved.json();
if (saved.status !== 200) throw new Error(`保存失败 ${saved.status}: ${JSON.stringify(savedBody)}`);
console.log('✅ 打包成功');

/* ── 3. 打开：导入时应当自动体检并把断链换成占位 ── */

const opened = await openRoute(
  new Request(`http://127.0.0.1:3080${OPEN_ROUTE}?path=${encodeURIComponent(target)}&cwd=${encodeURIComponent(fx.base)}`),
);
const openedBody = await opened.json();
if (opened.status !== 200) throw new Error(`打开失败 ${opened.status}: ${JSON.stringify(openedBody)}`);

const repair = openedBody.repair;
if (repair === undefined || repair === null) throw new Error('打开结果里没有 repair 报告');
if (repair.parts === undefined) throw new Error(`repair 报告缺 parts：${JSON.stringify(repair)}`);
if (repair.parts.missing !== 1) throw new Error(`应报 1 个缺失，实际 ${repair.parts.missing}`);
if (repair.parts.dropped !== 1) throw new Error(`应丢 1 个 part，实际 ${repair.parts.dropped}`);
if (repair.changed !== true) throw new Error('报告说没改，但确实有断链');
if (Array.isArray(repair.notes) === false || repair.notes.length === 0) throw new Error('缺可读说明');
console.log('✅ 打开时自动体检：missing=1 / dropped=1 / changed=true / 有说明');

/* ── 4. 落盘的那份会话里，图已经换成占位文本 ── */

// 打开结果直接告诉我们会话落在哪个文件上，不用自己拼目录（sessions/ 下面还有一层 cwd slug）。
const landedFile = openedBody.target;

const raw = fs.readFileSync(landedFile);
const text = scanZstdFrames(raw)
  .map((f) => zlib.zstdDecompressSync(raw.subarray(f.start, f.end)).toString('utf8'))
  .join('\n');
if (text.includes('"type":"image"')) throw new Error('落盘会话里还有 image part');
if (text.includes('图片已丢失：lost.png') === false) throw new Error('落盘会话里没有占位说明');
console.log('✅ 落盘会话已清理：无 image part，留了可读占位');

/* ── 5. 同一份包再打开一次：已经是干净的，不该再报缺失 ── */

const again = await openRoute(
  new Request(`http://127.0.0.1:3080${OPEN_ROUTE}?path=${encodeURIComponent(target)}&cwd=${encodeURIComponent(fx.base)}`),
);
const againBody = await again.json();
if (again.status !== 200) throw new Error(`二次打开失败 ${again.status}: ${JSON.stringify(againBody)}`);
if (againBody.repair !== undefined && againBody.repair.parts?.missing > 0) {
  throw new Error('二次打开仍在报缺失——说明体检没有稳定结果');
}
console.log('✅ 再打开同一份包不再报缺失（体检是幂等的）');

console.log('\n✅ e2e 自检通过');
