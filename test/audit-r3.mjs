/**
 * 安全审计第 3 轮（AUDIT-R3.md）修复项的常驻回归：R3-1 / R3-3 / R3-4 / R3-5 / R3-6 / R3-8。
 *
 * 这几条都不是「再跑一遍正常流程」，而是把 R3 报告里实测过的形态钉死：
 *   R3-1  解包阶段抛错要变成 package-broken（带可贴给 AI 的修包说明），不是 500 通用文案；
 *   R3-3  落盘文件名逐段校验，而且必须在补 `.dsproj` 之前判（否则尾点会被藏进更难看的名字）；
 *   R3-4  锁判定的时钟回拨（Math.abs）+ 侧车锁冲突映射成 409 locked，且 ignoreLock 真能绕过；
 *   R3-5  只有真切掉行时才算 partial / trimmed:true；
 *   R3-6  ENTRY_SINCE 里的引入版本不得超过当前版本（否则提示自相矛盾）；
 *   R3-8  writeAtomic 失败时把 ADS 留下的裸文件删掉。
 *
 * 每条断言都能独立变红：改回旧实现，对应那一行就会失败。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';

import { autoCleanup, loadRoutes, makeFixture } from './fixture.mjs';

const fx = makeFixture();
autoCleanup(fx);

const { mod, routes } = await loadRoutes('../index.js');
const { ROUTE, OPEN_ROUTE, compareVersions, lockBlocks, trimSession, writeAtomic, zipWrite } = mod;
const saveRoute = routes.get(ROUTE);
const openRoute = routes.get(OPEN_ROUTE);

let passed = 0;
let failed = 0;
const check = (ok, label, extra = '') => {
  if (ok) {
    passed += 1;
    console.log(`✅ ${label}${extra === '' ? '' : ' · ' + extra}`);
  } else {
    failed += 1;
    console.error(`✗ ${label}${extra === '' ? '' : ' · ' + extra}`);
  }
};

const ZSTD_FRAME_OPTS = { params: { [zlib.constants.ZSTD_c_checksumFlag]: 1 } };
const frameOf = (text) => zlib.zstdCompressSync(Buffer.from(text, 'utf8'), ZSTD_FRAME_OPTS);
const OUT = path.join(fx.home, 'out');
fs.mkdirSync(OUT, { recursive: true });
fs.mkdirSync(path.join(fx.home, 'storages'), { recursive: true });
// 保存只认「用过的目录」，先把 lastDir 指到临时输出目录。
fs.writeFileSync(
  path.join(fx.home, 'storages', 'session-save.json'),
  JSON.stringify({ paths: {}, lastDir: OUT, autosave: {}, stamps: {}, stale: {}, missing: {} }),
);

const call = async (handler, route, query = {}) => {
  const search = new URLSearchParams(query);
  const url = `http://127.0.0.1:3080${route}${search.toString() === '' ? '' : '?' + search.toString()}`;
  const response = await handler(new Request(url, { headers: { origin: 'http://127.0.0.1:3080' } }));
  let body;
  try {
    body = await response.json();
  } catch {
    body = undefined;
  }
  return { status: response.status, body };
};

const headerOf = (id) =>
  JSON.stringify({ type: 'session', version: 4, id, cwd: 'C:/demo', createdAt: 1792340086210, title: '审计样本' }) + '\n';

/* ── R3-1：解包阶段抛错也要走 packageBrokenReport ── */
{
  const garbage = path.join(OUT, `garbage-${randomUUID()}.dsproj`);
  fs.writeFileSync(garbage, Buffer.from('这根本不是 zip，只是一段纯文本。', 'utf8'));
  const broken = await call(openRoute, OPEN_ROUTE, { path: garbage, cwd: OUT });
  check(
    broken.status === 500 && broken.body?.status === 'package-broken',
    'R3-1 非 zip 的 .dsproj → package-broken',
    `${broken.status} ${broken.body?.status ?? ''}`,
  );
  const prompt = String(broken.body?.prompt ?? '');
  check(prompt.includes('这个包的本质是一个 zip'), 'R3-1 带出「包其实是 zip」的修包说明');
  check(prompt.includes('包路径：') && prompt.includes(garbage), 'R3-1 修包说明里带包路径');
  check(Array.isArray(broken.body?.entries) && broken.body.entries.length === 0, 'R3-1 解不开时条目清单是空数组');
  check(
    typeof broken.body?.message === 'string' && broken.body.message !== '',
    'R3-1 message 是解包器原话',
    String(broken.body?.message ?? '').slice(0, 40),
  );

  // 中央目录被砍掉：同样是「包坏了」，不是服务端内部故障。
  const good = path.join(OUT, `good-${randomUUID()}.dsproj`);
  const saved = await call(saveRoute, ROUTE, { sessionId: fx.session.id, path: good, force: '1' });
  assert.equal(saved.status, 200, 'seed 包保存失败：' + JSON.stringify(saved.body));
  const whole = fs.readFileSync(good);
  const cut = path.join(OUT, `cut-${randomUUID()}.dsproj`);
  fs.writeFileSync(cut, whole.subarray(0, 60));
  const truncated = await call(openRoute, OPEN_ROUTE, { path: cut, cwd: OUT });
  check(truncated.body?.status === 'package-broken', 'R3-1 截断的包 → package-broken', truncated.body?.status ?? '');
  check(String(truncated.body?.prompt ?? '').includes('包路径：'), 'R3-1 截断的包也带修包说明');
}

