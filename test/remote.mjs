/**
 * 远程访问回归：DSH 不是从回环地址打开的时候（内网 IP、域名、反代），
 * 插件必须还能用——保存改成浏览器下载、打开改成浏览器上传、自动保存不出现。
 *
 * 服务端判据是「同源」而不是「必须回环」：Host 不是 127.0.0.1 时，只要
 * Origin 与 Host 一致就放行，跨源照样 403。
 *
 * 全部在临时目录里跑（自己设 DSH_HOME），不碰真实的 ~/.dsh。
 * 运行：node test/remote.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { createHash, randomUUID } from 'node:crypto';
import { apply, zipRead, zipWrite } from '../index.js';

let failed = 0;
const ok = (label, detail) => console.log(`✅ ${label}${detail === undefined ? '' : ` · ${detail}`}`);
const bad = (label, detail) => {
  failed += 1;
  console.error(`✗ ${label}${detail === undefined ? '' : ` · ${detail}`}`);
};
const check = (condition, label, detail) => (condition ? ok(label, detail) : bad(label, detail));

/* ── 隔离的运行根 ── */
const BASE = fs.mkdtempSync(path.join(os.tmpdir(), 'dshss-remote-'));
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

/* ── 抓路由 ── */
const routes = new Map();
apply({
  connection: {
    fetch: {
      register: (spec) => {
        routes.set(spec.path, spec.fetch);
      },
    },
  },
});
const save = routes.get('/api/session.save');
const open = routes.get('/api/session.open');
check(save !== undefined && open !== undefined, '两条路由都已注册', `${routes.size} 条`);

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

/**
 * 以某个 Host / Origin 的身份调路由。remote 那几个用例就是靠它换视角：
 * 回环保持原判据，非回环要求同源。
 */
async function call(handler, route, query, options = {}) {
  const host = options.host ?? '127.0.0.1:3080';
  const url = new URL(`http://${host}${route}?${new URLSearchParams(query).toString()}`);
  const headers = new Headers();
  if (options.origin !== undefined) headers.set('origin', options.origin);
  if (options.site !== undefined) headers.set('sec-fetch-site', options.site);
  const init = { headers };
  if (options.body !== undefined) {
    init.method = 'POST';
    init.body = options.body;
    headers.set('content-type', 'application/octet-stream');
  }
  const response = await handler(new Request(url, init));
  const buffer = Buffer.from(await response.arrayBuffer());
  let body;
  try {
    body = JSON.parse(buffer.toString('utf8'));
  } catch {
    body = undefined;
  }
  return { status: response.status, body, buffer, headers: response.headers };
}

/* ── 先造一个真会话：本地身份打开一次自带包 ── */
const sessionId = `session-${randomUUID()}`;
const seed = path.join(OUT, 'seed.dsproj');
fs.writeFileSync(seed, buildPackage(sessionId, OUT));
const opened = await call(open, '/api/session.open', { path: seed, mode: 'auto', cwd: OUT });
check(opened.status === 200 && opened.body?.status === 'opened', '本地身份打开自带包', `HTTP ${opened.status}`);
check(opened.body?.sessionId === sessionId, '拿到的就是包里那条会话', opened.body?.sessionId);

/* ── 1. 非回环 + 同源：门必须放行 ── */
const remoteHost = '192.168.1.20:3080';
const remoteOrigin = `http://${remoteHost}`;
const allowed = await call(save, '/api/session.save', { sessionId, mode: 'auto', deliver: 'download' }, {
  host: remoteHost,
  origin: remoteOrigin,
  site: 'same-origin',
});
check(allowed.status === 200, '非回环地址的同源请求不再被 403', `HTTP ${allowed.status}`);
check(
  String(allowed.headers.get('content-type') ?? '').includes('application/zip'),
  '响应是 zip 附件',
  allowed.headers.get('content-type'),
);

/* ── 2. 下载分支不落盘：只打包交给浏览器 ── */
const listing = () => fs.readdirSync(OUT).filter((name) => name.endsWith('.dsproj')).sort();
const before = listing();
const delivered = await call(save, '/api/session.save', { sessionId, mode: 'auto', deliver: 'download' }, {
  host: remoteHost,
  origin: remoteOrigin,
});
const after = listing();
check(delivered.status === 200 && delivered.buffer.length > 0, '下载分支返回了包体', `${delivered.buffer.length} 字节`);
check(before.join('|') === after.join('|'), '下载分支没有往目录里写文件', `${after.length} 个 .dsproj`);

const deliveredZip = zipRead(delivered.buffer);
check(deliveredZip.has('manifest.json'), '拿到的确实是工程包（有 manifest.json）');
check(
  [...deliveredZip.keys()].some((name) => name.startsWith('session/')),
  '包里有会话条目',
  [...deliveredZip.keys()].filter((n) => n.startsWith('session/')).join(','),
);
const disposition = String(delivered.headers.get('content-disposition') ?? '');
check(disposition.includes('attachment;'), '带 attachment 让浏览器存成文件', disposition.slice(0, 40));
check(
  disposition.includes("filename*=UTF-8''"),
  '文件名按 RFC 5987 编码（中文标题不会乱码）',
  disposition.includes("filename*=UTF-8''"),
);

