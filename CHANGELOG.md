# 变更记录

格式参照 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### 修复

- **坏包只回一句 500，修包指引永远拿不到（P1）。** `importPackage` 第一行的 `zipRead` 不在任何 try 里：不是 ZIP、中央目录/条目越界、单条或整包超限，全冒到 `handleOpen` 的兜底 catch，变成 `500 {"status":"error"}`。客户端是按 `status: 'package-broken'` 弹修复面板的，所以「把这段话贴给 AI 重新打包」这条出口对这些包根本不存在。现在解包阶段的抛错一律走 `packageBrokenReport`。
- **保存落点没有文件名校验，冒号路径留下 0 字节垃圾（P2）。** `?path=...ds:stream.dsproj` 只做了 roots 校验：`writeFileSync` 先按 ADS 语义建出裸文件 `ads`，`rename` 再 EINVAL，`unlink(tmp)` 只删掉数据流，`ads` 留在目录里。现在落盘前复用包内路径那套逐段校验（冒号、设备名、尾点、尾空格），并且 `writeAtomic` 失败时补删 ADS 前面那个裸文件；`x.dsproj.` 这种尾点也直接 400 而不是被补成 `x.dsproj..dsproj`。
- **未来时间戳的锁永不过期（P2）。** `lockBlocks` 写的是 `Date.now() - at < LOCK_STALE_MS`，时钟回拨或跨机同步让 `at` 落在未来时差值为负，判定恒真；侧车锁踩到这条路直接 `throw` → 500，还没有 `canIgnoreLock`，用户只能自己去删 `.lock`。现在取绝对值，并把侧车锁冲突映射成 `409 locked`（带 `canIgnoreLock`，`ignoreLock=1` 真的能跳过，stale / confirm-overwrite 那几条不受影响）。
- **`trimSession` 一刀没落也报 `trimmed: true`（P3）。** 单行就超过预算时（一行 200 KB 的 JSON）按行切切不动，`tail` 仍是整轮，却被标成 `partial`，于是 `droppedTurns: 0` 还报裁剪，插一条「更早的 0 轮没有带进上下文」，产物反而比原文大（64117 → 64232 tokens）。现在只有真被切掉行才标 `partial`，没丢东西就原样返回、`trimmed: false`、`oversizeTurn` 如实带出。
- **`ENTRY_SINCE` 把 `bili/` 标成未发布的 0.4.3（P3）。** 提示于是自相矛盾：「写它的是 0.4.2，本机是 0.4.2：先升级插件」。改成 0.4.2（真正首发版本），并加断言保证这张表的版本永远不大于 `PLUGIN_VERSION`。
- **附件被重新压缩时只丢一句「压缩比异常」（P2，不取消闸门）。** 别人用 7-Zip 重打包会把 1 MiB 文本压到 1 KB（约 1014:1），整包打不开。闸门保留——3 MiB 全零条目 935:1 的放大是真的（`test/security` R7 在守）——但提示改成「附件条目压缩比异常：被重新压缩过，本插件写包用 store」，指路而不是只报错。

### 已知边界

以下是第二轮审计确认、这一轮**没有修**的项，写在这里免得下次重新发现：

- **全解路径没有累计字节上限**（estimateContext / trimSession）。单帧上限管住了，累计没有：多帧各自合法、加起来很大时仍会吃满内存。
- **覆盖率闸只判「扫到哪」**：末帧缺 checksum 仍判完整。影响极低（要构造合法但尾部截断的 zstd 帧）。
- **`verify-failed` 时状态其实已写入**：返回体说没写，实际 `rememberSource` 已经落盘。
- **`isInside` 不解符号链接**：落点若是指向别处的 junction，判据看的是字面路径。
- **`memory=restore` 跨工作区覆盖不提示**：slug 不同即视为不同工作区，界面没有并列提示。

### 安全

