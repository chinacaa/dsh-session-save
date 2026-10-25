# AGENTS.md

给在这个仓库里干活的 AI/人类协作者的说明书。**先读完「红线」再动手**，那里每一条都是踩过的坑。

## 这是什么

一个 DSH（DeepSeek Harness）插件：把当前会话另存为单个 `.dsproj` 工程文件，也能反过来从 `.dsproj` 打开会话并切过去。产物与 `dshproj` 命令行工具双向兼容（同一套 `dshproj/1` 包格式）。

- 语言/运行时：纯 ESM（`"type": "module"`），零运行时依赖，只用 `node:` 内置模块；客户端只 `require('react')`。
- 宿主：DSH `>=0.2.1-rc.1`（`engines.dsh`），Cordis `^4.0.1`（peer）。
- 平台：Windows 优先（原生对话框走 `powershell.exe` + WinForms），没有 PowerShell 时退回网页里的路径输入框。

## 红线（改之前先看，违反会静默坏掉）

1. **别用 profile 的 `cordis.patch.yml` 装本插件**。那份文件只用于「覆盖已有 id」；新增插件必须靠包内 `cordis.patch.yml` + `package.json` 的 `dsh.bundle.patch` + profile `package.json` 里 `dsh.profile.bundles` 追加包名。只往 profile patch 里加 `- id/name` 行 → 路由 404 且没有任何日志。
2. **别手改 `package.json` 的 `version`**。用 `node scripts/bump.mjs`，它同时更新 `CHANGELOG.md`。
3. **别再往侧栏塞 DOM 注入的按钮**。侧栏「工作区」标题行是硬编码（`sectionLabel` + `searchButton` + `headerActions`，类名还是 hashed 的），没有插槽。本插件只挂官方插槽：标题栏 `conversation.session.header.utilities` + 空会话页 `conversation.hero.options`。
4. **改会话日志只许重写第 0 帧**。会话文件是「多个 zstd 帧拼接」，第 0 帧是 header；改 `cwd`/`id` 后必须把帧 1..n 原字节照搬，不能整体解压再压回去。
5. **`client.js` 里不许出现 `document.`、`MutationObserver`、全局 `<style>`、除 react 之外的依赖**。`test/client.mjs` 里有反向断言，写了就红。图标一律内联 SVG（`stroke="currentColor"`），颜色用主题 token。
6. **`.ps1` 必须是带 BOM 的 UTF-8**，否则 PowerShell 5.1 按 ANSI 解析直接 `Missing closing '}'`（而 pwsh 7 的 AST 校验却能通过，别拿它当证据）。中文路径**必须走 `-ResultFile`**：PS 5.1 的 stdout 是控制台代码页（中文系统 `gb2312`），Node 按 UTF-8 读会把中文读成 `ÿ…`，然后按乱码名写盘。
7. **测试必须自己复原 `~/.dsh`**。每个测试前后都对比 `sessions/` 与 `memory/workspaces/` 的目录集合，新增的删掉；改过的 `storages/session-save.json` 只删自己那几个键，别整份删（用户真实记录在里面）。
8. **不要 commit `*.dsproj`**（`.gitignore` 已挡）。测试产物一律写 `os.tmpdir()`。
9. **不要主动 commit / push**，除非用户明说。
10. **不要把安全校验删掉或放宽**。包是「可能来自敌人」：条目名必须过 `safeSegments`（`\` 也算分隔符）、落点必须过 `isInside`、`inflateRawSync` 必须带 `maxOutputLength`、四条 `/api` 路由必须过 `requestGate`、`manifest.parts` 必须复核。`test/security.mjs` 会盯这些，改坏了立刻红。
11. **默认不打包 `~/.dsh/memory`**（里面有用户的项目笔记、日志和白板）。要带必须显式 `?memory=1`（界面上是 <kbd>Alt</kbd> 点击）。

## 目录

```
index.js            Host 半：四条 HTTP 路由 + 打包/导入 + 锁 + CAS（约 1430 行）
client.js           Client 半：5 个插槽项 + 三个模态 + 内联图标（约 1480 行）
cordis.patch.yml    bundle 补丁层（insert id=session-save）
save-dialog.ps1     原生「保存会话」对话框
open-dialog.ps1     原生「打开会话工程」对话框
marketplace/        上架条目（提 PR 到 awesome-dsh-plugin 用）
scripts/bump.mjs    改版本（package.json + CHANGELOG）
scripts/set-repo.mjs 把 OWNER 占位换成真实 GitHub 名字
test/*.mjs          六个自检（见「测试」）
assets/             截图与方形图标（市场用）
```

## 命令

```bash
node test/dialog.mjs      # 中文路径往返：PS 结果文件 + UTF-8 编码
node test/client.mjs      # 客户端接线：5 个插槽项、图标手指纹、点击打到的路由
node test/smoke.mjs       # Host 冒烟：真实会话 → 打包 → 回读 ZIP → 二次保存复用路径
node test/open.mjs        # 打开链路：复用 / 换 cwd 落地 / need-workspace / 逐帧比对
node test/conflict.mjs    # 锁、四种冲突、CAS、自动保存（约 30 秒，含 2.6 秒等待）
node test/security.mjs    # 安全回归：条目名穿越 / 落点文件名 / 解压炸弹 / 路由闸 / parts 校验

node --check index.js client.js            # 语法
node scripts/bump.mjs patch --dry          # 版本号预演
node scripts/set-repo.mjs <owner>          # 填掉 OWNER 占位

pwsh -c "foreach($f in 'save-dialog.ps1','open-dialog.ps1'){$t=$null;$e=$null;[void][System.Management.Automation.Language.Parser]::ParseFile((Resolve-Path $f).Path,[ref]$t,[ref]$e);\"$f => $($e.Count)\"}"
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
| `/api/session.open` | 读一个 `.dsproj`，导入成本机会话并返回 `sessionId` |
| `/api/session.autosave` | 查/开关某个会话的自动保存 |
| `/api/session.workspaces` | 列 `workspace.json` 里登记的工作区（打开时选落点用） |

数据路径规则（**两套 slug，别混**）：

- 会话：`$DSH_HOME/sessions/<projectKey(cwd)>/<encodeSegment(id)>/session.v4.jsonl.zstd`。`projectKey` 把 `/ \ :` 的连续段折成一个 `-`；`encodeSegment` 把非 `[A-Za-z0-9._-]` 的字符转成 `~XXXX`。
- 记忆：`$DSH_HOME/memory/workspaces/--C--Users-aa-workspace--` 这种，**每个**分隔符各变一个 `-`。所以记忆目录要「先精确、再按去掉非字母数字后相等」两级模糊匹配，不能照会话那套算。

`importPackage` 的判定顺序（别调换）：

1. 本机没有这个 id 且没给 `cwd` → `status: 'need-workspace'`（客户端弹工作区选择）。
2. 同 id + 同 `createdAt` + 同 `cwd` → 复用现有文件，不写盘。
3. 同 id + 同 `createdAt` + 不同 `cwd` → **relocate**：换新 `session-<uuid>` id 落地（id 必须全机唯一）。
4. 同 id + 不同 `createdAt` → 真冲突，按 `onConflict` 走 `ask`（409）/`reuse`/`overwrite`（先 `.bak-<ts>`）/`copy`。

写盘的三重保护：`${file}.lock` 侧车 `wx` 独占 → 包内 `LOCK.json`（`host`/`pid`/`at`/`writes`，异机按 15 分钟判活）→ 内容 sha256 CAS（不符时手动保存 409 `status:'stale'`，自动保存**自行关闭**并记进 `stale`）。落盘用 `writeAtomic`（tmp + rename），避免同步盘抓到半个包。

状态文件 `$DSH_HOME/storages/session-save.json`：`{ paths, lastDir, autosave, stamps, stale }`，按 `sessionId` 索引，形状变了要进 CHANGELOG 并考虑升 MINOR。

**Client（`client.js`）** 用 `window.__ModuleLoader__.load({ id:'dsh-session-save', factory(require){...} })`，`exports.inject = ['slots','sessions','uiWorkspace']`，注册 5 项：

```
conversation.session.header.utilities   session-open@39  session-save@40  session-autosave@41  session-save-as@42
conversation.hero.options               session-open-hero@41
```

打开流程：`api/session.open` → `need-workspace` 弹工作区面板 → `conflict` 弹四选一面板 → `opened` 时 `sessions.refresh?.()` 再 `uiWorkspace.openSession?.(id)`（两步都可选调用，纯 TUI 没有 `uiWorkspace` 时只导入不跳转）。

## 测试怎么写

- 抓 Host handler：给 `apply` 一个假 ctx，`connection.fetch.register` 把 spec 存进 **`Map`（按 `spec.path`）**。别只留最后一个 spec——四条路由会串。
- 假 React：`createElement` 返回 `{type, props, children}`；`useState` 必须返回 `[value, fn]` 二元组，否则组件里解构直接 TypeError；要拿图标内部 `<path d>` 得先 `renderNode(node.type(node.props))` 把组件元素展开。
- 造「同 id 不同会话」：解第 0 帧 → 把 `header.id` 换成新 uuid → 用 `zstdCompressSync(..., { params: { [zlib.constants.ZSTD_c_checksumFlag]: 1 } })` 重压 → 拼回帧 1..n 原字节 → 同步改 `manifest.json` 的 `session.id`。
- 冲突用例顺序必须是 `ask → reuse → copy → overwrite`：`overwrite` 会把本机那份的 `createdAt` 改成包里的，之后就再也构不成「不同会话」了。
- 自动保存靠 `ctx.on('session/event', ...)` 钩子：假 ctx 提供 `effect(fn)`（立即执行）与 `on(name, handler)`（存起来），测试里手动 `handler({id}, {type:'step/end'})` 再等 2.6 秒（1.5 秒去抖 + 余量）。

## 版本与发行

- 版本真源是 `package.json` 的 `version`；`0.x` 阶段 MINOR 可带破坏性改动，`PATCH` 只修 bug；四条路由出入参 + 五个插槽座位 + 状态文件字段形状冻结时才升 `1.0.0`。
- 不随包版本走的三个东西：`dshproj/1`（`FORMAT`）、`dshproj-lock/1`（`LOCK_FORMAT`）、宿主兼容范围（`engines.dsh` 与 peer cordis）。
- 发版：`node scripts/bump.mjs minor` → `git commit -m "发布 vX"` → `git tag -a vX -m "vX"` → `git push --follow-tags`。
- 上架：`marketplace/dsh-session-save.yml` 复制成 awesome-dsh-plugin 仓库的 `data/plugins/<owner>__<repo>.yml` 提 PR；硬门槛是 `dsh.bundle`（已满足）、仓库满 1 天、topic `dsh-plugin`、描述与代码对得上。

## 改完之后

1. `node --check index.js client.js`（改过 .ps1 再加语法检查）。
2. 跑**全部五个**测试，别只跑改到的那一个。
3. 改过行为 → `CHANGELOG.md` 的 `[Unreleased]` 加一条。
4. 确认 `~/.dsh` 目录集合回到原状（5 个会话目录 / 3 个记忆目录），`storages/session-save.json` 没留下测试会话的键。
