import type { Adapters } from './platform/adapter';
import type { LocalRepo } from './repo';
import { decodeUtf8 } from './sync';

export type TermKind = 'category' | 'instructor' | 'tag';
export type TermState = 'empty' | 'pending' | 'approved';

export interface PendingTerm {
  kind: TermKind;
  termKey: string;
  displayName: string;
  votes: number;
  threshold: number;
}

export interface DirectorySnapshot {
  version: number;
  /** 'kind\x00termKey' -> displayName。用 Map 而非 Set：`displayOf` 要取 display_name（册子 §5.1/§5.3），Set 存不下展示名。 */
  approved: Map<string, string>;
  /** 'kind\x00termKey' -> 行（带 votes/threshold，供「我创建的」提示行）。 */
  pending: Map<string, PendingTerm>;
}

export interface DirectoryOptions {
  adapters: Adapters;
  repo: LocalRepo;
  nodeBaseUrl: string;
}

const CACHE_VERSION_KEY = 'directory_version';
const CACHE_TERMS_KEY = 'directory_terms_json';

const KINDS: ReadonlySet<string> = new Set(['category', 'instructor', 'tag']);
const SEP = '\x00';

function isKind(v: unknown): v is TermKind {
  return typeof v === 'string' && KINDS.has(v);
}

/**
 * Go 版 `unicode.IsSpace` 的显式等价集。不能直接用 JS 正则 `\s`——二者集合有差异：
 * `\s` 含 `U+FEFF`（BOM，Go 不算空白），却不含 `U+0085`（NEL，Go 算空白）。
 * 词条键要与节点侧 `NormalizeTermKey` 逐字节同构，故手写判集合。
 */
function isGoSpace(ch: string): boolean {
  const cp = ch.codePointAt(0)!;
  return (
    cp === 0x09 ||
    cp === 0x0a ||
    cp === 0x0b ||
    cp === 0x0c ||
    cp === 0x0d ||
    cp === 0x20 ||
    cp === 0x85 ||
    cp === 0xa0 ||
    cp === 0x1680 ||
    (cp >= 0x2000 && cp <= 0x200a) ||
    cp === 0x2028 ||
    cp === 0x2029 ||
    cp === 0x202f ||
    cp === 0x205f ||
    cp === 0x3000
  );
}

/** 对应 Go `strings.TrimSpace`：去首尾 Go 空白。 */
function trimGoSpace(s: string): string {
  const rs = [...s];
  let i = 0;
  let j = rs.length;
  while (i < j && isGoSpace(rs[i]!)) i++;
  while (j > i && isGoSpace(rs[j - 1]!)) j--;
  return rs.slice(i, j).join('');
}

/** 步 2：U+FF01..U+FF5E 各减 0xFEE0；U+3000 → 半角空格。 */
function foldFullWidth(s: string): string {
  let out = '';
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    if (cp >= 0xff01 && cp <= 0xff5e) out += String.fromCodePoint(cp - 0xfee0);
    else if (cp === 0x3000) out += ' ';
    else out += ch;
  }
  return out;
}

/** 步 3：连续 Go 空白折叠为单个半角空格。 */
function collapseGoSpaces(s: string): string {
  let out = '';
  let prevSpace = false;
  for (const ch of s) {
    if (isGoSpace(ch)) {
      if (!prevSpace) {
        out += ' ';
        prevSpace = true;
      }
      continue;
    }
    out += ch;
    prevSpace = false;
  }
  return out;
}

/** 步 4：只折 ASCII 大写 A-Z 为小写，非 ASCII 不动。 */
function foldAsciiLower(s: string): string {
  let out = '';
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    out += cp >= 0x41 && cp <= 0x5a ? String.fromCharCode(cp + 0x20) : ch;
  }
  return out;
}

/** 步 5：剥离控制字符 U+0000–U+001F 与 U+007F。 */
function stripControl(s: string): string {
  let out = '';
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    if (cp <= 0x1f || cp === 0x7f) continue;
    out += ch;
  }
  return out;
}

/**
 * 词条键规范化（册子 #58 §2.2），与节点侧 `store.NormalizeTermKey` 逐字节同构。
 * 顺序定死：TrimSpace → 全角折半角 → 空白折叠 → ASCII 小写 → 剥离控制字符 → 1..64 rune。
 * 不做 Unicode NFC。非法（空或超 64 rune）返回 null。
 */
export function normalizeTermKey(raw: string): string | null {
  let s = trimGoSpace(raw);
  s = foldFullWidth(s);
  s = collapseGoSpaces(s);
  s = foldAsciiLower(s);
  s = stripControl(s);
  const n = [...s].length;
  if (n < 1 || n > 64) return null;
  return s;
}

