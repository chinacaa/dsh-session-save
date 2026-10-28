# 功能清单与测试矩阵

本文从代码反推功能面（`index.js` 四条路由 + `client.js` 五个插槽项），逐条列出可观测行为、期望结果，以及由哪套测试覆盖。测试分两层：

- **七套自动化回归**（`test/*.mjs`）：`node test/<name>.mjs` 单独可跑，共打印 260 行 ✅。`smoke.mjs` 用 `throw` 断言、只在末尾打一行汇总，表里按 1 计（实际 12 处检查）。
- **审计验收脚本**（未随仓库分发）：针对历史漏洞的复现/防回归，判据写在下表里，可照着重写。

所有套件都通过 `test/fixture.mjs` 自建临时 `DSH_HOME`（`os.tmpdir()` 下），跑完自删——**不读也不改真实 `~/.dsh`**，所以在任何机器、任何数据状态下结果一致。功能面的 F 编号是本文与 `test/*.mjs` 注释共同引用的锚点，改动功能时两边一起改。

约定：`S` = `/api/session.save`，`O` = `/api/session.open`，`A` = `/api/session.autosave`，`W` = `/api/session.workspaces`。

## 一、功能清单

### A. 保存（`S`，`GET|POST`）

| ID | 功能 | 入参 | 期望 |
| --- | --- | --- | --- |
| F1 | 保存到已记住的路径 | `sessionId` | 200 `status:saved`，返回 `path/bytes/entries/memoryFiles/lock/cloud`，覆盖原文件 |
| F2 | 保存到显式路径 | `sessionId`+`path` | 同上；`path` 必须落在白名单目录（上次保存目录 ∪ 已记住工程的目录） |
| F3 | 首次保存弹原生另存为 | `sessionId`（无 `path`） | 打开「保存会话」窗口；用户确认后 200 `saved`；取消 → `status:cancelled` |
| F4 | 另存为（强制弹窗） | `ask=1` 或 `mode=dialog` | 无视记住路径，必弹窗口；返回新路径并记为新的记住路径 |
| F5 | 覆盖确认 | `path` 指向已存在的陌生文件 | 无 `force` → 409 `confirm-overwrite`；`force=1` 但文件不是合法 `.dsproj` → 409 `not-dsproj` |
| F6 | 内容被别处改过（CAS） | 磁盘文件 sha256 与上次写盘记录不符 | 409 `stale`，带 `expected/actual/bytes/since`；`force=1` 才覆盖 |
| F7 | 文件被别的进程锁着 | 存在新鲜锁 | 409 `locked`，带 `lock`（host/pid/at/writes） |
| F8 | 打包内容 | — | `dshproj/1` ZIP：`manifest.json`（含 `session.frames/lines`、`parts`、`lock`）+ `session/<file>`（store）+ 可选 `memory/workspaces/<slug>/**` + `LOCK.json` + `SUMMARY.md` |
| F9 | 带记忆打包 | `memory=1` | 包内出现 `memory/workspaces/...` 条目，`memoryFiles > 0`；默认**不带** |
| F10 | 默认文件名 | — | `<会话标题>-<YYYYMMDD-HHmm>.dsproj`（时间取 `header.createdAt`）；标题为空 → `<YYYYMMDD-HHmm>-session-<id前8>.dsproj`；非法字符替换、截断 60 字 |
| F11 | 同步盘识别 | 路径命中 OneDrive/Dropbox/… | 响应带 `cloud:<盘名>`，客户端提示「两台机器同开会互相覆盖」 |
| F12 | 原子写 | — | 先写 `<target>.tmp-<pid>-<ts>` 再 rename；不产生半截包 |

### B. 打开（`O`，`GET|POST`）

