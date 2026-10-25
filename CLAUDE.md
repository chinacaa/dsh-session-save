# CLAUDE.md

Claude Code 进这个仓库时先读这个文件；**完整规矩在 [AGENTS.md](AGENTS.md)**（含九条红线与全部踩坑记录）。本文件只放最短路径和 Claude 自己的做事习惯。

## 一句话

DSH 插件：把会话另存为单个 `.dsproj` 文件，并能从 `.dsproj` 打开会话。Host 半 `index.js`（四条路由），Client 半 `client.js`（五个插槽项），零运行时依赖，纯 ESM。

## 开工前

```bash
node --check index.js client.js     # 改完必跑
node test/client.mjs                # 改动碰到客户端时最先跑这个（秒级）
node test/smoke.mjs                 # 改动碰到打包/路由时跑
node test/open.mjs                  # 改动碰到导入/落地规则时跑
node test/conflict.mjs              # 改动碰到锁/CAS/自动保存时跑（约 30 秒）
node test/dialog.mjs                # 改动碰到 .ps1 或中文路径时跑
```

**收工前跑全部五个**，不是只跑改到的那个；然后确认 `~/.dsh/sessions` 回到 5 个目录、`~/.dsh/memory/workspaces` 回到 3 个、`storages/session-save.json` 没留下测试会话的键。

## 五条最容易犯的错

1. 改版本别手改 `package.json` —— `node scripts/bump.mjs patch|minor|major`。
2. 改会话日志只重写第 0 帧，帧 1..n 原字节照搬。
3. `client.js` 里不许出现 `document.` / `MutationObserver` / 全局样式 / 新依赖（测试有反向断言）。
4. `.ps1` 存成带 BOM 的 UTF-8；中文路径走 `-ResultFile`，别读 stdout（PS 5.1 是 `gb2312`）。
5. 别用 profile 的 `cordis.patch.yml` 装插件，靠 `dsh.bundle.patch` + `dsh.profile.bundles`。

## 改完之后

- 行为变了 → `CHANGELOG.md` 的 `[Unreleased]` 加一条（中文，按「新增/修复/变更」分组）。
- 不主动 `git commit`、不 `git push`，除非用户明说。
- 不碰 `assets/` 里的截图除非用户要求重做；不往仓库里放 `.dsproj`。
- 回答用中文；代码标识符、命令、报错保持原文。
