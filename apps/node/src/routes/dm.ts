// 逐行对齐 internal/httpapi/dm.go 的 handleDMGet（:106-153）。
import type { ServerHandler } from "@base/core-ts";
import type { Db } from "../db";
import { isHexN, parseGoInt, toStr } from "./derived";
import { parseCommentCursor } from "./comment";
import { jsonResponse } from "./json";

const DM_DEFAULT_LIMIT = 30;
const DM_MAX_LIMIT = 100;

interface DmEvent {
  eventId: string;
  actor: string;
  createdAt: number;
  payloadCid: string;
}

/** ListDMEvents（store/dm.go:6-32）：按 (created_at,event_id) 倒序分页读发给 peer 的 dm.v1。 */
function listDMEvents(
  db: Db,
  peerId: string,
  cursorTS: number,
  cursorID: string,
  limit: number,
): DmEvent[] {
  if (limit <= 0) limit = 30;
  let q = `SELECT event_id,id,type,body_json,created_at,received_at,target_id,payload_cid,reply_to
    FROM events WHERE type='dm.v1' AND target_id=?`;
  const args: unknown[] = ["dm/" + peerId];
  if (cursorID !== "") {
    q += ` AND (created_at < ? OR (created_at = ? AND event_id < ?))`;
    args.push(cursorTS, cursorTS, cursorID);
  }
  q += ` ORDER BY created_at DESC, event_id DESC LIMIT ?`;
  args.push(limit);

  const rows = db.select(q, args);
  return rows.map((r) => ({
    eventId: toStr(r.event_id),
    actor: toStr(r.id),
    createdAt: Number(r.created_at ?? 0),
    payloadCid: toStr(r.payload_cid),
  }));
}

/**
 * 匿名分页读「所有人发给 peer_id 的私信索引」；无 404 分支，查无即空数组。
 * 游标与 GET /v1/comment 同口径（复用 parseCommentCursor）。
 */
export function dmHandler(db: Db): ServerHandler {
  return async (req) => {
    const peerId = req.params.peer_id ?? "";
    if (!isHexN(peerId, 16)) {
      return jsonResponse(400, { error: "event_param_invalid" });
    }
    try {
      const limitRaw = req.query.limit ?? "";
      let limit = DM_DEFAULT_LIMIT;
      if (limitRaw !== "") {
        const n = parseGoInt(limitRaw);
        if (n !== null && n > 0 && n <= DM_MAX_LIMIT) limit = n;
      }
      const cur = parseCommentCursor(req.query.cursor ?? "");
      const rows = listDMEvents(db, peerId, cur.ts, cur.id, limit);

      const events = rows.map((e) => ({
        event_id: e.eventId,
        actor: e.actor,
        created_at: e.createdAt,
        payload_cid: e.payloadCid,
      }));

      // 满页才给游标：与 GET /v1/comment 同口径。
      let nextCursor: string | null = null;
      if (rows.length === limit) {
        const last = rows[rows.length - 1];
        nextCursor = `${last.createdAt}_${last.eventId}`;
      }
      return jsonResponse(200, { events, next_cursor: nextCursor });
    } catch (err) {
      return jsonResponse(500, { error: err instanceof Error ? err.message : String(err) });
    }
  };
}
