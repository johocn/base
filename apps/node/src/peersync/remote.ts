// 逐行移植 internal/peersync/remote.go：本文件只做「把一个公开/内部接口包成一次调用」。
// 字段名与 internal/httpapi 的响应 DTO 一一对应。
//
// 与 Go 的**有意差异**：Go 的 protocol.ReadBlobFrame 从 io.Reader 流式读、读尽返回 io.EOF；
// @base/protocol-ts 的 readBlobFrame(buf, offset) 面向整段缓冲、读尽返回 null，故 fetchBatch 用 offset 循环。
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  BLOB_PACK_CONTENT_TYPE,
  blobId as blobIdOf,
  FETCH_MAX_BYTES,
  readBlobFrame,
  type Manifest,
} from "@base/protocol-ts";
import {
  client,
  doRequest,
  fetchMaxBlobs,
  type Config,
  type Peer,
  type SyncContext,
} from "./peer";

/** GET /v1/catalog 的一页（JSON 线名：snake_case）。 */
export interface CatalogPage {
  pack_id: string;
  content_version: number;
  items: CatalogItem[];
  next_cursor: string | null;
}

/** 目录条目；反熵只用 item_id，其余留着便于诊断打印。 */
export interface CatalogItem {
  item_id: string;
  source: string;
  type: string;
  title: string;
  content_hash: string;
  source_rev: string;
}

/** GET /v1/inventory 的一条块记录。 */
export interface InventoriedBlob {
  blob_id: string;
  size: number;
}

/** 拉全量分页后的邻居块清单（对齐 Go Inventory 的 Go 字段名）。 */
export interface Inventory {
  contentVersion: number;
  merkleRoot: string;
  blobs: InventoriedBlob[];
}

/** 拉块切批需要的「块 id + 明文长度」。 */
export interface BlobSize {
  blobId: string;
  size: number;
}

/** 一次（可能分批的）拉块结果。 */
export interface FetchResult {
  /** 请求过的块数。 */
  requested: number;
  /** 校验通过并交给 sink 的块数。 */
  fetched: number;
  /** 帧头与内容哈希不符被丢弃的帧数。 */
  badFrames: number;
  /** 单块 > FetchMaxBytes 无法走 fetch 的块（本期不做分片传输）。 */
  tooLarge: string[];
}

const decoder = new TextDecoder();

function toStr(v: unknown): string {
  return v === null || v === undefined ? "" : String(v);
}

function toNum(v: unknown): number {
  return v === null || v === undefined ? 0 : Number(v);
}

function headerGet(headers: Record<string, string>, name: string): string {
  const want = name.toLowerCase();
  if (Object.prototype.hasOwnProperty.call(headers, want)) return headers[want];
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === want) return v;
  }
  return "";
}

/** Go url.QueryEscape：非保留字符原样、空格转 '+'、其余按 UTF-8 字节 %XX（大写）。 */
function queryEscape(s: string): string {
  let out = "";
  for (const ch of s) {
    const c = ch.codePointAt(0) ?? 0;
    if (
      (c >= 0x30 && c <= 0x39) ||
      (c >= 0x41 && c <= 0x5a) ||
      (c >= 0x61 && c <= 0x7a) ||
      c === 0x2d ||
      c === 0x5f ||
      c === 0x2e ||
      c === 0x7e
    ) {
      out += ch;
    } else if (c === 0x20) {
      out += "+";
    } else {
      for (const b of new TextEncoder().encode(ch)) {
        out += "%" + b.toString(16).toUpperCase().padStart(2, "0");
      }
    }
  }
  return out;
}

/** endpoint（remote.go:68-70）：拼路径前去掉 URL 末尾所有 '/'。 */
export function endpoint(p: Peer, path: string): string {
  return p.url.replace(/\/+$/, "") + path;
}

/** get（remote.go:72-90）：GET 一页并做状态码检查。 */
async function get(c: Config, ctx: SyncContext, p: Peer, path: string): Promise<Uint8Array> {
  const tr = client(c, p);
  const res = await doRequest(c, ctx, tr, "GET", endpoint(p, path), null);
  if (res.status !== 200) {
    const text = decoder.decode(res.body.subarray(0, 64 << 20)).trim();
    throw new Error(`GET ${path}: HTTP ${res.status} ${text}`);
  }
  return res.body;
}

