/**
 * dsh-session-save (Host half)
 *
 * One HTTP route that packages the current Session into a `.dsproj` file and
 * writes it to a path the user picks. Paths are remembered per Session, so the
 * first save asks where and later saves overwrite the same file.
 *
 * Zero dependencies: node:fs / node:path / node:zlib only. 平台相关的原生窗口代码
 * 被隔离在 `dialog/` 里，本文件只 import 平台选择器，不知道底层是 PowerShell。
 */
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

import { openDialog as platformOpenDialog, saveDialog as platformSaveDialog } from './dialog/index.mjs';

/** Loader row name. */
export const name = 'session-save';
/** The route lives on the browser carrier. */
export const inject = ['connection'];

/** Absolute registration path of the save route. */
export const ROUTE = '/api/session.save';
/** Absolute registration path of the open route. */
export const OPEN_ROUTE = '/api/session.open';
export const AUTOSAVE_ROUTE = '/api/session.autosave';
export const WORKSPACES_ROUTE = '/api/session.workspaces';
export const LOCALES_ROUTE = '/api/session.locales';

const FORMAT = 'dshproj/1';
/**
 * 本插件自己的版本号：从同目录 `package.json` 读。
 * 读不到就退回 `0.0.0` —— 版本只用来给「包比我新」这句提示加料，不该成为打开失败的理由。
 */
const PLUGIN_VERSION = (() => {
  try {
    const raw = fs.readFileSync(new URL('./package.json', import.meta.url), 'utf8');
    const version = JSON.parse(raw)?.version;
    return typeof version === 'string' && version !== '' ? version : '0.0.0';
  } catch {
    return '0.0.0';
  }
})();

/**
 * 比较两段版本号：`a` 比 `b` 新返回 1，旧返回 -1，一样返回 0。
 * 只认点分的数字段，`-rc.1` 这类后缀直接丢掉 —— 这里只回答「谁更新」，
 * 不判 semver 的兼容性语义（包格式看的是 `FORMAT`，不是这个）。
 */
export function compareVersions(a, b) {
  // semver：主版本段逐段比数字，缺位补 0；预发布段单独比，带预发布的小于同号正式版。
  const parse = (text) => {
    const raw = String(text ?? '').trim();
    const dash = raw.indexOf('-');
    const core = dash === -1 ? raw : raw.slice(0, dash);
    const pre = dash === -1 ? undefined : raw.slice(dash + 1);
    return {
      nums: core.split('.').map((part) => {
        const n = Number.parseInt(part, 10);
        return Number.isFinite(n) ? n : 0;
      }),
      // '1.0.0-' 这种畸形写法按「没有预发布」处理，别当成最小的版本。
      labels: pre === undefined || pre === '' ? undefined : pre.split('.'),
    };
  };
  const left = parse(a);
  const right = parse(b);
  for (let i = 0; i < Math.max(left.nums.length, right.nums.length); i += 1) {
    const x = left.nums[i] ?? 0;
    const y = right.nums[i] ?? 0;
    if (x !== y) return x > y ? 1 : -1;
  }
  // 主版本相同时，带预发布的那一侧更小（0.4.3-alpha.1 < 0.4.3）。
  // 这一条不能省：插件跑 0.4.3-alpha.1、包是 0.4.3 写的，必须判成「包更新」，
  // 否则会被当成「包里有不认识的条目」而报「包坏了」。
  if (left.labels === undefined || right.labels === undefined) {
    if (left.labels === undefined && right.labels === undefined) return 0;
    return left.labels === undefined ? 1 : -1;
  }
  for (let i = 0; i < Math.max(left.labels.length, right.labels.length); i += 1) {
    const x = left.labels[i];
    const y = right.labels[i];
    if (x === undefined) return -1; // 段数少的更小
    if (y === undefined) return 1;
    const nx = /^\d+$/.test(x) ? Number.parseInt(x, 10) : undefined;
    const ny = /^\d+$/.test(y) ? Number.parseInt(y, 10) : undefined;
    if (nx !== undefined && ny !== undefined) {
      if (nx !== ny) return nx > ny ? 1 : -1;
      continue;
    }
    if (nx !== undefined) return -1; // 数字段低于字母段
    if (ny !== undefined) return 1;
    if (x !== y) return x > y ? 1 : -1;
  }
  return 0;
}
const ZSTD_MAGIC = 0xfd2fb528;
/** Same frame parameters the official writer uses, so rewritten headers stay readable. */
const CHECKSUM_OPTIONS = { params: { [zlib.constants.ZSTD_c_checksumFlag]: 1 } };
/** 包内锁：`LOCK.json` 的格式标记与「锁仍新鲜」的时间窗。 */
export const LOCK_FORMAT = 'dshproj-lock/1';
const LOCK_STALE_MS = 15 * 60 * 1000;
/** 自动保存的合并窗口：一步结束后稍等，避免连续 step 反复写盘。 */
const AUTOSAVE_DELAY_MS = 1500;

/* ───────────────────────── DSH 路径派生（复刻官方实现） ───────────────────────── */

const dshHome = () => process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
const sessionsRoot = () => path.join(dshHome(), 'sessions');
const memoryRoot = () => path.join(dshHome(), 'memory', 'workspaces');
const stateFile = () => path.join(dshHome(), 'storages', 'session-save.json');

/**
 * Official `encodeSegment`: safe characters pass, everything else becomes ~XXXX.
 *
 * 逐 UTF-16 码元转义（`charCodeAt`，不是 `codePointAt`）——官方如此，因此
 * 增补平面字符会拆成代理对两段（`😀` → `~D83D~DE00`）。用 `codePointAt`
 * 得到 `~1F600`，与磁盘上的真实目录名对不上。
 */
export function encodeSegment(raw) {
  const text = String(raw);
  if (text === '.') return '~002E';
  if (text === '..') return '~002E~002E';
  let out = '';
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    const ch = String.fromCharCode(code);
    if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) out += ch;
    else out += '~' + code.toString(16).toUpperCase().padStart(4, '0');
  }
  return out;
}

/**
 * Official `projectKey`: separators collapse, then the segment is hex-escaped.
 *
 * 与官方逐字一致的三处细节，漏一个就会指错目录：
 *   ① 连续分隔符只折叠成**一个** `-`（`separatorRun`），且**不剪掉尾部** `-`
 *      ——`C:\x\` 的官方键是 `--C-x---`（尾部分隔符贡献一个 `-`，外加包裹的两条）。
 *   ② 前导 `-` 剥掉后若为空则兜底 `root`（官方 `|| "root"`），根路径 `/` 才成 `--root--`。
 *   ③ 转义按 UTF-16 码元，同 {@link encodeSegment}。
 *
 * 唯一有意的偏离：`cwd` 为空串时官方 `projectKey` 抛错，这里退回 `_no-cwd`
 * （即官方 `projectDir(root, undefined)` 的目录名）。本函数的使用方都是
 * 「找到就返回、找不到给 undefined」的查找逻辑，抛错只会中断整轮扫描。
 */
export function projectKey(cwd) {
  const raw = String(cwd ?? '');
  if (raw === '') return '_no-cwd';
  let readable = '';
  let separatorRun = false;
  for (let i = 0; i < raw.length; i += 1) {
    const code = raw.charCodeAt(i);
    const ch = String.fromCharCode(code);
    if (ch === '/' || ch === '\\' || ch === ':') {
      if (!separatorRun) readable += '-';
      separatorRun = true;
    } else if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
      readable += ch;
      separatorRun = false;
    } else {
      readable += '~' + code.toString(16).toUpperCase().padStart(4, '0');
      separatorRun = false;
    }
  }
  return `--${(readable.replace(/^-+/, '') || 'root').slice(0, 251)}--`;
}

/**
 * Memory directories use one dash per separator, so both spellings are tried exactly.
 *
 * 绝不做「归一化后相等」的模糊匹配（这里曾经有第三级 normSlug 比对）：把大小写、
 * `-`、尾分隔符全抹平之后，`C:\x\ws` 与 `C:\x\ws\` 会命中同一个记忆目录 ——
 * 打包方只要让 cwd 带个尾斜杠，记忆就会落进受害者另一个工作区的记忆目录，
 * restore 模式下等于跨工作区覆盖项目笔记。路径相等只有一种判法：resolve 之后逐段比。
 */
function resolveMemoryDir(cwd) {
  if (!cwd) return undefined;
  let names;
  try {
    names = fs.readdirSync(memoryRoot(), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return undefined;
  }
  const candidates = [
    projectKey(cwd),
    `--${String(cwd).replace(/[/\\:]/g, '-').replace(/^-+/, '').slice(0, 251)}--`,
  ];
  for (const candidate of candidates) {
    if (names.includes(candidate)) return { slug: candidate, dir: path.join(memoryRoot(), candidate) };
  }
  return undefined;
}

/* ───────────────────────── 会话日志读取 ───────────────────────── */

/**
 * 解一帧。
 *
 * 所有 zstd 解压都必须走这里：直接调 zlib.zstdDecompressSync 会绕过帧上限。
 * 超限时 Node 抛 `ERR_BUFFER_TOO_LARGE`，调用方**不许**把它当成「这帧坏了、跳过」——
 * 那等于让炸弹包被静默当成空会话打开，比直接报错更糟。
 */
function decompressFrame(slice) {
  return zlib.zstdDecompressSync(slice, { maxOutputLength: MAX_FRAME_BYTES });
}

/**
 * Split a concatenated zstd log into its frames.
 * @param buf - whole log file
 * @returns array of { start, end } frame bounds
 */
export function scanZstdFramesDetailed(buf) {
  const frames = [];
  // 认出了帧头、但帧体（或末块之后的 checksum）没读完 —— 末帧被截断。
  let truncated = false;
  let p = 0;
  while (p + 8 <= buf.length && buf.readUInt32LE(p) === ZSTD_MAGIC) {
    const start = p;
    const fhd = buf[p + 4];
    const single = (fhd >> 5) & 1;
    const didFlag = fhd & 3;
    const fcsFlag = fhd >> 6;
    const checksum = (fhd >> 2) & 1;
    p += 5;
    if (!single) p += 1; // Window_Descriptor
    p += didFlag === 0 ? 0 : didFlag === 1 ? 1 : didFlag === 2 ? 2 : 4; // Dictionary_ID
    p += fcsFlag === 0 ? (single ? 1 : 0) : fcsFlag === 1 ? 2 : fcsFlag === 2 ? 4 : 8; // Frame_Content_Size
    let complete = false;
    while (p + 3 <= buf.length) {
      const bh = buf[p] | (buf[p + 1] << 8) | (buf[p + 2] << 16);
      const last = bh & 1;
      const type = (bh >> 1) & 3;
      const size = bh >>> 3;
      p += 3;
      // zstd 规范：Block_Type=1（RLE）的 Block_Size 是解压后大小，载荷恒 1 字节。
      // 早先按「非 RLE 才加 size」算，RLE 块加 0 → p 从此错位，后面全是垃圾，
      // 整帧被当成「没写完」丢掉：一条带 300 KB 连续空格的普通消息就能触发，
      // rewriteHeader 随即把正文帧全扔了，还回 HTTP 200 说一切正常。
      if (type === 1) p += 1;
      else if (type === 0 || type === 2) p += size;
      else {
        complete = false; // 3 = reserved，规范里不存在，当损坏处理
        break;
      }
      if (p > buf.length) break;
      if (last) {
        // checksum 的 4 个字节也是帧的一部分。以前不管 p 是否越过文件末尾都置 complete，
        // 随后 end 被 Math.min 夹回 buf.length —— 一个被砍掉 checksum 的末帧于是看起来
        // 「正好覆盖到文件末尾」，覆盖率闸放行，rewriteHeader 把半截帧当正文照搬。
        if (checksum) p += 4;
        if (p <= buf.length) complete = true;
        break;
      }
    }
    if (!complete) {
      truncated = true;
      break;
    }
    frames.push({ start, end: p });
  }
  return { frames, truncated };
}

/**
 * 帧边界列表。截断标记只在需要区分「文件末尾正好是一帧」与「末帧没写完」的地方用
 * （覆盖率闸、体检报告）；其余调用方要的只是边界。
 */
export function scanZstdFrames(buf) {
  return scanZstdFramesDetailed(buf).frames;
}

function readHeader(buf) {
  const frames = scanZstdFrames(buf);
  const slice = frames.length > 0 ? buf.subarray(frames[0].start, frames[0].end) : buf;
  const text = decompressFrame(slice).toString('utf8');
  const nl = text.indexOf('\n');
  return JSON.parse(nl === -1 ? text : text.slice(0, nl));
}

/** Frame count and non-empty JSONL line count, mirroring what dshproj records. */
function readStats(buf) {
  const frames = scanZstdFrames(buf);
  let lines = 0;
  for (const frame of frames) {
    let text;
    try {
      text = decompressFrame(buf.subarray(frame.start, frame.end)).toString('utf8');
    } catch (error) {
      // 超单帧上限是攻击信号，不是「这帧坏了」；吞掉等于让炸弹包通过体检。
      if (error?.code === 'ERR_BUFFER_TOO_LARGE') throw error;
      continue;
    }
    for (const line of text.split('\n')) if (line.trim() !== '') lines += 1;
  }
  return { frames: frames.length, lines };
}

/** Locate `<sessions>/<projectKey>/<session-id>/session.vN.jsonl.zstd`. */
function findSessionFile(sessionId) {
  // id 只接受 `session-<uuid>` / 裸 uuid：这两种形态里不可能出现分隔符或 `..`。
  // 之前这里还留了一个「原样 id」候选，等于把 encodeSegment 挡掉的穿越重新放行了。
  if (!isSessionId(sessionId)) return undefined;
  let projects;
  try {
    projects = fs.readdirSync(sessionsRoot(), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return undefined;
  }
  const wanted = encodeSegment(sessionId);
  for (const project of projects) {
    const dir = path.join(sessionsRoot(), project, wanted);
    let entries;
    try {
      entries = fs.readdirSync(dir);
    } catch {
      continue;
    }
    const log = entries
      .filter((entry) => /^session(\.[0-9A-Za-z]+)?\.jsonl(\.zstd)?$/.test(entry))
      .sort((a, b) => a.length - b.length)[0];
    if (log !== undefined) return path.join(dir, log);
  }
  return undefined;
}

/* ───────────────────────── 极简 ZIP 写入 ───────────────────────── */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  if (typeof zlib.crc32 === 'function') return zlib.crc32(buf) >>> 0;
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function dosDateTime(d = new Date()) {
  return {
    time: ((d.getHours() & 31) << 11) | ((d.getMinutes() & 63) << 5) | ((d.getSeconds() / 2) & 31),
    date: (((d.getFullYear() - 1980) & 127) << 9) | (((d.getMonth() + 1) & 15) << 5) | (d.getDate() & 31),
  };
}

/** entries: [{ name, data: Buffer, store?: boolean }] */
export function zipWrite(entries) {
  const chunks = [];
  const central = [];
  let offset = 0;
  const { time, date } = dosDateTime();
  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, 'utf8');
    const data = entry.data;
    const method = entry.store ? 0 : 8;
    const body = method === 8 ? zlib.deflateRawSync(data, { level: 9 }) : data;
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, nameBuf, body);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0x0800, 8);
    cd.writeUInt16LE(method, 10);
    cd.writeUInt16LE(time, 12);
    cd.writeUInt16LE(date, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(body.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt16LE(0, 30);
    cd.writeUInt16LE(0, 32);
    cd.writeUInt16LE(0, 34);
    cd.writeUInt16LE(0, 36);
    cd.writeUInt32LE(0, 38);
    cd.writeUInt32LE(offset, 42);
    central.push(cd, nameBuf);
    offset += local.length + nameBuf.length + body.length;
  }
  const cdBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...chunks, cdBuf, eocd]);
}

/* ───────────────────────── 极简 ZIP 读取 ───────────────────────── */

/** 单条目解压上限 / 整包解压总量 / 压缩比上限：超限即判定为炸弹，拒绝打开。 */
const MAX_ENTRY_BYTES = 64 * 1024 * 1024;
const MAX_TOTAL_BYTES = 512 * 1024 * 1024;
/**
 * 单帧解压上限。
 *
 * 为什么帧也要单独设一个：`MAX_ENTRY_BYTES` 只管 zip 那一层解出来的量，
 * 而会话日志本身是「多个 zstd 帧拼接」，每个帧里还能再套一层压缩。
 * 实测一个 29 KB 的包，第 0 帧写成 900 MB 全空格，DEFLATE 层解出来只有几十 KB
 * （轻松过 64 MB 检查），接着 zstd 一展开就把 RSS 顶到 +937 MB；2000 MB 那版 +2 GB。
 * 所以这一层额度必须单独设——删了它等于给「套两层」留着后门。
 */
const MAX_FRAME_BYTES = MAX_ENTRY_BYTES;
const MAX_RATIO = 200;
/** 压缩比只在条目够大时才看，免得把小文本的正常压缩误判成炸弹。 */
const RATIO_FLOOR_BYTES = 4 * 1024 * 1024;

/**
 * 一次导入最多回填多少个附件对象 / 多少字节。
 *
 * 为什么另设这两个数而不是复用 MAX_TOTAL_BYTES：附件落点是 DSH 自己的对象库，
 * 那边的 `attachments/v1` 没有任何 GC（只有写入点，没有 unlink/rm 调用），
 * 写进去就永远躺着。包里的会话日志可以随时失效，附件不会——所以总额度要更紧。
 */
const MAX_ATTACH_FILES = 2000;
const MAX_ATTACH_TOTAL_BYTES = 128 * 1024 * 1024;

/**
 * Read a stored/deflated ZIP into a name → bytes map.
 *
 * 解压是攻击面：条目名、偏移、体积、压缩比全部要校验，任何一项不对就整包拒绝，
 * 不要「先解出来再看看」。
 * @param buf - whole archive
 * @returns Map<string, Buffer>
 */
export function zipRead(buf) {
  const eocd = (() => {
    const floor = Math.max(0, buf.length - 65557);
    for (let p = buf.length - 22; p >= floor; p--) if (buf.readUInt32LE(p) === 0x06054b50) return p;
    return -1;
  })();
  if (eocd < 0) throw new Error('不是有效的 ZIP 包（找不到中央目录）');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  if (p + 46 > buf.length) throw new Error('中央目录偏移越界');
  const out = new Map();
  let total = 0;
  for (let i = 0; i < count; i++) {
    if (p + 46 > buf.length) throw new Error('中央目录损坏（越界）');
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('中央目录损坏');
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const usize = buf.readUInt32LE(p + 24);
    const nlen = buf.readUInt16LE(p + 28);
    const elen = buf.readUInt16LE(p + 30);
    const clen = buf.readUInt16LE(p + 32);
    const lo = buf.readUInt32LE(p + 42);
    if (p + 46 + nlen > buf.length) throw new Error('中央目录里的文件名越界');
    const name = buf.toString('utf8', p + 46, p + 46 + nlen);
    // 先看条目名：绝对路径、盘符、`..`、UNC 一律不要（写入侧还有 safeJoin 兜一层）
    safeSegments(name);
    if (lo + 30 > buf.length) throw new Error(`条目偏移越界：${name}`);
    const dataStart = lo + 30 + buf.readUInt16LE(lo + 26) + buf.readUInt16LE(lo + 28);
    if (dataStart + csize > buf.length) throw new Error(`条目数据越界：${name}`);
    if (usize > MAX_ENTRY_BYTES) throw new Error(`条目解压后过大（${usize} 字节），拒绝打开：${name}`);
    if (csize > MAX_ENTRY_BYTES) throw new Error(`条目压缩体积过大，拒绝打开：${name}`);
    // 附件条目不再整段豁免：本插件写包时一律 store，但别人重打包（7-Zip、资源管理器
    // 的「发送到压缩文件夹」）会 DEFLATE，1 MiB 文本压成 1 KB、比值上千——那是合法包。
    // 这里不取消闸门（3 MiB 全零缓冲区 935:1 的放大是真的，见 test/security 的 R7），
    // 而是把话说明白：提示它「被重新压缩过、请按 store 重打包」，而不是只丢一句比值异常。
    const isAttachment = name.startsWith('attachments/');
    const ratioFloor = isAttachment ? 64 * 1024 : RATIO_FLOOR_BYTES;
    if (usize > ratioFloor && csize > 0 && usize / csize > MAX_RATIO) {
      throw new Error(
        isAttachment
          ? `附件条目压缩比异常：被重新压缩过（约 ${Math.round(usize / csize)}:1，本插件写包用 store），拒绝打开：${name}`
          : `条目压缩比异常（约 ${Math.round(usize / csize)}:1），拒绝打开：${name}`,
      );
    }
    const raw = buf.subarray(dataStart, dataStart + csize);
    let data;
    if (method === 0) data = Buffer.from(raw);
    else if (method === 8) data = zlib.inflateRawSync(raw, { maxOutputLength: MAX_ENTRY_BYTES });
    else throw new Error(`不支持的压缩方式 ${method}：${name}`);
    total += data.length;
    if (total > MAX_TOTAL_BYTES) throw new Error('包解压后总量过大，拒绝打开');
    out.set(name, data);
    p += 46 + nlen + elen + clen;
  }
  return out;
}

