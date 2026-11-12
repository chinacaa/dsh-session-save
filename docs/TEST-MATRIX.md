# 功能清单与测试矩阵

本文从代码反推功能面（`index.js` 四条路由 + `client.js` 五个插槽项），逐条列出可观测行为、期望结果，以及由哪套测试覆盖。测试分两层：

- **二十三套自动化回归**（`test/*.mjs`）：`node test/<name>.mjs` 单独可跑，共 708 条用例（`grep -c '✅'` 逐行相加的实测值）。`smoke.mjs` 用 `throw` 断言、只在末尾打一行汇总，表里按 1 计（实际 12 处检查）。
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
| F28 | 查询状态 | `sessionId` | 200 `{status:'ok', enabled, path, cloud, stale, missing}`；`missing` 只在目标文件消失过时出现，形如 `{path, detectedAt}` |
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
| F50 | 保存前确认目标还在 | 保存的目标是「那个路径上的那个文件」，不是「那个路径」。①手动保存：走「记住的路径」（`reusedRemembered`）且没带 `recreate=1` 时先 `fs.existsSync(target)`，不在就返回 `409 {status:'missing-target', path, name, dir, suggested}`，**一个字节都不写**；写盘阶段抛 `ENOENT` 也归到这个状态而不是 500。②自动保存：`autosaveOnce` 在 `lockBlocks` 之后、`staleOf` 之前先查目标在不在，不在就 `delete state.autosave[id]` + 记 `state.missing[id] = {path, detectedAt}` 后直接返回；`catch` 里的 `ENOENT` / 「目标目录不存在」同样走这条熔断。③打包写入一律 `writeAtomic(..., { createDir: false })`，目录不存在抛「目标目录不存在」，不再 `mkdir -p` 顺手把目录和文件一起造出来。④`missing` 在打开成功、保存成功、自动保存成功后清掉 |
| F51 | 附件随包带走与回填 | 会话日志只存 `sha256:` 引用，图片/文件字节在 `DSH_HOME/attachments/v1/{objects,file-objects}/<前2>/<sha64>` 的独立对象库——只导日志的包换机打开必然 `ATTACHMENT_NOT_FOUND`，且重试不自愈。①打包：`attachmentRefs(buf)` 从解压后的日志文本抓 `attachmentId` / `fileId` 的 `sha256:` 引用（正则容忍 JSON 内嵌时被转义的引号），逐条去对象库读，**读出来重算哈希对不上就不带**，条目名 `attachments/<objects\|files>/<前2>/<sha256>`；本机没有的记进 `manifest.attachments.missing` 并写进 `SUMMARY.md`；`options.includeAttachments === false` 可关。②回填：`restoreAttachments(entries)` 三道校验——条目名匹配 `ATTACH_ENTRY_RE`、分片目录必须等于哈希前两位、`cryptoHash(data) === sha`，任一不成立计 `rejected` 跳过；目标已存在计 `skipped`（内容寻址幂等）；落盘映射 `objects → objects`、`files → file-objects`。③`ENTRY_ALLOW` 与 `CONTENT_ENTRY` 放行 `attachments/` 前缀，`verifyPackage` 仍要求这些条目在 `parts` 里声明。④导入返回值新增 `attachmentsWritten` / `attachmentsSkipped` / `attachmentsRejected` |

## 二、测试矩阵（用例 → 期望 → 覆盖）

### 二十三套回归

