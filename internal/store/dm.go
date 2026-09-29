package store

// ListDMEvents 按 (created_at, event_id) 倒序分页读发给某收件人的 dm.v1 事件（册子 §4.2）。
// 与 ListGroupEvents 同构：只把 type 换成 dm.v1、target_id 换成 "dm/" + peerID。
// 私信没有投影表 ⇒ 调用方无需按 action 分流（每条都是密文发言）。
func (s *Store) ListDMEvents(peerID string, cursorTS int64, cursorID string, limit int) ([]Event, error) {
	if limit <= 0 {
		limit = 30
	}
	q := `SELECT ` + eventColumns + ` FROM events WHERE type='dm.v1' AND target_id=?`
	args := []any{"dm/" + peerID}
	if cursorID != "" {
		q += ` AND (created_at < ? OR (created_at = ? AND event_id < ?))`
		args = append(args, cursorTS, cursorTS, cursorID)
	}
	q += ` ORDER BY created_at DESC, event_id DESC LIMIT ?`
	args = append(args, limit)

	rows, err := s.db.Query(q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Event{}
	for rows.Next() {
		e, err := scanEvent(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, e)
	}
	return out, rows.Err()
}