/* ── R3-3：落盘文件名校验，且在补扩展名之前 ── */
{
  const before = new Set(fs.readdirSync(OUT));
  const cases = [
    ['name.', '尾点'],
    ['ads:stream', 'ADS 冒号'],
    ['CON', '设备名'],
    ['nul.txt', '设备名带扩展'],
    ['bad<name', '非法字符 <'],
  ];
  for (const [name, why] of cases) {
    const r = await call(saveRoute, ROUTE, { sessionId: fx.session.id, path: path.join(OUT, name), force: '1' });
    check(r.status === 400 && r.body?.status === 'bad-name', `R3-3 ${why} → 400 bad-name`, `${r.status} ${r.body?.status ?? ''}`);
  }

  // 尾点必须在补 `.dsproj` 之前判：补完会变成 `x.dsproj..dsproj`，错误被藏进一个更难看的名字。
  const dotted = await call(saveRoute, ROUTE, { sessionId: fx.session.id, path: path.join(OUT, 'x.dsproj.'), force: '1' });
  check(
    dotted.status === 400 && dotted.body?.status === 'bad-name',
    'R3-3 尾点在补扩展名之前就被拦',
    `${dotted.status} ${dotted.body?.status ?? ''}`,
  );
  check(
    !fs.existsSync(path.join(OUT, 'x.dsproj..dsproj')) && !fs.existsSync(path.join(OUT, 'x.dsproj')),
    'R3-3 没有多出 x.dsproj..dsproj 这种文件',
  );

  const after = fs.readdirSync(OUT).filter((name) => !before.has(name));
  check(after.length === 0, 'R3-3 被拒的名字一个文件都没落盘', after.join(',') || '');
  check(!fs.existsSync(path.join(OUT, 'ads')) && !fs.existsSync(path.join(OUT, 'nul.txt')), 'R3-3 ADS / 设备名没留下裸文件');

  const ok = await call(saveRoute, ROUTE, { sessionId: fx.session.id, path: path.join(OUT, 'ok-name'), force: '1' });
  check(ok.status === 200 && ok.body?.status === 'saved', 'R3-3 合法名字不被误拒', `${ok.status} ${ok.body?.status ?? ''}`);
}

