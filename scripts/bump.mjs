#!/usr/bin/env node
// 改版本号：package.json 与 CHANGELOG.md 一起动，最后把 git 命令打出来。
//
//   node scripts/bump.mjs patch        0.1.0 → 0.1.1
//   node scripts/bump.mjs minor        0.1.0 → 0.2.0
//   node scripts/bump.mjs major        0.1.0 → 1.0.0
//   node scripts/bump.mjs 0.3.0-rc.1   指定版本（0.x 阶段偶尔要给预发布号）
//   node scripts/bump.mjs patch --dry  只看会变成什么，不写盘
//
// 规则：CHANGELOG 的 [Unreleased] 有内容就提升成新版本号，没内容就记一条「仅版本号变更」。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const pkgPath = path.join(root, 'package.json');
const logPath = path.join(root, 'CHANGELOG.md');

const argv = process.argv.slice(2);
const dry = argv.includes('--dry');
const arg = argv.find((a) => a !== '--dry');

if (arg === undefined) {
  console.error('用法：node scripts/bump.mjs <patch|minor|major|x.y.z> [--dry]');
  process.exit(1);
}

const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
const current = String(pkg.version ?? '0.0.0');
const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(current);
if (m === null) {
  console.error(`package.json 里的 version 不是语义化版本：${current}`);
  process.exit(1);
}

let next;
if (arg === 'patch') next = `${m[1]}.${m[2]}.${Number(m[3]) + 1}`;
else if (arg === 'minor') next = `${m[1]}.${Number(m[2]) + 1}.0`;
else if (arg === 'major') next = `${Number(m[1]) + 1}.0.0`;
else if (/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(arg)) next = arg;
else {
  console.error(`不认识的版本参数：${arg}`);
  process.exit(1);
}

if (next === current) {
  console.log(`已经是 ${current}，没有改动。`);
  process.exit(0);
}

// package.json：只替换 version 那一行，其余格式原样保留
const pkgText = fs.readFileSync(pkgPath, 'utf8');
const bumpedPkg = pkgText.replace(/("version"\s*:\s*)"[^"]*"/, `$1"${next}"`);
if (bumpedPkg === pkgText) {
  console.error('package.json 里没找到可替换的 version 字段。');
  process.exit(1);
}

// CHANGELOG：把 [Unreleased] 顶成新版本
const today = new Date().toISOString().slice(0, 10);
const log = fs.readFileSync(logPath, 'utf8');
const marker = '## [Unreleased]';
const at = log.indexOf(marker);
let bumpedLog;

if (at === -1) {
  bumpedLog = `${log.trimEnd()}\n\n## [${next}] - ${today}\n\n- 仅版本号变更。\n`;
} else {
  const after = log.slice(at + marker.length);
  const nextSection = after.search(/^## \[/m);
  const body = (nextSection === -1 ? after : after.slice(0, nextSection)).replace(/^\s*\n/, '').trim();
  const rest = nextSection === -1 ? '' : after.slice(nextSection);
  const filled = body === '' ? '- 仅版本号变更。' : body;
  bumpedLog =
    `${log.slice(0, at)}${marker}\n\n## [${next}] - ${today}\n\n${filled}\n\n${rest}`.replace(/\n{3,}/g, '\n\n');
}

if (dry) {
  console.log(`[dry] ${current} → ${next}`);
  console.log(bumpedLog.slice(Math.max(0, bumpedLog.indexOf('## [Unreleased]')), bumpedLog.indexOf('## [Unreleased]') + 400));
} else {
  fs.writeFileSync(pkgPath, bumpedPkg, 'utf8');
  fs.writeFileSync(logPath, bumpedLog, 'utf8');
  console.log(`${current} → ${next}`);
  console.log('已更新 package.json 与 CHANGELOG.md。');
}

console.log(`\n发版三步：\n  git add -A && git commit -m "发布 v${next}"\n  git tag -a v${next} -m "v${next}"\n  git push --follow-tags`);
console.log(`\n记得同步三处版本相关的地方（都不跟着 package.json 自动变）：`);
console.log(`  · .dsproj 包格式：dshproj/1（改格式才动，与包版本无关）`);
console.log(`  · 锁格式：dshproj-lock/1，在 index.js 的 LOCK_FORMAT`);
console.log(`  · 宿主兼容范围：engines.dsh 与 peerDependencies["@deepseek-ai/cordis"]`);
