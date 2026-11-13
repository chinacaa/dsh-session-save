# 调用的 DSH 接口一览（适配核对表）

本文件是**升级 DSH 时的核对清单**：插件到底依赖了 DSH 的哪些接口、每个接口的契约是什么、在哪一行用、失效了会怎样、怎么复查。

适配时从上到下过一遍，任何一条对不上就是必须改的点。

- 核对基线：DSH **0.2.1-rc.5**（`C:\Users\aa\AppData\Roaming\dsh-tauri\dependencies\dsh\package.json`）、`@deepseek-ai/cordis` **4.0.5**、会话格式 `SESSION_FORMAT_VERSION = 4`。
- 历史轮次：rc.3 → rc.4、rc.2（当时的 npm `latest`）→ rc.4、rc.4 → 0.2.1-rc.5 三轮差异；以及「为什么不需要旧版兼容 patch」，见文末「§6 版本差异账」。最近一轮（rc.4 → 0.2.1-rc.5）结论是零接口差异，插件代码未改；本机另在 `0.2.2-alpha.2` 上复核过，见 §6.4。
- 下文 `index.js:NNN` / `client.js:NNN` 均指本仓库同行号；行号会漂，**以函数名和代码形状为准**。
- 取证方式分三类，每条都标注了：**Inspect 实测**（本机运行中的 DSH 通过 `cordis_inspect_query` 直读）、**源码核对**（读 `node_modules/@deepseek-ai/*` 的 `lib/`）、**运行时实测**（跑本仓库测试或 curl 本机 HTTP 接口）。

---

## 0. 包清单声明（DSH 靠这三处认出插件）

| 位置 | 内容 | 失效后果 |
|---|---|---|
| `package.json` → `dsh.bundle.patch` | `"./cordis.patch.yml"` | DSH 不知道有 patch 层，插件根本不会被挂载 |
| `package.json` → `dsh.client` | `{ platform: "web" }`（**不写 `inject`**，见 §6.1 第 5 条） | 客户端半边不加载，界面里没有任何按钮 |
| `cordis.patch.yml` | `- insert: [{ id: session-save, name: dsh-session-save }]` | 同上；`name` 必须是**真实包名**，Cordis 按 `name` import |

另有 `package.json` → `exports`：DSH 的 client-modules 要求声明了 `dsh.client` 的包**必须导出 `./client`**，否则启动即抛 `declares dsh.client but exports no "./client" bundle`（`dsh-client-modules/lib/index.js:738`）。本仓库导出 `"./client": "./client.js"`。

`engines.dsh` = `>=0.2.1-rc.1 <0.3.0-0`；`peerDependencies["@deepseek-ai/cordis"]` = `^4.0.1`。**`engines.dsh` 是真拦截**：`dsh-app-boot` 用 `semver.satisfies(runtime, range, { includePrerelease: true })` 判定（`lib/index.js:276-284`），预发布版参与比较；一旦写了 `engines.dsh`，`peerDependencies` 里的 `@deepseek-ai/dsh*` **完全不参与判定**（`unmetRequirements` 只走一条分支），它只给 npm 看。版本判定细节与「别按版本分流」的理由见 `AGENTS.md` 的「版本与发行」节。

---

## 1. Host 半边（`index.js`）

### 1.1 模块导出形状

```js
export const name = 'session-save'   // index.js:20  Loader 行名
export const inject = ['connection'] // index.js:22  硬依赖：connection 不在就不 apply
export function apply(ctx)           // index.js:2477
```

`inject` 声明的是 Cordis 服务名。写进数组 = 硬依赖（服务缺失则本插件不启动）；反之用 `ctx.get(name)` 拿的是可选依赖。

### 1.2 `ctx.connection`（Host 服务）

- **取法**：`index.js:2478` `const connection = Reflect.get(ctx, 'connection')`。用 `Reflect.get` 而不是 `ctx.connection`，是为了在缺服务时拿到 `undefined` 而不是抛错。
- **只用了一个成员**：`connection.fetch.register(...)`。
- **契约**（Inspect 实测 `host/Service.listService` → `connection`）：

```ts
interface HostConnectionFetch {
  register(route: ConnectionFetchRoute): () => Promise<void>
}
interface ConnectionFetchRoute {
  path: string
  methods: readonly ('GET' | 'HEAD' | 'POST')[]   // 注意：只有这三个
  requestBody: 'buffered' | 'streaming'
  fetch: (request: Request) => Promise<Response>
}
```

- **实际用法**（4 条路由，全在 `apply()` 里）：

| 路由 | 行号 | methods | requestBody |
|---|---|---|---|
| `/api/session.save` | `index.js:2481` | `['GET','POST']` | `buffered` |
| `/api/session.open` | `index.js:2496` | `['GET','POST']` | `buffered` |
| `/api/session.workspaces` | `index.js:2509` | `['GET','POST']` | `buffered` |
| `/api/session.autosave` | `index.js:2524` | `['GET','POST']` | `buffered` |

`fetch` 收到的是标准 `Request`，返回标准 `Response`（`jsonResponse()`，`index.js:2185`）。四条都自己做了 `requestGate()` 来源校验（`index.js:2105`：回环 Host + 同源 Origin + 拒 cross-site），**不依赖 connection 的鉴权**——所以若 DSH 改变了 Host 头/Origin 的注入方式，这里会先拦住请求。

`/api/session.open` 的出参比 DSH 给的会话对象多一项 **`repair`**（插件自产的体检报告，不是 DSH 契约）：`{ frames:{total,broken,truncated}, lines:{total,dropped}, parts:{total,missing,patched,dropped}, changed, notes }`。它由 `repairSession()`（`index.js:710`）在落盘前生成：逐帧 `zstdDecompressSync`（解不开的帧原样保留字节）、逐行 `JSON.parse`（坏行丢弃）、`repairPartNode()`（`index.js:637`）遍历 image part，本机没有的对象换成文字占位、缺尺寸的用 `imageInfoOf()`（`index.js:578`）按文件头补齐。**这条是 DSH 契约的探针**：DSH 一旦改了会话日志的帧结构或 part 形状（`attachment` 对象 vs 扁平 `attachmentId`），`repair.parts.total` 会先掉到 0——测试 `test/repair.mjs` 与 `test/open-repair.mjs` 盯着它。

