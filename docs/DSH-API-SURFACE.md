# 调用的 DSH 接口一览（适配核对表）

本文件是**升级 DSH 时的核对清单**：插件到底依赖了 DSH 的哪些接口、每个接口的契约是什么、在哪一行用、失效了会怎样、怎么复查。

适配时从上到下过一遍，任何一条对不上就是必须改的点。

- 核对基线：DSH **0.2.1-rc.2**（`C:\Users\aa\AppData\Roaming\dsh-tauri\dependencies\dsh\package.json`）、`@deepseek-ai/cordis` **4.0.5**、会话格式 `SESSION_FORMAT_VERSION = 4`。
- 下文 `index.js:NNN` / `client.js:NNN` 均指本仓库同行号；行号会漂，**以函数名和代码形状为准**。
- 取证方式分三类，每条都标注了：**Inspect 实测**（本机运行中的 DSH 通过 `cordis_inspect_query` 直读）、**源码核对**（读 `node_modules/@deepseek-ai/*` 的 `lib/`）、**运行时实测**（跑本仓库测试或 curl 本机 HTTP 接口）。

---

## 0. 包清单声明（DSH 靠这三处认出插件）

| 位置 | 内容 | 失效后果 |
|---|---|---|
| `package.json` → `dsh.bundle.patch` | `"./cordis.patch.yml"` | DSH 不知道有 patch 层，插件根本不会被挂载 |
| `package.json` → `dsh.client` | `{ platform: "web", inject: ["@deepseek-ai/dsh-client-runtime"] }` | 客户端半边不加载，界面里没有任何按钮 |
| `cordis.patch.yml` | `- insert: [{ id: session-save, name: dsh-session-save }]` | 同上；`name` 必须是**真实包名**，Cordis 按 `name` import |

另有 `package.json` → `exports`：DSH 的 client-modules 要求声明了 `dsh.client` 的包**必须导出 `./client`**，否则启动即抛 `declares dsh.client but exports no "./client" bundle`（`dsh-client-modules/lib/index.js:738`）。本仓库导出 `"./client": "./client.js"`。

`engines.dsh` = `>=0.2.1-rc.1`；`peerDependencies["@deepseek-ai/cordis"]` = `^4.0.1`。**这两个字段是给人和 npm 看的，DSH 自己不做版本拦截** —— 真正的兼容性只能靠本文档逐条核对。

---

## 1. Host 半边（`index.js`）

### 1.1 模块导出形状

```js
export const name = 'session-save'   // index.js:20  Loader 行名
export const inject = ['connection'] // index.js:22  硬依赖：connection 不在就不 apply
export function apply(ctx)           // index.js:1807
```

`inject` 声明的是 Cordis 服务名。写进数组 = 硬依赖（服务缺失则本插件不启动）；反之用 `ctx.get(name)` 拿的是可选依赖。

### 1.2 `ctx.connection`（Host 服务）

- **取法**：`index.js:1808` `const connection = Reflect.get(ctx, 'connection')`。用 `Reflect.get` 而不是 `ctx.connection`，是为了在缺服务时拿到 `undefined` 而不是抛错。
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
| `/api/session.save` | `index.js:1810` | `['GET','POST']` | `buffered` |
| `/api/session.open` | `index.js:1822` | `['GET','POST']` | `buffered` |
| `/api/session.workspaces` | `index.js:1834` | `['GET','POST']` | `buffered` |
| `/api/session.autosave` | `index.js:1840` | `['GET','POST']` | `buffered` |

`fetch` 收到的是标准 `Request`，返回标准 `Response`（`jsonResponse()`，`index.js:1555`）。四条都自己做了 `requestGate()` 来源校验（`index.js:1475`：回环 Host + 同源 Origin + 拒 cross-site），**不依赖 connection 的鉴权**——所以若 DSH 改变了 Host 头/Origin 的注入方式，这里会先拦住请求。

### 1.3 `ctx.effect` / `ctx.on`（Cordis 生命周期 + 事件）

- **用法**（`index.js:1854-1872`）：

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
| 数据根 | `index.js:43` | `process.env.DSH_HOME \|\| <homedir>/.dsh` |
| 会话目录 | `index.js:167` `findSessionFile()` | `<DSH_HOME>/sessions/<projectKey>/<encodeSegment(sessionId)>/session.v?.jsonl[.zstd]` |
| 记忆目录 | `index.js:77` `resolveMemoryDir()` | `<DSH_HOME>/memory/workspaces/<slug>/` |
| 工作区表 | `index.js:519` `readWorkspaces()` | `<DSH_HOME>/storages/workspace.json` → `tables.workspaces[<id>] = { path, title }` |
| `projectKey` | `index.js:64` | 分隔符折叠成 `-`，再去掉前导 `-`，非 `[A-Za-z0-9._-]` 转 `~XXXX`，驼峰包 `--…--`，截 251 字符 |
| `encodeSegment` | `index.js:50` | 同上但不折叠，`.`/`..` 特判为 `~002E`/`~002E~002E` |
| 日志文件名 | `index.js:360` `LOG_NAME_RE` | `/^session(\.[0-9A-Za-z]+)?\.jsonl(\.zstd)?$/` |
| 帧结构 | `index.js:108` `scanZstdFrames()` | 单文件多帧 zstd 流，第 0 帧是 JSON header，后续帧是 JSONL 事件 |
| 写回方式 | `index.js:854` `rewriteHeader()` | **只重写第 0 帧**，其余帧字节原样保留 |

