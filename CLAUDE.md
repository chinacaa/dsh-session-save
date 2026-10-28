# CLAUDE.md

Claude Code 进这个仓库先读这个，取最短路径。**完整规矩、架构、全部踩坑记录在 [AGENTS.md](AGENTS.md)** —— 要改行为、改安全校验、改路径规则、或遇到任何"为什么这样写"的疑问，去那边对齐，本文不重复。

## 一句话

DSH 插件：把当前会话另存为单个 `.dsproj` 工程文件，也能反过来从 `.dsproj` 打开并切过去。Host 半 `index.js`（四条路由），Client 半 `client.js`（五个插槽项），零运行时依赖，纯 ESM。

## 开工

```bash
node --check index.js client.js          # 改完必跑
node test/client.mjs                     # 碰到客户端最先跑（秒级）
node test/dialog.mjs                     # 碰到 dialog/ 下任何文件
node test/smoke.mjs                      # 碰到打包 / 保存路由
node test/open.mjs                       # 碰到导入 / 落地规则
node test/conflict.mjs                   # 碰到锁 / CAS / 自动保存（约 30 秒）
node test/security.mjs                   # 碰到任何校验、或说不准有没有碰到（最该跑）
node test/pathkey.mjs                    # 升级 DSH 后第一件事：路径键与官方逐字比对（几十毫秒）
```

**收工前跑全部七套**，不是只跑改到的那一个；改过客户端再加一轮 `DSH_TEST_LOCALE=en-US node test/client.mjs`（中英词表两条路径都要过）。

测试自己建临时 `DSH_HOME`（`test/fixture.mjs`），跑完自己删——**不需要**再手工核对 `~/.dsh` 里的目录数，也不要让新测试去读真实 `~/.dsh`。

## 最容易犯的错

1. 改版本别手改 `package.json` —— `node scripts/bump.mjs patch|minor|major`（它同时写 `CHANGELOG.md`）。
2. 改会话日志只重写第 0 帧，帧 1..n 原字节照搬（整体解压再压回去会改掉别的东西）。
3. `client.js` 里不许出现 `document.` / `MutationObserver` / 全局 `<style>` / 除 react 外的依赖 —— 测试有反向断言。
4. `.ps1` 存成**带 BOM 的 UTF-8**；中文路径走 `-ResultFile`，别读 stdout（PS 5.1 是 `gb2312`，读回来是乱码）。
5. 装插件别用 profile 的 `cordis.patch.yml` —— 靠包内 `cordis.patch.yml` + 包 `dsh.bundle.patch` + profile `dsh.profile.bundles`。
6. 新测试先 `makeFixture()` 再 `loadRoutes()`，顺序反了会读到真实数据根。
7. 安全校验一条都别放宽（`safeSegments` / `isInside` / `maxOutputLength` / `requestGate` / `manifest.parts` / 记忆永不落原名）；改这条线之前先读 AGENTS.md 红线 10。

## 改完之后

- 行为变了 → `CHANGELOG.md` 的 `[Unreleased]` 加一条（中文，按「新增 / 修复 / 变更 / 安全」分组；纯文档改动可不加）。
- 功能点或断言变了 → 同步 `docs/TEST-MATRIX.md` 的覆盖表（按 F 编号列，条数对不上就是漏改）。
- 不主动 `git commit`、不 `git push`，除非用户明说。
- 不碰 `assets/` 里的截图（除非要求重做）；不往仓库里放 `.dsproj`。
- 回答用中文；代码标识符、命令、报错保持原文。
