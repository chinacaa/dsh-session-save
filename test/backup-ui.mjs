/**
 * 三个「覆盖前先备份」弹窗的回调 + 界面文案完整性。
 *
 * 为什么要单独一套：`test/client.mjs` 只把五个插槽项渲染一遍，弹窗内部的复选框状态
 * 从来没被点过。备份开关最容易坏的地方恰好在那条缝里——服务端读到了 `backup=0`，
 * 但界面根本没把勾选状态传出去（或者默认值是反的），用户以为自己留了退路。
 *
 * 这套测试用一个小号 React（真状态、手动重渲染）把三个弹窗各自挂起来：
 *   1. 陈旧（StaleModal）：默认勾选 → 点「覆盖磁盘文件」应带 force=1&backup=1；
 *      取消勾选 → backup=0；
 *   2. 冲突（ConflictModal）：同上，选「覆盖」/「另存为副本」都要带上勾选状态；
 *   3. 合并记忆（MemoryMergeModal）：memory=restore 同样带 backup。
 * 顺带把文案键查一遍：client.js 里每个 `L.<key>` 都要在两份语言包里，
 * 中文兜底表不许出现重复键（重复 = 后者静默覆盖前者，界面会突然变英文）。
 *
 * 运行：node test/backup-ui.mjs
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.dirname(here);
const source = readFileSync(path.join(repo, 'client.js'), 'utf8');
const zhPack = JSON.parse(readFileSync(path.join(repo, 'locales', 'zh-CN.json'), 'utf8'));
const enPack = JSON.parse(readFileSync(path.join(repo, 'locales', 'en-US.json'), 'utf8'));

let passed = 0;
let failed = 0;
const ok = (label, detail) => {
  passed += 1;
  console.log(`✅ ${label}${detail === undefined ? '' : ` · ${detail}`}`);
};
const bad = (label, detail) => {
  failed += 1;
  console.error(`✗ ${label}${detail === undefined ? '' : ` · ${detail}`}`);
};
const check = (condition, label, detail) => (condition ? ok(label, detail) : bad(label, detail));

/* ───────────────────────── 小号 React：真状态 + 手动重渲染 ───────────────────────── */

let current = null;
const element = (type, props, ...children) => ({ type, props: props ?? {}, children });

const React = {
  Fragment: Symbol('Fragment'),
  createElement: element,
  useState(init) {
    const inst = current;
    const index = inst.cursor++;
    if (!(index in inst.cells)) inst.cells[index] = typeof init === 'function' ? init() : init;
    const set = (next) => {
      const value = typeof next === 'function' ? next(inst.cells[index]) : next;
      inst.cells[index] = value;
    };
    return [inst.cells[index], set];
  },
  useRef(init) {
    const inst = current;
    const index = inst.cursor++;
    if (!(index in inst.cells)) inst.cells[index] = { current: typeof init === 'function' ? init() : init };
    return inst.cells[index];
  },
  useCallback(fn) {
    const inst = current;
    const index = inst.cursor++;
    if (!(index in inst.cells)) inst.cells[index] = fn;
    return inst.cells[index];
  },
  useMemo(fn) {
    const inst = current;
    const index = inst.cursor++;
    if (!(index in inst.cells)) inst.cells[index] = fn();
    return inst.cells[index];
  },
  useEffect(fn) {
    const inst = current;
    inst.cursor++;
    if (inst.pristine === true) inst.effects.push(fn);
  },
  useLayoutEffect(fn) {
    const inst = current;
    inst.cursor++;
    if (inst.pristine === true) inst.effects.push(fn);
  },
};

/** 挂一个组件：首次渲染顺带跑一遍 effect；之后由测试显式 render() 重渲染。 */
function mount(type, props = {}) {
  const inst = { props, cells: [], cursor: 0, effects: [], cleanups: [], pristine: true, tree: null };
  inst.render = () => {
    const previous = current;
    current = inst;
    inst.cursor = 0;
    try {
      inst.tree = type(inst.props);
    } finally {
      current = previous;
    }
    if (inst.pristine === true) {
      inst.pristine = false;
      for (const fn of inst.effects.splice(0)) {
        const cleanup = fn();
        if (typeof cleanup === 'function') inst.cleanups.push(cleanup);
      }
    }
    return inst.tree;
  };
  inst.render();
  return inst;
}