/** FetchCatalog（remote.go:93-107）：拉目录首页。 */
export async function fetchCatalog(
  c: Config,
  ctx: SyncContext,
  p: Peer,
  since: number,
): Promise<CatalogPage> {
  let path = "/v1/catalog";
  if (since > 0) path += "?since=" + String(since);
  const body = await get(c, ctx, p, path);
  let parsed: Record<string, unknown> | null;
  try {
    parsed = JSON.parse(decoder.decode(body)) as Record<string, unknown> | null;
  } catch (err) {
    throw new Error(`catalog 响应不是合法 JSON: ${String(err)}`);
  }
  if (parsed === null || typeof parsed !== "object") {
    return { pack_id: "", content_version: 0, items: [], next_cursor: null };
  }
  return {
    pack_id: toStr(parsed.pack_id),
    content_version: toNum(parsed.content_version),
    items: Array.isArray(parsed.items) ? (parsed.items as CatalogItem[]) : [],
    next_cursor: parsed.next_cursor === null || parsed.next_cursor === undefined ? null : String(parsed.next_cursor),
  };
}

/** FetchManifest（remote.go:110-120）：拉签名 manifest，同时把原始字节一并返回。 */
export async function fetchManifest(
  c: Config,
  ctx: SyncContext,
  p: Peer,
  packID: string,
): Promise<{ manifest: Manifest; raw: Uint8Array }> {
  const body = await get(c, ctx, p, "/v1/manifest/" + packID);
  let parsed: Manifest | null;
  try {
    parsed = JSON.parse(decoder.decode(body)) as Manifest | null;
  } catch (err) {
    throw new Error(`manifest 不是合法 JSON: ${String(err)}`);
  }
  if (parsed === null || typeof parsed !== "object") {
    const empty: Manifest = {
      pack_id: "",
      schema_version: 0,
      issuer: "",
      issued_at: "",
      content_version: 0,
      entries: [],
      tombstone: [],
      merkle_root: "",
      signature: "",
    };
    return { manifest: empty, raw: body };
  }
  return { manifest: parsed, raw: body };
}

/**
 * FetchPackTo（remote.go:124-164）：把 pack.sqlite 下载到 destDir/pack.sqlite。
 * 先写 .tmp，读完整且字节数 > 0 才 rename 落位：避免半截包被当成产物。
 */