/** sha256 of a buffer, used for the manifest's per-entry digests. */
function cryptoHash(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

/* ─────────────── 路径与输入校验（包内与 HTTP 传入的内容一律不可信） ─────────────── */

/**
 * DSH_HOME 里的会话 id 形态：`session-<uuid>`，也兼容早期写入的裸 uuid。
 * 两者都只含十六进制与连字符，所以这个校验同时挡住了 `..`、盘符和分隔符。
 */
const SESSION_ID_RE = /^(session-)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isSessionId = (value) => typeof value === 'string' && SESSION_ID_RE.test(value);

/** 会话日志文件名：`session.v4.jsonl.zstd` / `session-<uuid>.jsonl`。 */
const LOG_NAME_RE = /^session(\.[0-9A-Za-z]+)?\.jsonl(\.zstd)?$/;

/* ───────────── 附件对象：日志里只有哈希，字节在另一个对象库 ───────────── */

/**
 * 包里附件条目的唯一合法形态：`attachments/objects/<前两位>/<sha256>`、
 * `attachments/files/<前两位>/<sha256>`。
 * 包内用 `files` 这个名字，落到盘上对应 DSH 的 `file-objects` 目录 ——
 * 目录名照抄 DSH 的约定，别在自己这里发明一套。
 */
const ATTACH_ENTRY_RE = /^attachments\/(objects|files)\/([0-9a-f]{2})\/([0-9a-f]{64})$/;
const ATTACH_KIND_DIR = { objects: 'objects', files: 'file-objects' };
const ATTACH_REF_RE = /(?:attachmentId|fileId)\\?"\s*:\s*\\?"sha256:([0-9a-f]{64})/g;

/** 内容寻址对象在本机的根目录（按 kind 分 objects / file-objects）。 */
function attachmentRootDir(kind) {
  return path.join(dshHome(), 'attachments', 'v1', ATTACH_KIND_DIR[kind] ?? 'objects');
}

/** 解出会话日志全文：逐帧解压再拼，坏帧跳过（半写帧不该让整包打不出来）。 */
function decodeLogText(buf) {
  let text = '';
  let frameTotal = 0;
  for (const frame of scanZstdFrames(buf)) {
    let piece;
    try {
      piece = decompressFrame(buf.subarray(frame.start, frame.end)).toString('utf8');
    } catch (error) {
      /* 单帧解压失败不影响其余帧；但超限必须冒出去，不能被当成坏帧吞掉。 */
      if (error?.code === 'ERR_BUFFER_TOO_LARGE') throw error;
      continue;
    }
    // 单帧有上限挡不住「几百帧各几十 MB」，这里再累计一层总量。
    frameTotal += piece.length;
    if (frameTotal > MAX_TOTAL_BYTES) throw new Error('会话日志解压后总量过大，拒绝打开');
    text += piece;
  }
  return text;
}

/** 日志里引用到的附件哈希。只是引用，不代表本机真有这个对象。 */
export function attachmentRefs(buf) {
  const seen = new Set();
  for (const match of decodeLogText(buf).matchAll(ATTACH_REF_RE)) seen.add(match[1]);
  return seen;
}

/**
 * 把包里的附件对象回填到本机对象库。
 * 内容寻址天然幂等：目标已存在就是同一份，跳过即可，不需要问冲突。
 * 三道校验——条目名合法、分片目录与哈希前缀一致、内容真的哈希成这个名字，
 * 任何一条不成立就整条跳过：宁可少恢复一个对象，也不往对象库里写来路不明的字节。
 */
// ── billion-context 压缩块 ──────────────────────────────────────────
// bili 把每个会话的压缩状态存在自己的 XDG 目录里，文件名是
// `<上游 host>_<sha256(sessionId) 的前 24 位十六进制>.json`（实测 0.1.211）。
// 导出时把这份状态原样带走，导入时按同一算法重建文件名写回去，bili 下次
// 请求这个会话就能接着用已经压好的块，而不是把整包历史重发一遍。
// 兼容口径：bili 没装、schema 不是 3、本机那份比包里新，一律不动——宁可不恢复，
// 也不能把一份认不出来的状态塞进别人的库。
const BILI_PLUGIN = 'billion-context';
const BILI_SCHEMA = 3;
const BILI_ENTRY = 'bili/session.json';

export function biliSessionsRoot() {
  const configured = process.env.BILI_SESSIONS_DIR;
  if (typeof configured === 'string' && configured !== '') return configured;
  return path.join(os.homedir(), '.local', 'share', 'billion-context', 'sessions');
}

function biliIdHash(sessionId) {
  return cryptoHash(Buffer.from(String(sessionId), 'utf8')).slice(0, 24);
}

// 这两个值来自包内容，会被拼进文件路径。它们必须是"一个目录名 / 一段文件名"，
// 不含分隔符也不含 ..，否则一份构造过的包能把状态写到会话目录之外。
const BILI_PROTOCOL_RE = /^[a-z0-9][a-z0-9._-]{0,31}$/i;
// host 只收裸主机名。带端口的 origin（`api.example.com:8443`）会解析出带冒号的 host，
// 而冒号在 Windows 文件名里非法（实测 rename 直接 EINVAL）——原样写进去必然失败，
// 换成别的字符又会写进 bili 永远找不到的槽位。所以带端口一律按 bad-host 拒绝，
// 由调用方如实报告，不再静默落到 api.deepseek.com 的槽位。
const BILI_HOST_RE = /^[a-z0-9][a-z0-9.-]{0,253}$/i;

function biliProtocolOf(state) {
  const protocol = state?.meta?.protocol;
  return typeof protocol === 'string' && BILI_PROTOCOL_RE.test(protocol) === true ? protocol : 'anthropic';
}

function biliHostOf(state) {
  const origin = typeof state?.meta?.upstreamOrigin === 'string' ? state.meta.upstreamOrigin : '';
  // 没有 origin 才是「用默认上游」；给了 origin 但解析不出来是错，不能默默当成默认值——
  // 那样状态会写进 api.deepseek.com 的槽位，bili 下次按真实 host 找永远找不到，而返回体还报 ok。
  if (origin === '') return 'api.deepseek.com';
  let bare = origin.trim();
  try {
    const parsed = new URL(bare);
    bare = parsed.host;
  } catch {
    bare = bare.replace(/^https?:\/\//i, '').replace(/\/+$/, '');
  }
  return BILI_HOST_RE.test(bare) === true ? bare : undefined;
}

// 文件名要 host，host 又只存在于文件内容里，所以按「后缀是 id 的哈希」扫目录。
export function findBiliState(sessionId) {
  const suffix = `_${biliIdHash(sessionId)}.json`;
  const root = biliSessionsRoot();
  let dirs;
  try {
    dirs = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return undefined;
  }
  for (const dir of dirs) {
    if (dir.isDirectory() !== true) continue;
    const sub = path.join(root, dir.name);
    let files;
    try {
      files = fs.readdirSync(sub);
    } catch {
      continue;
    }
    for (const file of files) {
      if (file.endsWith(suffix) !== true) continue;
      try {
        const absolute = path.join(sub, file);
        const state = JSON.parse(fs.readFileSync(absolute, 'utf8'));
        if (String(state?.id ?? '') !== String(sessionId)) continue;
        return { state, file, absolute };
      } catch {
        continue;
      }
    }
  }
  return undefined;
}

function collectBili(sessionId) {
  const found = findBiliState(sessionId);
  if (found === undefined) return { entry: undefined, info: { present: false } };
  const wrapper = {
    plugin: BILI_PLUGIN,
    schema: BILI_SCHEMA,
    sessionId: String(sessionId),
    protocol: biliProtocolOf(found.state),
    host: biliHostOf(found.state) ?? 'api.deepseek.com',
    savedAt: Number(found.state?.savedAt) || null,
    state: found.state,
  };
  const data = Buffer.from(JSON.stringify(wrapper), 'utf8');
  return {
    entry: { name: BILI_ENTRY, data, store: true },
    info: { present: true, schema: BILI_SCHEMA, savedAt: wrapper.savedAt, bytes: data.length },
  };
}

function restoreBili(entries, expectedSessionId, backupWanted = true) {
  const raw = entries instanceof Map ? entries.get(BILI_ENTRY) : undefined;
  if (raw === undefined) return { written: 0, skipped: 0, rejected: 0, reason: 'absent' };
  let wrapper;
  try {
    wrapper = JSON.parse(Buffer.from(raw).toString('utf8'));
  } catch {
    return { written: 0, skipped: 0, rejected: 1, reason: 'bad-json' };
  }
  if (wrapper?.plugin !== BILI_PLUGIN) return { written: 0, skipped: 0, rejected: 1, reason: 'foreign' };
  if (Number(wrapper?.schema) !== BILI_SCHEMA) {
    return { written: 0, skipped: 0, rejected: 0, reason: 'schema-mismatch', schema: wrapper?.schema ?? null };
  }
  const state = wrapper?.state;
  const sessionId = String(wrapper?.sessionId ?? state?.id ?? '');
  if (sessionId === '' || state === null || typeof state !== 'object') {
    return { written: 0, skipped: 0, rejected: 1, reason: 'no-state' };
  }
  // 只恢复本会话：块里的 sessionId 必须就是这次导入的那个会话。
  // 少了这一步，一份构造过的包可以带别人的 id，把状态写进另一个会话的槽位。
  if (expectedSessionId !== undefined && String(expectedSessionId) !== sessionId) {
    return { written: 0, skipped: 0, rejected: 1, reason: 'session-mismatch' };
  }
  if (String(state?.id ?? '') !== sessionId) {
    return { written: 0, skipped: 0, rejected: 1, reason: 'session-mismatch' };
  }
  const root = biliSessionsRoot();
  try {
    fs.accessSync(root);
  } catch {
    // bili 没装：不是错误，只是这一份状态没人接
    return { written: 0, skipped: 1, rejected: 0, reason: 'not-installed' };
  }
  const host = biliHostOf(state);
  if (host === undefined) {
    // 包里的 upstreamOrigin 解析不出合法 host：不许静默落到 api.deepseek.com 槽位——
    // 写进去 bili 下次按真实 host 找永远找不到，而返回体还会报 ok。
    return { written: 0, skipped: 0, rejected: 1, reason: 'bad-host' };
  }
  const dir = path.join(root, biliProtocolOf(state));
  const dest = path.join(dir, `${host}_${biliIdHash(sessionId)}.json`);
  // 兜底：白名单挡不住所有写法，落点必须真的在会话目录里
  if (isInside(root, dest) !== true) {
    return { written: 0, skipped: 0, rejected: 1, reason: 'bad-target' };
  }
  try {
    fs.mkdirSync(dir, { recursive: true });
    if (fs.existsSync(dest)) {
      let localAt = 0;
      try {
        localAt = Number(JSON.parse(fs.readFileSync(dest, 'utf8'))?.savedAt) || 0;
      } catch {
        localAt = 0;
      }
      const packAt = Number(state?.savedAt) || 0;
      // 本机这份更晚：它带着包导出之后的对话，覆盖等于把进度退回去
      if (localAt > packAt) return { written: 0, skipped: 1, rejected: 0, reason: 'newer-local' };
      // bili 每轮都会重写这份状态。刚被改过说明它正在这个会话上干活，
      // 这时覆盖进去会被它下一次写盖掉，甚至让它读到一份它没预期的状态。
      // 等一次再判；仍然新鲜就让开，交给用户稍后重开。
      if (Date.now() - fs.statSync(dest).mtimeMs < 2000) {
        // 以前在这里 `Atomics.wait` 睡 120 ms 再判一次：那是同步阻塞事件循环，导入一次卡一次。
        // importPackage 整条链是同步的，改异步会传染到路由；这里直接让开更简单也更快——
        // bili 刚写过就说明它正在这个会话上干活，本来就不该覆盖。
        return { written: 0, skipped: 1, rejected: 0, reason: 'busy' };
      }
      if (backupWanted === true) {
        try {
          fs.copyFileSync(dest, `${dest}.bak-${Date.now()}`);
        } catch {
          // 备份失败不挡写盘：目标本来就是可重建的派生状态
        }
      }
    }
    const payload = Buffer.from(JSON.stringify(state), 'utf8');
    writeAtomic(dest, payload);
    // 写成功不等于写对：同步盘/杀软偶尔会短暂挡住 rename 后的读，
    // 这里回读一次，确认落下去的确实是我们这份（长度 + 首尾字节）。
    const back = fs.readFileSync(dest);
    if (back.length !== payload.length || back.equals(payload) !== true) {
      // 回读到的不是我们写的那份。以前只记 rejected 就返回，文件却留在盘上 ——
      // 返回体说「没写」，磁盘上却多了一份没人验证过的 bili 状态。
      // 它是可重建的派生缓存（bili 下次会重写），删掉才能让「没写」是真的。
      let removed = false;
      try {
        fs.rmSync(dest, { force: true });
        removed = fs.existsSync(dest) !== true;
      } catch {
        removed = false;
      }
      return { written: 0, skipped: 0, rejected: 1, reason: 'verify-failed', removed };
    }
    return { written: 1, skipped: 0, rejected: 0, reason: 'ok' };
  } catch (error) {
    return { written: 0, skipped: 0, rejected: 1, reason: 'write-failed', message: String(error?.message ?? error) };
  }
}

function restoreAttachments(entries) {
  let written = 0;
  let skipped = 0;
  let rejected = 0;
  let bytes = 0;
  for (const [name, data] of entries) {
    const match = ATTACH_ENTRY_RE.exec(name);
    if (match === null) continue;
    const kind = match[1];
    const shard = match[2];
    const sha = match[3];
    if (sha.slice(0, 2) !== shard) {
      rejected += 1;
      continue;
    }
    if (cryptoHash(data) !== sha) {
      rejected += 1;
      continue;
    }
    const root = attachmentRootDir(kind);
    const dest = path.join(root, shard, sha);
    if (!isInside(root, dest)) {
      rejected += 1;
      continue;
    }
    if (fs.existsSync(dest)) {
      skipped += 1;
      continue;
    }
    // 配额要在「确实要写」之后判：本机已有的条目一个字节都不会落盘，
    // 把它们算进额度会让「重开自己刚存的包」被判超限。
    if (written + 1 > MAX_ATTACH_FILES || bytes + data.length > MAX_ATTACH_TOTAL_BYTES) {
      rejected += 1;
      continue;
    }
    try {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, data);
      written += 1;
      bytes += data.length;
    } catch {
      rejected += 1;
    }
  }
  return { written, skipped, rejected };
}

/** 把一段路径解析成真实落点：从最深的已存在祖先开始 realpath，再把剩下的段拼回去。 */
function realTarget(target) {
  const abs = path.resolve(target);
  const rest = [];
  let head = abs;
  for (;;) {
    try {
      const real = typeof fs.realpathSync.native === 'function' ? fs.realpathSync.native(head) : fs.realpathSync(head);
      return rest.length === 0 ? real : path.join(real, ...rest.reverse());
    } catch {
      const up = path.dirname(head);
      // 一路走到根还解析不出来（盘符不存在、没有权限）：退回字面路径。
      // 宁可少判一层链接，也不能把一条合法路径判成越界 —— 工作区与插件本身
      // 在本机就是 junction，误判等于打不开自己的东西。
      if (up === head) return abs;
      rest.push(path.basename(head));
      head = up;
    }
  }
}

/**
 * dest 是否严格落在 root 之内（root 自身不算）。
 *
 * 必须比解析后的路径：落点可能是 junction / symlink，字面路径在 root 里、真实写入
 * 却落在别处。两端都走 realTarget，于是「root 自己是链接」「dest 是链接」
 * 「dest 经链接逃出 root」三种情形都对。判前缀仍用 path.relative，不用字符串 startsWith。
 */
export function isInside(root, dest) {
  const rel = path.relative(realTarget(root), realTarget(dest));
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/** 本机对象库里有没有这一份（kind: objects | files）。 */
function hasAttachmentObject(kind, sha) {
  const root = attachmentRootDir(kind);
  const dest = path.join(root, sha.slice(0, 2), sha);
  return isInside(root, dest) && fs.existsSync(dest);
}

/** 从图片头部读出宽高与真实类型。认不出就返回 undefined——猜出来的尺寸比没有更糟。 */
function imageInfoOf(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 24) return undefined;
  if (buf.readUInt32BE(0) === 0x89504e47 && buf.readUInt32BE(4) === 0x0d0a1a0a) {
    return { mediaType: 'image/png', width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  if (buf.length >= 10 && buf.toString('ascii', 0, 3) === 'GIF') {
    return { mediaType: 'image/gif', width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
  }
  if (
    buf.length >= 30 &&
    buf.toString('ascii', 0, 4) === 'RIFF' &&
    buf.toString('ascii', 8, 12) === 'WEBP'
  ) {
    const chunk = buf.toString('ascii', 12, 16);
    if (chunk === 'VP8X') {
      return {
        mediaType: 'image/webp',
        width: 1 + buf.readUIntLE(24, 3),
        height: 1 + buf.readUIntLE(27, 3),
      };
    }
    if (chunk === 'VP8L') {
      const bits = buf.readUInt32LE(21);
      return {
        mediaType: 'image/webp',
        width: 1 + (bits & 0x3fff),
        height: 1 + ((bits >> 14) & 0x3fff),
      };
    }
  }
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) {
        i += 1;
        continue;
      }
      const marker = buf[i + 1];
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return {
          mediaType: 'image/jpeg',
          height: buf.readUInt16BE(i + 5),
          width: buf.readUInt16BE(i + 7),
        };
      }
      const size = buf.readUInt16BE(i + 2);
      if (size < 2) break;
      i += 2 + size;
    }
  }
  return undefined;
}

const MEDIA_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

/**
 * 逐个 part 看一遍：断链的图换成文字、缺的尺寸按对象文件补回、认不出的媒体类型按魔数纠正。
 * 改过的节点返回新对象，没改的原样返回——外面靠引用比较决定要不要重写这一行。
 */