/**
 * 展示名清洗（对齐 Go `store.CleanDisplayName`，`directory.go:64-66`）：
 * `stripControl(collapseSpaces(TrimSpace(raw)))`。**故意不做全角折叠与大小写折叠**——
 * 展示名保留原文（含全角、大小写），便于阅读。
 */
export function cleanDisplayName(raw: string): string {
  return stripControl(collapseGoSpaces(trimGoSpace(raw)));
}

/**
 * 拉取目录并落缓存（册子 §4.2）。
 * - 版本未变（`unchanged:true`）时**绝不写缓存**，避免用等价数据覆盖本地。
 * - 形状非法时抛错，不用坏响应覆盖已有缓存。
 */
export async function pullDirectory(o: DirectoryOptions): Promise<{ version: number; unchanged: boolean }> {
  const local = Number((await o.repo.getConfig(CACHE_VERSION_KEY)) ?? '0') || 0;
  // 手拼查询串：老 WebView 没有 URLSearchParams（与 sync.fetchCatalog 同款取舍）
  const res = await o.adapters.http.get(`${o.nodeBaseUrl}/v1/directory?version=${local}`);
  if (res.status !== 200) throw new Error('目录拉取失败: HTTP ' + res.status);
  const body = JSON.parse(decodeUtf8(res.body)) as {
    version?: unknown;
    unchanged?: unknown;
    approved?: unknown;
    pending?: unknown;
  };
  if (body.unchanged === true) {
    return { version: typeof body.version === 'number' ? body.version : local, unchanged: true };
  }
  if (!Array.isArray(body.approved) || !Array.isArray(body.pending) || typeof body.version !== 'number') {
    throw new Error('目录响应形状非法');
  }
  await o.repo.setConfig(CACHE_VERSION_KEY, String(body.version));
  await o.repo.setConfig(CACHE_TERMS_KEY, JSON.stringify({ approved: body.approved, pending: body.pending }));
  return { version: body.version, unchanged: false };
}

/**
 * 读本地缓存构造快照（册子 §4.2）。fail-closed：缓存缺失/损坏一律返回空集 ⇒ 全端按 `pending`，
 * 宁可显示「待票选」也不误显示为「已通过」。
 */
export async function loadDirectory(repo: LocalRepo): Promise<DirectorySnapshot> {
  const version = Number((await repo.getConfig(CACHE_VERSION_KEY)) ?? '0') || 0;
  const raw = await repo.getConfig(CACHE_TERMS_KEY);
  const approved = new Map<string, string>();
  const pending = new Map<string, PendingTerm>();
  if (raw === null || raw === '') return { version, approved, pending };
  try {
    const parsed = JSON.parse(raw) as { approved?: unknown; pending?: unknown };
    if (!Array.isArray(parsed.approved) || !Array.isArray(parsed.pending)) {
      return { version, approved, pending };
    }
    for (const t of parsed.approved) {
      const row = t as { kind?: unknown; term_key?: unknown; display_name?: unknown };
      if (!isKind(row.kind) || typeof row.term_key !== 'string' || row.term_key === '') continue;
      const name = typeof row.display_name === 'string' && row.display_name !== '' ? row.display_name : row.term_key;
      approved.set(row.kind + SEP + row.term_key, name);
    }
    for (const t of parsed.pending) {
      const row = t as {
        kind?: unknown;
        term_key?: unknown;
        display_name?: unknown;
        votes?: unknown;
        threshold?: unknown;
      };
      if (!isKind(row.kind) || typeof row.term_key !== 'string' || row.term_key === '') continue;
      pending.set(row.kind + SEP + row.term_key, {
        kind: row.kind,
        termKey: row.term_key,
        displayName: typeof row.display_name === 'string' && row.display_name !== '' ? row.display_name : row.term_key,
        votes: typeof row.votes === 'number' ? row.votes : 0,
        threshold: typeof row.threshold === 'number' ? row.threshold : 0,
      });
    }
  } catch {
    // JSON 损坏 ⇒ 与缓存缺失同口径（fail-closed）
    return { version, approved: new Map(), pending: new Map() };
  }
  return { version, approved, pending };
}

/** 三态判定（册子 §5.1）：字段空 ⇒ empty；在 approved ⇒ approved；否则 pending。 */
export function termState(s: DirectorySnapshot, kind: TermKind, key: string): TermState {
  if (key === '') return 'empty';
  return s.approved.has(kind + SEP + key) ? 'approved' : 'pending';
}

/** 取展示名：pending 命中取其 displayName，否则 approved 命中取 displayName，都未命中回退 key。 */
export function displayOf(s: DirectorySnapshot, kind: TermKind, key: string): string {
  const k = kind + SEP + key;
  const p = s.pending.get(k);
  if (p !== undefined) return p.displayName;
  const a = s.approved.get(k);
  if (a !== undefined) return a;
  return key;
}