export async function fetchPackTo(
  c: Config,
  ctx: SyncContext,
  p: Peer,
  packID: string,
  destDir: string,
): Promise<string> {
  const tr = client(c, p);
  const res = await doRequest(c, ctx, tr, "GET", endpoint(p, "/v1/pack/" + packID), null);
  if (res.status !== 200) {
    const text = decoder.decode(res.body.subarray(0, 4096)).trim();
    throw new Error(`GET /v1/pack/${packID}: HTTP ${res.status} ${text}`);
  }
  mkdirSync(destDir, { recursive: true, mode: 0o755 });
  const final = join(destDir, "pack.sqlite");
  const tmp = final + ".tmp";
  try {
    writeFileSync(tmp, res.body);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw new Error(`写 pack 临时文件: ${String(err)}`);
  }
  if (res.body.length === 0) {
    rmSync(tmp, { force: true });
    throw new Error(`pack ${packID} 为空文件`);
  }
  try {
    renameSync(tmp, final);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
  return final;
}

/** PostSync（remote.go:167-195）：提交本地水位与块集合 merkle_root，返回对端判定是否相等。 */
export async function postSync(
  c: Config,
  ctx: SyncContext,
  p: Peer,
  version: number,
  merkleRoot: string,
): Promise<boolean> {
  const tr = client(c, p);
  const body = new TextEncoder().encode(
    JSON.stringify({ content_version: version, merkle_root: merkleRoot }),
  );
  const res = await doRequest(c, ctx, tr, "POST", endpoint(p, "/v1/sync"), body);
  if (res.status !== 200) {
    const text = decoder.decode(res.body.subarray(0, 1 << 20)).trim();
    throw new Error(`POST /v1/sync: HTTP ${res.status} ${text}`);
  }
  let out: { equal?: unknown };
  try {
    out = JSON.parse(decoder.decode(res.body)) as { equal?: unknown };
  } catch (err) {
    throw new Error(`sync 响应不是合法 JSON: ${String(err)}`);
  }
  return out?.equal === true;
}

/** FetchInventory（remote.go:198-235）：翻页拉邻居的**全量**块清单（since=0：完整集合）。 */
export async function fetchInventory(
  c: Config,
  ctx: SyncContext,
  p: Peer,
  since: number,
): Promise<Inventory> {
  const inv: Inventory = { contentVersion: 0, merkleRoot: "", blobs: [] };
  let cursor = "";
  const seenCursor = new Set<string>();
  for (;;) {
    let path = "/v1/inventory?limit=2000";
    if (since > 0) path += "&since=" + String(since);
    if (cursor !== "") path += "&cursor=" + queryEscape(cursor);
    const body = await get(c, ctx, p, path);
    let page: Record<string, unknown>;
    try {
      page = JSON.parse(decoder.decode(body)) as Record<string, unknown>;
    } catch (err) {
      throw new Error(`inventory 响应不是合法 JSON: ${String(err)}`);
    }
    inv.contentVersion = toNum(page?.content_version);
    inv.merkleRoot = toStr(page?.merkle_root);
    if (Array.isArray(page?.blobs)) inv.blobs.push(...(page.blobs as InventoriedBlob[]));
    const next = page?.next_cursor;
    if (next === null || next === undefined || next === "") return inv;
    const nextStr = String(next);
    if (seenCursor.has(nextStr)) throw new Error("inventory 分页未推进，拒绝死循环");
    seenCursor.add(nextStr);
    cursor = nextStr;
  }
}

/**
 * FetchBlobs（remote.go:240-294）：按「块数 ≤ FetchMaxBlobs 且累计 size ≤ FetchMaxBytes」切批拉块。
 * 每帧先校验 hex(sha256(payload))[0:32] == 帧头 blob_id，不符即丢弃并计入 BadFrames。
 * 对端没发的块不报错，只是拿不到（契约 §5.2：缺失块整帧跳过）。
 */
export async function fetchBlobs(
  c: Config,
  ctx: SyncContext,
  p: Peer,
  want: BlobSize[],
  sink: (blobId: string, data: Uint8Array) => void,
): Promise<FetchResult> {
  const out: FetchResult = { requested: 0, fetched: 0, badFrames: 0, tooLarge: [] };
  const maxBlobs = fetchMaxBlobs(c);
  let remaining = want;
  while (remaining.length > 0) {
    const batch: BlobSize[] = [];
    let bytesTotal = 0;
    for (const b of remaining) {
      if (batch.length >= maxBlobs) break;
      if (b.size > FETCH_MAX_BYTES) {
        out.tooLarge.push(b.blobId);
        continue;
      }
      if (batch.length > 0 && bytesTotal + b.size > FETCH_MAX_BYTES) break;
      batch.push(b);
      bytesTotal += b.size;
    }
    // 把 TooLarge 从 remaining 中摘掉，避免死循环。
    if (out.tooLarge.length > 0) {
      const skip = new Set(out.tooLarge);
      remaining = remaining.filter((b) => !skip.has(b.blobId));
    }
    if (batch.length === 0) break;
    await fetchBatch(c, ctx, p, batch, out, sink);
    const sent = new Set(batch.map((b) => b.blobId));
    remaining = remaining.filter((b) => !sent.has(b.blobId));
  }
  return out;
}

/** fetchBatch（remote.go:296-338）：发一批 fetch，逐帧校验后交给 sink。 */
export async function fetchBatch(
  c: Config,
  ctx: SyncContext,
  p: Peer,
  batch: BlobSize[],
  out: FetchResult,
  sink: (blobId: string, data: Uint8Array) => void,
): Promise<void> {
  const tr = client(c, p);
  const ids = batch.map((b) => b.blobId);
  const reqBody = new TextEncoder().encode(JSON.stringify({ blob_ids: ids }));
  out.requested += ids.length;
  const res = await doRequest(c, ctx, tr, "POST", endpoint(p, "/v1/fetch"), reqBody);
  if (res.status !== 200) {
    const text = decoder.decode(res.body.subarray(0, 4096)).trim();
    throw new Error(`POST /v1/fetch: HTTP ${res.status} ${text}`);
  }
  const ct = headerGet(res.headers, "Content-Type");
  if (ct !== BLOB_PACK_CONTENT_TYPE) {
    throw new Error(
      `fetch Content-Type = ${JSON.stringify(ct)}, want ${JSON.stringify(BLOB_PACK_CONTENT_TYPE)}`,
    );
  }
  let offset = 0;
  for (;;) {
    let frame: { blobId: string; payload: Uint8Array; next: number } | null;
    try {
      frame = readBlobFrame(res.body, offset);
    } catch (err) {
      throw new Error(`读 fetch 帧: ${String(err)}`);
    }
    if (frame === null) return;
    offset = frame.next;
    if (blobIdOf(frame.payload) !== frame.blobId) {
      out.badFrames++;
      continue;
    }
    sink(frame.blobId, frame.payload);
    out.fetched++;
  }
}