/* ── 假 fetch：按路由排队发脚本，并把每次请求的 URL 记下来 ── */

const calls = [];
const queues = new Map();
const queueOf = (route) => {
  if (!queues.has(route)) queues.set(route, []);
  return queues.get(route);
};
const script = (route, payload, status = 200) => queueOf(route).push({ payload, status });

globalThis.fetch = async (url) => {
  const raw = String(url);
  calls.push(raw);
  const route = raw.split('?')[0];
  const queue = queueOf(route);
  const next = queue.length > 0 ? queue.shift() : { payload: { status: 'ok' }, status: 200 };
  return {
    ok: next.status < 400,
    status: next.status,
    text: async () => JSON.stringify(next.payload),
    json: async () => next.payload,
  };
};

/* ── 照 DSH 的方式载入 client.js ── */

let loaded;
globalThis.window = {
  __ModuleLoader__: {
    load({ id, factory }) {
      loaded = {
        id,
        module: factory((name) => {
          if (name === 'react') return React;
          throw new Error(`unexpected require(${name})`);
        }),
      };
    },
  },
};
Object.defineProperty(globalThis, 'navigator', { value: { language: 'zh-CN' }, configurable: true });
new Function('window', source)(globalThis.window);

check(loaded !== undefined && typeof loaded.module?.apply === 'function', 'I0 client.js 能被加载（模块 id 与 apply 都在）', loaded?.id);

const components = new Map();
const ctx = {
  slots: {
    inject(name, cb) {
      cb();
      return () => {};
    },
    register(def, component) {
      components.set(def.id, component);
      return () => {};
    },
  },
  sessions: { refresh: async () => {} },
  uiWorkspace: { openSession() {}, pickDirectory: async () => null },
};
loaded.module.apply(ctx);
check(components.size === 5, 'I1 五个插槽项都注册了', [...components.keys()].join(', '));

/* ───────────────────────── 树工具 ───────────────────────── */

const nodes = (node, out = []) => {
  if (node === null || node === undefined || typeof node !== 'object') return out;
  if (Array.isArray(node)) {
    for (const item of node) nodes(item, out);
    return out;
  }
  out.push(node);
  for (const child of node.children ?? []) nodes(child, out);
  if (node.props !== null && typeof node.props === 'object' && 'children' in node.props) nodes(node.props.children, out);
  return out;
};

const textExcerpt = (node) => {
  if (typeof node === 'string') return node;
  if (node === null || node === undefined || typeof node !== 'object') return '';
  return (node.children ?? []).map(textExcerpt).join('');
};

const byTypeName = (tree, name) =>
  nodes(tree).find((node) => typeof node.type === 'function' && node.type.name === name);

const buttons = (tree) => nodes(tree).filter((node) => node.type === 'button');

const findButton = (tree, label) =>
  buttons(tree).find((node) => textExcerpt(node).includes(label) || node.props?.['aria-label'] === label);

const checkboxIn = (tree) => nodes(tree).find((node) => node.type === 'input' && node.props?.type === 'checkbox');

const checkboxLabel = (tree, box) => {
  const label = nodes(tree).find((node) => node.type === 'label' && (node.children ?? []).includes(box));
  return label === undefined ? undefined : textExcerpt(label).trim();
};

const tick = () => new Promise((resolve) => setTimeout(resolve, 30));

/** 打开流程把弹窗都放在 OpenPanels 里：要先把它挂起来，才看得到里面的模态。 */
const panelsOf = (inst) => {
  inst.render();
  const element = byTypeName(inst.tree, 'OpenPanels');
  return element === undefined ? undefined : mount(element.type, element.props);
};

const lastCall = (route) => [...calls].reverse().find((url) => url.startsWith(route)) ?? '';
const paramsOf = (url) => new URLSearchParams(url.split('?')[1] ?? '');

/* ───────────────────────── S. 陈旧弹窗（保存时磁盘内容被改过） ───────────────────────── */

