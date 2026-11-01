#!/usr/bin/env node
/**
 * 多语言本地化自检：语言包形状、回落规则、路由下发。
 *
 * 这一套管三件事：
 *   1. `locales/*.json` 的形状对——键都在 zh-CN 里、占位符一致、值都是字符串；
 *   2. `client.js` 里没有第二份硬编码的整表（真源只有 locales/ 与中文兜底）；
 *   3. `/api/session.locales` 真的能把语言包发下去，且只从目录清单里挑文件。
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { autoCleanup, loadRoutes, makeFixture } from './fixture.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.dirname(here);
const localeDir = path.join(repo, 'locales');
const readText = (file) => fs.readFileSync(file, 'utf8');
const readPack = (tag) => JSON.parse(readText(path.join(localeDir, `${tag}.json`)));

const fx = makeFixture('dshss-loc');
autoCleanup(fx);

const tags = fs
  .readdirSync(localeDir)
  .filter((name) => name.endsWith('.json'))
  .map((name) => name.slice(0, -5))
  .sort();

assert.ok(tags.includes('zh-CN'), '必须有源语言 zh-CN');
assert.ok(tags.length >= 2, `至少要有两份语言包，实际 ${tags.length}`);

const source = readPack('zh-CN');
const sourceKeys = Object.keys(source);
assert.ok(sourceKeys.length >= 100, `源语言键数偏少：${sourceKeys.length}`);

/* ── 1. 每份语言包都是源语言的子集，占位符一致 ── */

const slots = (text) => [...String(text).matchAll(/\{([A-Za-z][A-Za-z0-9]*)\}/g)].map((m) => m[1]).sort();

for (const tag of tags) {
  const pack = readPack(tag);
  assert.ok(pack !== null && typeof pack === 'object' && Array.isArray(pack) === false, `${tag} 顶层必须是对象`);
  for (const [key, value] of Object.entries(pack)) {
    assert.equal(typeof value, 'string', `${tag}:${key} 的值必须是字符串`);
    assert.ok(sourceKeys.includes(key), `${tag} 多出一个源语言没有的键：${key}`);
  }
  if (tag === 'zh-CN') continue;
  const missing = sourceKeys.filter((key) => !(key in pack));
  assert.equal(missing.length, 0, `${tag} 缺 ${missing.length} 个键：${missing.slice(0, 5).join('、')}`);
  for (const key of sourceKeys) {
    assert.deepEqual(
      slots(pack[key]),
      slots(source[key]),
      `${tag}:${key} 的占位符与源语言不一致`,
    );
  }
}
console.log(`✅ ${tags.length} 份语言包齐全（${tags.join(' / ')}），键集合与占位符都对得上源语言 ${sourceKeys.length} 个键`);

/* ── 2. client.js 不再自带整份英文表，且真的去拉语言包 ── */

const clientSource = readText(path.join(repo, 'client.js'));
assert.ok(clientSource.includes('const ZH = {'), 'client.js 要保留中文兜底表');
assert.equal(clientSource.includes('const EN = {'), false, '英文表不该再硬编码在 client.js 里——真源是 locales/en-US.json');
assert.ok(clientSource.includes('api/session.locales'), '客户端要去拉 /api/session.locales');
assert.ok(
  /Object\.assign\(L, /.test(clientSource),
  '拿到语言包必须就地合并进 L：L.xxx 在几百处被直接读，换引用等于整体重写',
);
assert.ok(
  /async function loadLocale\(\)[\s\S]{0,600}navigator\.language/.test(clientSource),
  '语言要从 navigator.language 取，别写死',
);
assert.ok(/void loadLocale\(\)/.test(clientSource), 'apply 里要真的触发一次加载');
console.log('✅ client.js 只留中文兜底，启动时按浏览器语言去拉语言包并就地合并');

/* ── 3. 检查脚本本身能用 ── */

const check = execFileSync(process.execPath, [path.join(repo, 'scripts/check-locales.mjs')], { encoding: 'utf8' });
assert.ok(check.includes('全部通过'), `check-locales 应当通过，实际输出：${check.slice(0, 300)}`);
console.log('✅ scripts/check-locales.mjs 通过，PR 作者有办法自己先验一遍');

/* ── 4. 路由：按标签挑语言包，挑不到回中文，且不从请求拼路径 ── */

const { routes } = await loadRoutes();
const handler = routes.get('/api/session.locales');
assert.ok(typeof handler === 'function', '必须注册 /api/session.locales');

function call(tag, origin) {
  const search = tag === undefined ? '' : `?lang=${encodeURIComponent(tag)}`;
  const url = `http://127.0.0.1:3080/api/session.locales${search}`;
  return handler(new Request(url, origin === undefined ? {} : { headers: { origin } }));
}

async function body(tag) {
  const response = await call(tag);
  return { status: response.status, body: JSON.parse(await response.text()) };
}

const zh = await body('zh-CN');
assert.equal(zh.status, 200, '正常请求要 200');
assert.equal(zh.body.status, 'ok');
assert.equal(zh.body.lang, 'zh-CN');
assert.equal(Object.keys(zh.body.messages).length, sourceKeys.length, '下发的键数要和语言包一致');
assert.deepEqual(zh.body.available, tags, '要告诉客户端现有哪些语言');
assert.equal(zh.body.fallback, 'zh-CN');

const en = await body('en-US');
assert.equal(en.body.lang, 'en-US');
assert.notEqual(en.body.messages.button, zh.body.messages.button, '英文包必须真的是英文');

const loose = await body('en');
assert.equal(loose.body.lang, 'en-US', '只有主语言时要落到同族的具体标签');

const unknown = await body('xx-YY');
assert.equal(unknown.body.lang, 'zh-CN', '认不出的语言回中文，不能 500');

const noParam = await body(undefined);
assert.equal(noParam.body.lang, 'zh-CN', '不给 lang 时也要有兜底');

const traversal = await body('../../package');
assert.equal(traversal.status, 200, '路径穿越的标签只可能退化成中文，不能抛错');
assert.equal(traversal.body.lang, 'zh-CN');
assert.equal(traversal.body.messages.button, zh.body.messages.button);

const gate = await call(undefined, 'http://evil.example');
assert.equal(gate.status, 403, '跨站请求要被 requestGate 挡掉');
console.log('✅ 语言包路由：精确/主语言/未知标签都落到对的语言，路径穿越退化中文，跨站被挡');

console.log('✅ locales 自检通过');
