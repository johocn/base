// 对端同步·反熵 store 层：逐行对齐 internal/store 的
// blobs.go（ListBlobsPage/ListAllBlobIDs/ContentVersion/DeleteBlobFile/DeleteBlob/MediaChunkIndex）、
// replica.go（UpsertBlobReplica/ReplicaPeers/CountBlobsWithoutReplica）、scrub.go（VerifyBlobs）、
// comment.go（EventBlobIndex/PutCommentTombstone/IsRevokedPayload/ListRevokedPayloads/
// ListTombstonesAfter/GetPeerCursor/PutPeerCursor）、event.go（ListEventsAfter）与 store.go（GetBlobBytes）。
//
// SQL 文本逐字照抄 Go（含换行与制表符）。PutBlob/HasBlob 复用 events.ts（签名用 Db），
// 此处只做一个极小的 HostDb → Db 适配，不复制逻辑。
import { readFileSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { normalizeChunkID } from "@base/core-ts";
import { blobId as blobIdOf, isBlobId } from "@base/protocol-ts";
import type { Db } from "../db";
import { decrypt } from "../host/aesgcm";
import type { HostDb, SqlValue } from "../host/sqlite";
import { hasBlob, putBlob, type EventRow } from "./events";

export { hasBlob, putBlob };

/** 块引用（store.go:103-108 的 BlobRef）；ListBlobsPage 不回传 item_id，故为空串。 */
export interface BlobRef {
  blobId: string;
  seq: number;
  size: number;
  itemId: string;
}

/** 校验失败的块（scrub.go:11-14 的 BadBlob）。reason = hash_mismatch | missing。 */
export interface BadBlob {
  blobId: string;
  reason: string;
}

/** 审核删除墓碑（comment.go:95-101 的 CommentTombstone）。 */
export interface CommentTombstone {
  eventId: string;
  payloadCid: string;
  reason: string;
  at: number;
  receivedAt: number;
}

/** HostDb → Db 适配：仅为复用 events.ts 的 putBlob / hasBlob。 */
export function hostDbAsDb(db: HostDb): Db {
  return {
    select: (sql, params = []) => db.all(sql, params as SqlValue[]),
    execute: (sql, params = []) => db.run(sql, params as SqlValue[]),
    close: () => {},
  };
}

function toStr(value: unknown): string {
  return value == null ? "" : String(value);
}

function toNum(value: unknown): number {
  return value == null ? 0 : Number(value);
}

/** BlobPath（store.go:184-186）：<dataDir>/blobs/<b[0:2]>/<b[2:4]>/<blob_id>。 */
function blobPath(dataDir: string, blobId: string): string {
  return join(dataDir, "blobs", blobId.slice(0, 2), blobId.slice(2, 4), blobId);
}

function isENOENT(err: unknown): boolean {
  return (err as NodeJS.ErrnoException).code === "ENOENT";
}

/** MetaString（store.go:556-562）：读 meta；不存在或出错时返回 def。 */
function metaString(db: HostDb, key: string, def: string): string {
  try {
    const row = db.get(`SELECT value FROM meta WHERE key=?`, [key]);
    if (row === undefined) return def;
    return String(row.value);
  } catch {
    return def;
  }
}

const INT_RE = /^[+-]?[0-9]+$/;

/** Go `strconv.ParseInt(raw,10,64)`：空串/非法字符/越界一律抛错。 */
function parseInt64Go(raw: string): number {
  const bad = (): never => {
    throw new Error(`store: bad content_version ${JSON.stringify(raw)}`);
  };
  if (!INT_RE.test(raw)) bad();
  const body = raw.startsWith("+") ? raw.slice(1) : raw;
  const n = BigInt(body);
  if (n < -(2n ** 63n) || n > 2n ** 63n - 1n) bad();
  return Number(n);
}

/** ListBlobsPage（blobs.go:14-39）：按 blob_id 升序（cursor 独占）分页；next 为空表示没有下一页。 */
export function listBlobsPage(
  db: HostDb,
  cursor: string,
  limit: number,
): { refs: BlobRef[]; next: string } {
  let lim = limit;
  if (lim <= 0) lim = 500;
  const rows = db.all(
    `SELECT blob_id,seq,size FROM blobs WHERE blob_id > ? ORDER BY blob_id ASC LIMIT ?`,
    [cursor, lim],
  );
  const refs: BlobRef[] = rows.map((r) => ({
    blobId: toStr(r.blob_id),
    seq: toNum(r.seq),
    size: toNum(r.size),
    itemId: "",
  }));
  let next = "";
  if (refs.length === lim) next = refs[refs.length - 1].blobId;
  return { refs, next };
}

/** ListAllBlobIDs（blobs.go:42-57）：全部 blob_id（升序）。 */
export function listAllBlobIDs(db: HostDb): string[] {
  const rows = db.all(`SELECT blob_id FROM blobs ORDER BY blob_id ASC`);
  return rows.map((r) => toStr(r.blob_id));
}

/**
 * ContentVersion（blobs.go:61-68）：全局 content_version；无记录时为 0，非法值抛错。
 * 这是唯一的水位读法：反熵会话与 inventory 都靠它判定「是否需要拉包」。
 */
export function contentVersion(db: HostDb): number {
  return parseInt64Go(metaString(db, "content_version", "0"));
}

/** DeleteBlobFile（blobs.go:71-79）：删块文件本体；文件不存在视为成功（幂等）。 */
export function deleteBlobFile(db: HostDb, dataDir: string, blobId: string): void {
  if (!isBlobId(blobId)) {
    throw new Error(`store: invalid blob id ${JSON.stringify(blobId)}`);
  }
  try {
    unlinkSync(blobPath(dataDir, blobId));
  } catch (err) {
    if (!isENOENT(err)) throw err;
  }
}

/** DeleteBlob（blobs.go:82-88）：删块文件与 blobs 行。 */
export function deleteBlob(db: HostDb, dataDir: string, blobId: string): void {
  deleteBlobFile(db, dataDir, blobId);
  db.run(`DELETE FROM blobs WHERE blob_id=?`, [blobId]);
}

/** deleteBlobRow（scrub.go:68-71）。 */
function deleteBlobRow(db: HostDb, blobId: string): void {
  db.run(`DELETE FROM blobs WHERE blob_id=?`, [blobId]);
}

/** json.Unmarshal 语义：非法 JSON / 非字符串数组一律抛错（null → 空数组）。 */
function parseChunkHashes(itemId: string, raw: string): string[] {
  const detail = (d: string): string => `store: media_meta ${itemId} 的 chunk_hashes_json 非法: ${d}`;
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch (err) {
    throw new Error(detail(String(err)));
  }
  if (v === null) return [];
  if (!Array.isArray(v)) throw new Error(detail("不是 JSON 数组"));
  for (const x of v) {
    if (typeof x !== "string") throw new Error(detail("数组元素不是字符串"));
  }
  return v as string[];
}

/**
 * MediaChunkIndex（blobs.go:95-123）：blob_id → 所属条目与 seq，来源是各 media_meta 的
 * chunk_hashes_json（数组下标即 seq）。同一字节被多条引用时保留**先到者**的归属。
 */
export function mediaChunkIndex(db: HostDb): Record<string, BlobRef> {
  const rows = db.all(`SELECT item_id,chunk_hashes_json FROM media_meta`);
  const out: Record<string, BlobRef> = {};
  for (const r of rows) {
    const itemId = toStr(r.item_id);
    const hashes = parseChunkHashes(itemId, toStr(r.chunk_hashes_json));
    hashes.forEach((raw, seq) => {
      const id = normalizeChunkID(raw);
      if (!isBlobId(id)) return;
      if (Object.prototype.hasOwnProperty.call(out, id)) return;
      out[id] = { blobId: id, seq, size: 0, itemId };
    });
  }
  return out;
}

/** UpsertBlobReplica（replica.go:10-17）：登记 peer 声明持有该块，seen_at 刷新为当前值。 */
export function upsertBlobReplica(db: HostDb, blobId: string, peer: string, seenAt: number): void {
  if (!isBlobId(blobId)) {
    throw new Error(`store: invalid blob id ${JSON.stringify(blobId)}`);
  }
  db.run(
    `INSERT INTO blob_replicas(blob_id,peer,seen_at) VALUES(?,?,?)
\t\tON CONFLICT(blob_id,peer) DO UPDATE SET seen_at=excluded.seen_at`,
    [blobId, peer, seenAt],
  );
}

/** ReplicaPeers（replica.go:20-35）：声明持有该块的 peer 列表（升序）。 */
export function replicaPeers(db: HostDb, blobId: string): string[] {
  const rows = db.all(`SELECT peer FROM blob_replicas WHERE blob_id=? ORDER BY peer ASC`, [blobId]);
  return rows.map((r) => toStr(r.peer));
}

/** CountBlobsWithoutReplica（replica.go:39-44）：本地持有但无任何 peer 声明的块数。 */
export function countBlobsWithoutReplica(db: HostDb): number {
  const row = db.get(`SELECT COUNT(*) FROM blobs b
\t\tWHERE NOT EXISTS(SELECT 1 FROM blob_replicas r WHERE r.blob_id=b.blob_id)`);
  return toNum(row?.n ?? row?.["COUNT(*)"] ?? 0);
}

/**
 * VerifyBlobs（scrub.go:23-66）：逐块重算哈希并清理坏块；blobIds 为空表示全量。
 *   - 文件不存在但 blobs 行存在 → 删行，记 missing；
 *   - 文件存在但重算哈希与 id 不符（或解不开）→ 删文件与行，记 hash_mismatch。
 */
export function verifyBlobs(
  db: HostDb,
  dataDir: string,
  storeKey: Uint8Array,
  blobIds: readonly string[],
): { checked: number; bad: BadBlob[] } {
  let ids = blobIds;
  if (ids.length === 0) ids = listAllBlobIDs(db);
  let checked = 0;
  const bad: BadBlob[] = [];
  for (const id of ids) {
    if (!isBlobId(id)) continue;
    try {
      statSync(blobPath(dataDir, id));
    } catch (err) {
      if (!isENOENT(err)) throw err;
      deleteBlobRow(db, id);
      bad.push({ blobId: id, reason: "missing" });
      continue;
    }
    checked++;
    let data: Uint8Array;
    try {
      data = getBlobBytes(db, dataDir, storeKey, id);
    } catch {
      deleteBlob(db, dataDir, id);
      bad.push({ blobId: id, reason: "hash_mismatch" });
      continue;
    }
    if (blobIdOf(data) !== id) {
      deleteBlob(db, dataDir, id);
      bad.push({ blobId: id, reason: "hash_mismatch" });
    }
  }
  return { checked, bad };
}

/**
 * EventBlobIndex（comment.go:66-92）：事件正文块 → 归属事件，来源是 events.payload_cid。
 * type 白名单 = comment.v1 / group.v1 / dm.v1；itemId 前缀分别是 comment: / group: / dm:。
 */
export function eventBlobIndex(db: HostDb): Record<string, BlobRef> {
  const rows = db.all(`SELECT type,event_id,payload_cid FROM events
\t\tWHERE type IN ('comment.v1','group.v1','dm.v1') AND payload_cid IS NOT NULL AND payload_cid<>''`);
  const out: Record<string, BlobRef> = {};
  for (const r of rows) {
    const typ = toStr(r.type);
    const eventId = toStr(r.event_id);
    const cid = toStr(r.payload_cid);
    if (Object.prototype.hasOwnProperty.call(out, cid)) continue;
    let prefix = "comment:";
    if (typ === "group.v1") prefix = "group:";
    else if (typ === "dm.v1") prefix = "dm:";
    out[cid] = { blobId: cid, seq: 0, size: 0, itemId: prefix + eventId };
  }
  return out;
}

/** PutCommentTombstone（comment.go:104-114）：幂等 upsert；received_at 保留首次值。 */
export function putCommentTombstone(db: HostDb, t: CommentTombstone): void {
  const receivedAt = t.receivedAt === 0 ? Date.now() : t.receivedAt;
  db.run(
    `INSERT INTO comment_tombstone(event_id,payload_cid,reason,at,received_at)
\t\tVALUES(?,?,?,?,?)
\t\tON CONFLICT(event_id) DO UPDATE SET
\t\t\tpayload_cid=excluded.payload_cid, reason=excluded.reason, at=excluded.at`,
    [t.eventId, t.payloadCid, t.reason, t.at, receivedAt],
  );
}

/** IsRevokedPayload（comment.go:117-127）：某块是否被评论墓碑撤销。 */
export function isRevokedPayload(db: HostDb, cid: string): boolean {
  const row = db.get(`SELECT 1 FROM comment_tombstone WHERE payload_cid=? LIMIT 1`, [cid]);
  return row !== undefined;
}

/** ListRevokedPayloads（comment.go:143-158）：全部被撤销的块 id（Go 为 map[string]struct{}）。 */
export function listRevokedPayloads(db: HostDb): Set<string> {
  const rows = db.all(`SELECT DISTINCT payload_cid FROM comment_tombstone`);
  const out = new Set<string>();
  for (const r of rows) out.add(toStr(r.payload_cid));
  return out;
}

/** ListTombstonesAfter（comment.go:161-185）：按 (received_at, event_id) 复合游标增量读墓碑。 */
export function listTombstonesAfter(
  db: HostDb,
  ts: number,
  id: string,
  limit: number,
): CommentTombstone[] {
  let lim = limit;
  if (lim <= 0) lim = 200;
  const rows = db.all(
    `SELECT event_id,payload_cid,reason,at,received_at FROM comment_tombstone
\t\tWHERE received_at > ? OR (received_at = ? AND event_id > ?)
\t\tORDER BY received_at ASC, event_id ASC LIMIT ?`,
    [ts, ts, id, lim],
  );
  return rows.map((r) => ({
    eventId: toStr(r.event_id),
    payloadCid: toStr(r.payload_cid),
    reason: toStr(r.reason),
    at: toNum(r.at),
    receivedAt: toNum(r.received_at),
  }));
}

/** GetPeerCursor（comment.go:188-201）：读对某 peer 某 kind 的事件增量游标；无记录返回零值。 */
export function getPeerCursor(db: HostDb, peer: string, kind: string): { ts: number; id: string } {
  const row = db.get(`SELECT cursor_ts,cursor_id FROM peer_sync_cursor WHERE peer=? AND kind=?`, [
    peer,
    kind,
  ]);
  if (row === undefined) return { ts: 0, id: "" };
  return { ts: toNum(row.cursor_ts), id: toStr(row.cursor_id) };
}

/**
 * PutPeerCursor（comment.go:206-220）：持久化事件增量游标。
 * 护栏（§3.5）：新游标未严格大于旧游标（时钟回拨或对端旧值）时只把 ts 抬到 oldTS+1，
 * 保证单调推进且不跳过同一毫秒内的后续行。
 */
export function putPeerCursor(
  db: HostDb,
  peer: string,
  kind: string,
  ts: number,
  id: string,
): void {
  const old = getPeerCursor(db, peer, kind);
  let nextTS = ts;
  if (ts < old.ts || (ts === old.ts && id <= old.id)) nextTS = old.ts + 1;
  db.run(
    `INSERT INTO peer_sync_cursor(peer,kind,cursor_ts,cursor_id,updated_at)
\t\tVALUES(?,?,?,?,?)
\t\tON CONFLICT(peer,kind) DO UPDATE SET
\t\t\tcursor_ts=excluded.cursor_ts, cursor_id=excluded.cursor_id, updated_at=excluded.updated_at`,
    [peer, kind, nextTS, id, Date.now()],
  );
}

/** ListEventsAfter（event.go:93-113）：按 (received_at, event_id) 复合游标增量读事件，严格大于。 */
export function listEventsAfter(
  db: HostDb,
  ts: number,
  id: string,
  limit: number,
): EventRow[] {
  let lim = limit;
  if (lim <= 0) lim = 200;
  const rows = db.all(
    `SELECT event_id,id,type,body_json,created_at,received_at,target_id,payload_cid,reply_to FROM events
\t\tWHERE received_at > ? OR (received_at = ? AND event_id > ?)
\t\tORDER BY received_at ASC, event_id ASC LIMIT ?`,
    [ts, ts, id, lim],
  );
  return rows.map((r) => ({
    eventId: toStr(r.event_id),
    id: toStr(r.id),
    type: toStr(r.type),
    bodyJson: toStr(r.body_json),
    createdAt: toNum(r.created_at),
    receivedAt: toNum(r.received_at),
    targetId: toStr(r.target_id),
    payloadCid: toStr(r.payload_cid),
    replyTo: toStr(r.reply_to),
  }));
}

/** GetBlobBytes（store.go:382-395）：读块文件并解密（storeKey），返回明文。 */
export function getBlobBytes(
  db: HostDb,
  dataDir: string,
  storeKey: Uint8Array,
  blobId: string,
): Uint8Array {
  if (!isBlobId(blobId)) {
    throw new Error(`store: invalid blob id ${JSON.stringify(blobId)}`);
  }
  const raw = readFileSync(blobPath(dataDir, blobId));
  try {
    return decrypt(storeKey, new Uint8Array(raw));
  } catch (err) {
    throw new Error(`store: decrypt blob ${blobId}: ${String(err)}`);
  }
}