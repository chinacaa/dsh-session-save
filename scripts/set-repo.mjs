#!/usr/bin/env node
// Fill the OWNER placeholder in the files that carry a GitHub URL.
//
//   node scripts/set-repo.mjs <github-owner> [repo-name]
//
// Examples:
//   node scripts/set-repo.mjs octocat
//   node scripts/set-repo.mjs octocat dsh-session-save
//
// It rewrites package.json (repository/homepage/bugs), LICENSE, README.md and the
// marketplace entry, then renames the entry file to <owner>__<repo>.yml.
// Run it once after creating the GitHub repo; running it twice is harmless.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const [owner, repoArg] = process.argv.slice(2);
const repo = repoArg && repoArg.trim() !== '' ? repoArg.trim() : 'dsh-session-save';

if (owner === undefined || owner.trim() === '') {
  console.error('用法：node scripts/set-repo.mjs <github-owner> [repo-name]');
  process.exit(1);
}
if (!/^[A-Za-z0-9-]+$/.test(owner) || !/^[A-Za-z0-9._-]+$/.test(repo)) {
  console.error('owner 只能含字母、数字、连字符；repo 还能含点和下划线。');
  process.exit(1);
}

const targets = ['package.json', 'LICENSE', 'README.md', 'marketplace/dsh-session-save.yml'];
const touched = [];

for (const rel of targets) {
  const file = path.join(here, rel);
  if (!fs.existsSync(file)) continue;
  const before = fs.readFileSync(file, 'utf8');
  const after = before.replaceAll('OWNER/dsh-session-save', `${owner}/${repo}`).replaceAll('OWNER', owner);
  if (after !== before) {
    fs.writeFileSync(file, after, 'utf8');
    touched.push(rel);
  }
}

const entry = path.join(here, 'marketplace', 'dsh-session-save.yml');
const renamed = path.join(here, 'marketplace', `${owner}__${repo}.yml`);
if (fs.existsSync(entry) && entry !== renamed) {
  fs.renameSync(entry, renamed);
  touched.push(`marketplace/${owner}__${repo}.yml`);
}

console.log(`owner=${owner} repo=${repo}`);
console.log(touched.length === 0 ? '没有需要改的文件（可能已经填过）。' : `已更新：${touched.join('、')}`);
console.log(`\n下一步：\n  git add -A && git commit -m "初始化"\n  git remote add origin https://github.com/${owner}/${repo}.git\n  git push -u origin main`);
console.log(`上架：把 marketplace/${owner}__${repo}.yml 复制成 awesome-dsh-plugin 仓库里的 data/plugins/${owner}__${repo}.yml，然后提 PR。`);
