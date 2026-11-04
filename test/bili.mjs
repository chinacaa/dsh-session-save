/**
 * billion-context 压缩块随包走、导入时回填（F60）。
 *
 * 为什么需要这一套：bili 在 wire 层按会话 id 记住「哪些消息已经折叠过」，
 * 状态存在自己的 XDG 目录里。换台机器打开 .dsproj 时，bili 手里没有这个
 * 会话的任何历史，第一次请求只能把整段历史重新发一遍 —— 大会话直接把
 * 上下文塞爆，而 bili 自己关掉了 DSH 的原生压缩，没有兜底。
 *
 * 这里验的是「带走 + 按同一算法放回去」，以及三条不许动的边界：
 *   · schema 不是 3 的块不认（bili 换格式时宁可不恢复）
 *   · 本机那份比包里新就不覆盖（那是包导出之后的对话）
 *   · bili 没装就当没这回事，不报错
 *
 *   node plugins/dsh-session-save/test/bili.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

import { autoCleanup, loadRoutes, makeFixture } from './fixture.mjs';

const fx = makeFixture();
autoCleanup(fx);

const { mod, routes } = await loadRoutes('../index.js');
const { ROUTE, OPEN_ROUTE, zipRead } = mod;
const saveRoute = routes.get(ROUTE);
const openRoute = routes.get(OPEN_ROUTE);
if (saveRoute === undefined) throw new Error(`route was not registered: ${ROUTE}`);
if (openRoute === undefined) throw new Error(`route was not registered: ${OPEN_ROUTE}`);

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
// bili 的文件名规则：<上游 host>_<sha256(sessionId) 前 24 位>.json
const biliHash = (sessionId) => sha256(Buffer.from(String(sessionId), 'utf8')).slice(0, 24);

/* ── 1. 造一个假的 bili 会话目录 ── */

const biliRoot = path.join(fx.base, 'bili-sessions');
const biliDir = path.join(biliRoot, 'anthropic');
const biliFile = path.join(biliDir, `api.deepseek.com_${biliHash(fx.session.id)}.json`);
fs.mkdirSync(biliDir, { recursive: true });
process.env.BILI_SESSIONS_DIR = biliRoot;

const biliState = {
  version: 3,
  savedAt: 1793460457156,
  id: fx.session.id,
  payload: {
    version: 3,
    savedAt: 1793460457156,
    id: fx.session.id,
    meta: { protocol: 'anthropic', upstreamOrigin: 'https://api.deepseek.com', label: fx.session.id },
    stats: { folded: 12, total: 40 },
    messages: { folded: [{ ref: 1 }, { ref: 2 }], active: [] },
  },
};
const writeBiliState = (state, file = biliFile) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(state));
};
writeBiliState(biliState);
console.log('✅ 夹具里准备好一份 bili 状态（文件名 = host + sha256(sessionId) 前 24 位）');

/* ── 2. 保存：压缩块要进包 ── */

const tmp = fs.mkdtempSync(path.join(fx.base, 'bili-'));
const target = path.join(tmp, 'bili.dsproj');
const stateFile = path.join(fx.home, 'storages', 'session-save.json');
const stateBackup = fs.existsSync(stateFile) ? fs.readFileSync(stateFile, 'utf8') : undefined;
{
  const state = stateBackup === undefined ? {} : JSON.parse(stateBackup);
  state.lastDir = tmp;
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
}

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
if (!entries.has('bili/session.json')) throw new Error('包里没有 bili/session.json');
console.log('✅ 压缩块进包了 · bili/session.json');

const packed = JSON.parse(entries.get('bili/session.json').toString('utf8'));
if (packed.plugin !== 'billion-context') throw new Error(`plugin 字段不对: ${packed.plugin}`);
if (packed.schema !== 3) throw new Error(`schema 应为 3，实际 ${packed.schema}`);
if (packed.sessionId !== fx.session.id) throw new Error(`sessionId 不对: ${packed.sessionId}`);
if (packed.state?.payload?.meta?.protocol !== 'anthropic') throw new Error('protocol 没带出来');
console.log('✅ 块里带上了 plugin / schema / sessionId / protocol / host');

const manifest = JSON.parse(entries.get('manifest.json').toString('utf8'));
if (manifest.bili?.present !== true) throw new Error(`manifest.bili.present 应为 true: ${JSON.stringify(manifest.bili)}`);
if (manifest.bili?.savedAt !== 1793460457156) throw new Error(`manifest.bili.savedAt 不对: ${manifest.bili?.savedAt}`);
console.log('✅ manifest 记下 bili.present 与 savedAt');