/* ── R3-8：writeAtomic 失败后不留 ADS 裸文件 ──
 * 现状（2026-11-03 复测）：这条断言是红的。index.js:1387-1394 用 `tmp.indexOf(':')` 找冒号，
 * 绝对路径上第一个冒号永远是盘符那个（index 1），`colon > 1` 恒为假，清理分支等于死代码；
 * 再加上 `!/^[A-Za-z]:[\\/]/.test(tmp)` 这一条，绝对路径被明确排除。实测 `adsprobe:stream.dsproj`
 * 写盘抛 EINVAL 之后，目录里留下 0 字节的 `adsprobe`。修法见 AUDIT-R3-R4 复测报告 N1。 */
{
  const bareName = `adsprobe-${randomUUID().slice(0, 8)}`;
  const bare = path.join(OUT, bareName);
  const target = path.join(OUT, `${bareName}:stream.dsproj`);
  let threw;
  try {
    writeAtomic(target, Buffer.from('x'));
  } catch (error) {
    threw = error;
  }
  check(threw !== undefined, 'R3-8 ADS 目标写盘会失败（前提成立）', threw?.code ?? 'no-throw');
  check(!fs.existsSync(bare), 'R3-8 失败后 ADS 裸文件已被清掉', fs.existsSync(bare) ? `残留 ${bareName}` : '');
}

/* ── R3-4：锁判定（Math.abs）与侧车锁映射 ── */
{
  const now = Date.now();
  const foreignLock = (at, over = {}) => ({
    host: `another-host-${randomUUID().slice(0, 6)}`,
    pid: 4242,
    at,
    ...over,
  });
  check(lockBlocks(foreignLock(new Date(now).toISOString())) !== undefined, 'R3-4 他机刚写的锁 → 拦住');
  check(lockBlocks(foreignLock(new Date(now - 3600 * 1000).toISOString())) === undefined, 'R3-4 超过 TTL 的旧锁 → 放行');
  check(
    lockBlocks(foreignLock(new Date(now + 24 * 3600 * 1000).toISOString())) === undefined,
    'R3-4 未来 24h 的时间戳 → 放行（Math.abs，时钟回拨不再变成永久锁）',
  );
  check(lockBlocks(foreignLock('not-a-date')) === undefined, 'R3-4 at 解析不出来 → 放行');
  check(
    lockBlocks(foreignLock(new Date(now).toISOString(), { host: os.hostname(), pid: 999999 })) === undefined,
    'R3-4 本机已死 pid → 放行',
  );
}

{
  // 真正的侧车锁冲突：另一个「活着」的进程正拿着 <target>.lock。
  const holder = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
  await new Promise((resolve) => holder.once('spawn', resolve));
  try {
    const target = path.join(OUT, `locked-${randomUUID()}.dsproj`);
    const sidecar = `${target}.lock`;
    const foreign = { host: os.hostname(), pid: holder.pid, at: new Date().toISOString(), token: 'foreign-token' };
    fs.writeFileSync(sidecar, JSON.stringify(foreign));

    const blocked = await call(saveRoute, ROUTE, { sessionId: fx.session.id, path: target });
    check(blocked.status === 409, 'R3-4 侧车锁冲突是 409 不是 500', `${blocked.status}`);
    check(
      blocked.body?.status === 'locked' && blocked.body?.canIgnoreLock === true,
      'R3-4 冲突体是 locked + canIgnoreLock',
      `${blocked.body?.status ?? ''} / ${blocked.body?.canIgnoreLock ?? ''}`,
    );
    check(blocked.body?.lock?.token === 'foreign-token', 'R3-4 409 里带上了占锁方信息');
    check(!fs.existsSync(target), 'R3-4 被拒时没有落盘');
    let kept;
    try {
      kept = JSON.parse(fs.readFileSync(sidecar, 'utf8')).token;
    } catch {
      kept = undefined;
    }
    check(kept === 'foreign-token', 'R3-4 被拒时不动别人的侧车锁', String(kept));

    const forced = await call(saveRoute, ROUTE, { sessionId: fx.session.id, path: target, ignoreLock: '1' });
    check(
      forced.status === 200 && forced.body?.status === 'saved',
      'R3-4 ignoreLock=1 真能绕过侧车锁',
      `${forced.status} ${forced.body?.status ?? ''}`,
    );
    check(fs.existsSync(target), 'R3-4 绕过之后确实落盘了');
    check(!fs.existsSync(sidecar), 'R3-4 绕过之后自己的侧车锁已收尾');
  } finally {
    holder.kill();
  }
}