function repairPartNode(node, report, options, depth = 0) {
  if (node === null || typeof node !== 'object' || depth > 64) return node;
  if (Array.isArray(node)) {
    let changed = false;
    const next = node.map((item) => {
      const fixed = repairPartNode(item, report, options, depth + 1);
      if (fixed !== item) changed = true;
      return fixed;
    });
    return changed ? next : node;
  }
  // 两种形状都得认：早期日志把 attachmentId 直接挂在 part 上，后来才包成 attachment 对象。
  // 只认一种就会漏掉一半引用——漏掉的那半照样把会话打成 ATTACHMENT_NOT_FOUND。
  const nested =
    node.type === 'image' &&
    node.attachment !== null &&
    typeof node.attachment === 'object' &&
    Array.isArray(node.attachment) === false;
  const flat = node.type === 'image' && typeof node.attachmentId === 'string';
  if (nested === true || flat === true) {
    const att = nested === true ? node.attachment : node;
    const raw = typeof att.attachmentId === 'string' ? att.attachmentId : '';
    const sha = raw.startsWith('sha256:') ? raw.slice(7) : '';
    const label =
      typeof att.name === 'string' && att.name !== '' ? att.name : path.basename(String(att.name ?? 'image'));
    report.parts.total += 1;
    if (!/^[0-9a-f]{64}$/.test(sha) || !hasAttachmentObject('objects', sha)) {
      report.parts.missing += 1;
      if (options.keepMissing === true) return node;
      report.parts.dropped += 1;
      report.notes.push(`图片 ${label} 在本机没有对应对象，已换成文字占位`);
      return { type: 'text', text: `[图片已丢失：${label}]` };
    }
    // 扁平形状没有尺寸字段，对象在就够了——没有的东西不该凭猜补上。
    if (nested === false) return node;
    const file = path.join(attachmentRootDir('objects'), sha.slice(0, 2), sha);
    let bytes;
    let info;
    try {
      bytes = fs.statSync(file).size;
      info = imageInfoOf(fs.readFileSync(file));
    } catch {
      bytes = undefined;
      info = undefined;
    }
    const patch = {};
    const badNumber = (value) => typeof value !== 'number' || !Number.isFinite(value) || value <= 0;
    if (badNumber(att.width) && info !== undefined) patch.width = info.width;
    if (badNumber(att.height) && info !== undefined) patch.height = info.height;
    if (badNumber(att.bytes) && bytes !== undefined) patch.bytes = bytes;
    if (!MEDIA_TYPES.has(att.mediaType) && info !== undefined) patch.mediaType = info.mediaType;
    if (Object.keys(patch).length === 0) return node;
    report.parts.patched += 1;
    report.notes.push(`图片 ${label} 的尺寸或类型不完整，已按对象文件补齐`);
    return { ...node, attachment: { ...att, ...patch } };
  }
  let changed = false;
  const next = {};
  for (const key of Object.keys(node)) {
    const fixed = repairPartNode(node[key], report, options, depth + 1);
    if (fixed !== node[key]) changed = true;
    next[key] = fixed;
  }
  return changed ? next : node;
}

/**
 * 打开前体检：找出「一打开就会报错」的地方，能确定坏的就地修。
 *
 * 只处理三类确定性故障：解不开的帧（只记数不删）、读不懂的行（丢掉，否则整条会话打不开）、
 * 引用了不存在的附件对象（换成文字占位）。拿不准的一律原样保留——导入是迁移，不是编辑。
 * 帧结构保持不变：没改动的帧直接沿用原字节，改过的帧才重压。
 */
// ── 上下文预算 ─────────────────────────────────────────────────────────────
// billion-context 这类插件在 wire 层做增量压缩：它把自己见过的消息折叠掉，只发新的。
// 但它按会话 id 记状态，第一次见到一个从外面搬进来的会话时手里没有历史，只能整包发上游。
// 本机实测一条 19.8 MB 的日志解压后 86 MB、约两千七百万 token，这种请求上游窗口接不住，
// 插件自己的预算也会在本地把它拒掉。
// 所以导入时按预算从尾部保留完整的 turn，砍掉的部分用一句话交代：
// 日志原件还在 .dsproj 里，用户没丢东西，只是这次不带进来。
const CONTEXT_BUDGET_TOKENS = 150000;
const BYTES_PER_TOKEN = 3.2;

/**
 * 全解路径的累计字节上限（estimateContext / trimSession）。
 *
 * 为什么单帧上限不够：MAX_FRAME_BYTES 只管一帧，几百帧各自几十 MB 加起来仍是几十 GB，
 * 逐帧解压、逐帧累加，内存一路涨到进程被系统杀掉。这里与 decodeLogText / repairSession
 * 同口径取 MAX_TOTAL_BYTES —— 那两条也是「所有帧都解开」的路径，数字对齐才不会出现
 * 「打包能过、估算先死」。
 * 为什么不会误杀正常的大包：附件额度是 128 MB，且附件本身已压缩（合法包接近 1:1），
 * 一个合规的包里会话日志解开后远到不了 512 MB。
 */
function logTooLargeError(maxBytes) {
  const limit = Math.round(maxBytes / (1024 * 1024));
  const error = new Error(
    `会话日志解开后超过 ${limit} MB，已停止读取：这个工程包太大，不是文件损坏。` +
      '请先导出更短的会话区间，或把包分卷后再打开。',
  );
  error.code = 'E_LOG_TOO_LARGE';
  return error;
}

/** 上限取值：调用方可以显式给一个更小的额度，否则用整包口径。 */
function readLimit(value) {
  return Number.isFinite(value) && value > 0 ? value : MAX_TOTAL_BYTES;
}

/** 累计已解出的字节数；越过上限就停在这里，不再解下一帧。 */
function countScanned(scanned, length, maxBytes) {
  const total = scanned + length;
  if (total > maxBytes) throw logTooLargeError(maxBytes);
  return total;
}

export function estimateContext(buffer, options = {}) {
  const maxBytes = readLimit(options.maxBytes);
  const frames = scanZstdFrames(buffer);
  let bytes = 0;
  let lines = 0;
  let scanned = 0;
  for (const frame of frames) {
    let text;
    try {
      text = decompressFrame(buffer.subarray(frame.start, frame.end)).toString('utf8');
    } catch (error) {
      if (error?.code === 'ERR_BUFFER_TOO_LARGE') throw error;
      continue;
    }
    scanned = countScanned(scanned, text.length, maxBytes);
    for (const line of text.split('\n')) {
      if (line === '') continue;
      bytes += Buffer.byteLength(line, 'utf8');
      lines += 1;
    }
  }
  return { bytes, lines, frames: frames.length, tokens: Math.ceil(bytes / BYTES_PER_TOKEN) };
}

export function trimSession(buffer, options = {}) {
  const budget = Number.isFinite(options.budget) && options.budget > 0 ? options.budget : CONTEXT_BUDGET_TOKENS;
  const budgetBytes = Math.floor(budget * BYTES_PER_TOKEN);
  const maxBytes = readLimit(options.maxBytes);
  const rows = [];
  let scanned = 0;
  for (const frame of scanZstdFrames(buffer)) {
    let text;
    try {
      text = decompressFrame(buffer.subarray(frame.start, frame.end)).toString('utf8');
    } catch (error) {
      if (error?.code === 'ERR_BUFFER_TOO_LARGE') throw error;
      continue;
    }
    // 与 estimateContext 同一个累计口径：这条路径同样会把每一帧都解开。
    scanned = countScanned(scanned, text.length, maxBytes);
    for (const line of text.split('\n')) if (line !== '') rows.push(line);
  }
  const typeOf = (line) => {
    try {
      return JSON.parse(line).type ?? '';
    } catch {
      return '';
    }
  };
  // 第一个 turn/start 之前的东西（header、权限预设、沙箱模式…）是会话的立身之本，整段保留。
  const head = [];
  const turns = [];
  let current;
  let seenTurn = false;
  for (const line of rows) {
    const type = typeOf(line);
    if (type === 'turn/start') {
      seenTurn = true;
      current = { lines: [line] };
      turns.push(current);
      continue;
    }
    if (seenTurn !== true) {
      // 只有「第一轮之前」的行才算头部（header、权限预设、沙箱模式）。
      head.push(line);
      continue;
    }
    if (current === undefined) {
      // 两轮之间的行（session/title、session/updated、agent/inbox/spliced…）跟着前一轮走。
      // 按 `current === undefined` 判头会把它们一路提到文件最前面：语义上等于给一份没有
      // 前文的日志安上中途的状态，标题会先于裁剪提示生效。
      const last = turns[turns.length - 1];
      if (last !== undefined) last.lines.push(line);
      else head.push(line);
      continue;
    }
    current.lines.push(line);
    if (type === 'turn/end') current = undefined;
  }
  // 从最后一轮往前收。保留的必须都是完整 turn：从中间切会让 tool/call 与 tool/result 配不上对。
  const kept = [];
  let used = 0;
  let oversizeTurn = false;
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    const size = turns[i].lines.reduce((n, line) => n + Buffer.byteLength(line, 'utf8'), 0);
    if (used + size > budgetBytes) {
      // 最后一轮自己就超预算（一次超长工具输出、一次大文件读取的 tool/result）：
      // 以前 `kept.length > 0` 让它无条件保留，预算一点没生效，report 还报 trimmed:true。
      // 现在按行从尾部切，切点只会落在行边界上。
      if (kept.length === 0) {
        const lines = turns[i].lines;
        // turn/start 必须留着：没有它这一轮就不成轮，日志里的轮次账目也对不上。
        const tail = lines.slice(0, 1);
        let acc = Buffer.byteLength(lines[0], 'utf8');
        for (let k = lines.length - 1; k >= 1; k -= 1) {
          const len = Buffer.byteLength(lines[k], 'utf8');
          if (tail.length > 1 && acc + len > budgetBytes) break;
          tail.unshift(lines[k]);
          acc += len;
        }
        if (tail.length > 0) {
          // 只有真被切掉行时才算 partial：单行就超过预算时 tail 仍是整轮
          // （一行 200 KB 的 JSON 切不动），那时一个字节都没丢，不能报 trimmed。
          kept.unshift({ lines: tail, partial: tail.length < lines.length });
          used += acc;
          oversizeTurn = true;
        }
      }
      break;
    }
    kept.unshift(turns[i]);
    used += size;
  }
  const droppedTurns = turns.length - kept.length;
  const partialTurn = kept.some((turn) => turn.partial === true);
  const beforeBytes = rows.reduce((n, line) => n + Buffer.byteLength(line, 'utf8'), 0);
  if (droppedTurns <= 0 && partialTurn !== true) {
    return {
      buffer,
      report: {
        trimmed: false,
        budget,
        turns: turns.length,
        keptTurns: kept.length,
        droppedTurns: 0,
        oversizeTurn,
        stillOverBudget: Math.ceil(beforeBytes / BYTES_PER_TOKEN) > budget,
        tokensBefore: Math.ceil(beforeBytes / BYTES_PER_TOKEN),
        tokensAfter: Math.ceil(beforeBytes / BYTES_PER_TOKEN),
      },
    };
  }
  let firstSeq = 0;
  try {
    const value = JSON.parse(kept[0].lines[0]).seq;
    if (Number.isFinite(value)) firstSeq = value;
  } catch {
    firstSeq = 0;
  }
  const out = [...head];
  out.push(
    JSON.stringify({
      type: 'user/message',
      seq: firstSeq - 1,
      time: Date.now(),
      data: {
        content: [
          {
            type: 'text',
            text:
              '这条会话是从工程包导入的，更早的 ' +
              String(droppedTurns) +
              ' 轮对话没有带进上下文（完整日志仍在那个 .dsproj 包里）。需要的细节可以直接打开包里的 session.v4.jsonl.zstd 取。',
          },
        ],
        role: 'user',
        id: 'trimmed-' + String(Date.now()),
      },
      surfaceOp: 'append',
    }),
  );
  // turn 号重新从 1 排：跳号会让界面显示成「第 87 轮」，用户以为少看了什么。重排不改语义。
  let nextTurn = 1;
  for (const turn of kept) {
    for (const line of turn.lines) {
      let obj;
      try {
        obj = JSON.parse(line);
      } catch {
        out.push(line);
        continue;
      }
      if (obj.data !== undefined && obj.data !== null && typeof obj.data.turn === 'number') obj.data.turn = nextTurn;
      out.push(JSON.stringify(obj));
    }
    nextTurn += 1;
  }
  const payload = Buffer.from(out.join('\n') + '\n', 'utf8');
  return {
    buffer: zlib.zstdCompressSync(payload, CHECKSUM_OPTIONS),
    report: {
      trimmed: true,
      budget,
      turns: turns.length,
      keptTurns: kept.length,
      droppedTurns,
      // 最后一轮自己超预算、被按行切开：界面要说「这一轮太大」，不能只说「已裁剪」。
      oversizeTurn,
      stillOverBudget: Math.ceil(payload.length / BYTES_PER_TOKEN) > budget,
      tokensBefore: Math.ceil(beforeBytes / BYTES_PER_TOKEN),
      tokensAfter: Math.ceil(payload.length / BYTES_PER_TOKEN),
    },
  };
}

export function repairSession(buffer, options = {}) {
  // 截断标记要如实带出去：末帧没写完时帧数比文件短一截，
  // 只说「共 N 帧」会让人以为日志是完整的。
  const scan = scanZstdFramesDetailed(buffer);
  const frames = scan.frames;
  const report = {
    frames: { total: frames.length, broken: 0, truncated: scan.truncated },
    lines: { total: 0, dropped: 0 },
    parts: { total: 0, missing: 0, patched: 0, dropped: 0 },
    changed: false,
    notes: [],
  };
  if (frames.length === 0) return { buffer, report };

  const chunks = [];
  let frameTotal = 0;
  for (const frame of frames) {
    let text;
    try {
      text = decompressFrame(buffer.subarray(frame.start, frame.end)).toString('utf8');
    } catch (error) {
      /* 超限不是「这帧坏了」——吞掉会把炸弹包修成空会话，必须冒出去。 */
      if (error?.code === 'ERR_BUFFER_TOO_LARGE') throw error;
      report.frames.broken += 1;
      report.notes.push('有一帧日志解不开，原样保留');
      chunks.push(buffer.subarray(frame.start, frame.end));
      continue;
    }
    // 逐帧都解开，所以总量要在这里累计（单帧上限挡不住多帧叠乘）。
    frameTotal += text.length;
    if (frameTotal > MAX_TOTAL_BYTES) throw new Error('会话日志解压后总量过大，拒绝打开');
    const trailing = text.endsWith('\n') ? '\n' : '';
    const kept = [];
    let frameChanged = false;
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue;
      report.lines.total += 1;
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        report.lines.dropped += 1;
        frameChanged = true;
        continue;
      }
      const fixed = repairPartNode(event, report, options);
      if (fixed === event) {
        kept.push(line);
      } else {
        frameChanged = true;
        kept.push(JSON.stringify(fixed));
      }
    }
    if (frameChanged === false) {
      chunks.push(buffer.subarray(frame.start, frame.end));
      continue;
    }
    report.changed = true;
    const payload = Buffer.from(kept.join('\n') + trailing, 'utf8');
    chunks.push(zlib.zstdCompressSync(payload, CHECKSUM_OPTIONS));
  }
  if (report.changed === false) return { buffer, report };
  return { buffer: Buffer.concat(chunks), report };
}

/**
 * 就地把已存在的会话体检一遍，只有真的改了才写回。
 *
 * 「打开」有两种落法：包里的会话是本机没有的（新写一份），或本机已经有了（直接切过去）。
 * 后一种以前完全跳过体检——用户在同一台机器上重开自己的包，正好走这条路，
 * 断链图就永远修不上。所以两条早退分支也要过一遍。
 *
 * 必须先回填附件再调这里：包自带的图还没进对象库时体检，会把它们当成缺失换掉。
 */
function repairInPlace(file, options = {}) {
  let buf;
  try {
    buf = fs.readFileSync(file);
  } catch (error) {
    // 文件不在就没有可体检的东西，交给调用方按「没有会话」处理
    if (error?.code === 'ENOENT') return undefined;
    throw error;
  }
  const repaired = repairSession(buf, options);
  if (repaired.report.changed === true) {
    // 就地改会话文件是不可逆的：断链图会被换成占位文字、坏行会被丢掉。
    // 与其它覆盖点用同一个开关，默认留一份 `.bak-<时间>`。
    if (options.backup !== false) {
      try {
        fs.copyFileSync(file, `${file}.bak-${Date.now()}`);
      } catch {
        /* 备份失败不挡体检：文件已经读进来了，改写本身是确定的 */
      }
    }
    writeAtomic(file, repaired.buffer);
  }
  return repaired.report;
}

/** 一组允许写入的根目录里，是否有一个包含 dest。 */
function isInsideAny(dest, roots) {
  return roots.some((root) => isInside(root, dest));
}

/**
 * 把包里的相对路径切成安全段：正斜杠与反斜杠都当分隔符（Windows 上 `\` 同样穿越），
 * 拒绝空段、`.`、`..`、盘符、UNC 前缀与控制字符。
 * 只要有一段不合法就抛错——不允许「尽量洗干净再写」。
 */
/**
 * 给文件名加后缀，但别让它超过 255 个 UTF-16 码元。
 * copy 模式会在原名后追加 `.from-dsproj-<日期>`：84 个汉字的名字本来恰好合规，
 * 加完后缀就过线了 —— 同一份记忆 restore 能写、copy 写不了，属于自造的可用性缺口。
 */
function withSuffix(rel, suffix) {
  const base = String(rel);
  if (base.length + suffix.length <= 255) return base + suffix;
  const cut = base.lastIndexOf('/');
  const dir = cut === -1 ? '' : base.slice(0, cut + 1);
  const name = cut === -1 ? base : base.slice(cut + 1);
  const dot = name.lastIndexOf('.');
  const ext = dot > 0 ? name.slice(dot) : '';
  const keep = Math.max(1, 255 - dir.length - suffix.length - ext.length);
  return dir + name.slice(0, keep) + suffix + ext;
}

