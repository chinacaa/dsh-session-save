/**
 * 对话框自检：平台选择器 + 三个平台的参数/脚本拼装 + 中文路径的 PowerShell 往返。
 *
 * 背景一（平台隔离）：`index.js` 只认识 `dialog/index.mjs` 的选择器。选择器按
 * 「依赖在不在」决定有没有原生窗口，判断错会导致 ENOENT 冒到用户点保存那一刻。
 *
 * 背景二（编码）：Windows PowerShell 5.1 的 stdout 是控制台代码页（中文系统 GBK），
 * Node 按 UTF-8 读会把 `C:\...\会话标题.dsproj` 读成 `C:\...\������ÿ...`，于是文件被存成
 * 乱码名。修法两条：脚本里把 OutputEncoding 设成 UTF-8，并且把结果额外写进
 * `-ResultFile`（UTF-8 无 BOM），Node 优先读文件。
 *
 * 背景三（跨平台）：macOS / Linux 那两条路在本机（Windows）无法真的弹窗，所以不测
 * 「窗口弹出来了吗」，只测**能被静态验证的部分**：探测逻辑（注入假的 PATH / 探测函数）、
 * 以及真正交给 osascript / zenity 的脚本与参数。参数拼错的话用户看到的是错的面板，
 * 那比报错更难查。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { dialogBackend, pickDialogModule, resetDialogBackendCache } from '../dialog/index.mjs';
import { readDialogResult, runDialog } from '../dialog/windows.mjs';
import {
  ensureExtension,
  lookPath,
  resultLine,
  sanitizeForAppleScript,
} from '../dialog/shared.mjs';
import { buildOpenScript, buildSaveScript, splitInitial } from '../dialog/macos.mjs';
import { buildOpenArgs, buildSaveArgs, pickLinuxTool } from '../dialog/linux.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const pkg = path.resolve(here, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dshss-dialog-'));
const pass = (msg) => console.log(`✅ ${msg}`);
const skip = (msg) => console.log(`⏭  跳过（本机没有 Windows PowerShell）：${msg}`);

/**
 * 真正要拉起 `powershell.exe` 的断言只在 Windows 上跑。
 *
 * 前面那批（选择器判据、AppleScript 文本、zenity/kdialog 参数、共用工具、脚本 BOM）
 * 都是纯静态校验，跨平台可跑；这几条要的是真实 PowerShell 的编码行为，别的平台上
 * 只能跳过——跳过要**显式打出来**，别静默当成通过。
 */
const IS_WIN = process.platform === 'win32';
async function needsPowerShell(msg, fn) {
  if (!IS_WIN) return skip(msg);
  await fn();
  pass(msg);
}

/** 写一个带 BOM 的 UTF-8 ps1，和正式脚本一样。 */
function writeScript(name, body) {
  const file = path.join(tmp, name);
  fs.writeFileSync(file, `\uFEFF${body}`, 'utf8');
  return file;
}

/** 造一套假的探测函数：`present` 里的路径才"存在"。 */
function fakeProbe(present, executable = present) {
  return {
    isFile: (target) => present.has(target),
    isExecutable: (target) => executable.has(target),
  };
}

const CN = 'C:\\Users\\aa\\Desktop\\会话标题测试-20261025-1300.dsproj';