{
  // 时钟回拨留下的「未来锁」不许挡保存：HTTP 这一层也要放行，而不是只放行单元函数。
  const target = path.join(OUT, `future-${randomUUID()}.dsproj`);
  fs.writeFileSync(
    `${target}.lock`,
    JSON.stringify({ host: 'some-other-host', pid: 111, at: new Date(Date.now() + 86400 * 1000).toISOString(), token: 'future' }),
  );
  const r = await call(saveRoute, ROUTE, { sessionId: fx.session.id, path: target });
  check(r.status === 200 && r.body?.status === 'saved', 'R3-4 未来时间戳的侧车锁不挡保存', `${r.status} ${r.body?.status ?? ''}`);
}

/* ── R3-5：partial / trimmed 只在真切掉行时为真 ── */
{
  const turn = (seq, bodies) =>
    [
      JSON.stringify({ type: 'turn/start', seq, time: 1, data: { turn: 1 } }),
      ...bodies.map((text, index) =>
        JSON.stringify({
          type: 'user/message',
          seq: seq + 1 + index,
          time: 1,
          data: { content: [{ type: 'text', text }], role: 'user' },
        }),
      ),
      JSON.stringify({ type: 'turn/end', seq: seq + 900, time: 1, data: { turn: 1 } }),
    ].join('\n') + '\n';

  // A：这一轮只有「turn/start + 一行正文」，而且日志正好断在这里（写到一半被杀）。
  // 尾切只切得动行边界，最后一行就是那一行巨内容 —— 一个字节都没丢，不许报 trimmed。
  // 注意别用「start + 正文 + turn/end」三行：那时被切掉的是 turn/end，确实丢了行，trimmed 就该是 true。
  const oneLine = Buffer.concat([
    frameOf(headerOf(`session-${randomUUID()}`)),
    frameOf(
      [
        JSON.stringify({ type: 'turn/start', seq: 1, time: 1, data: { turn: 1 } }),
        JSON.stringify({ type: 'user/message', seq: 2, time: 1, data: { content: [{ type: 'text', text: 'x'.repeat(2 * 1024 * 1024) }], role: 'user' } }),
      ].join('\n') + '\n',
    ),
  ]);
  const a = trimSession(oneLine, { budget: 100 });
  check(a.report.trimmed === false, 'R3-5 单行巨轮切不动时不报 trimmed:true', JSON.stringify(a.report));
  check(a.report.oversizeTurn === true, 'R3-5 但仍如实标 oversizeTurn');
  check(a.report.droppedTurns === 0 && a.report.keptTurns === 1, 'R3-5 单行巨轮一轮都没丢');

  // B：轮内有多行，按行从尾部切 —— 真切掉行，trimmed:true，但 droppedTurns 仍是 0。
  const manyLines = Buffer.concat([
    frameOf(headerOf(`session-${randomUUID()}`)),
    frameOf(turn(10, ['a'.repeat(4000), 'b'.repeat(4000), 'c'.repeat(4000), 'd'.repeat(4000)])),
  ]);
  const b = trimSession(manyLines, { budget: 100 });
  check(b.report.trimmed === true, 'R3-5 真切掉行时 trimmed:true', JSON.stringify(b.report));
  check(b.report.droppedTurns === 0 && b.report.oversizeTurn === true, 'R3-5 切的是轮内行，droppedTurns 仍为 0');

  // C：预算只够最后一轮 —— 整轮丢弃，droppedTurns 如实计数。
  const dropped = Buffer.concat([
    frameOf(headerOf(`session-${randomUUID()}`)),
    frameOf(turn(20, ['f'.repeat(100 * 1024)]) + turn(21, ['f'.repeat(100 * 1024)]) + turn(30, ['tail'])),
  ]);
  const c = trimSession(dropped, { budget: 100 });
  check(c.report.trimmed === true && c.report.droppedTurns > 0, 'R3-5 整轮被丢时 droppedTurns > 0', JSON.stringify(c.report));
  check(c.report.oversizeTurn === false, 'R3-5 整轮丢弃不该被标成 oversizeTurn');

  // D：预算够 —— 早退分支，trimmed:false。
  const fits = Buffer.concat([frameOf(headerOf(`session-${randomUUID()}`)), frameOf(turn(40, ['small']) + turn(50, ['small']))]);
  const d = trimSession(fits, { budget: 10000 });
  check(d.report.trimmed === false && d.report.droppedTurns === 0, 'R3-5 预算够时 trimmed:false', JSON.stringify(d.report));
}

