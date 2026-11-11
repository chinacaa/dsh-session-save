// 上下文预算（billion-context 兼容）：导入时按预算从尾部保留完整 turn。
// 这一套只验 trimSession / estimateContext 本身，端到端的包导入在 security.mjs 的 R13 段。
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { loadRoutes } from './fixture.mjs';

const OPTS = { params: { [zlib.constants.ZSTD_c_checksumFlag]: 1 } };
const { mod } = await loadRoutes('../index.js');
const { estimateContext, trimSession } = mod;

function buildLog({ turns, textSize = 400, id = 'session-ctx-test' }) {
  const header = {
    type: 'session',
    version: 4,
    id,
    createdAt: 1700000000000,
    cwd: 'C:/tmp/ctx-ws',
    isSeeded: false,
    delegationDepth: 0,
    agentPreset: 'standard',
  };
  const lines = [JSON.stringify(header), JSON.stringify({ type: 'permission/preset', seq: 0, data: { preset: 'danger-full-access' } })];
  let seq = 1;
  const filler = (ch) => ch.repeat(textSize);
  for (let turn = 1; turn <= turns; turn += 1) {
    lines.push(JSON.stringify({ type: 'turn/start', seq: seq++, time: 1700000001000 + turn, data: { turn } }));
    lines.push(
      JSON.stringify({
        type: 'user/message',
        seq: seq++,
        time: 1700000001000 + turn,
        data: { content: [{ type: 'text', text: filler('问') }], role: 'user', id: 'u' + turn },
        surfaceOp: 'append',
      }),
    );
    lines.push(
      JSON.stringify({
        type: 'assistant/message',
        seq: seq++,
        time: 1700000001000 + turn,
        data: { turn, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: filler('答') }] } },
      }),
    );
    lines.push(JSON.stringify({ type: 'turn/end', seq: seq++, time: 1700000001000 + turn, data: { turn, reason: { kind: 'completed' } } }));
  }
  return zlib.zstdCompressSync(Buffer.from(lines.join('\n') + '\n', 'utf8'), OPTS);
}

function decodeLines(buffer) {
  const out = [];
  const text = zlib.zstdDecompressSync(buffer, { maxOutputLength: 256 * 1024 * 1024 }).toString('utf8');
  for (const line of text.split('\n')) if (line !== '') out.push(line);
  return out;
}

const big = buildLog({ turns: 8 });

// ① 估算：能给出 line 数与 token 量，且 token 明显小于字节
const estimate = estimateContext(big);
assert.equal(estimate.lines > 0, true, '估算应该数出行数');
assert.equal(estimate.bytes > estimate.tokens, true, '按每 token 3.2 字节折算，token 必然小于字节');
console.log('✅ 估算跑得动 · ' + estimate.lines + ' 行 / ' + estimate.tokens + ' token');

// ② 预算够用时一个字节都不动
const untouched = trimSession(big, { budget: 10_000_000 });
assert.equal(untouched.report.trimmed, false, '预算够就不该裁');
assert.equal(untouched.buffer.equals(big), true, '没裁就必须原样返回，不能重压');
console.log('✅ 预算够时不裁 · trimmed=false 且 buffer 未变');

// ③ 预算不够时从尾部保留完整 turn
const trimmed = trimSession(big, { budget: 900 });
assert.equal(trimmed.report.trimmed, true, '预算不够就该裁');
assert.equal(trimmed.report.keptTurns > 0, true, '至少要留一轮，否则用户什么都看不到');
assert.equal(trimmed.report.keptTurns < trimmed.report.turns, true, '裁完必须比原来少');
assert.equal(trimmed.report.tokensAfter < trimmed.report.tokensBefore, true, 'token 必须真的降下来');
console.log(
  '✅ 超预算从尾部保留完整 turn · 保留 ' +
    trimmed.report.keptTurns +
    '/' +
    trimmed.report.turns +
    ' 轮，' +
    trimmed.report.tokensBefore +
    ' → ' +
    trimmed.report.tokensAfter +
    ' token',
);

// ④ 裁完仍然是个合法会话：header 在、每行能 parse、turn 完整
const kept = decodeLines(trimmed.buffer);
for (const line of kept) assert.doesNotThrow(() => JSON.parse(line), '裁完每一行都得是合法 JSON');
const headerLine = JSON.parse(kept[0]);
assert.equal(headerLine.type, 'session', '第一行必须还是会话头');
assert.equal(headerLine.id, 'session-ctx-test', '会话 id 不能被改');
const starts = kept.filter((line) => JSON.parse(line).type === 'turn/start').length;
const ends = kept.filter((line) => JSON.parse(line).type === 'turn/end').length;
assert.equal(starts, ends, 'turn/start 与 turn/end 必须成对，否则 DSH 会读到半个轮次');
assert.equal(starts, trimmed.report.keptTurns, '保留的轮数要与报告一致');
console.log('✅ 裁完仍是合法会话 · header 在、' + starts + ' 对 turn 完整、每行可解析');

// ⑤ turn 号从 1 连续，不留跳号
const turnNumbers = kept.filter((line) => JSON.parse(line).type === 'turn/start').map((line) => JSON.parse(line).data.turn);
assert.deepEqual(
  turnNumbers,
  turnNumbers.map((_, index) => index + 1),
  'turn 号必须从 1 连续，跳号会让界面显示成「第 87 轮」',
);
console.log('✅ turn 号重排为 1..' + turnNumbers.length + ' 连续');

// ⑥ 被砍掉的部分要说清楚，用户得知道去哪儿找
const notices = kept.filter((line) => {
  const obj = JSON.parse(line);
  return obj.type === 'user/message' && JSON.stringify(obj.data).includes('没有带进上下文');
});
assert.equal(notices.length, 1, '必须恰好一条说明，写清省掉了多少轮');
assert.equal(notices[0].includes(String(trimmed.report.droppedTurns) + ' 轮'), true, '说明里要写具体轮数');
console.log('✅ 省略说明只有一条且写明轮数 · ' + trimmed.report.droppedTurns + ' 轮');

// ⑦ 边界：零轮会话不炸
const empty = buildLog({ turns: 0 });
const emptyResult = trimSession(empty, { budget: 10 });
assert.equal(emptyResult.report.trimmed, false, '没有轮次可裁时不该报错也不该改');
console.log('✅ 零轮会话不炸 · trimmed=false');

console.log('✅ context 自检通过');