function safeSegments(raw) {
  const text = String(raw ?? '');
  if (text === '') throw new Error('包内路径为空');
  if (text.startsWith('/') || text.startsWith('\\')) throw new Error(`包内路径是绝对路径：${text}`);
  if (/^[A-Za-z]:/.test(text)) throw new Error(`包内路径带盘符：${text}`);
  if (/[\u0000-\u001f\u007f]/.test(text)) throw new Error('包内路径含控制字符');
  const segments = [];
  for (const raw of text.split(/[\\/]+/)) {
    if (raw === '') continue;
    // macOS（HFS+/APFS）导出的是 NFD，`e\u0301tude.md` 在那边是合法文件名。
    // 硬拒等于把「macOS 打包、Windows 打开」这个主场景整包打死；归一化到 NFC 再落盘，
    // 安全性一点没少——下面那些判定在归一化后的串上照样跑。
    const part = raw.normalize('NFC');
    if (part === '.' || part === '..') throw new Error(`包内路径含越界段「${part}」：${text}`);
    // 这一段的名字会直接变成磁盘上的文件名。只挡绝对路径和 `..` 不够：
    // `:` 在 Windows 上是 ADS 分隔符（MEMORY.md:evil 能往已有文件后面挂数据流），
    // 尾点/尾空格会被 Win32 静默削掉，CON/NUL 这类设备名会写进设备而不是文件。
    if (/[:<>"|?*]/.test(part)) throw new Error(`包内路径段含非法字符：${part}`);
    if (/[. ]$/.test(part)) throw new Error(`包内路径段以点或空格结尾：${part}`);
    if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i.test(part)) throw new Error(`包内路径段是设备名：${part}`);
    // Win32 的段名上限是 255 个 UTF-16 码元，不是 255 字节：86 个汉字 = 258 字节但只有 86 个
    // 字符，Windows 完全建得出来。按字节判会把合法包整包拒在 zipRead 阶段。
    if (part.length > 255) throw new Error(`包内路径段过长：${part.slice(0, 40)}…`);
    segments.push(part);
  }
  if (segments.length === 0) throw new Error(`包内路径为空：${text}`);
  return segments;
}

/**
 * HTTP 传来的落盘文件名同样不可信（`?path=` 直接来自请求）。
 * 只判最后一段：`:` 在 Windows 上是 ADS 分隔符，`writeFileSync('ads:stream')` 会先建出
 * 裸文件 `ads`、rename 再 EINVAL，目录里留下 0 字节垃圾；尾点/尾空格会被 Win32 静默削掉。
 * 目录部分走 isInsideAny 的 roots 校验，不在这里重复判。
 */
function assertWritableName(target) {
  const base = String(target).split(/[\\/]/).pop() ?? '';
  safeSegments(base);
  // 只判最后一段：safeSegments 已挡住 `:` `<` `>` `"` `|` `?` `*`、尾点、尾空格与 CON/NUL。
  // 整条绝对路径不能这样判——`C:` 的冒号会把自己误伤。
  return base;
}

/**
 * 拼到 root 之下，越界直接抛错。
 * 所有「来自包里的相对路径」都必须经过这里，不要直接用 path.join。
 */
function safeJoin(root, ...parts) {
  const segments = safeSegments(parts.map((part) => String(part)).join('/'));
  const dest = path.resolve(root, ...segments);
  if (!isInside(root, dest)) throw new Error(`包内路径越界，拒绝写入：${parts.join('/')}`);
  return dest;
}

/* ───────────────────────── 记住的路径 ───────────────────────── */

function readState() {
  const empty = { paths: {}, lastDir: undefined, autosave: {}, stamps: {}, stale: {}, missing: {} };
  try {
    const raw = JSON.parse(fs.readFileSync(stateFile(), 'utf8'));
    return {
      paths: raw?.paths && typeof raw.paths === 'object' ? raw.paths : {},
      lastDir: typeof raw?.lastDir === 'string' ? raw.lastDir : undefined,
      autosave: raw?.autosave && typeof raw.autosave === 'object' ? raw.autosave : {},
      stamps: raw?.stamps && typeof raw.stamps === 'object' ? raw.stamps : {},
      stale: raw?.stale && typeof raw.stale === 'object' ? raw.stale : {},
      missing: raw?.missing && typeof raw.missing === 'object' ? raw.missing : {},
    };
  } catch {
    return empty;
  }
}

/* ───────────────── 同步盘与「别处改过」检测（CAS） ───────────────── */

/** 常见同步盘目录名 → 提示用。只用于告知，不阻止保存。 */
const CLOUD_MARKS = [
  ['OneDrive', /onedrive/i],
  ['Dropbox', /dropbox/i],
  ['Google Drive', /google\s*drive/i],
  ['iCloud', /icloud|mobile documents/i],
  ['坚果云', /nutstore|坚果云/i],
  ['Box', /\bbox\b/i],
  ['Syncthing', /syncthing/i],
  ['Seafile', /seafile/i],
  ['百度网盘', /baidunetdisk|百度网盘/i],
];

/** 路径落在哪个同步盘里；不在同步盘返回 undefined。 */
export function cloudMarkOf(target) {
  const text = String(target ?? '');
  if (text === '') return undefined;
  const hit = CLOUD_MARKS.find(([, pattern]) => pattern.test(text));
  return hit === undefined ? undefined : hit[0];
}

/** 文件当前内容的 sha256；读不到返回 undefined。 */
export function fileStampOf(target) {
  try {
    const buf = fs.readFileSync(target);
    return { sha256: cryptoHash(buf), bytes: buf.length };
  } catch {
    return undefined;
  }
}

/**
 * 这份文件是不是被「别人」改过（另一台机器、同步盘、或手动替换）。
 * 只跟本机上一次写盘记下的 sha256 比；没记录过就当作没冲突。
 */
export function staleOf(state, sessionId, target) {
  const stamp = state?.stamps?.[sessionId];
  if (stamp === undefined || typeof stamp?.sha256 !== 'string') return undefined;
  if (typeof stamp.path !== 'string') return undefined;
  if (path.resolve(stamp.path) !== path.resolve(target)) return undefined;
  const now = fileStampOf(target);
  if (now === undefined) return undefined;
  if (now.sha256 === stamp.sha256) return undefined;
  return { expected: stamp.sha256, actual: now.sha256, bytes: now.bytes, since: stamp.at };
}

/**
 * 先写临时文件再改名：同步盘不会看到写了一半的包。
 *
 * `createDir: false` 时父目录必须已经存在，不存在就抛错。
 * 工程包的写入必须用这个模式：`mkdirSync(recursive)` 会在原目录被删掉/改名/
 * 磁盘没挂上时把整条目录树重新造出来，然后安静地写一个崭新的包 ——
 * 用户以为在更新原来那份，实际多出一份谁也找不到的孤儿文件。
 */
export function writeAtomic(target, bytes, options = {}) {
  const createDir = options.createDir !== false;
  const dir = path.dirname(target);
  if (createDir) fs.mkdirSync(dir, { recursive: true });
  else if (!fs.existsSync(dir)) throw new Error(`目标目录不存在：${dir}`);
  const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, bytes);
  try {
    fs.renameSync(tmp, target);
  } catch (error) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* 临时文件删不掉就留着 */
    }
    // Windows 的 `:` 是数据流分隔符：`writeFileSync('a:b')` 先建出裸文件 `a`，rename 才 EINVAL。
    // 只删 tmp 会把那个 0 字节的 `a` 永远留在用户的目录里（实测 tspath/ads 就是这么来的）。
    // 盘符那个冒号要先跳过：tmp 恒为绝对路径，第一个冒号在 index 1，
    // 「从盘符之后找冒号」才找得到文件名里那个（否则整段清理是死代码）。
    const drive = /^[A-Za-z]:[\\/]/.test(tmp) ? 2 : 0;
    const colon = tmp.indexOf(':', drive);
    if (colon > drive) {
      try {
        fs.unlinkSync(tmp.slice(0, colon));
      } catch {
        /* 没有这个裸文件是常态 */
      }
    }
    throw error;
  }
}

/**
 * 状态文件也必须原子写：自动保存与手动保存会并发读改写它，半截 JSON 会让
 * readState 整体回落成空状态 —— 表现就是「记住的保存路径全丢了」。
 */
function writeState(state, options = {}) {
  try {
    let out = state;
    // 给了 scoped 就只覆盖这几个会话的键：读-改-写这段中间隔着对话框等待，
    // 期间自动保存可能已经写了别的会话，整体覆盖会把那条改动抹掉。
    if (Array.isArray(options.scoped) === true) {
      const fresh = readState();
      out = {
        ...fresh,
        lastDir: state.lastDir ?? fresh.lastDir,
        paths: { ...fresh.paths },
        autosave: { ...fresh.autosave },
        stamps: { ...fresh.stamps },
        stale: { ...fresh.stale },
        missing: { ...fresh.missing },
      };
      for (const id of options.scoped) {
        for (const key of ['paths', 'autosave', 'stamps', 'stale', 'missing']) {
          const bucket = state[key];
          if (bucket !== undefined && bucket !== null && bucket[id] !== undefined) out[key][id] = bucket[id];
          else delete out[key][id];
        }
      }
    }
    writeAtomic(stateFile(), Buffer.from(JSON.stringify(out, null, 2), 'utf8'));
  } catch {
    /* 状态写不进去不影响本次保存 */
  }
}

/**
 * 记住「本机最近一次看到的这份文件」的内容指纹。
 * 打开工程、复用本机会话时都调它，这样之后别处改动能被 CAS 发现。
 */
function rememberSource(state, id, sourcePath) {
  const stamp = fileStampOf(sourcePath);
  state.paths[id] = sourcePath;
  state.lastDir = path.dirname(sourcePath);
  if (stamp !== undefined) {
    state.stamps[id] = { path: sourcePath, sha256: stamp.sha256, at: new Date().toISOString() };
  }
  delete state.stale[id];
  if (state.missing !== undefined && typeof state.missing === 'object') delete state.missing[id];
  return state;
}

/**
 * 成功导入的最后一件事：记住「本机这份会话来自哪个包」。
 *
 * 为什么排在返回体成型之后：状态文件是用户看得见的「这个包我打开过」，返回体是
 * 「这次到底成没成」。先落状态再拼返回体，任何一步在两者之间抛错（readStats 的
 * 超限重抛、返回体里新加的字段解析）都会留下「说没打开、状态里却有」的记录。
 * 只覆盖本次会话的键 —— 读-改-写之间可能隔着对话框，整表覆盖会抹掉别的会话。
 */
function commitSource(result, id, sourcePath) {
  try {
    writeState(rememberSource(readState(), id, sourcePath), { scoped: [id] });
  } catch {
    // 状态写不进去不影响这次打开；下次保存会重新问一遍路径。
  }
  return result;
}


/* ───────────────────────── 工作区列表（打开时选落点） ───────────────────────── */

/** `$DSH_HOME/storages/workspace.json` → [{ id, title, path, exists }] */
function readWorkspaces() {
  const file = path.join(dshHome(), 'storages', 'workspace.json');
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return [];
  }
  const table = raw?.tables?.workspaces;
  if (table === undefined || table === null || typeof table !== 'object') return [];
  const list = [];
  for (const [id, value] of Object.entries(table)) {
    const cwd = typeof value?.path === 'string' ? value.path : '';
    if (cwd === '') continue;
    list.push({
      id,
      title: typeof value?.title === 'string' && value.title !== '' ? value.title : path.basename(cwd) || cwd,
      path: cwd,
      exists: fs.existsSync(cwd),
    });
  }
  list.sort((a, b) => a.title.localeCompare(b.title, 'zh-Hans-CN'));
  return list;
}

/* ───────────────────────── 包内锁 + 侧车锁 ───────────────────────── */

/** The lock record embedded in every package this plugin writes. */
export function makeLock(sessionId, previous) {
  const writes = Number(previous?.writes);
  return {
    format: LOCK_FORMAT,
    sessionId,
    host: os.hostname(),
    pid: process.pid,
    at: new Date().toISOString(),
    writes: Number.isFinite(writes) ? writes + 1 : 1,
  };
}

/** Read the `LOCK.json` entry of a package (or its manifest mirror). */
export function lockOfPackage(entries, manifest) {
  const entry = entries?.get?.('LOCK.json');
  if (entry !== undefined) {
    try {
      return JSON.parse(entry.toString('utf8'));
    } catch {
      /* 坏锁文件按无锁处理 */
    }
  }
  const mirrored = manifest?.lock;
  return mirrored && typeof mirrored === 'object' ? mirrored : undefined;
}

/** Read the lock embedded in an existing `.dsproj` on disk. */
export function lockOfFile(file) {
  try {
    const entries = zipRead(fs.readFileSync(file));
    return lockOfPackage(entries, undefined);
  } catch {
    return undefined;
  }
}

const pidAlive = (pid) => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
};

/**
 * Whether an embedded lock should stop this write.
 * Same host → only while that pid is alive; other host → within the stale window.
 * @returns reason text, or undefined when the write may proceed
 */
export function lockBlocks(lock) {
  if (lock === undefined || typeof lock !== 'object') return undefined;
  if (lock.host === os.hostname()) {
    if (lock.pid === process.pid) return undefined;
    if (pidAlive(lock.pid)) {
      return `这个文件正被本机另一个 DSH 进程（pid ${lock.pid}）写入`;
    }
    return undefined;
  }
  const at = Date.parse(String(lock.at ?? ''));
  // 取绝对值：时钟回拨、跨机同步、手动改系统时间都会让 at 落在未来，差值变负数。
  // 只写 `now - at < TTL` 时未来时间戳永远为真，锁等于永不过期，保存会一直卡在「正在使用」。
  if (Number.isFinite(at) && Math.abs(Date.now() - at) < LOCK_STALE_MS) {
    return `这个文件正被 ${lock.host} 上的 DSH 使用（${lock.at}），可能还没存完`;
  }
  return undefined;
}

/**
 * 读侧车锁的当前内容：只用于把冲突原因原样回给界面（谁、什么时候、哪个 pid）。
 * 读不到就不带 —— 锁定判定本身不依赖它，它在判定之后可能已经被对面删掉。
 */
function readSidecarLock(target) {
  try {
    return JSON.parse(fs.readFileSync(`${target}.lock`, 'utf8'));
  } catch {
    return undefined;
  }
}

/**
 * Serialise writes to one package file across processes with a `.lock` sidecar.
 * A stale sidecar (dead pid on this host, or old on another host) is taken over.
 *
 * 锁文件里带一个随机 token：收尾时只在内容仍是这把锁时删除。
 * 以前无条件 unlink，判定稍微误一次就会把另一个进程正在用的锁删掉，两边同时写。
 */
function withSidecarLock(target, run, options = {}) {
  const sidecar = `${target}.lock`;
  const token = randomUUID();
  const payload = JSON.stringify({
    host: os.hostname(),
    pid: process.pid,
    at: new Date().toISOString(),
    token,
  });
  let fd;
  let owned = false;
  try {
    // 不在这里建目录：侧车锁要是顺手把父目录建出来，
    // writeAtomic({ createDir: false }) 那道「目录必须已经存在」的闸就白设了，
    // 一次 ?path=OUT/a/b/c/x.dsproj 就能造出用户找不到的孤儿包。
    fd = fs.openSync(sidecar, 'wx');
    fs.writeSync(fd, payload);
    owned = true;
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    let holder;
    try {
      holder = JSON.parse(fs.readFileSync(sidecar, 'utf8'));
    } catch {
      holder = undefined;
    }
    // ignoreLock：用户在界面上明确点了「仍然保存」。侧车锁只防并发覆盖，不防内容丢失，
    // 所以这一条允许被显式跳过（stale / confirm-overwrite / not-dsproj 那几条不允许）。
    const reason =
      options.ignoreLock === true ? undefined : lockBlocks({ ...holder, format: LOCK_FORMAT });
    if (reason !== undefined) {
      const blocked = new Error(`${reason}；稍后重试或删掉 ${sidecar}`);
      blocked.code = 'DSH_LOCKED';
      blocked.sidecar = sidecar;
      throw blocked;
    }
    try {
      fs.writeFileSync(sidecar, payload);
      owned = true;
    } catch {
      /* 抢锁失败就继续写，锁只是尽力而为 */
    }
  }
  try {
    return run();
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        /* ignore */
      }
    }
    if (owned) {
      let mine = false;
      try {
        mine = JSON.parse(fs.readFileSync(sidecar, 'utf8'))?.token === token;
      } catch {
        mine = false;
      }
      if (mine) {
        try {
          fs.unlinkSync(sidecar);
        } catch {
          /* ignore */
        }
      }
    }
  }
}

/* ───────────────────────── 另存为对话框（Host 侧真实窗口） ───────────────────────── */

/**
 * 弹原生另存为窗口：`undefined` = 这个平台拿不到窗口（调用方改走网页里的路径输入框）、
 * `null` = 用户取消、字符串 = 选中路径。
 *
 * 平台相关的实现全在 `dialog/` 下，本文件不认识 PowerShell 也不认识 COM：
 * - `dialog/index.mjs` 探测当前平台有没有实现（只看依赖在不在，不看版本号）
 * - `dialog/windows.mjs` 用 Windows PowerShell 5.1 拉 WinForms 的 SaveFileDialog
 *
 * 新增 macOS / Linux 实现时只需在 `dialog/index.mjs` 加一个分支，本文件零改动。
 */
function nativeSaveDialog(initial) {
  return platformSaveDialog(initial);
}

/** Same contract as nativeSaveDialog, but an Open dialog. */
function nativeOpenDialog(initial) {
  return platformOpenDialog(initial ?? '');
}

/* ───────────────────────── 打包 ───────────────────────── */

/** 把会话标题清成合法文件名：去掉 Windows 非法字符、折叠空白、限长。 */
export function sanitizeName(raw) {
  return String(raw ?? '')
    .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s]+/, '')
    .replace(/[.\s]+$/, '')
    .slice(0, 60)
    .trim();
}

export function suggestPath(sessionId, header, state, title = undefined) {
  const createdAt = Number(header?.createdAt) || Date.now();
  const d = new Date(createdAt);
  const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}-${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}`;
  const shortId = String(header?.id ?? sessionId).replace(/^session-/, '').slice(0, 8);
  let dir = state.lastDir;
  if (dir === undefined || !fs.existsSync(dir)) {
    const desktop = path.join(os.homedir(), 'Desktop');
    dir = fs.existsSync(desktop) ? desktop : os.homedir();
  }
  const label = sanitizeName(title);
  const base = label === '' ? `${stamp}-session-${shortId}` : `${label}-${stamp}`;
  return path.join(dir, `${base}.dsproj`);
}

/**
 * 打一个 `.dsproj`。
 * @param options.includeMemory - 是否连工作区记忆一起打包（默认否：MEMORY.md、日志、
 *   白板都是私人内容，不该在用户没明确要的时候跟着包流出去）
 */
function buildPackage(
  sessionFile,
  buf,
  header,
  stats = { frames: undefined, lines: undefined },
  lock = undefined,
  options = {},
) {
  const includeMemory = options.includeMemory === true;
  const entries = [];
  const parts = {};
  const fileName = path.basename(sessionFile);
  entries.push({ name: `session/${fileName}`, data: buf, store: true });
  parts[`session/${fileName}`] = { sha256: cryptoHash(buf), bytes: buf.length };

  const memory = includeMemory ? resolveMemoryDir(header?.cwd) : undefined;
  const memoryFiles = [];
  if (memory !== undefined) {
    for (const full of walkFiles(memory.dir)) {
      const rel = path.relative(memory.dir, full).split(path.sep).join('/');
      const data = fs.readFileSync(full);
      entries.push({ name: `memory/workspaces/${memory.slug}/${rel}`, data });
      memoryFiles.push(rel);
      parts[`memory/workspaces/${memory.slug}/${rel}`] = { sha256: cryptoHash(data), bytes: data.length };
    }
  }

  // 附件：会话日志里只留 `sha256:` 引用，图片/文件的字节在 DSH_HOME/attachments/v1 下。
  // 不把命中的对象一起带走，换台机器打开就是 ATTACHMENT_NOT_FOUND —— 而且重试不自愈，
  // 因为引用指向的是一段固定哈希。本机本来就没有的对象记进 manifest，让导入方知道
  // 「这个包天生缺东西」，而不是等它打开时炸一脸。
  const attachmentObjects = [];
  const attachmentFiles = [];
  const missingAttachments = [];
  if (options.includeAttachments !== false) {
    for (const sha of attachmentRefs(buf)) {
      let found = false;
      for (const kind of ['objects', 'files']) {
        const source = path.join(attachmentRootDir(kind), sha.slice(0, 2), sha);
        let data;
        try {
          data = fs.readFileSync(source);
        } catch {
          continue;
        }
        // 名字就是哈希：读出来对不上说明文件坏了，宁可不带也不能带坏字节
        if (cryptoHash(data) !== sha) continue;
        const entryName = `attachments/${kind}/${sha.slice(0, 2)}/${sha}`;
        entries.push({ name: entryName, data, store: true });
        parts[entryName] = { sha256: cryptoHash(data), bytes: data.length };
        (kind === 'objects' ? attachmentObjects : attachmentFiles).push({ id: `sha256:${sha}`, bytes: data.length });
        found = true;
      }
      if (!found) missingAttachments.push(`sha256:${sha}`);
    }
  }

  const bili = collectBili(header?.id);
  if (bili.entry !== undefined) {
    entries.push(bili.entry);
    parts[BILI_ENTRY] = { sha256: cryptoHash(bili.entry.data), bytes: bili.entry.data.length };
  }

  const manifest = {
    format: FORMAT,
    // 写这个包的是哪个版本。读的一方凭它认出「包比我新」——比猜测条目前缀可靠。
    plugin: { name: 'dsh-session-save', version: PLUGIN_VERSION },
    exportedAt: new Date().toISOString(),
    exportedBy: `dsh-session-save on ${os.hostname()}`,
    session: {
      id: header?.id,
      version: header?.version,
      cwd: header?.cwd,
      createdAt: header?.createdAt,
      agentPreset: header?.agentPreset,
      fileName,
      frames: stats.frames,
      lines: stats.lines,
      bytes: buf.length,
    },
    memorySlug: memory?.slug,
    memoryFiles,
    workspaceFiles: [],
    attachments: { objects: attachmentObjects, files: attachmentFiles, missing: missingAttachments },
    bili: bili.info,
    lock,
    parts,
  };
  entries.push({ name: 'manifest.json', data: Buffer.from(JSON.stringify(manifest, null, 2), 'utf8') });
  if (lock !== undefined) {
    entries.push({ name: 'LOCK.json', data: Buffer.from(JSON.stringify(lock, null, 2), 'utf8') });
  }

  const L = [];
  L.push(`# 会话工程：${header?.id ?? '(unknown)'}`);
  L.push('');
  L.push('| 项 | 值 |');
  L.push('| --- | --- |');
  L.push(`| 会话 ID | \`${header?.id}\` |`);
  L.push(`| 原始工作区 | \`${header?.cwd}\` |`);
  L.push(`| 创建时间 | ${new Date(Number(header?.createdAt) || 0).toISOString()} |`);
  L.push(`| 日志体积 | ${(buf.length / 1024).toFixed(1)} KB（${stats.frames ?? '?'} 个 zstd 帧 / ${stats.lines ?? '?'} 行） |`);
  L.push(`| agentPreset | ${header?.agentPreset ?? '-'} |`);
  L.push(`| 保存时间 | ${new Date().toISOString()} |`);
  if (lock !== undefined) {
    L.push(`| 写入者 | ${lock.host}（pid ${lock.pid}，第 ${lock.writes} 次写入） |`);
    L.push(`| 锁时间 | ${lock.at} |`);
  }
  L.push('');
  if (memoryFiles.length > 0) {
    L.push(`## 随包记忆文件（${memoryFiles.length} 个）`);
    L.push('');
    for (const rel of memoryFiles) L.push(`- \`${rel}\``);
    L.push('');
  } else if (!includeMemory) {
    L.push('## 工作区记忆');
    L.push('');
    L.push('这个包只含会话本身，没有带 `~/.dsh/memory` 里的项目记忆、日志与白板。');
    L.push('');
  }
  const attachTotal = attachmentObjects.length + attachmentFiles.length;
  if (attachTotal > 0 || missingAttachments.length > 0) {
    L.push('## 随包附件（图片 / 文件对象）');
    L.push('');
    L.push(`随包带走 ${attachTotal} 个（图片 ${attachmentObjects.length} / 文件 ${attachmentFiles.length}）。换台机器打开时按内容哈希回填，已存在就跳过。`);
    if (missingAttachments.length > 0) {
      L.push('');
      L.push(`打包时就缺 ${missingAttachments.length} 个，这些引用在目标机器上会报 \`ATTACHMENT_NOT_FOUND\`：`);
      for (const id of missingAttachments) L.push(`- \`${id}\``);
    }
    L.push('');
  }
  entries.push({ name: 'SUMMARY.md', data: Buffer.from(L.join('\n'), 'utf8') });

  return { zip: zipWrite(entries), entries: entries.map((entry) => entry.name), manifest };
}

