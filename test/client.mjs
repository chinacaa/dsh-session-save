/**
 * Client-half wiring test.
 *
 * Loads client.js exactly the way the DSH module loader does (window.__ModuleLoader__.load),
 * supplies a stub React and a stub ctx, then asserts:
 *   1. apply() registers three header utilities (open / save / autosave) and one
 *      hero option (`conversation.hero.options`) — the blank-session page seat;
 *   2. every registered component renders without throwing;
 *   3. the hero button really calls /api/session.open when clicked;
 *   4. client.js touches no DOM directly (no document / MutationObserver dependency).
 *
 * Run: node plugins/dsh-session-save/test/client.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';

const here = path.dirname(fileURLToPath(import.meta.url));
const file = path.join(here, '..', 'client.js');

/* ── 假 React：单次渲染，effect 收集起来手动跑 ── */

const effects = [];

function makeReact() {
  const resolve = (init) => (typeof init === 'function' ? init() : init);
  return {
    Fragment: Symbol('Fragment'),
    createElement(type, props, ...children) {
      return { type, props: props ?? {}, children };
    },
    useState: (init) => [resolve(init), () => {}],
    useRef: (init) => ({ current: resolve(init) }),
    useCallback: (fn) => fn,
    useMemo: (fn) => fn(),
    useEffect: (fn) => {
      effects.push(fn);
    },
    useLayoutEffect: (fn) => {
      effects.push(fn);
    },
  };
}

let loaded = null;
globalThis.window = {
  __ModuleLoader__: {
    load({ id, factory }) {
      loaded = {
        id,
        module: factory((name) => {
          if (name === 'react') return makeReact();
          throw new Error(`unexpected require(${name})`);
        }),
      };
    },
  },
};

const fetched = [];
globalThis.fetch = async (url) => {
  fetched.push(String(url));
  return {
    ok: true,
    status: 200,
    async json() {
      return { status: 'need-workspace', sessionId: 'session-test', workspaces: [] };
    },
    async text() {
      return '{}';
    },
  };
};

const source = readFileSync(file, 'utf8');

assert.equal(/document\s*\./.test(source), false, 'client.js 不应再直接操作 DOM');
assert.equal(/MutationObserver/.test(source), false, 'client.js 不应再依赖 MutationObserver');

new Function('window', source)(globalThis.window);

assert.ok(loaded, 'client.js 未调用 __ModuleLoader__.load');
assert.equal(loaded.id, 'dsh-session-save', 'module id');

const mod = loaded.module;
assert.ok(mod && typeof mod.apply === 'function', 'apply 缺失');
assert.deepEqual(mod.inject, ['slots', 'sessions', 'uiWorkspace'], 'inject 声明');

const registered = [];
const injected = [];
const ctx = {
  slots: {
    inject(name, cb) {
      injected.push(name);
      cb();
      return () => {};
    },
    register(def, component) {
      registered.push({ def, component });
      return () => {};
    },
  },
  sessions: { refresh: async () => {} },
  uiWorkspace: { openSession() {}, pickDirectory: async () => null },
};

mod.apply(ctx);

const HEADER = 'conversation.session.header.utilities';
const HERO = 'conversation.hero.options';

assert.equal(injected.length, 5, '五次 slots.inject');
assert.deepEqual(injected, [HEADER, HEADER, HEADER, HEADER, HERO], 'inject 目标插槽');
assert.equal(registered.length, 5, '五个插槽项');
assert.deepEqual(
  registered.map((r) => r.def.id),
  ['session-open', 'session-save', 'session-autosave', 'session-save-as', 'session-open-hero'],
  '插槽项 id 顺序',
);
assert.deepEqual(registered.map((r) => r.def.name), [HEADER, HEADER, HEADER, HEADER, HERO], '插槽项 name');
assert.deepEqual(registered.map((r) => r.def.order), [39, 40, 41, 42, 41], '插槽项 order');
assert.ok(registered.every((r) => typeof r.component === 'function'), '组件是函数');

function collectButtons(node, out = []) {
  if (node === null || typeof node !== 'object') return out;
  if (node.type === 'button') out.push(node);
  for (const child of node.children ?? []) collectButtons(child, out);
  return out;
}

// 每个组件都渲染一遍（effect 只被收集，不会自动执行）
const trees = new Map();
for (const { def, component } of registered) {
  const tree = component({ sessionId: 'session-test', displayTitle: '示例会话' });
  assert.ok(tree && typeof tree === 'object', `${def.id} 组件返回值`);
  trees.set(def.id, tree);
}

/* ── 空会话页面的按钮 ── */

const hero = trees.get('session-open-hero');
const heroButton = hero.children.find((child) => child && child.type === 'button');
assert.ok(heroButton !== undefined, '空会话页面没有渲染出打开按钮');
assert.equal(heroButton.props.type, 'button', '按钮 type');
assert.equal(typeof heroButton.props.onClick, 'function', '按钮有 onClick');
assert.equal(heroButton.props.disabled, false, '按钮默认可用');
assert.ok(String(heroButton.props.title).length > 0, '按钮有 title 提示');
assert.equal(heroButton.props['aria-label'], heroButton.props.title ? heroButton.props['aria-label'] : undefined);

// 图标 + 文案
assert.equal(heroButton.children.length, 2, '按钮里应有图标和文案');
const label = heroButton.children[1];
assert.equal(label.type, 'span', '文案节点是 span');
assert.equal(typeof label.children[0], 'string', `按钮文案应是字符串，实际 ${typeof label.children[0]}`);
assert.ok(label.children[0].length > 0, '按钮文案不为空');