| ID | 功能 | 入参 | 期望 |
| --- | --- | --- | --- |
| F13 | 打开并跳转 | `path` | 200 `status:opened` + `sessionId/cwd/target/stats/memory*/sourcePath`；客户端刷新列表并切到该会话 |
| F14 | 本机没有这个 id | `path`（无 `cwd`） | 200 `status:need-workspace` + `workspaces[]`（`{id,title,path,exists}`）+ `originalCwd` |
| F15 | 指定落点 | `path`+`cwd` | 会话文件落到 `sessions/<projectKey(cwd)>/<id>/`；`header.cwd` 改写为新 cwd |
| F16 | 同一会话同 cwd | — | `reused:true`，不写盘，直接指向现有文件 |
| F17 | 同一会话不同 cwd | — | `relocate`：换新 `session-<uuid>`，`replacedId` 记原 id（id 必须全机唯一） |
| F18 | 同 id 不同会话 | `onConflict=ask` | 409 `status:conflict`，带 `existing`/`incoming` 两侧详情 |
| F19 | 冲突四选一 | `onConflict=reuse|overwrite|copy` | `reuse` → 指向本机那份；`overwrite` → 先 `.bak-<ts>` 再覆盖；`copy` → 新 id 落地 |
| F20 | 打不开的文件 | 非 `.dsproj` / 不存在 / 坏包 | 400「只能打开 .dsproj 工程文件」/ 404「找不到这个文件（可能已被移动或删除）」/ 500「这个文件打不开：<原因>」，**不回显绝对路径** |
| F21 | 打开后记住来源 | — | `state.paths[id]`、`stamps[id]`、`lastDir` 更新；后续「保存」写回同一个包 |

### C. 记忆导入（`O` 的 `memory` 参数）

| ID | 功能 | 入参 | 期望 |
| --- | --- | --- | --- |
| F22 | 不写记忆 | 无 `memory` | `memoryWritten=0`，记忆目录不变 |
| F23 | 落副本（默认） | `memory=copy` | 一律落 `xxx.from-dsproj-<日期>`，**永不落原名**；同名副本已存在则加序号 |
| F24 | 合并已有 | `memory=restore` | **只覆盖本机已存在的文件**（先备份 `xxx.bak-<时间>`）；本机没有的不写，计入 `memoryCreated` |
| F25 | 合并并新建 | `memory=new` | restore 的全部行为 + 允许新建本机没有的文件（落原名） |
| F26 | 计划清单 | 任意 `memory` | 返回 `memoryPlanned:[{rel,exists}]`（`copy` 也返回），前端据此分「将覆盖 / 将新建」 |
| F27 | 幂等 | 重复导入同内容 | 内容逐字节相同 → `memorySkipped+1`，不备份、不覆盖 |

### D. 自动保存（`A`，`GET|POST`）

| ID | 功能 | 入参 | 期望 |
| --- | --- | --- | --- |
| F28 | 查询状态 | `sessionId` | 200 `{status:'ok', enabled, path, cloud, stale}` |
| F29 | 开 / 关 | `sessionId`+`enabled=1|0` | 写状态文件；开启时立刻调度一次 |
| F30 | 每步落盘 | 宿主 `session/event` 的 `step/end` / `turn/end` | 1.5 s 去抖后整包重写；`LOCK.json.writes` 递增 |
| F31 | 撞 CAS 自杀 | 磁盘被别处改过 | **不写盘**、自动关闭该会话的自动保存、把冲突记进 `state.stale[id]` |
| F32 | 被锁跳过 | 存在新鲜锁 | 跳过本次写盘，不报错 |

### E. 工作区（`W`）

| ID | 功能 | 期望 |
| --- | --- | --- |
| F33 | 列出工作区 | 读 `$DSH_HOME/storages/workspace.json` 的 `tables.workspaces`，返回 `{id,title,path,exists}`，按标题排序；文件缺失 → `[]` |

### F. 客户端（`client.js`）

