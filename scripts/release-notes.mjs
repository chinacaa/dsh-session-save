#!/usr/bin/env node
// 从 CHANGELOG.md 里抽出某个版本的正文，喂给 `gh release create --notes-file`。
//
//   node scripts/release-notes.mjs 0.2.2
//   node scripts/release-notes.mjs v0.2.2
//   node scripts/release-notes.mjs 0.2.2 --fallback "见 CHANGELOG.md"
//
// 为什么要单独一个脚本：发布说明应该只有 CHANGELOG 一个真源。以前是手写一份
// release notes 再粘进 `gh release create --notes`，等于同样的内容维护两遍，
// 发几次就一定漂。这里只做一件事——按版本号把 CHANGELOG 对应小节原样摘出来。
//
// 找不到该版本时的行为分两种：
// - 给了 --fallback：输出 fallback 文本并 exit 0。发布不该因为「忘了写 CHANGELOG」
//   就断掉（包已经发出去了，Release 建不出来反而更难收拾）。
// - 没给：exit 1，让流水线红掉。本地手动跑时这更符合预期。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const logPath = path.join(root, 'CHANGELOG.md');

const argv = process.argv.slice(2);
const fbAt = argv.indexOf('--fallback');
// --fallback 后面那一项是它的值，不算位置参数；--fallback 写在末尾没给值时按 null 处理
const fallback = fbAt === -1 ? null : (argv[fbAt + 1] ?? null);
const arg = argv.find((a, i) => !a.startsWith('--') && (fbAt === -1 || i !== fbAt + 1));

if (arg === undefined) {
  console.error('用法：node scripts/release-notes.mjs <x.y.z|vx.y.z> [--fallback "文本"]');
  process.exit(1);
}

// 前缀 v 可有可无：tag 一般是 v1.2.3，CHANGELOG 标题是 [1.2.3]
const version = arg.replace(/^v/, '');

if (!fs.existsSync(logPath)) {
  console.error(`没找到 ${logPath}`);
  process.exit(1);
}

const lines = fs.readFileSync(logPath, 'utf8').split(/\r?\n/);

// 版本标题形如 `## [0.2.2] - 2026-10-29`，也兼容没写日期的 `## [0.2.2]`
const heading = new RegExp(`^##\\s+\\[${version.replace(/\./g, '\\.')}\\](?:\\s|$)`);
const start = lines.findIndex((l) => heading.test(l));

if (start === -1) {
  const msg = `CHANGELOG.md 里没有 [${version}] 这一节`;
  if (fallback !== null) {
    console.error(`${msg}，用 --fallback 文本代替`);
    process.stdout.write(`${fallback}\n`);
    process.exit(0);
  }
  console.error(msg);
  process.exit(1);
}

// 一直取到下一个 `## `（同级标题）为止。`### 修复` 这类子标题是 `###`，不会被误判为边界。
let end = lines.length;
for (let i = start + 1; i < lines.length; i += 1) {
  if (/^##\s/.test(lines[i])) {
    end = i;
    break;
  }
}

const body = lines
  .slice(start + 1, end)
  .join('\n')
  // 连续空行压成一个，首尾空行去掉：gh 会把 markdown 原样渲染，多余空行只是噪音
  .replace(/\n{3,}/g, '\n\n')
  .trim();

if (body === '') {
  const msg = `CHANGELOG.md 的 [${version}] 一节是空的`;
  if (fallback !== null) {
    console.error(`${msg}，用 --fallback 文本代替`);
    process.stdout.write(`${fallback}\n`);
    process.exit(0);
  }
  console.error(msg);
  process.exit(1);
}

process.stdout.write(`${body}\n`);
