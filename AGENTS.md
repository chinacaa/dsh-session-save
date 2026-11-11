# AGENTS.md

给在这个仓库里干活的 AI/人类协作者的说明书。**先读完「红线」再动手**，那里每一条都是踩过的坑。

## 这是什么

一个 DSH（DeepSeek Harness）插件：把当前会话另存为单个 `.dsproj` 工程文件，也能反过来从 `.dsproj` 打开会话并切过去。产物与 `dshproj` 命令行工具双向兼容（同一套 `dshproj/1` 包格式）。

- 语言/运行时：纯 ESM（`"type": "module"`），零运行时依赖，只用 `node:` 内置模块；客户端只 `require('react')`。
- 宿主：DSH `>=0.2.1-rc.1 <0.3.0-0`（`engines.dsh`），Cordis `^4.0.1`（peer）。
- 平台：Windows 优先（原生对话框走 `powershell.exe` + WinForms）；macOS 走 `osascript` 的 Finder 面板；Linux/BSD 探 zenity / kdialog / qarma / matedialog。三者都没有时退回网页里的路径输入框。平台相关代码全部隔离在 `dialog/` 下（`index.mjs` 选实现、`shared.mjs` 共用工具、`windows.mjs` / `macos.mjs` / `linux.mjs` 各平台实现），`index.js` 只 import `dialog/index.mjs`，不认识具体实现。
- 规模：`index.js` ≈3730 行、`client.js` ≈2570 行、二十二套测试共 682 条 ✅（`smoke.mjs` 另有 12 处 throw 检查，只打一行汇总）。逐条覆盖见 `docs/TEST-MATRIX.md`。

## 红线（改之前先看，违反会静默坏掉）

