package store

import (
	"fmt"
	"reflect"
	"strings"
	"testing"
)

func TestGovernorSeats(t *testing.T) {
	// 册子 §3.2 的阶梯表逐行核对（AC 2）
	cases := []struct{ m, want int }{
		{1, 1}, {10, 1}, {11, 3}, {20, 3}, {21, 4}, {30, 4},
		{31, 5}, {41, 6}, {51, 7}, {61, 8}, {71, 9}, {80, 9}, {81, 10}, {200, 10},
	}
	for _, c := range cases {
		if got := GovernorSeats(c.m); got != c.want {
			t.Errorf("GovernorSeats(%d) = %d, want %d", c.m, got, c.want)
		}
	}
}

func TestQuorums(t *testing.T) {
	// 解散发起：治者 ≥ min(2, k)（AC 7）
	for _, c := range []struct{ k, want int }{{1, 1}, {3, 2}, {10, 2}} {
		if got := DissolveProposerQuorum(c.k); got != c.want {
			t.Errorf("DissolveProposerQuorum(%d) = %d, want %d", c.k, got, c.want)
		}
	}
}

// rankInputs 把 Event 摊成 ContributionRank 的输入行。
func rankInputs(events []Event) []RankInput {
	out := make([]RankInput, 0, len(events))
	for _, e := range events {
		out = append(out, RankInput{EventID: e.EventID, Actor: e.ID, CreatedAt: e.CreatedAt})
	}
	return out
}

// dedup 按 EventID 去重，保持首次出现的顺序。
func dedup(events []Event) []Event {
	seen := make(map[string]bool, len(events))
	out := make([]Event, 0, len(events))
	for _, e := range events {
		if seen[e.EventID] {
			continue
		}
		seen[e.EventID] = true
		out = append(out, e)
	}
	return out
}

// fixtureID 造一个可预期的 32 hex 身份 id：前缀单字符 + 补齐，保证 hex 升序与字母序一致（补充 8）。
func fixtureID(prefix byte) string {
	return strings.Repeat(string(prefix), 32)
}

// msgEvent 造一条已验签形态的 msg 事件行（body 只需含 action）。
func msgEvent(id, actor string, at int64) Event {
	return Event{EventID: id, ID: actor, Type: "group.v1", CreatedAt: at,
		BodyJSON: `{"action":"msg"}`}
}

func TestContributionRankAntiBrush(t *testing.T) {
	a, b, c, d, e := fixtureID('a'), fixtureID('b'), fixtureID('c'), fixtureID('d'), fixtureID('e')
	members := []string{a, b, c, d, e}
	const t0 = 1_700_000_000_000
	var events []Event
	// A 在 1 分钟内发 30 条 → 防刷截断为 20
	for i := 0; i < 30; i++ {
		events = append(events, msgEvent(fmt.Sprintf("%032x", 0x1000+i), a, t0+int64(i)*1000))
	}
	for i := 0; i < 20; i++ {
		events = append(events, msgEvent(fmt.Sprintf("%032x", 0x2000+i), b, t0+int64(i)*1000))
	}
	for i := 0; i < 20; i++ {
		events = append(events, msgEvent(fmt.Sprintf("%032x", 0x3000+i), c, t0+int64(i)*1000))
	}
	for i := 0; i < 5; i++ {
		events = append(events, msgEvent(fmt.Sprintf("%032x", 0x4000+i), d, t0+int64(i)*1000))
	}
	want := []string{a, b, c, d, e}
	if got := ContributionRank(rankInputs(events), members); !reflect.DeepEqual(got, want) {
		t.Fatalf("rank = %v, want %v（AC 3：A 截断为 20，与 B/C 同分按 id 升序）", got, want)
	}
}

func TestContributionRankReplayStable(t *testing.T) {
	a, b := fixtureID('a'), fixtureID('b')
	const t0 = 1_700_000_000_000
	one := msgEvent("00000000000000000000000000000001", a, t0)
	base := []Event{one, msgEvent("00000000000000000000000000000002", b, t0+1000)}
	first := ContributionRank(rankInputs(base), []string{a, b})
	// 把同一条 event_id 重放 100 次，名次不得变化（AC 3）
	replayed := append([]Event(nil), base...)
	for i := 0; i < 100; i++ {
		replayed = append(replayed, one)
	}
	if got := ContributionRank(rankInputs(dedup(replayed)), []string{a, b}); !reflect.DeepEqual(got, first) {
		t.Fatalf("重放后名次变化: %v != %v", got, first)
	}
}

