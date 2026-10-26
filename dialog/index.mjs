/**
 * dsh-session-save — 原生对话框的**平台选择器**
 *
 * 这个文件是「平台依赖代码的隔离边界」：`index.js` 只 import 这里的两个函数，
 * 永远不知道底层是 PowerShell、是 osascript、还是 zenity。要加新平台只改这里
 * 加一个分支 + 一个新实现文件，`index.js` 一行不动。
 *
 * 契约（三个返回值必须分得清，调用方全靠它分支）：
 * - `undefined` — 这个平台没有可用实现 / 依赖缺失 → 调用方改走网页里的路径输入框
 * - `null`      — 用户取消
 * - `string`    — 选中的绝对路径
 *
 * 选择用的是**能力探测**而不是版本号：
 * - 不看 `os.release()` / `process.versions` —— 那要把每个版本对应的可用性写成矩阵。
 * - 只看「真正的那个二进制度在不在」。
 *
 * 为什么必须探测（而不是「平台对了就一定能用」）：
 * - Windows 缺 `powershell.exe` 是真实存在的：WinPE 里 PowerShell 是可选包
 *   （WinPE-PowerShell），Nano Server 2016 起移除了 Windows PowerShell，
 *   Windows IoT Core 能力受限。
 * - macOS 理论上都有 `/usr/bin/osascript`，但它是随系统语音/自动化组件走的，
 *   某些精简镜像或 CI 环境会缺。
 * - Linux 最不确定：zenity / kdialog 一个都没装才是常态（无头、容器、纯 SSH）。
 *   所以 Linux 的「探测」等于「找一个能用的 GUI 工具」。
 *
 * 探测失败不是错误路径，是设计内的降级 —— 客户端本来就有一套完整的手输路径 UI
 * （`status: 'need-path'`），功能不丢，只是多打几个字。
 */
import { lookPath, statIsExecutable, statIsFile } from './shared.mjs';

/** macOS 的 AppleScript 解释器位置固定；不搜 PATH 是因为它不属于用户可改的那类工具。 */
const OSASCRIPT = '/usr/bin/osascript';

/**
 * 探测某个平台的对话框实现是否可用。
 *
 * 返回值：
 * - 模块说明符（字符串）— 可以 `await import()` 它
 * - `null` — 该平台没有实现或依赖缺失，调用方回退到路径输入框
 *
 * 单独导出的目的：测试可以直接验选择逻辑，不需要真的弹出窗口。
 * `deps` 是为了让测试能注入假的环境与探测函数，跑在 Windows 上也能验 mac / linux 分支。
 */
export function pickDialogModule(platform = process.platform, env = process.env, deps = {}) {
  const isFile = deps.isFile ?? statIsFile;
  const isExecutable = deps.isExecutable ?? statIsExecutable;

  if (platform === 'win32') {
    const systemRoot = env.SystemRoot;
    if (systemRoot === undefined || systemRoot === '') {
      // 没有 SystemRoot 说明这个"Windows"环境不太正常（容器/极简 PE），
      // 裸命令名能不能解析到全凭运气，按不可用处理更诚实。
      return null;
    }
    const exe = `${systemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
    return isFile(exe) ? './windows.mjs' : null;
  }

  if (platform === 'darwin') {
    // osascript 存在即可用；它本身调的是 Cocoa 面板，不需要额外组件。
    return isExecutable(OSASCRIPT) ? './macos.mjs' : null;
  }

  if (platform === 'linux' || platform === 'freebsd' || platform === 'openbsd') {
    // Linux 上「探测」= 找到一个装了 GUI 的工具（zenity / kdialog / qarma / matedialog）。
    // 一个都没有（无头服务器、容器）就降级，这是最常见的情况，不是异常。
    // 探测逻辑在 linux.mjs 里，那里也导出了同样的候选表，避免两处各写一份。
    const found = deps.pickLinuxTool
      ? deps.pickLinuxTool(env, isExecutable)
      : lookPath('zenity', env, isExecutable) ??
        lookPath('kdialog', env, isExecutable) ??
        lookPath('qarma', env, isExecutable) ??
        lookPath('matedialog', env, isExecutable);
    return found === null || found === undefined ? null : './linux.mjs';
  }

  return null;
}

/** 按平台缓存实现模块，避免每次保存都重新探测文件系统。 */
const cache = new Map();

/**
 * 取当前平台的对话框实现；不可用返回 `null`。
 *
 * 返回对象形状：`{ save(initial): Promise<string|null|undefined>,
 *                   open(initial): Promise<string|null|undefined> }`
 *
 * 缓存键是 `platform`：一次进程只会有一个真实平台，但测试会带着假平台名进来，
 * 用一个全局变量缓存会把「非 Windows 不可用」的结论漏给后续的真实调用。
 */
export async function dialogBackend(platform = process.platform, env = process.env, deps = {}) {
  const hit = cache.get(platform);
  if (hit !== undefined) return hit;
  const specifier = pickDialogModule(platform, env, deps);
  if (specifier === null) {
    cache.set(platform, null);
    return null;
  }
  const mod = await import(specifier);
  const backend = {
    save: (initial) => mod.saveDialog(initial),
    open: (initial) => mod.openDialog(initial),
  };
  cache.set(platform, backend);
  return backend;
}

/** 另存为窗口。没有实现时返回 `undefined`，让调用方走路径输入框。 */
export async function saveDialog(initial) {
  const backend = await dialogBackend();
  if (backend === null) return undefined;
  return backend.save(initial);
}

/** 打开窗口。没有实现时返回 `undefined`。 */
export async function openDialog(initial) {
  const backend = await dialogBackend();
  if (backend === null) return undefined;
  return backend.open(initial);
}

/** 仅供测试：清掉模块缓存，让下一次调用重新探测。 */
export function resetDialogBackendCache() {
  cache.clear();
}
