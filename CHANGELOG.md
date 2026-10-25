# 变更记录

格式参照 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### 安全

- 修掉 ZIP 条目名穿越（`../../x` 或 `..\..\x`）：读包阶段就按段校验并拒绝，导入时记忆文件落点逐段 `safeJoin`，一条都不出目标目录。
- 修掉 `manifest.session.fileName` 穿越：只接受 `session[.tag].jsonl[.zstd]` 形态的文件名并取 basename，落点必须仍在 `~/.dsh/sessions` 里，目标已存在则不覆盖。
- 解压炸弹防护：单条目 64 MB、整包 512 MB、压缩比 200×（4 MB 以下不计比例）；`inflateRawSync` 带 `maxOutputLength`，中央目录字段先做越界校验。
- 保存路由加白名单：只允许写到上次用的目录、已记住文件的目录，或原生对话框选的位置；覆盖陌生文件要先 `confirm-overwrite`，且对方必须是我们自己的 `.dsproj`。
- 打开路由收紧：只接受 `.dsproj`，失败信息不再回显绝对路径；`sessionId` 形态校验，`findSessionFile` 不再按原样字符串拼路径。
- 四条 `/api` 路由统一入口校验：只接受回环 Host、同源 Origin、非 `cross-site` 请求。
- 包完整性：`manifest.parts` 的 sha256 / 字节数逐条复核，未知条目直接拒绝。
- 侧车锁带持有者 token，只删自己那份；状态文件改原子写，避免半个 JSON 让记住的路径全丢。
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