| ID | 功能 | 期望 |
| --- | --- | --- |
| F34 | 五个插槽项 | `conversation.session.header.utilities`：`session-open@39`、`session-save@40`、`session-autosave@41`、`session-save-as@42`；`conversation.hero.options`：`session-open-hero@41` |
| F35 | 图标语义 | 文件夹=打开、软盘=保存、双向箭头=自动保存（开启时高亮）、软盘+铅笔=另存为；均内联 SVG |
| F36 | 提示与弹窗 | toast（成功/副本/冲突/云盘）、`AskPanel`（路径）、`WorkspaceModal`（选工作区）、`ConflictModal`（四选一）、`StaleModal`（三选一）、`RefuseModal`（覆盖/非工程包）、`MemoryNotice`+`MemoryMergeModal`（记忆提示与合并） |
| F37 | 无全局副作用 | `client.js` 不含 `document.` / `MutationObserver` / 全局 `<style>` / 非 react 依赖；文案全部走 i18n 中英两份 |

### G. 安全与数据完整性

| ID | 功能 | 期望 |
| --- | --- | --- |
| F38 | 路由入口闸 | 只接受回环 Host（`127.0.0.1`/`localhost`/`::1`）、同源 `Origin`、非 `cross-site`；缺 headers 或读不出来 → 拒绝 |
| F39 | 会话 id 校验 | `isSessionId` 正则；不合法 → 400；`findSessionFile` 只走 `encodeSegment`，不接受原样 id |
| F40 | 条目名校验 | `safeSegments`：`/` 与 `\` 都是分隔符，拒绝空段、`.`、`..`、盘符、UNC、控制字符 |
| F41 | 落点校验 | `safeJoin` + `isInside`：所有写盘目标必须在预期根内 |
| F42 | 解压限制 | 单条目 ≤64 MB、总计 ≤512 MB、压缩比 >200×（4 MB 以上才判）→ 拒绝 |
| F43 | 包完整性 | `ENTRY_ALLOW` 白名单；`manifest.parts` 逐条 sha256 + bytes 复核；**所有内容条目必须声明过**；带记忆但无 `parts` → 拒绝 |
| F44 | 锁 | `${file}.lock` 侧车 `wx` 独占（带 token，只删自己的）+ 包内 `LOCK.json`（同机判 pid 存活、异机 15 分钟窗口） |
| F45 | 状态文件 | `{paths,lastDir,autosave,stamps,stale}`，原子写；损坏则回落空状态而不是崩 |
| F46 | 中文路径 | `.ps1` 带 BOM；结果经 `-ResultFile` 以 UTF-8 回传，stdout 只兜底 |
| F47 | 平台隔离 | `dialog/index.mjs` 按「依赖在不在」选实现（不看系统版本号）：缺 `SystemRoot`、`powershell.exe` 不存在 → 返回 `null`，调用方降级到网页里的路径输入框；Windows 且解释器在 → 加载 `dialog/windows.mjs`。缓存键是 `platform`，假平台的「不可用」结论不会漏给真实平台 |
| F48 | 非 Windows 原生面板 | macOS 走 `osascript` 的 `choose file name` / `choose file`（`POSIX file` 包 alias、`POSIX path of` 转回 `/Users/...`、文件名冒号换 `-`、双引号转义、取消按 `-128` 判）；Linux/BSD 按 zenity → kdialog → qarma → matedialog 探测，GTK 系与 KDE 系各用一套开关，一个都没装（无头/容器）→ 降级。三平台统一补 `.dsproj` 扩展名、统一 `RESULT:` 单行契约 |
| F49 | 打开记忆目录 | `MemoryNotice` 走 `remote.session.openWorkspacePath({ path, action: 'reveal' })`，`inject` 里声明 `remote` 与 `remote.session`。**不得**调 `uiWorkspace.openPath`——DSH 的 `uiWorkspace` 没有这个方法，`typeof … === 'function'` 恒假，按钮点了没反应且不报错。目录只能用 `reveal`（省略 `action` 是「用默认应用打开」，对目录会失败） |

## 二、测试矩阵（用例 → 期望 → 覆盖）

### 七套回归

| 套件 | 条数 | 覆盖功能 | 关键期望 |
| --- | --- | --- | --- |
| `test/pathkey.mjs` | 35 | F13（`findSessionFile` 的目录派生）、F21 | `projectKey`/`encodeSegment` 与官方 rc.4 逐字一致：16 档 cwd 与内置 oracle 全等（含尾部分隔符不剪 `-`、根路径 `--root--`、emoji 拆代理对 `~D83D~DE00`、`~` 自身转义、251 截断）；4 条钉死形态独立断言；空串退回 `_no-cwd` 且 oracle 确实抛错（证明是有意偏离）；8 档 session id；磁盘实例形状核对 |
| `test/dialog.mjs` | 16 | F3、F46、F47、F48 | 三平台选择器各自按依赖存在性判定（win32 看 `powershell.exe`、darwin 看 `/usr/bin/osascript`、linux/BSD 找 zenity/kdialog/qarma/matedialog，都没有 → `null` 降级），并用注入的假探测函数在 Windows 上验 mac/linux 分支；实现缓存按平台隔离（先问无用平台不污染真实平台）；共用工具 `lookPath`/`ensureExtension`/`sanitizeForAppleScript`/`resultLine`；macOS 的 AppleScript 文本（`POSIX file` 包装、引号转义、冒号消毒）；Linux 的 zenity 与 kdialog 两套开关分别拼对（`--getsavefilename` 收完整建议路径 vs `--filename=`，kdialog 空目录回落 `.`）；zenity 优先级高于 kdialog；Windows 脚本带 BOM、`OutputEncoding`、`-ResultFile` 三件套齐；中文路径往返不乱码；取消 → `null`；脚本缺失 → `undefined`；乱码 stdout 不覆盖结果文件 |
| `test/client.mjs` | 6 | F34、F35、F37、F49 | 5 个插槽项 id/order/插槽名正确；另存为是独立图标且点击带 `ask=1`；hero 按钮点击打 `api/session.open`；源码不含 `document.`/`MutationObserver`；7 个记忆相关 i18n 键中英各一份；`inject` 含 `remote`/`remote.session` 且源码不含 `uiWorkspace.openPath`、含 `openWorkspacePath` 与 `action: 'reveal'` |
| `test/smoke.mjs` | 1（12 处 throw 检查） | F1、F8、F10、F12 | 夹具会话 → 打包 → 回读 ZIP 首条目 zstd magic、必有 `manifest.json`/`SUMMARY.md`/`session/`；二次保存复用同一路径；默认文件名规则与非法字符替换；无标题兜底名 |
| `test/open.mjs` | 35 | F13–F21、F23 | 复用不写盘；新 cwd 落地并改写 header；`need-workspace` 列工作区；选好工作区后打开；帧 1..n 原字节一致；坏路径 404 且不回显 |
| `test/conflict.mjs` | 67 | F5–F7、F11、F28–F32、F44 | 四种冲突顺序 ask→reuse→copy→overwrite；覆盖前留 `.bak`；异机新鲜锁给理由；CAS 409 与 `force`；自动保存钩子写盘并递增 `writes`；关闭后不再写；同步盘识别；目录复原 |
| `test/security.mjs` | 100 | F22–F27、F38–F43 | V1 越界条目读包即拒；V2 恶意 `fileName` 被收敛；V3 200 MB / 1026:1 在解压前拒绝；V4 目录外 400 且不建树；V5 非 id 400；V6 不回显路径；V7 `parts` 不符 500；V8 跨站 403；R1 未声明条目拒绝；R4 默认永不落原名；R6 restore 只覆盖已有、`memory=new` 才新建 |

合计 **260 条**。

### 审计验收脚本（未随仓库分发）

| 脚本 | 结果 | 说明 |
| --- | --- | --- |
| `verify-r6.mjs` | 25/25 | R6 语义：restore 不新建、`memory=new` 新建、越界/未声明仍拒 |
| `verify-r5.mjs` | 18/18 | R5 通道：restore 覆盖 + 备份 + 幂等（case 3 已按 R6 语义先建本机文件） |
| `poc4b-copy-mode.mjs` | 4/4 | 自洽 `parts` 投毒包在默认模式下不落任何原名文件 |
| `verify-fix.mjs` | 7/7 | V1/V2/V3a/V3b 防护未破，合法包仍可导入 |
| `probe-p0.mjs` | 42/42 | 四条路由在畸形请求（坏 URL、缺 headers、`headers.get` 抛异常、`request` 为 null）下**一律返回 JSON Response，不抛异常** |

## 三、P0 风险清单与结论

| 风险类别 | 若失守的后果 | 现状 |
| --- | --- | --- |
| 路径穿越（写盘逃逸） | 任意位置写文件 → 可投递到启动目录 | F40/F41 覆盖，`security.mjs` 与 `verify-fix.mjs` 盯 |
| 解压炸弹 | 内存/磁盘打爆 | F42 覆盖，`security.mjs` 断言 200 MB 与 1026:1 在解压前被拒 |
| 记忆投毒（prompt injection） | 模型读到攻击者写的项目笔记 | F23/F24/F43 覆盖：默认落副本、restore 只覆盖已有、未声明条目拒绝 |
| 路由越权 | 任意网页/远端可调用 | F38 覆盖，含「`headers.get` 抛异常」这一条——本轮实测发现 `requestGate` 未兜住会 reject，已修 |
| 数据丢失（覆盖/半截写） | 用户工程被毁 | F5/F6/F7/F12/F45 覆盖：覆盖确认、CAS、锁、原子写 |
| 会话 id 冲突 | 两条历史混成一条 | F17 覆盖：id 全机唯一，relocate 换新 id |
| 汉名乱码 | 文件名/路径损坏 | F46 覆盖，`dialog.mjs` 里有独立断言 |
| 平台判断错 | 点保存才抛 ENOENT / 非 Windows 崩 | F47 覆盖：开窗前按依赖存在性判掉，`dialog.mjs` 有选择器（三平台各一组）与缓存隔离两组断言 |
| 非 Windows 没有原生窗口 | macOS / Linux 用户只能用网页输入框 | F48：macOS 有 `osascript` 就用 Finder 面板，Linux 探到 zenity/kdialog 就用 GTK/KDE 面板，都没有才降级 |

**已修**：`requestGate` 读 `headers.get('host'/'origin'/'sec-fetch-site')` 时未加保护，畸形 `Headers` 实现（或 `get` 抛异常）会让 handler reject，请求变成非 JSON 失败。现为一次性 try 包住三个头读取，失败即返回「请求头读不出来，拒绝处理」→ 403。`probe-p0.mjs` 42/42。

## 四、怎么跑

```bash
node --check index.js client.js
node test/dialog.mjs
node test/client.mjs
DSH_TEST_LOCALE=en-US node test/client.mjs    # 英文词表那一轮（改过客户端才需要）
node test/smoke.mjs
node test/open.mjs
node test/conflict.mjs
node test/security.mjs
node test/pathkey.mjs
# 或一把梭：260 条全绿
for f in client dialog smoke open conflict security pathkey; do node test/$f.mjs || exit 1; done
```

`pathkey.mjs` 只依赖 `index.js` 里的两个纯函数，不建夹具、不写盘，跑起来几十毫秒——**每次升级 DSH 后第一件事就是跑它**，比读官方源码快。

跑完看末尾是否都打印「自检通过」，以及 `test/` 自己报的临时目录清理行。**不需要**再去核对 `~/.dsh` 里的会话/记忆目录数——夹具从不碰真实 `~/.dsh`（早期版本会碰，那正是"换台机器必红"的原因）。