function walkFiles(dir, acc = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkFiles(full, acc);
    else if (entry.isFile()) {
      try {
        if (fs.statSync(full).size < 8 * 1024 * 1024) acc.push(full);
      } catch {
        /* 跳过硬链接/权限问题 */
      }
    }
  }
  return acc;
}

/* ───────────────────────── 导入（打开 .dsproj） ───────────────────────── */

/** Memory dir for a cwd: reuse the existing one, else the canonical name. */
function memoryDirFor(cwd) {
  const existing = resolveMemoryDir(cwd);
  if (existing !== undefined) return existing;
  const slug = `--${String(cwd).replace(/[/\\:]/g, '-').replace(/^-+/, '').slice(0, 251)}--`;
  return { slug, dir: path.join(memoryRoot(), slug) };
}

/**
 * Rewrite only the header frame; frames 1..n stay byte-identical.
 * @param buf - whole session log
 * @param patch - header fields to replace
 */
export function rewriteHeader(buf, patch) {
  const frames = scanZstdFrames(buf);
  if (frames.length === 0) throw new Error('会话日志里没有完整的 zstd 帧');
  // 覆盖率闸：认出来的帧必须覆盖整个文件。扫描中断时 frames 会提前结束，
  // 这时 `buf.subarray(frames[1].start)` 看着像「正文」，其实是把认不出的部分整段丢掉——
  // 实测三帧 396 B 会被重写成 161 B 单帧，正文全没了还回 200。
  if (frames[frames.length - 1].end !== buf.length) {
    throw new Error(
      `会话日志的帧扫描不完整（覆盖到 ${frames[frames.length - 1].end}/${buf.length} 字节，末帧可能被截断），拒绝重写`,
    );
  }
  const head = decompressFrame(buf.subarray(frames[0].start, frames[0].end)).toString('utf8');
  const nl = head.indexOf('\n');
  const before = JSON.parse(nl === -1 ? head : head.slice(0, nl));
  const tail = nl === -1 ? '' : head.slice(nl);
  const header = { ...before, ...patch };
  const frame = zlib.zstdCompressSync(Buffer.from(JSON.stringify(header) + tail, 'utf8'), CHECKSUM_OPTIONS);
  const rest = frames.length > 1 ? buf.subarray(frames[1].start) : Buffer.alloc(0);
  return { buffer: Buffer.concat([frame, rest]), header, before };
}

/** The cwd a package should land in: the recorded one if it exists here, else this host's cwd. */
// 「路径不存在」这一种，插件可以自己解决：用户点了「在这里新建」就建出来，
// 不必让他去资源管理器里逐级创建。但只认绝对路径、且不碰盘符根/根目录——
// 那两种是「路径本身写错了」，不是「文件夹还没建」，硬建只会造出一堆垃圾目录。
function canAutoCreateCwd(target) {
  if (typeof target !== 'string' || target === '') return false;
  if (path.isAbsolute(target) !== true) return false;
  if (path.dirname(target) === target) return false;
  return true;
}

function landingCwd(preferred) {
  if (typeof preferred === 'string' && preferred !== '') {
    // 必须是**目录**：existsSync 对普通文件也返回 true，放过去会在 sessions/ 下
    // 建出以文件路径为键的目录（实测 sessions/--C-...-a-plain-file.txt--/）。
    // 用 statSync 而不是 lstatSync——工作区可能是 junction，lstat 会让它们全部失效。
    let stat;
    try {
      stat = fs.statSync(preferred);
    } catch {
      stat = undefined;
    }
    if (stat !== undefined && stat.isDirectory() === true) return preferred;
    // 明确给了但不合格时**不回落** process.cwd()：那样落点与用户以为的完全无关，
    // 而且一个字都不提示。这里抛，由 importPackage 转成 bad-workspace。
    // 抛出的错带上「哪个路径」和「什么毛病」，不然调用方只能回一句「不可用」，
    // 用户既不知道是哪个路径，也不知道是该建目录还是该改配置。
    const error = new Error('工作区不可用');
    error.cwd = preferred;
    error.reason = stat === undefined ? 'missing' : 'not-directory';
    throw error;
  }
  return process.cwd();
}

/** Latest `session/title` value in the log, for the toast. */
function readTitle(buf) {
  for (const frame of scanZstdFrames(buf)) {
    let text;
    try {
      text = decompressFrame(buf.subarray(frame.start, frame.end)).toString('utf8');
    } catch (error) {
      if (error?.code === 'ERR_BUFFER_TOO_LARGE') throw error;
      continue;
    }
    let found;
    for (const line of text.split('\n')) {
      if (!line.includes('"session/title"')) continue;
      try {
        const event = JSON.parse(line);
        if (typeof event?.data?.title === 'string') found = event.data.title;
      } catch {
        /* 坏行跳过 */
      }
    }
    if (found !== undefined) return found;
  }
  return undefined;
}

/**
 * 包内条目名白名单：只认这几种，别的一律拒绝。
 * 这样即便将来某个写入路径漏了校验，夹带进来的额外文件也进不了盘。
 */
const ENTRY_ALLOW = [
  /^manifest\.json$/,
  /^LOCK\.json$/,
  /^SUMMARY\.md$/,
  /^session\/[^/]+\.jsonl(\.zstd)?$/,
  /^memory\/workspaces\/[^/]+\/.+$/,
  /^attachments\/(objects|files)\/[0-9a-f]{2}\/[0-9a-f]{64}$/,
  /^bili\/session\.json$/,
];

/**
 * 内容条目：真正会被写进磁盘的东西（会话日志、工作区记忆）。
 * `parts` 只登记这两类（元数据条目 manifest/LOCK/SUMMARY 不登记），
 * 所以「必须在 parts 里声明过」这条只能对它们提要求。
 */
const CONTENT_ENTRY = /^(session\/|memory\/workspaces\/|attachments\/|bili\/)/;

/**
 * 「这类条目是从哪个版本开始被认识的」。
 * 包没写 `plugin.version` 时（老包、别的工具拼的包），靠它反推写包方有多新，
 * 才能把「包里夹带了怪东西」和「你该升级插件了」分开说。
 * 新增一类顶层条目时，记得在这里加一行。
 */
