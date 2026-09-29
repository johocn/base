package store

import (
	"errors"
	"fmt"
	"testing"
)

// groupEventHex 造一个 16 字节（32 hex）的事件 id，形状与契约一致。
func groupEventHex(n int) string { return fmt.Sprintf("%032x", n) }

// 验收 5（数据层口径）：首个 roster 锁定 creator_id，换 actor 必被拒且不动行。
func TestPutGroupRosterLocksOwner(t *testing.T) {
	st := openTemp(t)
	const gid = "group-owner"

	if err := st.PutGroupRoster(GroupRoster{
		GroupID: gid, CreatorID: "owner-1", Epoch: 1,
		MemberIDsJSON: `["m1"]`, EventID: groupEventHex(1),
	}); err != nil {
		t.Fatalf("首写 roster: %v", err)
	}
	g, ok, err := st.GetGroup(gid)
	if err != nil || !ok {
		t.Fatalf("首写后读回 err=%v ok=%v", err, ok)
	}
	if g.CreatorID != "owner-1" || g.Epoch != 1 || g.MemberIDsJSON != `["m1"]` || g.EventID != groupEventHex(1) {
		t.Fatalf("首写投影 = %+v", g)
	}

	// 换 actor：即使 epoch 更大，也必须被 owner 锁拒绝
	if err := st.PutGroupRoster(GroupRoster{
		GroupID: gid, CreatorID: "owner-2", Epoch: 2,
		MemberIDsJSON: `["m2"]`, EventID: groupEventHex(2),
	}); !errors.Is(err, ErrGroupOwnerMismatch) {
		t.Fatalf("换 owner 应 ErrGroupOwnerMismatch, got %v", err)
	}

	// 被拒的请求不得改动任何一列
	g2, ok, err := st.GetGroup(gid)
	if err != nil || !ok {
		t.Fatalf("拒绝后读回 err=%v ok=%v", err, ok)
	}
	if g2.CreatorID != "owner-1" || g2.Epoch != 1 || g2.MemberIDsJSON != `["m1"]` || g2.EventID != groupEventHex(1) {
		t.Fatalf("被拒的写改动了投影: %+v", g2)
	}
}

// 验收 6（数据层口径）：epoch 必须严格更大——相等或更小都是 stale，且不动行。
func TestPutGroupRosterEpochMonotonic(t *testing.T) {
	st := openTemp(t)
	const gid = "group-epoch"
	put := func(epoch int64, members string) error {
		t.Helper()
		return st.PutGroupRoster(GroupRoster{
			GroupID: gid, CreatorID: "owner", Epoch: epoch,
			MemberIDsJSON: members, EventID: groupEventHex(int(epoch)),
		})
	}

	if err := put(3, `["a"]`); err != nil {
		t.Fatalf("首写 epoch=3: %v", err)
	}
	if err := put(3, `["b"]`); !errors.Is(err, ErrGroupEpochStale) {
		t.Fatalf("相等 epoch 应 ErrGroupEpochStale, got %v", err)
	}
	if err := put(2, `["c"]`); !errors.Is(err, ErrGroupEpochStale) {
		t.Fatalf("更小 epoch 应 ErrGroupEpochStale, got %v", err)
	}

	g, ok, err := st.GetGroup(gid)
	if err != nil || !ok || g.Epoch != 3 || g.MemberIDsJSON != `["a"]` {
		t.Fatalf("两次被拒的写改动了投影: %+v ok=%v err=%v", g, ok, err)
	}

	if err := put(4, `["d"]`); err != nil {
		t.Fatalf("更大 epoch 应成功: %v", err)
	}
	g, _, _ = st.GetGroup(gid)
	if g.Epoch != 4 || g.MemberIDsJSON != `["d"]` || g.EventID != groupEventHex(4) {
		t.Fatalf("推进后投影 = %+v", g)
	}
}

// 反熵接收侧：ForceGroupRoster 不裁决 owner、只收更大 epoch、旧值静默忽略、返回是否写入。
func TestForceGroupRosterOnlyNewer(t *testing.T) {
	st := openTemp(t)
	const gid = "group-force"
	force := func(creator string, epoch int64, members string) bool {
		t.Helper()
		wrote, err := st.ForceGroupRoster(GroupRoster{
			GroupID: gid, CreatorID: creator, Epoch: epoch,
			MemberIDsJSON: members, EventID: groupEventHex(int(epoch)),
		})
		if err != nil {
			t.Fatalf("ForceGroupRoster epoch=%d: %v", epoch, err)
		}
		return wrote
	}

	// 空表首写：不校验 owner，直接落行
	if !force("peer-a", 5, `["a"]`) {
		t.Fatal("空表首写必须写入")
	}
	// 相等 / 更小：静默忽略并返回 false
	if force("peer-a", 5, `["b"]`) {
		t.Fatal("相等 epoch 不应写入")
	}
	if force("peer-a", 4, `["c"]`) {
		t.Fatal("更小 epoch 不应写入")
	}
	g, ok, err := st.GetGroup(gid)
	if err != nil || !ok || g.Epoch != 5 || g.MemberIDsJSON != `["a"]` {
		t.Fatalf("被忽略的写改动了投影: %+v ok=%v err=%v", g, ok, err)
	}

	// 更大：写入；owner 不参与裁决
	if !force("peer-b", 6, `["d"]`) {
		t.Fatal("更大 epoch 必须写入")
	}
	g, _, _ = st.GetGroup(gid)
	if g.Epoch != 6 || g.MemberIDsJSON != `["d"]` || g.EventID != groupEventHex(6) {
		t.Fatalf("推进后投影 = %+v", g)
	}
	if g.CreatorID != "peer-a" {
		t.Fatalf("反熵写入不得改写 owner 列: %+v", g)
	}
}