四条路由的 409 语义（客户端按 `status` 字段分流，不是按 HTTP 码）：

| `status` | 触发 | 客户端动作 |
|---|---|---|
| `confirm-overwrite` | 目标是个陌生 `.dsproj` | 弹「将覆盖 / 将新建」合并确认 |
| `not-dsproj` | 目标存在但不是本插件的包 | 只给「换个位置」 |
| `stale` | 内容 sha256 与 `stamps` 不符（别处改过） | 弹覆盖 / 另存为 |
| `locked` | 侧车 `.lock` 或包内 `LOCK.json` 判活 | 只报错，不给覆盖入口 |
| `missing-target` | **保存前发现原路径上的文件不在了**（见 `docs/TEST-MATRIX.md` F50） | 弹三选一：就在这里新建（`?recreate=1`）/ 另存到别处 / 取消；默认不写字节 |

`missing-target` 是**插件自己发明的**，不对应任何 DSH 接口——列在这里是因为它出现在路由出参里，适配时若 DSH 改了 `connection.fetch` 的响应处理（比如对非 2xx 做统一包装），这条会先受影响。

### 1.3 `ctx.effect` / `ctx.on`（Cordis 生命周期 + 事件）

- **用法**（`index.js:2538-2551`）：

```js
if (typeof ctx.effect === 'function' && typeof ctx.on === 'function') {
  ctx.effect(
    () => ctx.on('session/event', (session, event) => {
      const type = event?.type
      if (type !== 'step/end' && type !== 'turn/end') return
      scheduleAutosave(String(session?.id ?? ''))
    }),
    'session-save: autosave hook',
  )
}
```

- 先用 `typeof` 探测再调用 = 这条钩子是**锦上添花**（自动保存），缺了也不影响手动保存。
- **`session/event` 契约**（Inspect 实测 `host/Event.listEvents` → `session/event`）：

```ts
'session/event'(this: Scoped<Session>, session: Session, event: SessionEvent): void
// 类型：emit（post-commit，fire-and-forget）
// 语义：日志 push 之后的追加通知；listener 抛错只记日志，不会让那次 append 失败
```

- **只关心两个 event type**：`step/end` 与 `turn/end`（`SessionEventMap` 里的键名，未变）。若 DSH 改了事件名，自动保存在静默失效——**这是最容易悄悄坏掉的一条**，升级后要跑 `test/smoke.mjs` 或手工确认 `storages/session-save.json` 里有 `lastAutosaveAt` 更新。

### 1.4 会话日志文件格式（**最脆的依赖**）

插件直接读写 `~/.dsh` 下的会话文件，绕开了 DSH 的 API。这是零依赖设计的代价，也是升级时最可能断的地方。

| 事实 | 代码位置 | 当前值 |
|---|---|---|
| 数据根 | `index.js:80` | `process.env.DSH_HOME \|\| <homedir>/.dsh` |
| 会话目录 | `index.js:246` `findSessionFile()` | `<DSH_HOME>/sessions/<projectKey>/<encodeSegment(sessionId)>/session.v?.jsonl[.zstd]` |
| 记忆目录 | `index.js:149` `resolveMemoryDir()` | `<DSH_HOME>/memory/workspaces/<slug>/` |
| 工作区表 | `index.js:958` `readWorkspaces()` | `<DSH_HOME>/storages/workspace.json` → `tables.workspaces[<id>] = { path, title }` |
| `projectKey` | `index.js:119` | 见下节逐字对照表 |
| `encodeSegment` | `index.js:92` | 见下节逐字对照表 |
| 日志文件名 | `index.js:463` `LOG_NAME_RE` | `/^session(\.[0-9A-Za-z]+)?\.jsonl(\.zstd)?$/` |
| 帧结构 | `index.js:187` `scanZstdFrames()` | 单文件多帧 zstd 流，第 0 帧是 JSON header，后续帧是 JSONL 事件 |
| 写回方式 | `index.js:1341` `rewriteHeader()` | **只重写第 0 帧**，其余帧字节原样保留 |

#### `projectKey` / `encodeSegment`（**错一个字符就找错目录**）

这两个函数是「本机会话在哪」的唯一真相，且官方**不 export** 它们
（`dsh-session-persistence-jsonl/lib/index.js` 只导出 `Config, JsonlCompressionSchema, apply, name`），
没法 import 来对比。所以判据是**逐字复刻 + 自带 oracle 的回归测试**：

