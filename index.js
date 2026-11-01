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
  const parse = (text) =>
    String(text ?? '')
      .split('-')[0]
      .split('.')
      .map((part) => {
        const n = Number.parseInt(part, 10);
        return Number.isFinite(n) ? n : 0;
      });
  const left = parse(a);
  const right = parse(b);
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const x = left[i] ?? 0;
    const y = right[i] ?? 0;
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

const normSlug = (value) => String(value).toLowerCase().replace(/[^a-z0-9]/g, '');

/** Memory directories use one dash per separator; try both, then fuzzy-match. */
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
  const wanted = normSlug(cwd);
  for (const entry of names) {
    if (normSlug(entry) === wanted) return { slug: entry, dir: path.join(memoryRoot(), entry) };
  }
  return undefined;
}

/* ───────────────────────── 会话日志读取 ───────────────────────── */

/**
 * Split a concatenated zstd log into its frames.
 * @param buf - whole log file
 * @returns array of { start, end } frame bounds
 */
export function scanZstdFrames(buf) {
  const frames = [];
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
      if (type !== 1) p += size; // raw/rle blocks carry their payload
      if (p > buf.length) break;
      if (last) {
        if (checksum) p += 4;
        complete = true;
        break;
      }
    }
    if (!complete) break; // 末尾半写帧不计入
    frames.push({ start, end: Math.min(p, buf.length) });
  }
  return frames;
}

function readHeader(buf) {
  const frames = scanZstdFrames(buf);
  const slice = frames.length > 0 ? buf.subarray(frames[0].start, frames[0].end) : buf;
  const text = zlib.zstdDecompressSync(slice).toString('utf8');
  const nl = text.indexOf('\n');
  return JSON.parse(nl === -1 ? text : text.slice(0, nl));
}