const save = mount(components.get('session-save'), { sessionId: 'session-test' });
const saveButton = findButton(save.tree, zhPack.button);
check(saveButton !== undefined, 'S0 保存按钮渲染出来了', zhPack.button);

script('api/session.save', {
  status: 'stale',
  path: 'demo.dsproj',
  stale: { expected: 'old-sha', actual: 'new-sha', bytes: 1024, since: '2026-11-02T22:00:00.000Z' },
  cloud: '',
});
saveButton.props.onClick({});
await tick();
save.render();

const staleElement = byTypeName(save.tree, 'StaleModal');
check(staleElement !== undefined, 'S1 服务端说 stale 时真的弹出陈旧弹窗');

const stale = mount(staleElement.type, staleElement.props);
const staleBox = checkboxIn(stale.tree);
check(staleBox?.props?.checked === true, 'S2 备份复选框默认勾选（默认留退路，不是默认不留）');
check(
  checkboxLabel(stale.tree, staleBox) === zhPack.backupKeep,
  'S3 复选框文案取自语言包（中文兜底不能是英文）',
  checkboxLabel(stale.tree, staleBox),
);

const staleOverwrite = findButton(stale.tree, zhPack.staleOverwrite);
check(staleOverwrite !== undefined, 'S4 陈旧弹窗有「覆盖磁盘文件」', zhPack.staleOverwrite);

calls.length = 0;
staleOverwrite.props.onClick();
await tick();
const staleKeepUrl = lastCall('api/session.save');
check(
  paramsOf(staleKeepUrl).get('force') === '1' && paramsOf(staleKeepUrl).get('backup') === '1',
  'S5 勾着备份点覆盖 → force=1 且 backup=1',
  staleKeepUrl,
);

staleBox.props.onChange({ target: { checked: false } });
stale.render();
const staleBoxAfter = checkboxIn(stale.tree);
check(staleBoxAfter?.props?.checked === false, 'S6 取消勾选后复选框状态真的变了（受控组件）');

script('api/session.save', { status: 'saved', path: 'demo.dsproj' });
calls.length = 0;
findButton(stale.tree, zhPack.staleOverwrite).props.onClick();
await tick();
const staleNoBakUrl = lastCall('api/session.save');
check(
  paramsOf(staleNoBakUrl).get('backup') === '0',
  'S7 勾掉备份点覆盖 → backup=0（不再偷偷留 .bak）',
  staleNoBakUrl,
);
check(nodes(stale.tree).filter((node) => node.type === 'input').length === 1, 'S8 陈旧弹窗只有一个复选框（不会长出第二个开关）');

/* ───────────────────────── C. 冲突弹窗（导入同一个会话的另一份） ───────────────────────── */

const open = mount(components.get('session-open'), {});
const openButton = findButton(open.tree, zhPack.openButton);
check(openButton !== undefined, 'C0 打开按钮渲染出来了', zhPack.openButton);

script(
  'api/session.open',
  {
    status: 'conflict',
    conflict: true,
    sourcePath: 'demo.dsproj',
    cwd: 'C:\\demo',
    existing: { target: 'C:\\demo\\a', id: 'session-a', cwd: 'C:\\demo', createdAt: 1, title: '本机那份', stats: { frames: 1, lines: 2 }, bytes: 100 },
    incoming: { id: 'session-a', cwd: 'C:\\demo', createdAt: 2, title: '包里那份', stats: { frames: 1, lines: 2 }, bytes: 120, exportedAt: '2026-11-02T00:00:00.000Z' },
  },
  409,
);
openButton.props.onClick({});
await tick();
open.render();

const openPanels = panelsOf(open);
check(openPanels !== undefined, 'C0b 打开流程的弹窗容器渲染出来了');
const conflictElement = byTypeName(openPanels.tree, 'ConflictModal');
check(conflictElement !== undefined, 'C1 冲突载荷到达界面（ConflictModal 渲染出来了）');

const conflict = mount(conflictElement.type, conflictElement.props);
const conflictBox = checkboxIn(conflict.tree);
check(conflictBox?.props?.checked === true, 'C2 冲突弹窗的备份复选框默认勾选');
check(
  checkboxLabel(conflict.tree, conflictBox) === zhPack.backupKeep,
  'C3 冲突弹窗文案同样取自语言包',
  checkboxLabel(conflict.tree, conflictBox),
);

