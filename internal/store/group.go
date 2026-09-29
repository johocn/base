package store

import (
	"database/sql"
	"errors"
	"time"
)

// GroupRoster 是 groups 表的一行（册子 §4.2）。
type GroupRoster struct {
	GroupID          string
	CreatorID        string
	Epoch            int64
	RosterRev        int64
	Encrypted        int64
	MemberIDsJSON    string
	KeyEnvelopesJSON string
	EventID          string
	UpdatedAt        int64
}

// 哨兵错误由 httpapi 映射为错误码（册子 §4.2）。
var (
	ErrGroupOwnerMismatch  = errors.New("group_owner_mismatch")
	ErrGroupEpochStale     = errors.New("group_epoch_stale")
	ErrGroupRosterRevStale = errors.New("group_roster_rev_stale")
	ErrGroupFormLocked     = errors.New("group_form_locked")
)

// PutGroupRoster 写/更新名单投影（册子 §4.2）：首个 roster 事件锁定 creator_id，
// 后续必须同 actor 且 epoch 严格大于当前值。校验失败**不写任何行**。
// encrypted 由 httpapi 从 body 解析（缺省 1）；形态在建圈时定死，UPDATE 分支不动 encrypted。
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
		_, err = s.db.Exec(`INSERT INTO groups(group_id,creator_id,epoch,roster_rev,encrypted,member_ids_json,key_envelopes,event_id,updated_at)
			VALUES(?,?,?,?,?,?,?,?,?)`,
			r.GroupID, r.CreatorID, r.Epoch, 1, r.Encrypted, r.MemberIDsJSON, "[]", r.EventID, r.UpdatedAt)
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
	_, err = s.db.Exec(`UPDATE groups SET epoch=?,roster_rev=roster_rev+1,member_ids_json=?,event_id=?,updated_at=?
		WHERE group_id=? AND epoch=?`,
		r.Epoch, r.MemberIDsJSON, r.EventID, r.UpdatedAt, r.GroupID, curEpoch)
	return err
}

// PutGroupRosterV2 写 v2 名单投影（册子 §3.8）。多签与门槛已由 httpapi 验完，**这里不再校验 owner**——
// 写权已从「owner 锁」放宽为「写者 ∈ 圈内治者名单 ∧ 门槛签数达标」（§3.4）；
// 但三件事必须由本方法兜住：epoch 严格递增、roster_rev 严格递增、encrypted 建圈定死后不可切换（§3.1）。
// 校验失败**不写任何行**。
func (s *Store) PutGroupRosterV2(r GroupRoster) error {
	if r.UpdatedAt == 0 {
		r.UpdatedAt = time.Now().UnixMilli()
	}
	if r.KeyEnvelopesJSON == "" {
		r.KeyEnvelopesJSON = "[]"
	}
	var curEpoch, curRev, curEnc int64
	err := s.db.QueryRow(`SELECT epoch,roster_rev,encrypted FROM groups WHERE group_id=?`, r.GroupID).
		Scan(&curEpoch, &curRev, &curEnc)
	switch {
	case errors.Is(err, sql.ErrNoRows):
		_, err = s.db.Exec(`INSERT INTO groups(group_id,creator_id,epoch,roster_rev,encrypted,member_ids_json,key_envelopes,event_id,updated_at)
			VALUES(?,?,?,?,?,?,?,?,?)`,
			r.GroupID, r.CreatorID, r.Epoch, r.RosterRev, r.Encrypted, r.MemberIDsJSON,
			r.KeyEnvelopesJSON, r.EventID, r.UpdatedAt)
		return err
	case err != nil:
		return err
	}
	if r.Encrypted != curEnc {
		return ErrGroupFormLocked // 形态不可切换（册子 §3.1）
	}
	if r.Epoch <= curEpoch {
		return ErrGroupEpochStale
	}
	if r.RosterRev <= curRev {
		return ErrGroupRosterRevStale
	}
	// 乐观锁：WHERE 带上读到的旧值，并发下不会把更旧的行盖上去。
	_, err = s.db.Exec(`UPDATE groups SET epoch=?,roster_rev=?,member_ids_json=?,key_envelopes=?,event_id=?,updated_at=?
		WHERE group_id=? AND epoch=? AND roster_rev=?`,
		r.Epoch, r.RosterRev, r.MemberIDsJSON, r.KeyEnvelopesJSON, r.EventID, r.UpdatedAt,
		r.GroupID, curEpoch, curRev)
	return err
}

// ForceGroupRoster 反熵接收侧用的写入（册子 §4.4 的延伸）：不校验 owner（对端数据在信任域内），
// 只接受**更大的 epoch**，旧值静默忽略——与 putPeerCursor 的单调口径同族。
// 返回是否实际写入，供接收侧测试断言。
func (s *Store) ForceGroupRoster(r GroupRoster) (bool, error) {
	if r.UpdatedAt == 0 {
		r.UpdatedAt = time.Now().UnixMilli()
	}
	res, err := s.db.Exec(`INSERT INTO groups(group_id,creator_id,epoch,roster_rev,encrypted,member_ids_json,key_envelopes,event_id,updated_at)
		VALUES(?,?,?,?,?,?,?,?,?)
		ON CONFLICT(group_id) DO UPDATE SET
			epoch=excluded.epoch, roster_rev=excluded.roster_rev, encrypted=excluded.encrypted,
			member_ids_json=excluded.member_ids_json, key_envelopes=excluded.key_envelopes,
			event_id=excluded.event_id, updated_at=excluded.updated_at
		WHERE excluded.epoch > groups.epoch`,
		r.GroupID, r.CreatorID, r.Epoch, r.RosterRev, r.Encrypted, r.MemberIDsJSON,
		r.KeyEnvelopesJSON, r.EventID, r.UpdatedAt)
	if err != nil {
		return false, err
	}
	n, err := res.RowsAffected()
	return n > 0, err
}

// GetGroup 读名单投影；不存在返回 false。
func (s *Store) GetGroup(groupID string) (GroupRoster, bool, error) {
	var g GroupRoster
	err := s.db.QueryRow(`SELECT group_id,creator_id,epoch,roster_rev,encrypted,member_ids_json,key_envelopes,event_id,updated_at
		FROM groups WHERE group_id=?`, groupID).
		Scan(&g.GroupID, &g.CreatorID, &g.Epoch, &g.RosterRev, &g.Encrypted, &g.MemberIDsJSON,
			&g.KeyEnvelopesJSON, &g.EventID, &g.UpdatedAt)
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

// ListGroupMsgEvents 读某组的**全部** group.v1 事件（不分页），供席位派生用（册子 §3.3）。
// 与 ListGroupEvents 的区别只有「不给游标、不给 limit」：排名需要全量输入。
// 先读尽再返回，游标在函数内 Close——单连接池下不能留下未闭合游标。
func (s *Store) ListGroupMsgEvents(groupID string) ([]Event, error) {
	rows, err := s.db.Query(`SELECT `+eventColumns+` FROM events WHERE type='group.v1' AND target_id=? ORDER BY created_at ASC, event_id ASC`,
		"group/"+groupID)
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
