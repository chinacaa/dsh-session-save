/**
 * 目录名派生回归：`projectKey()` / `encodeSegment()` 必须与 DSH 官方逐字一致。
 *
 * 为什么单独一套：
 *   这两个函数是「本机会话在哪」的唯一真相。差一个字符，`open` 就会去扫一个
 *   不存在的目录，表现为「本机没有这个会话」——不是崩溃，是**静默找不到**，
 *   日常用真实 cwd 根本撞不上，只有带尾部分隔符、根路径、emoji 的项目名才暴露。
 *
 * 判据来源：
 *   官方 `dsh-session-persistence-jsonl/lib/index.js` 的 `projectKey` / `encodeSegment`
 *   没有 export（该模块只导出 `Config, JsonlCompressionSchema, apply, name`），
 *   所以不能 import 来比。这里把官方实现**原样抄一份**当 oracle，逐档比对我们
 *   的实现；官方改算法时，更新下面的 oracle 与用例即可。
 *
 * 运行：node test/pathkey.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { encodeSegment, projectKey } from '../index.js';

let failed = 0;
const ok = (label, detail) => console.log(`✅ ${label}${detail === undefined ? '' : ` · ${detail}`}`);
const bad = (label, detail) => {
  failed += 1;
  console.error(`✗ ${label}${detail === undefined ? '' : ` · ${detail}`}`);
};
const check = (condition, label, detail) => (condition ? ok(label, detail) : bad(label, detail));

/* ── oracle：官方 rc.4 实现原文（逐字抄，不要「顺手优化」）────────────── */
function officialEncodeSegment(raw) {
  if (raw.length === 0) throw new Error('cannot encode an empty path segment');
  if (raw === '.') return '~002E';
  if (raw === '..') return '~002E~002E';
  let out = '';
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i);
    const ch = String.fromCharCode(code);
    if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) out += ch;
    else out += '~' + code.toString(16).toUpperCase().padStart(4, '0');
  }
  return out;
}

function officialProjectKey(cwd) {
  if (cwd.length === 0) throw new Error('cannot encode an empty project path');
  let readable = '';
  let separatorRun = false;
  for (let i = 0; i < cwd.length; i++) {
    const code = cwd.charCodeAt(i);
    const ch = String.fromCharCode(code);
    if (ch === '/' || ch === '\\' || ch === ':') {
      if (!separatorRun) readable += '-';
      separatorRun = true;
    } else if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
      readable += ch;
      separatorRun = false;
    } else {
      readable += '~' + code.toString(16).toUpperCase().padStart(4, '0');
      separatorRun = false;
    }
  }
  return `--${(readable.replace(/^-+/, '') || 'root').slice(0, 251)}--`;
}

/* ── 一、projectKey 与 oracle 逐档一致 ─────────────────────────────── */
{
  const cases = [
    ['普通工作区', 'C:\\Users\\aa\\workspace'],
    ['正斜杠风格', 'C:/Users/aa/workspace'],
    ['尾部分隔符（官方不剪，多一个 -）', 'C:\\x\\'],
    ['尾部正斜杠', '/home/aa/proj/'],
    ['根路径 /', '/'],
    ['drive root', 'C:\\'],
    ['纯 POSIX 根后的多级', '/usr/local/lib'],
    ['连续分隔符折叠成一个', 'C:\\\\a\\\\\\b'],
    ['UNC 风格', '\\\\server\\share\\dir'],
    ['含空格', 'C:\\Users\\aa\\my project'],
    ['含中文', 'C:\\Users\\aa\\项目\\抗旱'],
    ['含 emoji（增补平面，拆代理对）', 'C:\\Users\\aa\\a😀b'],
    ['含 ~ 转义', 'C:\\Users\\aa\\a~b'],
    ['含点与连字符', 'C:\\a.b-c\\d'],
    ['超长（251 截断）', 'C:\\' + 'x'.repeat(400)],
    ['分隔符后紧跟非 ASCII', 'C:\\项目\\'],
  ];
  for (const [label, cwd] of cases) {
    const mine = projectKey(cwd);
    const theirs = officialProjectKey(cwd);
    check(mine === theirs, `projectKey · ${label}`, mine === theirs ? mine : `mine=${mine} official=${theirs}`);
  }
}

/* ── 二、三个曾经踩过的具体形态（把结论钉死，不只依赖 oracle）────────── */
{
  check(projectKey('C:\\Users\\aa\\workspace') === '--C-Users-aa-workspace--', '真实工作区键固定', projectKey('C:\\Users\\aa\\workspace'));
  check(projectKey('/') === '--root--', '根路径兜底为 root', projectKey('/'));
  check(projectKey('C:\\x\\') === '--C-x---', '尾部分隔符贡献一个 -，不剪', projectKey('C:\\x\\'));
  check(
    projectKey('C:\\Users\\aa\\a😀b') === `--C-Users-aa-a~D83D~DE00b--`,
    'emoji 按 UTF-16 码元拆成两个转义',
    projectKey('C:\\Users\\aa\\a😀b'),
  );
}

/* ── 三、空 cwd：有意偏离（官方抛错，这里给 _no-cwd 供扫描回落）──────── */
{
  check(projectKey('') === '_no-cwd', '空 cwd 退回 _no-cwd 而不是抛错');
  check(projectKey(undefined) === '_no-cwd', 'undefined cwd 同样退回 _no-cwd');
  let threw = false;
  try {
    officialProjectKey('');
  } catch {
    threw = true;
  }
  check(threw, 'oracle 在空 cwd 上确实抛错（证明这是有意的偏离而非抄错）');
}

/* ── 四、encodeSegment 与 oracle 一致 ─────────────────────────────── */
{
  const ids = [
    'session-2d55467e-2bf3-4a3b-a641-32213de33c6b',
    '2d55467e-2bf3-4a3b-a641-32213de33c6b',
    '.',
    '..',
    'session-a~b',
    'session-😀',
    'session-a b',
    'a/b',
  ];
  for (const id of ids) {
    const mine = encodeSegment(id);
    const theirs = officialEncodeSegment(id);
    check(mine === theirs, `encodeSegment · ${id.slice(0, 24)}`, mine === theirs ? mine : `mine=${mine} official=${theirs}`);
  }
  check(encodeSegment('..') === '~002E~002E', '点点不落成目录穿越');
}

/* ── 五、真实会话目录（有就拿实例对一遍，没有不算失败）──────────────── */
{
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  const sessions = path.join(home, 'sessions');
  let dirs = [];
  try {
    dirs = fs.readdirSync(sessions, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    dirs = [];
  }
  if (dirs.length === 0) {
    ok('真实会话目录不存在，跳过实例核对（干净机器上正常）');
  } else {
    // 形如 `--C-Users-aa-workspace--`：去掉包裹后应能由某个 cwd 反推。
    // 这里只校验「本插件对工作区 cwd 算出来的键，若存在于磁盘上则形状一致」，
    // 避免把别人的历史目录当成断言对象。
    const sample = projectKey('C:\\Users\\aa\\workspace');
    const hit = dirs.includes(sample);
    ok('本机当前工作区键与磁盘对照', hit ? `${sample} 存在` : `${sample} 不在磁盘上（${dirs.length} 个目录）`);
    const shaped = dirs.filter((name) => !/^--.*--$/.test(name));
    check(shaped.length === 0, '磁盘上的项目目录都符合 --…-- 形状', shaped.slice(0, 5).join(','));
  }
}

if (failed > 0) {
  console.error(`\n✗ pathkey 自检失败：${failed} 条`);
  process.exit(1);
}
console.log('\n✅ pathkey 自检通过');
