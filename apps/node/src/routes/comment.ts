// 逐行对齐 internal/httpapi/comment.go 的 handleCommentList / parseCommentCursor（:16-85）。
import type { ServerHandler } from "@base/core-ts";
import type { Db } from "../db";
import { likeCountsByTargets } from "../store/like";
import { isHexN, parseGoInt, parseGoInt64, toStr } from "./derived";
import { jsonResponse } from "./json";

const COMMENT_DEFAULT_LIMIT = 30;
const COMMENT_MAX_LIMIT = 100;

interface CommentRow {
  eventId: string;
  actor: string;
  targetId: string;
  payloadCid: string;
  replyTo: string;
  createdAt: number;
}

/** ListComments（store/comment.go:58-108）：按 (created_at,event_id) 倒序分页，联表排除墓碑。
 *  kind/targetId 为空不过滤；kind 匹配 items.type（不看 state），无 items 行的 target 按 id 前缀兜底（改版册子 §2.2）。 */
function listComments(
  db: Db,
  kind: string,
  targetId: string,
  cursorTS: number,
  cursorID: string,
  limit: number,
): CommentRow[] {
  if (limit <= 0) limit = 30;
  let q = `SELECT e.event_id,e.id,e.target_id,e.payload_cid,e.reply_to,e.created_at
    FROM events e
    WHERE e.type='comment.v1'
      AND NOT EXISTS (SELECT 1 FROM comment_tombstone t WHERE t.event_id=e.event_id)`;
  const args: unknown[] = [];
  if (kind !== "") {
    // 有 items 行按 items.type 匹配；无 items 行的 target 按 id 前缀兜底
    //（评论数据独立于条目存亡，kind 过滤不得藏掉这类评论——改版册子 §2.2）。
    q += ` AND (EXISTS (SELECT 1 FROM items i WHERE i.item_id=e.target_id AND i.type=?)
      OR (NOT EXISTS (SELECT 1 FROM items i WHERE i.item_id=e.target_id) AND e.target_id LIKE ? || '/%'))`;
    args.push(kind, kind);
  }
  if (targetId !== "") {
    q += ` AND e.target_id=?`;
    args.push(targetId);
  }
  if (cursorID !== "") {
    q += ` AND (e.created_at < ? OR (e.created_at = ? AND e.event_id < ?))`;
    args.push(cursorTS, cursorTS, cursorID);
  }
  q += ` ORDER BY e.created_at DESC, e.event_id DESC LIMIT ?`;
  args.push(limit);

  const rows = db.select(q, args);
  return rows.map((r) => ({
    eventId: toStr(r.event_id),
    actor: toStr(r.id),
    targetId: toStr(r.target_id),
    payloadCid: toStr(r.payload_cid),
    replyTo: toStr(r.reply_to),
    createdAt: Number(r.created_at ?? 0),
  }));
}

/** 解析不透明游标 `<created_at>_<event_id>`；非法值按首页处理（无游标）。 */
export function parseCommentCursor(raw: string): { ts: number; id: string } {
  if (raw === "") return { ts: 0, id: "" };
  const idx = raw.indexOf("_");
  if (idx < 0) return { ts: 0, id: "" };
  const id = raw.slice(idx + 1);
  if (!isHexN(id, 16)) return { ts: 0, id: "" };
  const ts = parseGoInt64(raw.slice(0, idx));
  if (ts === null) return { ts: 0, id: "" };
  return { ts, id };
}

/** 匿名分页读评论索引（册子 §4.2）；正文由客户端另取 GET /v1/blob/{payload_cid}。 */
export function commentHandler(db: Db): ServerHandler {
  return async (req) => {
    try {
      const limitRaw = req.query.limit ?? "";
      let limit = COMMENT_DEFAULT_LIMIT;
      if (limitRaw !== "") {
        const n = parseGoInt(limitRaw);
        if (n !== null && n > 0 && n <= COMMENT_MAX_LIMIT) limit = n;
      }
      const cur = parseCommentCursor(req.query.cursor ?? "");
      const rows = listComments(db, req.query.kind ?? "", req.query.target_id ?? "", cur.ts, cur.id, limit);

      // #79 §5.1：按页聚合 like_count（禁 N+1），无赞行 map 缺键按 0 填。
      const targets = rows.map((c) => c.eventId);
      const likeMap = likeCountsByTargets(db, targets);
      const comments = rows.map((c) => ({
        event_id: c.eventId,
        actor: c.actor,
        target_id: c.targetId,
        payload_cid: c.payloadCid,
        reply_to: c.replyTo === "" ? null : c.replyTo,
        created_at: c.createdAt,
        like_count: likeMap.get(c.eventId) ?? 0,
      }));

      // 满页才给游标：不满页即已到底。
      let nextCursor: string | null = null;
      if (rows.length === limit) {
        const last = rows[rows.length - 1];
        nextCursor = `${last.createdAt}_${last.eventId}`;
      }
      return jsonResponse(200, { comments, next_cursor: nextCursor });
    } catch (err) {
      return jsonResponse(500, { error: err instanceof Error ? err.message : String(err) });
    }
  };
}

/** CommentTargetRow（store/comment.go ListCommentTargets）：只含 active 条目，墓碑同口径排除。 */
interface CommentTargetRow {
  targetId: string;
  kind: string;
  title: string;
  count: number;
  lastAt: number;
}

function listCommentTargets(db: Db): CommentTargetRow[] {
  const rows = db.select(
    `SELECT e.target_id, i.type AS kind, i.title, COUNT(*) AS cnt, MAX(e.created_at) AS last_at
      FROM events e
      JOIN items i ON i.item_id = e.target_id AND i.state='active'
      WHERE e.type='comment.v1'
        AND NOT EXISTS (SELECT 1 FROM comment_tombstone t WHERE t.event_id=e.event_id)
      GROUP BY e.target_id
      ORDER BY last_at DESC, e.target_id DESC`,
    [],
  );
  return rows.map((r) => ({
    targetId: toStr(r.target_id),
    kind: toStr(r.kind),
    title: toStr(r.title),
    count: Number(r.cnt ?? 0),
    lastAt: Number(r.last_at ?? 0),
  }));
}

/** 匿名聚合读（改版册子 §2.1）；JSON 键序与 Go commentTargetDTO 一致。 */
export function commentTargetsHandler(db: Db): ServerHandler {
  return async () => {
    try {
      const targets = listCommentTargets(db).map((t) => ({
        target_id: t.targetId,
        kind: t.kind,
        title: t.title,
        count: t.count,
        last_at: t.lastAt,
      }));
      return jsonResponse(200, { targets });
    } catch (err) {
      return jsonResponse(500, { error: err instanceof Error ? err.message : String(err) });
    }
  };
}
