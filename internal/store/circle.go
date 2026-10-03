package store

import (
	"encoding/json"
	"time"
)

// PutCircleAssignment INSERT OR IGNORE 写一行 circle_assignments（融合治理册 §2.2）。
// 主键 (item_id, circle_id) 天然幂等——同组合重复调用只保留首次。
// origin 由 handler 从 body 读 "fusion" | "user"，本方法不做校验。
func (s *Store) PutCircleAssignment(itemID, circleID, origin string, createdAt int64) error {
	if createdAt == 0 {
		createdAt = time.Now().UnixMilli()
	}
	_, err := s.db.Exec(`INSERT OR IGNORE INTO circle_assignments(item_id,circle_id,origin,created_at)
		VALUES(?,?,?,?)`, itemID, circleID, origin, createdAt)
	return err
}

// UpsertGroupForForm INSERT OR IGNORE 写一行 groups（融合治理册 §2.2，轨道 B 成圈）。
// 不做 owner/epoch/roster_rev 校验——form 事件只成圈一次，后续由 group.v1 管理。
// 已存在的 group_id 静默跳过（ON CONFLICT DO NOTHING），保持幂等。
//
// 字段按设计册派生：
//   creator_id      = 条目作者（handler 查完 items 传进来）
//   epoch           = 1
//   roster_rev      = 0
//   encrypted       = 1（默认加密；与 node 侧同口径）
//   member_ids_json = [creatorID]——初始成员只有作者自己
//   key_envelopes   = []
//   event_id        = circleID（首次成圈事件就是圈本身）
//   updated_at      = createdAt
//   origin          = "fusion"（默认；handler 可覆盖）
func (s *Store) UpsertGroupForForm(circleID, creatorID string, createdAt int64, origin string) error {
	if createdAt == 0 {
		createdAt = time.Now().UnixMilli()
	}
	if origin == "" {
		origin = "fusion"
	}
	memberJSON, err := json.Marshal([]string{creatorID})
	if err != nil {
		return err
	}
	_, err = s.db.Exec(`INSERT OR IGNORE INTO groups(group_id,creator_id,epoch,roster_rev,encrypted,member_ids_json,key_envelopes,event_id,updated_at,origin)
		VALUES(?,?,?,?,?,?,?,?,?,?)`,
		circleID, creatorID, 1, 0, 1, string(memberJSON), "[]", circleID, createdAt, origin)
	return err
}