| 套件 | 条数 | 覆盖功能 | 关键期望 |
| --- | --- | --- | --- |
| `test/pathkey.mjs` | 35 | F13（`findSessionFile` 的目录派生）、F21 | `projectKey`/`encodeSegment` 与官方 rc.4 逐字一致：16 档 cwd 与内置 oracle 全等（含尾部分隔符不剪 `-`、根路径 `--root--`、emoji 拆代理对 `~D83D~DE00`、`~` 自身转义、251 截断）；4 条钉死形态独立断言；空串退回 `_no-cwd` 且 oracle 确实抛错（证明是有意偏离）；8 档 session id；磁盘实例形状核对 |
| `test/dialog.mjs` | 17 | F3、F46、F47、F48 | 三平台选择器各自按依赖存在性判定（win32 看 `powershell.exe`、darwin 看 `/usr/bin/osascript`、linux/BSD 找 zenity/kdialog/qarma/matedialog，都没有 → `null` 降级），并用注入的假探测函数在 Windows 上验 mac/linux 分支；实现缓存按平台隔离（先问无用平台不污染真实平台）；共用工具 `lookPath`/`ensureExtension`/`sanitizeForAppleScript`/`resultLine`；macOS 的 AppleScript 文本（`POSIX file` 包装、引号转义、冒号消毒）；Linux 的 zenity 与 kdialog 两套开关分别拼对（`--getsavefilename` 收完整建议路径 vs `--filename=`，kdialog 空目录回落 `.`）；zenity 优先级高于 kdialog；Windows 脚本带 BOM、`OutputEncoding`、`-ResultFile` 三件套齐；中文路径往返不乱码；取消 → `null`；脚本缺失 → `undefined`；乱码 stdout 不覆盖结果文件；R10 结果目录用 `mkdtemp` 每次独占、文件名不再由 pid + 时间戳拼（两者都能猜）、收尾连目录一起删、正常路径摘掉 exit 监听 |
| `test/client.mjs` | 11 | F34、F35、F37、F49、F50 | 5 个插槽项 id/order/插槽名正确；另存为是独立图标且点击带 `ask=1`；hero 按钮点击打 `api/session.open`；源码不含 `document.`/`MutationObserver`；7 个记忆相关 i18n 键中英各一份；`inject` 含 `remote`/`remote.session` 且源码不含 `uiWorkspace.openPath`、含 `openWorkspacePath` 与 `action: 'reveal'`；5 个 missing 相关 i18n 键中英各一份、`MissingModal` 存在、`payload.status === 'missing-target'` 被接住、`recreate: '1'` 传给保存路由、自动保存自停时把原路径说出来；`attachRejected`/`badWorkspace`/`memoryMergeTarget` 中英各一份、`payload.attachmentsRejected` 与 `payload?.memoryDir` 被读、`bad-workspace` 被接住且回落 `L.badWorkspace` |
| `test/smoke.mjs` | 1（12 处 throw 检查） | F1、F8、F10、F12 | 夹具会话 → 打包 → 回读 ZIP 首条目 zstd magic、必有 `manifest.json`/`SUMMARY.md`/`session/`；二次保存复用同一路径；默认文件名规则与非法字符替换；无标题兜底名 |
| `test/open.mjs` | 40 | F13–F21、F23 | 复用不写盘；新 cwd 落地并改写 header；`need-workspace` 列工作区；选好工作区后打开；帧 1..n 原字节一致；坏路径 404 且不回显 |
| `test/conflict.mjs` | 67 | F5–F7、F11、F28–F32、F44 | 四种冲突顺序 ask→reuse→copy→overwrite；覆盖前留 `.bak`；异机新鲜锁给理由；CAS 409 与 `force`；自动保存钩子写盘并递增 `writes`；关闭后不再写；同步盘识别；目录复原 |
| `test/audit-r2.mjs` | 18 | F69–F79 | B1 单个巨轮被裁且 tokensAfter 变小；B2 尾轮超大同样标 oversizeTurn；B3 86 汉字不误拒；B4 84 汉字 + copy 后缀不误拒；B5 NFD 名不误拒；B6 带端口 host 报 bad-host 且不串槽位；B7 炸弹包失败后无空目录；B8 标题不被提到文件最前；B9 无 `Atomics.wait(`；B10 状态写支持 scoped；B11 `isDsprojFile` 不整文件读；B12 改读 EOCD；B13 `[v6]` 剥端口 |
| `test/audit-r3.mjs` | 46 | R3-1–R3-8 | 坏包/截断包走 `package-broken` 而不是裸 500；落盘名前逐段校验（尾点、ADS 冒号、CON/NUL）且被拒时零残留；`writeAtomic` 失败后 ADS 裸文件被清掉；未来时间戳的锁放行、侧车锁冲突是 409 且 `ignoreLock` 能真绕过；`trimSession` 没丢东西不再报 `trimmed:true`；`ENTRY_SINCE` 每项 ≤ `PLUGIN_VERSION` |
| `test/audit-r4.mjs` | 36 | F80–F84 | U1 累计超上限抛 `E_LOG_TOO_LARGE` 且文案说「包太大、不是损坏」，默认额度下多帧包照常；U2 末帧缺 checksum 时帧表少一帧、`truncated` 为真、体检报告带出、覆盖率闸拒写；U3 校验失败包不落 `paths`、成功包记下 `paths` 与 `stamps`、别的会话键原样保留；U4 root 是链接 / dest 是链接 / dest 经链接逃出 root 三种情形（前两者判是、逃出判否）；U5 别工区 slug → `memoryForeign:true` + `memoryForeignSlug` + 实际落点，同工区不误报 |
| `test/audit-r1.mjs` | 17 | F62–F68 | A1 RLE 帧能被认出且覆盖到末尾；A2 三帧（中间 RLE）扫出三帧；A3 重写 header 后正文帧不丢；A4 扫描不完整时 `rewriteHeader` 抛错；A5 200 MB 炸弹包被拒；A6 失败后 sessions 里无 0 字节文件；A7–A9 ADS / 尾点 / 设备名的记忆条目被拒；A10 保存到不存在的多级目录被拒且不建目录；A11 relocate 后 bili 记 `renamed`；A12 `__proto__` 的 header.id 被拒 |
| `test/security.mjs` | 198 | F22–F27、F38–F43、F50、F61 | V1 越界条目读包即拒；V2 恶意 `fileName` 被收敛；V3 200 MB / 1026:1 在解压前拒绝；V4 目录外 400 且不建树；V5 非 id 400；V6 不回显路径；V7 `parts` 不符 500；V8 跨站 403；R1 未声明条目拒绝；R4 默认永不落原名；R6 restore 只覆盖已有、`memory=new` 才新建；V12 记住的文件被删后再存必须 409 `missing-target` 且不重建、`recreate=1` 才落地、成功后清 `missing`；V12b 自动保存发现目标消失后自己关掉并带回原路径、不重建；R7 附件条目 64 KB 起就算压缩比（3 MiB 全零 → 500 且对象库零写入）、2001 个附件只写 2000、超 128 MB 截断、正常包不受影响、已存在的不占配额；R8 六处解压单帧 64 MB 上限（900 MB 炸弹抛 `ERR_BUFFER_TOO_LARGE` 而**不是**当成坏帧静默跳过）、打包与体检的全解路径另有 512 MB 累计预算；R9 cwd 是普通文件或不存在的目录 → 400 `bad-workspace` 且不建目录、拒绝时回显包内原路径 + `reason`（`not-directory` / `missing`）+ 本机可用工作区，`ws` 与 `ws\` 落到两个记忆目录且不覆盖原 `MEMORY.md`；R10 打开失败只回通用文案、会话日志用临时文件 + `rename` 原子落盘、`wx` 撞名重试、部分失败时目录不残留 |
| `test/remote.mjs` | 26 | F85 | 非回环 Host + 同源 Origin 放行（200 / zip）；跨源 Origin 403；非回环无 Origin 且 `cross-site` 403、`same-origin` 放行；`deliver=download` 响应是 zip、带 `attachment` 与 `filename*=UTF-8''`、目录里没多出文件；`upload=1` 能打开且临时目录已清；空上传 400；客户端有 `isRemoteHost`、走 `deliver: 'download'`/`upload: '1'`、用 React 渲染的 file input、远程不注册 `session-autosave`、源码无 `document.` |

| F52 | 打开前体检自愈 | 包可能来自别的机器、中间也可能有文件被删过，会话里就会留下打不开的东西。`repairSession(buffer, options)` 在导入落盘前扫一遍：①逐帧 `zstdDecompressSync`，解不开的帧**原样保留原字节**并计 `frames.broken`（不替用户丢帧）；②逐行 `JSON.parse`，失败计 `lines.dropped` 并丢弃该行，同帧其余事件照常保留；③`repairPartNode` 递归遍历，**两种 image 形状都认**——`node.attachment` 对象（含 `attachmentId`/`mediaType`/`bytes`/`width`/`height`/`name`）与扁平 `node.attachmentId`。对象在本机不存在（`hasAttachmentObject('objects', sha)` 为假）→ 换成 `{type:'text', text:'[图片已丢失：<name>]'}`，计 `parts.missing`/`parts.dropped`；`keepMissing: true` 时只计数不改字节。对象在但 `width`/`height`/`bytes` 缺失或非正数、或 `mediaType` 不在 `image/png\|jpeg\|webp\|gif` 白名单 → 用 `imageInfoOf(buf)` 按文件头（PNG/GIF/WebP/JPEG）补齐，计 `parts.patched`；扁平形状没有这些字段，对象在就原样返回（不凭猜补）。④只有真改过的帧用 `zstdCompressSync(payload, CHECKSUM_OPTIONS)` 重压，未改帧逐字节沿用，帧结构不变；⑤返回 `{ buffer, report }`，`report = { frames:{total,broken}, lines:{total,dropped}, parts:{total,missing,patched,dropped}, changed, notes }`。⑥`importPackage` 里顺序固定为「先 `restoreAttachments(entries)` 回填附件 → 再 `repairSession(finalBuf)` → 才 `fs.writeFileSync`」：反了就会把包里自带的图判成缺失换成占位。⑦「本机已经有这份会话」的两条早退分支（同 id 同 cwd 的 `reused`、`mode === 'reuse'`）也走 `repairInPlace(existing.file)`，只在 `changed` 为真时 `writeAtomic` 写回——用户在同一台机器上重开自己的包走的正是这条路。⑧导入返回值新增 `repair` 报告 |
| `test/attach.mjs` | 11 | F51 | A1 日志里只有 `sha256:` 引用、对象库有字节时，包内出现 1 个 `attachments/objects/<前2>/<sha>` 且 manifest 记账正确；A2 同一张图被引用两次只带一份（内容寻址去重）；A3 本机缺对象时包照常出、`manifest.attachments.missing` 记下该哈希、`SUMMARY.md` 说明缺几个；A4 对象库里的字节被改坏（哈希对不上）时不带；A5 导入回填把对象写进新 DSH_HOME 的 `objects/`；A6 再导一次是 `skipped` 不是 `written`、文件 mtime 不变；A7 被篡改的包内条目（内容与名字不符）计 `rejected` 且不落盘；A8 分片目录与哈希前缀不符同样 `rejected`；A9 `objects` 与 `file-objects` 两个池分开落盘；A10 `includeAttachments: false` 时一个附件条目都不带；A11 包内附件条目必须在 `parts` 里声明，否则 `verifyPackage` 拒绝 |

| F53 | 包比我新时说「升级」而不是「包坏了」 | 包格式新增 `manifest.plugin = { name, version }`（`PLUGIN_VERSION` 从同目录 `package.json` 读，读不到退 `0.0.0`）。`verifyPackage` 撞到 `ENTRY_ALLOW` 白名单外的条目时不再直接抛固定文案，交给 `unknownEntryMessage(entryName, manifest)`：①包写了版本且 `compareVersions(writer, PLUGIN_VERSION) > 0` → 「这个包来自更新版本的 dsh-session-save（写它的是 X，本机是 Y）：先升级插件再打开。包本身没坏」；②包没写版本时用 `ENTRY_SINCE`（`[/^attachments\//, '0.3.0']`）反推这类条目从哪个版本起才有，若比本版新同样提示升级；③都不成立（同版本 / 更旧的包 / 纯陌生条目）→ 保持原文案「包里有不认识的条目，拒绝打开」，不拿版本当借口糊掉真异常。`compareVersions` 只比点分数字段、丢弃 `-rc.1` 后缀，回答的是「谁更新」，不承担包格式兼容判断（那看 `FORMAT`）。提示文案不含路径，`handleOpen` 的 `leaksPath` 判据因此不会把它替换成通用文案 |
| F54 | zstd 帧解压有上限 | 会话日志是「多个 zstd 帧拼接」，`zipRead` 那层 64 MB 只管 DEFLATE 那一层；帧里再套一层 zstd 就能绕过去（实测第 0 帧写成 900 MB 空白、包只有 `29,558` 字节，一打开 RSS +937 MB）。现在六处解压（`zipRead`、`readStats`、`readHeader`、`scanZstdFrames` 的调用方、`repairSession`、`importPackage`）统一走 `decompressFrame(buf, maxOutputLength = MAX_FRAME_BYTES)`（64 MB），超限抛 `ERR_BUFFER_TOO_LARGE`；**绝不能把它当成「这帧坏了、跳过」**——那样炸弹包会被静默当空会话打开，比报错更糟。打包与体检这两条会把所有帧都解开的路径另加一层累计预算（`MAX_TOTAL_INFLATED_BYTES = 512 MB`），挡住「几百帧各几十 MB」 |
| F55 | 落点必须是目录，记忆不许模糊匹配 | ①`landingCwd(preferred)` 用 `fs.statSync(preferred).isDirectory()` 判（`existsSync` 对普通文件也返回真，旧逻辑会在 `sessions/` 下建出以文件路径为键的目录），不是目录就抛；只有 preferred 为空才回落 `process.cwd()`，不再静默换地方。`importPackage` 捕获后返回 `{status:'bad-workspace', message:'这个位置不是一个可用的目录'}`（不含任何路径），`handleOpen` 用 **400** 回它（包没坏、是位置不对），客户端弹提示而不是继续走 `opened` 分支去 `rememberSource`。②`resolveMemoryDir` 删掉第三级 `normSlug` 模糊匹配（它抹平大小写、`-`、尾分隔符，`ws` 与 `ws\` 会命中同一个记忆目录，restore 下就跨工作区覆盖 `MEMORY.md`），只留两级精确候选，找不到返回 `undefined`（另建新目录）。路径相等只认 `path.resolve` 后逐段比，绝不用「归一化后相等」当判据 |
| F56 | 五条 Low 收尾 | ①`importPackage` 不再预先 `mkdirSync(targetDir)`：先写会话文件，成功后才建记忆目录（过去目录建了、写会话失败就留一个空壳）。②`handleOpen` 的 500 只回通用文案，不再把原始错误文本拼进去（`leaksPath` 判据留给正常返回体）。③会话日志先写 `session.v4.jsonl.zstd.tmp-<pid>-<时间>` 再 `rename` 原子落盘，并用 `wx` 打开临时文件撞名重试；`rename` 失败只清自己的临时文件。④`workspaces` 路由补 `try/catch`，抛错走 500 通用文案而不是让桥接层兜。⑤`dialog/windows.mjs` 的结果目录改用 `fs.mkdtempSync` 每次独占（原来是 `os.tmpdir()` 下 pid + 时间戳拼的可预测名，多进程/多用户可抢先占位），收尾连目录一起删，并摘掉 exit 监听避免反复弹窗堆到 `MaxListenersExceeded` |
| `test/repair.mjs` | 9 | F52 | R1 干净日志 `changed=false` 且 `buffer.equals(clean)`、帧数不变；R2 断链图换成 `[图片已丢失：lost.png]` 且会话里再无 `"type":"image"`；R3 缺尺寸的图按 PNG 头补成 640x480、`bytes` 等于真实字节数、`attachmentId` 未变；R4 坏行被丢、`lines.total` 仍按实际行数计、剩余行全部可 parse；R5 两帧结构下只有被改的那帧重写、另一帧字节 `equals` 不变；R6 `keepMissing: true` 时 `changed=false` 但仍报 `parts.missing=1`；R7 扁平 `attachmentId` 与嵌套 `attachment` 两种形状都认（断链换占位、健康的不动）；R8 修完 header 仍可读、`type==='session'`、id 一致，且对象库里的字节没有被碰 |
| `test/version.mjs` | 7 | F53 | V1 `compareVersions` 五种情形（9.9.9 > 0.3.1、0.3.10 > 0.3.9 按数值比、1.0.0 > 0.9.9、自己跟自己相等、`0.3.0-rc.1` 丢后缀后等于 `0.3.0`）；V2 打出来的包 `manifest.plugin.name === 'dsh-session-save'` 且 `version` 等于 `package.json` 的版本；V3 把包改成「9.9.9 写的」并塞一条本版不认识的 `previews/…` 条目 → 打开返回 500，提示含「更新版本」「9.9.9」本机版本「升级」，且不含盘符路径；V4 同版本 + 陌生条目 → 仍报「不认识的条目」，不说「更新版本」；V5 删掉 `plugin` 字段的老包 + 陌生条目 → 照旧拒绝、不崩；V6 正常包照常打开（改了校验不等于改了放行） |
| `test/bili.mjs` | 13 | F60 | B1 状态文件按 host + sha256(id) 前 24 位命名；B2 打包进 `bili/session.json`；B3 块内 plugin/schema/sessionId/protocol 齐全；B4 `manifest.bili.present` 与 `savedAt`；B5 导入回填 `written=1` 且路径一致；B6 本机更新时不覆盖；B7 schema≠3 不写盘；B8 未装 bili 照常 200；B9 老包 `absent`；B10 块里是别的 sessionId 时拒绝写入且不建别人的槽位；B11 protocol/host 带分隔符时落回默认目录、不逃出会话目录 |
| `test/roundtrip.mjs` | 91 | F1、F2、F13、F51、F52、F59、F61 | A 真实会话往返：样本取自本机 `session-403aa63e…`（4708 帧 / 21 MB）的前 10 帧，导出后 `manifest.session.frames` 与 `parts` 逐条 sha256/bytes 与包内实体一致；导进另一个 `DSH_HOME` 后 id / createdAt / cwd / 帧数原样回来，解压文本逐字一致；体检改过时行数账目与 `repair.notes` 对得上；干净合成会话导入后字节级一致；再打开走 `reused`；`contextBudget=3000` 时报告账目自洽（kept + dropped = 总轮次）、落盘 `turn/start` 数仍等于全部轮次且 `applied=false`（存档不被改）。C 附件：图片与文件对象进包、缺的进 `manifest.attachments.missing`、删掉本机对象后导入回填且字节一致、再导入幂等（0 写 2 跳过）、内容与文件名不符的对象计 `rejected` 且不落盘。D 备份开关四个覆盖点：冲突选覆盖（`.bak` 等于被覆盖前的字节）、记忆 restore（`.bak` 是原文、返回体带备份路径）、bili 状态（`.bak` 是旧状态）、磁盘被改后 `force=1` 与覆盖陌生同名包；每处都验 `backup=0` 时不多出 `.bak` 而内容照样换。E 冲突载荷（两侧 id/createdAt/`lock`）与记忆清单 `memoryPlanned.exists`、默认不落原名 |
| `test/backup-ui.mjs` | 37 | F34、F58、F61 | 带真状态的小号 React 挂载组件：陈旧弹窗（`stale` → `StaleModal`）勾着点覆盖 → `force=1&backup=1`，取消勾选 → `backup=0`；冲突弹窗（`conflict` 409）选覆盖 → `onConflict=overwrite&backup=1`，选另存为副本 → `copy&backup=0`；合并记忆（`memoryMode=copy` 的 `MemoryNotice` → `MemoryMergeModal`）确认 → `memory=restore&backup=1`，取消勾选 → `backup=0`；三个弹窗各只有一个复选框、默认勾选、文案取自语言包。文案完整性：`client.js` 里每个 `L.<key>`（剥掉注释后）都在两份语言包、中文兜底表无重复键且键数与 `zh-CN.json` 相等、`backupKeep` 兜底值与源语言一致、`scripts/check-locales.mjs` 通过 |
| `test/context.mjs` | 8 | F59 | C1 估算给出行数与 token（token < 字节）；C2 预算够时 `trimmed=false` 且 buffer 逐字节不变（不重压）；C3 超预算从尾保留完整 turn、token 真降；C4 裁完 header 在、id 未改、每行可解析、`turn/start` 与 `turn/end` 成对；C5 turn 号重排为 1..N 连续；C6 省略说明恰一条且写明轮数；C7 零轮会话不炸 |
| `test/open-repair.mjs` | 6 | F52 | 端到端走真实路由 save → open：O1 会话里放一个本机没有的 image 对象，打包照常成功；O2 打开返回 `repair.parts.missing=1` / `dropped=1` / `changed=true` 且 `notes` 非空；O3 落盘的会话文件里已无 `"type":"image"`、留有可读占位；O4 同一份包再打开不再报缺失（体检幂等）；O5 全程不碰夹具外的路径 |

| F57 | 三处「只能报错」给出下一步 | ①`replaceFile=1`：`landingCwd` 判 `not-directory` 时把占位文件改名成 `<原名>.bak-<时间戳>` 并建目录，失败改回原名；返回体 `canReplace` / `replacedFile`。②`ignoreLock=1`：锁判定改成 `!force && !ignoreLock`，409 带 `canIgnoreLock: true`；`stale` / 覆盖确认 / 类型判断不受影响。③`repairPackage=1`：`verifyPackage(..., { lenient: true })` 摘掉白名单外、哈希或体积不符、未声明的条目并返回 `dropped`；`importPackage` 重读一次再宽松校验，`session/` 被摘光仍拒绝；成功则 `packageRepair = { dropped, reason }` 并收窄 `manifest.attachments`。`packageBrokenReport()` 生成可复制的 `prompt`。 |
| F58 | 界面语言由语言包驱动 | `locales/<tag>.json` 是唯一真源（`zh-CN.json` 为源语言，114 键）；`index.js` 的 `listLocaleTags()` 只列目录里的 `*.json`，`resolveLocaleTag()` 先精确、再主语言前缀（`en` → `en-US`）、最后回 `zh-CN`，**绝不按请求字符串拼路径**（`?lang=../../package` 退化成中文）；`LOCALES_ROUTE = '/api/session.locales'` 过 `requestGate`（回环 Host + 同源 Origin，跨站 403），下发 `{status, lang, fallback, messages, available}`。客户端启动时 `void loadLocale()` 按 `navigator.language` 拉一次、`Object.assign(L, messages)` 就地合并（`L.xxx` 几百处直读，换引用等于重写），失败静默沿用内置中文兜底表。`scripts/check-locales.mjs` 校验 JSON 合法 / 值是字符串 / 键是源语言子集 / 占位符一致。 |
| F59 | 导入按上下文预算裁剪 | `estimateContext()` 逐帧解压累加行字节，按 `字节 / 3.2` 估 token；`trimSession()` 按 `turn/start`…`turn/end` 切块、从尾往前保留完整 turn 直到预算（它只算不写），返回报告 `{ trimmed, budget, turns, keptTurns, droppedTurns, tokensBefore, tokensAfter }`；`importPackage` 默认 `CONTEXT_BUDGET_TOKENS = 150000`，超预算时报告标 `applied: false` 且**落盘仍是完整日志**，`?contextBudget=0` 关、`?contextBudget=<n>` 自定义，返回体 `context: { before, trim }` |
| F60 | bili 压缩块随包 | `bili/session.json` 打包 bili 会话状态（`plugin` / `schema` / `sessionId` / `protocol` / `host` + 原状态），`manifest.bili` 记 `present` / `savedAt`；导入按 `<host>_<sha256(sessionId) 前 24 位>.json` 重建文件名写回。`schema` 不是 3 不写（`schema-mismatch`）、本机 `savedAt` 更新不覆盖（`newer-local`）、bili 没装记 `not-installed`、老包记 `absent`，四种都不是错误 |
| F61 | 覆盖前可选备份 | 冲突面板（`onConflict=overwrite`）、磁盘被改过（`force=1`）、合并记忆（`memory=restore`）三处都带「覆盖前先备份原文件」勾选框，默认勾选；请求侧 `backup=0` 关闭。关闭时会话覆盖、记忆覆盖、bili 状态覆盖都不建 `.bak-`，内容照样换成本机包里的那份 |
| F62 | 帧扫描按规范算 RLE | RLE 块载荷恒 1 字节（`type===1 → +1`），raw/compressed 加 `size`，`reserved` 视为不可解析；含 300 KB 连续空格的帧能被认出且覆盖到字节末尾，三帧日志扫出三帧 |
| F63 | 覆盖率闸与超限重抛 | `rewriteHeader` 要求认出来的帧覆盖整个文件，否则抛错拒写；`readStats` / `estimateContext` / `trimSession` / `readTitle` 遇 `ERR_BUFFER_TOO_LARGE` 一律重抛，炸弹包被拒且不落盘 |
| F64 | 导入失败不留空壳 | 目标文件 `wx` 占位之后，回填附件 / 体检 / 上下文裁剪任一步抛错都收掉空文件，重试不再 409 假冲突 |
| F65 | 包内路径段加严 | 每段拒绝 `[:<>"|?*]`、结尾点或空格、设备名（含带扩展名）、超 255 字节、非 NFC；ADS 与设备名写入被拒 |
| F66 | 侧车锁不建目录 | `withSidecarLock` 不再 `mkdirSync`，保存到不存在的多级目录被拒且不留下 `a/b/c` |
| F67 | relocate 后 bili 不写原槽位 | 换过 id 之后 `bili.reason` 记 `renamed`，副本不冒领原会话的折叠进度 |
| F68 | header.id 形态校验 | 导入时 `isSessionId(header.id)` 不通过就拒绝，`__proto__` 这类键进不了 `state.paths` |
| F69 | 预算管住单个超大 turn | 单轮超预算时从尾部按行切、保留 `turn/start`，并标 `oversizeTurn` / `stillOverBudget`；3 MB 单轮 + budget 100 → tokensAfter 982 → 182 |
| F70 | 段名按 UTF-16 码元判长 | `part.length > 255`；86 个汉字（258 字节）与 84 个汉字 + copy 后缀都能正常导入 |
| F71 | NFD 归一化而不是拒绝 | `part.normalize('NFC')` 后继续走全部校验；macOS 导出的 `e\u0301tude.md` 不再 500 |
| F72 | bili host 带端口如实拒绝 | `biliHostOf` 解析失败返回 `undefined`，`restoreBili` 报 `bad-host`，不写任何槽位 |
| F73 | 导入失败不留空目录 | 记 `dirExisted`，只在这次新建时 `rmdirSync`；炸弹包失败后 `sessions/` 无空目录 |
| F74 | 裁剪不搬 turn 之间的行 | 用 `seenTurn` 判头，两轮之间的 `session/title` 跟着前一轮 |
| F75 | restoreBili 不阻塞事件循环 | 去掉 `Atomics.wait`，新鲜即让开（`busy`） |
| F76 | `isDsprojFile` 不整文件读 | 读 EOCD + 中央目录判 manifest.json / session/*；大包不再误判 `not-dsproj` |
| F77 | 裸 IPv6 不被切开 | `[v6]:port` 与 `host:port` 分开剥；`::1` 仍判回环 |
| F78 | 状态文件按会话合并写 | `writeState(state, { scoped: [id] })` 只覆盖本次涉及的键 |
| F79 | 就地体检留备份 | `repairInPlace(file, { backup })` 改文件前留 `.bak-<时间>` |

| F80 | 全解路径的累计上限 | `estimateContext(buf, { maxBytes })` / `trimSession(buf, { budget, maxBytes })` 逐帧累加解出字节，越过 `MAX_TOTAL_BYTES` 抛 `E_LOG_TOO_LARGE`；打开路由把它映射成 `413 status:'too-large'`，文案为「会话日志解开后超过 512 MB，已停止读取：这个工程包太大，不是文件损坏」+ 下一步；默认额度下正常多帧包照常估算 |
| F81 | 末帧截断如实报告 | `scanZstdFramesDetailed(buf)` 返回 `{ frames, truncated }`：末块之后要读 checksum 的 4 字节，`p` 越过文件末尾则整帧不入帧表且 `truncated:true`；`repairSession().report.frames.truncated` 带出；`rewriteHeader` 的覆盖率闸据此拒绝重写并提示「末帧可能被截断」 |
| F82 | 状态只在成功路径提交 | `commitSource(result, id, source)` 在返回体成型后调用，`writeState(..., { scoped: [id] })` 只覆盖本次键；`handleOpen` 不再用打开前的快照整表写回（那会抹掉导入刚记下的 `stamps`）；`restoreBili` 回读校验失败时删掉刚写的那份（`removed`），让「没写」与磁盘一致 |
| F83 | `isInside` 解析符号链接 | 两端都走 `realTarget()`（从最深的已存在祖先 realpath 再拼回剩余段）后 `path.relative` 判前缀；root 自己是 junction、dest 是 junction 但仍在 root 内都判是，dest 经 junction 逃出 root 判否 |
| F84 | 跨工区记忆如实提示 | 包内 slug（`memory/workspaces/<slug>/…` 第一段）与本机 `memoryDirFor(cwd)` 解析出的 slug 不同时，返回体带 `memoryForeign:true` + `memoryForeignSlug`（落点仍由 `memoryDir` 给出）；合并记忆弹窗显示 `memoryForeignNote`（中英各一份），同工区不误报 |

| F85 | 非回环地址的远程访问 | Host 不是 `127.0.0.1`/`localhost`/`::1` 时（内网 IP、域名、反代），`requestGate` 的判据从「必须是回环」换成「必须同源」：有 Origin 要求 `parsed.host.toLowerCase() === host`，没有 Origin 只放行浏览器自己的同源导航（`sec-fetch-site` 为 `same-origin` / `none`），`cross-site` 一律拒。三条路由因此在内网可用：①`/api/session.save?deliver=download` 只 `buildPackage` 后直接回 zip，不落盘、不判锁、不写 `stamps`、不留备份，响应带 `content-disposition: attachment` 与 RFC 5987 的 `filename*`（中文标题不乱码）；②`/api/session.open?upload=1` 把 POST 来的字节落成 `os.tmpdir()` 下的临时 `.dsproj`，再走同一套导入流程（校验、体检、冲突判定一条不绕），`finally` 删临时目录，空体 400、超 `MAX_TOTAL_BYTES` 413 `too-large`；③客户端 `isRemoteHost()` 为真时不注册 `session-autosave` 槽位（那个开关写的是服务端机器上的文件，用户既看不到也带不走），保存走 `window.open` 下载，打开用 React 渲染的隐藏 file input + `ref.click()` 上传——组件里仍然不许出现 `document.` |

合计 **708 条**。

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
# 或一把梭：二十三套 708 条全绿
for f in pathkey client dialog smoke open conflict security attach repair open-repair version context bili roundtrip backup-ui audit-r1 audit-r2 audit-r3 audit-r4 ui-openwait dsh-list remote; do node test/$f.mjs || exit 1; done
```

`pathkey.mjs` 只依赖 `index.js` 里的两个纯函数，不建夹具、不写盘，跑起来几十毫秒——**每次升级 DSH 后第一件事就是跑它**，比读官方源码快。

跑完看末尾是否都打印「自检通过」，以及 `test/` 自己报的临时目录清理行。**不需要**再去核对 `~/.dsh` 里的会话/记忆目录数——夹具从不碰真实 `~/.dsh`（早期版本会碰，那正是"换台机器必红"的原因）。
