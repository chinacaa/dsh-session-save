/**
 * Smoke test for dsh-session-save (Host half).
 *
 * Runs the real route handler against a real Session log, writes a package to a
 * temp directory, then re-reads it as a ZIP to confirm the shape.
 *
 *   node plugins/dsh-session-save/test/smoke.mjs [session-id]
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { apply, ROUTE, sanitizeName, suggestPath } from '../index.js';

const routes = new Map();
apply({ connection: { fetch: { register: (spec) => routes.set(spec.path, spec) } } });
const handler = routes.get(ROUTE);
if (handler === undefined) throw new Error(`route was not registered: ${[...routes.keys()].join(', ')}`);

const sessionsRoot = path.join(os.homedir(), '.dsh', 'sessions');
const ids = [];
for (const project of fs.readdirSync(sessionsRoot)) {
  const dir = path.join(sessionsRoot, project);
  if (!fs.statSync(dir).isDirectory()) continue;
  for (const entry of fs.readdirSync(dir)) {
    try {
      if (fs.readdirSync(path.join(dir, entry)).some((f) => /^session.*\.jsonl\.zstd$/.test(f))) ids.push(entry);
    } catch {
      /* 不是会话目录 */
    }
  }
}
if (ids.length === 0) throw new Error(`没有可测的会话：${sessionsRoot}`);

const sessionId = process.argv[2] ?? ids[0];
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-session-save-'));
const target = path.join(tmp, 'smoke.dsproj');

// 保存路由只允许写到「上次用的目录」或已记住文件的目录下。测试前把 lastDir 指向本次临时目录，
// 结束时把状态文件恢复原样（原来没有就删掉），避免在 ~/.dsh 里留下痕迹。
const dshHome = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh');
const stateFile = path.join(dshHome, 'storages', 'session-save.json');
const stateBackup = fs.existsSync(stateFile) ? fs.readFileSync(stateFile, 'utf8') : undefined;
const restoreState = () => {
  if (stateBackup === undefined) fs.rmSync(stateFile, { force: true });
  else fs.writeFileSync(stateFile, stateBackup);
};
{
  const state = stateBackup === undefined ? {} : JSON.parse(stateBackup);
  state.lastDir = tmp;
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
}

const first = await handler.fetch(new Request(`http://127.0.0.1:3080${ROUTE}?sessionId=${encodeURIComponent(sessionId)}&path=${encodeURIComponent(target)}`));
const firstBody = await first.json();
if (first.status !== 200 || firstBody.status !== 'saved') throw new Error(`第一次保存失败: ${JSON.stringify(firstBody)}`);

const second = await handler.fetch(new Request(`http://127.0.0.1:3080${ROUTE}?sessionId=${encodeURIComponent(sessionId)}`));
const secondBody = await second.json();
if (secondBody.path !== target) throw new Error(`第二次保存没有复用路径: ${JSON.stringify(secondBody)}`);

const zip = fs.readFileSync(target);
const eocd = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
if (eocd < 0) throw new Error('产物不是 ZIP');
const count = zip.readUInt16LE(eocd + 10);
const names = [];
let p = zip.readUInt32LE(eocd + 16);
for (let i = 0; i < count; i++) {
  const method = zip.readUInt16LE(p + 10);
  const csize = zip.readUInt32LE(p + 20);
  const nlen = zip.readUInt16LE(p + 28);
  const elen = zip.readUInt16LE(p + 30);
  const clen = zip.readUInt16LE(p + 32);
  const lo = zip.readUInt32LE(p + 42);
  names.push(zip.toString('utf8', p + 46, p + 46 + nlen));
  if (i === 0) {
    const dataStart = lo + 30 + zip.readUInt16LE(lo + 26) + zip.readUInt16LE(lo + 28);
    const raw = zip.subarray(dataStart, dataStart + csize);
    const data = method === 0 ? raw : zlib.inflateRawSync(raw);
    if (data.readUInt32LE(0) !== 0xfd2fb528) throw new Error('会话条目不是 zstd 帧');
  }
  p += 46 + nlen + elen + clen;
}
for (const required of ['manifest.json', 'SUMMARY.md']) {
  if (!names.includes(required)) throw new Error(`缺条目 ${required}`);
}
if (!names.some((n) => n.startsWith('session/'))) throw new Error('缺会话日志');

// 默认命名：会话标题 + 创建时间；标题里的非法字符要被清掉
const named = suggestPath(sessionId, { id: sessionId, createdAt: 1792340086210 }, { lastDir: tmp }, '会话/标题:带*非法?"字符"');
const base = path.basename(named);
if (!/\.dsproj$/.test(base)) throw new Error(`默认名没有扩展名: ${base}`);
if (/[<>:"/\\|?*]/.test(base)) throw new Error(`默认名含非法字符: ${base}`);
if (!base.startsWith('会话 标题 带 非法 字符')) throw new Error(`默认名没有用标题: ${base}`);
if (!/-\d{8}-\d{4}\.dsproj$/.test(base)) throw new Error(`默认名缺时间戳: ${base}`);
const noTitle = path.basename(suggestPath(sessionId, { id: sessionId, createdAt: 1792340086210 }, { lastDir: tmp }));
if (!/^\d{8}-\d{4}-session-[0-9a-f]{8}\.dsproj$/.test(noTitle)) throw new Error(`无标题时的兜底名不对: ${noTitle}`);
if (sanitizeName(undefined) !== '') throw new Error('sanitizeName(undefined) 应为空串');

console.log('✅ smoke 通过');
console.log(`   会话 ${sessionId}`);
console.log(`   包体 ${(fs.statSync(target).size / 1024).toFixed(1)} KB / ${names.length} 个条目 / 记忆 ${firstBody.memoryFiles} 个`);
console.log(`   重复保存复用路径: ${secondBody.path}`);
console.log(`   默认文件名: ${base}`);
console.log(`   无标题兜底: ${noTitle}`);
restoreState();
fs.rmSync(tmp, { recursive: true, force: true });