| 细节 | 官方行为 | 这里的实现 |
|---|---|---|
| 分隔符 | `/` `\` `:` 都是分隔符，**连续一段只折叠成一个** `-` | 同 |
| 尾部分隔符 | **不剪**。`C:\x\` → `--C-x---`（尾部贡献一个 `-`，外加包裹的两条） | 同 |
| 前导 `-` | 剥掉；剥空了兜底 `root`，故 `/` → `--root--` | 同 |
| 转义粒度 | 按 **UTF-16 码元**（`charCodeAt`）。`😀` → `~D83D~DE00`，不是 `~1F600` | 同 |
| `~` 自身 | 同样转义成 `~007E`，防解码歧义 | 同 |
| 截断 | `slice(0, 251)`，**截完不再剪尾 `-`** | 同 |
| 空串 | 官方**抛错**（`cannot encode an empty project path`） | 退回 `_no-cwd`（有意偏离：调用方是「找到就返回、找不到给 undefined」的扫描逻辑，抛错会中断整轮） |

官方原文位置（rc.4）：`dsh-session-persistence-jsonl/lib/index.js:858`（`encodeSegment`）、`:880`（`projectKey`）、`:907`（`projectDir`，`cwd === undefined` 时选 `_no-cwd`）。

核对命令（**每次升级 DSH 后跑一遍**，比读源码快）：

```bash
node test/pathkey.mjs   # 35 条：16 档 cwd × oracle 对照 + 4 条钉死形态 + 空串偏离 + 8 档 id + 磁盘实例
```

`test/pathkey.mjs` 里抄了一份官方实现当 oracle；官方若改算法，更新那份 oracle 与用例即可，
`index.js` 侧对不上会立刻红。本机实测：`C:\Users\aa\workspace` → `--C-Users-aa-workspace--`。

### 1.5 子进程（`node:child_process`）

已**移出** `index.js`，全部在 `dialog/windows.mjs`（`execFile` + `powershell.exe`）。`index.js` 现在只 import `node:crypto` / `node:fs` / `node:os` / `node:path` / `node:zlib` 和 `./dialog/index.mjs`。详见 §3。

---

## 2. Client 半边（`client.js`）

### 2.1 模块加载协议

```js
window.__ModuleLoader__.load({ id: 'dsh-session-save', factory(require) { … return { inject, apply } } })
// client.js:8；factory 内 const React = require('react')  —— client.js:11
```

- `window.__ModuleLoader__` 由 `@deepseek-ai/dsh-client-modules/lib/client.js` 注入（`load` / `create`）。
- **`require` 只用来取 `react`**。没有其他 require，也没有 import。
- 工厂返回 `{ inject, apply }`：`inject` 是**客户端服务名数组**（`client.js:2030` → `['slots','sessions','uiWorkspace','remote','remote.session']`），`apply(ctx)` 在服务就绪后被调用。
- 数组元素可以是**点路径**：`'remote.session'` 表示「取 `ctx.remote.session` 这个子服务」，Cordis 按路径逐段取。官方 `@deepseek-ai/dsh-client-ui-open-in-app` 的 `inject` 就是这么写的（见其 `lib/client.js` 的 `const inject = ['sessions','slots','locale','remote','remote.session','shortcuts','layout']`）——照抄它的写法比自创更安全。
- 写进数组 = **硬依赖**：服务缺失时整个 Client 半边不加载。所以只对「一定要有」的服务这么写；可选调用仍然用 `ctx.get(name)` 或可选链。

### 2.2 `ctx.slots`（插槽注册）

- **两个插槽**（`client.js:14-15`）：

| 常量 | 槽位名 | 用途（Inspect 原文） |
|---|---|---|
| `SLOT` | `conversation.session.header.utilities` | *Right-aligned Session utilities in ascending order.* |
| `SLOT_HERO` | `conversation.hero.options` | *Compact options right-aligned in the New Session row after the workspace and preset controls; rendered only with a Session.* |

- **两条 API**（Inspect 实测 `client/Service.listService` → `slots`）：

```ts
ctx.slots.inject(key: keyof SlotMap & string, callback: () => SlotInjectionEffect): () => void
ctx.slots.register(...)   // 声明在 SlotCore
```

用法固定为 `ctx.slots.inject(SLOT, () => ctx.slots.register({ name, id, order }, Component))`——`inject` 负责「槽位出现时才注册」，槽位消失时自动注销。**不要在 `apply` 里直接 `register`**，否则槽位晚于插件出现时会丢。

- **注册项的 catalog**（Inspect `listSubTree`，两个槽位一致）：

```ts
{ id: string (required)      // 自己的 cell key；复用官方 id 会顶替那个 cell
  order?: number             // 升序，默认 0
  label?: string | (() => string) }
```

- **本插件的 5 个注册项**（`client.js:2036-2083`）：`session-open`(39)、`session-save`(40)、`session-autosave`(41)、`session-save-as`(42) 在 header 槽；`session-open-hero`(41) 在 hero 槽。本机 Inspect 实测这 5 个 occupant 全部 `active: true`。

> ⚠️ **升级第一个要看的**：`replaceRisk` 当前是 `none`，但 `order` 含义是「同槽位内排序」。官方 `open-in-app` 占了 `-10`、`session-log-download` 无 order、`dsh-better-sidebar` 占 10/20。本插件用 39–42 是刻意排在所有官方项之后；若官方新增项也用 40 附近，图标顺序会混。

### 2.3 组件 props（DSH 传给插槽组件的标准 props）

Inspect `listSubTree` → `selected.catalog.standardProps` 列了 17 个 hook/prop。**本插件只用了其中一个**：

```js
props.sessionId          // client.js:477 / 729 / 1830
```

其余 16 个（`useSessions` / `useChat` / `useConversation` / `useSession` / `usePanelInfo` / `useWorkspaces` / …）一概没碰。`session-open-hero` 那个槽的 `ownerProps` 是空数组，同样只吃 `sessionId`。

⇒ 若 DSH 改了 `standardProps` 集合，**只要 `sessionId` 还在就没有影响**。

### 2.4 `ctx.sessions`（客户端服务）

- 用了一个方法，且**带可选链兜底**（`client.js:759`）：

```js
await host?.sessions?.refresh?.()   // ISessions.refresh(): Promise<void>
```

用途：导入 .dsproj 后让会话列表重新索引。失败被 `try/catch` 吞掉，不阻断打开流程。

- 同类里的其他方法（`retain` / `fork` / `search` / `scope` / `binding` / `refreshProjections`）都没用。

### 2.5 `ctx.uiWorkspace`（客户端服务）

- 用了两处，全部可选链：

| 调用 | 行号 | 契约 |
|---|---|---|
| `host?.uiWorkspace?.pickDirectory?.()` | `client.js:903` | `pickDirectory(): Promise<string\|null>` |
| `host?.sessions?.refresh?.()` 之后 `host?.uiWorkspace?.openSession?.(sessionId)` | `client.js:798` / `:803` | `openSession(target: SessionTarget): void` |

> **`uiWorkspace` 上没有 `openPath`。** Inspect 实测 `uiWorkspace` 的 10 个方法：`openSession` / `openWorkspace` / `forkSession` / `connectWorkspace` / `startSession` / `archiveSession` / `unarchiveSession` / `pickDirectory` / `listDirectory` / `createDirectory`，没有 `openPath`。早先「打开记忆目录」写成 `typeof host?.uiWorkspace?.openPath === 'function'` 导致**判断恒假、按钮点了没反应**（静默降级，不报错，所以很难发现）。现已改走下面的 Remote 调用。

### 2.5b `ctx.remote.session.openWorkspacePath`（客户端 → Host 的 Remote）

「在文件管理器里定位路径」的正确入口是 Session Remote，而不是 ctx 服务：

```ts
// client.js:1093 附近
const session = host?.remote?.session;
if (typeof session?.openWorkspacePath !== 'function') return;
session.openWorkspacePath({ path: dir, action: 'reveal' })
  .catch(() => { /* Host 不认这个路径就只显示路径，不弹错 */ });