script('api/session.open', { status: 'opened', sessionId: 'session-a', title: '包里那份' });
calls.length = 0;
findButton(conflict.tree, zhPack.conflictOverwrite).props.onClick();
await tick();
const conflictUrl = lastCall('api/session.open');
check(
  paramsOf(conflictUrl).get('onConflict') === 'overwrite' && paramsOf(conflictUrl).get('backup') === '1',
  'C4 选「覆盖」+ 勾备份 → onConflict=overwrite 且 backup=1',
  conflictUrl,
);

conflictBox.props.onChange({ target: { checked: false } });
conflict.render();
script('api/session.open', { status: 'opened', sessionId: 'session-a', title: '包里那份' });
calls.length = 0;
findButton(conflict.tree, zhPack.conflictCopy).props.onClick();
await tick();
const copyUrl = lastCall('api/session.open');
check(
  paramsOf(copyUrl).get('onConflict') === 'copy' && paramsOf(copyUrl).get('backup') === '0',
  'C5 换一条出路也照样带上勾选状态（copy + backup=0）',
  copyUrl,
);
check(nodes(conflict.tree).filter((node) => node.type === 'input').length === 1, 'C6 冲突弹窗只有一个复选框');

/* ───────────────────────── M. 合并记忆弹窗 ───────────────────────── */

const mergeFlow = mount(components.get('session-open'), {});
script('api/session.open', {
  status: 'opened',
  sessionId: 'session-m',
  title: '带记忆的包',
  cwd: 'C:\\demo',
  sourcePath: 'demo.dsproj',
  memoryWritten: 1,
  memoryMode: 'copy',
  memoryPlanned: [{ rel: 'MEMORY.md', exists: true }],
  memoryConflicts: [],
  memoryCreated: [],
  memoryDir: 'C:\\home\\memory\\workspaces\\--demo--',
  attachmentsWritten: 0,
  repair: { changed: false },
});
findButton(mergeFlow.tree, zhPack.openButton).props.onClick({});
await tick();

const mergePanels = panelsOf(mergeFlow);
const noticeElement = byTypeName(mergePanels.tree, 'MemoryNotice');
check(noticeElement !== undefined, 'M1 记忆只落了副本时给出提示面板（MemoryNotice）');
const notice = mount(noticeElement.type, noticeElement.props);
const mergeEntry = findButton(notice.tree, zhPack.memoryMerge);
check(mergeEntry !== undefined, 'M1b 提示面板里有「合并记忆」入口', zhPack.memoryMerge);

mergeEntry.props.onClick();
await tick();

const mergePanels2 = panelsOf(mergeFlow);
const mergeElement = byTypeName(mergePanels2.tree, 'MemoryMergeModal');
check(mergeElement !== undefined, 'M2 点了合并 → 弹出合并确认面板');

const merge = mount(mergeElement.type, mergeElement.props);
const mergeBox = checkboxIn(merge.tree);
check(mergeBox?.props?.checked === true, 'M3 合并弹窗的备份复选框默认勾选');
check(
  checkboxLabel(merge.tree, mergeBox) === zhPack.backupKeep,
  'M4 合并弹窗文案同样取自语言包',
  checkboxLabel(merge.tree, mergeBox),
);

script('api/session.open', { status: 'opened', sessionId: 'session-m', title: '带记忆的包' });
calls.length = 0;
findButton(merge.tree, zhPack.memoryMergeConfirm).props.onClick();
await tick();
const mergeUrl = lastCall('api/session.open');
check(
  paramsOf(mergeUrl).get('memory') === 'restore' && paramsOf(mergeUrl).get('backup') === '1',
  'M5 合并已有 + 勾备份 → memory=restore 且 backup=1',
  mergeUrl,
);

