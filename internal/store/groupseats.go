package store

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"sort"
	"strings"
)

// GovernorSeats 返回成员数 m 对应的治理人席位总数 k(m)（册子 §3.2）。
func GovernorSeats(m int) int {
	if m <= 10 {
		return 1
	}
	k := 3 + (m-11)/10
	if k > 10 {
		return 10
	}
	return k
}

// RemoveQuorumV2 是「移出成员」的 V2 动态门槛（Spec v2 §6）：
//   base 门槛公式（圈内 m_circle + P_circle + F_circle）+ GovernQuorum 裁切。
// m_circle 是圈内注册成员数；P_circle / F_circle 是圈内成员对圈内容的互动度（progress / favorites）。
func RemoveQuorumV2(mCircle, PCircle, FCircle int) int {
	threshold := GovernThreshold("base", mCircle, PCircle, FCircle)
	return GovernQuorum(threshold, mCircle)
}

// DissolveProposerQuorum 是「解散圈子」的发起治者门槛 min(2, k)（册子 §3.4）。
// 保持不变：这是治者签名门槛，不是票选 quorum；Spec v2 §6 明确不动它。
func DissolveProposerQuorum(k int) int {
	if k < 2 {
		return k
	}
	return 2
}

// DissolveVoteQuorumV2 是「解散圈子」的 V2 动态门槛（Spec v2 §6）：
//   enhanced 门槛公式 + GovernQuorum 裁切（比 base 更严格）。
func DissolveVoteQuorumV2(mCircle, PCircle, FCircle int) int {
	threshold := GovernThreshold("enhanced", mCircle, PCircle, FCircle)
	return GovernQuorum(threshold, mCircle)
}

// brushWindowMs 是防刷窗口：任意滚动 24h（册子 §3.3 第 3 条，边界取整到秒）。
const brushWindowMs = 24 * 60 * 60 * 1000

// brushMaxPerWindow 是同一 actor 在任意滚动 24h 内最多计入的条数（册子 §3.3 第 3 条）。
const brushMaxPerWindow = 20

// RankInput 是排序输入的一行（导出以便 genvectors 构造黄金向量）。
type RankInput struct {
	EventID   string
	Actor     string
	CreatedAt int64
}

// ContributionRank 按册子 §3.3 排出圈内贡献度名次。
//   - 输入已按 event_id 去重、只含 action=msg、且 actor 已过滤到当前成员（由 DeriveSeats 完成）；
//   - 防刷：逐 actor 的发言按 (created_at, event_id) 升序**贪心接受**，保持任意滚动 24h 窗口 ≤ 20；
//   - 排序键：count 降序，同分按 actor_id 的 hex 字典序**升序**（各节点同解的前提）；
//   - 返回**全部成员**的名次顺序（零发言的成员也在，排在最后按 id 升序），长度 = len(members)。
func ContributionRank(events []RankInput, members []string) []string {
	counts := make(map[string]int, len(members))
	byActor := make(map[string][]RankInput, len(members))
	memberSet := make(map[string]bool, len(members))
	for _, m := range members {
		memberSet[m] = true
	}
	for _, e := range events {
		if !memberSet[e.Actor] {
			continue // 已移出者的历史发言不计入排名（册子 §3.3 第 4 条；事件仍留库）
		}
		byActor[e.Actor] = append(byActor[e.Actor], e)
	}
	for actor, list := range byActor {
		sort.Slice(list, func(i, j int) bool {
			if list[i].CreatedAt != list[j].CreatedAt {
				return list[i].CreatedAt < list[j].CreatedAt
			}
			return list[i].EventID < list[j].EventID
		})
		accepted := make([]int64, 0, len(list))
		for _, e := range list {
			// 贪心：若接受该条会让某个 24h 窗口内超过上限，则丢弃它（从最早已接受条开始数）。
			accepted = append(accepted, e.CreatedAt)
			if windowCount(accepted, e.CreatedAt) > brushMaxPerWindow {
				accepted = accepted[:len(accepted)-1]
			}
		}
		counts[actor] = len(accepted)
	}
	out := append([]string(nil), members...)
	sort.Slice(out, func(i, j int) bool {
		if counts[out[i]] != counts[out[j]] {
			return counts[out[i]] > counts[out[j]]
		}
		return out[i] < out[j]
	})
	return out
}

// windowCount 返回已接受的（升序）时刻里落在 [end-24h, end] 闭区间的条数。
func windowCount(accepted []int64, end int64) int {
	lo := end - brushWindowMs
	n := 0
	for _, t := range accepted {
		if t >= lo && t <= end {
			n++
		}
	}
	return n
}

// EventWatermark 是册子 §3.3 第 8 条的 event_watermark：event_id 集合排序拼接后取 sha256 前 16 hex。
func EventWatermark(eventIDs []string) string {
	sorted := append([]string(nil), eventIDs...)
	sort.Strings(sorted)
	sum := sha256.Sum256([]byte(strings.Join(sorted, "")))
	return hex.EncodeToString(sum[:])[:16]
}

// SeatSnapshot 是一次席位派生的结果，水位一并带出（册子 §3.3 第 8 条）。
type SeatSnapshot struct {
	RosterRev   int64
	RosterEpoch int64
	Watermark   string
	SeatCount   int
	Ranked      []string
	Governors   []string
	// Decidable=false 表示名册或事件集合不足以判定名次（册子 §3.3 第 9 条）。
	// k(m) <= 1 的圈子不需要排名，恒可判定。
	Decidable bool
}

// DeriveSeats 从名册 + 圈内发言事件派生席位（册子 §3.2 / §3.3）。
// 只读派生、不落表；创建者永久占 1 席，其余 k-1 席按贡献度名次取。
func DeriveSeats(memberIDs []string, creatorID string, rosterRev, epoch int64, events []Event) SeatSnapshot {
	k := GovernorSeats(len(memberIDs))
	msgs := make([]RankInput, 0, len(events))
	seen := make(map[string]bool, len(events))
	ids := make([]string, 0, len(events))
	for _, e := range events {
		if seen[e.EventID] {
			continue // 按 event_id 去重（册子 §3.3 第 1 条）
		}
		seen[e.EventID] = true
		if GroupBodyAction(e.BodyJSON) != "msg" {
			continue
		}
		ids = append(ids, e.EventID)
		msgs = append(msgs, RankInput{EventID: e.EventID, Actor: e.ID, CreatedAt: e.CreatedAt})
	}
	snap := SeatSnapshot{
		RosterRev: rosterRev, RosterEpoch: epoch,
		Watermark: EventWatermark(ids),
		SeatCount: k,
		Ranked:    ContributionRank(msgs, memberIDs),
		Decidable: k <= 1 || len(msgs) > 0,
	}
	// 创建者永久 1 席；其余按名次取，跳过创建者本身（册子 §3.2）。
	snap.Governors = make([]string, 0, k)
	if creatorID != "" {
		snap.Governors = append(snap.Governors, creatorID)
	}
	for _, id := range snap.Ranked {
		if len(snap.Governors) >= k {
			break
		}
		if id == creatorID {
			continue
		}
		snap.Governors = append(snap.Governors, id)
	}
	return snap
}

// GroupBodyAction 从事件 body_json 里取 action；解析失败或非 roster/msg 返回空串。
func GroupBodyAction(bodyJSON string) string {
	var b struct {
		Action string `json:"action"`
	}
	if err := json.Unmarshal([]byte(bodyJSON), &b); err != nil {
		return ""
	}
	return b.Action
}