```

| 项 | 事实 |
|---|---|
| Host 侧契约 | `dsh-api-session-controller/lib/typert.host.js` 的 zod schema：`{ path: string, action?: 'reveal', application?: string }` → `{ opened: true }` |
| Host 实现 | `dsh-api-session-controller/lib/index.js` 的 `openWorkspacePath(request, signal)`：先 `verifyDesktopPath`，再按 `action === 'reveal'` → `revealPath`；`application` 有值 → `openFileApplication`；否则 → `openPath` |
| 前置条件 | `canOpenPath()` 为假（远程/无桌面会话）时整条不可用，调用会抛 `gateway/internal`；插件已 `.catch` 吞掉 |
| 路径校验 | `verifyDesktopPath` 要求路径能 `fs.processPathFromHostPath` 映射回同一路径，否则 `gateway/bad-request`（"Path has no verified Host path"） |
| `action` 语义 | `'reveal'` = 文件管理器定位（目录只能这样）；省略 = 用系统默认应用打开。**目录用 open 会失败**，所以本插件固定传 `reveal` |
| 官方同款调用 | `dsh-client-ui-open-in-app/lib/client.js` 的 `openPath()`、`dsh-client-ui-deliverables/lib/index.js` 的 `openVerified()` 都是这个写法 |

### 2.6 HTTP 调用（四条业务路由自建 fetch，不经过 Remote）

客户端对 §1.2 注册的四条路由**自己发 `fetch`**，不走 Remote 通道：

```js
fetch(`${ROUTE}?${search.toString()}`, { method: 'GET', headers: { accept: 'application/json' }, credentials: 'same-origin' })
// client.js:497（保存）、client.js:735（requestJson，打开/自动保存/工作区）
```

⇒ 依赖两个非契约事实：**(a)** 插件注册的 `/api/*` 路由与页面同源；**(b)** `credentials: 'same-origin'` 能带上 DSH 的浏览器凭据。二者都由 `ctx.connection.fetch.register` 的实现保证，目前成立。

> 注意区分：**业务路由**（保存/打开/自动保存/工作区）走自建 fetch；**「打开记忆目录」**走 `ctx.remote.session.openWorkspacePath`（§2.5b）。两者不冲突——`remote` 只用来调 DSH 已有的 Remote 方法，不自建路由。

### 2.7 国际化

`client.js:204` 读 `navigator.language`（`/^en\b/i` → 英文词表，否则中文）。**与 DSH 的 locale 服务无关**——那是浏览器语言，不是 DSH 的 `ctx.locale`。若想跟随 DSH 的语言切换，需改成 `ctx.locale`；当前是刻意不依赖。

---

## 3. 平台相关（`dialog/`，与 DSH 无关但值得一起核对）

`index.js` 只 import `dialog/index.mjs` 的两个函数，选择器按**能力探测**挑实现（不看版本号）：

| 平台 | 判据 | 实现 |
|---|---|---|
| win32 | `${SystemRoot}\System32\WindowsPowerShell\v1.0\powershell.exe` 是文件 | `windows.mjs`（`-NoProfile -STA -ExecutionPolicy Bypass -File`） |
| darwin | `/usr/bin/osascript` 可执行 | `macos.mjs`（`choose file name` / `choose file`） |
| linux/freebsd | `zenity` → `kdialog` → `qarma` → `matedialog` | `linux.mjs` |
| 其他 | — | `null` → 调用方回退到网页里的路径输入框 |

三态返回值：`undefined` = 平台没实现 / `null` = 用户取消 / `string` = 选中路径。

---

## 4. 升级 DSH 时的核对顺序

1. **启动能不能过**：DSH 起得来、插件在 Loader 里 active、界面出现 4 个按钮 + hero 里 1 个。挂不上先看 `package.json` 的 `dsh.bundle.patch` / `dsh.client` / `exports["./client"]`。
2. **四个路由在不在**：`curl 'http://127.0.0.1:3080/api/session.workspaces'`（带 Host 头）应返回 JSON 列表而不是 404。
3. **插槽还在不在**：`cordis_inspect_query` → `client/Slots.listSubTree` 传 `conversation.session.header.utilities`，看 5 个 occupant 是否全 `active`。
4. **事件名没变**：`cordis_inspect_query` → `host/Event.listEvents` 传 `session/event`，确认签名仍是 `(session, event)`；再确认 `event.type` 仍可能是 `step/end` / `turn/end`。
5. **会话文件还能读**：`node test/smoke.mjs`（打包 + 回读）与 `node test/open.mjs`（40 条，导入与冲突）。十一套测试全部通过 `test/fixture.mjs` 自建临时 `DSH_HOME`，不读真实 `~/.dsh`。
6. **跑满回归**：`for f in pathkey client dialog smoke open conflict security attach repair open-repair version locales context bili roundtrip backup-ui audit-r1 audit-r2 audit-r3 audit-r4 ui-openwait dsh-list remote; do node test/$f.mjs || exit 1; done`，应共 **729** 条 ✅（详见 `docs/TEST-MATRIX.md`）。其中 `pathkey.mjs` 是 rc.4 适配时新增的目录名派生回归。
7. **客户端能调 Host 吗**：`node test/client.mjs` 里已断言 `inject` 含 `remote` 与 `remote.session`、且源码不含 `uiWorkspace.openPath`。「打开记忆目录」失效是**静默**的（按钮点了没反应、不报错），只能靠这条断言兜住。

---

## 5. 复查用的 Inspect 命令（本机 DSH 运行中才可用）

这些是 DSH 自带的只读 Inspect Provider，用来**直接问运行中的 DSH**，比读 `node_modules` 更接近事实：

```
cordis_inspect_list()                                              # 有哪些 Provider
client/Service.listService      { }                                # slots / sessions / uiWorkspace / locale …
client/Service.listService      { service: "uiWorkspace" }         # 单个服务的完整签名（注意：没有 openPath）
client/Slots.listSubTree        { root: "conversation.session.header.utilities" }
host/Service.listService        { service: "connection" }
host/Event.listEvents           { event: "session/event" }
client/Builtin.listBuiltins     { }                                # 客户端半边能用的全局符号
```

Remote 类方法（如 `openWorkspacePath`）**不在** Service 目录里，Inspect 也查不到它——要去 `node_modules/@deepseek-ai/dsh-api-session-controller/lib/typert.host.js` 找 zod schema，`lib/index.js` 里找同名实现方法。

**注意**：Inspect 只能读，不能当成插件代码可调用的业务 Service。插件代码仍然只能走 `ctx.*`。

---

## 6. 版本差异账（0.2.0 → 0.2.2-alpha.2）

### 6.1 rc.3 → rc.4

rc.3 的核对结论大部分仍然成立；rc.4 逐条复查后**只有目录名派生这一处真偏差**，其余全是「名字变了但行为没变」。

| # | 项目 | rc.3 → rc.4 | 对本插件的影响 |
|---|---|---|---|
| 1 | `projectKey` / `encodeSegment` | 实现未变，但**本插件当年抄错了三处**：尾部分隔符被剪、`codePointAt` 而非 `charCodeAt`、前导剪裁位置不对 | **已修**（`index.js:92`/`:82`）。真实数据从未触发（本机 5 个会话目录全部对得上），但构造路径必错。新增 `test/pathkey.mjs` 35 条钉住 |
| 2 | 官方 `encodeSegment` 空串 | 抛错（`cannot encode an empty path segment`） | 插件侧 `findSessionFile()` 先用 `isSessionId()` 挡掉非 id，不会走到这里 |
| 3 | `projectDir(root, undefined)` | 回落 `_no-cwd` | 插件 `projectKey('')` 也回落 `_no-cwd`，一致 |
| 4 | `session.openWorkspacePath` | 仍在 `dsh-api-remotes/lib/client.js`，参数 object、结果 `{ opened: true }` | 无需改动 |
| 5 | `dsh.client.inject` 里的 `@deepseek-ai/dsh-client-runtime` | **该包在 rc.4 的 node_modules 里根本不存在**（全盘 grep 零命中） | **已删**（`package.json` 的 `dsh.client` 现在只有 `{ platform: "web" }`）。原来那条是无效声明：`dsh.client.inject` 列的是**客户端模块图里的包名**（`dsh-client-modules/lib/client.js:789` `arriveGraphRow()` 里 `this.graphRows.get(packageName)` 取不到就静默跳过），不是服务名——服务依赖由工厂返回的 `inject` 数组负责（`client.js:2030`）。留着它只是把「不存在的包」写成契约，下次适配会误以为有这个依赖 |
| 6 | `Slots` 插槽根 `conversation.session.header.utilities` | 未变，5 个 occupant 仍全部 `active` | 无需改动 |
| 7 | `session/event` 事件签名 `(session, event)`、`step/end`·`turn/end` | 未变 | 自动保存无需改动 |
| 8 | `@deepseek-ai/cordis` | 4.0.5（未变） | `peerDependencies ^4.0.1` 仍成立 |
| 9 | `SESSION_FORMAT_VERSION` | 仍为 `4` | 日志读写与 header 重写无需改动 |
| 10 | `dsh-session-persistence-jsonl` 的导出面 | 仍只有 `Config, JsonlCompressionSchema, apply, name` —— `projectKey`/`encodeSegment` **不可 import** | 只能靠复刻 + oracle 测试（见 §1.4） |

**升级核对只需两条命令**：

```bash
node test/pathkey.mjs    # 目录名派生没漂
node test/client.mjs     # 插槽 / inject / 前端接线没断
```

其余五套（`dialog` `smoke` `open` `conflict` `security`）覆盖的是插件自己的落盘与安全逻辑，与 DSH 版本弱相关，但**改动后必须全跑**（合计 286 条）；`attach` / `repair` / `open-repair` 三套覆盖附件打包回填与打开前体检（26 条）。以上 308 + 46（`pathkey` 35 + `client` 11）+ 26 = 380 条，再加 `version` 7 条、`locales` 5 条、`context` 8 条、`bili` 13 条，以及往返 `roundtrip` 89 条与弹窗/文案 `backup-ui` 36 条 = 全部 553 条。`locales` 覆盖语言包形状、客户端兜底、路由回落与跨站拦截。

### 6.2 rc.2 → rc.4（2026-10 那轮的对照；本机现在跑 0.2.2-alpha.2）

npm 上 `@deepseek-ai/dsh` 的 `dist-tags`：`latest = 0.2.1-rc.2`（`alpha = 0.2.2-alpha.2`）。当时本机跑的是 `0.2.1-rc.4`。下面这轮把**两个版本对同一批包逐字 diff**，结论是：**插件用到的接口一个都没变。**

核对方式：`npm pack` 两版 → 解包到 `/tmp/pkhist/cmp-dsh-<pkg>-0.2.1-rc.{2,4}/` → `diff -rq` 找出差异文件 → 再对差异文件按插件关心的符号 `grep`。

| 包 | 文件级差异 | 插件关心的符号 |
|---|---|---|
| `dsh-session-persistence-jsonl` | **只有 `package.json`** | `encodeSegment` / `projectKey` / `projectDir` 三段 `diff` **完全一致** |
| `dsh-session` | **只有 `package.json`** | `step/end`、`turn/end` 各 5 处，计数一致，签名未变 |
| `dsh-api-remotes` | `lib/client.js` 130 行 + `package.json` | 差异**全是 telemetry event schema**（新增 `more_menu_item_click` / `agent_preset_switch` / `code_work_view_toggle`，新增字段 `is_new_session` / `agent_preset` / `timestamp` / `position`）。`grep 'openWorkspacePath\|fetch\|register\|workspace'` **零命中** |
| `dsh-client-ui-conversation` | 14 个文件：3 个 README + 10 个 `.d.ts` + `lib/client.js`（305 行） | `grep 'header.utilities\|hero.options'` 在 `lib/client.js` **零命中** → 两个插槽声明块逐字未变（rc.2 在 `:19859`、rc.4 在 `:20062`，都是 `kind:"list", scope:"session"`） |

**唯一真实的版本断崖在 0.2.0 系**：`@deepseek-ai/dsh-client-ui-conversation@0.2.0-rc.1` 里 `conversation.hero.options` 计数为 **0**（不存在），`conversation.session.header.utilities` 为 2；从 `0.2.1-rc.1` 起 hero 变成 2。也就是说 **hero 座位是 0.2.1 才有的**。

但这条断崖不需要兼容代码：`ctx.slots.inject(key, cb)` 的契约是「声明已存在则同步执行回调，否则等下一次声明时才执行」——slot 不存在时插件那个 hero 按钮**静默不出现，不抛错**（见 §2.2）。而 `engines.dsh = ">=0.2.1-rc.1 <0.3.0-0"` 已经把 0.2.0 系挡在门外、把 0.3.0 及之后也挡在门外（判定用 `semver.satisfies(..., { includePrerelease: true })`，见 `dsh-app-boot/lib/index.js:276-283`）。三档写法的逐版本判定表在 §7.5。

### 6.3 为什么没有「旧版兼容 patch」

`cordis.patch.yml` 的 patch 层**只能做两件事**（`dsh-app-boot/lib/index.js:61-110` `applyEntryPatches`）：`insert` 往 group 塞 entry，或按 `id` 覆盖已有 entry 的字段（`config` / `name` / `disabled`）。它**拿不到 DSH 版本号**：

- `!!js` 表达式在 `@deepseek-ai/cordis-plugin-loader/lib/index.js:230-237` 里求值，作用域是 `with (ctx)`——只能取 **Cordis 服务**，取不到 `package.json` 的版本字符串。
- DSH 也**不提供版本服务**：`grep -rn "provide(['\"]version\|dshVersion"` 在 `dsh-app-boot/lib/index.js` 与 `dsh-shell*/lib/*.js` 零命中；`ProfileContext` 类型字段只有 `name / packageManager? / dir / patchPath / installAnchor / cwd / home / startedBundles / overlays / telemetryDisabledEnv`。

所以 patch 层无法「按版本号分流」。真要给某个旧版留后门，只有两条路：主干暴露一个 `config` 开关、由 patch 覆盖 `config` 打开（客户端 `apply(ctx, config)` 确实收 config，`dsh-cordis-client-runner/lib/client.js:627`）；或用 `disabled: !!js ...` 按**某个服务在不在**做能力探测。

当前**没有任何需要这样做的项**：rc.2 ↔ rc.4 零接口差异，0.2.0 系已被 `engines.dsh` 挡住，且 hero 座位缺失本来就是优雅降级。所以 `cordis.patch.yml` 保持只有那一条 `insert`。

### 6.4 rc.4 → 0.2.1-rc.5（npm `latest`），附 0.2.2-alpha.2 复核

`dist-tags` 现状：`latest = 0.2.1-rc.5`、`next = 0.2.1-rc.5`、`alpha = 0.2.2-alpha.2`。**支持基线取 npm `latest` 的 `0.2.1-rc.5`**；本机实际装的是 `alpha` 的 `0.2.2-alpha.2`，作为附注一并核对。结论与上一轮相同：**插件用到的接口一个都没变，代码零改动。**

核对方式：直接比对升级前后两份 `dependencies/dsh/node_modules/@deepseek-ai`（旧的那份是 `dsh-0.2.1-rc.4-40372188763`）。注意旧目录里有 `*.dshpurge.bak`，那是 dshpurge 补丁留下的备份，`diff -rq` 会把补丁差异算成版本差异 —— 所以判版本差异只按插件关心的符号 `grep` 计数，不做整文件 diff。

| 接口 | 判定依据 | 结论 |
| --- | --- | --- |
| `conversation.*` 插槽 | 两版各 `72` 个 | 集合完全一致（`comm` 双向零差异）；`hero.options`、`session.header.utilities` 都在 |
| 附件对象库 | `dsh-attachment-local/lib/index.js:996` 取 `dshHome/attachments/v1`，`:298` 落 `objects/<前2>/<sha>`，`:673` 落 `file-objects/<前2>/<sha>` | 与 `index.js` 的 `ATTACH_KIND_DIR` 逐段对应 |
| 会话日志路径 | `projectKey` 3 处 / `encodeSegment` 37 处 / `projectDir` 4 处，两版计数相同 | 未变 |
| 会话文件格式 | `dsh-session-format` 系列仍只到 `-v3-to-v4` | 没有 v5 |
| `session/event` | 47 处 | 在（插件只监听这一个事件名） |
| `ctx.effect` / `ctx.get(` | `dsh-client-ui-conversation/lib/client.js` 里 12 处 / 6 处 | 在 |
| `engines.dsh` 判定 | `dsh-app-boot/lib/index.js:276-284` 的 `semver.satisfies(runtimeVersion, range, { includePrerelease: true })` | 逻辑与行号都没变 |

表里对比的是 rc.4 与本机 `0.2.2-alpha.2` 两端：`0.2.1-rc.5` 的接口集合夹在这两者之间，未单独安装验证，按两端一致推断。

比静态核对更硬的是真机验证：升版后插件确实装配成功。`curl -H "Origin: http://127.0.0.1:3080" http://127.0.0.1:3080/api/session.workspaces` 返回 `200`；`/api/session.locales?lang=en-US` 也返回 `200`，带回 114 键的英文包 —— Host 半边活着，四条路由都通。

`engines.dsh = ">=0.2.1-rc.1 <0.3.0-0"` 对 `0.2.2-alpha.2` 判 **ALLOW**（预发布版落在范围内，靠 `includePrerelease: true`），对 `0.3.0-alpha.1` 与 `0.3.0` 仍是 **BLOCK**：上界没有因为这次升级被顺手放宽。

二十套 **637 条全绿**，与发版前一致，零回退。

## 7. `engines.dsh` 的接口倒推依据

§6 记的是「两个版本之间差了什么」；这一节记的是**下限本身从哪来**。

`AGENTS.md`「版本与发行」定的规矩：范围只能从接口倒推，不许跟着最新版走；改范围前必须在**每一个**边界版本上跑完十二套。这张表就是「倒推」的账：插件用到哪条接口、哪条最早可用、哪几条还没验过。

### 7.1 插件依赖的宿主接口清单

| # | 接口 | 用在本仓库哪一行 | 缺了会怎样 | 首次可用版本 |
| --- | --- | --- | --- | --- |
| 1 | 插槽 `conversation.session.header.utilities` | `client.js:14` | 标题栏四个按钮全不出现 | `UNKNOWN`（同包 0.2.0-rc.1 存在但未逐字核对该座位） |
| 2 | 插槽 `conversation.hero.options` | `client.js:15` | 空会话页少一个「打开」胶囊，其余不受影响 | **0.2.1-rc.1**（实测，见 7.2） |
| 3 | `ctx.slots` 注册 API（`ctx.slots.register` 形状） | `client.js` 的 `apply` | 插件整块不挂载 | `UNKNOWN` |
| 4 | `ctx.get('connection')` + `connection.fetch.register` | `index.js:2784`、`2799`、`2812`、`2828`、`2840` | 四条路由全 404 | `UNKNOWN` |
| 5 | 路由依赖的 `connection` 形状（`methods` / `requestBody` / `path`） | 同上五处 | 路由注册被拒或请求体读不到 | `UNKNOWN` |
| 6 | `ctx.effect` | `index.js:2855-2856` | 自动保存整条链路不工作 | `UNKNOWN` |
| 7 | `ctx.on('session/event', handler)` | `index.js:2858` | 自动保存收不到 `step/end`，永不触发 | `UNKNOWN` |
| 8 | 客户端 `window.__ModuleLoader__.load({ id, factory })` | `client.js:8` | 客户端半边整个不加载 | `UNKNOWN` |
| 9 | `session.openWorkspacePath({ path, action })`（Session Remote） | `client.js:1156` | 「在文件管理器里显示」静默失效，其余正常 | `UNKNOWN` |
| 10 | `sessions.refresh()` | `client.js` 的打开流程 | 打开后会话列表不更新（导入本身成功） | `UNKNOWN` |
| 11 | 会话日志 `/` 文件名形状 `session.v4.jsonl.zstd` | `index.js:463-466` | 打包扫不到会话文件 | `UNKNOWN` |
| 12 | 附件对象库 `$DSH_HOME/attachments/v1/{objects,files}/<前两位>/<sha256>` | `index.js:480` | 附件既带不走也回填不了 | **≤0.2.0-rc.1**（实测，见 7.2） |
| 13 | `engines.dsh` 自身的判定实现（`semver.satisfies` + `includePrerelease`） | `docs` 本文 §1 | 范围写了不生效 | `UNKNOWN`（判定逻辑在 `dsh-app-boot/lib/index.js:276-283`，未回溯到首次版本） |

**下限 = 上表里最晚的那个「首次可用版本」。** 现在只有第 2 行有实测值，其余标 `UNKNOWN`——`UNKNOWN` 不等于「更早」，只是还没验。

### 7.2 已经实测的两个点

拿 npm 上的历史版本直接解包 grep，不看文档、不看 changelog：

| 目标 | 包 | 0.2.0-rc.1 | 0.2.1-rc.1 |
| --- | --- | --- | --- |
| `conversation.hero.options` | `@deepseek-ai/dsh-client-ui-conversation` | 命中 **0** 次 | 命中 **4** 次 |
| `attachments/v1/objects` | `@deepseek-ai/dsh-attachment-local` | 命中 **2** 次 | 命中 **2** 次 |

两条结论：

- **第 2 行是真门槛**：`0.2.0-rc.1` 的 `dsh-client-ui-conversation` 包里连这个字符串都不存在，不是「座位在但渲染为空」。所以 `>=0.2.1-rc.1` 的下限有硬依据。
- **第 12 行不是门槛**：附件对象库路径在 `0.2.0-rc.1` 就已经是现在这个形状，插件附带的那套附件打包/回填不会把下限推高。

### 7.3 怎么把剩下的 `UNKNOWN` 补上

对每个要验的版本、每个要验的包，跑同一条流程（`npm pack` 会把整包 tarball 落到当前目录，直接流式 grep，不解包到磁盘）：

```bash
cd /tmp && rm -rf probe && mkdir probe && cd probe
V=0.2.1-rc.1
for p in dsh-client-ui-conversation dsh-attachment-local dsh-session-persistence-jsonl; do
  npm pack "@deepseek-ai/$p@$V" --registry=https://registry.npmjs.org
done
for t in *.tgz; do
  echo "-- $t"
  tar -xzOf "$t" | grep -c 'conversation\.hero\.options'
done
```

三个坑：

1. **`npm pack` 返回码不代表成败**。包能下、tarball 能落盘，但带 `EBADENGINE` 之类警告时退出码非 0，`&&` 链会误判成「包不存在」。判据只看 `ls -l *.tgz` 有没有那个版本的文件。
2. **字符串在哪个包要先在本地装上找一遍**，别猜：
   ```bash
   cd ~/.dsh/profiles/web/node_modules 2>/dev/null || cd "$DSH_HOME/../dependencies/dsh/node_modules"
   grep -rl 'conversation.hero.options' ./@deepseek-ai | cut -d/ -f2 | sort -u
   ```
3. **命中数 0 要区分「字符串没有」和「包没有」**：包不存在时 `npm pack` 不产文件，先确认 tarball 在，再判 0。

补完一行就把 7.1 的 `UNKNOWN` 换成年份版本号，并在 7.2 加一行证据。**没跑过的不许填版本号**——填了就等于给自己发了一张「这个版本能用」的空头承诺，而 `engines.dsh` 是真拦截。

### 7.4 现状

- `package.json` 的 `engines.dsh` 当前是 `>=0.2.1-rc.1 <0.3.0-0`：下限的硬依据是第 2 行，上限的依据是 semver 语义（见 7.5）。
- 第 3–11 行、13 行尚未逐版回溯。它们**不影响现有下限的正确性方向**（下限由最晚者决定，未验项只会让下限可能偏低），但**影响上限的声明**：`>=` 开口成立的前提是「下限之后每个已发布版本都实测过」，这条现在也没做到（0.2.1-rc.2 / rc.4 / rc.5 / 0.2.2-alpha.2 未跑）。
- 因此当前写法应当读作「**已知在 0.2.1-rc.1 上可用**」，不是「0.2.1-rc.1 之后全都验证过」。要把它变成后者，按 `AGENTS.md`「改范围的前置条件」逐版本跑十二套，把结果记进 §6。

### 7.5 上限写成什么样才对

`0.x` 阶段 MINOR 可带破坏性改动，所以范围必须闭合在当前 MINOR 上。但上限的具体写法有两个坑，都用 `semver.satisfies(v, range, { includePrerelease: true })` 实测过：

| 版本 | `>=0.2.1-rc.1` | `>=0.2.1-rc.1 <0.3.0` | `>=0.2.1-rc.1 <0.3.0-0` |
| --- | --- | --- | --- |
| `0.2.0-rc.2` | BLOCK | BLOCK | BLOCK |
| `0.2.1-alpha.5` | BLOCK | BLOCK | BLOCK |
| `0.2.1-rc.1` | ALLOW | ALLOW | ALLOW |
| `0.2.1-rc.3` | ALLOW | ALLOW | ALLOW |
| `0.2.1-rc.5` | ALLOW | ALLOW | ALLOW |
| `0.2.2-alpha.2` | ALLOW | ALLOW | ALLOW |
| `0.2.2` | ALLOW | ALLOW | ALLOW |
| `0.3.0-alpha.1` | ALLOW | **ALLOW** | BLOCK |
| `0.3.0-rc.1` | ALLOW | **ALLOW** | BLOCK |
| `0.3.0` | ALLOW | BLOCK | BLOCK |
| `0.4.0` | ALLOW | BLOCK | BLOCK |

两条结论：

1. **不写上界等于没有上界**：`>=0.2.1-rc.1` 放行到 `0.4.0` 甚至更远，dsh 哪天在 MINOR 里改了插槽契约，插件会被装进一个它没见过的宿主里。
2. **上界不能写成 `<0.3.0`**：semver 里预发布版小于对应正式版，`0.3.0-alpha.1 < 0.3.0` 成立；而宿主判定带 `includePrerelease: true`，于是 0.3.0 的 alpha / rc / 正式版全被放进来。要真正封死下一个 MINOR，上界写成 `<0.3.0-0`（`-0` 是该版本号下最小的预发布标识）。

复现：

```bash
cd "$DSH_HOME/../dependencies/dsh"   # 或任意装过 semver 的地方
node -e "
const s=require('semver'); const opt={includePrerelease:true};
for (const r of ['>=0.2.1-rc.1','>=0.2.1-rc.1 <0.3.0','>=0.2.1-rc.1 <0.3.0-0']) {
  console.log('--- '+r);
  for (const v of ['0.2.0-rc.2','0.2.1-alpha.5','0.2.1-rc.1','0.2.1-rc.3','0.2.1-rc.5','0.2.2-alpha.2','0.2.2','0.3.0-alpha.1','0.3.0-rc.1','0.3.0','0.4.0'])
    console.log('  '+v.padEnd(14)+' '+(s.satisfies(v,r,opt)?'ALLOW':'BLOCK'));
}"
```

范围写成 `<0.3.0-0` 之后，dsh 发 0.3.0 时插件会被 `engines.dsh` 挡住——**这是设计意图，不是故障**。要放开，先按 `AGENTS.md`「改范围的前置条件」在新版上跑完十二套，再把上界挪到 `<0.4.0-0` 并把结果记进 §6。