// 验收 4（读侧）：ListGroupEvents 只出本组 group.v1、按 (created_at,event_id) 倒序、游标取更旧一页。
func TestListGroupEventsPaging(t *testing.T) {
	st := openTemp(t)
	const g1, g2 = "group-1", "group-2"
	put := func(eventID, typ, target string, createdAt int64) {
		t.Helper()
		if err := st.PutEvent(Event{
			EventID: eventID, ID: "actor-" + eventID, Type: typ, BodyJSON: `{}`,
			CreatedAt: createdAt, ReceivedAt: createdAt, TargetID: target,
		}); err != nil {
			t.Fatalf("PutEvent %s: %v", eventID, err)
		}
	}
	put(groupEventHex(1), "group.v1", "group/"+g1, 100)   // 本组 msg
	put(groupEventHex(2), "group.v1", "group/"+g1, 200)   // 本组 roster
	put(groupEventHex(3), "group.v1", "group/"+g1, 300)   // 本组 msg
	put(groupEventHex(4), "group.v1", "group/"+g2, 400)   // 别组，必须过滤
	put(groupEventHex(5), "comment.v1", "group/"+g1, 500) // 别类型，必须过滤

	rows, err := st.ListGroupEvents(g1, 0, "", 10)
	if err != nil || len(rows) != 3 {
		t.Fatalf("应只出本组 3 条 err=%v rows=%+v", err, rows)
	}
	want := []string{groupEventHex(3), groupEventHex(2), groupEventHex(1)}
	for i, id := range want {
		if rows[i].EventID != id {
			t.Fatalf("应按 created_at 倒序: %+v", rows)
		}
	}
	if rows[0].TargetID != "group/"+g1 {
		t.Fatalf("目标过滤错误: %+v", rows[0])
	}

	// 游标：严格更旧
	page, err := st.ListGroupEvents(g1, 300, groupEventHex(3), 10)
	if err != nil || len(page) != 2 || page[0].EventID != groupEventHex(2) {
		t.Fatalf("游标翻页 err=%v rows=%+v", err, page)
	}

	// limit 生效
	one, err := st.ListGroupEvents(g1, 0, "", 1)
	if err != nil || len(one) != 1 || one[0].EventID != groupEventHex(3) {
		t.Fatalf("limit 未生效 err=%v rows=%+v", err, one)
	}
}

func TestPutGroupRosterV2MonotonicAndFormLock(t *testing.T) {
	st := openTemp(t)
	base := GroupRoster{GroupID: "g1", CreatorID: "c1", Epoch: 1, RosterRev: 1,
		Encrypted: 1, MemberIDsJSON: `["c1"]`, EventID: "e1"}

	// 首写（无行）→ 成立
	if err := st.PutGroupRosterV2(base); err != nil {
		t.Fatalf("首写: %v", err)
	}
	// epoch 相等 → ErrGroupEpochStale
	if err := st.PutGroupRosterV2(GroupRoster{GroupID: "g1", Epoch: 1, RosterRev: 2,
		Encrypted: 1, MemberIDsJSON: `["c1"]`, EventID: "e2"}); !errors.Is(err, ErrGroupEpochStale) {
		t.Fatalf("epoch 未递增应报 stale，得 %v", err)
	}
	// roster_rev 未递增 → ErrGroupRosterRevStale
	if err := st.PutGroupRosterV2(GroupRoster{GroupID: "g1", Epoch: 2, RosterRev: 1,
		Encrypted: 1, MemberIDsJSON: `["c1"]`, EventID: "e3"}); !errors.Is(err, ErrGroupRosterRevStale) {
		t.Fatalf("roster_rev 未递增应报 stale，得 %v", err)
	}
	// 形态切换 → ErrGroupFormLocked（册子 §3.1）
	if err := st.PutGroupRosterV2(GroupRoster{GroupID: "g1", Epoch: 2, RosterRev: 2,
		Encrypted: 0, MemberIDsJSON: `["c1"]`, EventID: "e4"}); !errors.Is(err, ErrGroupFormLocked) {
		t.Fatalf("形态切换应被拒，得 %v", err)
	}
	// 正常推进
	if err := st.PutGroupRosterV2(GroupRoster{GroupID: "g1", Epoch: 2, RosterRev: 2,
		Encrypted: 1, MemberIDsJSON: `["c1","m2"]`, KeyEnvelopesJSON: `[{"from_epoch":1,"cipher":"x"}]`,
		EventID: "e5"}); err != nil {
		t.Fatalf("推进: %v", err)
	}
	g, ok, err := st.GetGroup("g1")
	if err != nil || !ok {
		t.Fatalf("GetGroup: ok=%v err=%v", ok, err)
	}
	if g.Epoch != 2 || g.RosterRev != 2 || g.Encrypted != 1 || g.KeyEnvelopesJSON != `[{"from_epoch":1,"cipher":"x"}]` {
		t.Fatalf("读回错: %+v", g)
	}
}