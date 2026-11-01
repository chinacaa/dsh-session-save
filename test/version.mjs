/**
 * 包比插件新的时候要会说人话（F53）。
 *
 * 为什么需要这一套：0.2.x 打开 0.3.0 的包，得到的是一句「包里有不认识的条目，拒绝打开：
 * attachments/objects/…」。用户第一反应是「我的包坏了」，于是去翻备份、去重存一份——
 * 而真实原因只是插件旧了。这类误解的代价比多写十行代码高得多。
 *
 * 这里验四件事：
 *   1. 打出来的包确实记下了写它的插件版本（manifest.plugin）；
 *   2. 包比我新 → 报「更新版本，先升级」，并同时说出包版本和本机版本；
 *   3. 包和我同版本却带了陌生条目 → 仍然按「不认识」拒绝（不能一句「你旧了」糊掉真异常）；
 *   4. 老包没有 plugin 字段 → 也不许崩，照旧拒绝。
 *
 *   node plugins/dsh-session-save/test/version.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { autoCleanup, loadRoutes, makeFixture } from './fixture.mjs';

const fx = makeFixture();
autoCleanup(fx);

const { mod, routes } = await loadRoutes('../index.js');
const { ROUTE, OPEN_ROUTE, zipRead, zipWrite, compareVersions } = mod;
const saveRoute = routes.get(ROUTE);
const openRoute = routes.get(OPEN_ROUTE);
if (typeof saveRoute !== 'function' || typeof openRoute !== 'function') {
  throw new Error('路由没取到：save/open');
}

const here = path.dirname(fileURLToPath(import.meta.url));
const myVersion = JSON.parse(fs.readFileSync(path.join(here, '..', 'package.json'), 'utf8')).version;

/* ── 1. 版本比较：只回答「谁更新」，不管 semver 的兼容语义 ── */

const cases = [
  ['9.9.9', '0.3.1', 1, '主版本更大算更新'],
  ['0.3.10', '0.3.9', 1, '数字段按数值比，不是字典序'],
  ['1.0.0', '0.9.9', 1, '1.x 高于任何 0.x'],
  [myVersion, myVersion, 0, '自己跟自己一样'],
  ['0.3.0-rc.1', '0.3.0', 0, '预发布后缀丢掉后相同'],
];
for (const [a, b, want, why] of cases) {
  const got = compareVersions(a, b);
  if (got !== want) throw new Error(`compareVersions(${a}, ${b}) = ${got}，应为 ${want}（${why}）`);
}
console.log(`✅ 版本比较 ${cases.length} 种情形都对`);

/* ── 2. 打一个正常的包，看它记了什么 ── */

const tmp = fs.mkdtempSync(path.join(fx.base, 'ver-'));
const stateFile = path.join(fx.home, 'storages', 'session-save.json');
const state = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : {};
state.lastDir = tmp;
fs.mkdirSync(path.dirname(stateFile), { recursive: true });
fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));

const good = path.join(tmp, 'good.dsproj');
const saved = await saveRoute(
  new Request(
    `http://127.0.0.1:3080${ROUTE}?sessionId=${encodeURIComponent(fx.session.id)}&path=${encodeURIComponent(good)}`,
  ),
);
if (saved.status !== 200) throw new Error(`保存失败 ${saved.status}: ${await saved.text()}`);

const entries = zipRead(fs.readFileSync(good));
const manifest = JSON.parse(entries.get('manifest.json').toString('utf8'));
if (manifest.plugin === undefined || manifest.plugin === null) throw new Error('manifest 里没有 plugin 字段');
if (manifest.plugin.name !== 'dsh-session-save') throw new Error(`plugin.name 不对：${manifest.plugin.name}`);
if (manifest.plugin.version !== myVersion) {
  throw new Error(`plugin.version 应是 ${myVersion}，实际 ${manifest.plugin.version}`);
}
console.log(`✅ 包记住了写它的版本：${manifest.plugin.name} ${manifest.plugin.version}`);

/* ── 3. 把包改成「未来版本写的」，再塞一条本版不认识的条目 ── */