/* ── 3. 导入：本机没有就重建，路径要一模一样 ── */

fs.rmSync(biliFile);
if (fs.existsSync(biliFile)) throw new Error('夹具清理失败');
{
  const opened = await openRoute(
    new Request(`http://127.0.0.1:3080${OPEN_ROUTE}?path=${encodeURIComponent(target)}&cwd=${encodeURIComponent(fx.cwd)}`),
  );
  const body = await opened.json();
  if (opened.status !== 200) throw new Error(`打开失败: ${opened.status} ${JSON.stringify(body).slice(0, 200)}`);
  if (body.bili?.written !== 1) throw new Error(`bili.written 应为 1: ${JSON.stringify(body.bili)}`);
  if (!fs.existsSync(biliFile)) throw new Error('bili 状态文件没有被重建');
  const restored = JSON.parse(fs.readFileSync(biliFile, 'utf8'));
  if (restored.id !== fx.session.id) throw new Error('重建的文件里 id 不对');
  if (restored.savedAt !== biliState.savedAt) throw new Error('重建的文件里 savedAt 不对');
  console.log('✅ 导入把压缩块放回了原路径 · bili.written = 1');
}

/* ── 4. 本机那份更新：不许覆盖 ── */

{
  const newer = { ...biliState, savedAt: biliState.savedAt + 5000, payload: { ...biliState.payload, marker: 'local-newer' } };
  writeBiliState(newer);
  const opened = await openRoute(
    new Request(`http://127.0.0.1:3080${OPEN_ROUTE}?path=${encodeURIComponent(target)}&cwd=${encodeURIComponent(fx.cwd)}`),
  );
  const body = await opened.json();
  if (body.bili?.reason !== 'newer-local') throw new Error(`应报 newer-local，实际 ${JSON.stringify(body.bili)}`);
  const kept = JSON.parse(fs.readFileSync(biliFile, 'utf8'));
  if (kept.payload?.marker !== 'local-newer') throw new Error('本机那份被覆盖了');
  if (kept.savedAt !== newer.savedAt) throw new Error('本机 savedAt 被改动了');
  console.log('✅ 本机那份更新时不覆盖 · reason = newer-local');
}

/* ── 5、7. 改包要连 manifest.parts 一起改，否则先撞完整性校验 ── */

const { zipWrite } = mod;
let repackSeq = 0;
const repack = (source, { dropBili = false, schema, sessionId, protocol, host } = {}) => {
  const en = zipRead(fs.readFileSync(source));
  if (dropBili === true) {
    en.delete('bili/session.json');
  } else {
    const wrapper = JSON.parse(en.get('bili/session.json').toString('utf8'));
    if (schema !== undefined) wrapper.schema = schema;
    if (sessionId !== undefined) {
      wrapper.sessionId = sessionId;
      if (wrapper.state !== undefined) wrapper.state.id = sessionId;
    }
    if (protocol !== undefined || host !== undefined) {
      wrapper.state.meta = wrapper.state.meta ?? {};
      if (protocol !== undefined) wrapper.state.meta.protocol = protocol;
      if (host !== undefined) wrapper.state.meta.upstreamOrigin = `https://${host}`;
    }
    en.set('bili/session.json', Buffer.from(JSON.stringify(wrapper), 'utf8'));
  }
  const manifest = JSON.parse(en.get('manifest.json').toString('utf8'));
  if (dropBili === true) {
    delete manifest.parts['bili/session.json'];
    manifest.bili = { present: false };
  } else {
    const buf = en.get('bili/session.json');
    manifest.parts['bili/session.json'] = { sha256: sha256(buf), bytes: buf.length };
  }
  en.set('manifest.json', Buffer.from(JSON.stringify(manifest, null, 2), 'utf8'));
  repackSeq += 1;
  const out = path.join(tmp, `repack-${repackSeq}.dsproj`);
  fs.writeFileSync(out, zipWrite([...en].map(([name, data]) => ({ name, data }))));
  return out;
};

{
  // 上一步留下的本机状态先清掉，否则「没写盘」这条会被旧文件干扰
  fs.rmSync(biliFile, { force: true });
  const badTarget = repack(target, { schema: 99 });
  const opened = await openRoute(
    new Request(`http://127.0.0.1:3080${OPEN_ROUTE}?path=${encodeURIComponent(badTarget)}&cwd=${encodeURIComponent(fx.cwd)}`),
  );
  const body = await opened.json();
  if (body.bili?.reason !== 'schema-mismatch') throw new Error(`应报 schema-mismatch，实际 ${JSON.stringify(body.bili)}`);
  if (fs.existsSync(biliFile)) throw new Error('schema 不认识却写了盘');
  console.log('✅ schema 不是 3 时不写盘 · reason = schema-mismatch');
}