const ENTRY_SINCE = [
  [/^attachments\//, '0.3.0'],
  // `bili/` 在当前版本（0.4.2）的 ENTRY_ALLOW 里就已经认识。标成还没发布的 0.4.3 会让提示
  // 自相矛盾：同一句话里既写「写它的是 0.4.2」，又让人「先升级插件」。新增顶层条目时，
  // 这里的版本必须是它真正首发的版本，且不得大于 PLUGIN_VERSION（test/audit-r3 有断言）。
  [/^bili\//, '0.4.2'],
];

/**
 * 白名单外的条目该怎么说。
 *
 * 0.2.x 打开 0.3.0 的包时只得到一句「包里有不认识的条目」—— 用户以为是包坏了，
 * 其实只是插件旧了。这里先回答「是不是我太旧」，是就明说升级，别让人去怀疑文件。
 */
function unknownEntryMessage(entryName, manifest) {
  const writer =
    typeof manifest?.plugin?.version === 'string' && manifest.plugin.version !== ''
      ? manifest.plugin.version
      : undefined;
  const since = ENTRY_SINCE.find(([pattern]) => pattern.test(entryName));
  const need = since === undefined ? undefined : since[1];
  const newerWriter = writer !== undefined && compareVersions(writer, PLUGIN_VERSION) > 0;
  const newerEntry = need !== undefined && compareVersions(need, PLUGIN_VERSION) > 0;
  if (newerWriter || newerEntry) {
    const from =
      writer !== undefined ? `写它的是 ${writer}` : `这类条目从 ${need} 才开始有`;
    return `这个包来自更新版本的 dsh-session-save（${from}，本机是 ${PLUGIN_VERSION}）：先升级插件再打开。包本身没坏，升级后能照常打开。`;
  }
  return `包里有不认识的条目，拒绝打开：${entryName}`;
}

/**
 * 打开前的整包校验：条目白名单 + `manifest.parts` 的 sha256／体积比对。
 * digest 在打包时就写好了，这里第一次真正用它 —— 传输中被改动或被人塞了东西就能发现。
 *
 * 光比对 `parts` 里声明过的条目不够：攻击者可以只声明合法条目（哈希全对），
 * 另外夹带一条没声明的 `memory/workspaces/<slug>/MEMORY.md` —— 那是每轮注入上下文的
 * 项目长期笔记，写进去等于 prompt injection。所以内容条目必须「全都被声明过」。
 */
function verifyPackage(entries, manifest, options = {}) {
  // 宽松模式只在用户明确点了「尝试修复后打开」时启用：校验不过的条目**从包里摘掉**，
  // 能救多少救多少，然后把丢掉的清单交给调用方写进返回体。
  // 默认（严格）行为一个字节都不改——校验放宽了就等于包校验形同虚设。
  const lenient = options.lenient === true;
  const dropped = [];
  const drop = (name, why) => {
    if (entries.delete(name) === true) dropped.push({ name, why });
  };
  for (const name of [...entries.keys()]) {
    if (!ENTRY_ALLOW.some((pattern) => pattern.test(name))) {
      if (lenient !== true) throw new Error(unknownEntryMessage(name, manifest));
      drop(name, 'unexpected-entry');
    }
  }
  const parts = manifest?.parts;
  if (parts === undefined || parts === null || typeof parts !== 'object') {
    // 老包/第三方包可能没有 parts：会话条目照旧放行（不然旧包全打不开），
    // 但记忆条目无法验证来源，一律拒绝。
    for (const name of [...entries.keys()]) {
      if (!name.startsWith('memory/workspaces/')) continue;
      if (lenient !== true) throw new Error(`包内记忆条目缺少 manifest.parts，拒绝打开：${name}`);
      drop(name, 'undeclared');
    }
    return lenient === true ? { dropped } : undefined;
  }
  for (const [name, meta] of Object.entries(parts)) {
    const data = entries.get(name);
    if (data === undefined) continue; // 旧包可能没带全，缺的条目按「没有」处理
    let why;
    if (typeof meta?.sha256 === 'string' && cryptoHash(data) !== meta.sha256) why = 'hash-mismatch';
    else if (Number.isFinite(meta?.bytes) && data.length !== meta.bytes) why = 'size-mismatch';
    if (why === undefined) continue;
    if (lenient !== true) {
      throw new Error(
        why === 'hash-mismatch'
          ? `包内条目校验失败（内容被改动过）：${name}`
          : `包内条目体积不符：${name}`,
      );
    }
    drop(name, why);
  }
  // 内容条目必须在 parts 里声明过，否则等于绕过了上面的完整性校验
  for (const name of [...entries.keys()]) {
    if (!CONTENT_ENTRY.test(name)) continue;
    if (Object.prototype.hasOwnProperty.call(parts, name)) continue;
    if (lenient !== true) throw new Error(`包内条目未在 manifest.parts 中声明，拒绝打开：${name}`);
    drop(name, 'undeclared');
  }
  return lenient === true ? { dropped } : undefined;
}

/**
 * 包彻底打不开时给用户的一段话：他可以直接整段贴给任意 AI，连同路径一起让 AI 修。
 * 只描述格式与定位方法，不假设对方装了本插件——所以把条目结构写全。
 */
function packageBrokenReport(sourcePath, error, names) {
  let size = 0;
  try {
    size = fs.statSync(sourcePath).size;
  } catch {
    size = 0;
  }
  const shown = names.slice(0, 60);
  const lines = [
    '我手上有一个 DSH 会话工程包（.dsproj）打不开，请你帮我修。',
    '',
    `包路径：${sourcePath}`,
    `包体积：${size} 字节`,
    `打开它的插件：dsh-session-save ${PLUGIN_VERSION}`,
    `报错原文：${String(error?.message ?? error)}`,
    '',
    `包内条目（共 ${names.length} 个，下面列出前 ${shown.length} 个）：`,
    ...shown.map((name) => `  - ${name}`),
  ];
  if (names.length > shown.length) lines.push(`  …另有 ${names.length - shown.length} 个未列出`);
  lines.push(
    '',
    '这个包的本质是一个 zip，条目名与约定如下：',
    '  manifest.json —— 顶层；format 为 dshproj/1；parts 记录每个内容条目的 sha256 与 bytes；lock 记录写出方',
    '  session/<name>.jsonl 或 session/<name>.jsonl.zstd —— 会话日志，内容是 JSON Lines，zstd 变体是多帧拼接',
    '  memory/workspaces/<slug>/<相对路径> —— 该会话所在工作区的记忆文件',
    '  attachments/objects/<sha前2位>/<sha256> 与 attachments/files/<sha前2位>/<sha256> —— 附件对象，文件名就是内容的 sha256',
    '',
    '请按这个顺序做，不要跳步：',
    '  1. 解压到临时目录，对每个内容条目重算 sha256 与字节数，和 manifest.parts 逐条比对，列出对不上的；',
    '  2. 如果只是 manifest.parts 记错了（重算值稳定、条目本身能正常解压），就按实际值修正 manifest.json；',
    '  3. 如果某条目字节确实坏了：附件、记忆条目可以删掉它并从 parts 同步删除；session/ 条目不能删——真坏了请先告诉我坏在哪几个字节，别猜；',
    '  4. 重新打包成 zip，manifest.json 放在根目录，条目名与上面约定一致，压缩方式不限；',
    '  5. 告诉我修好的文件路径、改了哪几条、还有哪些没能救回来。',
    '',
    '硬约束：不要改 session 日志的字节，不要重命名附件对象（名字就是内容哈希，改了就永久对不上），不要往包里加新条目。',
  );
  return {
    status: 'package-broken',
    // message 就是校验器的原话：用户先看懂「哪儿不合规」，再看下面的修包说明。
    message: String(error?.message ?? error),
    error: String(error?.message ?? error),
    sourcePath,
    entries: names.slice(0, 200),
    prompt: lines.join('\n'),
  };
}

/**
 * Unpack a `.dsproj` into this DSH_HOME and return the identity to open.
 * @param sourcePath - package file
 * @param options - { cwd?, memory?, onConflict? }
 */
function importPackage(sourcePath, options = {}) {
  let entries;
  try {
    entries = zipRead(fs.readFileSync(sourcePath));
  } catch (readError) {
    // 解包阶段抛的错（不是 ZIP / 中央目录或条目越界 / 单条或整包超限）都是「包坏了」，
    // 不是服务端内部故障。以前它冒到 handleOpen 的兜底 catch，变成 500 + 一句通用文案，
    // 用户拿不到 package-broken 里那段能整段贴给 AI 的修包说明，界面上的修复面板也不会弹。
    return packageBrokenReport(sourcePath, readError, []);
  }
  const manifestEntry = entries.get('manifest.json');
  let manifest;
  if (manifestEntry !== undefined) {
    try {
      manifest = JSON.parse(manifestEntry.toString('utf8'));
    } catch {
      manifest = undefined;
    }
  }
  let packageRepair;
  try {
    verifyPackage(entries, manifest);
  } catch (verifyError) {
    const reasonText = String(verifyError?.message ?? '');
    // 「包比插件新」不是包坏了——修包流程会建议用户删条目，那是错的提示。
    if (reasonText.includes('更新版本')) {
      return { status: 'newer-package', message: reasonText, sourcePath };
    }
    if (options.repairPackage !== true) {
      return packageBrokenReport(sourcePath, verifyError, [...entries.keys()]);
    }
    // 宽松重试：重新解一遍，别拿严格模式可能动过的 Map。
    entries = zipRead(fs.readFileSync(sourcePath));
    const lenientManifest = entries.get('manifest.json');
    let retryManifest = manifest;
    if (lenientManifest !== undefined) {
      try {
        retryManifest = JSON.parse(lenientManifest.toString('utf8'));
      } catch {
        retryManifest = manifest;
      }
    }
    let lenientResult;
    try {
      lenientResult = verifyPackage(entries, retryManifest, { lenient: true });
    } catch (fatal) {
      // 宽松模式仍拒绝 = 连会话日志本身都没法信任，这时不能硬塞进 sessions/。
      return packageBrokenReport(sourcePath, fatal, [...entries.keys()]);
    }
    const stillHasSession = [...entries.keys()].some((name) => name.startsWith('session/'));
    if (stillHasSession !== true) {
      return packageBrokenReport(sourcePath, verifyError, [...entries.keys()]);
    }
    const dropped = lenientResult?.dropped ?? [];
    packageRepair = {
      dropped,
      reason: String(verifyError?.message ?? verifyError),
    };
    // 条目被摘掉后 parts / attachments 声明也要跟着收窄，否则后面按声明取条目会撞空。
    if (manifest !== undefined && typeof manifest === 'object' && Array.isArray(dropped) === true) {
      const gone = new Set(dropped.map((item) => item.name));
      if (manifest.attachments !== undefined && manifest.attachments !== null && typeof manifest.attachments === 'object') {
        for (const key of ['objects', 'files']) {
          const list = manifest.attachments[key];
          if (Array.isArray(list) !== true) continue;
          manifest.attachments[key] = list.filter((item) => {
            const sha = typeof item?.sha256 === 'string' ? item.sha256 : '';
            return gone.has(`attachments/${key}/${sha.slice(0, 2)}/${sha}`) !== true;
          });
        }
      }
    }
  }
  const sessionName = [...entries.keys()].find((name) => /^session\/.+\.jsonl(\.zstd)?$/.test(name));
  if (sessionName === undefined) throw new Error('包里没有会话日志（session/…）');
  const buf = entries.get(sessionName);
  const original = readHeader(buf);
  // id 会成为 state.paths 的键、目录名的一部分。`__proto__` 这类键会被 setter 吞掉，
  // 非 uuid 形态则可能撞上别的东西——只判「非空字符串」不够。
  if (!isSessionId(original?.id)) throw new Error(`会话日志的 header.id 不是合法会话 id：${String(original?.id)}`);

  const explicitCwd = typeof options.cwd === 'string' && options.cwd !== '' ? options.cwd : undefined;
  const dirFor = (sessionId, targetCwd) => path.join(sessionsRoot(), projectKey(targetCwd), encodeSegment(sessionId));
  const mode = ['ask', 'reuse', 'overwrite', 'copy'].includes(options.onConflict) ? options.onConflict : 'ask';
  // 覆盖前要不要留一份原文件，由界面上的勾选框决定；默认留（宁可多一个 .bak，也不少一条退路）。
  const backupWanted = options.backup !== false;
  const packageLock = lockOfPackage(entries, manifest);

  /** The session dir for this id anywhere under DSH_HOME (id must stay unique). */
  const findExisting = (sessionId) => {
    const wanted = encodeSegment(sessionId);
    let projects;
    try {
      projects = fs.readdirSync(sessionsRoot(), { withFileTypes: true });
    } catch {
      return undefined;
    }
    for (const project of projects) {
      if (!project.isDirectory()) continue;
      const dir = path.join(sessionsRoot(), project.name, wanted);
      if (!fs.existsSync(dir)) continue;
      let file;
      try {
        const logName = fs.readdirSync(dir).find((name) => /^session(\.[0-9A-Za-z]+)?\.jsonl(\.zstd)?$/.test(name));
        if (logName !== undefined) file = path.join(dir, logName);
      } catch {
        file = undefined;
      }
      if (file === undefined) continue;
      let header;
      let buf;
      try {
        buf = fs.readFileSync(file);
        header = readHeader(buf);
      } catch {
        header = undefined;
      }
      return { dir, file, header, buf };
    }
    return undefined;
  };

  const existing = findExisting(original.id);
  if (existing === undefined && explicitCwd === undefined) {
    // 本机没有这个会话，也没指定落点 → 先问要打开到哪个工作区
    return {
      status: 'need-workspace',
      sessionId: original.id,
      title: readTitle(buf),
      originalCwd: original.cwd,
      exportedAt: manifest?.exportedAt,
      exportedBy: manifest?.exportedBy,
      workspaces: readWorkspaces(),
      sourcePath,
    };
  }

  let cwd;
  try {
    cwd = landingCwd(explicitCwd ?? manifest?.session?.cwd ?? original.cwd);
  } catch (error) {
    // 这条路走的是**正常返回体**，apply 的 catch 不会替我们过滤绝对路径。
    // 这里回显的是用户自己在包里的工作区路径（不是服务端目录），必须给：
    // 只说「不是可用的目录」的话，用户既不知道是哪个路径，也不知道下一步该做什么。
    // 同时带上本机可用工作区列表，客户端直接复用「打开到哪个工作区」那个弹窗，
    // 选一个就能继续——否则这个状态就是死路。
    // 用户点了界面上的「在这里新建」：插件自己把目录建出来再继续，不指望用户
    // 去理解什么叫「工作区路径」。只处理「不存在」这一种；「是个文件」不能代劳，
    // 那是用户的文件，删了才叫闯祸。
    let failure = error;
    let createError;
    const canCreate = options.createCwd === true
      && failure?.reason === 'missing'
      && canAutoCreateCwd(failure?.cwd) === true;
    // 「位置被一个文件占着」也能代劳，但删用户文件是闯祸，所以只改名不删：
    // 备份成 <原名>.bak-<时间>，用户随时能改回来。必须由界面按钮显式传 replaceFile。
    let replacedFile;
    const canReplace = options.replaceFile === true
      && failure?.reason === 'not-directory'
      && canAutoCreateCwd(failure?.cwd) === true;
    if (canReplace === true) {
      try {
        const backup = `${failure.cwd}.bak-${Date.now()}`;
        fs.renameSync(failure.cwd, backup);
        fs.mkdirSync(failure.cwd);
        cwd = landingCwd(failure.cwd);
        replacedFile = backup;
        failure = undefined;
      } catch (failed) {
        createError = failed;
        // 改名成功了但建目录失败：把文件改回去，别留一个「文件没了、目录也没建」的中间态。
        try {
          if (replacedFile !== undefined && fs.existsSync(replacedFile) === true && fs.existsSync(failure.cwd) !== true) {
            fs.renameSync(replacedFile, failure.cwd);
            replacedFile = undefined;
          }
        } catch {
          // 改不回去也不能吞掉原始错误，下面返回体里会带上 createError 原文
        }
      }
    }
    if (canCreate === true) {
      try {
        fs.mkdirSync(failure.cwd, { recursive: true });
        // 建完照样要再过一遍 landingCwd：mkdir 可能只建出了上半截，或路径上
        // 还躺着一个同名文件。别因为「我试过了」就放行。
        cwd = landingCwd(failure.cwd);
        failure = undefined;
      } catch (failed) {
        createError = failed;
      }
    }
    if (failure !== undefined) {
      const badCwd = typeof failure?.cwd === 'string' ? failure.cwd : '';
      const missing = failure?.reason === 'missing';
      const failedText = createError === undefined ? '' : String(createError?.message ?? '');
      return {
        status: 'bad-workspace',
        sessionId: original.id,
        title: readTitle(buf),
        originalCwd: original.cwd,
        cwd: badCwd,
        reason: missing === true ? 'missing' : 'not-directory',
        // 界面据此决定要不要给「在这里新建」按钮：缺目录、且还没建失败过才给。
        canCreate: missing === true && failedText === '',
        canReplace: missing !== true && failedText === '' && canAutoCreateCwd(badCwd) === true,
        replacedFile,
        createError: failedText === '' ? undefined : failedText,
        workspaces: readWorkspaces(),
        sourcePath,
        message: missing === true
          ? (failedText === ''
            ? `这个包原来在 ${badCwd} 打开，本机上这个文件夹不存在。`
            : `新建 ${badCwd} 失败：${failedText}。请换一个位置。`)
          : (failedText === ''
            ? `这个包原来在 ${badCwd} 打开，但本机这个位置是一个文件，不是文件夹。`
            : `把 ${badCwd} 改名备份后新建文件夹失败：${failedText}。请换一个位置。`),
      };
    }
  }

  let id = original.id;
  let renamed = false;
  let conflictResolved;
  let target;
  let targetDir;

  if (existing !== undefined) {
    const sameSession = existing.header?.createdAt === original.createdAt;
    const existingCwd = existing.header?.cwd;
    const sameCwd =
      typeof existingCwd === 'string' && path.resolve(existingCwd) === path.resolve(cwd);
    if (sameSession && sameCwd && mode !== 'overwrite') {
      // 同一会话的另一份（同 id + 同 createdAt + 同工作区）→ 直接打开本机这份，不复制
      // 但用户明确选了「覆盖」时必须往下走：这一支只是「打开已有内容」的快捷路，
      // 它不能替用户决定「别覆盖」——否则点了覆盖看到的还是旧内容（2026-11-02 报的 bug）
      // 直接打开本机这份，也照样回填附件：用户很可能就是拿这个包来补上次没带过来的图
      const attachRestore = restoreAttachments(entries);
      const biliRestore = restoreBili(entries, id, backupWanted);
      const repairReport = repairInPlace(existing.file, { backup: backupWanted });
      const result = {
        sessionId: id,
        cwd,
        target: existing.file,
        reused: true,
        renamed: false,
        originalCwd: original.cwd,
        title: readTitle(existing.buf),
        stats: readStats(existing.buf),
        memoryWritten: 0,
        memorySkipped: 0,
        memoryConflicts: [],
        attachmentsWritten: attachRestore.written,
        attachmentsSkipped: attachRestore.skipped,
        attachmentsRejected: attachRestore.rejected,
        bili: biliRestore,
        repair: repairReport,
        packageRepair,
        sourcePath,
        packageLock,
      };
      return commitSource(result, id, sourcePath);
    }

    if (sameSession && !(sameCwd && mode === 'overwrite')) {
      // 同一会话，但要求落到别的工作区 → 就地再开一份，换新 id（id 必须全机唯一）
      // 「同会话同位置 + 用户要覆盖」不适用这一支：那种情况该盖掉原地那份，不是另起一份
      conflictResolved = 'relocate';
      id = `session-${randomUUID()}`;
      renamed = true;
    } else if (mode === 'ask') {
      return {
        conflict: true,
        sessionId: id,
        cwd,
        existing: {
          target: existing.file,
          id: existing.header?.id ?? id,
          cwd: existing.header?.cwd,
          createdAt: existing.header?.createdAt,
          title: readTitle(existing.buf),
          stats: readStats(existing.buf),
          bytes: existing.buf?.length,
        },
        incoming: {
          id: original.id,
          cwd: original.cwd,
          createdAt: original.createdAt,
          title: readTitle(buf),
          stats: readStats(buf),
          bytes: buf.length,
          exportedAt: manifest?.exportedAt,
          exportedBy: manifest?.exportedBy,
          lock: packageLock,
        },
        sourcePath,
      };
    }

    if (mode === 'reuse') {
      // 直接打开本机这份，也照样回填附件：用户很可能就是拿这个包来补上次没带过来的图
      const attachRestore = restoreAttachments(entries);
      const biliRestore = restoreBili(entries, id, backupWanted);
      const repairReport = repairInPlace(existing.file, { backup: backupWanted });
      const result = {
        sessionId: id,
        cwd: existing.header?.cwd ?? cwd,
        target: existing.file,
        reused: true,
        renamed: false,
        conflictResolved: 'reuse',
        originalCwd: original.cwd,
        title: readTitle(existing.buf),
        stats: readStats(existing.buf),
        memoryWritten: 0,
        memorySkipped: 0,
        memoryConflicts: [],
        attachmentsWritten: attachRestore.written,
        attachmentsSkipped: attachRestore.skipped,
        attachmentsRejected: attachRestore.rejected,
        bili: biliRestore,
        repair: repairReport,
        packageRepair,
        sourcePath,
        packageLock,
      };
      return commitSource(result, id, sourcePath);
    }

    if (mode === 'overwrite') {
      // 用包里的内容盖掉本机这份：同 id、同位置，旧文件留 .bak
      conflictResolved = 'overwrite';
      targetDir = existing.dir;
      target = existing.file;
      try {
        if (backupWanted === true) {
          fs.copyFileSync(existing.file, `${existing.file}.bak-${Date.now()}`);
        }
      } catch {
        /* 备份失败不阻断覆盖 */
      }
    } else {
      // copy：换新 id，两条历史都留着
      conflictResolved = 'copy';
      id = `session-${randomUUID()}`;
      renamed = true;
    }
  }

  // 包里的 fileName 也是外部输入：先按两种分隔符切掉任何目录部分，再要求它长得像
  // 会话日志名（`session...jsonl[.zstd]`）。不认识的形态直接回落到包内条目名。
  const declared = manifest?.session?.fileName;
  const declaredBase =
    typeof declared === 'string' ? String(declared).split(/[\\/]+/).pop() ?? '' : '';
  const packageBase = path.basename(sessionName);
  let fileName = LOG_NAME_RE.test(packageBase) ? packageBase : encodeSegment(packageBase);
  if (target !== undefined) {
    const base = path.basename(target);
    if (LOG_NAME_RE.test(base)) fileName = base;
  } else if (LOG_NAME_RE.test(declaredBase)) {
    fileName = declaredBase;
  }

  let finalBuf = buf;
  let header = original;
  if (id !== original.id || cwd !== original.cwd) {
    const out = rewriteHeader(buf, { id, cwd });
    finalBuf = out.buffer;
    header = out.header;
  }

  if (target === undefined) {
    targetDir = dirFor(id, cwd);
    target = path.join(targetDir, fileName);
  }
  // 最后一道闸：无论 fileName 来自哪里，落点必须在 sessions 根之下
  if (!isInside(sessionsRoot(), target)) throw new Error('会话落点越界，拒绝写入');
  // 记下「这个目录原来在不在」：失败收尾时只删自己建的那个，restore 已存在的目录不能动。
  const dirExisted = fs.existsSync(targetDir);
  fs.mkdirSync(targetDir, { recursive: true });
  // 只有「覆盖本机这份」这条明确选择的路径可以写已存在的文件。
  // 判据用 `wx` 一次成型，不用 existsSync：查到「不存在」到真正写下去之间有一段空档，
  // 而这条判据的本意就是「不许覆盖别人的东西」——判据自己留着 TOCTOU 就白写了。
  let claimed = false;
  if (conflictResolved !== 'overwrite') {
    let handle;
    try {
      handle = fs.openSync(target, 'wx');
    } catch (error) {
      if (error?.code === 'EEXIST') throw new Error('目标位置已有同名会话文件，拒绝覆盖');
      throw error;
    }
    fs.closeSync(handle);
    claimed = true;
  }
  // 先回填附件对象，再体检：体检要判「引用的对象在不在本机」，对象库得先就位，
  // 否则包里自带的图会被自己判成缺失、白白换成占位文字。失败不抛错（包可能天生就缺）。
  // claim 一旦成功，从这里到写盘完成之间的任何一步抛错都会留下一个 0 字节的
  // `session.v4.jsonl.zstd`：重试被 wx 判成「已存在」→ 409 假冲突，用户以为打不开。
  // 所以整段包进 try，catch 里把空壳收掉。
  let attached;
  let biliAttached;
  let repaired;
  let contextReport;
  try {
    attached = restoreAttachments(entries);
    // 只回填本来那个会话的状态：relocate / copy 换过 id 之后，写进新槽位等于
    // 把原会话的折叠进度复制一份过去，而写回原槽位又会覆盖别人的东西。
    biliAttached =
      String(id) === String(original.id)
        ? restoreBili(entries, id, backupWanted)
        : { written: 0, skipped: 1, rejected: 0, reason: 'renamed' };

  // 打开前体检：坏行、断链的图会让 DSH 一打开就报错，能确定坏的就地修掉再落盘。
  // 导入是一次性迁移，这一刀不修，用户下次还得手动来一遍。
  repaired = repairSession(finalBuf);
  finalBuf = repaired.buffer;

  // 上下文预算：上面那个 repair 只修坏行和断链，不改体量。一条 86 MB 的会话换算下来
  // 是两千多万 token，带进上下文等于把模型堵死，所以超预算时从尾部保留完整 turn。
  const contextBefore = estimateContext(finalBuf);
  const budgetRaw =
    options.contextBudget === undefined ? CONTEXT_BUDGET_TOKENS : Number.parseInt(String(options.contextBudget), 10);
  let contextTrim;
  if (Number.isFinite(budgetRaw) && budgetRaw > 0 && contextBefore.tokens > budgetRaw) {
    const trimmed = trimSession(finalBuf, { budget: budgetRaw });
    finalBuf = trimmed.buffer;
    contextTrim = trimmed.report;
  }
  contextReport = { before: contextBefore, trim: contextTrim };

  // 原子写：先写同目录的临时文件再 rename。直接用 writeFileSync 的话，写到一半崩了
  // 就在 sessions/ 下留半个会话文件，DSH 下次读到它只会报一句莫名其妙的解析错。
    writeAtomic(target, finalBuf, { createDir: true });
  } catch (error) {
    // 上面刚用 wx 建过一个空壳，写失败就把它收掉；只删自己建的那个（claimed 且确实是空文件）
    if (claimed === true) {
      try {
        if (fs.statSync(target).size === 0) fs.rmSync(target, { force: true });
      } catch {
        /* ignore */
      }
    }
    // 目录是这次建的就一并收掉：留着会被 findExisting 当成「本机已有这个会话」，
    // 后续走 reuse 分支拿着一个不存在的文件继续。
    if (dirExisted !== true) {
      try {
        fs.rmdirSync(targetDir);
      } catch {
        /* 非空（别人的会话在里面）或已被删，都不该强删 */
      }
    }
    throw error;
  }

  let memoryWritten = 0;
  let memorySkipped = 0;
  const memoryConflicts = [];
  // 没写进去的新文件单独记。它和 memoryConflicts（覆盖了的）语义相反，混用会让界面把
  // 「没写」显示成「已覆盖」——那正是这一轮要修的误解源头。
  const memoryCreated = [];
  // 四态：'copy'（默认）落副本、'restore'（用户显式合并）只覆盖本机已有、'new'（合并并新建）
  // 连本机没有的一起落原名、其余（undefined/false）不碰记忆。
  const memoryMode =
    options.memory === 'restore'
      ? 'restore'
      : options.memory === 'new'
        ? 'new'
        : options.memory === 'copy'
          ? 'copy'
          : undefined;
  // 清单给界面用：所有记忆条目 + 本机是否已有同名文件。copy 模式也要给——界面第一次导入
  // 拿到的就是 copy 的返回体，没有清单它就没法在合并前列出「将覆盖 / 将新建」。
  let memoryPlanned = [];
  const prefix = 'memory/workspaces/';
  const memoryKeys = [...entries.keys()].filter((name) => name.startsWith(prefix));
  let memoryDir;
  // 包内的记忆属于「打包方那个工作区」：条目名第一段就是它的 slug。与本次落点的 slug
  // 不同时，restore 写进的是另一个工区的记忆目录 —— 界面必须说出来，否则「合并记忆」
  // 看起来像写进眼前这个项目，实际落在别人的项目笔记里。
  let memoryForeign = false;
  let memoryForeignSlug;
  if (memoryKeys.length > 0 && memoryMode !== undefined) {
    const memory = memoryDirFor(cwd);
    memoryDir = memory.dir;
    const packageSlugs = new Set(
      memoryKeys.map((key) => key.slice(prefix.length).split(/[\\/]+/).filter((part) => part !== '')[0] ?? ''),
    );
    for (const slug of packageSlugs) {
      if (slug !== memory.slug) {
        memoryForeign = true;
        memoryForeignSlug = memoryForeignSlug ?? slug;
      }
    }
    const stamp = new Date().toISOString().slice(0, 10);
    // 先把所有落点算完再写：任意一条越界都整包拒绝，不给「写了一半」留机会
    const planned = [];
    for (const key of memoryKeys) {
      // 反斜杠也是分隔符；第一段是包里记录的 slug，落点由本机解析，所以丢掉它
      const segments = key.slice(prefix.length).split(/[\\/]+/).filter((part) => part !== '');
      const rel = segments.slice(1).join('/');
      if (rel === '') continue;
      // 默认（copy）永不落到原名上。manifest.parts 的 sha256 是打包方自己算的，只能证明
      // 「包内自洽」，证明不了「打包的人可信」——所以包里的记忆内容一律降级成带来源后缀
      // 的副本：DSH 不会把它当记忆读，静默投毒变成可见文件。
      // restore 是用户看过提示后显式点的「合并」，只有这条路才落原名，且覆盖前先备份。
      // 落点一律由 safeJoin 算，exists 也必须拿同一个落点去判——用 path.join 裸拼等于
      // 自己新开一条穿越面。existed 只用来给界面列清单，不是「可信所以能落原名」的判据。
      const native = safeJoin(memory.dir, rel);
      planned.push({
        rel,
        existed: fs.existsSync(native),
        dest:
          memoryMode === 'restore' || memoryMode === 'new'
            ? native
            : safeJoin(memory.dir, withSuffix(rel, `.from-dsproj-${stamp}`)),
        data: entries.get(key),
      });
    }
    memoryPlanned = planned.map((item) => ({ rel: item.rel, exists: item.existed }));
    for (const item of planned) {
      const { rel, dest, data } = item;
      // 这里**不许**预先建目录：restore 模式碰到「本机没有这个文件」是直接跳过的，
      // 预建会留下一个空目录（实测 handoff/ 被建出来，里面一个文件都没有）。
      // 父目录放到真正要写的分支里再建——「不写」就必须一点副作用都没有。
      // 落点已被占用时两种模式的处理不同：
      //   copy    —— 内容相同就幂等跳过，不同就换下一个序号（绝不覆盖别人的文件）
      //   restore —— 内容相同就幂等跳过（重复点「合并」不产生一堆 .bak），不同就先备份再覆盖
      let target = dest;
      let attempt = 0;
      let wrote = false;
      let skipped = false;
      let backup;
      while (attempt <= 50) {
        let existing;
        try {
          existing = fs.readFileSync(target);
        } catch {
          existing = undefined; // 文件不存在
        }
        if (existing !== undefined) {
          if (existing.equals(data)) {
            memorySkipped += 1;
            skipped = true;
            break;
          }
          if (memoryMode === 'copy') {
            attempt += 1;
            target = `${dest}-${attempt}`;
            continue;
          }
          // 备份名是拼出来的路径，同样过 safeJoin；撞名就换序号重试。
          // 勾掉「覆盖前先备份」时不建备份，直接覆盖原文件。
          const backupDest =
            backupWanted === true ? safeJoin(memory.dir, `${rel}.bak-${Date.now()}-${attempt}`) : undefined;
          // 备份文件和被覆盖的文件都在记忆目录里，父目录必须先存在（放在备份之前，
          // 否则 copyFileSync 会以 ENOENT 失败，被下面的 catch 记成「写不进去」）。
          if (backupDest !== undefined) fs.mkdirSync(path.dirname(backupDest), { recursive: true });
          fs.mkdirSync(path.dirname(target), { recursive: true });
          try {
            if (backupDest !== undefined) fs.copyFileSync(target, backupDest, fs.constants.COPYFILE_EXCL);
            fs.writeFileSync(target, data);
            backup = backupDest;
            wrote = true;
            break;
          } catch (error) {
            if (error?.code === 'EEXIST') {
              attempt += 1;
              continue;
            }
            // 备份或覆盖失败不拖垮整包：记下来当作跳过，让用户知道哪条没成。
            memoryConflicts.push({ rel, backup: undefined, error: String(error?.message ?? error) });
            skipped = true;
            break;
          }
        } else {
          // restore 的语义是「合并」：只覆盖本机已经存在的文件，不新建。
          // 否则攻击者只要挑本机不存在的路径（handoff/evil.md、当天日期日志），就能绕开
          // 确认弹窗静默落原名——那正是 R4 要断的注入链。这里必须干净地 break：
          // 往下走会掉进 while 重试，最后抛「记忆副本重名太多」这种完全不对的错误。
          if (memoryMode === 'restore') {
            memorySkipped += 1;
            memoryCreated.push(rel);
            // 必须同时把本地标记置上：下面的 `!wrote && !skipped` 判据只看这两个变量，
            // 只加计数不置标记会被当成「重名写不进去」，抛一句完全不对的错误。
            skipped = true;
            break;
          }
          try {
            // 走到这里才是真的要写：父目录此刻才建（copy 落副本、new 落原名都在这条）
            fs.mkdirSync(path.dirname(target), { recursive: true });
            // wx：存在就失败。existsSync 与 write 之间的空档也不给穿越/覆盖用
            fs.writeFileSync(target, data, { flag: 'wx' });
            wrote = true;
            break;
          } catch (error) {
            if (error?.code !== 'EEXIST') throw error;
            attempt += 1;
            // copy 换下一个序号；new 要的就是原名，重读一次再走「备份 + 覆盖」分支
            if (memoryMode === 'copy') target = `${dest}-${attempt}`;
          }
        }
      }
      if (!wrote && !skipped) throw new Error(`记忆副本重名太多，放弃写入：${rel}`);
      if (wrote) {
        // copy 模式换过序号记一条字符串（老形状，前端只用来数个数）；
        // restore 模式记 { rel, backup }，前端要把备份路径显示给用户。
        if (backup !== undefined) memoryConflicts.push({ rel, backup });
        else if (attempt > 0) memoryConflicts.push(rel);
        memoryWritten += 1;
      }
    }
  }

  return commitSource({
    sessionId: id,
    cwd,
    target,
    renamed,
    replacedId: renamed ? original.id : undefined,
    conflictResolved,
    originalCwd: original.cwd,
    title: readTitle(finalBuf),
    stats: readStats(finalBuf),
    memoryWritten,
    memorySkipped,
    attachmentsWritten: attached.written,
    attachmentsSkipped: attached.skipped,
    attachmentsRejected: attached.rejected,
    bili: biliAttached,
    // 打开前的体检结论：改了什么、还剩什么。changed=false 说明这个包本身是干净的。
    repair: repaired.report,
    context: contextReport,
    packageRepair,
    memoryConflicts,
    // 「本机没有、这次没写」的那批。界面据此提醒「有东西没写」，和 memoryConflicts 分开用。
    memoryCreated,
    // 执行前的清单：[{ rel, exists }]。copy 模式也返回，界面靠它渲染「将覆盖 / 将新建」。
    memoryPlanned,
    // 这次写的是不是另一个工区的记忆：true 时界面必须直说，别让「合并记忆」
    // 看起来像写进当前打开的工作区。
    memoryForeign,
    memoryForeignSlug,
    // 记忆落点目录（服务端按 cwd 解析出来的，不是请求里带来的路径），前端「打开记忆目录」用。
    memoryDir,
    memoryMode: memoryMode ?? 'none',
    sourcePath,
    cloud: cloudMarkOf(sourcePath),
    packageLock,
    packageLockBlocked: lockBlocks(packageLock),
  }, id, sourcePath);
}

/* ───────────────────────── 自动保存 ───────────────────────── */

/** Sessions with a save already queued/running, so steps do not pile up. */
const autosaveTimers = new Map();
const autosaveBusy = new Set();

/**
 * Write the remembered package for one session, silently.
 * Autosave never opens a dialog: no remembered path means nothing to update.
 */
async function autosaveOnce(sessionId) {
  if (autosaveBusy.has(sessionId)) return;
  const state = readState();
  if (state.autosave?.[sessionId] !== true) return;
  const target = state.paths?.[sessionId];
  if (typeof target !== 'string' || target === '') { return; }
  const sessionFile = findSessionFile(sessionId);
  if (sessionFile === undefined) { return; }

  autosaveBusy.add(sessionId);
  try {
    const buf = fs.readFileSync(sessionFile);
    let header;
    try {
      header = readHeader(buf);
    } catch {
      header = undefined;
    }
    const existingLock = fs.existsSync(target) ? lockOfFile(target) : undefined;
    const blocked = lockBlocks(existingLock);
    if (blocked !== undefined) { return; }

    // 记住的位置上文件已经没了（被删、被移走、磁盘没挂上）→ 停掉自动保存并记下来。
    // 绝不能让它在这个位置重新造一份：用户下次打开的是自己以为还在的旧包，
    // 而自动保存已经悄悄另起了一个新文件。
    if (!fs.existsSync(target)) {
      delete state.autosave[sessionId];
      state.missing = state.missing && typeof state.missing === 'object' ? state.missing : {};
      state.missing[sessionId] = { path: target, detectedAt: new Date().toISOString() };
      writeState(state);
      return;
    }

    // 文件已被别处改过 → 停掉自动保存，别把别人的版本盖掉
    const stale = staleOf(state, sessionId, target);
    if (stale !== undefined) {
      delete state.autosave[sessionId];
      state.stale = state.stale && typeof state.stale === 'object' ? state.stale : {};
      state.stale[sessionId] = {
        path: target,
        detectedAt: new Date().toISOString(),
        cloud: cloudMarkOf(target),
        ...stale,
      };
      writeState(state);
      return;
    }

    const lock = makeLock(sessionId, existingLock);
    // 只有用户主动要（Alt 点击 / ?memory=1）才把工作区记忆一起打包。
    const out = buildPackage(sessionFile, buf, header, readStats(buf), lock, { includeMemory: false });
    withSidecarLock(target, () => {
      writeAtomic(target, out.zip, { createDir: false });
    });
    state.stamps = state.stamps && typeof state.stamps === 'object' ? state.stamps : {};
    state.stamps[sessionId] = { path: target, sha256: cryptoHash(out.zip), at: new Date().toISOString() };
    if (state.stale !== undefined && typeof state.stale === 'object') delete state.stale[sessionId];
    if (state.missing !== undefined && typeof state.missing === 'object') delete state.missing[sessionId];
    writeState(state);
  } catch (error) {
    // 目标目录在检查之后消失了（U 盘拔出、网络盘掉线）：不能只吞掉，
    // 否则每一步都失败一次、用户永远等不到那份自动保存，也不知道为什么。
    if (error?.code === 'ENOENT' || String(error?.message ?? '').includes('目标目录不存在')) {
      try {
        const fresh = readState();
        if (fresh.autosave?.[sessionId] === true) {
          delete fresh.autosave[sessionId];
          fresh.missing = fresh.missing && typeof fresh.missing === 'object' ? fresh.missing : {};
          fresh.missing[sessionId] = { path: target, detectedAt: new Date().toISOString() };
          writeState(fresh);
        }
      } catch {
        /* 状态写不进去就算了，反正不会静默造文件 */
      }
    }
    /* 其余自动保存失败不打扰用户，下一次 step 会重试 */
  } finally {
    autosaveBusy.delete(sessionId);
  }
}

/** Coalesce a burst of step endings into one write. */
function scheduleAutosave(sessionId) {
  if (autosaveTimers.has(sessionId)) return;
  const timer = setTimeout(() => {
    autosaveTimers.delete(sessionId);
    void autosaveOnce(sessionId);
  }, AUTOSAVE_DELAY_MS);
  if (typeof timer?.unref === 'function') timer.unref();
  autosaveTimers.set(sessionId, timer);
}

async function handleAutosave(request) {
  const gate = requestGate(request);
  if (gate !== undefined) return jsonResponse({ status: 'error', message: gate }, 403);

  const url = new URL(request.url);
  const query = Object.fromEntries(url.searchParams);
  const sessionId = (query.sessionId ?? '').trim();
  if (sessionId === '') return jsonResponse({ status: 'error', message: 'missing sessionId' }, 400);
  if (!isSessionId(sessionId)) {
    return jsonResponse({ status: 'error', message: 'sessionId 形态不对' }, 400);
  }

  const state = readState();
  state.autosave = state.autosave && typeof state.autosave === 'object' ? state.autosave : {};

  if (query.enabled === undefined) {
    return jsonResponse({
      status: 'ok',
      sessionId,
      enabled: state.autosave[sessionId] === true,
      path: state.paths[sessionId],
      cloud: cloudMarkOf(state.paths[sessionId]),
      stale: state.stale?.[sessionId],
      missing: state.missing?.[sessionId],
    });
  }

  const enabled = query.enabled === '1' || query.enabled === 'true';
  if (enabled) state.autosave[sessionId] = true;
  else delete state.autosave[sessionId];
  writeState(state);

  if (enabled) scheduleAutosave(sessionId);
  return jsonResponse({
    status: 'ok',
    sessionId,
    enabled,
    path: state.paths[sessionId],
    cloud: cloudMarkOf(state.paths[sessionId]),
  });
}

/* ───────────────────────── 路由 ───────────────────────── */

/**
 * 路由自带的首道校验：只接受本机回环地址来的请求。
 *
 * 宿主（`dsh-client-connection`）已经有 Host/Origin fence，但它在 `Origin` 缺失时直接放行，
 * 而且一旦 `trustedHosts` 放宽或把 DSH 挂到反代后面，那层就没了 —— 上面那几个洞都会变成远程可利用。
 * 单元测试要构造真实 `Request` 再调 handler；拿不到 headers 一律拒绝 ——
 * 「默认放行」等于给未来的调用路径留后门。
 * @returns 拒绝原因，或 undefined 表示放行
 */
function requestGate(request) {
  const headers = request?.headers;
  if (headers === undefined || headers === null || typeof headers.get !== 'function') {
    return '请求没有可用的 headers，无法校验来源';
  }
  // 浏览器一定带 Host；undici 之类的调用端可能没带，这时退回看请求 URL 的主机名，
  // 两者都拿不到才算不合格。
  const urlHost = (() => {
    try {
      return new URL(String(request?.url ?? '')).host;
    } catch {
      return '';
    }
  })();
  // 一次性把要用的三个头读出来：headers.get 本身可能抛（畸形 request 或自定义 Headers 实现），
  // 抛出会一路冒到宿主，让整个请求变成 reject —— 这里必须就地兜住，退回「拒绝」。
  let rawHost;
  let rawOrigin;
  let rawSite;
  try {
    rawHost = headers.get('host');
    rawOrigin = headers.get('origin');
    rawSite = headers.get('sec-fetch-site');
  } catch {
    return '请求头读不出来，拒绝处理';
  }
  const host = String(rawHost ?? '').toLowerCase() || urlHost.toLowerCase();
  if (host === '') return '请求缺少 Host';
  // `::1` 这种裸 IPv6 里全是冒号：`replace(/:\d+$/, '')` 会把它切成 `:`，
  // 于是「只接受回环」的判据把合法请求也挡了。先按 [v6]:port 的形态剥，再按 host:port 剥。
  const hostName = (() => {
    if (host.startsWith('[')) {
      const close = host.indexOf(']');
      return close === -1 ? host : host.slice(1, close);
    }
    const colon = host.lastIndexOf(':');
    if (colon !== -1 && host.indexOf(':') === colon) return host.slice(0, colon);
    return host;
  })();
  const loopback = (value) =>
    value === '127.0.0.1' || value === 'localhost' || value === '::1' || value === '[::1]';
  if (!loopback(hostName)) return '只接受本机回环地址的请求';
  const origin = rawOrigin;
  if (origin !== null && origin !== undefined && origin !== '') {
    let parsed;
    try {
      parsed = new URL(String(origin));
    } catch {
      return 'Origin 无法解析';
    }
    if (!loopback(parsed.hostname.toLowerCase())) return 'Origin 不是本机地址';
    if (parsed.host.toLowerCase() !== host) return 'Origin 与 Host 不一致';
  }
  if (String(rawSite ?? '') === 'cross-site') return '拒绝跨站请求';
  return undefined;
}

/** 允许写入的目录：上次保存目录 + 已记住的每个工程文件所在目录。 */
function saveRootsOf(state) {
  const roots = new Set();
  const push = (dir) => {
    if (typeof dir === 'string' && dir !== '') roots.add(path.resolve(dir));
  };
  push(state?.lastDir);
  for (const value of Object.values(state?.paths ?? {})) {
    if (typeof value === 'string' && value !== '') push(path.dirname(value));
  }
  return [...roots];
}

/** 这个文件是不是本插件写出的工程包（覆盖已有文件前必须成立）。 */
function isDsprojFile(file) {
  // 只看文件尾部：EOCD → 中央目录 → 条目名。以前把 fs.readFileSync 整个文件读进来再判大小，
  // 带附件的大包（配额上限 128 MB）会被 `stat.size > MAX_ENTRY_BYTES` 直接判成「不是工程包」，
  // 于是「覆盖」这条路径对着自己的大包报 not-dsproj。
  let fd;
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size < 22) return false;
    fd = fs.openSync(file, 'r');
    const tailLen = Math.min(stat.size, 66 * 1024);
    const tail = Buffer.alloc(tailLen);
    fs.readSync(fd, tail, 0, tailLen, stat.size - tailLen);
    const eocd = tail.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    if (eocd === -1 || eocd + 22 > tail.length) return false;
    const cdSize = tail.readUInt32LE(eocd + 12);
    const cdOffset = tail.readUInt32LE(eocd + 16);
    if (cdSize === 0 || cdOffset + cdSize > stat.size || cdSize > 16 * 1024 * 1024) return false;
    const cd = Buffer.alloc(cdSize);
    fs.readSync(fd, cd, 0, cdSize, cdOffset);
    let p = 0;
    while (p + 46 <= cd.length && cd.readUInt32LE(p) === 0x02014b50) {
      const nameLen = cd.readUInt16LE(p + 28);
      const extraLen = cd.readUInt16LE(p + 30);
      const commentLen = cd.readUInt16LE(p + 32);
      const name = cd.toString('utf8', p + 46, p + 46 + nameLen);
      if (name === 'manifest.json') return true;
      if (/^session\/.+\.jsonl(\.zstd)?$/.test(name)) return true;
      p += 46 + nameLen + extraLen + commentLen;
    }
    return false;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        /* 关不掉就算了，进程退出会回收 */
      }
    }
  }
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

