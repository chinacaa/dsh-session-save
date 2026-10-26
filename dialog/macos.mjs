/**
 * dsh-session-save — macOS 原生对话框实现
 *
 * 用 `osascript`（AppleScript 的 CLI 外壳）拉 `choose file name` / `choose file`，
 * 也就是 Finder 那套标准面板。选它而不是装第三方包的理由：
 * - `osascript` 每个 macOS 都自带，零运行时依赖。
 * - 走的是 Cocoa 的 `NSSavePanel` / `NSOpenPanel`，iCloud Drive、标签、最近位置、
 *   沙箱授权全都免费拿到；自己画一个永远追不上。
 *
 * 编码约定：AppleScript 返回的是 UTF-8，`execFile` 默认也按 UTF-8 解，所以这里
 * **不需要** Windows 那套 `-ResultFile` 兜底。仍然保留 `RESULT:` 单行契约，
 * 让三个平台的解析路径完全一致。
 *
 * 取消的判定：用户点取消时 AppleScript 会抛 `-128`（User canceled）。
 * 这条错误码是稳定的老约定，比去比对错误文案可靠得多。
 */
import { execFile } from 'node:child_process';
import path from 'node:path';
import { ensureExtension, sanitizeForAppleScript } from './shared.mjs';

/** 一个对话框最多挂 10 分钟，和 Windows 侧对齐。 */
export const DIALOG_TIMEOUT_MS = 10 * 60 * 1000;

/** 用户取消时 osascript 的退出码固定是 1，stderr 里带 -128。 */
const CANCEL_CODE = '-128';

/**
 * 把用户给的初始路径拆成「目录 + 文件名」，供 AppleScript 预填。
 *
 * `default location` 要的是文件夹别名，`default name` 只要文件名，拆错了面板会
 * 打开到别的地方，所以单独抽出来测。
 */
export function splitInitial(initial) {
  if (typeof initial !== 'string' || initial === '') return { dir: '', name: '' };
  const dir = path.dirname(initial);
  const name = path.basename(initial);
  return {
    // dirname('x.dsproj') 会返回 '.'，那不是真目录，别当成 folder 传进去。
    dir: dir === '.' ? '' : dir,
    name,
  };
}

/**
 * 拼另存为的 AppleScript。
 *
 * 几个必须踩对的点：
 * - `default location` 收的是 **alias/文件对象**，字符串必须 `POSIX file` 包一层，
 *   否则 -1728（Can't get object）。
 * - 返回的是 file 对象，`POSIX path of` 才转成 `/Users/...` 形态，否则拼出来
 *   `Macintosh HD:Users:...`，Node 侧完全用不了。
 * - 字符串里的 `"` 和 `\` 要转义，否则用户路径里带个引号就把脚本截断了。
 */
export function buildSaveScript(initial) {
  const { dir, name } = splitInitial(sanitizeForAppleScript(initial ?? ''));
  const lines = ['tell application "System Events"', '  activate', 'end tell'];
  const parts = ['choose file name with prompt "保存会话"'];
  if (name !== '') parts.push(`default name ${quote(name)}`);
  if (dir !== '') parts.push(`default location (POSIX file ${quote(dir)})`);
  lines.push(`set target to ${parts.join(' ')}`);
  lines.push('return POSIX path of target');
  return lines.join('\n');
}

/** 拼打开会话工程的 AppleScript。`choose file` 直接返回别名，同样转 POSIX。 */
export function buildOpenScript() {
  return [
    'tell application "System Events"',
    '  activate',
    'end tell',
    'set target to choose file with prompt "打开会话工程" with invisibles',
    'return POSIX path of target',
  ].join('\n');
}

/** AppleScript 的双引号字符串字面量转义。 */
function quote(text) {
  return `"${String(text).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * 跑一段 AppleScript，把结果收敛成三个值：
 * - `undefined` — osascript 不可用 / 崩了 / 超时 → 调用方改走路径输入框
 * - `null`      — 用户取消（-128）
 * - `string`    — 选中的绝对路径
 *
 * 写成「不抛异常、用返回值表达失败」是刻意的：调用方在 HTTP 请求里 await 它，
 * 抛出来会变成 500，而降级到路径输入框才是产品上正确的行为。
 */
export function runAppleScript(script) {
  return new Promise((resolve) => {
    execFile(
      '/usr/bin/osascript',
      ['-e', script],
      { timeout: DIALOG_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
      (error, stdout, stderr) => {
        const out = String(stdout ?? '').trim();
        if (error) {
          // 取消是最常见的一种"错误"，别把它当失败。
          if (String(stderr ?? '').includes(CANCEL_CODE) || error.code === 1) {
            return resolve(out === '' ? null : out);
          }
          return resolve(undefined);
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
 * 补扩展名在这里做：macOS 的面板不会像 WinForms 那样自动补 `.dsproj`，
 * 不补的话用户输「我的会话」会落成一个没后缀的文件，与 Windows 侧产物不一致。
 */
export async function saveDialog(initial) {
  const picked = await runAppleScript(buildSaveScript(initial));
  if (typeof picked !== 'string') return picked;
  return ensureExtension(picked, 'dsproj');
}

/** 打开窗口。 */
export async function openDialog(initial) {
  void initial; // 打开面板不预填文件名，参数保留是为了和 Windows 签名一致。
  return runAppleScript(buildOpenScript());
}