/** Frame count and non-empty JSONL line count, mirroring what dshproj records. */
function readStats(buf) {
  const frames = scanZstdFrames(buf);
  let lines = 0;
  for (const frame of frames) {
    try {
      const text = zlib.zstdDecompressSync(buf.subarray(frame.start, frame.end)).toString('utf8');
      for (const line of text.split('\n')) if (line.trim() !== '') lines += 1;
    } catch {
      /* 单帧解压失败不影响打包 */
    }
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
const MAX_RATIO = 200;
/** 压缩比只在条目够大时才看，免得把小文本的正常压缩误判成炸弹。 */
const RATIO_FLOOR_BYTES = 4 * 1024 * 1024;

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
    if (usize > RATIO_FLOOR_BYTES && csize > 0 && usize / csize > MAX_RATIO) {
      throw new Error(`条目压缩比异常（约 ${Math.round(usize / csize)}:1），拒绝打开：${name}`);
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
  for (const frame of scanZstdFrames(buf)) {
    try {
      text += zlib.zstdDecompressSync(buf.subarray(frame.start, frame.end)).toString('utf8');
    } catch {
      /* 单帧解压失败不影响其余帧 */
    }
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
function restoreAttachments(entries) {
  let written = 0;
  let skipped = 0;
  let rejected = 0;
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
    try {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, data);
      written += 1;
    } catch {
      rejected += 1;
    }
  }
  return { written, skipped, rejected };
}

/** dest 是否严格落在 root 之内（root 自身不算）。用 relative 判前缀，别用字符串 startsWith。 */
function isInside(root, dest) {
  const rootAbs = path.resolve(root);
  const rel = path.relative(rootAbs, path.resolve(dest));
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
export function repairSession(buffer, options = {}) {
  const frames = scanZstdFrames(buffer);
  const report = {
    frames: { total: frames.length, broken: 0 },
    lines: { total: 0, dropped: 0 },
    parts: { total: 0, missing: 0, patched: 0, dropped: 0 },
    changed: false,
    notes: [],
  };
  if (frames.length === 0) return { buffer, report };

  const chunks = [];
  for (const frame of frames) {
    let text;
    try {
      text = zlib.zstdDecompressSync(buffer.subarray(frame.start, frame.end)).toString('utf8');
    } catch {
      report.frames.broken += 1;
      report.notes.push('有一帧日志解不开，原样保留');
      chunks.push(buffer.subarray(frame.start, frame.end));
      continue;
    }
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
  if (repaired.report.changed === true) writeAtomic(file, repaired.buffer);
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
function safeSegments(raw) {
  const text = String(raw ?? '');
  if (text === '') throw new Error('包内路径为空');
  if (text.startsWith('/') || text.startsWith('\\')) throw new Error(`包内路径是绝对路径：${text}`);
  if (/^[A-Za-z]:/.test(text)) throw new Error(`包内路径带盘符：${text}`);
  if (/[\u0000-\u001f\u007f]/.test(text)) throw new Error('包内路径含控制字符');
  const segments = [];
  for (const part of text.split(/[\\/]+/)) {
    if (part === '') continue;
    if (part === '.' || part === '..') throw new Error(`包内路径含越界段「${part}」：${text}`);
    segments.push(part);
  }
  if (segments.length === 0) throw new Error(`包内路径为空：${text}`);
  return segments;
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
    throw error;
  }
}

/**
 * 状态文件也必须原子写：自动保存与手动保存会并发读改写它，半截 JSON 会让
 * readState 整体回落成空状态 —— 表现就是「记住的保存路径全丢了」。
 */
function writeState(state) {
  try {
    writeAtomic(stateFile(), Buffer.from(JSON.stringify(state, null, 2), 'utf8'));
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
  if (Number.isFinite(at) && Date.now() - at < LOCK_STALE_MS) {
    return `这个文件正被 ${lock.host} 上的 DSH 使用（${lock.at}），可能还没存完`;
  }
  return undefined;
}

/**
 * Serialise writes to one package file across processes with a `.lock` sidecar.
 * A stale sidecar (dead pid on this host, or old on another host) is taken over.
 *
 * 锁文件里带一个随机 token：收尾时只在内容仍是这把锁时删除。
 * 以前无条件 unlink，判定稍微误一次就会把另一个进程正在用的锁删掉，两边同时写。
 */
function withSidecarLock(target, run) {
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
    fs.mkdirSync(path.dirname(sidecar), { recursive: true });
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
    const reason = lockBlocks({ ...holder, format: LOCK_FORMAT });
    if (reason !== undefined) throw new Error(`${reason}；稍后重试或删掉 ${sidecar}`);
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
function rewriteHeader(buf, patch) {
  const frames = scanZstdFrames(buf);
  if (frames.length === 0) throw new Error('会话日志里没有完整的 zstd 帧');
  const head = zlib.zstdDecompressSync(buf.subarray(frames[0].start, frames[0].end)).toString('utf8');
  const nl = head.indexOf('\n');
  const before = JSON.parse(nl === -1 ? head : head.slice(0, nl));
  const tail = nl === -1 ? '' : head.slice(nl);
  const header = { ...before, ...patch };
  const frame = zlib.zstdCompressSync(Buffer.from(JSON.stringify(header) + tail, 'utf8'), CHECKSUM_OPTIONS);
  const rest = frames.length > 1 ? buf.subarray(frames[1].start) : Buffer.alloc(0);
  return { buffer: Buffer.concat([frame, rest]), header, before };
}

/** The cwd a package should land in: the recorded one if it exists here, else this host's cwd. */
function landingCwd(preferred) {
  if (typeof preferred === 'string' && preferred !== '' && fs.existsSync(preferred)) return preferred;
  return process.cwd();
}

/** Latest `session/title` value in the log, for the toast. */
function readTitle(buf) {
  for (const frame of scanZstdFrames(buf)) {
    let text;
    try {
      text = zlib.zstdDecompressSync(buf.subarray(frame.start, frame.end)).toString('utf8');
    } catch {
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
];

/**
 * 内容条目：真正会被写进磁盘的东西（会话日志、工作区记忆）。
 * `parts` 只登记这两类（元数据条目 manifest/LOCK/SUMMARY 不登记），
 * 所以「必须在 parts 里声明过」这条只能对它们提要求。
 */
const CONTENT_ENTRY = /^(session\/|memory\/workspaces\/|attachments\/)/;

/**
 * 「这类条目是从哪个版本开始被认识的」。
 * 包没写 `plugin.version` 时（老包、别的工具拼的包），靠它反推写包方有多新，
 * 才能把「包里夹带了怪东西」和「你该升级插件了」分开说。
 * 新增一类顶层条目时，记得在这里加一行。
 */
const ENTRY_SINCE = [[/^attachments\//, '0.3.0']];

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
function verifyPackage(entries, manifest) {
  for (const name of entries.keys()) {
    if (!ENTRY_ALLOW.some((pattern) => pattern.test(name))) {
      throw new Error(unknownEntryMessage(name, manifest));
    }
  }
  const parts = manifest?.parts;
  if (parts === undefined || parts === null || typeof parts !== 'object') {
    // 老包/第三方包可能没有 parts：会话条目照旧放行（不然旧包全打不开），
    // 但记忆条目无法验证来源，一律拒绝。
    for (const name of entries.keys()) {
      if (name.startsWith('memory/workspaces/')) {
        throw new Error(`包内记忆条目缺少 manifest.parts，拒绝打开：${name}`);
      }
    }
    return;
  }
  for (const [name, meta] of Object.entries(parts)) {
    const data = entries.get(name);
    if (data === undefined) continue; // 旧包可能没带全，缺的条目按「没有」处理
    if (typeof meta?.sha256 === 'string' && cryptoHash(data) !== meta.sha256) {
      throw new Error(`包内条目校验失败（内容被改动过）：${name}`);
    }
    if (Number.isFinite(meta?.bytes) && data.length !== meta.bytes) {
      throw new Error(`包内条目体积不符：${name}`);
    }
  }
  // 内容条目必须在 parts 里声明过，否则等于绕过了上面的完整性校验
  for (const name of entries.keys()) {
    if (!CONTENT_ENTRY.test(name)) continue;
    if (!Object.prototype.hasOwnProperty.call(parts, name)) {
      throw new Error(`包内条目未在 manifest.parts 中声明，拒绝打开：${name}`);
    }
  }
}

/**
 * Unpack a `.dsproj` into this DSH_HOME and return the identity to open.
 * @param sourcePath - package file
 * @param options - { cwd?, memory?, onConflict? }
 */
function importPackage(sourcePath, options = {}) {
  const entries = zipRead(fs.readFileSync(sourcePath));
  const manifestEntry = entries.get('manifest.json');
  let manifest;
  if (manifestEntry !== undefined) {
    try {
      manifest = JSON.parse(manifestEntry.toString('utf8'));
    } catch {
      manifest = undefined;
    }
  }
  verifyPackage(entries, manifest);
  const sessionName = [...entries.keys()].find((name) => /^session\/.+\.jsonl(\.zstd)?$/.test(name));
  if (sessionName === undefined) throw new Error('包里没有会话日志（session/…）');
  const buf = entries.get(sessionName);
  const original = readHeader(buf);
  if (typeof original?.id !== 'string' || original.id === '') throw new Error('会话日志缺少 header');

  const explicitCwd = typeof options.cwd === 'string' && options.cwd !== '' ? options.cwd : undefined;
  const dirFor = (sessionId, targetCwd) => path.join(sessionsRoot(), projectKey(targetCwd), encodeSegment(sessionId));
  const mode = ['ask', 'reuse', 'overwrite', 'copy'].includes(options.onConflict) ? options.onConflict : 'ask';
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

  const cwd = landingCwd(explicitCwd ?? manifest?.session?.cwd ?? original.cwd);

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
    if (sameSession && sameCwd) {
      // 同一会话的另一份（同 id + 同 createdAt + 同工作区）→ 直接打开本机这份，不复制
      // 直接打开本机这份，也照样回填附件：用户很可能就是拿这个包来补上次没带过来的图
      const attachRestore = restoreAttachments(entries);
      const repairReport = repairInPlace(existing.file);
      const state = rememberSource(readState(), id, sourcePath);
      writeState(state);
      return {
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
        repair: repairReport,
        sourcePath,
        packageLock,
      };
    }

    if (sameSession) {
      // 同一会话，但要求落到别的工作区 → 就地再开一份，换新 id（id 必须全机唯一）
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
      const repairReport = repairInPlace(existing.file);
      const state = rememberSource(readState(), id, sourcePath);
      writeState(state);
      return {
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
        repair: repairReport,
        sourcePath,
        packageLock,
      };
    }

    if (mode === 'overwrite') {
      // 用包里的内容盖掉本机这份：同 id、同位置，旧文件留 .bak
      conflictResolved = 'overwrite';
      targetDir = existing.dir;
      target = existing.file;
      try {
        fs.copyFileSync(existing.file, `${existing.file}.bak-${Date.now()}`);
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
  fs.mkdirSync(targetDir, { recursive: true });
  // 只有「覆盖本机这份」这条明确选择的路径可以写已存在的文件
  if (conflictResolved !== 'overwrite' && fs.existsSync(target)) {
    throw new Error('目标位置已有同名会话文件，拒绝覆盖');
  }
  // 先回填附件对象，再体检：体检要判「引用的对象在不在本机」，对象库得先就位，
  // 否则包里自带的图会被自己判成缺失、白白换成占位文字。失败不抛错（包可能天生就缺）。
  const attached = restoreAttachments(entries);

  // 打开前体检：坏行、断链的图会让 DSH 一打开就报错，能确定坏的就地修掉再落盘。
  // 导入是一次性迁移，这一刀不修，用户下次还得手动来一遍。
  const repaired = repairSession(finalBuf);
  finalBuf = repaired.buffer;

  fs.writeFileSync(target, finalBuf);

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
  if (memoryKeys.length > 0 && memoryMode !== undefined) {
    const memory = memoryDirFor(cwd);
    memoryDir = memory.dir;
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
            : safeJoin(memory.dir, `${rel}.from-dsproj-${stamp}`),
        data: entries.get(key),
      });
    }
    memoryPlanned = planned.map((item) => ({ rel: item.rel, exists: item.existed }));
    for (const item of planned) {
      const { rel, dest, data } = item;
      fs.mkdirSync(path.dirname(dest), { recursive: true });
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
          const backupDest = safeJoin(memory.dir, `${rel}.bak-${Date.now()}-${attempt}`);
          try {
            fs.copyFileSync(target, backupDest, fs.constants.COPYFILE_EXCL);
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

  const state = rememberSource(readState(), id, sourcePath);
  writeState(state);

  return {
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
    // 打开前的体检结论：改了什么、还剩什么。changed=false 说明这个包本身是干净的。
    repair: repaired.report,
    memoryConflicts,
    // 「本机没有、这次没写」的那批。界面据此提醒「有东西没写」，和 memoryConflicts 分开用。
    memoryCreated,
    // 执行前的清单：[{ rel, exists }]。copy 模式也返回，界面靠它渲染「将覆盖 / 将新建」。
    memoryPlanned,
    // 记忆落点目录（服务端按 cwd 解析出来的，不是请求里带来的路径），前端「打开记忆目录」用。
    memoryDir,
    memoryMode: memoryMode ?? 'none',
    sourcePath,
    cloud: cloudMarkOf(sourcePath),
    packageLock,
    packageLockBlocked: lockBlocks(packageLock),
  };
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
  const hostName = host.replace(/:\d+$/, '');
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
  let buf;
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size < 22 || stat.size > MAX_ENTRY_BYTES) return false;
    buf = fs.readFileSync(file);
  } catch {
    return false;
  }
  if (buf.readUInt32LE(0) !== 0x04034b50) return false;
  try {
    const entries = zipRead(buf);
    if (entries.has('manifest.json')) return true;
    return [...entries.keys()].some((entry) => /^session\/.+\.jsonl(\.zstd)?$/.test(entry));
  } catch {
    return false;
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
        { status: 'need-path', suggested: suggested(), message: '只能存到用过的目录，或通过另存为窗口挑位置' },
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
        message: '上次保存的那个文件已经不在了（被删除、移走，或所在磁盘没挂上）。',
      },
      409,
    );
  }

  // 锁先判：文件里带着别人正在写的锁时，比「要不要覆盖」更该先说。
  const existingLock = fs.existsSync(target) ? lockOfFile(target) : undefined;
  if (!force) {
    const blocked = lockBlocks(existingLock);
    if (blocked !== undefined) {
      return jsonResponse({ status: 'locked', path: target, lock: existingLock, message: blocked }, 409);
    }
  }

  // 覆盖一个「不是本会话记住的那个文件」：必须是明确的 force，而且它得是本插件的工程包。
  // 否则一次请求就能把用户桌面上的任意 .dsproj（或其他同名文件）换成我们的内容。
  if (fs.existsSync(target) && target !== rememberedAbs && !fromDialog) {
    if (!force) {
      return jsonResponse(
        {
          status: 'confirm-overwrite',
          path: path.basename(target),
          message: '这个位置已经有一个文件，覆盖会丢掉它',
        },
        409,
      );
    }
    if (!isDsprojFile(target)) {
      return jsonResponse(
        { status: 'not-dsproj', path: path.basename(target), message: '那个文件不是 .dsproj 工程包，拒绝覆盖' },
        409,
      );
    }
  }

  if (!force) {
    const stale = staleOf(state, sessionId, target);
    if (stale !== undefined) {
      return jsonResponse(
        {
          status: 'stale',
          path: target,
          stale,
          cloud: cloudMarkOf(target),
          message: '这个文件的内容已经不是我上次写的那份了（可能来自另一台机器或同步盘）。',
        },
        409,
      );
    }
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
      writeAtomic(target, out.zip, { createDir: false });
    });
  } catch (error) {
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
          message: '保存位置所在的文件夹不在了（磁盘没挂上或被删）。',
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
    const result = importPackage(source, { cwd, onConflict, memory: memoryMode });
    if (result.status === 'need-workspace') return jsonResponse(result);
    if (result.conflict === true) return jsonResponse({ status: 'conflict', ...result }, 409);
    // 打开时就把该文件此刻的内容指纹记下来；顺带把「别处正在写 / 在同步盘里」这两件
    // 需要用户知道的事随结果带回去，界面上提示一句，但都不阻止打开。
    const state = rememberSource(readState(), result.sessionId, source);
    writeState(state);
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
        return jsonResponse({ status: 'error', message: String(error?.message ?? error) }, 500);
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
        return jsonResponse({ status: 'error', message: String(error?.message ?? error) }, 500);
      }
    },
  });
  connection.fetch.register({
    path: WORKSPACES_ROUTE,
    methods: ['GET', 'POST'],
    requestBody: 'buffered',
    fetch: async (request) => handleWorkspaces(request),
  });
  connection.fetch.register({
    path: AUTOSAVE_ROUTE,
    methods: ['GET', 'POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      try {
        return await handleAutosave(request);
      } catch (error) {
        return jsonResponse({ status: 'error', message: String(error?.message ?? error) }, 500);
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