async function handleSave(request) {
  const gate = requestGate(request);
  if (gate !== undefined) return jsonResponse({ status: 'error', message: gate }, 403);

  const url = new URL(request.url);
  const query = Object.fromEntries(url.searchParams);
  const sessionId = (query.sessionId ?? '').trim();
  if (sessionId === '') return jsonResponse({ status: 'error', message: 'missing sessionId' }, 400);
  if (!isSessionId(sessionId)) {
    return jsonResponse({ status: 'error', message: 'sessionId 形态不对' }, 400);
  }

  const sessionFile = findSessionFile(sessionId);
  if (sessionFile === undefined) {
    return jsonResponse({ status: 'error', message: `找不到会话日志：${sessionId}` }, 404);
  }

  let buf;
  try {
    buf = fs.readFileSync(sessionFile);
  } catch (error) {
    return jsonResponse({ status: 'error', message: `读取会话日志失败：${error?.message ?? error}` }, 500);
  }

  let header;
  try {
    header = readHeader(buf);
  } catch {
    header = undefined;
  }

  const state = readState();
  const roots = saveRootsOf(state);
  const forceAsk = query.ask === '1' || query.mode === 'dialog';
  const force = query.force === '1' || query.force === 'true';
  // 覆盖前要不要留一份原文件；默认留。与导入侧同名同义。
  const backupWanted = query.backup !== '0' && query.backup !== 'false';
  // ignoreLock 只跳过「别的窗口正在写」这一条，stale / confirm-overwrite / not-dsproj
  // 三条照旧——那些防的是内容丢失，不是并发。
  const ignoreLock = query.ignoreLock === '1' || query.ignoreLock === 'true';
  // 记住的文件不见了之后，用户明确点了「就在这里重新建一份」才允许落盘。
  const recreate = query.recreate === '1' || query.recreate === 'true';
  const includeMemory = query.memory === '1' || query.memory === 'true';
  const explicitRaw = typeof query.path === 'string' && query.path.trim() !== '' ? query.path.trim() : null;
  const remembered = state.paths[sessionId];
  const rememberedAbs = typeof remembered === 'string' && remembered !== '' ? path.resolve(remembered) : undefined;
  const suggested = () => suggestPath(sessionId, header, state, readTitle(buf));

  let target = null;
  let fromDialog = false;
  let reusedRemembered = false;

  if (explicitRaw !== null) {
    const abs = path.resolve(explicitRaw);
    // HTTP 传来的路径只能落在已知目录里（上次保存目录、已记住的工程所在目录）。
    // 想存到新地方只有一条路：走原生另存为窗口，由用户自己点。
    if (!isInsideAny(abs, roots)) {
      return jsonResponse(
        { status: 'need-path', suggested: suggested(), message: '仅可保存到已使用的目录，或通过另存为窗口指定位置' },
        400,
      );
    }
    target = abs;
  } else if (!forceAsk && rememberedAbs !== undefined) {
    target = rememberedAbs;
    reusedRemembered = true;
  }

  if (target === null) {
    const picked = await nativeSaveDialog(suggested());
    if (picked === undefined) return jsonResponse({ status: 'need-path', suggested: suggested() });
    if (picked === null) return jsonResponse({ status: 'cancelled' });
    target = path.resolve(picked);
    fromDialog = true; // 用户自己在窗口里点了「保存」，覆盖是同意的
  } else if (typeof query.dir === 'string' && query.dir !== '') {
    const dir = path.resolve(query.dir);
    if (!roots.includes(dir)) {
      return jsonResponse({ status: 'error', message: '不允许写入这个目录' }, 400);
    }
    if (!path.isAbsolute(target)) target = path.join(dir, target);
    if (!isInsideAny(target, roots)) {
      return jsonResponse({ status: 'error', message: '不允许写入这个位置' }, 400);
    }
  }

  // 落盘前先判文件名（必须在补扩展名之前：`x.dsproj.` 补完会变成 `x.dsproj..dsproj`，
  // 把「尾点」这个错误藏进一个更难看的名字里）。来自另存为窗口的路径是用户自己选的，跳过。
  if (!fromDialog) {
    try {
      assertWritableName(target);
    } catch (nameError) {
      return jsonResponse(
        {
          status: 'bad-name',
          name: path.basename(target),
          message: `这个文件名不能用：${nameError?.message ?? nameError}`,
        },
        400,
      );
    }
  }

  if (!/\.dsproj$/i.test(target)) target = `${target}.dsproj`;
  if (!isInsideAny(target, roots) && !fromDialog) {
    return jsonResponse({ status: 'error', message: '不允许写入这个位置' }, 400);
  }

  // 复用「记住的路径」时必须确认那个文件还在。
  // 这条路径是默认保存路径，用户点一下按钮就落盘，中间没有任何确认机会 ——
  // 文件被删、被移到别的盘、U 盘没插、网络盘没挂上时，旧行为是直接在同名位置
  // 造一个全新的包：用户以为在更新原来那份，实际原来那份早已不在，新包也没人打开过。
  if (reusedRemembered && !recreate && !fs.existsSync(target)) {
    return jsonResponse(
      {
        status: 'missing-target',
        path: target,
        name: path.basename(target),
        dir: path.dirname(target),
        suggested: suggested(),
        message: '上次保存的文件不存在（已被删除、移动，或所在磁盘未挂载）。',
      },
      409,
    );
  }

  // 锁先判：文件里带着别人正在写的锁时，比「要不要覆盖」更该先说。
  const existingLock = fs.existsSync(target) ? lockOfFile(target) : undefined;
  if (!force && !ignoreLock) {
    let blocked = lockBlocks(existingLock);
    if (blocked !== undefined) {
      // 另一个进程正在写同一个文件，通常几十到几百毫秒就结束了。先替用户等一等，
      // 别一上来就甩一句「被占用」让人自己再点一次——他根本不知道「占用」是什么。
      for (let attempt = 0; attempt < 6; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 150));
        const retryLock = fs.existsSync(target) ? lockOfFile(target) : undefined;
        blocked = lockBlocks(retryLock);
        if (blocked === undefined) break;
      }
    }
    if (blocked !== undefined) {
      // 用户可以选择「仍然保存」：带 ignoreLock=1 再请求一次，跳过锁判定。
      // 只跳锁，不跳 stale / confirm-overwrite / not-dsproj——那几条防的是丢数据。
      return jsonResponse({ status: 'locked', canIgnoreLock: true, path: target, lock: existingLock, message: `${blocked}；等它存完之后再点一次，或把那个窗口关掉。` }, 409);
    }
  }

  // 覆盖一个「不是本会话记住的那个文件」：必须是明确的 force，而且它得是本插件的工程包。
  // 否则一次请求就能把用户桌面上的任意 .dsproj（或其他同名文件）换成我们的内容。
  const overwritingForeign = fs.existsSync(target) && target !== rememberedAbs && !fromDialog;
  if (overwritingForeign === true) {
    if (!force) {
      return jsonResponse(
        {
          status: 'confirm-overwrite',
          path: path.basename(target),
          message: '该位置已存在文件，覆盖将丢失其内容',
        },
        409,
      );
    }
    if (!isDsprojFile(target)) {
      return jsonResponse(
        { status: 'not-dsproj', path: path.basename(target), message: '目标文件不是 .dsproj 工程包，无法覆盖' },
        409,
      );
    }
  }

  // 磁盘内容是不是已经不是我们上次写的那份。这个判断有两个用处，别只留一个：
  //   ① 没带 force → 拦下来问（409）；
  //   ② 带了 force（界面上「覆盖磁盘文件」）→ 覆盖前要不要留 .bak。
  // 早先只在 ① 里算它，② 那处只看 overwritingForeign，结果「勾了备份、点了覆盖磁盘文件」
  // 一个 .bak 都不留——勾选框对这条路径等于摆设，别处同步过来的内容被直接抹掉。
  const stale = staleOf(state, sessionId, target);
  if (!force && stale !== undefined) {
    return jsonResponse(
      {
        status: 'stale',
        path: target,
        stale,
        cloud: cloudMarkOf(target),
        message: '磁盘内容与本机上次写入的版本不一致（可能来自另一台机器或同步盘）。',
      },
      409,
    );
  }

  const lock = makeLock(sessionId, existingLock);

  let out;
  try {
    out = buildPackage(sessionFile, buf, header, readStats(buf), lock, { includeMemory });
  } catch (error) {
    return jsonResponse({ status: 'error', message: `打包失败：${error?.message ?? error}` }, 500);
  }

  try {
    withSidecarLock(target, () => {
      // 覆盖「不是我们上次写的那份」之前先留一份：陌生文件（手滑点了覆盖）与
      // 磁盘内容已被别处改过（同步盘/另一台机器）都算，两条都由同一个 backup 开关控制。
      const overwrittenElsewhere = overwritingForeign === true || stale !== undefined;
      if (backupWanted === true && overwrittenElsewhere === true && fs.existsSync(target)) {
        try {
          fs.copyFileSync(target, `${target}.bak-${Date.now()}`);
        } catch {
          // 备份失败不挡写盘：写不进去比少一个备份更糟。
        }
      }
      writeAtomic(target, out.zip, { createDir: false });
    }, { ignoreLock });
  } catch (error) {
    // 侧车锁冲突以前直接冒到兜底 catch，变成 500 + 一句「写入失败」：用户既拿不到
    // canIgnoreLock 这个出口，也分不清是锁还是磁盘问题。现在统一成 409 locked。
    if (error?.code === 'DSH_LOCKED') {
      return jsonResponse(
        {
          status: 'locked',
          path: target,
          name: path.basename(target),
          lock: readSidecarLock(target),
          canIgnoreLock: true,
          message: error?.message ?? '这个文件正被另一个 DSH 写入',
        },
        409,
      );
    }
    // 目录在检查之后、写入之前消失了（U 盘拔出、网络盘掉线、父目录被删）。
    // 这时 writeAtomic 不会替我们建目录，报 ENOENT —— 同样不能含糊成一句「写入失败」。
    if (error?.code === 'ENOENT') {
      return jsonResponse(
        {
          status: 'missing-target',
          path: target,
          name: path.basename(target),
          dir: path.dirname(target),
          suggested: suggested(),
          message: '保存位置所在的目录不存在（磁盘未挂载或已被删除）。',
        },
        409,
      );
    }
    return jsonResponse({ status: 'error', message: `写入失败：${target} — ${error?.message ?? error}` }, 500);
  }

  const stat = fs.statSync(target);
  state.paths[sessionId] = target;
  state.lastDir = path.dirname(target);
  state.stamps = state.stamps && typeof state.stamps === 'object' ? state.stamps : {};
  state.stamps[sessionId] = { path: target, sha256: cryptoHash(out.zip), at: new Date().toISOString() };
  if (state.stale !== undefined && typeof state.stale === 'object') delete state.stale[sessionId];
  if (state.missing !== undefined && typeof state.missing === 'object') delete state.missing[sessionId];
  writeState(state);

  return jsonResponse({
    status: 'saved',
    path: target,
    name: path.basename(target),
    bytes: stat.size,
    savedAt: new Date(stat.mtimeMs).toISOString(),
    entries: out.entries.length,
    memoryFiles: out.manifest.memoryFiles.length,
    lock,
    cloud: cloudMarkOf(target),
    session: { id: header?.id ?? sessionId, cwd: header?.cwd, createdAt: header?.createdAt },
  });
}