/* ── 6. bili 没装：跳过，不报错 ── */

{
  process.env.BILI_SESSIONS_DIR = path.join(fx.base, 'no-bili-here');
  const opened = await openRoute(
    new Request(`http://127.0.0.1:3080${OPEN_ROUTE}?path=${encodeURIComponent(target)}&cwd=${encodeURIComponent(fx.cwd)}`),
  );
  const body = await opened.json();
  if (opened.status !== 200) throw new Error('bili 没装不该让打开失败');
  if (body.bili?.reason !== 'not-installed') throw new Error(`应报 not-installed，实际 ${JSON.stringify(body.bili)}`);
  console.log('✅ bili 没装时整个打开照常 200 · reason = not-installed');
}

/* ── 7. 老包（没有这一条）：不算错 ── */

{
  process.env.BILI_SESSIONS_DIR = biliRoot;
  const plainTarget = repack(target, { dropBili: true });
  const opened = await openRoute(
    new Request(`http://127.0.0.1:3080${OPEN_ROUTE}?path=${encodeURIComponent(plainTarget)}&cwd=${encodeURIComponent(fx.cwd)}`),
  );
  const body = await opened.json();
  if (opened.status !== 200) throw new Error(`没有 bili 条目的包应当照常打开，实际 ${opened.status}`);
  if (body.bili?.reason !== 'absent') throw new Error(`老包应报 absent，实际 ${JSON.stringify(body.bili)}`);
  console.log('✅ 老包（没有压缩块）照常打开 · reason = absent');
}

if (stateBackup === undefined) fs.rmSync(stateFile, { force: true });
else fs.writeFileSync(stateFile, stateBackup);

/* ── 8. 只认本会话：块里写别人的 id 必须拒绝 ── */

{
  fs.rmSync(biliFile, { force: true });
  const other = repack(target, { sessionId: 'session-00000000-0000-4000-8000-000000000000' });
  const opened = await openRoute(
    new Request(`http://127.0.0.1:3080${OPEN_ROUTE}?path=${encodeURIComponent(other)}&cwd=${encodeURIComponent(fx.cwd)}`),
  );
  const body = await opened.json();
  if (body.bili?.reason !== 'session-mismatch') {
    throw new Error(`别的会话的块应报 session-mismatch，实际 ${JSON.stringify(body.bili)}`);
  }
  if (fs.existsSync(biliFile)) throw new Error('别的会话的块把内容写进了本会话槽位');
  const stray = path.join(biliDir, `api.deepseek.com_${biliHash('session-00000000-0000-4000-8000-000000000000')}.json`);
  if (fs.existsSync(stray)) throw new Error('给别的会话建了状态文件');
  console.log('✅ 块里是别的 sessionId 时拒绝写入 · reason = session-mismatch');
}

/* ── 9. protocol / host 里塞路径分隔符也逃不出会话目录 ── */

{
  fs.rmSync(biliFile, { force: true });
  const evil = repack(target, { protocol: '../../evil', host: '..\\..\\evil' });
  const opened = await openRoute(
    new Request(`http://127.0.0.1:3080${OPEN_ROUTE}?path=${encodeURIComponent(evil)}&cwd=${encodeURIComponent(fx.cwd)}`),
  );
  const body = await opened.json();
  if (opened.status !== 200) throw new Error(`构造包不该让打开失败，实际 ${opened.status}`);
  // R2-4 起：非法 host 不再默默落回默认槽位（那会把状态写错位置还报 ok），改为 rejected/bad-host。
  if (body.bili?.rejected !== 1 || body.bili?.reason !== 'bad-host') {
    throw new Error(`非法 host 应报 bad-host，实际 ${JSON.stringify(body.bili)}`);
  }
  if (fs.existsSync(path.join(biliRoot, 'evil')) || fs.existsSync(path.join(biliRoot, '..', 'evil'))) {
    throw new Error('路径逃出了会话目录');
  }
  if (fs.existsSync(biliFile)) throw new Error('非法 host 不该写进任何槽位');
  console.log('✅ host 带分隔符时 refuse 而不是落回默认 · reason = bad-host');
}

console.log('✅ bili / 压缩块随包往返自检通过');
