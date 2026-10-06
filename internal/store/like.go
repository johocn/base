package store

import (
	"database/sql"
	"errors"
	"strings"
)

// #79 §4：点赞/举报的即时聚合计数（方案 A，零新表）。
// 依赖 idx_events_type_target(type, target_id)（schema.go），按页聚合禁 N+1。

// LikeCountsByTargets 对一批 target（评论 event_id 或条目 item_id）各算 like_count：
// 同 (id, target_id) 取 (created_at, event_id) 最大者为最新状态，计数 = 最新为 like 的去重 actor 数。
// 无赞 target 不在返回 map 中（调用方按 0 处理）。
func (s *Store) LikeCountsByTargets(targets []string) (map[string]int64, error) {
	out := map[string]int64{}
	if len(targets) == 0 {
		return out, nil
	}
	q := `SELECT target_id, COUNT(DISTINCT id) FROM events e
		WHERE e.type='like.v1' AND e.target_id IN (` + placeholders(len(targets)) + `)
		  AND json_extract(e.body_json,'$.action')='like'
		  AND NOT EXISTS (SELECT 1 FROM events e2
			WHERE e2.type='like.v1' AND e2.id=e.id AND e2.target_id=e.target_id
			  AND (e2.created_at > e.created_at
			       OR (e2.created_at = e.created_at AND e2.event_id > e.event_id)))
		GROUP BY target_id`
	args := make([]any, 0, len(targets))
	for _, t := range targets {
		args = append(args, t)
	}
	rows, err := s.db.Query(q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var target string
		var cnt int64
		if err := rows.Scan(&target, &cnt); err != nil {
			return nil, err
		}
		out[target] = cnt
	}
	return out, rows.Err()
}

// ActiveItemExists 条目 target 校验（#79 §3.3）：items 存在且 state='active'。
func (s *Store) ActiveItemExists(itemID string) (bool, error) {
	var one int
	err := s.db.QueryRow(`SELECT 1 FROM items WHERE item_id=? AND state='active' LIMIT 1`, itemID).Scan(&one)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	return err == nil, err
}

// ReportedCommentRow 是 POST /v1/admin/review/reported 的一行：被举报评论 + 聚合举报数。
type ReportedCommentRow struct {
	EventID     string   // 被举报评论 event_id
	Actor       string   // 评论作者
	TargetID    string   // 评论所属目标
	PayloadCID  string   // 评论正文块（审核者接 fetch 取正文）
	ReplyTo     string
	CreatedAt   int64    // 评论创建时间
	ReportCount int64    // 去重举报人数（#79 §4.2）
	Reporters   []string // 去重举报人 id
}

// ListReportedComments 被举报评论列表（#79 §5.3）：
// 内联评论事件已同步到本地（JOIN）且未墓碑；report_count 降序、次键 (created_at, event_id) 降序。
func (s *Store) ListReportedComments() ([]ReportedCommentRow, error) {
	rows, err := s.db.Query(`SELECT t.event_id, t.id, t.target_id, t.payload_cid, t.reply_to, t.created_at,
		COUNT(DISTINCT r.id) AS report_count, GROUP_CONCAT(DISTINCT r.id) AS reporters
		FROM events r
		JOIN events t ON t.event_id = r.target_id AND t.type='comment.v1'
		WHERE r.type='report.v1'
		  AND NOT EXISTS (SELECT 1 FROM comment_tombstone tb WHERE tb.event_id=t.event_id)
		GROUP BY t.event_id
		ORDER BY report_count DESC, t.created_at DESC, t.event_id DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []ReportedCommentRow{}
	for rows.Next() {
		var (
			r        ReportedCommentRow
			targetID sql.NullString
			payload  sql.NullString
			replyTo  sql.NullString
			ids      sql.NullString
		)
		if err := rows.Scan(&r.EventID, &r.Actor, &targetID, &payload, &replyTo, &r.CreatedAt,
			&r.ReportCount, &ids); err != nil {
			return nil, err
		}
		r.TargetID, r.PayloadCID, r.ReplyTo = targetID.String, payload.String, replyTo.String
		if ids.Valid && ids.String != "" {
			r.Reporters = strings.Split(ids.String, ",") // id 是 hex，不含逗号
		} else {
			r.Reporters = []string{}
		}
		out = append(out, r)
	}
	return out, rows.Err()
}
