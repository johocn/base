package store

import (
	"database/sql"
	"errors"
	"time"
)

// CommentRow 是 GET /v1/comment 的投影行（正文不在这里，按 payload_cid 另取块）。
type CommentRow struct {
	EventID    string
	Actor      string
	TargetID   string
	PayloadCID string
	ReplyTo    string
	CreatedAt  int64
}

// ListComments 按 (created_at, event_id) 倒序分页读评论投影，联表排除墓碑。
// targetID 为空表示不过滤目标；cursorTS/cursorID 为上一页末条，返回严格更旧的行。
func (s *Store) ListComments(targetID string, cursorTS int64, cursorID string, limit int) ([]CommentRow, error) {
	if limit <= 0 {
		limit = 30
	}
	q := `SELECT e.event_id,e.id,e.target_id,e.payload_cid,e.reply_to,e.created_at
		FROM events e
		WHERE e.type='comment.v1'
		  AND NOT EXISTS (SELECT 1 FROM comment_tombstone t WHERE t.event_id=e.event_id)`
	args := []any{}
	if targetID != "" {
		q += ` AND e.target_id=?`
		args = append(args, targetID)
	}
	if cursorID != "" {
		q += ` AND (e.created_at < ? OR (e.created_at = ? AND e.event_id < ?))`
		args = append(args, cursorTS, cursorTS, cursorID)
	}
	q += ` ORDER BY e.created_at DESC, e.event_id DESC LIMIT ?`
	args = append(args, limit)

	rows, err := s.db.Query(q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []CommentRow{}
	for rows.Next() {
		var (
			c        CommentRow
			targetID sql.NullString
			payload  sql.NullString
			replyTo  sql.NullString
		)
		if err := rows.Scan(&c.EventID, &c.Actor, &targetID, &payload, &replyTo, &c.CreatedAt); err != nil {
			return nil, err
		}
		c.TargetID, c.PayloadCID, c.ReplyTo = targetID.String, payload.String, replyTo.String
		out = append(out, c)
	}
	return out, rows.Err()
}

// EventBlobIndex 返回事件正文块 → 归属事件的映射，来源是 events.payload_cid。
// ① 类评论正文与 ② 类小组 / 私信密文都挂在这里：三者都是「块被事件引用」，
// 少了归属，缓存节点永远拉不下来、scrub 还会把块当孤儿删掉（册子 §4.4）。
func (s *Store) EventBlobIndex() (map[string]BlobRef, error) {
	rows, err := s.db.Query(`SELECT type,event_id,payload_cid FROM events
		WHERE type IN ('comment.v1','group.v1','dm.v1','circle.v1') AND payload_cid IS NOT NULL AND payload_cid<>''`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]BlobRef{}
	for rows.Next() {
		var typ, eventID, cid string
		if err := rows.Scan(&typ, &eventID, &cid); err != nil {
			return nil, err
		}
		if _, ok := out[cid]; ok {
			continue
		}
		prefix := "comment:"
		switch typ {
		case "group.v1":
			prefix = "group:"
		case "dm.v1":
			prefix = "dm:"
		case "circle.v1":
			prefix = "circle:"
		}
		out[cid] = BlobRef{BlobID: cid, ItemID: prefix + eventID}
	}
	return out, rows.Err()
}

// CommentTombstone 是一条审核删除墓碑。
type CommentTombstone struct {
	EventID    string
	PayloadCID string
	Reason     string
	At         int64
	ReceivedAt int64
}

// PutCommentTombstone 幂等 upsert 墓碑；received_at 保留首次值（同 PutEvent，游标单调的前提）。
func (s *Store) PutCommentTombstone(t CommentTombstone) error {
	if t.ReceivedAt == 0 {
		t.ReceivedAt = time.Now().UnixMilli()
	}
	_, err := s.db.Exec(`INSERT INTO comment_tombstone(event_id,payload_cid,reason,at,received_at)
		VALUES(?,?,?,?,?)
		ON CONFLICT(event_id) DO UPDATE SET
			payload_cid=excluded.payload_cid, reason=excluded.reason, at=excluded.at`,
		t.EventID, t.PayloadCID, t.Reason, t.At, t.ReceivedAt)
	return err
}

// IsRevokedPayload 判断某块是否被评论墓碑撤销（fetch / scrub / 落块三处护栏共用）。
func (s *Store) IsRevokedPayload(cid string) (bool, error) {
	var one int
	err := s.db.QueryRow(`SELECT 1 FROM comment_tombstone WHERE payload_cid=? LIMIT 1`, cid).Scan(&one)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return true, nil
}

// IsRevokedEvent 判断某事件是否已被审核删除（写路径用它挡住同一条重发）。
func (s *Store) IsRevokedEvent(eventID string) (bool, error) {
	var one int
	err := s.db.QueryRow(`SELECT 1 FROM comment_tombstone WHERE event_id=? LIMIT 1`, eventID).Scan(&one)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return true, nil
}

// ListRevokedPayloads 一次取全部被撤销的块 id（批量护栏用）。
func (s *Store) ListRevokedPayloads() (map[string]struct{}, error) {
	rows, err := s.db.Query(`SELECT DISTINCT payload_cid FROM comment_tombstone`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]struct{}{}
	for rows.Next() {
		var cid string
		if err := rows.Scan(&cid); err != nil {
			return nil, err
		}
		out[cid] = struct{}{}
	}
	return out, rows.Err()
}

// ListTombstonesAfter 按 (received_at, event_id) 复合游标增量读墓碑。
func (s *Store) ListTombstonesAfter(ts int64, id string, limit int) ([]CommentTombstone, error) {
	if limit <= 0 {
		limit = 200
	}
	rows, err := s.db.Query(`SELECT event_id,payload_cid,reason,at,received_at FROM comment_tombstone
		WHERE received_at > ? OR (received_at = ? AND event_id > ?)
		ORDER BY received_at ASC, event_id ASC LIMIT ?`, ts, ts, id, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []CommentTombstone{}
	for rows.Next() {
		var (
			t      CommentTombstone
			reason sql.NullString
		)
		if err := rows.Scan(&t.EventID, &t.PayloadCID, &reason, &t.At, &t.ReceivedAt); err != nil {
			return nil, err
		}
		t.Reason = reason.String
		out = append(out, t)
	}
	return out, rows.Err()
}

// GetPeerCursor 读对某 peer 某 kind 的事件增量游标；无记录返回零值。
func (s *Store) GetPeerCursor(peer, kind string) (int64, string, error) {
	var (
		ts int64
		id string
	)
	err := s.db.QueryRow(`SELECT cursor_ts,cursor_id FROM peer_sync_cursor WHERE peer=? AND kind=?`, peer, kind).Scan(&ts, &id)
	if errors.Is(err, sql.ErrNoRows) {
		return 0, "", nil
	}
	if err != nil {
		return 0, "", err
	}
	return ts, id, nil
}

// PutPeerCursor 持久化事件增量游标。
// 护栏（§3.5）：新游标若未严格大于旧游标（时钟回拨、或对端返回旧值），
// 只把 ts 抬到 oldTS+1，保证单调推进且**不跳过**同一毫秒内的后续行。
func (s *Store) PutPeerCursor(peer, kind string, ts int64, id string) error {
	oldTS, oldID, err := s.GetPeerCursor(peer, kind)
	if err != nil {
		return err
	}
	if ts < oldTS || (ts == oldTS && id <= oldID) {
		ts = oldTS + 1
	}
	_, err = s.db.Exec(`INSERT INTO peer_sync_cursor(peer,kind,cursor_ts,cursor_id,updated_at)
		VALUES(?,?,?,?,?)
		ON CONFLICT(peer,kind) DO UPDATE SET
			cursor_ts=excluded.cursor_ts, cursor_id=excluded.cursor_id, updated_at=excluded.updated_at`,
		peer, kind, ts, id, time.Now().UnixMilli())
	return err
}
