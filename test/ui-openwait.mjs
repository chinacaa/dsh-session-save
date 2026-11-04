// 打开后跳转的等待逻辑：refresh() 只是发起一次 session.list，索引落到
// sessions/summaries 上要晚一拍；不等就 openSession，会撞 DSH 的
// `sessions.retain: unknown session`，文件明明已经导好了却显示「打开失败」。
// 这套用例只做静态断言，因为它守的是「客户端别在索引没跟上时喊失败」这条约定。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const source = fs.readFileSync(path.join(root, 'client.js'), 'utf8');
const zh = JSON.parse(fs.readFileSync(path.join(root, 'locales/zh-CN.json'), 'utf8'));
const en = JSON.parse(fs.readFileSync(path.join(root, 'locales/en-US.json'), 'utf8'));

// ① 跳转前必须查 sessions.get，而不是 refresh 完就开
assert.ok(
  source.includes('host?.sessions?.get?.(payload.sessionId) !== undefined'),
  '跳转前要先确认索引认识这个会话',
);
console.log('✅ 跳转前查 sessions.get');

// ② 要么等，要么明确放弃：必须出现等待分支
assert.ok(source.includes('recognized === false && attempt < 15'), '索引没跟上要等，不能立刻跳');
assert.ok(source.includes('setTimeout(resolve, 100)'), '等待要用短间隔轮询');
console.log('✅ 索引没跟上会等，最多 15 次 × 100ms');

// ③ 等不到时不能报「打开失败」——包已经落盘了
assert.ok(source.includes("setToast({ tone: 'info', text: `${L.opened} · ${label}${L.listRefreshHint}` })"), '等不到要报「已导入」而不是「打开失败」');
assert.ok(!/recognized === false[\s\S]{0,200}L\.openFailed/.test(source), '等不到时不许复用 openFailed');
console.log('✅ 等不到只提示列表没刷新，不喊打开失败');

// ④ 文案中英各一份，且两边都有
assert.equal(typeof zh.listRefreshHint, 'string');
assert.equal(typeof en.listRefreshHint, 'string');
assert.notEqual(zh.listRefreshHint, en.listRefreshHint);
console.log('✅ 提示文案中英各一份');

// ⑤ 兜底表也要有，否则语言包到达前中文首屏会说 undefined
assert.ok(source.includes('listRefreshHint:'), 'client.js 的中文兜底表要有这一条');
console.log('✅ client.js 中文兜底表同步');

console.log('ui-openwait 自检通过');
