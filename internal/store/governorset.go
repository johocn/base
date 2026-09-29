package store

import (
	"encoding/json"
	"sort"
)

// GovernorSet 返回本节点治理人集合 = #23 全站名册 ∪ #33 各圈治者（册子 §3.4）。
// 名册与席位都是**实时派生**、不落表；席位的判定完全复用 #35 Phase 1 的 DeriveSeats，
// 本函数不自定义任何圈子治者口径。
func (s *Store) GovernorSet() (map[string]bool, error) {
	out := map[string]bool{}
	roster, err := s.ContributorRoster()
	if err != nil {
		return nil, err
	}
	for _, c := range roster {
		out[c.ID] = true
	}
	// 先把小组行读尽再关游标：单连接池下不能在未闭合游标上发起嵌套查询。
	type groupRow struct {
		id        string
		creator   string
		epoch     int64
		rosterRev int64
		members   string
	}
	var rows []groupRow
	cur, err := s.db.Query(`SELECT group_id,creator_id,epoch,roster_rev,member_ids_json FROM groups ORDER BY group_id ASC`)
	if err != nil {
		return nil, err
	}
	for cur.Next() {
		var g groupRow
		if err := cur.Scan(&g.id, &g.creator, &g.epoch, &g.rosterRev, &g.members); err != nil {
			cur.Close()
			return nil, err
		}
		rows = append(rows, g)
	}
	if err := cur.Err(); err != nil {
		cur.Close()
		return nil, err
	}
	cur.Close()

	for _, g := range rows {
		members := []string{}
		if err := json.Unmarshal([]byte(g.members), &members); err != nil {
			continue // 名单 JSON 不可解析 = 该圈不参与资格判定，不中断其余来源
		}
		sort.Strings(members)
		events, err := s.ListGroupMsgEvents(g.id)
		if err != nil {
			return nil, err
		}
		snap := DeriveSeats(members, g.creator, g.rosterRev, g.epoch, events)
		for _, id := range snap.Governors {
			if id != "" {
				out[id] = true
			}
		}
	}
	return out, nil
}