/* ── R3-6：ENTRY_SINCE 的引入版本不得超过当前版本 ── */
{
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const src = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8');
  const lines = src.split('\n');
  const startAt = lines.findIndex((line) => line.includes('const ENTRY_SINCE'));
  let endAt = -1;
  for (let i = startAt + 1; startAt >= 0 && i < lines.length; i += 1) {
    if (lines[i].trim() === '];') {
      endAt = i;
      break;
    }
  }
  const table = [];
  for (let i = startAt + 1; startAt >= 0 && endAt > startAt && i < endAt; i += 1) {
    const prefix = lines[i].match(/\[\/(\^[A-Za-z0-9_-]+)/);
    const version = lines[i].match(/'(\d+\.\d+\.\d+)'/);
    if (prefix !== null && version !== null) table.push([prefix[1].slice(1), version[1]]);
  }
  check(table.length >= 2, 'R3-6 ENTRY_SINCE 表能解析出来', table.map((row) => row.join('@')).join(',') || '空表');
  const over = table.filter(([, version]) => compareVersions(version, pkg.version) > 0);
  check(over.length === 0, 'R3-6 每项引入版本都 ≤ 当前插件版本', over.map((row) => row.join('@')).join(',') || pkg.version);
  const bili = table.find(([prefix]) => prefix === 'bili');
  check(bili !== undefined && compareVersions(bili[1], '0.4.2') >= 0, 'R3-6 bili 的引入版本不早于 0.4.2', bili?.join('@') ?? 'missing');

  // 行为面：当前版本写出的包（含 bili 条目）不许被说成「包比插件新」。
  const makePackage = (writer) => {
    const id = `session-${randomUUID()}`;
    const logName = `session/${id}.jsonl`;
    const entries = [
      { name: logName, data: Buffer.from('{"type":"session","version":4,"id":"' + id + '","cwd":"C:/demo"}\n', 'utf8') },
      { name: 'bili/session.json', data: Buffer.from('{}', 'utf8') },
      { name: 'weird/x', data: Buffer.from('x', 'utf8') },
    ];
    const parts = {};
    for (const entry of entries) {
      parts[entry.name] = { sha256: createHash('sha256').update(entry.data).digest('hex'), bytes: entry.data.length };
    }
    const manifest = { format: 'dshproj/1', plugin: { name: 'dsh-session-save', version: writer }, parts, session: { id } };
    const file = path.join(OUT, `bili-${randomUUID()}.dsproj`);
    fs.writeFileSync(
      file,
      zipWrite([{ name: 'manifest.json', data: Buffer.from(JSON.stringify(manifest), 'utf8') }, ...entries]),
    );
    return file;
  };

  const same = await call(openRoute, OPEN_ROUTE, { path: makePackage(pkg.version), cwd: OUT });
  check(
    same.body?.status === 'package-broken',
    'R3-6 同版本写出的包被判成「不认识的条目」而不是「更新版本」',
    `${same.body?.status ?? ''}`,
  );
  check(!String(same.body?.message ?? '').includes('更新版本'), 'R3-6 同版本的提示里不出现「更新版本」');
  const newer = await call(openRoute, OPEN_ROUTE, { path: makePackage('0.4.3'), cwd: OUT });
  check(newer.body?.status === 'newer-package', 'R3-6 真更新的包才说「先升级插件」', `${newer.body?.status ?? ''}`);
}

if (failed > 0) {
  console.error(`\n✗ audit-r3 自检失败：${failed} 条`);
  process.exit(1);
}
console.log(`\n✅ audit-r3 自检通过（${passed} 条）`);