- **上下文预算对「最后一轮自己就超预算」失效。** 收集循环用 `kept.length > 0` 让尾轮无条件保留：一次超长工具输出就能让 `budget: 100` 仍留下 98 万 token，report 还报 `trimmed: true`。现在单轮超预算时从尾部按行切（`turn/start` 一定留着，否则这一轮不成轮、轮次账目也对不上），并如实标 `oversizeTurn` / `stillOverBudget`。
- **包内路径段按字节卡 255，长中文名被整包拒。** Win32 的段名上限是 255 个 UTF-16 码元，不是 255 字节：86 个汉字 = 258 字节但只有 86 个字符，Windows 建得出来，这里却整包 500。另外 copy 模式追加的 `.from-dsproj-<日期>` 会把 84 个汉字的名字顶过线，同一份记忆 restore 能写、copy 写不了。现在按码元判长，后缀超长时截主名、保扩展名。
- **NFC 硬校验把 macOS 导出的 NFD 文件名整包拒掉。** macOS（HFS+/APFS）给的 `e\u0301tude.md` 在那边合法，这里一看不是 NFC 就 500——恰好打死「macOS 打包、Windows 打开」这个主场景。现在归一化到 NFC 再落盘，分隔符/设备名/尾点的判定在归一化后的串上照样跑。
- **bili 状态在 host 带端口时静默写错槽位。** `api.example.com:8443` 不匹配 host 白名单，就默默落到 `api.deepseek.com` 槽位、返回体还报 `ok`。现在如实报 `bad-host`（冒号在 Windows 文件名里非法，原样写必然 EINVAL，换字符又会写进 bili 永远找不到的槽位——拒绝比写错好）。
- **导入失败留下空会话目录。** 0 字节文件已经会清，目录没清；留着会被 `findExisting` 当成「本机已有这个会话」，后续走 reuse 分支拿着不存在的文件继续。现在只在「目录是这次建的」时才收掉。
- **裁剪把 turn 之间的行提到文件开头。** `head` 的判定只看 `current === undefined`，于是每轮结束到下一轮开始之间的 `session/title`、`session/updated` 也被吸进头部。现在用 `seenTurn` 判，两轮之间的行跟着前一轮走。
- **`restoreBili` 同步阻塞 120 ms。** `Atomics.wait` 卡住整个事件循环，导入一次卡一次；`importPackage` 是同步链，改成 async 会传染到路由，所以直接让开（`busy`）——bili 刚写过就说明它正在这个会话上干活。
- **`isDsprojFile` 用整文件大小当判据。** 带附件的大包（配额上限 128 MB）会被 `stat.size > MAX_ENTRY_BYTES` 判成「不是工程包」，于是「覆盖」对着自己的大包报 `not-dsproj`。现在只读 EOCD + 中央目录。
- **`requestGate` 把裸 IPv6 切成 `:`。** `::1` 走 `replace(/:\d+$/, '')` 变成 `:`，回环判据把合法请求也挡了。现在按 `[v6]:port` 形态剥端口。
- **状态文件按会话合并写。** 读-改-写之间隔着对话框等待，期间自动保存写了别的会话，整体覆盖会把那条改动抹掉。现在导入的三处写入只覆盖本次涉及的会话键。
- **就地体检不留备份。** `repairInPlace` 改会话文件（断链换占位、坏行丢弃）不可逆，现在与其它覆盖点共用 `backup` 开关，默认留 `.bak-<时间>`。
- **帧扫描按 zstd 规范算 RLE 块，扫描不完整时拒绝重写。** RLE 块的 `Block_Size` 是解压后大小、载荷恒 1 字节；早先按「非 RLE 才加 size」累加，RLE 块加 0 导致指针错位、后续块头变成垃圾，整帧被判成「没写完」丢掉。一条带 300 KB 连续空格的普通消息就能触发，随后换工作区打开时 `rewriteHeader` 把正文帧全扔了，还回 200 说一切正常。现在 `type===1 → +1`、`reserved → 不可解析`，并且 `rewriteHeader` 加覆盖率闸：认出来的帧必须覆盖整个文件，否则抛错拒写。
- **解压上限不再被绕过。** 扫描认不出帧时，体检与上下文估算会直接「原样返回」——7 KB 的包能落盘一帧解开 200 MB。现在超单帧上限的 `ERR_BUFFER_TOO_LARGE` 在 `readStats` / `estimateContext` / `trimSession` / `readTitle` 四处一律重抛，不许当成「这帧坏了、跳过」。
- **导入中途失败不再留 0 字节会话文件。** 目标文件的占位（`wx`）建好之后，回填附件、体检、上下文裁剪任何一步抛错，都会把空壳收掉；以前残留的空文件会让重试得到 409 假冲突。
- **包内路径段加严。** 除绝对路径与 `..` 外，每段还拒绝 `[:<>"|?*]`（Windows 上是 ADS 分隔符）、结尾的点或空格、设备名（`CON` / `NUL` / `COM1` 等，含带扩展名形式）、超过 255 字节，以及非 NFC 形式。
- **侧车锁不再替调用方建目录。** 锁文件顺手 `mkdirSync` 会架空 `writeAtomic({ createDir: false })`，保存到不存在的多级目录时留下孤儿包。
- **relocate / copy 不再把 bili 状态写回原槽位。** 换过 id 之后直接记 `renamed`，既不给副本冒领原会话的折叠进度，也不覆盖原会话。
- **导入校验 `header.id` 形态。** 只判「非空字符串」不够：该 id 会成为 `state.paths` 的键，`__proto__` 这类键会被 setter 吞掉。

