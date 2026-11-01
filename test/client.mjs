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

/*
 * client.js 用 `navigator.language` 选词表（/^en\b/i → EN，否则 ZH）。
 * Node 21+ 自带全局 navigator，它的 language 跟随宿主机语言：中文机 zh-CN 走 ZH，
 * GitHub 的英文 windows-latest runner 是 en-US 走 EN。测试若不锁定它，断言就会随
 * 跑测机器的语言飘——CI 挂而本地过，正是这个原因。
 *
 * 所以这里把 navigator 钉死成指定 locale，让测试与环境解耦，并对中英各跑一遍。
 */
function setLocale(language) {
  Object.defineProperty(globalThis, 'navigator', {
    value: { language },
    configurable: true,
    writable: true,
  });
}

/* 默认钉中文（断言按中文写）。CI 用 DSH_TEST_LOCALE 显式声明，本文件另有英文一轮的回归。 */
const LOCALE = process.env.DSH_TEST_LOCALE || 'zh-CN';
setLocale(LOCALE);
const IS_EN = /^en\b/i.test(LOCALE);

/* 组件渲染用的是内置中文兜底表：语言包是启动后异步拉的，测试里不发请求。
   所以期望值取 zh-CN.json，另加一条断言证明 en-US.json 真的翻过这句——
   不然「英文 runner 跑中文断言」会误判成缺陷。 */
const ZH_PACK = JSON.parse(readFileSync(new URL('../locales/zh-CN.json', import.meta.url), 'utf8'));
const EN_PACK = JSON.parse(readFileSync(new URL('../locales/en-US.json', import.meta.url), 'utf8'));
const T = { saveAs: ZH_PACK.saveAs, openButton: ZH_PACK.openButton };

new Function('window', source)(globalThis.window);

assert.ok(loaded, 'client.js 未调用 __ModuleLoader__.load');
assert.equal(loaded.id, 'dsh-session-save', 'module id');

const mod = loaded.module;
assert.ok(mod && typeof mod.apply === 'function', 'apply 缺失');
assert.deepEqual(
  mod.inject,
  ['slots', 'sessions', 'uiWorkspace', 'remote', 'remote.session'],
  'inject 声明',
);

// 「打开记忆目录」必须走 Session Remote 的 openWorkspacePath。
// DSH 的 UiWorkspace 没有 openPath 方法（只有 openSession / openWorkspace /
// forkSession / connectWorkspace / startSession / archiveSession /
// unarchiveSession / pinSession / unpinSession / pickDirectory /
// listDirectory / createDirectory），早先那行
// `typeof host?.uiWorkspace?.openPath === 'function'` 恒为假，按钮点了没有反应。
assert.equal(/uiWorkspace\s*\??\.\s*openPath/.test(source), false, '不得调用不存在的 uiWorkspace.openPath');
assert.ok(source.includes('openWorkspacePath'), '打开目录应走 remote.session.openWorkspacePath');
assert.ok(source.includes("action: 'reveal'"), '打开目录应用 reveal（交给文件管理器而非默认应用）');

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
assert.equal(saveAsButton.props['aria-label'], T.saveAs, `另存为按钮的 aria-label 取自语言表（locale=${LOCALE}，首屏用内置中文兜底）`);
assert.notEqual(EN_PACK.saveAs, ZH_PACK.saveAs, 'en-US.json 里这句要真的翻译过，不能照抄中文');

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

/* 界面文案已外置到 `locales/*.json`（谁都能加一份提 PR），client.js 只留中文兜底。
   所以「中英各一份」这件事从「源码里数两遍」改成「两份语言包都齐全」。 */
const localePack = (tag) => JSON.parse(readFileSync(new URL(`../locales/${tag}.json`, import.meta.url), 'utf8'));
const zhPack = localePack('zh-CN');
const enPack = localePack('en-US');
function assertBilingual(key) {
  assert.ok(key in zhPack, `locales/zh-CN.json 缺 ${key}`);
  assert.ok(key in enPack, `locales/en-US.json 缺 ${key}`);
  assert.ok(source.includes(`${key}:`), `client.js 的中文兜底表缺 ${key}`);
}

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
  assertBilingual(key);
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
  assertBilingual(key);
}
assert.ok(source.includes('memoryPlanned'), '合并弹窗必须读 memoryPlanned 才能分两段列清单');
assert.ok(source.includes("memory: 'new'"), '「合并并新建」必须把 memory=new 传给打开路由');
assert.ok(source.includes('memoryCreated'), '前端要消费 memoryCreated（本机没有、没写的那些）');
assert.ok(
  source.includes('memoryMergeNoOverwrite'),
  '没有可覆盖文件时要有明确文案，不能让用户以为「没事」',
);
console.log('✅ 合并弹窗分「将覆盖 / 将新建」两段，并给出 memory=new 出路，中英文案齐全');

/* ── R7：目标文件不在了必须停下来问（不能静默新建） ── */

