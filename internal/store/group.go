package store

import (
	"database/sql"
	"errors"
	"time"
)

// GroupRoster 是 groups 表的一行（册子 §4.2）。
type GroupRoster struct {
	GroupID       string
	CreatorID     string
	Epoch         int64
	MemberIDsJSON string
	EventID       string
	UpdatedAt     int64
}

// 两个哨兵错误由 httpapi 映射为错误码（册子 §4.2）。
var (
	ErrGroupOwnerMismatch = errors.New("group_owner_mismatch")
	ErrGroupEpochStale    = errors.New("group_epoch_stale")
)

// PutGroupRoster 写/更新名单投影（册子 §4.2）：首个 roster 事件锁定 creator_id，
// 后续必须同 actor 且 epoch 严格大于当前值。校验失败**不写任何行**。
func (s *Store) PutGroupRoster(r GroupRoster) error {
	if r.UpdatedAt == 0 {
		r.UpdatedAt = time.Now().UnixMilli()
	}
	var curCreator string
	var curEpoch int64
	err := s.db.QueryRow(`SELECT creator_id,epoch FROM groups WHERE group_id=?`, r.GroupID).
		Scan(&curCreator, &curEpoch)
	switch {
	case errors.Is(err, sql.ErrNoRows):
		_, err = s.db.Exec(`INSERT INTO groups(group_id,creator_id,epoch,member_ids_json,event_id,updated_at)
			VALUES(?,?,?,?,?,?)`,
			r.GroupID, r.CreatorID, r.Epoch, r.MemberIDsJSON, r.EventID, r.UpdatedAt)
		return err
	case err != nil:
		return err
	}
	if r.CreatorID != curCreator {
		return ErrGroupOwnerMismatch
	}
	if r.Epoch <= curEpoch {
		return ErrGroupEpochStale
	}
	// 乐观锁：WHERE epoch=? 保证并发下不会把更旧的值盖上去。
	_, err = s.db.Exec(`UPDATE groups SET epoch=?,member_ids_json=?,event_id=?,updated_at=?
		WHERE group_id=? AND epoch=?`,
		r.Epoch, r.MemberIDsJSON, r.EventID, r.UpdatedAt, r.GroupID, curEpoch)
	return err
}

// ForceGroupRoster 反熵接收侧用的写入（册子 §4.4 的延伸）：不校验 owner（对端数据在信任域内），
// 只接受**更大的 epoch**，旧值静默忽略——与 putPeerCursor 的单调口径同族。
// 返回是否实际写入，供接收侧测试断言。
func (s *Store) ForceGroupRoster(r GroupRoster) (bool, error) {
	if r.UpdatedAt == 0 {
		r.UpdatedAt = time.Now().UnixMilli()
	}
	res, err := s.db.Exec(`INSERT INTO groups(group_id,creator_id,epoch,member_ids_json,event_id,updated_at)
		VALUES(?,?,?,?,?,?)
		ON CONFLICT(group_id) DO UPDATE SET
			epoch=excluded.epoch, member_ids_json=excluded.member_ids_json,
			event_id=excluded.event_id, updated_at=excluded.updated_at
		WHERE excluded.epoch > groups.epoch`,
		r.GroupID, r.CreatorID, r.Epoch, r.MemberIDsJSON, r.EventID, r.UpdatedAt)
	if err != nil {
		return false, err
	}
	n, err := res.RowsAffected()
	return n > 0, err
}

// GetGroup 读名单投影；不存在返回 false。
func (s *Store) GetGroup(groupID string) (GroupRoster, bool, error) {
	var g GroupRoster
	err := s.db.QueryRow(`SELECT group_id,creator_id,epoch,member_ids_json,event_id,updated_at
		FROM groups WHERE group_id=?`, groupID).
		Scan(&g.GroupID, &g.CreatorID, &g.Epoch, &g.MemberIDsJSON, &g.EventID, &g.UpdatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return GroupRoster{}, false, nil
	}
	if err != nil {
		return GroupRoster{}, false, err
	}
	return g, true, nil
}

// ListGroupEvents 按 (created_at, event_id) 倒序分页读某组的 group.v1 事件（册子 §4.3）。
// 与 ListComments 同口径：事件行是唯一来源，名单事件与发言事件都在里面，
// 由调用方按 body_json 的 action 分流（发言才有 payload_cid）。
func (s *Store) ListGroupEvents(groupID string, cursorTS int64, cursorID string, limit int) ([]Event, error) {
	if limit <= 0 {
		limit = 30
	}
	q := `SELECT ` + eventColumns + ` FROM events WHERE type='group.v1' AND target_id=?`
	args := []any{"group/" + groupID}
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
