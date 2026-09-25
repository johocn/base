package store

import "time"

// Event 是一条已验签的客户端事件（落库骨架）。
// S1 阶段 type 取值表为空，故没有写入路径；B 阶段只需填 httpapi 的类型表，
// 本文件与验签管线都不用改。
type Event struct {
	EventID    string
	ID         string
	Type       string
	BodyJSON   string
	CreatedAt  int64
	ReceivedAt int64
}

// PutEvent 幂等写入事件：同 event_id 覆盖（客户端可安全重试），received_at 保留首次值。
func (s *Store) PutEvent(e Event) error {
	if e.ReceivedAt == 0 {
		e.ReceivedAt = time.Now().UnixMilli()
	}
	_, err := s.db.Exec(`INSERT INTO events(event_id,id,type,body_json,created_at,received_at)
		VALUES(?,?,?,?,?,?)
		ON CONFLICT(event_id) DO UPDATE SET
			id=excluded.id, type=excluded.type, body_json=excluded.body_json, created_at=excluded.created_at`,
		e.EventID, e.ID, e.Type, e.BodyJSON, e.CreatedAt, e.ReceivedAt)
	return err
}

// ListEvents 返回某身份的事件，按 created_at 倒序；limit<=0 取 100。
func (s *Store) ListEvents(id string, limit int) ([]Event, error) {
	if limit <= 0 {
		limit = 100
	}
	rows, err := s.db.Query(`SELECT event_id,id,type,body_json,created_at,received_at
		FROM events WHERE id=? ORDER BY created_at DESC, event_id ASC LIMIT ?`, id, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Event{}
	for rows.Next() {
		var e Event
		if err := rows.Scan(&e.EventID, &e.ID, &e.Type, &e.BodyJSON, &e.CreatedAt, &e.ReceivedAt); err != nil {
			return nil, err
		}
		out = append(out, e)
	}
	return out, rows.Err()
}
