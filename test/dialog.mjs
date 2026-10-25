/**
 * 对话框编码自检：中文路径必须原样从 PowerShell 回到 Node。
 *
 * 背景：Windows PowerShell 5.1 的 stdout 是控制台代码页（中文系统 GBK），Node 按
 * UTF-8 读会把 `C:\...\会话标题.dsproj` 读成 `C:\...\������ÿ...`，于是文件被存成
 * 乱码名。修法两条：脚本里把 OutputEncoding 设成 UTF-8，并且把结果额外写进
 * `-ResultFile`（UTF-8 无 BOM），Node 优先读文件。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { readDialogResult, runDialog } from '../index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const pkg = path.resolve(here, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dshss-dialog-'));
const pass = (msg) => console.log(`✅ ${msg}`);

/** 写一个带 BOM 的 UTF-8 ps1，和正式脚本一样。 */
function writeScript(name, body) {
  const file = path.join(tmp, name);
  fs.writeFileSync(file, `\uFEFF${body}`, 'utf8');
  return file;
}

const CN = 'C:\\Users\\aa\\Desktop\\会话标题测试-20261025-1300.dsproj';

try {
  /* 1. 正式脚本：BOM + ResultFile + OutputEncoding 三件套 */
  for (const file of ['save-dialog.ps1', 'open-dialog.ps1']) {
    const full = path.join(pkg, file);
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
    assert.ok(text.includes("Write-Output $line"), `${file} 仍应打印 RESULT 行`);
  }
  pass('两个对话框脚本都带 BOM、UTF-8 stdout、-ResultFile 回写');

  /* 2. 走 ResultFile：中文原样回来（这是真正修掉乱码的路径） */
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
  const picked = await runDialog(viaFile, 'C:\\Users\\aa\\Desktop\\x.dsproj');
  assert.equal(picked, CN);
  pass(`中文路径经 ResultFile 原样回来 · ${picked}`);

  /* 3. 只有 stdout（老脚本那种）：OutputEncoding 也必须救回来 */
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
  const picked2 = await runDialog(viaStdout, '');
  assert.equal(picked2, CN);
  pass('没有 ResultFile 时，stdout 也已按 UTF-8 输出');

  /* 4. 反方向：Node 传进去的中文 -Initial 必须原样到 PowerShell */
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
  const echoed = await runDialog(echo, CN);
  assert.equal(echoed, CN);
  pass('传进去的中文 -Initial 原样到达 PowerShell');

  /* 5. 取消 → null；脚本不存在 → undefined */
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
  assert.equal(await runDialog(path.join(tmp, 'nope.ps1'), ''), undefined);
  pass('取消返回 null、脚本缺失返回 undefined');

  /* 5. readDialogResult：GBK 乱码的 stdout 不该盖掉 ResultFile 里的正确值 */
  const gbk = Buffer.from([0xb2, 0xe2, 0xca, 0xd4]); // GBK「测试」，按 UTF-8 读是乱码
  const mojibake = `RESULT:C:\\x\\${gbk.toString('utf8')}.dsproj`;
  const goodFile = path.join(tmp, 'result.txt');
  fs.writeFileSync(goodFile, `RESULT:${CN}`, 'utf8');
  assert.equal(readDialogResult(goodFile, mojibake, null), CN);
  assert.equal(readDialogResult('', mojibake, null), `C:\\x\\${gbk.toString('utf8')}.dsproj`);
  assert.equal(readDialogResult(path.join(tmp, 'missing.txt'), mojibake, null), `C:\\x\\${gbk.toString('utf8')}.dsproj`);
  assert.equal(readDialogResult('', '', new Error('spawn failed')), undefined);
  pass('结果文件优先于 stdout；两者都没有 RESULT 行时按 error 判定 undefined');

  console.log('✅ dialog 自检通过');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
