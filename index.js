/**
 * dsh-session-save (Host half)
 *
 * One HTTP route that packages the current Session into a `.dsproj` file and
 * writes it to a path the user picks. Paths are remembered per Session, so the
 * first save asks where and later saves overwrite the same file.
 *
 * Zero dependencies: node:fs / node:path / node:zlib / node:child_process only.
 */
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

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
const ZSTD_MAGIC = 0xfd2fb528;
/** Same frame parameters the official writer uses, so rewritten headers stay readable. */
const CHECKSUM_OPTIONS = { params: { [zlib.constants.ZSTD_c_checksumFlag]: 1 } };
const here = path.dirname(fileURLToPath(import.meta.url));
const PS1 = path.join(here, 'save-dialog.ps1');
const OPEN_PS1 = path.join(here, 'open-dialog.ps1');
const DIALOG_TIMEOUT_MS = 10 * 60 * 1000;
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

/** Official `encodeSegment`: safe characters pass, everything else becomes ~XXXX. */
function encodeSegment(raw) {
  const text = String(raw);
  if (text === '.') return '~002E';
  if (text === '..') return '~002E~002E';
  let out = '';
  for (const ch of text) {
    if (/[A-Za-z0-9._-]/.test(ch)) out += ch;
    else out += '~' + ch.codePointAt(0).toString(16).toUpperCase().padStart(4, '0');
  }
  return out;
}

