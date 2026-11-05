// 用 DSH 自己的会话索引（@deepseek-ai/dsh-session-persistence-jsonl）
// 去认我们落盘的会话：它扫盘、读文件头、按 header.id 登记。
// 这一层是「打开失败 · sessions.retain: unknown session」的源头——
// 真实索引能认出这个 id，客户端跳转才有得跳；认不出，重试多少遍都没用。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { makeFixture, autoCleanup } from './fixture.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const DSH = process.env.DSH_CHECKOUT ?? 'C:/Users/aa/AppData/Roaming/dsh-tauri/dependencies/dsh';
const persistenceEntry = path.join(DSH, 'node_modules/@deepseek-ai/dsh-session-persistence-jsonl/lib/index.js');
const cordisEntry = path.join(DSH, 'node_modules/@deepseek-ai/cordis/lib/index.js');

const fx = makeFixture('dsh-list');
autoCleanup(fx);

// 夹具已经把会话按 DSH 的目录约定写在 fixtures 里了（projectKey + encodeSegment(id) + session.v4.jsonl.zstd）
assert.ok(fs.existsSync(fx.session.file), '夹具没把会话写出来');

if (fs.existsSync(persistenceEntry) === false || fs.existsSync(cordisEntry) === false) {
  console.log('⚠️  本机没装 DSH，跳过真实索引用例');
  console.log('dsh-list 自检通过（跳过）');
  process.exit(0);
}

const { Context } = await import(pathToFileURL(cordisEntry).href);
const { apply } = await import(pathToFileURL(persistenceEntry).href);

const ctx = new Context();
await apply(ctx, { root: fx.sessions, compression: 'zstd' });
const store = ctx.get('sessionPersistence') ?? ctx.sessionPersistence;
assert.ok(store !== undefined, 'DSH 的会话存储服务没起来');

const snapshots = await store.list();
const found = snapshots.find((s) => s.header.id === fx.session.id);
assert.ok(found !== undefined, `DSH 索引没认出这个会话：${fx.session.id}（列到 ${snapshots.length} 个）`);
assert.equal(found.header.cwd, fx.cwd, 'header.cwd 要原样保留');
assert.equal(found.header.version, 4, '会话格式版本要是 4');
assert.ok(found.sizeBytes > 0, '体积要能算出来');
console.log(`✅ DSH 自己的索引认出了落盘的会话（共 ${snapshots.length} 个）`);

// 再列一次：列表是每次现扫盘算出来的，不依赖上一次的结果。
// 这也是客户端那个「refresh() 之后就能认识新导入会话」的前提。
const again = await store.list();
assert.equal(again.some((item) => item.header.id === fx.session.id), true, '再列一次也要能认出');
console.log('✅ 反复列两次都能认出（客户端 refresh 后才有得跳）');

await ctx.dispose?.();
console.log('dsh-list 自检通过');
