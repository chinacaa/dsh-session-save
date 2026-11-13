// 打开后跳转：DSH 的 sessions 服务只有 refresh() / retain()，没有 get(id) 这类查询方法。
// 上一版拿 sessions.get(id) 轮询，方法不存在 → 永远判「索引没跟上」→ 一次也不跳，
// 用户看到的就是「还是打不开」。这套用例把这个真接口契约用假 host 跑一遍。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const source = fs.readFileSync(path.join(root, 'client.js'), 'utf8');
const zh = JSON.parse(fs.readFileSync(path.join(root, 'locales/zh-CN.json'), 'utf8'));
const en = JSON.parse(fs.readFileSync(path.join(root, 'locales/en-US.json'), 'utf8'));

/* ── 1. 静态：不许再依赖不存在的 sessions.get ── */
assert.ok(
  !/sessions\?\.get\?\./.test(source) && !/sessions\.get\(/.test(source),
  'sessions 服务没有 get(id)，不能拿它当「索引跟上没」的判据',
);
assert.ok(source.includes('async function jumpWhenReady('), '跳转要收成一个可测函数');
assert.ok(source.includes("'uiWorkspace.openSession \u4e0d\u53ef\u7528'"), 'uiWorkspace 缺失要有明确错误');
console.log('\u2705 \u4e0d\u518d\u4f9d\u8d56\u4e0d\u5b58\u5728\u7684 sessions.get');

/* ── 2. 静态：重试契约（刷新 + 只对 unknown session 重试）── */
assert.ok(source.includes('/unknown session/i.test(text)'), '只对「索引不认识」重试，其它错直接报');
assert.ok(source.includes('host?.sessions?.refresh?.()'), '重试前要刷新索引');
assert.ok(source.includes('Number.isFinite(options.attempts) ? options.attempts : 12'), '重试次数要有上限');
console.log('\u2705 \u53ea\u5bf9 unknown session \u91cd\u8bd5\uff0c\u91cd\u8bd5\u524d\u5237\u65b0\u4e14\u6709\u4e0a\u9650');

/* ── 3. 动态：把 jumpWhenReady 抽出来跑真实契约 ── */
function extractFunction(text, name) {
  const start = text.indexOf(`async function ${name}(`);
  assert.notEqual(start, -1, `找不到 ${name}`);
  // 先跳过参数表（默认值里会有 {}），再从函数体开始数花括号。
  let i = start;
  let paren = 0;
  for (; i < text.length; i += 1) {
    if (text[i] === '(') paren += 1;
    else if (text[i] === ')') {
      paren -= 1;
      if (paren === 0) { i += 1; break; }
    }
  }
  while (i < text.length && text[i] !== '{') i += 1;
  let depth = 0;
  for (; i < text.length; i += 1) {
    if (text[i] === '{') depth += 1;
    else if (text[i] === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  throw new Error(`${name} 花括号不配对`);
}

const body = extractFunction(source, 'jumpWhenReady');
const factory = new Function(`${body}\nreturn jumpWhenReady;`);
const jumpWhenReady = factory();
const noWait = () => Promise.resolve();

// 3a 索引晚一拍：第一次抛 unknown session，refresh() 之后它才认识
{
  let known = false;
  let refreshed = 0;
  let opened = null;
  const host = {
    sessions: { refresh: () => { refreshed += 1; known = true; } },
    uiWorkspace: {
      openSession: (id) => {
        if (known === false) throw new Error(`sessions.retain: unknown session ${id}`);
        opened = id;
      },
    },
  };
  const outcome = await jumpWhenReady(host, 'session-x', { attempts: 12, wait: noWait });
  assert.equal(outcome.jumped, true, '刷新后应当跳过去');
  assert.equal(opened, 'session-x');
  assert.ok(refreshed >= 1, '跳之前必须刷新过索引');
}
console.log('\u2705 \u7d22\u5f15\u665a\u4e00\u62cd\uff1a\u5237\u65b0\u4e00\u6b21\u5c31\u771f\u7684\u8df3\u8fc7\u53bb\u4e86');

// 3b 一直不认识：不能用无穷循环，也不能抛
{
  let refreshed = 0;
  const host = {
    sessions: { refresh: () => { refreshed += 1; } },
    uiWorkspace: { openSession: () => { throw new Error('sessions.retain: unknown session session-y'); } },
  };
  const outcome = await jumpWhenReady(host, 'session-y', { attempts: 3, wait: noWait });
  assert.equal(outcome.jumped, false);
  assert.ok(outcome.unknown !== undefined, '要带出 lastUnknown 供上层决定文案');
  assert.equal(outcome.error, undefined, '这不是真错误，不能走 openFailed');
  assert.equal(refreshed, 3, '每次重试前都刷新一次');
}
console.log('\u2705 \u4e00\u76f4\u4e0d\u8ba4\u8bc6\uff1a\u6709\u9650\u91cd\u8bd5\uff0c\u4e0d\u65e0\u7a77\u5faa\u73af\u4e5f\u4e0d\u5f53\u771f\u9519\u8bef');

// 3c 别的错误：不重试、原样交回
{
  let refreshed = 0;
  let calls = 0;
  const host = {
    sessions: { refresh: () => { refreshed += 1; } },
    uiWorkspace: { openSession: () => { calls += 1; throw new Error('boom'); } },
  };
  const outcome = await jumpWhenReady(host, 'session-z', { attempts: 5, wait: noWait });
  assert.equal(outcome.jumped, false);
  assert.equal(outcome.error.message, 'boom');
  assert.equal(calls, 1, '真错误只试一次');
  assert.equal(refreshed, 0, '真错误不刷新');
}
console.log('\u2705 \u771f\u9519\u8bef\u53ea\u8bd5\u4e00\u6b21\uff0c\u4e0d\u628a\u5b83\u6de1\u5316\u6210\u300c\u7d22\u5f15\u6ca1\u8ddf\u4e0a\u300d');

// 3d 没有 uiWorkspace：直接报，不能假成功
{
  const outcome = await jumpWhenReady({ sessions: {} }, 'session-w', { attempts: 2, wait: noWait });
  assert.equal(outcome.jumped, false);
  assert.ok(outcome.error !== undefined);
}
console.log('\u2705 \u7f3a\u5c11 uiWorkspace \u65f6\u4e0d\u4f2a\u9020\u6210\u529f');

/* ── 4. 用户在界面上看到的说法 ── */
assert.ok(source.includes('const outcome = await jumpWhenReady(host, payload.sessionId);'), '调用点要接上');
assert.ok(
  source.includes("setToast({ tone: 'info', text: `${L.opened} \u00b7 ${label}${L.listRefreshHint}"),
  '只卡在索引时要说「已导入」',
);
assert.equal(typeof zh.listRefreshHint, 'string');
assert.equal(typeof en.listRefreshHint, 'string');
assert.notEqual(zh.listRefreshHint, en.listRefreshHint);
assert.ok(source.includes('listRefreshHint:'), 'client.js 的中文兜底表要有这一条');
console.log('\u2705 \u754c\u9762\u6587\u6848\u4e2d\u82f1\u5404\u4e00\u4efd\uff0c\u4e14\u53ea\u5728\u771f\u5361\u4f4f\u65f6\u624d\u8bf4');

console.log('ui-openwait 自检通过');
