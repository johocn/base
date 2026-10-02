// 逐行对齐 internal/httpapi/peer.go（334 行）的**入站**五路由：inventory / sync / fetch /
// scrub / event-sync。本层不做跨节点编排（scrub 只修本地），装配只在**对端监听**上（Go 的 mountInternal）。
//
// 三处裸 json 解码（sync / fetch / scrub）用 Go `json.NewDecoder(...).Decode(&struct)` 的口径：
// 只解第一个 JSON 值（不拒尾随）、顶层 null 是 no-op、非对象即失败、字段类型严格。
// event-sync 用 `s.decodeJSON`（identity.go:40-48）口径，即 decode.ts 的 decodeStrict（体上限 64 KiB）。
import type {
  HttpServerAdapter,
  ServerHandler,
  ServerRequest,
  ServerResponse,
} from "@base/core-ts";
import {
  BLOB_PACK_CONTENT_TYPE,
  FETCH_MAX_BYTES,
  blobId as blobIdOf,
  isBlobId,
  merkleRoot,
  writeBlobFrame,
} from "@base/protocol-ts";
import type { HostDb } from "../host/sqlite";
import {
  contentVersion,
  getBlobBytes,
  hasBlob,
  hostDbAsDb,
  listAllBlobIDs,
  listBlobsPage,
  listEventsAfter,
  listRevokedPayloads,
  listTombstonesAfter,
  verifyBlobs,
} from "../store/peersync";
import {
  decodeStrict,
  jsonObjectField,
  parseJSONDocument,
  type JsonNode,
  type StrictSpec,
} from "./decode";
import { parseGoInt, parseGoInt64 } from "./derived";
import { jsonResponse } from "./json";

// —— 常量（peer.go:12-15、:203-206；defaultFetchMaxBlobs 见 server.go:29） ——
const INVENTORY_DEFAULT_LIMIT = 500;
const INVENTORY_MAX_LIMIT = 2000;
const EVENT_SYNC_DEFAULT_LIMIT = 200;
const EVENT_SYNC_MAX_LIMIT = 500;
const DEFAULT_FETCH_MAX_BLOBS = 64;

/** 三个裸解码路由的体上限：sync `1<<16`、fetch / scrub `1<<20`。 */
const SYNC_MAX_BODY = 1 << 16;
const FETCH_MAX_BODY = 1 << 20;
const SCRUB_MAX_BODY = 1 << 20;

/** 入站五路由的依赖；db 用 HostDb（D1 peersync.ts 的首参口径）。 */
export interface PeerDeps {
  db: HostDb;
  dataDir: string;
  storeKey: Uint8Array;
  /** 对齐 server.go:22-23、:49-51：<=0 取缺省 64。 */
  fetchMaxBlobs: number;
}

function errResponse(err: unknown): ServerResponse {
  return jsonResponse(500, { error: err instanceof Error ? err.message : String(err) });
}

// ==================== GET /v1/inventory（peer.go:34-79）====================

interface BlobSizeDTO {
  blob_id: string;
  size: number;
}

export function inventoryHandler(deps: PeerDeps): ServerHandler {
  return async (req) => {
    const q = req.query;
    let limit = INVENTORY_DEFAULT_LIMIT;
    const limitRaw = q["limit"] ?? "";
    if (limitRaw !== "") {
      const n = parseGoInt(limitRaw); // strconv.Atoi
      if (n !== null && n > 0 && n <= INVENTORY_MAX_LIMIT) limit = n;
    }

    let version: number;
    let ids: string[];
    let root: string;
    try {
      version = contentVersion(deps.db);
      ids = listAllBlobIDs(deps.db);
      root = merkleRoot(ids);
    } catch (err) {
      return errResponse(err);
    }
    const resp: {
      content_version: number;
      merkle_root: string;
      blobs: BlobSizeDTO[];
      next_cursor: string | null;
    } = { content_version: version, merkle_root: root, blobs: [], next_cursor: null };
    const sinceRaw = q["since"] ?? "";
    if (sinceRaw !== "") {
      const n = parseGoInt64(sinceRaw);
      if (n !== null && n >= version) {
        // 调用方水位不低于本节点：空 blobs + 仍带 merkle_root，用于快速 no-op
        return jsonResponse(200, resp);
      }
    }

    let refs: { blobId: string; size: number }[];
    let next: string;
    try {
      ({ refs, next } = listBlobsPage(deps.db, q["cursor"] ?? "", limit));
    } catch (err) {
      return errResponse(err);
    }
    for (const ref of refs) resp.blobs.push({ blob_id: ref.blobId, size: ref.size });
    if (next !== "") resp.next_cursor = next;
    return jsonResponse(200, resp);
  };
}