`projectKey` / `encodeSegment` 是**复刻官方实现**（注释已写明）。升级核对方法：

```bash
# 拿 DSH 自己的实现比一遍（node_modules 里找 projectKey / encodeSegment）
grep -rn "function projectKey\|function encodeSegment" \
  "$APPDATA/../Roaming/dsh-tauri/dependencies/dsh/node_modules/@deepseek-ai/dsh-session/lib/"*.js
```

对本机实测：`C:\Users\aa\workspace` → `--C-Users-aa-workspace--`，与目录实际命名一致。

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
- 工厂返回 `{ inject, apply }`：`inject` 是**客户端服务名数组**（`client.js:1895` → `['slots','sessions','uiWorkspace','remote','remote.session']`），`apply(ctx)` 在服务就绪后被调用。
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

- **本插件的 5 个注册项**（`client.js:1897-1948`）：`session-open`(39)、`session-save`(40)、`session-autosave`(41)、`session-save-as`(42) 在 header 槽；`session-open-hero`(41) 在 hero 槽。本机 Inspect 实测这 5 个 occupant 全部 `active: true`。

> ⚠️ **升级第一个要看的**：`replaceRisk` 当前是 `none`，但 `order` 含义是「同槽位内排序」。官方 `open-in-app` 占了 `-10`、`session-log-download` 无 order、`dsh-better-sidebar` 占 10/20。本插件用 39–42 是刻意排在所有官方项之后；若官方新增项也用 40 附近，图标顺序会混。

### 2.3 组件 props（DSH 传给插槽组件的标准 props）

Inspect `listSubTree` → `selected.catalog.standardProps` 列了 17 个 hook/prop。**本插件只用了其中一个**：

```js
props.sessionId          // client.js:467 / 690 / 1703
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
| `host?.uiWorkspace?.pickDirectory?.()` | `client.js:864` | `pickDirectory(): Promise<string\|null>` |
| `host?.sessions?.refresh?.()` 之后 `host?.uiWorkspace?.openSession?.(sessionId)` | `client.js:764` | `openSession(target: SessionTarget): void` |

> **`uiWorkspace` 上没有 `openPath`。** Inspect 实测 `uiWorkspace` 的 10 个方法：`openSession` / `openWorkspace` / `forkSession` / `connectWorkspace` / `startSession` / `archiveSession` / `unarchiveSession` / `pickDirectory` / `listDirectory` / `createDirectory`，没有 `openPath`。早先「打开记忆目录」写成 `typeof host?.uiWorkspace?.openPath === 'function'` 导致**判断恒假、按钮点了没反应**（静默降级，不报错，所以很难发现）。现已改走下面的 Remote 调用。

### 2.5b `ctx.remote.session.openWorkspacePath`（客户端 → Host 的 Remote）

「在文件管理器里定位路径」的正确入口是 Session Remote，而不是 ctx 服务：

```ts
// client.js:1055 附近
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
// client.js:487（保存）、client.js:698（requestJson，打开/自动保存/工作区）
```

⇒ 依赖两个非契约事实：**(a)** 插件注册的 `/api/*` 路由与页面同源；**(b)** `credentials: 'same-origin'` 能带上 DSH 的浏览器凭据。二者都由 `ctx.connection.fetch.register` 的实现保证，目前成立。

> 注意区分：**业务路由**（保存/打开/自动保存/工作区）走自建 fetch；**「打开记忆目录」**走 `ctx.remote.session.openWorkspacePath`（§2.5b）。两者不冲突——`remote` 只用来调 DSH 已有的 Remote 方法，不自建路由。

### 2.7 国际化

`client.js:194` 读 `navigator.language`（`/^en\b/i` → 英文词表，否则中文）。**与 DSH 的 locale 服务无关**——那是浏览器语言，不是 DSH 的 `ctx.locale`。若想跟随 DSH 的语言切换，需改成 `ctx.locale`；当前是刻意不依赖。

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
5. **会话文件还能读**：`node test/smoke.mjs`（打包 + 回读）与 `node test/open.mjs`（35 条，导入与冲突）。六套测试全部通过 `test/fixture.mjs` 自建临时 `DSH_HOME`，不读真实 `~/.dsh`。
6. **跑满回归**：`node test/client.mjs && node test/dialog.mjs && node test/smoke.mjs && node test/open.mjs && node test/conflict.mjs && node test/security.mjs`，应共 225 条 ✅（详见 `docs/TEST-MATRIX.md`）。
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
