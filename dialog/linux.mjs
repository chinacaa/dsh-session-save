/**
 * dsh-session-save — Linux 原生对话框实现
 *
 * Linux 没有统一的标准面板，能用的只有桌面环境各自带的工具，所以要按优先级探测：
 *
 * 1. `zenity`  — GTK 那套（GNOME、Cinnamon、MATE、XFCE…），覆盖面最广
 * 2. `kdialog` — KDE Plasma
 * 3. `qarma` / `matedialog` — zenity 的兼容分支（有的发行版只装这些）
 *
 * 一个都没有就返回 `undefined`，让调用方走网页里的路径输入框 —— 这在本机是常态
 * （无头服务器、纯 SSH、装了 DSH 但没装桌面的容器），不是异常。
 *
 * 三家的命令行开关**名字不一样**，不能只探到二进制就按同一套参数调
 * （`--file` vs `--getopenfilename`、`--filename` vs `--getsavefilename`），
 * 所以下面为每种工具各留一份参数拼装。
 */
import { execFile } from 'node:child_process';
import { ensureExtension, lookPath, statIsExecutable } from './shared.mjs';

/** 一个对话框最多挂 10 分钟，和 Windows / macOS 侧对齐。 */
export const DIALOG_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * 候选工具与它们的参数形态。
 *
 * `family` 决定用哪套开关：GTK 系（zenity / qarma / matedialog）命令一致，
 * kdialog 自己一套。
 */
const CANDIDATES = [
  { bin: 'zenity', family: 'gtk' },
  { bin: 'qarma', family: 'gtk' },
  { bin: 'matedialog', family: 'gtk' },
  { bin: 'kdialog', family: 'kde' },
];

/**
 * 挑一个可用的对话框工具。找不到返回 `null`。
 *
 * 探测的是「存在且可执行」：只 stat 到文件不够，PATH 里偶尔会有无 x 位的残骸，
 * 那种情况 execFile 会 EACCES，不如在这里就判掉。
 */
export function pickLinuxTool(env = process.env, isExecutable = statIsExecutable) {
  for (const candidate of CANDIDATES) {
    const full = lookPath(candidate.bin, env, isExecutable);
    if (full !== null) return { ...candidate, path: full };
  }
  return null;
}

/**
 * 拼另存为的参数。
 *
 * 两家的语义差异要注意：
 * - zenity `--file-selection --save --confirm-overwrite`：返回用户敲的路径，
 *   **不会**替你补扩展名，也不检查目录存在。
 * - kdialog `--getsavefilename <起始路径> <过滤>`：起始参数是**完整建议路径**
 *   （不是目录），第二个参数是 `名称 (*.dsproj)` 形态的过滤器。
 */
export function buildSaveArgs(family, initial, suggestedName) {
  const start = typeof initial === 'string' && initial !== '' ? initial : suggestedName ?? '';
  if (family === 'kde') {
    return ['--title', '保存会话', '--getsavefilename', start, '会话工程 (*.dsproj)'];
  }
  const args = ['--file-selection', '--save', '--title', '保存会话', '--confirm-overwrite'];
  if (start !== '') {
    // zenity 的 --filename 收完整路径时，面板会把目录和文件名都预填好。
    args.push(`--filename=${start}`);
  }
  return args;
}

/** 拼打开的参数。kdialog 的第二个参数同样是过滤器，不是目录。 */
export function buildOpenArgs(family, initialDir) {
  const start = typeof initialDir === 'string' && initialDir !== '' ? initialDir : '';
  if (family === 'kde') {
    return ['--title', '打开会话工程', '--getopenfilename', start === '' ? '.' : start, '会话工程 (*.dsproj)'];
  }
  const args = ['--file-selection', '--title', '打开会话工程'];
  if (start !== '') args.push(`--filename=${start}/`);
  return args;
}

/**
 * 跑一个对话框工具，收敛成三个值：
 * - `undefined` — 没有可用工具 / 崩了 / 超时 → 调用方走路径输入框
 * - `null`      — 用户取消
 * - `string`    — 选中的绝对路径
 *
 * 取消的判定：zenity 取消时退出码 1 且 stdout 为空；kdialog 取消时退出码 1。
 * 两者都不会把「取消」和「出错」区分得很干净，所以用「退出码非 0 + stdout 为空」
 * 统一当取消，只有在**连工具都起不来**（ENOENT / EACCES / 超时）时才算 undefined。
 */
export function runLinuxDialog(tool, args) {
  return new Promise((resolve) => {
    execFile(
      tool.path,
      args,
      { timeout: DIALOG_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
      (error, stdout) => {
        const out = String(stdout ?? '').trim();
        if (error) {
          // 起不来的情形：二进制没了 / 没权限 / 超时。这才是「没有原生窗口」。
          const spawnFailed =
            error.code === 'ENOENT' ||
            error.code === 'EACCES' ||
            error.killed === true ||
            (error.signal !== undefined && error.signal !== null);
          if (spawnFailed) return resolve(undefined);
          // 其余非 0 退出码 + 空输出 = 用户取消。
          if (out === '') return resolve(null);
          return resolve(out);
        }
        if (out === '') return resolve(null);
        return resolve(out);
      },
    );
  });
}

/**
 * 另存为窗口。
 *
 * 补扩展名在这里做，和 macOS 侧一致：zenity / kdialog 都不自动补，
 * 不补的话「我的会话」会落成没后缀的文件。
 */
export async function saveDialog(initial, suggestedName) {
  const tool = pickLinuxTool();
  if (tool === null) return undefined;
  const picked = await runLinuxDialog(tool, buildSaveArgs(tool.family, initial, suggestedName));
  if (typeof picked !== 'string') return picked;
  return ensureExtension(picked, 'dsproj');
}

/** 打开窗口。 */
export async function openDialog(initial) {
  const tool = pickLinuxTool();
  if (tool === null) return undefined;
  return runLinuxDialog(tool, buildOpenArgs(tool.family, initial));
}