for (const key of [
  'missingTarget',
  'missingTargetHint',
  'missingTargetRecreate',
  'missingTargetSaveAs',
  'missingAutoOff',
]) {
  assertBilingual(key);
}
assert.ok(source.includes('MissingModal'), '要有专门的「文件不在了」弹窗组件');
assert.ok(
  source.includes("payload.status === 'missing-target'"),
  '保存返回 missing-target 时前端必须接住，不能当成功处理',
);
assert.ok(
  source.includes("recreate: '1'"),
  '「就在这里新建」必须把 recreate=1 传给保存路由',
);
assert.ok(
  source.includes('payload.missing') && source.includes('L.missingAutoOff'),
  '自动保存被目标消失停掉时，界面要把原因（含原路径）说出来',
);
console.log('✅ 目标文件不在了会停下来问：missing-target 弹窗三选一、自动保存自停并说明原因，中英文案齐全');

/* ── R8. 打开前体检：改了什么要让用户看见 ── */

for (const key of ['repairHint', 'repairMissing', 'repairPatched', 'repairLines', 'repairFrames']) {
  assertBilingual(key);
}
assert.ok(source.includes('payload.repair'), '打开结果里的 repair 报告必须被读取');
assert.ok(source.includes('repair.changed === true'), '只有真的改过才提示，不能每次都报一遍');
assert.ok(
  source.includes('L.repairHint') && source.includes('repairNotes.join'),
  '体检结果要拼成一句话说出来，而不是只存着',
);
console.log('✅ 打开前体检有交代：改了哪几类（缺字节/缺尺寸/坏行/坏帧）逐条列出，中英文案齐全');

/* ── R9. 附件被配额拦下时必须说出来 ── */

for (const key of ['attachRejected']) {
  assertBilingual(key);
}
assert.ok(source.includes('payload.attachmentsRejected'), '打开结果里的 attachmentsRejected 必须被读取');
assert.ok(
  source.includes("attachRejected > 0") && source.includes('L.attachRejected'),
  '被拦下的附件要拼进提示文本，不能只做计数没人看',
);
console.log('✅ 附件被配额拦下时说明了「几个、为什么」，中英文案齐全，且不打扰正常回填');

/* ── R10. cwd 不合格要报「换个位置」；合并弹窗要摊出记忆落点 ── */

for (const key of ['memoryMergeTarget', 'wsBadTitle', 'wsBadMissing', 'wsBadNotDir', 'wsBadCreate', 'wsBadCreateFailed']) {
  assertBilingual(key);
}
assert.ok(source.includes("payload.status === 'bad-workspace'"), 'bad-workspace 状态必须被接住');
assert.ok(source.includes('L.wsBadTitle'), 'bad-workspace 弹窗要有自己的标题，不能复用 need-workspace');
assert.ok(source.includes("createCwd: '1'"), '「在这里新建」按钮要带上建目录的显式开关');
assert.ok(source.includes('payload?.canCreate === true'), '服务端说不该建（位置被文件占了 / 建失败过）时不显示按钮');
assert.ok(/onCreate:\s*\(dir\)\s*=>/.test(source), '新建按钮要把原路径交给后端，而不是让用户重选');
assert.ok(
  /status === 'bad-workspace'\)\s*\{[\s\S]{0,400}setWorkspace\(payload\)/.test(source),
  'bad-workspace 要复用工作区弹窗给出路，不能只弹一行错误',
);
assert.ok(source.includes('payload?.reason === \'missing\''), '两种不可用原因要分开说');
assert.ok(
  source.includes('payload?.memoryDir'),
  '合并弹窗要读 memoryDir —— need-workspace 返回体里没有它，必须容忍 undefined',
);
assert.ok(
  source.includes('L.memoryMergeTarget'),
  '弹窗要把「落点不是你当前打开的工作区」说清楚，否则用户以为写进眼前这个项目',
);
console.log('✅ cwd 不合格时说「换个位置」；合并弹窗摊出记忆落点并说明它不是当前工作区，中英文案齐全');
for (const key of ['wsReplaceFile', 'wsReplaceHint', 'lockedTitle', 'lockedHint', 'lockedForce', 'brokenTitle', 'brokenHint', 'brokenCopy', 'brokenCopied', 'brokenRepair', 'brokenCount', 'brokenNoPrompt']) {
  assertBilingual(key);
}
assert.ok(source.includes('LockedModal'), '锁冲突要有自己的弹窗，不能只弹 toast');
assert.ok(source.includes('BrokenModal'), '坏包要摊出可复制的说明，不能只说「打开失败」');
assert.ok(source.includes("repairPackage: '1'"), '坏包弹窗要能给「丢掉坏条目再试一次」的开关');
assert.ok(source.includes("ignoreLock: '1'"), '锁弹窗的「仍然保存」要带 ignoreLock');
assert.ok(source.includes('payload.canIgnoreLock === true'), '只有服务端给了出口才显示「仍然保存」');
assert.ok(source.includes('payload?.prompt'), '坏包说明要读服务端给的 prompt');
assert.ok(source.includes("replaceFile: '1'"), '位置被文件占着时，「改名备份」要带 replaceFile');
assert.ok(source.includes('payload?.canReplace === true'), '只有服务端说能代劳才显示那个按钮');
console.log('✅ 三条出口都接到界面：位置被占可改名备份、锁冲突可仍然保存、坏包可复制说明找 AI 修，中英文案齐全');