### 修复

- **「覆盖磁盘文件」勾着备份却不备份。** 磁盘内容被别处改过后点覆盖，服务端的备份条件只看了「覆盖的不是自己记住的那个文件」，于是用户勾着默认勾选的「覆盖前先备份原文件」，一个 `.bak-<时间>` 都不留——同步盘/另一台机器改过的内容被直接抹掉，勾选框对这条路径等于摆设。现在 `staleOf()` 提到分支外算一次，`force=1` 时同样按勾选决定是否先备份；取消勾选照旧不留备份。

- **中文界面的备份勾选框显示英文。** `client.js` 的中文兜底表里 `backupKeep` 写了两遍，后一条是英文译文；对象字面量同名键后者覆盖前者，语言包到达前的中文首屏三个弹窗都显示 `Back up the original before overwriting`。删掉重复行。

### 新增

- **覆盖前可选留一份原文件。** 冲突面板（导入时选「覆盖」）、磁盘内容被改过的提示、合并记忆三个弹窗都多了一个默认勾选的「覆盖前先备份原文件」；取消勾选就真的不留 `.bak-<时间>`。保存到陌生文件时同样适用（这一路以前是直接覆盖，不留退路）。请求侧关闭开关是 `backup=0`，默认开启。

- **导入时按上下文预算从尾部保留完整轮次，默认 150000 token，不调就防爆。** 一条几百轮的会话折算下来是几十万到几千万 token，`billion-context` 这类在 wire 层做增量压缩的插件也接不住：它按会话记住自己已折叠过哪些消息，第一次见到一个从外面搬进来的会话时手里没有历史，只能把整包发上游。所以 `importPackage` 先 `estimateContext()` 量一下体量，超预算就 `trimSession()` 从最后一轮往前保留完整 turn，在头部插一条说明（省了几轮、完整日志仍在工程包里），turn 号重排为从 1 连续。只从轮次边界切，不会把工具调用与结果拆开；`?contextBudget=0` 关闭，`?contextBudget=<n>` 自定义。返回体新增 `context: { before, trim }`。
- **`.dsproj` 带上 billion-context 的压缩块。** bili 按会话 id 记住哪些消息已经折叠过，状态存在它自己的目录里；换台机器打开一个大会话时它手里没有这份历史，第一轮只能把整段重发一遍，而 bili 关掉了 DSH 的原生压缩，这一层没有兜底。现在导出会把状态打包成 `bili/session.json`（内含 `plugin` / `schema` / `sessionId` / `protocol` / `host` 与原始状态），导入按 `<host>_<sha256(sessionId) 前 24 位>.json` 重建文件名写回。只恢复这一个会话：块里的 `sessionId` 不是本次导入的会话就不写（记 `session-mismatch`），`protocol` / `host` 过白名单且落点必须仍在 bili 的会话目录内；bili 刚写过那一份（2 秒内）先等一下，仍新鲜就让开（记 `busy`），写完回读校验。三条边界：`schema` 不是 3 的不写、本机那份 `savedAt` 更新不覆盖（它带着包导出之后的对话）、bili 没装或包里没有这一条只记原因不算错。返回体新增 `bili: { written, skipped, rejected, reason }`。