// 条目名要挑一个本版确实不认识的：attachments/ 现在认识了，用 previews/ 当前缀示例。
const foreignName = `previews/${'ab'}/${'a'.repeat(64)}`;
const rebuild = (patch) => {
  const list = [...entries].map(([name, data]) => ({ name, data }));
  list.push({ name: foreignName, data: Buffer.from('future-entry', 'utf8') });
  const merged = { ...manifest, ...patch };
  const withoutManifest = list.filter((item) => item.name !== 'manifest.json');
  return zipWrite([{ name: 'manifest.json', data: Buffer.from(JSON.stringify(merged, null, 2), 'utf8') }, ...withoutManifest]);
};

const caseOf = async (fileName, patch) => {
  const file = path.join(tmp, fileName);
  fs.writeFileSync(file, rebuild(patch));
  const res = await openRoute(
    new Request(`http://127.0.0.1:3080${OPEN_ROUTE}?path=${encodeURIComponent(file)}&cwd=${encodeURIComponent(fx.base)}`),
  );
  return { status: res.status, body: await res.json() };
};

const future = await caseOf('future.dsproj', { plugin: { name: 'dsh-session-save', version: '9.9.9' } });
if (future.status !== 500) throw new Error(`未来包应当被拒（500），实际 ${future.status}`);
const futureMsg = String(future.body.message ?? '');
if (futureMsg.includes('更新版本') === false) throw new Error(`提示里没说是版本问题：${futureMsg}`);
if (futureMsg.includes('9.9.9') === false) throw new Error(`提示里没说包是哪个版本写的：${futureMsg}`);
if (futureMsg.includes(myVersion) === false) throw new Error(`提示里没说本机版本：${futureMsg}`);
if (futureMsg.includes('升级') === false) throw new Error(`提示里没说要升级：${futureMsg}`);
// 提示是给用户看的，不该把服务器上的绝对路径抖出去
if (/[A-Za-z]:[\\/]/.test(futureMsg)) throw new Error(`提示里漏了盘符路径：${futureMsg}`);
console.log(`✅ 未来版本的包：明说升级、带双方版本、不漏路径`);

/* ── 4. 同版本却带陌生条目：不能拿「你旧了」糊掉真异常 ── */

const same = await caseOf('same.dsproj', { plugin: { name: 'dsh-session-save', version: myVersion } });
if (same.status !== 500) throw new Error(`同版本的陌生包也应当被拒，实际 ${same.status}`);
const sameMsg = String(same.body.message ?? '');
if (sameMsg.includes('不认识的条目') === false) throw new Error(`同版本应报「不认识的条目」：${sameMsg}`);
if (sameMsg.includes('更新版本')) throw new Error(`同版本不该说「更新版本」：${sameMsg}`);
console.log('✅ 同版本的陌生条目仍按「不认识」拒绝，没有糊过去');

/* ── 5. 老包没有 plugin 字段：不许崩 ── */

const legacyEntries = [...entries].map(([name, data]) => ({ name, data }));
const legacyManifest = { ...manifest };
delete legacyManifest.plugin;
const legacyFile = path.join(tmp, 'no-plugin.dsproj');
fs.writeFileSync(
  legacyFile,
  zipWrite([
    { name: 'manifest.json', data: Buffer.from(JSON.stringify(legacyManifest, null, 2), 'utf8') },
    ...legacyEntries.filter((item) => item.name !== 'manifest.json'),
    { name: foreignName, data: Buffer.from('future-entry', 'utf8') },
  ]),
);
const legacyRes = await openRoute(
  new Request(
    `http://127.0.0.1:3080${OPEN_ROUTE}?path=${encodeURIComponent(legacyFile)}&cwd=${encodeURIComponent(fx.base)}`,
  ),
);
const legacyBody = await legacyRes.json();
const legacyMsg = String(legacyBody.message ?? '');
if (legacyRes.status !== 500) throw new Error(`老包带陌生条目也应当被拒，实际 ${legacyRes.status}`);
if (legacyMsg.includes('不认识的条目') === false) throw new Error(`老包应报「不认识的条目」：${legacyMsg}`);
console.log('✅ 没有版本字段的老包：照旧拒绝，不崩也不乱猜');

/* ── 6. 正常包还能打开（改了校验不等于改了放行） ── */

const ok = await openRoute(
  new Request(`http://127.0.0.1:3080${OPEN_ROUTE}?path=${encodeURIComponent(good)}&cwd=${encodeURIComponent(fx.base)}`),
);
if (ok.status !== 200) throw new Error(`正常包打不开 ${ok.status}: ${await ok.text()}`);
console.log('✅ 正常包不受影响，照常打开');

console.log('\n✅ version 自检通过（6 项）');
