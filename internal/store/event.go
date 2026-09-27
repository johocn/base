package store

import (
	"database/sql"
	"errors"
	"time"
)

// Event 是一条已验签的客户端事件。
// TargetID / PayloadCID / ReplyTo 只有 comment.v1 有值，其余类型留空。
type Event struct {
	EventID    string
	ID         string
	Type       string
	BodyJSON   string
	CreatedAt  int64
	ReceivedAt int64
	TargetID   string
	PayloadCID string
	ReplyTo    string
}

// PutEvent 幂等写入事件：同 event_id 覆盖（客户端可安全重试），received_at 保留首次值。
// received_at 保留首次值是本节点事件游标（§3.5）单调推进的前提，不能改成 excluded。
func (s *Store) PutEvent(e Event) error {
	if e.ReceivedAt == 0 {
		e.ReceivedAt = time.Now().UnixMilli()
	}
	_, err := s.db.Exec(`INSERT INTO events(event_id,id,type,body_json,created_at,received_at,target_id,payload_cid,reply_to)
		VALUES(?,?,?,?,?,?,?,?,?)
		ON CONFLICT(event_id) DO UPDATE SET
			id=excluded.id, type=excluded.type, body_json=excluded.body_json, created_at=excluded.created_at,
			target_id=excluded.target_id, payload_cid=excluded.payload_cid, reply_to=excluded.reply_to`,
		e.EventID, e.ID, e.Type, e.BodyJSON, e.CreatedAt, e.ReceivedAt,
		e.TargetID, e.PayloadCID, e.ReplyTo)
	return err
}

const eventColumns = `event_id,id,type,body_json,created_at,received_at,target_id,payload_cid,reply_to`

func scanEvent(row interface{ Scan(...any) error }) (Event, error) {
	var (
		e        Event
		targetID sql.NullString
		payload  sql.NullString
		replyTo  sql.NullString
	)
	err := row.Scan(&e.EventID, &e.ID, &e.Type, &e.BodyJSON, &e.CreatedAt, &e.ReceivedAt,
		&targetID, &payload, &replyTo)
	if err != nil {
		return Event{}, err
	}
	e.TargetID, e.PayloadCID, e.ReplyTo = targetID.String, payload.String, replyTo.String
	return e, nil
}

// ListEvents 返回某身份的事件，按 created_at 倒序；limit<=0 取 100。
func (s *Store) ListEvents(id string, limit int) ([]Event, error) {
	if limit <= 0 {
		limit = 100
	}
	rows, err := s.db.Query(`SELECT `+eventColumns+`
		FROM events WHERE id=? ORDER BY created_at DESC, event_id ASC LIMIT ?`, id, limit)
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

// GetEventByID 读单条事件（审核 reject 用）。
func (s *Store) GetEventByID(eventID string) (Event, bool, error) {
	row := s.db.QueryRow(`SELECT `+eventColumns+` FROM events WHERE event_id=?`, eventID)
	e, err := scanEvent(row)
	if errors.Is(err, sql.ErrNoRows) {
		return Event{}, false, nil
	}
	if err != nil {
		return Event{}, false, err
	}
	return e, true, nil
}

// ListEventsAfter 按 (received_at, event_id) 复合游标增量读事件，严格大于游标。
func (s *Store) ListEventsAfter(ts int64, id string, limit int) ([]Event, error) {
	if limit <= 0 {
		limit = 200
	}
	rows, err := s.db.Query(`SELECT `+eventColumns+` FROM events
		WHERE received_at > ? OR (received_at = ? AND event_id > ?)
		ORDER BY received_at ASC, event_id ASC LIMIT ?`, ts, ts, id, limit)
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