1. **别用 profile 的 `cordis.patch.yml` 装本插件**。那份文件只用于「覆盖已有 id」；新增插件必须靠包内 `cordis.patch.yml` + `package.json` 的 `dsh.bundle.patch` + profile `package.json` 里 `dsh.profile.bundles` 追加包名。只往 profile patch 里加 `- id/name` 行 → 路由 404 且没有任何日志。
2. **别手改 `package.json` 的 `version`**。用 `node scripts/bump.mjs`，它同时更新 `CHANGELOG.md`。
3. **别再往侧栏塞 DOM 注入的按钮**。侧栏「工作区」标题行是硬编码（`sectionLabel` + `searchButton` + `headerActions`，类名还是 hashed 的），没有插槽。本插件只挂官方插槽：标题栏 `conversation.session.header.utilities` + 空会话页 `conversation.hero.options`。
4. **改会话日志只许重写第 0 帧**。会话文件是「多个 zstd 帧拼接」，第 0 帧是 header；改 `cwd`/`id` 后必须把帧 1..n 原字节照搬，不能整体解压再压回去。
5. **`client.js` 里不许出现 `document.`、`MutationObserver`、全局 `<style>`、除 react 之外的依赖**。`test/client.mjs` 里有反向断言，写了就红。图标一律内联 SVG（`stroke="currentColor"`），颜色用主题 token。
6. **`.ps1` 必须是带 BOM 的 UTF-8**，否则 PowerShell 5.1 按 ANSI 解析直接 `Missing closing '}'`（而 pwsh 7 的 AST 校验却能通过，别拿它当证据）。中文路径**必须走 `-ResultFile`**：PS 5.1 的 stdout 是控制台代码页（中文系统 `gb2312`），Node 按 UTF-8 读会把中文读成 `ÿ…`，然后按乱码名写盘。
7. **测试不许读写真实的 `~/.dsh`**。一律 `makeFixture()` 建临时 `DSH_HOME`（`os.tmpdir()` 下），`autoCleanup(fx)` 兜住正常退出/异常/^C 三种收尾。早期那套「跑前跑后对比 `sessions/` 目录集合、改过 `storages/session-save.json` 手工删键」的做法已经废弃——它本身就是「换台机器必红」的根源。要断言状态文件，就断言夹具里那份。
8. **不要 commit `*.dsproj`**（`.gitignore` 已挡）。测试产物一律写 `os.tmpdir()`。
9. **不要主动 commit / push**，除非用户明说。
10. **不要把安全校验删掉或放宽**。包是「可能来自敌人」：条目名必须过 `safeSegments`（`\` 也算分隔符）、落点必须过 `isInside`、`inflateRawSync` 必须带 `maxOutputLength`、四条 `/api` 路由必须过 `requestGate`（拿不到 `headers` 时默认拒绝，别为单测放开）、`manifest.parts` 必须复核。另外 **`manifest.parts` 必须覆盖所有内容条目**（`session/`、`memory/workspaces/`）：只复核「声明过的」等于给未声明条目开后门，可以夹带 `MEMORY.md` 投毒项目笔记；包里带记忆条目但整个 `parts` 缺失的同样拒绝。**还有一层：默认的 copy 模式下落盘永不用原名**，一律 `xxx.from-dsproj-<日期>`——`parts` 的 sha256 是打包方自算的，自洽的包照样能过前面所有检查，所以「会不会被 DSH 当记忆读」只能靠改名来断（`restore` / `new` 是用户显式选的例外，见本行后半段）。`test/security.mjs` 会盯这些，改坏了立刻红。**`memory=restore`（界面上的「合并记忆」）只改落点，不放宽任何校验**：它照样过 `safeSegments` / `safeJoin` / `ENTRY_ALLOW` / `manifest.parts`，覆盖前先备份成 `xxx.bak-<时间>`；restore 只能由用户显式触发，**绝不许用包里的 `exportedBy`、hostname、`parts` 自洽之类字段判断「这个包可信」**——那些都是打包方自己写的。**`memory=restore` 只许覆盖本机已存在的文件，本机没有的一律不写**（计入 `memoryCreated`，不是 `memoryConflicts`）；用户显式选「合并并新建」才走 `memory=new`。理由：restore 若连新文件也建，一份投毒包在「本机没有该文件」时就能零确认地把 `MEMORY.md` 落到记忆目录，而 `MEMORY.md`、最近两天的日期日志、`handoff/*.md` 全在 DSH 的记忆读取面内——等于绕过 R4 的改名防护。本机没有的一律不写、也不建目录（计入 `memoryCreated` 交给界面）；`xxx.from-dsproj-<日期>` 副本只出现在 **copy 模式**（默认打开方式），restore 与 `new` 都不产生副本。**附件回填同理**：`attachments/` 条目不许享受 `RATIO_FLOOR_BYTES` 那档豁免（那档只给非附件用——附件是已压缩二进制，合法包接近 1:1，给了豁免等于让 3 MiB 全零缓冲把配额撑满，实测 935× 放大），且一次导入受 `MAX_ATTACH_FILES` / `MAX_ATTACH_TOTAL_BYTES` 双配额约束，超出的计入 `attachmentsRejected` **并且必须显示给用户**——DSH 的附件对象库没有 GC，写进去就永远躺着。**帧解压同理**：六处 zstd 解压必须走 `decompressFrame`（带 `maxOutputLength`），直接调 `zlib.zstdDecompressSync` 会绕过单帧上限——zip 那层只管「DEFLATE 解出多少」，帧里再套一层就能绕（实测 29 KB 的包解出 900 MB、RSS +937 MB）。超限的 `ERR_BUFFER_TOO_LARGE` **不许**被 `catch` 成「这帧坏了、跳过」，那等于让炸弹包被静默当成空会话打开；打包（`decodeLogText`）、体检（`repairSession`）与上下文估算/裁剪（`estimateContext` / `trimSession`）这四条全解路径还要累计总量到 `MAX_TOTAL_BYTES`，超限抛 `E_LOG_TOO_LARGE`——那是「包太大」，不是「这帧坏了」。
11. **默认不打包 `~/.dsh/memory`**（里面有用户的项目笔记、日志和白板）。要带必须显式 `?memory=1`（界面上是 <kbd>Alt</kbd> 点击）。

## 目录

```
index.js            Host 半：四条 HTTP 路由 + 打包/导入 + 锁 + CAS
client.js           Client 半：5 个插槽项 + 各模态 + 内联图标
cordis.patch.yml    bundle 补丁层（insert id=session-save）
dialog/index.mjs    平台选择器：探测当前平台有没有原生窗口实现（不看版本号）
dialog/shared.mjs   三平台共用：lookPath / ensureExtension / 结果行契约
dialog/windows.mjs  Windows 实现：拉 PowerShell 5.1 + WinForms 对话框
dialog/macos.mjs    macOS 实现：osascript 的 choose file name / choose file
dialog/linux.mjs    Linux/BSD 实现：zenity → kdialog → qarma → matedialog
dialog/save-dialog.ps1  原生「保存会话」对话框（WinForms SaveFileDialog）
dialog/open-dialog.ps1  原生「打开会话工程」对话框（WinForms OpenFileDialog）
marketplace/        上架条目（提 PR 到 awesome-dsh-plugin 用）
scripts/bump.mjs    改版本（package.json + CHANGELOG）
scripts/release-notes.mjs 从 CHANGELOG 摘某版本正文当 Release 说明
scripts/set-repo.mjs 把 OWNER 占位换成真实 GitHub 名字
test/fixture.mjs    临时 DSH_HOME 夹具（二十二套测试共用）
test/*.mjs          二十二套自检（见「测试」）
locales/*.json      界面语言包（zh-CN 为源语言，118 键；新文案先加这里）
docs/TEST-MATRIX.md 功能面 → 测试覆盖矩阵（84 条 F 编号）
docs/DSH-API-SURFACE.md 用到的 DSH 接口清单（升级 DSH 时逐条核对）
assets/             截图与方形图标（市场用）
```

## 命令

```bash
node test/client.mjs      # 客户端接线：5 个插槽项、图标指纹、点击打到的路由
node test/dialog.mjs      # 三平台原生窗口：选择器判据、缓存隔离、三套参数拼装、中文路径往返
node test/smoke.mjs       # Host 冒烟：夹具会话 → 打包 → 回读 ZIP → 二次保存复用路径
node test/open.mjs        # 打开链路：复用 / 换 cwd 落地 / need-workspace / 逐帧比对
node test/conflict.mjs    # 锁、四种冲突、CAS、自动保存（约 30 秒，含 2.6 秒等待）
node test/security.mjs    # 安全回归：条目名穿越 / 落点文件名 / 解压炸弹 / 路由闸 / parts 校验
node test/pathkey.mjs     # 路径键：projectKey / encodeSegment 与官方实现逐字对齐（含分隔符、emoji、根路径边界）
node test/attach.mjs      # 附件：引用提取、随包带走、缺失记账、导入回填与幂等、篡改条目拒绝
node test/repair.mjs      # 体检自愈：断链换占位、缺尺寸按文件头补、坏行坏帧、两种 image 形状
node test/open-repair.mjs # 端到端体检：打包带断链图 → 打开时自愈 → 再打开幂等
node test/version.mjs     # 包比插件新：说「升级」而不是「包坏了」
node test/context.mjs     # 导入时的上下文预算：估算、裁剪、turn 完整性与重排
node test/roundtrip.mjs   # 往返保真 + 附件回填 + 四个覆盖点的 backup=0/1
node test/backup-ui.mjs   # 三个弹窗的备份勾选回调 + 文案完整性
node test/audit-r1.mjs   # 审计第 1 轮：RLE 帧、覆盖率闸、0 字节残留、ADS/设备名、保存不建目录、relocate 的 bili
node test/audit-r4.mjs   # 审计第 4 轮：累计解压上限、末帧截断、状态提交时机、isInside 解链接、跨工区记忆

node --check index.js client.js            # 语法
node scripts/bump.mjs patch --dry          # 版本号预演
node scripts/set-repo.mjs <owner>          # 填掉 OWNER 占位

pwsh -c "foreach($f in 'dialog/save-dialog.ps1','dialog/open-dialog.ps1'){$t=$null;$e=$null;[void][System.Management.Automation.Language.Parser]::ParseFile((Resolve-Path $f).Path,[ref]$t,[ref]$e);\"$f => $($e.Count)\"}"
```

本地装载（改完必须重启 DSH，bundle 只在启动时组合）：

```powershell
New-Item -ItemType Junction -Path "$env:USERPROFILE\.dsh\profiles\web\node_modules\dsh-session-save" -Target "<本仓库绝对路径>"
# profile 的 package.json：dependencies 加 "dsh-session-save": "link:<本仓库绝对路径>"
# profile 的 package.json：dsh.profile.bundles 追加 "dsh-session-save"
```

新建 junction 用 PowerShell 的 `New-Item -ItemType Junction`；bash 里 `cmd //c mklink /J` 会被参数转换搞坏（`Invalid switch`）。

## 架构

**Host（`index.js`，`inject = ['connection']`）** 注册四条路由，全部 `methods: ['GET','POST']`、`requestBody: 'buffered'`：

| 路由 | 作用 |
| --- | --- |
| `/api/session.save` | 打包当前会话写到路径；不带 path 时拉原生另存为（会挂住 HTTP 直到有人点窗口） |
| `/api/session.open` | 读一个 `.dsproj`，导入成本机会话并返回 `sessionId` 与体检报告 `repair` |
| `/api/session.autosave` | 查/开关某个会话的自动保存 |
| `/api/session.workspaces` | 列 `workspace.json` 里登记的工作区（打开时选落点用） |

数据路径规则（**两套 slug，别混**）：

- 会话：`$DSH_HOME/sessions/<projectKey(cwd)>/<encodeSegment(id)>/session.v4.jsonl.zstd`。
- 记忆：`$DSH_HOME/memory/workspaces/--C--Users-aa-workspace--` 这种，**每个**分隔符各变一个 `-`。所以记忆目录**只做精确匹配**（`resolveMemoryDir` 依次试两级精确候选，找不到就返回 `undefined` 另建新目录）。**别加"归一化后相等"的模糊匹配**：它会抹平大小写、`-`、尾分隔符，`ws` 与 `ws\` 就命中同一个记忆目录，`memory=restore` 下去就是跨工作区覆盖 `MEMORY.md`（AUDIT-0.3.0 的 M3）；路径相等只认 `path.resolve` 后逐段比。

`projectKey` / `encodeSegment` 是**照 DSH 官方实现逐字复刻**的（`dsh-session-persistence-jsonl/lib/index.js` 的 `projectKey` / `encodeSegment`，rc.4 在 855–905 行），不是自己设计的规则。三个「看起来像 bug、其实必须这样」的细节，**别顺手"优化"掉**：

| 细节 | 官方行为 | 改错会怎样 |
| --- | --- | --- |
| 尾部分隔符 | 连续分隔符折叠成**一个** `-`，且**不剪掉尾部**——`C:\x\` → `--C-x---`（尾部贡献一个 `-`，外加包裹的两条） | 少一个 `-` 就指到不存在的目录 → 表现成「本机没有这个会话」 |
| 根路径 | 剥掉前导 `-` 后若为空，兜底 `root`——`/` → `--root--` | 得到 `----`，`/` 下的会话永远找不到 |
| 转义单位 | 按 **UTF-16 码元**（`charCodeAt`）逐位转义，不是码点——`😀` → `~D83D~DE00` | 用 `codePointAt` 得到 `~1F600`，emoji 路径的会话全部定位失败 |

另一处**有意偏离**：`cwd` 为空串时官方 `projectKey` 抛错，这里返回 `_no-cwd`（即官方 `projectDir(root, undefined)` 的目录名）。因为本函数的使用方都是「找到就返回、找不到给 undefined」的查找逻辑，抛错会中断整轮扫描。改这条前先看 `test/pathkey.mjs` 里那条「oracle 确实抛错」的对照用例。

判据由 `test/pathkey.mjs` 盯着：它内置一份官方实现的原样副本当 oracle，逐档比对本仓库的实现。**官方算法若在未来的 DSH 里变了，这个测试不会自己发现**——升级 DSH 后要人工重抄一次 oracle（从上面那个文件的对应函数原样复制，连注释一起），再跑一遍；这是「官方函数不可 import」（该包只导出 `Config, JsonlCompressionSchema, apply, name`）下能做到的最强验证。

`importPackage` 的判定顺序（别调换）：

1. 本机没有这个 id 且没给 `cwd` → `status: 'need-workspace'`（客户端弹工作区选择）。
2. 同 id + 同 `createdAt` + 同 `cwd` → 复用现有文件，不写盘。
3. 同 id + 同 `createdAt` + 不同 `cwd` → **relocate**：换新 `session-<uuid>` id 落地（id 必须全机唯一）。
4. 同 id + 不同 `createdAt` → 真冲突，按 `onConflict` 走 `ask`（409）/`reuse`/`overwrite`（先 `.bak-<ts>`）/`copy`。

写盘的三重保护：`${file}.lock` 侧车 `wx` 独占 → 包内 `LOCK.json`（`host`/`pid`/`at`/`writes`，异机按 15 分钟判活）→ 内容 sha256 CAS（不符时手动保存 409 `status:'stale'`，自动保存**自行关闭**并记进 `stale`）。落盘用 `writeAtomic`（tmp + rename），避免同步盘抓到半个包。

状态文件 `$DSH_HOME/storages/session-save.json`：`{ paths, lastDir, autosave, stamps, stale, missing }`，按 `sessionId` 索引，形状变了要进 CHANGELOG 并考虑升 MINOR。

**Client（`client.js`）** 用 `window.__ModuleLoader__.load({ id:'dsh-session-save', factory(require){...} })`，`exports.inject = ['slots','sessions','uiWorkspace','remote','remote.session']`（点路径表示「取子服务」，官方 `dsh-client-ui-open-in-app` 同写法），注册 5 项：

```
conversation.session.header.utilities   session-open@39  session-save@40  session-autosave@41  session-save-as@42
conversation.hero.options               session-open-hero@41
```

打开流程：`api/session.open` → `need-workspace` 弹工作区面板 → `conflict` 弹四选一面板 → `opened` 时 `sessions.refresh?.()` 再 `uiWorkspace.openSession?.(id)`（两步都可选调用，纯 TUI 没有 `uiWorkspace` 时只导入不跳转）。

## 测试怎么写

**一条判据：测试不许依赖本机真实状态。** 早期的 `smoke.mjs` / `open.mjs` 直接读 `~/.dsh/sessions` 里"恰好存在"的会话，换台机器或清过数据就红。现在统一走 `test/fixture.mjs`：

```js
import { autoCleanup, loadRoutes, makeFixture } from './fixture.mjs';
const fx = makeFixture();   // 在 os.tmpdir() 下建 dshss-fx-XXXX：sessions/ + memory/ + storages/
autoCleanup(fx);            // 正常退出/异常/^C 都会删掉
const { mod, routes } = await loadRoutes('../index.js');   // 必须在 makeFixture 之后
```

- **顺序：先建夹具，再 `loadRoutes`**。`index.js` 的 `dshHome()` / `sessionsRoot()` 是懒求值（每次调用才读 `process.env.DSH_HOME`），所以顺序其实已经不敏感；但**保持这个顺序**——一旦哪天有人在模块顶层读了环境变量，先建夹具才不会踩坑。
- **夹具的项目目录名直接 import `index.js` 的 `projectKey`**（`fixture.mjs` 里 `const projectKeyOf = projectKey`），不再自己抄一份。**记忆目录 slug 是另一套算法**（见「架构」，每个分隔符各变一个 `-`），测试里要造记忆条目时按那套拼（`security.mjs` 里是直接写字面量 `memory/workspaces/--demo--/…`）。改 `index.js` 的 slug 逻辑时，`test/pathkey.mjs` 会立刻红。
- **夹具命令行可传**：`makeFixture({ sessionId, cwd, title })` 覆盖默认值。
- **自定义 set-cwd 类用例别自己拼路径**，用 `fx.home` + `fx.session.id`，否则 relocate 之后 id 对不上。

其余约定：

- 抓 Host handler：给 `apply` 一个假 ctx，`connection.fetch.register` 把 spec 存进 **`Map`（按 `spec.path`）**。别只留最后一个 spec——四条路由会串。
- 假 React：`createElement` 返回 `{type, props, children}`；`useState` 必须返回 `[value, fn]` 二元组，否则组件里解构直接 TypeError；要拿图标内部 `<path d>` 得先 `renderNode(node.type(node.props))` 把组件元素展开。
- **假 `navigator.language` 不设，词表就会跟着跑测试的机器走**：`client.js` 按 `navigator.language` 选中/英词表，干净环境的 Node 没有 `navigator` 时取默认 `zh-CN`，但本地装了 Node 也可能被注入。`client.mjs` 现在先用 `setLocale(LOCALE)` 钉住，双语断言从 `T = IS_EN ? {...} : {...}` 取；跑英文一轮用 `DSH_TEST_LOCALE=en-US node test/client.mjs`。
- 造「同 id 不同会话」：解第 0 帧 → 把 `header.id` 换成新 uuid → 用 `zstdCompressSync(..., { params: { [zlib.constants.ZSTD_c_checksumFlag]: 1 } })` 重压 → 拼回帧 1..n 原字节 → 同步改 `manifest.json` 的 `session.id`。
- 冲突用例顺序必须是 `ask → reuse → copy → overwrite`：`overwrite` 会把本机那份的 `createdAt` 改成包里的，之后就再也构不成「不同会话」了。
- 自动保存靠 `ctx.on('session/event', ...)` 钩子：假 ctx 提供 `effect(fn)`（立即执行）与 `on(name, handler)`（存起来），测试里手动 `handler({id}, {type:'step/end'})` 再等 2.6 秒（1.5 秒去抖 + 余量）。

## 版本与发行

- 版本真源是 `package.json` 的 `version`；`0.x` 阶段 MINOR 可带破坏性改动，`PATCH` 只修 bug；四条路由出入参 + 五个插槽座位 + 状态文件字段形状冻结时才升 `1.0.0`。
- 不随包版本走的三个东西：`dshproj/1`（`FORMAT`）、`dshproj-lock/1`（`LOCK_FORMAT`）、宿主兼容范围（`engines.dsh` 与 peer cordis）。
- `engines.dsh` 是**真拦截**，不是给人看的：`dsh-app-boot` 用 `semver.satisfies(runtime, range, { includePrerelease: true })` 判定（`lib/index.js:276-283`），预发布版**参与**比较。所以 `>=0.2.1-rc.1 <0.3.0-0` 会挡住 `0.2.1-alpha.5` 及更早，放行 `rc.1`…`rc.5`、`0.2.2-alpha.*`、`0.2.2`，挡住 `0.3.0-0` 及之后。**上限必须写 `<0.3.0-0`，不能写 `<0.3.0`**：`includePrerelease: true` 下 `0.3.0-alpha.1 < 0.3.0`，写 `<0.3.0` 会把 0.3.0 的预发布全放进来，等于没上限。一旦写了 `engines.dsh`，`peerDependencies` 里的 `@deepseek-ai/dsh*` 就**完全不参与判定**（`unmetRequirements` 只走一条分支）。
- **`engines.dsh` 的范围只能从接口倒推，不许跟着「最新版」走**。三件事分开：

  **下限怎么定**：逐条列出插件真正用到的宿主接口（四个插槽座位名、`ctx.on('session/event')`、`ctx.get('connection')`、`ctx.effect`、四条 `/api/session.*` 路由依赖的 `connection` 形状、会话文件格式版本、附件对象库路径），对每个接口找到它**第一次存在**的 dsh 版本，取其中最晚的那个当下限。对照表在 `docs/DSH-API-SURFACE.md` §7；查不到的接口必须标 `UNKNOWN`，不许估一个看起来合理的版本号填上。

  **改范围的前置条件**：在新范围声称支持的**每一个边界版本**上跑完二十二套（`for f in pathkey client dialog smoke open conflict security attach repair open-repair version locales context bili roundtrip backup-ui audit-r1 audit-r2 audit-r3 audit-r4 ui-openwait dsh-list; do node test/$f.mjs; done` 加 `DSH_TEST_LOCALE=en-US node test/client.mjs`），把「哪个版本、跑了什么、结果如何」写进 `docs/DSH-API-SURFACE.md` §6。**没跑过的版本不许进范围**，包括「应该没问题」的版本。

  **上限怎么处理**：`>=x` 这种开口写法，只在「下限之后每一个已发布的版本都实测过」时才成立。dsh 发新版后，新版**不在范围内是正常的**；把范围改到新版是那次实测的结论，不是发版当天的默认动作。新版改了你用的接口，正确做法是改代码适配，然后在新旧两版上都跑一遍，而不是把旧版从范围里删掉。

  **上限卡在 MINOR 边界**：`0.x` 阶段 MINOR 可带破坏性改动（本节第一条），所以范围必须闭合到当前 MINOR —— `<0.3.0-0`。写成 `<0.3.0` 挡不住 `0.3.0-alpha.1` 与 `0.3.0-rc.1`，等于没有上限；三档写法的实测判定表在 `docs/DSH-API-SURFACE.md` §7.5。

  当前 `engines.dsh = ">=0.2.1-rc.1 <0.3.0-0"`：**下限**的唯一硬依据是 hero 座位（`0.2.1-rc.1` 才有，`0.2.0-rc.1` 里 `conversation.hero.options` 计数为 0），其余接口的首次可用版本尚未逐条回溯，`§7` 里标 `UNKNOWN` 的就是还没回溯的项；**上限**的依据是 semver 语义（`0.x` 的 MINOR 可能破坏），不是「0.3.0 已知会破坏」。

- **别在主干里写按 DSH 版本分流的分支，也别指望 patch 层能按版本分流**。patch（`cordis.patch.yml`）只能 `insert` 或按 `id` 覆盖字段；`!!js` 表达式的作用域是 `with (ctx)`，只拿得到 Cordis 服务，拿不到版本号，DSH 也不提供版本服务（`ProfileContext` 无 `version`）。真要给旧版留后门只有两条路：主干暴露 `config` 开关由 patch 覆盖，或用 `disabled: !!js ...` 做**能力探测**（某服务在不在）。当前**没有任何需要这么做的项**——理由与逐包对照见 `docs/DSH-API-SURFACE.md` §6.2/§6.3。
- 发版三步，**推 tag 就够了**：
  1. `node scripts/bump.mjs minor`（写 `package.json` + 把 `CHANGELOG.md` 的 `[Unreleased]` 顶成 `## [x.y.z]`）
  2. `git commit -am "发布 vX"` → `git tag -a vX -m "vX"`
  3. `git push origin main && git push origin vX`
  推 tag 会触发 `publish.yml` 全套：校验 tag↔版本一致 → `npm publish --provenance` → 轮询 registry → 从 registry 取回 tarball 核对 sha1 → **用 `scripts/release-notes.mjs` 从 CHANGELOG 摘出正文建 Release** → 把 tarball 传成 Release 附件。不用手工建 Release，也不用写 release notes。
- 重跑不会红：每个 step 先问「这件事做过没」。版本已在 registry 上就跳过 publish（registry 会硬拒重复版本号），Release 已存在就跳过创建，附件用 `--clobber` 覆盖。所以「上次附件没传成」这种事故，重跑同一个 tag 就补上了。
- 三个入口做同一件事：`push tag v*`（主路径）、`release: published`（有人在网页上手建 Release）、`workflow_dispatch`（手动兜底，可 `dry_run` 只打包）。自己建的 Release 用 `github.token`，GitHub 不会因 `github.token` 的事件再触发工作流，不会递归发两次。
- **CI 只发布、不跑测试**。测试是发布前的**本机**动作（见「改完之后」）。别把 `node test/*.mjs` 塞回 workflow：发布链路要的是"结果确定"，而 `dialog.mjs` 要真拉起 Windows PowerShell + WinForms、其余套件要建临时数据根，都属于本机动作；这也正是当初 CI 红过一轮后定的边界。
- 发版说明**只有 `CHANGELOG.md` 一个真源**。`node scripts/release-notes.mjs <ver>` 按版本号摘出对应小节；找不到时带 `--fallback "..."` 就降级输出提示、不带就 exit 1。别再手写一份 notes 粘进 `gh release create --notes`——同一份内容维护两遍必然漂。
- 上架：`marketplace/chinacaa__dsh-session-save.yml` 复制成 awesome-dsh-plugin 仓库的 `data/plugins/<owner>__<repo>.yml` 提 PR；硬门槛是 `dsh.bundle`（已满足）、仓库满 1 天、topic `dsh-plugin`、描述与代码对得上。

## 文档怎么改

仓库里每个 `.md` 都有唯一职责。**同一个事实只写一处**，写两处必然两处不一致——这是这份文档自己踩过的坑（README 曾把红线写成"九条"、把测试收尾写成"跑完对比 `~/.dsh` 的目录数"，都与代码脱节）。

| 文件 | 写什么 | 不写什么 | 什么时候动 |
| --- | --- | --- | --- |
| `README.md`<br>`README.en.md` | 用户视角：这是什么、三步用起来、`.dsproj` 里有什么、和 `dshproj` CLI 的关系、安全承诺、常见问题、已知边界、许可 | 内部实现（函数名、分支顺序）、踩坑过程、"为什么这样写"、测试写法 | 用户能看见的行为变了：按钮、默认文件名、文案、四条路由的出入参、记忆语义、平台限制 |
| `AGENTS.md` | 协作者视角：红线、目录、命令、架构契约（两套 slug、`importPackage` 判定顺序、三重写保护）、测试怎么写、发版与上架、本文档分工 | 面向用户的教程式叙述、历史流水账、"当初为什么"的完整复盘 | 踩到"会静默坏掉"的坑（→ 补红线）、路由/目录/发版流程变了、测试套路变了 |
| `CLAUDE.md` | 最短入口：一句话定位、开工命令、最容易犯的错、收工约定 | 重复 AGENTS.md 的架构与安全细节（只留指针） | AGENTS.md 红线增删时同步条目数；开工命令或收工标准变了 |
| `docs/TEST-MATRIX.md` | F 编号 → 功能面 → 期望结果 → 由哪套测试的哪几条覆盖；怎么跑、什么算通过 | 用户教程、发版流程、安全论证的长篇说明 | **任何功能点或断言变化**。F 编号是 `test/*.mjs` 注释里引用的锚点，改一边必须改另一边 |
| `docs/DSH-API-SURFACE.md` | 插件用到的**每一条** DSH 接口：契约签名、在哪一行用、失效后果、怎么复查（Inspect 命令）。这是「别复述代码」的**唯一例外**——它记的是**外部**契约（DSH 的，不是本仓库的），必须抄准签名 | 本仓库自己的实现细节、"当初为什么这么写"、DSH 的使用教程 | 每次升级 DSH 后逐条核对；插件新增/删除对 DSH 的调用点时必须同改 |
| `CHANGELOG.md` | 用户能感知的变化，按「新增 / 修复 / 变更 / 安全」分组，中文 | 纯文档改动、纯重构、内部改名、开发过程 | 行为变了就加一条 `[Unreleased]`；发版时由 `bump.mjs` 收口，别手写版本号标题 |
| `marketplace/*.yml` | 上架条目：名称、描述、分类、仓库地址、必需字段 | README 的长篇说明（描述控制在平台限制内） | 插件定位/分类/描述变了，或上游条目格式变更 |

三条硬规矩：

1. **别在文档里复述代码**。默认文件名规则的真源是 `index.js` 的 `suggestPath()`、上限常量在 `index.js` 顶部；文档只说结论和例子，不抄正则、不抄常量值。抄了就会在下次改代码时变成谎言。
2. **数字必须当场能验**。文档里出现"11 条红线""682 条 ✅""F1–F84""≈3730 行"这类计数时，要能用一条命令复现（见「改完之后」）。改完顺手核一遍，别让读者去发现数字过期。
3. **中英必须同一次改完**。`README.md` 与 `README.en.md` 是同一份文档的两种语言：小标题顺序、表格列、示例文件名一一对应。只改一份等于给另一半读者发过期信息。

还有两条不写在文档里的东西：进度和计划（放 issue / PR / 提交信息，不写进 README 的"路线图"）、本机路径与个人环境（`C:\Users\...`、profile 名、私有 registry）——后者写进文档等于把私有环境当契约。

## 文字风格准则（README、CHANGELOG、界面字面量、报错）

这个仓库的文字有三拨读者：翻源码的人、只读 README 的人、被报错挡在界面上的人。**三处共用一套语体**——技术严肃，说清事实，不表演亲切。

### 语体

| 该这样 | 别这样 | 为什么 |
| --- | --- | --- |
| 这个位置不是可用的目录。请选择其他工作区，或先创建该目录。 | 哎呀这个位置打不开呢～ | 报错是给人解决问题的，不是安抚情绪 |
| 磁盘上的内容已不是本机上次写入的版本。覆盖将丢失这些改动。 | 文件被改过啦，要不要覆盖？ | 说清后果，让人自己判断 |
| 9 个附件因体积或数量超限未写入。 | 有些附件太大了没存上。 | 数字是事实，别省略 |

三条禁令：

1. **不用表演式口语。** 「省事。不折腾。」「点开就能继续。」这类三短句堆砌，读起来比机器味更假。
2. **不在句尾加评价。** 「……才是关键」「……就对了」「说白了……」全部删掉，句子到事实为止。
3. **不用「我们」。** 文档里没有作者，只有这个插件。

### 标点

- 破折号 `——` 只用在真正的插入语里，一段最多一处。拿它当「然后 / 所以 / 也就是」的连接符会立刻露出翻译腔：README 曾在 355 行里用了 22 处，读完像机翻；现在是 17 处、英文 41 处，超过中文 20 / 英文 45 就该回头查。
- 不用连接词起句：「反过来说」「于是」「另外值得一提的是」全部删掉，直接写下一句。
- 中文用全角标点；代码、路径、命令、报错原文一律半角、原样贴。
- 加粗只给**操作名词**（`**保存**`、`**合并记忆**`），不给整句，也不拿来强调情绪。

### 错误提示三要素

任何面向用户的失败提示，必须同时给出三件事，缺一条就算没写完：

1. **发生了什么** —— 具体到对象：哪个路径、哪个文件、哪个会话。
2. **影响什么** —— 会不会丢数据、会不会留下半个文件、会不会白等。
3. **下一步做什么** —— 能自动代劳的已经做完，剩给用户的动作要是一个具体按钮或一句命令。

反面例子：`该位置不是可用的目录`（不说哪个路径、不给动作、界面只有一条 toast）。这句话真的在 0.3.0 里存在过，用户只能自己开资源管理器猜是哪一个目录。

### 术语表

| 概念 | 只用这个 | 不要写 |
| --- | --- | --- |
| 一条对话 | 会话 / session | 聊天、对话记录、context |
| DSH 里的工作目录 | 工作区 / workspace | 项目、工程（单说「目录」时指文件系统里的目录） |
| `.dsproj` 文件 | 工程包 / 包 | 存档、快照、备份文件 |
| 打包带走的图片 | 附件 / attachment | 图片对象、资源 |
| 覆盖当前文件 | 覆盖 | 替换、顶掉 |
| 把包里的记忆并进本机 | 合并记忆 | 导入记忆、同步记忆 |

### 中英必须同步

`README.md` 与 `README.en.md`、`locales/zh-CN.json` 与 `locales/en-US.json`、四条路由的 `message`，都是同一句话的不同语言版本。**改一处就改全部**：只改中文等于给另一半读者发过期信息；只改语言包等于界面还显示旧话（客户端有一份中文兜底表，`client.js` 的 `ZH`）。

### 界面字面量

- 源语言在 `locales/zh-CN.json`，兜底表在 `client.js` 的 `ZH` —— 两处都要有，`test/locales.mjs` 会查。
- 占位符 `{n}` / `{path}` 原样保留，不许改成 `%s`，也不许在代码里拼字符串绕过去。
- 长度：按钮不超过 6 字，弹窗标题不超过 12 字，否则英文版会撑破布局。
- 字面量里不写死路径、端口、账号。

### 自查

```bash
node scripts/check-locales.mjs          # 键是不是源语言子集、占位符对不对得上
grep -o '——' README.md | wc -l          # 中文破折号密度，超过 20 就该回头查
grep -o '—' README.en.md | wc -l        # 英文 em dash，超过 45 同理
```

## 改完之后

1. `node --check index.js client.js`（改过 .ps1 再加语法检查）。
2. 跑**全部二十二套**测试，别只跑改到的那一个；改过客户端再补一轮 `DSH_TEST_LOCALE=en-US node test/client.mjs`。
3. 改过行为 → `CHANGELOG.md` 的 `[Unreleased]` 加一条。
4. 改过任何一个断言或功能点 → 同步 `docs/TEST-MATRIX.md` 的覆盖表（它按 F 编号列，条数对不上就是漏改）。
5. 改过文档 → 按「文档怎么改」那张表核对：中英两份是否同改、有没有把代码细节抄进文档、文中的计数是否仍成立：

   ```bash
   wc -l index.js client.js                                  # 对应 AGENTS.md「规模」
   awk '/^## 红线/,/^## 目录/' AGENTS.md | grep -c '^[0-9]\+\. \*\*'   # 红线条数（必须限在红线节内：本文别处也有编号列表）
   grep -oE 'F[0-9]+' docs/TEST-MATRIX.md | sort -u | wc -l  # 功能面条数
   for f in pathkey client dialog smoke open conflict security attach repair open-repair version locales context bili roundtrip backup-ui audit-r1 audit-r2 audit-r3 audit-r4 ui-openwait dsh-list; do node test/$f.mjs | grep -c '✅' ; done   # 二十一行相加 = 682
   ```

6. 确认测试没有留下垃圾：跑完 `git status` 应为只有你改的源文件，`os.tmpdir()` 下不该残留 `dshss-fx-*` / `dshss-sec-*` 目录（`autoCleanup` 会删，残留说明收尾路径漏了信号处理）。
