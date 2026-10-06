// #79 §4：点赞/举报的即时聚合计数（方案 A，零新表）。
// SQL 与 internal/store/like.go 的 LikeCountsByTargets / ListReportedComments 逐字同口径；
// 依赖 idx_events_type_target(type, target_id)（store/schema.ts），按页聚合禁 N+1。
import type { Db } from "../db";

function toStr(value: unknown): string {
  return value == null ? "" : String(value);
}

/**
 * LikeCountsByTargets（store/like.go:15-46）对一批 target（评论 event_id 或条目 item_id）各算 like_count：
 * 同 (id, target_id) 取 (created_at, event_id) 最大者为最新状态，计数 = 最新为 like 的去重 actor 数。
 * 无赞 target 不在返回 map 中（调用方按 0 处理）。
 */
export function likeCountsByTargets(db: Db, targets: string[]): Map<string, number> {
  const out = new Map<string, number>();
  if (targets.length === 0) return out;
  const ph = targets.map(() => "?").join(",");
  const rows = db.select(
    `SELECT target_id, COUNT(DISTINCT id) AS cnt FROM events e
		WHERE e.type='like.v1' AND e.target_id IN (${ph})
		  AND json_extract(e.body_json,'$.action')='like'
		  AND NOT EXISTS (SELECT 1 FROM events e2
			WHERE e2.type='like.v1' AND e2.id=e.id AND e2.target_id=e.target_id
			  AND (e2.created_at > e.created_at
			       OR (e2.created_at = e.created_at AND e2.event_id > e.event_id)))
		GROUP BY target_id`,
    targets,
  );
  for (const r of rows) out.set(toStr(r.target_id), Number(r.cnt ?? 0));
  return out;
}

/** ReportedCommentRow 是 POST /v1/admin/review/reported 的一行：被举报评论 + 聚合举报数。 */
export interface ReportedCommentRow {
  eventId: string;
  actor: string;
  targetId: string;
  payloadCid: string;
  replyTo: string;
  createdAt: number;
  /** 去重举报人数（#79 §4.2）。 */
  reportCount: number;
  /** 去重举报人 id。 */
  reporters: string[];
}

/**
 * ListReportedComments（store/like.go:72-107）被举报评论列表（#79 §5.3）：
 * 内联评论事件已同步到本地（JOIN）且未墓碑；report_count 降序、次键 (created_at, event_id) 降序。
 */
export function listReportedComments(db: Db): ReportedCommentRow[] {
  const rows = db.select(
    `SELECT t.event_id, t.id, t.target_id, t.payload_cid, t.reply_to, t.created_at,
		COUNT(DISTINCT r.id) AS report_count, GROUP_CONCAT(DISTINCT r.id) AS reporters
		FROM events r
		JOIN events t ON t.event_id = r.target_id AND t.type='comment.v1'
		WHERE r.type='report.v1'
		  AND NOT EXISTS (SELECT 1 FROM comment_tombstone tb WHERE tb.event_id=t.event_id)
		GROUP BY t.event_id
		ORDER BY report_count DESC, t.created_at DESC, t.event_id DESC`,
  );
  const out: ReportedCommentRow[] = [];
  for (const r of rows) {
    const ids = toStr(r.reporters);
    out.push({
      eventId: toStr(r.event_id),
      actor: toStr(r.id),
      targetId: toStr(r.target_id),
      payloadCid: toStr(r.payload_cid),
      replyTo: toStr(r.reply_to),
      createdAt: Number(r.created_at ?? 0),
      reportCount: Number(r.report_count ?? 0),
      reporters: ids === "" ? [] : ids.split(","), // id 是 hex，不含逗号
    });
  }
  return out;
}