/** 内置语言包目录：`locales/<tag>.json`，一个文件一种语言，谁都能加一份提 PR。 */
const LOCALES_URL = new URL('./locales/', import.meta.url);
const FALLBACK_LOCALE = 'zh-CN';

/** 列出现有的语言标签（文件名去 `.json`），排序后返回。 */
function listLocaleTags() {
  try {
    return fs
      .readdirSync(LOCALES_URL)
      .filter((name) => name.endsWith('.json'))
      .map((name) => name.slice(0, -5))
      .sort();
  } catch {
    return [];
  }
}

/** 读一份语言包；读不到或形状不对就返回 undefined（由调用方决定怎么报）。 */
function readLocaleMessages(tag) {
  try {
    const raw = fs.readFileSync(new URL(`./locales/${tag}.json`, import.meta.url), 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed !== null && typeof parsed === 'object' && Array.isArray(parsed) === false) return parsed;
  } catch {
    // 缺文件、坏 JSON、无权限都走同一条路：当成「没有这个语言包」。
  }
  return undefined;
}

/**
 * 把浏览器给的标签收拢到磁盘上真实存在的语言包：先精确匹配（`en-US`），
 * 再退到主语言（`en` → 第一条以 `en-` 开头的），最后回中文。
 * 只从目录清单里挑，绝不按请求里的字符串现拼路径——那等于让 URL 决定读哪个文件。
 */
function resolveLocaleTag(requested) {
  const tags = listLocaleTags();
  const wanted = String(requested ?? '').trim().replace(/_/g, '-');
  if (wanted !== '' && tags.includes(wanted)) return wanted;
  const primary = wanted.split('-')[0].toLowerCase();
  if (primary !== '') {
    const hit = tags.find((tag) => {
      const lower = tag.toLowerCase();
      return lower === primary || lower.startsWith(`${primary}-`);
    });
    if (hit !== undefined) return hit;
  }
  return tags.includes(FALLBACK_LOCALE) ? FALLBACK_LOCALE : (tags[0] ?? FALLBACK_LOCALE);
}

/**
 * 语言包下发。客户端拿不到时会用内置中文兜底，所以这条路由失败不影响插件可用，
 * 只是退化成「只有中文」。
 */
function handleLocales(request) {
  const gate = requestGate(request);
  if (gate !== undefined) return jsonResponse({ status: 'error', message: gate }, 403);
  const url = new URL(request.url);
  const available = listLocaleTags();
  const tag = resolveLocaleTag(url.searchParams.get('lang'));
  const messages = readLocaleMessages(tag);
  if (messages === undefined) {
    return jsonResponse(
      { status: 'error', message: '语言包读取失败', lang: tag, fallback: FALLBACK_LOCALE, messages: {}, available },
      500,
    );
  }
  // 不回显目录路径：客户端只需要标签和内容。
  return jsonResponse({ status: 'ok', lang: tag, fallback: FALLBACK_LOCALE, messages, available });
}

/** 侧栏「打开」按钮需要的工作区列表。 */
function handleWorkspaces(request) {
  const gate = requestGate(request);
  if (gate !== undefined) return jsonResponse({ status: 'error', message: gate }, 403);
  return jsonResponse({ status: 'ok', workspaces: readWorkspaces() });
}

/**
 * `?path=<file>` 直接导入；没有 path 时弹原生打开窗口。
 * 返回 { status:'opened', sessionId, ... } 供客户端跳转。
 */
async function handleOpen(request) {
  const gate = requestGate(request);
  if (gate !== undefined) return jsonResponse({ status: 'error', message: gate }, 403);

  const url = new URL(request.url);
  const query = Object.fromEntries(url.searchParams);
  const explicit = typeof query.path === 'string' && query.path.trim() !== '' ? query.path.trim() : null;
  const state = readState();

  let source = explicit === null ? null : path.resolve(explicit);
  if (source === null) {
    const picked = await nativeOpenDialog(state.lastDir ?? '');
    if (picked === undefined) return jsonResponse({ status: 'need-path' });
    if (picked === null) return jsonResponse({ status: 'cancelled' });
    source = path.resolve(picked);
  }

  // 打开只吃本插件的工程包：别的扩展名、或者扩展名对但内容不是包的文件，在他被
  // 当成 ZIP 解析之前就挡掉，免得一次请求就把任意路径喂进解包逻辑。
  if (!/\.dsproj$/i.test(source)) {
    return jsonResponse({ status: 'error', message: '只能打开 .dsproj 工程文件' }, 400);
  }
  if (!fs.existsSync(source)) {
    // 不回显绝对路径：请求里带来的路径不该出现在响应正文里。
    return jsonResponse({ status: 'error', message: '找不到这个文件（可能已被移动或删除）' }, 404);
  }

  try {
    const cwd = typeof query.cwd === 'string' && query.cwd.trim() !== '' ? query.cwd.trim() : undefined;
    const onConflict = typeof query.onConflict === 'string' ? query.onConflict : 'ask';
    // 记忆落盘方式：默认只落副本（安全默认）。restore 只覆盖本机已有文件；new 额外允许
    // 新建本机没有的文件。白名单只认精确字符串，别用 !== 'copy' 之类的兜底——多一个拼写
    // 就会悄悄变成「能写新文件」的通道。
    const memoryMode =
      query.memory === 'restore' ? 'restore' : query.memory === 'new' ? 'new' : 'copy';
    // createCwd=1 只在用户点了「在这里新建」时传：缺目录时插件自己建，
    // 不给这个位就等于「别替我动文件系统」。
    const createCwd = query.createCwd === '1' || query.createCwd === 'true';
    // replaceFile=1：目标位置被一个文件占着时，把它改名备份再建目录（不删）。
    // repairPackage=1：包校验不过时先摘掉坏条目再试一次，而不是直接判死。
    const replaceFile = query.replaceFile === '1' || query.replaceFile === 'true';
    const repairPackage = query.repairPackage === '1' || query.repairPackage === 'true';
    const backupWanted = query.backup !== '0' && query.backup !== 'false';
    const result = importPackage(source, { cwd, onConflict, memory: memoryMode, createCwd, replaceFile, repairPackage, backup: backupWanted, contextBudget: query.contextBudget });
    if (result.status === 'need-workspace') return jsonResponse(result);
    // 落点不合格：明确拒绝，不落到 process.cwd()。400 而不是 500——包没坏，是位置不对。
    if (result.status === 'bad-workspace') return jsonResponse(result, 400);
    // 包校验没过 / 包比插件新：都不是 200。沿用原来的 500，客户端按 status 字段决定弹哪个窗。
    if (result.status === 'package-broken' || result.status === 'newer-package') return jsonResponse(result, 500);
    if (result.conflict === true) return jsonResponse({ status: 'conflict', ...result }, 409);
    // 来源指纹已经在 importPackage 的成功路径末尾（commitSource）记过一次，这里不再写第二遍：
    // 这一步用的是打开之前读到的 state 快照，整表写回会把导入期间别的会话的键抹掉。
    return jsonResponse({
      status: 'opened',
      ...result,
      cloud: cloudMarkOf(source),
      warning: result.packageLockBlocked ?? undefined,
    });
  } catch (error) {
    // 同 V6：路径细节只进日志，不进响应正文。但「为什么打不开」这类不含路径的理由要带回去 ——
    // 否则用户只看到一句通用文案，分不清是包坏了、还是被哪条安全校验挡了。
    console.warn('[dsh-session-save] 打开失败', source, error);
    const raw = String(error?.message ?? '');
    // 累计解压超限：包没坏，只是太大。别再让它混进「不是有效的工程包」那句里 ——
    // 那句话会让用户去翻备份重存一份，而这份包一个字节都没坏。
    if (error?.code === 'E_LOG_TOO_LARGE') {
      return jsonResponse({ status: 'too-large', message: raw }, 413);
    }
    const leaksPath = raw === '' || raw.includes(source) || raw.includes(os.homedir()) || /[A-Za-z]:[\\/]/.test(raw);
    return jsonResponse(
      {
        status: 'error',
        message: leaksPath ? '这个文件打不开：不是有效的 .dsproj 工程包，或者权限不够' : `这个文件打不开：${raw}`,
      },
      500,
    );
  }
}

/**
 * Register the save route.
 * @param ctx - Host context carrying the browser connection.
 */
export function apply(ctx) {
  const connection = Reflect.get(ctx, 'connection');
  if (connection === undefined) return;
  connection.fetch.register({
    path: ROUTE,
    methods: ['GET', 'POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      try {
        return await handleSave(request);
      } catch (error) {
        // 500 一律给固定文案：异常原文里常带绝对路径、主机名、内部模块名，
        // 而这条响应会原样进浏览器。要区分业务原因请走 `status` 字段。
        ctx.logger?.warn?.('[dsh-session-save] save route failed', error);
        return jsonResponse({ status: 'error', message: '内部错误，详见日志' }, 500);
      }
    },
  });
  connection.fetch.register({
    path: OPEN_ROUTE,
    methods: ['GET', 'POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      try {
        return await handleOpen(request);
      } catch (error) {
        ctx.logger?.warn?.('[dsh-session-save] open route failed', error);
        return jsonResponse({ status: 'error', message: '内部错误，详见日志' }, 500);
      }
    },
  });
  connection.fetch.register({
    path: WORKSPACES_ROUTE,
    methods: ['GET', 'POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      // 这条没有业务异常可抛，出错只会是读 storages/workspace.json 之类的基础故障；
      // 别让同步异常冒到宿主的路由分发器里（那会变成一个没人接的 500 + 一串栈）。
      try {
        return await handleWorkspaces(request);
      } catch (error) {
        ctx.logger?.warn?.('[dsh-session-save] workspaces route failed', error);
        return jsonResponse({ status: 'ok', workspaces: [] });
      }
    },
  });

  connection.fetch.register({
    path: LOCALES_ROUTE,
    methods: ['GET', 'POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      try {
        return handleLocales(request);
      } catch (error) {
        ctx.logger?.warn?.('[dsh-session-save] locales route failed', error);
        return jsonResponse({ status: 'error', message: '内部错误，详见日志' }, 500);
      }
    },
  });  connection.fetch.register({
    path: AUTOSAVE_ROUTE,
    methods: ['GET', 'POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      try {
        return await handleAutosave(request);
      } catch (error) {
        ctx.logger?.warn?.('[dsh-session-save] autosave route failed', error);
        return jsonResponse({ status: 'error', message: '内部错误，详见日志' }, 500);
      }
    },
  });

  // 每步结束 → 该会话若开了自动保存，合并后写回记住的文件
  if (typeof ctx.effect === 'function' && typeof ctx.on === 'function') {
    ctx.effect(
      () =>
        ctx.on('session/event', (session, event) => {
          const type = event?.type;
          if (type !== 'step/end' && type !== 'turn/end') return;
          const id = String(session?.id ?? '');
          if (id === '') return;
          scheduleAutosave(id);
        }),
      'session-save: autosave hook',
    );
  }
}