// ==================== 裸 json.Decoder.Decode 的极小等价（sync / fetch / scrub）====================
//
// Go 原语：`json.NewDecoder(http.MaxBytesReader(w, r.Body, N)).Decode(&struct)`。
// - MaxBytesReader 的可见效果 = 解析器最多能消费前 N 字节；故这里按 `body[0:N]` 截断后再解析：
//   值完整落在 N 字节内即成功，越过 N 即失败（与 Go 的 maxBytesReader 读越限报错等价）。
// - Decode 只解**第一个** JSON 值，尾随内容不读、不拒。
// - 顶层必须解进 struct：对象或 null 成功（null 为 no-op 零值），数组/数字/字符串/布尔失败。
// - 字段类型严格：int64 收 `1.5`/`1e2`/越界/字符串 → 失败；string 收非字符串 → 失败；
//   []string 收非数组 → 失败（元素 null 为 no-op → ""）；字段 null → 零值；未知字段忽略。

type BareFieldType = "string" | "int64" | "string_list";
type BareFieldValue = string | number | string[];

const JSON_WS = new Set([" ", "\t", "\n", "\r"]);
// JSON number 前缀（与 decode.ts 的 NUM_RE 同文法）。
const NUM_PREFIX_RE = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/;

function skipWs(s: string, i: number): number {
  while (i < s.length && JSON_WS.has(s[i])) i++;
  return i;
}

/** 从 `"` 起扫一个字符串，返回结束下标（独占）；未闭合返回 -1。 */
function scanString(s: string, i: number): number {
  i++;
  while (i < s.length) {
    const c = s[i];
    if (c === "\\") {
      i += 2;
      continue;
    }
    if (c === '"') return i + 1;
    i++;
  }
  return -1;
}

/** 从 `{`/`[` 起做括号配平扫描（字符串内不计数），返回结束下标；不完整返回 -1。 */
function scanComposite(s: string, i: number): number {
  let depth = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === '"') {
      const e = scanString(s, i);
      if (e < 0) return -1;
      i = e;
      continue;
    }
    if (c === "{" || c === "[") depth++;
    else if (c === "}" || c === "]") {
      depth--;
      if (depth === 0) return i + 1;
    }
    i++;
  }
  return -1;
}

/** 扫出文本头部的第一个 JSON 值（跳过前导空白）；不存在或不完整返回 null。 */
function firstJSONValue(text: string): string | null {
  const i = skipWs(text, 0);
  if (i >= text.length) return null;
  const c = text[i];
  let end: number;
  if (c === "{" || c === "[") end = scanComposite(text, i);
  else if (c === '"') end = scanString(text, i);
  else if (text.startsWith("true", i)) end = i + 4;
  else if (text.startsWith("false", i)) end = i + 5;
  else if (text.startsWith("null", i)) end = i + 4;
  else {
    const m = NUM_PREFIX_RE.exec(text.slice(i));
    end = m === null ? -1 : i + m[0].length;
  }
  return end < 0 ? null : text.slice(i, end);
}

/** 单个字段按 Go 口径解码；失败返回 undefined。 */
function decodeBareField(type: BareFieldType, node: JsonNode): BareFieldValue | undefined {
  if (type === "string") return node.t === "str" ? node.v : undefined;
  if (type === "int64") {
    if (node.t !== "num") return undefined;
    const n = parseGoInt64(node.raw); // 非整数字面量 / 越界 → null
    return n === null ? undefined : n;
  }
  if (node.t !== "arr") return undefined;
  const out: string[] = [];
  for (const el of node.v) {
    if (el.t === "null") {
      out.push(""); // Go：null 对 string 元素是 no-op → 零值
      continue;
    }
    if (el.t !== "str") return undefined;
    out.push(el.v);
  }
  return out;
}

function defaultBareValue(type: BareFieldType): BareFieldValue {
  if (type === "int64") return 0;
  if (type === "string") return "";
  return [];
}