## [0.4.2] - 2026-11-02

### 修复

- **同一个会话的第二份包点「覆盖」后，看到的还是旧内容。** 导入时「本机已有同 id、同创建时间、同工作区的会话」有一条捷径：直接打开本机那份、不写字节。它排在对 `onConflict` 的判断之前，所以用户明确选了「覆盖」也会被这条捷径截住，文件一个字节都没变。现在这条捷径只在「不是覆盖」时生效，覆盖会走真正的写盘路径（覆盖前留 `.bak-<时间>` 备份）；同会话但换了工作区的情况仍然另开一份，不会被当成覆盖目标。

### 文档

- **DSH 0.2.1-rc.5 的适配核对结论记进了 `docs/DSH-API-SURFACE.md` §6.4，核对基线随之从 `0.2.1-rc.4` 改为 `0.2.1-rc.5`（npm `latest`）。** 插件依赖的接口在 rc.4 → rc.5 之间没有变化：`conversation.*` 插槽两版各 72 个且集合完全相同，附件对象库仍是 `dshHome/attachments/v1`（`objects` 与 `file-objects` 分片路径一致），`projectKey`/`encodeSegment`/`projectDir` 计数相同，会话格式仍到 `v4` 没有 v5，`session/event`、`ctx.effect`、`ctx.get` 都在，`engines` 判定仍是 `dsh-app-boot/lib/index.js:276-284` 那句 `semver.satisfies(runtimeVersion, range, { includePrerelease: true })`。本机装的 `0.2.2-alpha.2` 作为附注一并验过，**代码一行未改**，十二套 394 条仍全绿。文里同时记了两条判据，免得下次误读：`0.2.1-rc.5` 未单独安装，结论是 rc.4 与 `0.2.2-alpha.2` 两端夹逼推断出来的，不写成「已实测」；旧版目录里的 `*.dshpurge.bak` 会让 `diff -rq` 把补丁差异算成版本差异，判版本差异只能按插件关心的符号 `grep` 计数。

## [0.4.0] - 2026-11-01

### 新增

- **界面文案搬出代码，别人可以 PR 别的语言。** 114 条文案从 `client.js` 挪进 `locales/zh-CN.json`（源语言）与 `locales/en-US.json`，启动时由 `/api/session.locales` 下发，前端按 `navigator.language` 挑一份、挑不到回中文；`client.js` 保留中文表做首屏兜底（语言包异步拉，等它回来就是白屏）。语言标签只从目录清单里挑，不按请求字符串拼路径——`?lang=../../package` 只会退化成中文。新加 `scripts/check-locales.mjs`（JSON 合法 / 值是字符串 / 键是源语言子集 / 占位符一致，少翻只提示不失败）与 `test/locales.mjs`（语言包形状、客户端不再留英文整表、路由回落与路径穿越、跨站 403，共 5 条）。
- **三处「以前只能报错收场」的地方，现在都给出了下一步。** ①目标位置被一个**文件**占着：过去只回「这个位置不是一个可用的目录」，用户得自己开资源管理器处理。现在带 `?replaceFile=1` 时把那个文件**改名备份**成 `<原名>.bak-<时间戳>`（不删，随时改回来）再建目录；改名成功但建目录失败会把文件改回原名，不留中间态；返回体给 `canReplace` 让界面决定要不要显示这个按钮。②保存时**别的窗口正占着这个包**：过去等 6×150ms 再回 409 就结束，用户只能反复点。现在 409 里带 `canIgnoreLock: true`，界面给「仍然保存」并传 `?ignoreLock=1` 跳过锁判定——**只跳锁**，`stale`、覆盖确认、`.dsproj` 类型这三道防丢数据的判断照旧。③**包校验不过**：过去只有一句「校验失败」。现在先分清「包比插件新」（走升级插件，包没坏）与真坏了；真坏了返回 `status: 'package-broken'` 并附一段可直接复制给 AI 的 `prompt`（包路径、体积、插件版本、报错原文、条目清单、包结构约定、五步修法、硬约束），界面提供「复制说明」与「丢掉坏条目后打开」；后者带 `?repairPackage=1` 走宽松校验，把哈希/体积对不上的条目从包里摘掉、清单写进 `packageRepair.dropped`，**会话日志摘光就仍然拒绝**——救不回会话的包不能硬塞进 `sessions/`。

