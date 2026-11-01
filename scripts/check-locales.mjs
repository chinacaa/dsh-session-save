#!/usr/bin/env node
/**
 * 语言包体检：`node scripts/check-locales.mjs`
 *
 * 只回答三个问题——JSON 有没有写坏、键名对不对、占位符有没有丢。
 * 翻译得地不地道不在这里判，那是 reviewer 的事。
 *
 * 退出码：0 全部通过；1 有问题（会逐条列出来，不中断）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dir = path.join(root, 'locales');
const SOURCE = 'zh-CN';

const problems = [];
const note = (message) => problems.push(message);

function readPack(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      note(`${file}：顶层必须是一个对象`);
      return undefined;
    }
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value !== 'string') note(`${file}：${key} 的值必须是字符串，实际是 ${typeof value}`);
    }
    return parsed;
  } catch (error) {
    note(`${file}：读不了或不是合法 JSON（${error.message}）`);
    return undefined;
  }
}

const files = fs.readdirSync(dir).filter((name) => name.endsWith('.json')).sort();
if (files.length === 0) {
  note('locales/ 下一个 .json 都没有');
}

const sourceFile = `${SOURCE}.json`;
if (!files.includes(sourceFile)) {
  note(`缺少源语言 ${sourceFile}——新增文案要以它为基准`);
}

const source = files.includes(sourceFile) ? readPack(sourceFile) : undefined;
const sourceKeys = source === undefined ? [] : Object.keys(source);

/** 抽出值里的 `{name}` 占位符，排序后比对；顺序不同不算错。 */
function slots(text) {
  return [...String(text).matchAll(/\{([A-Za-z][A-Za-z0-9]*)\}/g)].map((m) => m[1]).sort();
}

for (const file of files) {
  if (file === sourceFile) continue;
  const pack = readPack(file);
  if (pack === undefined) continue;

  for (const key of Object.keys(pack)) {
    if (!sourceKeys.includes(key)) {
      note(`${file}：多出一个源语言里没有的键 ${key}（键名拼错了？）`);
    }
  }

  const missing = sourceKeys.filter((key) => !(key in pack));
  if (missing.length > 0) {
    // 少翻是允许的（运行时回落中文），但要让作者知道还差多少。
    note(`${file}：还差 ${missing.length} 个键未翻译（可用，但不完整）：${missing.slice(0, 8).join('、')}${missing.length > 8 ? ' …' : ''}`);
  }

  if (source !== undefined) {
    for (const key of sourceKeys) {
      if (!(key in pack)) continue;
      const want = slots(source[key]);
      const got = slots(pack[key]);
      if (want.join(',') !== got.join(',')) {
        note(`${file}：${key} 的占位符对不上——源语言是 {${want.join('} {')}}，这里是 {${got.join('} {')}}`);
      }
    }
  }
}

const summary = files.map((file) => {
  let count = '读不出';
  try {
    count = String(Object.keys(JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'))).length);
  } catch {
    // 坏文件已经在上面报过了，这里不再重复报。
  }
  return `  ${file}：${count} 个键`;
});
console.log(`语言包：${files.length} 份\n${summary.join('\n')}`);

if (problems.length > 0) {
  console.error(`\n发现 ${problems.length} 个问题：`);
  for (const line of problems) console.error(`  - ${line}`);
  process.exit(1);
}
console.log('\n全部通过。');