/* ── 3. 非回环 + 跨源：照样拒绝 ── */
const cross = await call(save, '/api/session.save', { sessionId, mode: 'auto' }, {
  host: remoteHost,
  origin: 'http://evil.example',
});
check(cross.status === 403, '别的站点发来的请求仍然 403', `HTTP ${cross.status} ${cross.body?.message ?? ''}`);

/* ── 4. 非回环 + 没有 Origin 且是跨站：拒绝 ── */
const noOrigin = await call(save, '/api/session.save', { sessionId, mode: 'auto' }, {
  host: remoteHost,
  site: 'cross-site',
});
check(noOrigin.status === 403, '远程访问缺 Origin 的跨站请求被拒', `HTTP ${noOrigin.status} ${noOrigin.body?.message ?? ''}`);

/* ── 5. 非回环 + 没有 Origin 但是同源导航（下载）── 放行 ── */
const nav = await call(save, '/api/session.save', { sessionId, mode: 'auto', deliver: 'download' }, {
  host: remoteHost,
  site: 'same-origin',
});
check(nav.status === 200, '浏览器自己发起的同源下载放行', `HTTP ${nav.status}`);

/* ── 5b. 非回环 + Origin 与 Sec-Fetch-Site 都缺：按导航放行 ──
   旧浏览器不发 Sec-Fetch-Site，反向代理也可能剥掉；要求必须有这个头会把
   合法下载挡成「远程访问缺少 Origin」。这条以前就这么误伤过。 */
const bare = await call(save, '/api/session.save', { sessionId, mode: 'auto', deliver: 'download' }, {
  host: remoteHost,
});
check(
  bare.status === 200 && bare.buffer.length > 0,
  '两个头都缺的下载请求不被当成跨站',
  `HTTP ${bare.status} ${bare.body?.message ?? ''}`,
);

/* ── 6. 回环仍按老判据：跨源 Origin 一样拒 ── */
const loopCross = await call(save, '/api/session.save', { sessionId, mode: 'auto' }, {
  host: '127.0.0.1:3080',
  origin: 'http://evil.example',
});
check(loopCross.status === 403, '回环上跨源 Origin 仍然 403', `HTTP ${loopCross.status}`);

/* ── 7. 上传：字节进来，落成临时包再走同一套导入 ── */
const uploadSession = `session-${randomUUID()}`;
const uploadBytes = buildPackage(uploadSession, OUT);
const leftovers = () =>
  fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith('dsh-session-save-open-'));
const junkBefore = leftovers().length;
const uploaded = await call(
  open,
  '/api/session.open',
  { upload: '1', mode: 'auto', cwd: OUT },
  { host: remoteHost, origin: remoteOrigin, body: uploadBytes },
);
check(uploaded.status === 200 && uploaded.body?.status === 'opened', '上传的包能打开', `HTTP ${uploaded.status} ${uploaded.body?.status ?? ''}`);
check(uploaded.body?.sessionId === uploadSession, '打开的就是上传的那条会话', uploaded.body?.sessionId);
check(leftovers().length === junkBefore, '临时目录用完就删了', `${junkBefore} -> ${leftovers().length}`);

/* ── 8. 上传空内容：明确报错，不是 500 ── */
const empty = await call(
  open,
  '/api/session.open',
  { upload: '1', mode: 'auto' },
  { host: remoteHost, origin: remoteOrigin, body: Buffer.alloc(0) },
);
check(empty.status === 400 && empty.body?.status === 'error', '空上传回 400 而不是崩', `HTTP ${empty.status} ${empty.body?.message ?? ''}`);

/* ── 9. 客户端：远程模式必须换掉那三处行为 ── */
const client = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8');
check(client.includes('function isRemoteHost()'), '客户端有远程判据');
check(client.includes("deliver: 'download'"), '保存走下载分支');
check(client.includes("upload: '1'"), '打开走上传分支');
check(client.includes("type: 'file'") && client.includes('accept: \'.dsproj'), '选文件用 React 渲染的 input（不碰 document）');
check(
  client.includes('if (isRemoteHost() === false) {') &&
    client.includes("id: 'session-autosave'") &&
    client.includes("id: 'session-save-as'"),
  '远程不注册自动保存槽位',
);
// 后续步骤（选落点 / 选冲突策略 / 修包）不能再去点文件框：服务端的临时包在上传
// 结束时就删了，第二次拿到的是不存在的路径；用户也会被连续两个文件框搞懵。
check(
  client.includes('const remoteFile = useRef(null)'),
  '远程模式把选中的 File 留在内存里',
);
check(
  client.includes('const followUp = typeof extra.path === \'string\' && remoteFile.current !== null'),
  '后续步骤认得出「这是同一个包的下一步」',
);
check(
  client.includes('const { path: _discarded, ...rest } = extra') &&
    client.includes('await uploadAndOpen(remoteFile.current, rest)'),
  '后续步骤重发字节、丢掉已失效的服务端路径',
);
check(
  /if \(followUp === false\) \{[\s\S]{0,600}?input\.click\(\)/.test(client),
  '只有首次点「打开」才弹文件框',
);
check(!/\bdocument\./.test(client), '没有引入 document（红线 5）');

/* ── 收拾 ── */
fs.rmSync(BASE, { recursive: true, force: true });
console.log(failed === 0 ? '✅ remote 自检通过' : `✗ remote 有 ${failed} 条失败`);
process.exit(failed === 0 ? 0 : 1);