try {
  /* 0. Windows 选择器：不看版本号，只看依赖在不在 */
  assert.equal(
    pickDialogModule('win32', { SystemRoot: '' }),
    null,
    '没有 SystemRoot 的"Windows"环境按不可用处理',
  );
  assert.equal(
    pickDialogModule('win32', { SystemRoot: 'C:\\Windows' }, fakeProbe(
      new Set(['C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe']),
    )),
    './windows.mjs',
    'powershell.exe 在 → 选出 windows 实现',
  );
  assert.equal(
    pickDialogModule('win32', { SystemRoot: 'C:\\NoSuchWindows' }),
    null,
    'powershell.exe 不在 → 回退到路径输入框，而不是等到点保存才炸',
  );
  pass('Windows 选择器：缺 SystemRoot / 缺解释器都回退，齐全时选出 windows.mjs');

  /* 0b. macOS 选择器：osascript 在不在 */
  assert.equal(
    pickDialogModule('darwin', {}, fakeProbe(new Set(['/usr/bin/osascript']))),
    './macos.mjs',
    'osascript 可执行 → 选出 macos 实现',
  );
  assert.equal(
    pickDialogModule('darwin', {}, fakeProbe(new Set())),
    null,
    '缺 osascript（精简镜像）→ 回退到路径输入框',
  );
  pass('macOS 选择器：有 osascript 用原生面板，没有就回退');

  /* 0c. Linux 选择器：等于"找一个装了 GUI 的工具"，一个都没有是常态 */
  const zenity = { bin: 'zenity', family: 'gtk', path: '/usr/bin/zenity' };
  assert.equal(
    pickDialogModule('linux', { PATH: '/usr/bin:/bin' }, {
      ...fakeProbe(new Set(['/usr/bin/zenity'])),
      pickLinuxTool: () => zenity,
    }),
    './linux.mjs',
    '找到 zenity → 选出 linux 实现',
  );
  assert.equal(
    pickDialogModule('linux', { PATH: '/usr/bin:/bin' }, {
      ...fakeProbe(new Set()),
      pickLinuxTool: () => null,
    }),
    null,
    'zenity / kdialog 全都没有（无头、容器）→ 回退到路径输入框',
  );
  assert.equal(
    pickDialogModule('freebsd', { PATH: '/usr/local/bin' }, {
      ...fakeProbe(new Set()),
      pickLinuxTool: () => ({ bin: 'zenity', family: 'gtk', path: '/usr/local/bin/zenity' }),
    }),
    './linux.mjs',
    'FreeBSD 复用 linux 实现（同样靠 zenity / kdialog）',
  );
  assert.equal(pickDialogModule('aix', {}, fakeProbe(new Set())), null, '没实现的平台 → null');
  pass('Linux / BSD 选择器：探到 GUI 工具才启用，探不到按设计降级');

  /* 0d. 缓存必须按平台分开：先问一个没有实现的平台，不能把结论漏给真实平台 */
  resetDialogBackendCache();
  assert.equal(await dialogBackend('darwin'), null, 'darwin 无 osascript → null');
  const realBackend = await dialogBackend();
  assert.notEqual(realBackend, null, '查过 darwin 之后，真实平台仍应拿到实现');
  assert.equal(typeof realBackend.save, 'function', '实现要有 save()');
  assert.equal(typeof realBackend.open, 'function', '实现要有 open()');
  resetDialogBackendCache();
  assert.equal(await dialogBackend('linux'), null, '重置后 linux 仍判定不可用');
  resetDialogBackendCache();
  const macBackend = await dialogBackend(
    'darwin',
    {},
    fakeProbe(new Set(['/usr/bin/osascript'])),
  );
  assert.equal(typeof macBackend?.save, 'function', '注入探测后 darwin 应拿到 macos 实现');
  resetDialogBackendCache();
  pass('缓存按平台隔离：无用平台的结论不会污染真实平台');

  /* 1. 共用小工具：PATH 搜索、扩展名补齐、AppleScript 消毒、RESULT 行契约 */
  assert.equal(
    lookPath('zenity', { PATH: '/usr/bin:/opt/bin' }, (t) => t === '/opt/bin/zenity'),
    '/opt/bin/zenity',
    'PATH 里按目录顺序找，找到即返回',
  );
  assert.equal(
    lookPath('zenity', { PATH: ':/usr/bin:' }, (t) => t === '/usr/bin/zenity'),
    '/usr/bin/zenity',
    'PATH 里的空段（前导/尾随冒号）被跳过，不会拼出 /zenity',
  );
  assert.equal(
    lookPath('zenity', { PATH: '/opt/' }, (t) => t === '/opt/zenity'),
    '/opt/zenity',
    '目录已带尾斜杠时不拼成 /opt//zenity',
  );
  assert.equal(lookPath('zenity', { PATH: '' }, () => true), null, 'PATH 为空 → null');
  assert.equal(lookPath('zenity', { Path: '/usr/bin' }, () => false), null, '没有 PATH 键 → null');

  assert.equal(ensureExtension('/a/我的会话', 'dsproj'), '/a/我的会话.dsproj', '没后缀 → 补 .dsproj');
  assert.equal(ensureExtension('/a/x.zip', 'dsproj'), '/a/x.zip', '已有后缀 → 原样放行');
  assert.equal(ensureExtension('/a/x.d/y', 'dsproj'), '/a/x.d/y.dsproj', '点只在目录名里 → 仍补后缀');
  assert.equal(ensureExtension('', 'dsproj'), '', '空串原样返回');

  assert.equal(sanitizeForAppleScript('/a/b:c'), '/a/b-c', '冒号会被 AppleScript 当分隔符 → 换掉');
  assert.equal(resultLine('/a/b'), 'RESULT:/a/b', 'RESULT 行格式');
  assert.equal(resultLine(null), 'RESULT:', '取消时是空 RESULT 行，不是缺行');
  assert.equal(resultLine('/a/b\nc'), 'RESULT:/a/b c', '换行压成空格，保住单行契约');
  pass('共用工具：PATH 搜索 / 扩展名 / 冒号消毒 / RESULT 单行契约');

  /* 2. macOS：AppleScript 文本（引号不转义就会把整条脚本截断） */
  assert.deepEqual(
    splitInitial('/Users/aa/Desktop/会话.dsproj'),
    { dir: '/Users/aa/Desktop', name: '会话.dsproj' },
    '拆成目录 + 文件名',
  );
  assert.deepEqual(splitInitial('x.dsproj'), { dir: '', name: 'x.dsproj' }, "dirname 返回 '.' 时不该当目录");
  assert.deepEqual(splitInitial(''), { dir: '', name: '' }, '空输入');

  const saveScript = buildSaveScript('/Users/aa/Desktop/会话.dsproj');
  assert.ok(saveScript.includes('choose file name'), '用的是 choose file name（另存为面板）');
  assert.ok(saveScript.includes('default name "会话.dsproj"'), '预填文件名');
  assert.ok(
    saveScript.includes('default location (POSIX file "/Users/aa/Desktop")'),
    'default location 必须是 POSIX file 包一层的别名，否则 -1728',
  );
  assert.ok(saveScript.includes('POSIX path of target'), 'file 对象要转成 /Users/... 形态');
  assert.ok(!saveScript.includes(':'), '冒号已消毒（AppleScript 里是路径分隔符）');

  // 引号出现在**文件名**里（splitInitial 之前不会被 dirname 切走），必须转义否则脚本被截断
  const quotedName = buildSaveScript('/tmp/he said "hi".dsproj');
  assert.ok(
    quotedName.includes('default name "he said \\"hi\\".dsproj"'),
    '文件名里的双引号被转义，脚本不被截断',
  );
  // 引号出现在**目录**里同样是转义点，且不能把两条字符串粘连
  const quotedDir = buildSaveScript('/tmp/a"/b.dsproj');
  assert.ok(
    quotedDir.includes('POSIX file "/tmp/a\\""'),
    '目录里的双引号也被转义',
  );
  assert.ok(!buildSaveScript('').includes('default location'), '没有目录时不传 default location');
  assert.ok(buildOpenScript().includes('choose file'), '打开用 choose file（选择已有文件）');
  pass('macOS：AppleScript 文本正确（POSIX file / 转义 / 冒号消毒）');

  /* 3. Linux：zenity 与 kdialog 的开关完全不是一套，必须分开拼 */
  const gtkSave = buildSaveArgs('gtk', '/home/aa/会话.dsproj');
  assert.deepEqual(
    gtkSave,
    ['--file-selection', '--save', '--title', '保存会话', '--confirm-overwrite', '--filename=/home/aa/会话.dsproj'],
    'zenity 另存为：--file-selection --save + --filename 预填完整路径',
  );
  assert.deepEqual(
    buildSaveArgs('gtk', ''),
    ['--file-selection', '--save', '--title', '保存会话', '--confirm-overwrite'],
    '没有建议路径时不给 --filename',
  );
  assert.deepEqual(
    buildSaveArgs('kde', '/home/aa/会话.dsproj'),
    ['--title', '保存会话', '--getsavefilename', '/home/aa/会话.dsproj', '会话工程 (*.dsproj)'],
    'kdialog 另存为：--getsavefilename 收完整建议路径 + 过滤器',
  );

  const gtkOpen = buildOpenArgs('gtk', '/home/aa');
  assert.deepEqual(
    gtkOpen,
    ['--file-selection', '--title', '打开会话工程', '--filename=/home/aa/'],
    'zenity 打开：--filename 要以斜杠结尾才是目录',
  );
  assert.deepEqual(
    buildOpenArgs('kde', '/home/aa'),
    ['--title', '打开会话工程', '--getopenfilename', '/home/aa', '会话工程 (*.dsproj)'],
    'kdialog 打开：--getopenfilename 收目录 + 过滤器',
  );
  assert.deepEqual(
    buildOpenArgs('kde', ''),
    ['--title', '打开会话工程', '--getopenfilename', '.', '会话工程 (*.dsproj)'],
    'kdialog 不给目录时用 . 而不是空串（空串会让它报错）',
  );
  pass('Linux：zenity 与 kdialog 两套开关各自拼对');

  /* 4. Linux 工具探测的优先级：zenity 优先，其次 kdialog，一个都没有返回 null */
  const onlyKde = pickLinuxTool({ PATH: '/usr/bin' }, (t) => t === '/usr/bin/kdialog');
  assert.equal(onlyKde?.family, 'kde', '只有 kdialog 时装它也认');
  assert.equal(onlyKde?.path, '/usr/bin/kdialog', '返回的是绝对路径，不是裸名字');
  const both = pickLinuxTool({ PATH: '/usr/bin' }, () => true);
  assert.equal(both?.bin, 'zenity', 'zenity 与 kdialog 都在时优先 zenity（GTK 覆盖面更广）');
  assert.equal(pickLinuxTool({ PATH: '/usr/bin' }, () => false), null, '一个都没有 → null');
  pass('Linux 工具探测：zenity > kdialog，一个都没有返回 null');

  /* 5. 正式 Windows 脚本：BOM + ResultFile + OutputEncoding 三件套 */
  for (const file of ['save-dialog.ps1', 'open-dialog.ps1']) {
    const full = path.join(pkg, 'dialog', file);
    const bytes = fs.readFileSync(full);
    assert.equal(bytes[0], 0xef, `${file} 应有 UTF-8 BOM`);
    assert.equal(bytes[1], 0xbb, `${file} BOM 第二字节`);
    assert.equal(bytes[2], 0xbf, `${file} BOM 第三字节`);
    const text = bytes.toString('utf8');
    assert.ok(text.includes('$ResultFile'), `${file} 应支持 -ResultFile`);
    assert.ok(
      text.includes('[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)'),
      `${file} 应把 stdout 改成 UTF-8`,
    );
    assert.ok(text.includes('Write-Output $line'), `${file} 仍应打印 RESULT 行`);
  }
  pass('两个对话框脚本都带 BOM、UTF-8 stdout、-ResultFile 回写');

  /* 6. 走 ResultFile：中文原样回来（这是真正修掉乱码的路径） */
  await needsPowerShell('中文路径经 ResultFile 原样回来', async () => {
    const viaFile = writeScript(
      'stub-file.ps1',
      [
        'param([string]$Initial = "", [string]$Filter = "", [string]$ResultFile = "")',
        "$ErrorActionPreference = 'Stop'",
        'try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch { }',
        `$line = 'RESULT:${CN.replace(/'/g, "''")}'`,
        'if ($ResultFile -ne "") { [System.IO.File]::WriteAllText($ResultFile, $line, (New-Object System.Text.UTF8Encoding($false))) }',
        'Write-Output $line',
        '',
      ].join('\n'),
    );
    assert.equal(await runDialog(viaFile, 'C:\\Users\\aa\\Desktop\\x.dsproj'), CN);
  });

  /* 7. 只有 stdout（老脚本那种）：OutputEncoding 也必须救回来 */
  await needsPowerShell('没有 ResultFile 时，stdout 也已按 UTF-8 输出', async () => {
    const viaStdout = writeScript(
      'stub-stdout.ps1',
      [
        'param([string]$Initial = "", [string]$Filter = "", [string]$ResultFile = "")',
        "$ErrorActionPreference = 'Stop'",
        'try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch { }',
        `Write-Output ('RESULT:${CN.replace(/'/g, "''")}')`,
        '',
      ].join('\n'),
    );
    assert.equal(await runDialog(viaStdout, ''), CN);
  });

  /* 8. 反方向：Node 传进去的中文 -Initial 必须原样到 PowerShell */
  await needsPowerShell('传进去的中文 -Initial 原样到达 PowerShell', async () => {
    const echo = writeScript(
      'stub-echo.ps1',
      [
        'param([string]$Initial = "", [string]$Filter = "", [string]$ResultFile = "")',
        'try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch { }',
        '$line = "RESULT:" + $Initial',
        'if ($ResultFile -ne "") { [System.IO.File]::WriteAllText($ResultFile, $line, (New-Object System.Text.UTF8Encoding($false))) }',
        'Write-Output $line',
        '',
      ].join('\n'),
    );
    assert.equal(await runDialog(echo, CN), CN);
  });

  /* 9a. 脚本不存在 → undefined（在 spawn 之前就返回，跨平台可验） */
  assert.equal(await runDialog(path.join(tmp, 'nope.ps1'), ''), undefined);
  pass('脚本缺失直接返回 undefined，不会去 spawn 解释器');

  /* 9b. 取消 → null（要真实 PowerShell 才跑得出 RESULT: 空行） */
  await needsPowerShell('取消返回 null', async () => {
    const cancel = writeScript(
      'stub-cancel.ps1',
      [
        'param([string]$Initial = "", [string]$Filter = "", [string]$ResultFile = "")',
        "$line = 'RESULT:'",
        'if ($ResultFile -ne "") { [System.IO.File]::WriteAllText($ResultFile, $line, (New-Object System.Text.UTF8Encoding($false))) }',
        'Write-Output $line',
        '',
      ].join('\n'),
    );
    assert.equal(await runDialog(cancel, ''), null);
  });

  /* 10. readDialogResult：GBK 乱码的 stdout 不该盖掉 ResultFile 里的正确值 */
  const gbk = Buffer.from([0xb2, 0xe2, 0xca, 0xd4]); // GBK「测试」，按 UTF-8 读是乱码
  const mojibake = `RESULT:C:\\x\\${gbk.toString('utf8')}.dsproj`;
  const goodFile = path.join(tmp, 'result.txt');
  fs.writeFileSync(goodFile, `RESULT:${CN}`, 'utf8');
  assert.equal(readDialogResult(goodFile, mojibake, null), CN);
  assert.equal(readDialogResult('', mojibake, null), `C:\\x\\${gbk.toString('utf8')}.dsproj`);
  assert.equal(
    readDialogResult(path.join(tmp, 'missing.txt'), mojibake, null),
    `C:\\x\\${gbk.toString('utf8')}.dsproj`,
  );
  assert.equal(readDialogResult('', '', new Error('spawn failed')), undefined);
  pass('结果文件优先于 stdout；两者都没有 RESULT 行时按 error 判定 undefined');

  console.log('✅ dialog 自检通过');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