- **打开前先体检，坏的地方顺手修掉。** 包是从别的机器来的、或者中间有文件被删过，会话里就可能留着打不开的东西：图片引用指向本机没有的对象（打开就是 `Attachment object is missing.`）、图片缺宽高与字节数、日志里有半行坏 JSON。这些过去要等用户自己撞上去才发现。现在 `importPackage` 落盘前先跑一遍 `repairSession`：**图片对象本机确实没有**的，把 `image` 部分换成可读的文字占位（`[图片已丢失：page-2.png]`），不再留一个必然报错的引用；**对象在、但 `width`/`height`/`bytes` 缺失或不是正数**的，按图片文件头把尺寸补齐（PNG/GIF/WebP/JPEG 四种头都读）；**整行 JSON 解析不了**的丢掉该行、保留同帧其余事件；**整帧解压不开**的原样保留字节、只记一笔——不替用户丢数据。只重压真的改过的那一帧，没动过的帧逐字节沿用，帧结构不变。导入返回值新增 `repair` 报告（`frames`/`lines`/`parts` 三段计数 + `changed` + `notes`），界面在打开后逐条说明改了什么。`repairSession(buffer, { keepMissing: true })` 可只体检不改字节。
- **包比插件新的时候，说的不再是「包坏了」。** 打开时白名单外的条目过去只会得到一句「包里有不认识的条目，拒绝打开：`attachments/objects/…`」——0.2.x 打开 0.3.0 的包就是这样，用户以为文件坏了，去翻备份重存一份，其实只是插件旧了。现在包里多了 `manifest.plugin = { name, version }`（写它的插件版本），读的一方先比版本：**包比我新**就明说「这个包来自更新版本的 dsh-session-save（写它的是 X，本机是 Y），先升级插件再打开；包本身没坏」，并保证不把服务器路径漏进提示。包没写版本时按「这类条目从哪个版本起才有」（`ENTRY_SINCE`）反推——0.2.x 认不出 `attachments/` 就知道至少要 0.3.0。**同版本却带了陌生条目**仍按「不认识的条目」拒绝：一句「你旧了」不能把真异常糊过去。

### 变更

- **宿主兼容范围闭合到 MINOR：`engines.dsh` 从 `>=0.2.1-rc.1` 改为 `>=0.2.1-rc.1 <0.3.0-0`。** 开口写法只声明了下限，dsh 哪天在 MINOR 里改了插槽契约或 `connection` 形状，插件还是会被装进一个它没见过的宿主里。`0.x` 阶段 MINOR 允许破坏性改动，所以上界必须卡在 MINOR 边界。上界写成 `<0.3.0-0` 而不是 `<0.3.0`：宿主用 `includePrerelease: true` 比较，`0.3.0-alpha.1` 小于 `0.3.0`，写 `<0.3.0` 会把 0.3.0 的 alpha 与 rc 全放进来，等于没上界（三档写法的逐版本判定表见 `docs/DSH-API-SURFACE.md` §7.5）。范围收紧后 dsh 发 0.3.0 时插件会被挡住，这是设计意图：要放开先在新版上跑完十二套，再把上界挪到 `<0.4.0-0`。