/** 裸解码：返回各字段值；失败返回 null（调用方回 400）。 */
function decodeBareRequest(
  body: Uint8Array,
  maxBytes: number,
  fields: Record<string, BareFieldType>,
): Record<string, BareFieldValue> | null {
  const text = Buffer.from(body.subarray(0, maxBytes)).toString("utf8");
  const raw = firstJSONValue(text);
  if (raw === null) return null;
  const node = parseJSONDocument(raw);
  if (node === null) return null;
  if (node.t !== "obj" && node.t !== "null") return null; // 顶层非对象/非 null → 失败
  const out: Record<string, BareFieldValue> = {};
  for (const [key, type] of Object.entries(fields)) {
    const v = jsonObjectField(node, key); // 精确优先、其次唯一大小写不敏感；重复键后者胜
    if (v === undefined || v.t === "null") {
      out[key] = defaultBareValue(type);
      continue;
    }
    const d = decodeBareField(type, v);
    if (d === undefined) return null;
    out[key] = d;
  }
  return out;
}

// ==================== POST /v1/sync（peer.go:87-106）====================

export function syncHandler(deps: PeerDeps): ServerHandler {
  return async (req) => {
    const body = decodeBareRequest(req.body, SYNC_MAX_BODY, {
      content_version: "int64",
      merkle_root: "string",
    });
    if (body === null) return jsonResponse(400, { error: "请求体不是合法 JSON" });

    let root: string;
    try {
      root = merkleRoot(listAllBlobIDs(deps.db));
    } catch (err) {
      return errResponse(err);
    }
    const equal = root === (body["merkle_root"] as string);
    return jsonResponse(200, { equal });
  };
}

// ==================== POST /v1/fetch（peer.go:114-198）====================

export function fetchHandler(deps: PeerDeps): ServerHandler {
  const maxBlobs = deps.fetchMaxBlobs > 0 ? deps.fetchMaxBlobs : DEFAULT_FETCH_MAX_BLOBS;
  return async (req) => {
    const body = decodeBareRequest(req.body, FETCH_MAX_BODY, { blob_ids: "string_list" });
    if (body === null) return jsonResponse(400, { error: "请求体不是合法 JSON" });
    const blobIds = body["blob_ids"] as string[];

    if (blobIds.length === 0) return jsonResponse(400, { error: "blob_ids 不能为空" });
    if (blobIds.length > maxBlobs) {
      return jsonResponse(413, { error: `单请求块数超过上限 ${maxBlobs}` });
    }
    for (const id of blobIds) {
      if (!isBlobId(id)) return jsonResponse(400, { error: `非法 blob_id: ${id}` });
    }

    // 反熵护栏 1：被审核删除的块不返回（否则删除会被邻居拉回复活）。
    let revoked: Set<string>;
    try {
      revoked = listRevokedPayloads(deps.db);
    } catch (err) {
      return errResponse(err);
    }

    // 全量预检：存在性 + 去重 + 跳过已撤销 + 累计 size 上限；任一不满足即整体报错，绝不返回半截流。
    const adb = hostDbAsDb(deps.db);
    const found: { id: string; size: number }[] = [];
    const seen = new Set<string>();
    let total = 0;
    for (const id of blobIds) {
      if (seen.has(id)) continue;
      seen.add(id);
      if (revoked.has(id)) continue;
      let ok: boolean;
      let size: number;
      try {
        ({ exists: ok, size } = hasBlob(adb, deps.dataDir, id));
      } catch (err) {
        return errResponse(err);
      }
      if (!ok) continue; // 本节点没有：整帧跳过
      total += size;
      found.push({ id, size });
    }
    if (total > FETCH_MAX_BYTES) {
      return jsonResponse(413, { error: `单请求总字节超过上限 ${FETCH_MAX_BYTES}` });
    }

    // Go 逐帧流式写；本壳 ServerResponse.body 是整段 Uint8Array，故先把全部帧拼成一个缓冲。
    // 帧的字节序列与顺序与 Go 完全一致（writeBlobFrame == protocol.WriteBlobFrame）。
    const frames: Uint8Array[] = [];
    for (const h of found) {
      let data: Uint8Array;
      try {
        data = getBlobBytes(deps.db, deps.dataDir, deps.storeKey, h.id);
      } catch {
        continue; // 读块失败：跳过该帧
      }
      if (blobIdOf(data) !== h.id) continue; // 内容与哈希不符：跳过该帧
      try {
        frames.push(writeBlobFrame(h.id, data));
      } catch {
        break; // 写帧失败（Go 直接 return，停止后续帧）
      }
    }
    let len = 0;
    for (const f of frames) len += f.length;
    const out = new Uint8Array(len);
    let off = 0;
    for (const f of frames) {
      out.set(f, off);
      off += f.length;
    }
    return {
      status: 200,
      headers: {
        "Content-Type": BLOB_PACK_CONTENT_TYPE,
        "Cache-Control": "no-store",
      },
      body: out,
    };
  };
}

