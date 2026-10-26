/**
 * dsh-session-save — Windows 原生对话框实现
 *
 * 用 Windows PowerShell 5.1（`powershell.exe`，Vista 起 in-box）拉起 WinForms 的
 * `SaveFileDialog` / `OpenFileDialog`，把用户选中的绝对路径带回 Node。
 *
 * 为什么是 PowerShell 而不是别的：
 * - `FileDialog._autoUpgradeEnabled` 默认 `True`，底层自动走 `IFileDialog`（Vista+
 *   的 COM 通用对话框）而不是老的 `GetSaveFileNameW`；系统版本差异已被 WinForms
 *   吞掉，这里不需要判 build number。
 * - `SaveFileDialog` 同时提供 `Filter` / `DefaultExt` / `OverwritePrompt` /
 *   `AddExtension` / `CheckPathExists`；DSH 侧的 directory-picker 只有 `pick()`，
 *   能力对不上。
 * - 零运行时依赖：`powershell.exe` 是系统组件，不需要 koffi 之类。
 *
 * 编码坑（务必别动）：Windows PowerShell 5.1 的 stdout 是**控制台代码页**（中文系统
 * 是 GBK），Node 按 UTF-8 解就把中文路径读成 `ÿ…`，文件会被存成乱码名。所以脚本
 * 把同一行按 UTF-8 无 BOM 写进 `-ResultFile`，这里优先读它，stdout 只当兜底。
 *
 * 本文件只在 Windows 上被 `dialog/index.mjs` 动态引入；非 Windows 平台根本加载不到它。
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
/** 脚本与本文件同目录，挪动目录时两者一起走，路径不会失配。 */
export const SAVE_PS1 = path.join(here, 'save-dialog.ps1');
export const OPEN_PS1 = path.join(here, 'open-dialog.ps1');

/** 一个对话框最多挂 10 分钟，之后按「拿不到窗口」处理。 */
export const DIALOG_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * 目标解释器：优先 `%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe`
 * （避开 PATH 里可能被塞的假货），拿不到 `SystemRoot` 才退回裸命令名。
 *
 * 注意是 **Windows PowerShell 5.1**，不是 `pwsh`：后者任何 Windows 都不自带，
 * 且带 WinForms 时冷启动更慢（5.1 的 WinForms 有 ngen 映像，7 要临时 JIT）。
 */
export function powerShellPath() {
  const systemRoot = process.env.SystemRoot;
  return systemRoot
    ? path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    : 'powershell.exe';
}

/**
 * 从结果文件 / stdout 里取出 `RESULT:<path>`。
 *
 * 三个返回值分得清，调用方全靠它分支：
 * - `undefined` — 拿不到窗口（脚本缺失、解释器缺失、超时），调用方改走网页里的路径输入框
 * - `null`      — 用户在窗口里点了取消
 * - `string`    — 选中的绝对路径
 */
export function readDialogResult(resultFile, stdout, error) {
  let raw = '';
  if (typeof resultFile === 'string' && resultFile !== '') {
    try {
      raw = fs.readFileSync(resultFile, 'utf8');
    } catch {
      raw = '';
    }
  }
  if (raw === '') raw = String(stdout ?? '');
  const line = raw.split(/\r?\n/).find((entry) => entry.startsWith('RESULT:'));
  if (line === undefined) return error ? undefined : null;
  const picked = line.slice('RESULT:'.length).trim();
  return picked === '' ? null : picked;
}

/**
 * 跑一个对话框脚本：`undefined` = 拿不到窗口，`null` = 用户取消，字符串 = 选中路径。
 * `-ResultFile` 是为了绕开 stdout 的控制台代码页，见 readDialogResult。
 */
export function runDialog(scriptPath, initial) {
  return new Promise((resolve) => {
    if (!fs.existsSync(scriptPath)) return resolve(undefined);
    const resultFile = path.join(
      os.tmpdir(),
      `dsh-session-save-dialog-${process.pid}-${Date.now()}.txt`,
    );
    try {
      fs.unlinkSync(resultFile);
    } catch {
      /* ignore */
    }
    execFile(
      powerShellPath(),
      [
        '-NoProfile',
        '-STA',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        scriptPath,
        '-Initial',
        initial ?? '',
        '-ResultFile',
        resultFile,
      ],
      { timeout: DIALOG_TIMEOUT_MS, windowsHide: false, maxBuffer: 1024 * 1024 },
      (error, stdout) => {
        const picked = readDialogResult(resultFile, stdout, error);
        try {
          fs.unlinkSync(resultFile);
        } catch {
          /* ignore */
        }
        resolve(picked);
      },
    );
  });
}

/** 另存为窗口。契约同 runDialog。 */
export function saveDialog(initial) {
  return runDialog(SAVE_PS1, initial);
}

/** 打开窗口。契约同 saveDialog。 */
export function openDialog(initial) {
  return runDialog(OPEN_PS1, initial ?? '');
}
