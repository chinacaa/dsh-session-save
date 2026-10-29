# 变更记录

格式参照 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

## [0.2.3] - 2026-10-29

### 修复

- **保存前不再假定目标还在原处。** 以前有两处会在目标消失时静默造出一个同名文件：①自动保存——那个文件被删掉、被移走，或所在磁盘/网盘没挂上时，旧逻辑先 `mkdir -p` 再照写，等于把一份同名空壳放回原位；②手动保存——第二次点 💾 走「记住的路径」直接落盘，中间没有确认机会，文件不在了就在原位新建。现在两者都先确认：自动保存发现目标不在会**自己停掉**（`autosave[sessionId]` 置 `false`），并在状态里留一条 `missing`（原路径 + 发现时间），界面提示「自动保存已停用：目标文件不在了」；手动保存返回 `409 missing-target`（带原 `path`），弹窗三个选择——**就在这里新建**（`?recreate=1`）/ **另存到别处** / **取消**，默认一个字节都不写。打包写入也不再顺手建目录（`writeAtomic(..., { createDir: false })`），目录不在就报「目标目录不存在」。`storages/session-save.json` 新增 `missing` 字段；打开或保存成功后自动清掉对应标记。

## [0.2.2] - 2026-10-28

### 修复

- 会话目录名与 DSH 官方实现有三处不一致，某些工作区会定位到不存在的目录（表现为「本机没有这个会话」，或换机打开后找不到原会话）：①连续分隔符以前被折算并**剪掉尾部** `-`，官方只折叠不剪——`C:\x\` 的官方键是 `--C-x---`；②前导 `-` 剥完若为空，官方兜底 `root`（根路径 `/` → `--root--`），以前得到 `----`；③转义以前按 Unicode 码点，官方按 UTF-16 码元——emoji 的 `😀` 官方是 `~D83D~DE00`，以前写成 `~1F600`。现在两个函数与官方逐字对齐，并新增 `test/pathkey.mjs`（35 条）把每一种边界钉住，防止下次升级 DSH 时再漂。
- `test/fixture.mjs` 不再自己抄一份 `projectKey`，改为直接 `import` 实现（`const projectKeyOf = projectKey`）。以前两份同源但独立演化，实现一改夹具就静默找错目录。
- 发布流水线取回 tarball 时不再被 npm registry 的传播延迟打成 failure：该步骤改为自己轮询 registry（30 次 × 10 秒），等不到只告警并跳过上传、不判失败；下载改用 `--retry-all-errors`。这是 v0.2.1 那次「包已经发出去了，但 Release 附件没传成」的根因修复——当时只有 `curl -f --retry 3`，而 `--retry` 不重试 404。

### 变更

- 发版从「手工几步」变成「推 tag 就完事」：`publish.yml` 现在由 `push tag v*` 触发，一条链路做完 校验 tag↔版本一致 → `npm publish --provenance` → 轮询 registry → 从 registry 取回 tarball 核对 sha1 → **用 `CHANGELOG.md` 自动建 GitHub Release** → 把 tarball 传成 Release 附件。以前发一版要手工建 Release、手工写发布说明、手工上传附件，三步都靠人记。
- 新增 `scripts/release-notes.mjs`：按版本号从 `CHANGELOG.md` 摘出对应小节当 Release 正文。发布说明从此只有一个真源，不再手写第二份。
- 流水线改为**幂等**，同一个 tag 重跑不会红：版本已在 npm 上就跳过 publish（registry 会硬拒重复版本号），Release 已存在就跳过创建，附件用 `--clobber` 覆盖。上次「附件没传成」这类事故，重跑一次就补上，不用再手工 `gh release upload`。

## [0.2.1] - 2026-10-28

### 修复

- 「打开记忆目录」按钮以前点了没反应：它调的是 `host.uiWorkspace.openPath`，而 DSH 的 `uiWorkspace` 服务根本没有这个方法（只有 `openSession` / `pickDirectory` / `listDirectory` 等 10 个），`typeof … === 'function'` 判断恒假 → 静默什么都不做。现在改走 Session Remote 的 `remote.session.openWorkspacePath({ path, action: 'reveal' })`，并在 `inject` 里声明 `remote` / `remote.session` 两个服务依赖。路径由 Host 侧 `verifyDesktopPath` 校验，不认的路径仍然只显示而不弹错。
- 发版流水线在 v0.2.1 首次发布时把整个 job 打成 failure：`npm publish` 成功返回后 registry 还没能读到新版本（npm 自己就提示「being processed and may take a few minutes」），紧接着的「取回已发布的 tarball」拿到 404，`curl -f` 退 22。包其实已经发出去，只有 Release 附件没传成（当日手工补传）。**这条修复没赶上 v0.2.1 的包，随 0.2.2 发布**——见 0.2.2「修复」。

### 变更

- 新增 `docs/DSH-API-SURFACE.md`：把插件用到的每一条 DSH 接口（包清单声明、Host 的 `connection` 与 `session/event`、客户端的 `slots` / `sessions` / `uiWorkspace` / `remote.session`、四条自建 HTTP 路由）连同契约签名、调用行号、失效后果、复查用的 Inspect 命令列成核对表，升级 DSH 时照着逐条过。

## [0.2.0] - 2026-10-26

### 新增

- 「合并记忆」通道：`?memory=restore`（界面上的「合并记忆」按钮）把包里的工作区记忆写回**原名**，让 DSH 真的能读到；默认行为不变，仍只落 `xxx.from-dsproj-<日期>` 副本。restore 只改落点，`safeSegments` / `safeJoin` / `ENTRY_ALLOW` / `manifest.parts` 校验一条都不跳过；覆盖前先备份成 `xxx.bak-<时间>`，内容已一致则跳过不备份。
- 打开后告诉用户记忆发生了什么：toast 里报「几个记忆文件落了副本 / 几个和本地重名 / 几个已写回原位」，落副本时界面留一块提示面板，带「合并记忆」和「打开记忆目录」；合并前弹窗列出会被覆盖的文件。以前这三个字段后端早就返回、前端一个都没用。

### 变更

- 六套测试改为自带临时数据根（新增 `test/fixture.mjs`）：每个套件在 `os.tmpdir()` 下建一份 `DSH_HOME` 夹具、跑完自删，**不再读写真实的 `~/.dsh`**。以前 `smoke.mjs` / `open.mjs` 依赖"本机恰好存在某个会话"，换机器、清过数据、或 CI runner 上必红；现在任何机器结果一致，也不再需要跑完手工核对目录数。
- 中文词表不再跟着宿主的 `navigator.language` 漂：`test/client.mjs` 显式钉住 locale（`DSH_TEST_LOCALE`，默认 `zh-CN`），断言从中英两套期望里取；本地/英文 runner 都能跑同一套用例。
- `publish.yml` 只负责发布：`release: published` 或手动 `workflow_dispatch` 时执行 `npm publish --provenance --access public`，action 升到 `actions/checkout@v5` + `actions/setup-node@v5`（Node 20 已弃用）。测试回归改为发布前的本机动作，不再进 CI。
- 平台相关代码抽到 `dialog/` 目录，`index.js` 不再认识 PowerShell：`dialog/index.mjs` 是选择器，`dialog/shared.mjs` 是共用工具，`dialog/windows.mjs` + 两个 `.ps1` 是 Windows 实现。以后加平台只加一个实现文件和一个分支，`index.js` 一行不动。
- **macOS / Linux 也有原生窗口了**：macOS 走系统自带的 `osascript`（`choose file name` 出保存面板、`choose file` 出打开面板，取消按 AppleScript 的 `-128` 判）；Linux 与 BSD 按 zenity → kdialog → qarma → matedialog 找第一个装了的，GTK 系与 KDE 系各用一套开关。以前非 Windows 只能用网页里的路径输入框。
- 原生窗口的可用性改为**能力探测**（Windows 看 `powershell.exe`、macOS 看 `/usr/bin/osascript`、Linux 找 GUI 工具），不再假设「某个平台就一定有」。探测不到就直接回退到网页里的路径输入框；这条路径此前只在 `execFile` 抛 `ENOENT` 时才被动触发，现在开窗之前就判掉。

### 安全

- 修掉「合并记忆」对本机不存在的文件零确认落盘：`memory=restore` 现在**只覆盖本机已存在的记忆文件**（覆盖前备份 `.bak-<时间>`），本机没有的一律不写、计入 `memoryCreated` 并在弹窗「将新建」段列出；要把记忆铺到全新机器，需用户显式选「合并并新建」（`memory=new`）。此前一份投毒包只要声明一个本机没有的 `MEMORY.md`，点一次「合并记忆」就能让 DSH 把它当项目笔记读进上下文——`MEMORY.md`、最近两天的日期日志、`handoff/*.md` 全在记忆读取面内，等于绕过「记忆永不落原名」这层防护。
- 返回体新增 `memoryPlanned`（`[{ rel, exists }]`，`copy` 模式也返回），前端据此把「将覆盖」和「将新建」分开显示，用户在点确认前就能看见哪些文件本机没有。
- 修掉 ZIP 条目名穿越（`../../x` 或 `..\..\x`）：读包阶段就按段校验并拒绝，导入时记忆文件落点逐段 `safeJoin`，一条都不出目标目录。
- 修掉 `manifest.session.fileName` 穿越：只接受 `session[.tag].jsonl[.zstd]` 形态的文件名并取 basename，落点必须仍在 `~/.dsh/sessions` 里，目标已存在则不覆盖。
- 解压炸弹防护：单条目 64 MB、整包 512 MB、压缩比 200×（4 MB 以下不计比例）；`inflateRawSync` 带 `maxOutputLength`，中央目录字段先做越界校验。
- 保存路由加白名单：只允许写到上次用的目录、已记住文件的目录，或原生对话框选的位置；覆盖陌生文件要先 `confirm-overwrite`，且对方必须是我们自己的 `.dsproj`。
- 打开路由收紧：只接受 `.dsproj`，失败信息不再回显绝对路径；`sessionId` 形态校验，`findSessionFile` 不再按原样字符串拼路径。
- 四条 `/api` 路由统一入口校验：只接受回环 Host、同源 Origin、非 `cross-site` 请求。
- 包完整性：`manifest.parts` 的 sha256 / 字节数逐条复核，未知条目直接拒绝。
- 包完整性缺口：以前只复核「`parts` 里声明过的」条目，没声明的条目照样能过白名单——于是可以只声明合法会话条目、偷偷夹带 `memory/workspaces/<slug>/MEMORY.md`（那玩意儿每轮都会注入模型上下文）。现在所有内容条目（`session/`、`memory/workspaces/`）必须都在 `manifest.parts` 里声明过，没声明的一律拒绝；包里有记忆条目但整个 `parts` 缺失的，也拒绝。
- 删掉 `ENTRY_ALLOW` 里 `workspace/` 那条白名单：导入路径从来没有处理过 `workspace/` 条目，放行等于默许未知内容。
- 入口校验在拿不到 `headers`（不是 `Headers` 实例或缺失）时改为直接拒绝，不再为单元测试开后门放行。
- 侧车锁带持有者 token，只删自己那份；状态文件改原子写，避免半个 JSON 让记住的路径全丢。
- 包内记忆条目永不落成原名：`manifest.parts` 的 sha256 是打包方自己算的，攻击者把投毒的 `MEMORY.md` 也登记进去、哈希算对，前一条的全覆盖检查就全过了——自洽不等于可信。所以导入时记忆一律写 `xxx.from-dsproj-<日期>` 副本（重名继续加序号），不会被 DSH 当成项目笔记注入上下文；副本留在那儿可人工比对。
- 默认不再把 `~/.dsh/memory` 整份打进包（只在 Alt 点击 / `?memory=1` 时带）；界面与文档都写明。

## [0.1.0] - 2026-10-25

### 新增

- 会话标题栏「保存」：第一次弹原生另存为窗口，之后一键覆盖同一文件。
- 会话标题栏「另存为」：独立图标，每次都问名字与位置，原文件保留。
- 会话标题栏「打开」：选一个 `.dsproj` 导入并切到那个会话；空会话页面的新会话行也有一个。
- 自动保存开关：每步结束（`session/event` 的 `step/end`、`turn/end`）后 1.5 秒去抖写盘。
- 打开冲突处理：本机没有该会话 id 时先问落到哪个工作区；同 id 不同会话时弹面板四选一（复用 / 覆盖 / 副本 / 取消）；同会话换工作区自动换新 id。
- 文件内锁 `LOCK.json`（写入者主机、pid、时间、写入次数）与 `manifest.lock` 镜像；磁盘侧 `${file}.lock` 侧车 `wx` 独占；跨机按 15 分钟时间窗判活。
- 内容比对（CAS）：写前比 sha256，被别处改过时手动保存返回 409、自动保存自行关闭并记录冲突。
- 原子写：`<target>.tmp-<pid>-<ts>` + rename，避免同步盘抓到半个包。
- 同步盘提示：路径命中 OneDrive / Dropbox / Google Drive / iCloud / 坚果云 / Box / Syncthing / Seafile / 百度网盘时提示两台机器同开会互相覆盖。
- 文件命名：`<会话标题>-<会话创建时间>.dsproj`，标题为空时退回 `<时间>-session-<id 前 8 位>`。
- 与 `dshproj` 命令行工具（`dshproj/1` 包格式）双向兼容。
