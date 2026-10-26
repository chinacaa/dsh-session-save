/**
 * dsh-session-save — 非 Windows 实现共用的小工具
 *
 * 只放「macOS 与 Linux 都要、但和具体窗口系统无关」的东西。Windows 那条路走
 * WinForms，能力齐全，不需要这些，所以它不 import 本文件。
 */
import fs from 'node:fs';

/**
 * 在 `PATH` 里找一个可执行文件的位置，找不到返回 `null`。
 *
 * 不用 `which` / `command -v`：那要起一个子进程，还得处理 shell 差异（`sh` 没有
 * `command -v`、路径里有空格、Windows 的 `;` 分隔）。这里拼路径 + `statSync`，
 * 零副作用，而且探测逻辑可以被测试直接注入。
 *
 * 注意只搜 `PATH`：/usr/bin、/bin 本来就在 PATH 里；homebrew 的 /opt/homebrew/bin
 * 在 Apple Silicon 上也在。漏搜的风险远小于自己硬编码一堆目录。
 */
export function lookPath(bin, env = process.env, isFile = statIsFile) {
  const pathVar = env.PATH ?? env.Path ?? '';
  for (const dir of pathVar.split(':')) {
    if (dir === '') continue;
    const full = dir.endsWith('/') ? `${dir}${bin}` : `${dir}/${bin}`;
    if (isFile(full)) return full;
  }
  return null;
}

/** 默认的文件探测，抽成具名函数方便测试替换。 */
export function statIsFile(target) {
  try {
    return fs.statSync(target).isFile();
  } catch {
    return false;
  }
}

/** 默认的可执行探测：既要存在，也要有 x 位（不然 execFile 会 EACCES）。 */
export function statIsExecutable(target) {
  try {
    const st = fs.statSync(target);
    if (!st.isFile()) return false;
    fs.accessSync(target, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * 补默认扩展名。
 *
 * Windows 侧靠 WinForms 的 `AddExtension = true` 自动补；macOS 的 `choose file name`
 * 和 Linux 的 zenity / kdialog 都不补。在这里对齐规则，三种平台才会产出同样形态的
 * 文件名：用户只输 `我的会话`，落盘是 `我的会话.dsproj`。
 *
 * 已经有**任何**扩展名就原样放行 —— 用户写 `x.zip` 是他的自由，不硬掰成 `.dsproj`。
 */
export function ensureExtension(file, ext) {
  if (typeof file !== 'string' || file === '') return file;
  const base = file.slice(file.lastIndexOf('/') + 1);
  if (base.includes('.')) return file;
  return `${file}.${ext}`;
}

/**
 * macOS 的文件名**不能含** `:`（Finder 显示成 `/`，osascript 里更是路径分隔符）。
 * 用户在对话框里敲出冒号时，AppleScript 会直接把整条路径搞错，所以在进入 osascript
 * 之前先换掉，别让它一路错到写盘。
 */
export function sanitizeForAppleScript(file) {
  return file.replace(/:/g, '-');
}

/**
 * 把 `RESULT:<path>` 这一行拼出来。三平台共用的唯一输出格式契约。
 *
 * 路径里万一带换行（Linux 上合法），压成空格 —— 单行契约比保留怪字符重要，
 * 换行路径在网页输入框那条路上也一样过不了。
 */
export function resultLine(picked) {
  const value = picked ?? '';
  return `RESULT:${String(value).replace(/[\r\n]+/g, ' ')}`;
}