/** Official `projectKey`: separators collapse, then the segment is hex-escaped. */
function projectKey(cwd) {
  const raw = String(cwd ?? '');
  if (raw === '') return '_no-cwd';
  const folded = raw.replace(/[/\\:]+/g, '-').replace(/^-+/, '');
  let safe = '';
  for (const ch of folded) {
    if (/[A-Za-z0-9._-]/.test(ch)) safe += ch;
    else safe += '~' + ch.codePointAt(0).toString(16).toUpperCase().padStart(4, '0');
  }
  return `--${safe.slice(0, 251).replace(/-+$/, '')}--`;
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

/** dest 是否严格落在 root 之内（root 自身不算）。用 relative 判前缀，别用字符串 startsWith。 */
function isInside(root, dest) {
  const rootAbs = path.resolve(root);
  const rel = path.relative(rootAbs, path.resolve(dest));
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
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
  const empty = { paths: {}, lastDir: undefined, autosave: {}, stamps: {}, stale: {} };
  try {
    const raw = JSON.parse(fs.readFileSync(stateFile(), 'utf8'));
    return {
      paths: raw?.paths && typeof raw.paths === 'object' ? raw.paths : {},
      lastDir: typeof raw?.lastDir === 'string' ? raw.lastDir : undefined,
      autosave: raw?.autosave && typeof raw.autosave === 'object' ? raw.autosave : {},
      stamps: raw?.stamps && typeof raw.stamps === 'object' ? raw.stamps : {},
      stale: raw?.stale && typeof raw.stale === 'object' ? raw.stale : {},
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

/** 先写临时文件再改名：同步盘不会看到写了一半的包。 */
export function writeAtomic(target, bytes) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
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
 * 从结果文件 / stdout 里取出 `RESULT:<path>`。
 *
 * Windows PowerShell 5.1 的 stdout 走控制台代码页（中文系统上是 GBK），Node 按
 * UTF-8 解就会把中文路径读成乱码（文件被存成 `������ÿ...` 那种名字）。所以脚本
 * 会把同一行按 UTF-8 写进 `-ResultFile`，这里优先读它，stdout 只当兜底。
 */
export function readDialogResult(resultFile, stdout, error) {
  let raw = '';
  if (typeof resultFile === 'string' && resultFile !== '') {
    try {
      raw = fs.readFileSync(resultFile, 'utf8');
    } catch {
      raw = '';
    }
  }
  if (raw === '') raw = String(stdout ?? '');
  const line = raw.split(/\r?\n/).find((entry) => entry.startsWith('RESULT:'));
  // 没有 RESULT 行：要么拿不到窗口（undefined → 客户端改走路径输入），要么被取消。
  if (line === undefined) return error ? undefined : null;
  const picked = line.slice('RESULT:'.length).trim();
  return picked === '' ? null : picked;
}

/**
 * 跑一个对话框脚本：undefined = 拿不到窗口，null = 用户取消，字符串 = 选中路径。
 * `-ResultFile` 是为了绕开 stdout 的控制台代码页，见 readDialogResult。
 */
export function runDialog(scriptPath, initial) {
  return new Promise((resolve) => {
    const systemRoot = process.env.SystemRoot;
    const exe = systemRoot
      ? path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
      : 'powershell.exe';
    if (!fs.existsSync(scriptPath)) return resolve(undefined);
    const resultFile = path.join(
      os.tmpdir(),
      `dsh-session-save-dialog-${process.pid}-${Date.now()}.txt`,
    );
    try {
      fs.unlinkSync(resultFile);
    } catch {
      /* ignore */
    }
    execFile(
      exe,
      [
        '-NoProfile',
        '-STA',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        scriptPath,
        '-Initial',
        initial ?? '',
        '-ResultFile',
        resultFile,
      ],
      { timeout: DIALOG_TIMEOUT_MS, windowsHide: false, maxBuffer: 1024 * 1024 },
      (error, stdout) => {
        const picked = readDialogResult(resultFile, stdout, error);
        try {
          fs.unlinkSync(resultFile);
        } catch {
          /* ignore */
        }
        resolve(picked);
      },
    );
  });
}

function nativeSaveDialog(initial) {
  return runDialog(PS1, initial);
}

/** Same contract as nativeSaveDialog, but an Open dialog. */
function nativeOpenDialog(initial) {
  return runDialog(OPEN_PS1, initial ?? '');
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

  const manifest = {
    format: FORMAT,
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
  /^workspace\/.+$/,
];

/**
 * 打开前的整包校验：条目白名单 + `manifest.parts` 的 sha256／体积比对。
 * digest 在打包时就写好了，这里第一次真正用它 —— 传输中被改动或被人塞了东西就能发现。
 */
function verifyPackage(entries, manifest) {
  for (const name of entries.keys()) {
    if (!ENTRY_ALLOW.some((pattern) => pattern.test(name))) {
      throw new Error(`包里有不认识的条目，拒绝打开：${name}`);
    }
  }
  const parts = manifest?.parts;
  if (parts === undefined || parts === null || typeof parts !== 'object') return;
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
  fs.writeFileSync(target, finalBuf);

  let memoryWritten = 0;
  let memorySkipped = 0;
  const memoryConflicts = [];
  const prefix = 'memory/workspaces/';
  const memoryKeys = [...entries.keys()].filter((name) => name.startsWith(prefix));
  if (memoryKeys.length > 0 && options.memory !== false) {
    const memory = memoryDirFor(cwd);
    const stamp = new Date().toISOString().slice(0, 10);
    // 先把所有落点算完再写：任意一条越界都整包拒绝，不给「写了一半」留机会
    const planned = [];
    for (const key of memoryKeys) {
      // 反斜杠也是分隔符；第一段是包里记录的 slug，落点由本机解析，所以丢掉它
      const segments = key.slice(prefix.length).split(/[\\/]+/).filter((part) => part !== '');
      const rel = segments.slice(1).join('/');
      if (rel === '') continue;
      planned.push({ rel, dest: safeJoin(memory.dir, rel), data: entries.get(key) });
    }
    for (const item of planned) {
      const { rel, dest, data } = item;
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      let existing;
      try {
        existing = fs.readFileSync(dest);
      } catch {
        existing = undefined; // 文件不存在
      }
      if (existing !== undefined) {
        if (existing.equals(data)) {
          memorySkipped += 1;
          continue;
        }
        const alt = `${dest}.from-dsproj-${stamp}`;
        fs.mkdirSync(path.dirname(alt), { recursive: true });
        fs.writeFileSync(alt, data);
        memoryConflicts.push(rel);
        memoryWritten += 1;
        continue;
      }
      try {
        // wx：存在就失败。existsSync 与 write 之间的空档也不给穿越/覆盖用
        fs.writeFileSync(dest, data, { flag: 'wx' });
        memoryWritten += 1;
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error;
        const alt = `${dest}.from-dsproj-${stamp}`;
        fs.writeFileSync(alt, data);
        memoryConflicts.push(rel);
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
    memoryConflicts,
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
      writeAtomic(target, out.zip);
    });
    state.stamps = state.stamps && typeof state.stamps === 'object' ? state.stamps : {};
    state.stamps[sessionId] = { path: target, sha256: cryptoHash(out.zip), at: new Date().toISOString() };
    if (state.stale !== undefined && typeof state.stale === 'object') delete state.stale[sessionId];
    writeState(state);
  } catch {
    /* 自动保存失败不打扰用户，下一次 step 会重试 */
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
 * 单元测试直接调 handler（没有 headers 对象）时不拦。
 * @returns 拒绝原因，或 undefined 表示放行
 */
function requestGate(request) {
  const headers = request?.headers;
  if (headers === undefined || headers === null || typeof headers.get !== 'function') return undefined;
  // 浏览器一定带 Host；undici 之类的调用端可能没带，这时退回看请求 URL 的主机名，
  // 两者都拿不到才算不合格。
  const urlHost = (() => {
    try {
      return new URL(String(request?.url ?? '')).host;
    } catch {
      return '';
    }
  })();
  const host = String(headers.get('host') ?? '').toLowerCase() || urlHost.toLowerCase();
  if (host === '') return '请求缺少 Host';
  const hostName = host.replace(/:\d+$/, '');
  const loopback = (value) =>
    value === '127.0.0.1' || value === 'localhost' || value === '::1' || value === '[::1]';
  if (!loopback(hostName)) return '只接受本机回环地址的请求';
  const origin = headers.get('origin');
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
  if (String(headers.get('sec-fetch-site') ?? '') === 'cross-site') return '拒绝跨站请求';
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
  const includeMemory = query.memory === '1' || query.memory === 'true';
  const explicitRaw = typeof query.path === 'string' && query.path.trim() !== '' ? query.path.trim() : null;
  const remembered = state.paths[sessionId];
  const rememberedAbs = typeof remembered === 'string' && remembered !== '' ? path.resolve(remembered) : undefined;
  const suggested = () => suggestPath(sessionId, header, state, readTitle(buf));

  let target = null;
  let fromDialog = false;

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
    out = buildPackage(sessionFile, buf, header, readStats(buf), lock);
  } catch (error) {
    return jsonResponse({ status: 'error', message: `打包失败：${error?.message ?? error}` }, 500);
  }

  try {
    withSidecarLock(target, () => {
      writeAtomic(target, out.zip);
    });
  } catch (error) {
    return jsonResponse({ status: 'error', message: `写入失败：${target} — ${error?.message ?? error}` }, 500);
  }

  const stat = fs.statSync(target);
  state.paths[sessionId] = target;
  state.lastDir = path.dirname(target);
  state.stamps = state.stamps && typeof state.stamps === 'object' ? state.stamps : {};
  state.stamps[sessionId] = { path: target, sha256: cryptoHash(out.zip), at: new Date().toISOString() };
  if (state.stale !== undefined && typeof state.stale === 'object') delete state.stale[sessionId];
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
    const result = importPackage(source, { cwd, onConflict });
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
    // 同 V6：包里/路径里的细节只进日志，不进响应正文。
    console.warn('[dsh-session-save] 打开失败', source, error);
    return jsonResponse({ status: 'error', message: '这个文件打不开：不是有效的 .dsproj 工程包，或者权限不够' }, 500);
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