// 点一下 → 打到 /api/session.open
heroButton.props.onClick();
await new Promise((resolve) => setTimeout(resolve, 10));
assert.ok(
  fetched.some((url) => url.startsWith('api/session.open')),
  `点击后没有请求打开路由：${JSON.stringify(fetched)}`,
);

// 其余组件也应有可点击按钮
for (const id of ['session-open', 'session-save', 'session-autosave']) {
  const buttons = collectButtons(trees.get(id));
  assert.ok(buttons.length > 0, `${id} 没有渲染出按钮`);
}

/* ── 另存为是独立图标按钮 ── */

const saveAsElement = trees.get('session-save-as');
assert.equal(saveAsElement.props.alwaysAsk, true, '另存为按钮应强制弹对话框');
assert.equal(saveAsElement.props.sessionId, 'session-test', '另存为按钮拿到 sessionId');

const saveAsButtons = collectButtons(saveAsElement.type(saveAsElement.props));
assert.equal(saveAsButtons.length, 1, '另存为渲染出一个按钮');
const saveAsButton = saveAsButtons[0];
assert.equal(saveAsButton.props['aria-label'], '另存为', '另存为按钮的 aria-label');

// 图标必须是新的（不是软盘）
const renderNode = (node) =>
  node && typeof node.type === 'function' ? renderNode(node.type(node.props ?? {})) : node;
const firstPathD = (button) => {
  const icon = (button.children ?? []).map(renderNode).find((child) => child && child.type === 'svg');
  const path = (icon?.children ?? []).map(renderNode).find((child) => child && child.type === 'path');
  return String(path?.props?.d ?? '');
};
const saveIconD = firstPathD(saveAsButton);
assert.ok(saveIconD.startsWith('M2.5 2.5h8l3 3v3'), `另存为图标不是 SaveAsIcon：${JSON.stringify(saveIconD)}`);
const plainButtons = collectButtons(trees.get('session-save'));
assert.notEqual(firstPathD(plainButtons[0]), saveIconD, '保存与另存为的图标应不同');

// 点一下另存为 → 请求里必须带 ask=1
saveAsButton.props.onClick({});
await new Promise((resolve) => setTimeout(resolve, 10));
assert.ok(
  fetched.some((url) => url.startsWith('api/session.save') && url.includes('ask=1')),
  `另存为没有带 ask=1：${JSON.stringify(fetched)}`,
);

console.log(`✅ client 接线通过 / id=${loaded.id} / inject=${mod.inject.join(',')}`);
console.log(`✅ 插槽项 ${registered.map((r) => `${r.def.id}@${r.def.order}`).join(' ')}`);
console.log('✅ 空会话页面渲染了打开按钮（点击走 api/session.open），且 client.js 不再直接操作 DOM');
console.log('✅ 另存为是独立图标按钮，点击带 ask=1 强制弹对话框');

/* ── R5：记忆落盘结果必须被前端消费（中英两份文案都在） ── */

const clientSource = readFileSync(file, 'utf8');
for (const key of [
  'memoryCopiesHint',
  'memoryConflictsHint',
  'memoryRestoredHint',
  'memoryNoticeTitle',
  'memoryNoticeBody',
  'memoryMerge',
  'memoryMergeTitle',
  'memoryMergeHint',
  'memoryMergeMore',
  'memoryMergeConfirm',
  'memoryOpenDir',
]) {
  const hits = source.split(`${key}:`).length - 1;
  assert.equal(hits, 2, `${key} 必须中英各一份，实际 ${hits} 处`);
}
// R6 把判断抽成了 mode 变量，语义不变：restore 与 copy 走不同文案
assert.ok(
  source.includes("mode === 'restore'") &&
    source.includes('L.memoryRestoredHint') &&
    source.includes('L.memoryCopiesHint'),
  'jump 应区分 restore 与 copy 的提示',
);
assert.ok(source.includes("memory: 'restore'"), '合并按钮应把 memory=restore 传给打开路由');
assert.ok(source.includes('MemoryNotice') && source.includes('MemoryMergeModal'), '记忆提示与合并弹窗应存在');
console.log('✅ 记忆落盘结果被前端消费：副本提示、冲突计数、合并弹窗，中英文案齐全');

/* ── R6：合并弹窗要分「将覆盖 / 将新建」，并给出 memory=new 的出路 ── */

for (const key of [
  'memoryMergeOverwrite',
  'memoryMergeCreate',
  'memoryMergeCreateHint',
  'memoryMergeWithNew',
  'memoryMergeNoOverwrite',
  'memoryCreatedHint',
  'memoryNewHint',
]) {
  const hits = source.split(`${key}:`).length - 1;
  assert.equal(hits, 2, `${key} 必须中英各一份，实际 ${hits} 处`);
}
assert.ok(source.includes('memoryPlanned'), '合并弹窗必须读 memoryPlanned 才能分两段列清单');
assert.ok(source.includes("memory: 'new'"), '「合并并新建」必须把 memory=new 传给打开路由');
assert.ok(source.includes('memoryCreated'), '前端要消费 memoryCreated（本机没有、没写的那些）');
assert.ok(
  source.includes('memoryMergeNoOverwrite'),
  '没有可覆盖文件时要有明确文案，不能让用户以为「没事」',
);
console.log('✅ 合并弹窗分「将覆盖 / 将新建」两段，并给出 memory=new 出路，中英文案齐全');
