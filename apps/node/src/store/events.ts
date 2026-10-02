// 事件/块写读层：逐行对齐 internal/store 的 event.go / progress.go / store.go 的
// PutEvent / GetEventByID / IsRevokedEvent / PutProgressProjection / PutBlob / HasBlob。
import { mkdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { blobId as blobIdOf, isBlobId, progressWins } from "@base/protocol-ts";
import type { Db } from "../db";
import { encrypt } from "../host/aesgcm";

export interface EventRow {
  eventId: string;
  id: string;
  type: string;
  bodyJson: string;
  createdAt: number;
  receivedAt: number;
  targetId: string;
  payloadCid: string;
  replyTo: string;
}

/** `time.Now().UTC().Format(time.RFC3339)`：无毫秒。 */
function nowUTC(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

function toStr(value: unknown): string {
  return value == null ? "" : String(value);
}

/**
 * PutEvent（event.go:25-37）：同 event_id 覆盖，**received_at 保留首次值**。
 * 空串字段照传 ""（不是 NULL），供 GET 侧「空串 → null」口径复用。
 */
export function putEvent(db: Db, e: EventRow): void {
  let receivedAt = e.receivedAt;
  if (receivedAt === 0) receivedAt = Date.now();
  db.execute(
    `INSERT INTO events(event_id,id,type,body_json,created_at,received_at,target_id,payload_cid,reply_to)
		VALUES(?,?,?,?,?,?,?,?,?)
		ON CONFLICT(event_id) DO UPDATE SET
			id=excluded.id, type=excluded.type, body_json=excluded.body_json, created_at=excluded.created_at,
			target_id=excluded.target_id, payload_cid=excluded.payload_cid, reply_to=excluded.reply_to`,
    [
      e.eventId,
      e.id,
      e.type,
      e.bodyJson,
      e.createdAt,
      receivedAt,
      e.targetId,
      e.payloadCid,
      e.replyTo,
    ],
  );
}

/** GetEventByID（event.go:80-90）：读单条事件；无行返回 null。 */
export function getEventById(db: Db, eventId: string): EventRow | null {
  const rows = db.select(
    `SELECT event_id,id,type,body_json,created_at,received_at,target_id,payload_cid,reply_to
		FROM events WHERE event_id=?`,
    [eventId],
  );
  if (rows.length === 0) return null;
  const r = rows[0];
  return {
    eventId: toStr(r.event_id),
    id: toStr(r.id),
    type: toStr(r.type),
    bodyJson: toStr(r.body_json),
    createdAt: Number(r.created_at ?? 0),
    receivedAt: Number(r.received_at ?? 0),
    targetId: toStr(r.target_id),
    payloadCid: toStr(r.payload_cid),
    replyTo: toStr(r.reply_to),
  };
}

/** IsRevokedEvent（comment.go:130-140）：该事件是否已被审核删除。 */
export function isRevokedEvent(db: Db, eventId: string): boolean {
  const rows = db.select(`SELECT 1 FROM comment_tombstone WHERE event_id=? LIMIT 1`, [eventId]);
  return rows.length > 0;
}

/**
 * HasCommentEvent（tag.go:186-190）：event_id 是否为本节点已收到的 comment.v1 事件。
 * 硬过滤 type='comment.v1'：② 类（group.v1 / dm.v1）由此**天然被排除**（册子 §3.7 红线）。
 */
export function hasCommentEvent(db: Db, eventId: string): boolean {
  const rows = db.select(`SELECT 1 FROM events WHERE type='comment.v1' AND event_id=?`, [eventId]);
  return rows.length > 0;
}

export interface ProgressProjection {
  id: string;
  itemId: string;
  position: number;
  done: boolean;
  day: string;
  createdAt: number;
  eventId: string;
}

/**
 * PutProgressProjection（progress.go:53-88）：progress + checkin_days **同事务**写。
 * progress 按 LWW 收敛（同 event_id 重放幂等；输了静默 no-op）；
 * checkin_days 恒 insert-or-ignore，**即使 progress 输了也要写**。
 */
export function putProgressProjection(db: Db, e: ProgressProjection): void {
  db.execute("BEGIN");
  try {
    db.execute(
      `INSERT INTO checkin_days(id,day,first_event_id,created_at)
		VALUES(?,?,?,?) ON CONFLICT(id,day) DO NOTHING`,
      [e.id, e.day, e.eventId, e.createdAt],
    );
    const prev = db.select(`SELECT updated_at, event_id FROM progress WHERE id=? AND item_id=?`, [
      e.id,
      e.itemId,
    ]);
    if (prev.length === 0) {
      db.execute(
        `INSERT INTO progress(id,item_id,position,done,day,updated_at,event_id,dirty)
		VALUES(?,?,?,?,?,?,?,0)`,
        [e.id, e.itemId, e.position, e.done ? 1 : 0, e.day, e.createdAt, e.eventId],
      );
    } else if (toStr(prev[0].event_id) === e.eventId) {
      // 同一条事件重放：幂等，什么都不做。
    } else if (
      progressWins(e.createdAt, e.eventId, Number(prev[0].updated_at ?? 0), toStr(prev[0].event_id))
    ) {
      db.execute(
        `UPDATE progress SET position=?,done=?,day=?,updated_at=?,event_id=?
		WHERE id=? AND item_id=?`,
        [e.position, e.done ? 1 : 0, e.day, e.createdAt, e.eventId, e.id, e.itemId],
      );
    }
    db.execute("COMMIT");
  } catch (err) {
    db.execute("ROLLBACK");
    throw err;
  }
}

/** BlobPath（store.go:184-186）：<dataDir>/blobs/<b[0:2]>/<b[2:4]>/<blob_id>。 */
function blobPath(dataDir: string, blobId: string): string {
  return join(dataDir, "blobs", blobId.slice(0, 2), blobId.slice(2, 4), blobId);
}

/**
 * PutBlob（store.go:331-355）：blob_id 在**明文**上校验，落盘的是密文，blobs.size 记明文长度。
 */
export function putBlob(
  db: Db,
  dataDir: string,
  storeKey: Uint8Array | null,
  blobId: string,
  data: Uint8Array,
  itemId: string,
  seq: number,
): void {
  if (!isBlobId(blobId)) {
    throw new Error(`store: invalid blob id ${JSON.stringify(blobId)}`);
  }
  if (blobIdOf(data) !== blobId) {
    throw new Error(`store: blob id mismatch: ${blobIdOf(data)} != ${blobId}`);
  }
  if (storeKey === null) {
    throw new Error(`store: encrypt blob ${blobId}: 无 store 密钥`);
  }
  const enc = encrypt(storeKey, data);
  const p = blobPath(dataDir, blobId);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, enc);
  db.execute(
    `INSERT INTO blobs(blob_id,size,item_id,seq,created_at) VALUES(?,?,?,?,?)
		ON CONFLICT(blob_id) DO UPDATE SET item_id=excluded.item_id, seq=excluded.seq`,
    [blobId, data.byteLength, itemId, seq, nowUTC()],
  );
}

/**
 * HasBlob（store.go:360-379）：先查 blobs 表取**明文** size，再 statSync 确认文件存在。
 * 无行或文件缺失 → 不存在。
 */
export function hasBlob(
  db: Db,
  dataDir: string,
  blobId: string,
): { exists: boolean; size: number } {
  if (!isBlobId(blobId)) {
    throw new Error(`store: invalid blob id ${JSON.stringify(blobId)}`);
  }
  const rows = db.select(`SELECT size FROM blobs WHERE blob_id=?`, [blobId]);
  if (rows.length === 0) return { exists: false, size: 0 };
  const size = Number(rows[0].size ?? 0);
  try {
    statSync(blobPath(dataDir, blobId));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { exists: false, size: 0 };
    throw err;
  }
  return { exists: true, size };
}