func TestDeriveSeats(t *testing.T) {
	a, b, c := fixtureID('a'), fixtureID('b'), fixtureID('c')
	const t0 = 1_700_000_000_000
	// m=3 ⇒ k=1，创建者永久 1 席，恒可判定（补充 6）
	snap := DeriveSeats([]string{a, b, c}, a, 3, 3, nil)
	if snap.SeatCount != 1 || !reflect.DeepEqual(snap.Governors, []string{a}) || !snap.Decidable {
		t.Fatalf("m=3 席位错: %+v", snap)
	}
	// m=11 ⇒ k=3，创建者 a + 名次前 2（b、c），可判定
	members := []string{a, b, c}
	for i := 0; i < 9; i++ {
		members = append(members, fmt.Sprintf("%032x", 0x9000+i))
	}
	events := []Event{
		msgEvent("00000000000000000000000000000011", b, t0),
		msgEvent("00000000000000000000000000000012", b, t0+1000),
		msgEvent("00000000000000000000000000000013", c, t0),
	}
	snap = DeriveSeats(members, a, 5, 5, events)
	if snap.SeatCount != 3 || !snap.Decidable {
		t.Fatalf("m=11 席位错: %+v", snap)
	}
	if snap.Governors[0] != a || snap.Governors[1] != b || snap.Governors[2] != c {
		t.Fatalf("m=11 治者错: %v", snap.Governors)
	}
	// m=11 且一条 msg 都没有 ⇒ 不可判定（补充 6）
	if snap := DeriveSeats(members, a, 5, 5, nil); snap.Decidable {
		t.Fatalf("无发言的 m=11 圈应不可判定: %+v", snap)
	}
}

func TestEventWatermark(t *testing.T) {
	// 顺序无关（排序后拼接）
	if EventWatermark([]string{"b", "a"}) != EventWatermark([]string{"a", "b"}) {
		t.Fatal("水位应对 event_id 集合的顺序不敏感")
	}
	if n := len(EventWatermark([]string{"a"})); n != 16 {
		t.Fatalf("水位长度 = %d, want 16", n)
	}
}

// TestRemoveQuorumV2 / TestDissolveVoteQuorumV2 是 Spec v2 §6 纯函数演算测试。
// 直接对照 GovernThreshold + GovernQuorum 的组合公式，不需要数据库。

func TestRemoveQuorumV2(t *testing.T) {
	cases := []struct {
		m, P, F int
		want    int
	}{
		// m=5, base = 10+1+0 = 11, quorum = min(max(11, 3), 5) = 5（阈值 > m 被裁切）
		{5, 0, 0, 5},
		// m=10, base = 10+3+0 = 13, quorum = min(max(13, 5), 10) = 10
		{10, 0, 0, 10},
		// m=20, P=F=3: base = 10+6+2 = 18, quorum = min(max(18, 10), 20) = 18
		{20, 3, 3, 18},
		// m=50, P=10,F=20: base = 10+16+10 = 36, quorum = min(max(36, 25), 50) = 36
		{50, 10, 20, 36},
		// m=100, P=F=0: base = 10+33+0 = 43, ⌈100/2⌉=50 → 50 获胜
		{100, 0, 0, 50},
		// 小圈 m=3: threshold=10+1+0=11 > 3 → 3（全员同意）
		{3, 0, 0, 3},
	}
	for _, c := range cases {
		got := RemoveQuorumV2(c.m, c.P, c.F)
		if got != c.want {
			t.Errorf("RemoveQuorumV2(m=%d,P=%d,F=%d) = %d, want %d", c.m, c.P, c.F, got, c.want)
		}
	}
}

func TestDissolveVoteQuorumV2(t *testing.T) {
	cases := []struct {
		m, P, F int
		want    int
	}{
		// m=10: enhanced = 20+3+0 = 23 > 10 → 10
		{10, 0, 0, 10},
		// m=20, P=F=3: enhanced = 20+6+4 = 30 > 20 → 20
		{20, 3, 3, 20},
		// m=50, P=10,F=20: enhanced = 20+16+20 = 56 > 50 → 50
		{50, 10, 20, 50},
		// m=100, P=F=0: enhanced = 20+33+0 = 53, quorum = min(max(53, 50), 100) = 53
		{100, 0, 0, 53},
		// 互动多 → 门槛高但被裁切：m=30, P=F=20 → enhanced = 20+10+26=56 > 30 → 30
		{30, 20, 20, 30},
	}
	for _, c := range cases {
		got := DissolveVoteQuorumV2(c.m, c.P, c.F)
		if got != c.want {
			t.Errorf("DissolveVoteQuorumV2(m=%d,P=%d,F=%d) = %d, want %d", c.m, c.P, c.F, got, c.want)
		}
	}
}

// TestDissolveV2比RemoveV2门槛高：同样 m/P/F 下 enhanced > base
func TestDissolveV2HigherThanRemoveV2(t *testing.T) {
	m, P, F := 25, 5, 5
	r := RemoveQuorumV2(m, P, F)
	d := DissolveVoteQuorumV2(m, P, F)
	if d < r {
		t.Errorf("DissolveVoteQuorumV2(%d,%d,%d)=%d 不应低于 RemoveQuorumV2=%d", m, P, F, d, r)
	}
}