- **「本机已经有这份会话」的那条路也会体检了。** 打开时分两种落法：包里是本机没有的会话（新写一份），或本机已经有了（直接切过去）。后者以前完全跳过体检——而用户在同一台机器上重开自己的包，走的正是它，断链图就永远修不上。现在两条路都先回填附件、再体检、最后写盘；顺序不能反，否则包里自带的图还没进对象库就被判成缺失，好好的图被换成占位文本。

- **落点不是目录的时候，直说，不再往下走。** 包里记着「这条会话在哪个工作区」。打开时若那个路径不在了，旧逻辑静默回落到服务端当前目录——会话被塞进一个跟它无关的目录，接着写下去的记忆也落在那儿。更糟的是那个路径存在、但**是个普通文件**：`existsSync` 对文件同样为真，于是拿文件路径当键，在 `sessions/` 下建出一串以文件名结尾的目录。现在先 `statSync(...).isDirectory()` 确认它真是目录（用 `statSync` 不用 `lstatSync`，工作区可能就是 junction），不是就返回 `400 bad-workspace`（`{status, sessionId, title, originalCwd, sourcePath, message}`），一个目录都不建、一个字节都不写；提示里不带任何服务器路径。界面把这句话直接显示出来，不当成崩溃。
- **记忆目录不再做「归一化后相等」的模糊匹配。** `resolveMemoryDir` 原来第三级会把大小写、`-`、首尾分隔符抹平再比，于是 `...\ws` 与 `...\ws\` 被判成同一个工作区——两个不同的项目共用一个记忆目录，`restore` 模式能直接覆盖别人的 `MEMORY.md`。现在只认两级精确候选（`projectKey(cwd)` 与包里的 slug，都要 `path.resolve` 后逐段相等），找不到就新建。判据只有「路径逐段相同」这一条：归一化抹平的每一处，都是两个真实路径之间的差别。
- **合并记忆的弹窗会写明落点。** 「这些记忆会落到这个目录」这句话过去只有提示语，没有具体路径，用户看不出它和自己当前打开的工作区不是一回事。现在 `MemoryMergeModal` 里直接列出 `memoryDir`，并补一句「落点由包里的 cwd 决定，不是你当前打开的工作区」。

### 安全

- **附件条目不再享受压缩比豁免。** 压缩比检查过去对所有条目统一用「解压后不到 4 MB 就不算比例」这一档豁免，而附件本来就是已压缩的二进制、合法包接近 1:1，豁免对它们没有道理：170 条 3 MiB 全零缓冲区每条都落在豁免区，`MAX_RATIO = 200` 形同虚设。实测一个 `571,961` 字节的包能往 `~/.dsh/attachments/v1` 写出 `534,773,760` 字节（**935×**、170 个文件、1049 ms），而 DSH 的附件对象库**没有回收机制**，写进去就永远躺着，且这些对象没有任何会话引用——纯垃圾。现在 `attachments/` 条目的豁免阈值降到 64 KB，其余条目维持原值。
- **附件回填有了条数与总字节双配额。** 一次导入最多写 2000 个对象、合计 128 MB；超出的不计入「本机已有、跳过」，而是计入 `attachmentsRejected`，并在打开后的提示里明说「N 个附件因体积或数量超限未写入」。过去这个计数有值但没人读，用户只会发现自己少了几张图却不知道为什么。
- **zstd 帧解压有了输出上限。** 会话日志是「多个 zstd 帧拼接」，`zipRead` 那层 64 MB 只管住「DEFLATE 解出多少」，帧里再套一层 zstd 就能绕过去：实测把第 0 帧写成 900 MB 空白，包只有 `29,558` 字节（放大 32,587 倍），一打开 RSS 就 +937 MB，2000 MB 那版 +2 GB，而报错还是「字符串太长」这种跟炸弹无关的话。现在六处解压统一走 `decompressFrame`（`maxOutputLength` 钉在单帧 64 MB），超限抛 `ERR_BUFFER_TOO_LARGE`；打包与体检这两条会把所有帧都解开的路径另加一层累计预算（512 MB），挡住「几百帧各几十 MB」。**关键是不能把超限当成「这帧坏了、跳过」**——那样炸弹包会被静默当成空会话打开，比直接报错更糟。改后同样两个包：RSS 峰值 +67 MB、耗时 30 ms，报错变成 `ERR_BUFFER_TOO_LARGE`。

### 变更

- **落点必须是一个真目录，记忆目录不再"看着我像"就认。** 两件事：
  - 打开时要落地到包里的 `cwd`。过去只判 `existsSync`，而它对普通文件也返回真——`cwd` 指着一个文件时，会在 `sessions/` 下建出一个以文件路径为键的目录；目录不存在时又静默回落到服务端当前目录，你以为它开在你的工作区，其实不是。现在要求 `statSync(...).isDirectory()` 为真，否则返回 400 与一句「这个位置不是一个可用的目录」（**400 不是 500**：包没坏，是位置不对），界面弹提示停下，不建任何目录、也不假装开成功。
  - 记忆目录的解析过去有第三级"归一化后相等"的模糊匹配（抹平大小写、`-`、尾分隔符）。`...\ws` 与 `...\ws\` 因此会命中同一个记忆目录，配合「合并记忆」就能跨工作区覆盖别人的 `MEMORY.md`。现在只做两级精确匹配，找不到就新建一个——宁可多一个目录，不猜。

### 修复

- **五条收尾。** ①打开失败时不再预先建目录（过去目录建了、写会话失败就留一个空壳）。②打开失败的 500 只回通用文案，原始错误文本（可能含路径）不再拼进去。③会话日志先写临时文件再 `rename` 原子落盘，并用 `wx` 撞名重试；中途失败只清自己的临时文件，不会留下半个会话被 DSH 当成真的。④`workspaces` 路由补上 `try/catch`，抛错走统一文案而不是让桥接层兜。⑤原生对话框的结果目录改成每次 `mkdtemp` 独占——过去是 `os.tmpdir()` 下「固定前缀 + pid + 时间戳」的可预测名字，同一台机器上别的进程可以先占位、把结果换成自己的内容。

## [0.3.0] - 2026-10-31

### 新增

- **图片跟着包走。** 会话日志里只留 `sha256:` 引用，图片和文件的字节在 `~/.dsh/attachments/v1` 下的独立对象库——只导出日志的包换一台机器打开必然 `ATTACHMENT_NOT_FOUND`，而且重试不会自愈（引用指向一段固定哈希）。现在打包时把**会话真正引用到的**对象一起塞进来：图片进 `attachments/objects/<前2>/<sha256>`，文件进 `attachments/files/<前2>/<sha256>`，读出来先重算哈希，对不上宁可不带。打开时按同样规则回填：目标已存在就跳过（内容寻址天然幂等）；条目名与哈希前缀不符、或内容哈希对不上，一律拒绝写入，宁可少恢复一个也不往对象库里塞来路不明的字节。本机本来就没有的对象记进 `manifest.attachments.missing` 并写进 `SUMMARY.md`，让接包的人知道「这个包天生缺东西」，而不是等他打开时炸一脸。导入返回值新增 `attachmentsWritten` / `attachmentsSkipped` / `attachmentsRejected`；`options.includeAttachments === false` 可关掉打包。

### 变更

- **0.3.0 打出来的包，0.2.x 的插件打不开。** 包里多了 `attachments/` 下的条目，旧版的条目白名单（`ENTRY_ALLOW`）没有这条规则，`verifyPackage` 会以「包里有不认识的条目，拒绝打开：`attachments/objects/…`」中止。反过来不受影响：0.2.x 的旧包用 0.3.0 打开完全正常——旧包没有 `attachments` 段，回填逻辑拿到空表就直接跳过。收到别人发来的包却打不开时，先对一下两边的插件版本。

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