mergeBox.props.onChange({ target: { checked: false } });
merge.render();
script('api/session.open', { status: 'opened', sessionId: 'session-m', title: '带记忆的包' });
calls.length = 0;
findButton(merge.tree, zhPack.memoryMergeConfirm).props.onClick();
await tick();
check(paramsOf(lastCall('api/session.open')).get('backup') === '0', 'M6 勾掉备份后合并 → backup=0');

/* ───────────────────────── N. 文案完整性 ───────────────────────── */

check(typeof zhPack.backupKeep === 'string' && zhPack.backupKeep !== '', 'N1 zh-CN 有 backupKeep', zhPack.backupKeep);
check(
  typeof enPack.backupKeep === 'string' && enPack.backupKeep !== '' && enPack.backupKeep !== zhPack.backupKeep,
  'N2 en-US 有 backupKeep 且确实翻过（不是照抄中文）',
  enPack.backupKeep,
);

/* 注释里也会写 `L.xxx` 举例，那不是真引用：先剥掉注释再数。 */
const codeOnly = source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');
const referenced = new Set();
for (const chunk of codeOnly.split(/\bL\./)) {
  const match = /^([A-Za-z][A-Za-z0-9]*)/.exec(chunk);
  if (match !== null) referenced.add(match[1]);
}
const missingZh = [...referenced].filter((key) => !(key in zhPack));
const missingEn = [...referenced].filter((key) => !(key in enPack));
check(missingZh.length === 0, 'N3 client.js 里引用的每个 L.<key> 都在 zh-CN.json 里', missingZh.join(', ') || `${referenced.size} 个键`);
check(missingEn.length === 0, 'N4 同上，en-US.json 也齐全', missingEn.join(', ') || `${referenced.size} 个键`);

/* 兜底表是首屏文案：对象字面量里同名键后者覆盖前者，谁写重复了界面就突然换语言。 */
const zhStart = source.indexOf('const ZH = {');
const zhEnd = source.indexOf(String.fromCharCode(10) + '    };', zhStart);
check(zhStart > 0 && zhEnd > zhStart, 'N5 能在 client.js 里定位中文兜底表');
const zhText = source.slice(zhStart + 'const ZH = '.length, zhEnd + 6);
const ZH = new Function('return (' + zhText + ')')();

const keyLines = zhText
  .split(String.fromCharCode(10))
  .filter((line) => line.startsWith('      ') && line.includes(':') && line.trim() !== '}');
const keyNames = keyLines.map((line) => line.trim().split(':')[0]);
const counts = new Map();
for (const key of keyNames) counts.set(key, (counts.get(key) ?? 0) + 1);
const duplicated = [...counts].filter(([, times]) => times > 1).map(([key]) => key);
check(duplicated.length === 0, 'N6 中文兜底表没有重复键（重复会静默覆盖前一条）', duplicated.join(', ') || `${keyNames.length} 个键无重复`);

check(
  Object.keys(ZH).length === Object.keys(zhPack).length,
  'N7 兜底表与 zh-CN.json 键数一致（不靠重复键凑数）',
  `${Object.keys(ZH).length} vs ${Object.keys(zhPack).length}`,
);
check(
  ZH.backupKeep === zhPack.backupKeep,
  'N8 兜底表的 backupKeep 与 zh-CN.json 一致（首屏不能显示英文）',
  `${JSON.stringify(ZH.backupKeep)} vs ${JSON.stringify(zhPack.backupKeep)}`,
);

const backupMentions = source.split('L.backupKeep').length - 1;
check(backupMentions >= 3, 'N9 三个弹窗共用同一个 backupKeep 文案', `${backupMentions} 处`);

try {
  execFileSync(process.execPath, [path.join(repo, 'scripts', 'check-locales.mjs')], { stdio: 'pipe' });
  ok('N10 scripts/check-locales.mjs 通过（键集合与占位符）');
} catch (error) {
  bad('N10 scripts/check-locales.mjs 通过（键集合与占位符）', String(error?.stderr ?? error?.message ?? error).slice(0, 400));
}

console.log(`\n弹窗/文案：通过 ${passed} 条，失败 ${failed} 条`);
if (failed > 0) {
  console.error(`\n✗ backup-ui 自检失败：${failed} 条`);
  process.exit(1);
}
console.log('\n✅ backup-ui 自检通过');