// ==================== POST /v1/event-sync（peer.go:243-295）====================

/** eventSyncRequest（peer.go:213-217）：kind string / after{ts int64,id string} / limit int。 */
const EVENT_SYNC_SPEC: StrictSpec = {
  kind: "string",
  after: { ts: "int64", id: "string" },
  limit: "int64",
};

export function eventSyncHandler(deps: PeerDeps): ServerHandler {
  return async (req) => {
    const res = decodeStrictEventSync(req);
    if (!res.ok) return res.resp;
    const { kind, after, limit: rawLimit } = res.value;

    if (kind !== "event" && kind !== "tombstone") {
      return jsonResponse(400, { error: "event_param_invalid" });
    }
    let limit = rawLimit;
    if (limit <= 0) limit = EVENT_SYNC_DEFAULT_LIMIT;
    if (limit > EVENT_SYNC_MAX_LIMIT) limit = EVENT_SYNC_MAX_LIMIT;

    const items: unknown[] = [];
    let next: { ts: number; id: string } | null = null;
    if (kind === "event") {
      let evs;
      try {
        evs = listEventsAfter(deps.db, after.ts, after.id, limit);
      } catch (err) {
        return errResponse(err);
      }
      for (const e of evs) {
        items.push({
          event_id: e.eventId,
          id: e.id,
          type: e.type,
          body_json: e.bodyJson,
          created_at: e.createdAt,
          received_at: e.receivedAt,
        });
      }
      if (evs.length === limit) {
        const last = evs[evs.length - 1];
        next = { ts: last.receivedAt, id: last.eventId };
      }
    } else {
      let ts;
      try {
        ts = listTombstonesAfter(deps.db, after.ts, after.id, limit);
      } catch (err) {
        return errResponse(err);
      }
      for (const t of ts) {
        items.push({
          event_id: t.eventId,
          payload_cid: t.payloadCid,
          reason: t.reason,
          at: t.at,
          received_at: t.receivedAt,
        });
      }
      if (ts.length === limit) {
        const last = ts[ts.length - 1];
        next = { ts: last.receivedAt, id: last.eventId };
      }
    }
    return jsonResponse(200, { items, next });
  };
}

/** 对齐 peer.go:245 的 `s.decodeJSON`（identity.go:40-48）：严格解码，失败 → 400 bad_json。 */
function decodeStrictEventSync(
  req: ServerRequest,
):
  | { ok: true; value: { kind: string; after: { ts: number; id: string }; limit: number } }
  | { ok: false; resp: ServerResponse } {
  const res = decodeStrict(req, EVENT_SYNC_SPEC);
  if (!res.ok) return res;
  const v = res.value;
  return {
    ok: true,
    value: {
      kind: v["kind"] as string,
      after: v["after"] as { ts: number; id: string },
      limit: v["limit"] as number,
    },
  };
}

// ==================== POST /v1/scrub（peer.go:316-334）====================

export function scrubHandler(deps: PeerDeps): ServerHandler {
  return async (req) => {
    const body = decodeBareRequest(req.body, SCRUB_MAX_BODY, { blob_ids: "string_list" });
    if (body === null) return jsonResponse(400, { error: "请求体不是合法 JSON" });
    const blobIds = body["blob_ids"] as string[];

    let checked: number;
    let bad: { blobId: string; reason: string }[];
    try {
      ({ checked, bad } = verifyBlobs(deps.db, deps.dataDir, deps.storeKey, blobIds));
    } catch (err) {
      return errResponse(err);
    }
    return jsonResponse(200, {
      checked,
      repaired: 0, // 恒为 0：跨节点补齐走出站 fetch，本包不依赖 peersync
      dropped: bad.length,
      bad: bad.map((b) => ({ blob_id: b.blobId, reason: b.reason })),
    });
  };
}

// ==================== 装配（peer.go / server.go:159-165 的 mountInternal）====================

/** 注册入站五路由到传入 adapter（**内部路由**，只应挂对端监听）。 */
export function mountPeerRoutes(adapter: HttpServerAdapter, deps: PeerDeps): void {
  adapter.handle("GET /v1/inventory", inventoryHandler(deps));
  adapter.handle("POST /v1/sync", syncHandler(deps));
  adapter.handle("POST /v1/fetch", fetchHandler(deps));
  adapter.handle("POST /v1/scrub", scrubHandler(deps));
  adapter.handle("POST /v1/event-sync", eventSyncHandler(deps));
}