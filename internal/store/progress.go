package store

import (
	"database/sql"
	"errors"
	"fmt"

	"github.com/johocn/base/internal/protocol"
)

// ProgressEvent 是一条 progress.v1 事件的投影输入（#8 册子 §3.1）。
// `Position` 已由客户端按 §3.2 归一化、`Done` 由客户端判定 —— 节点只信、不反推。
type ProgressEvent struct {
	ID        string
	ItemID    string
	Position  int64
	Done      bool
	Day       string
	CreatedAt int64
	EventID   string
}

// ProgressRow 是 progress 表的一行。
type ProgressRow struct {
	ItemID    string
	Position  int64
	Done      bool
	Day       string
	UpdatedAt int64
	EventID   string
}

// CheckinDayRow 是 checkin_days 表的一行。
type CheckinDayRow struct {
	Day          string
	FirstEventID string
	CreatedAt    int64
}

// PutProgressProjection 把一条 progress.v1 事件投影进 progress + checkin_days（#8 册子 §4.2）。
// **同一事务**写两张表：要么都落、要么都不落（反熵中断不留半条状态）。
//
// progress 的收敛口径 = §3.4 的 LWW（`created_at` 降序、平局 `event_id` 升序，首条即胜者）：
//   - 无行 → INSERT；
//   - 同 event_id 重放 → 幂等 no-op；
//   - 本次事件更晚 → UPDATE；
//   - 否则（更早，或同刻更大 event_id）→ **静默 no-op**（输者不是错误：寄存器已收敛，
//     与 ProjectGovernProposal 的 ErrGovernEventConflict 不同——那册需要向用户告知冲突，本册不需要）。
//
// checkin_days 恒为 insert-or-ignore：该身份该日已有行则保留首次（§3.5 的「只增集合」）。
// 注意**即使 progress 这行输了 LWW，checkin_days 照样要写**——打卡是**事件级**语义
// （§3.5：某日已打卡 ⇔ 存在至少一条 day == 该日 的事件），不是寄存器级。
func (s *Store) PutProgressProjection(e ProgressEvent) error {
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()

	if _, err := tx.Exec(`INSERT INTO checkin_days(id,day,first_event_id,created_at)
		VALUES(?,?,?,?) ON CONFLICT(id,day) DO NOTHING`,
		e.ID, e.Day, e.EventID, e.CreatedAt); err != nil {
		return fmt.Errorf("store: 投影打卡日: %w", err)
	}

	prevCreated, prevEventID, found, err := existingProgressTx(tx, e.ID, e.ItemID)
	if err != nil {
		return err
	}
	switch {
	case !found:
		if _, err := tx.Exec(`INSERT INTO progress(id,item_id,position,done,day,updated_at,event_id,dirty)
			VALUES(?,?,?,?,?,?,?,0)`,
			e.ID, e.ItemID, e.Position, boolToInt(e.Done), e.Day, e.CreatedAt, e.EventID); err != nil {
			return fmt.Errorf("store: 投影进度: %w", err)
		}
	case prevEventID == e.EventID:
		// 同一条事件重放：幂等，什么都不做。
	case protocol.ProgressWins(e.CreatedAt, e.EventID, prevCreated, prevEventID):
		if _, err := tx.Exec(`UPDATE progress SET position=?,done=?,day=?,updated_at=?,event_id=?
			WHERE id=? AND item_id=?`,
			e.Position, boolToInt(e.Done), e.Day, e.CreatedAt, e.EventID, e.ID, e.ItemID); err != nil {
			return fmt.Errorf("store: 收敛进度 %s: %w", e.ItemID, err)
		}
	}
	// 其余分支（本次事件输了）静默 no-op：事件行照样由上层落，读接口以寄存器为准。
	return tx.Commit()
}

// existingProgressTx 读一个寄存器已占位的 (updated_at, event_id)；无行返回 found=false。
func existingProgressTx(tx *sql.Tx, id, itemID string) (updatedAt int64, eventID string, found bool, err error) {
	err = tx.QueryRow(`SELECT updated_at, event_id FROM progress WHERE id=? AND item_id=?`,
		id, itemID).Scan(&updatedAt, &eventID)
	if errors.Is(err, sql.ErrNoRows) {
		return 0, "", false, nil
	}
	if err != nil {
		return 0, "", false, err
	}
	return updatedAt, eventID, true, nil
}

// ListProgressByID 返回某身份的全部进度寄存器（LWW 胜者），按 item_id 升序。
// `GET /v1/me` 与反熵断言都用它。空结果返回 nil（上层负责转成 `[]`，不是 `null`）。
func (s *Store) ListProgressByID(id string) ([]ProgressRow, error) {
	rows, err := s.db.Query(`SELECT item_id,position,done,day,updated_at,event_id
		FROM progress WHERE id=? ORDER BY item_id ASC`, id)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []ProgressRow
	for rows.Next() {
		var r ProgressRow
		var done int
		if err := rows.Scan(&r.ItemID, &r.Position, &done, &r.Day, &r.UpdatedAt, &r.EventID); err != nil {
			return nil, err
		}
		r.Done = done != 0
		out = append(out, r)
	}
	return out, rows.Err()
}

// CheckinDaysOf 返回某身份的全部打卡日，按 day 升序。空结果返回 nil（同 ListProgressByID）。
func (s *Store) CheckinDaysOf(id string) ([]CheckinDayRow, error) {
	rows, err := s.db.Query(`SELECT day,first_event_id,created_at FROM checkin_days
		WHERE id=? ORDER BY day ASC`, id)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []CheckinDayRow
	for rows.Next() {
		var r CheckinDayRow
		if err := rows.Scan(&r.Day, &r.FirstEventID, &r.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// boolToInt 把布尔落成 SQLite 的 0/1。
func boolToInt(v bool) int {
	if v {
		return 1
	}
	return 0
}
