package store

import "testing"

// seedCourse 造一门带归属的课程（author_id=author）；lessons 为 seq>=1 的课时 id 列表。
// 直接走 UpsertSegmentSubmission：它同事务写 items.author_id 与 segments，且不验签。
func seedCourse(t *testing.T, st *Store, courseID, author string, lessons []string) {
	t.Helper()
	segs := []Segment{}
	for i, lid := range lessons {
		segs = append(segs, Segment{ItemID: courseID, Seq: i + 1, Kind: "lesson", Text: lid})
	}
	if _, err := st.UpsertSegmentSubmission(SegmentSubmission{
		ItemID: courseID, Type: "course", Title: "课", Segments: segs, AuthorID: author, AuthorSig: "00",
	}); err != nil {
		t.Fatalf("UpsertSegmentSubmission(%s): %v", courseID, err)
	}
}

// seedProgress 直接写一行 progress（测试造数，绕过事件投影）。
func seedProgress(t *testing.T, st *Store, learnerID, itemID string) {
	t.Helper()
	if _, err := st.db.Exec(`INSERT INTO progress(id,item_id,position,done,day,updated_at,event_id,dirty)
		VALUES(?,?,?,?,?,?,?,0)`, learnerID, itemID, 0, 0, "2026-10-01", 1, "ev-"+learnerID+"-"+itemID); err != nil {
		t.Fatalf("造 progress: %v", err)
	}
}

func TestFreeRemoveEligible(t *testing.T) {
	// 组 1：仅创建者、无课时 ⇒ true
	st := openTemp(t)
	seedCourse(t, st, "course/c1", authorA, nil)
	if got, err := freeRemoveEligible(st.db, "course/c1", authorA); err != nil || !got {
		t.Fatalf("无课时应可免票选: got=%v err=%v", got, err)
	}
	// 组 4：非创建者（如名册内治理者）⇒ false
	if got, err := freeRemoveEligible(st.db, "course/c1", authorB); err != nil || got {
		t.Fatalf("非创建者不应免票选: got=%v err=%v", got, err)
	}
	// 组 3：有课时、无他人 progress ⇒ true（此处同时验证「有课时」不短路为假）
	st2 := openTemp(t)
	seedCourse(t, st2, "course/c2", authorA, []string{"course/c2/lesson/l1"})
	if got, err := freeRemoveEligible(st2.db, "course/c2", authorA); err != nil || !got {
		t.Fatalf("有课时但无他人学习应可免票选: got=%v err=%v", got, err)
	}
	// 组 2：有他人 progress ⇒ false
	seedProgress(t, st2, authorB, "course/c2/lesson/l1")
	if got, err := freeRemoveEligible(st2.db, "course/c2", authorA); err != nil || got {
		t.Fatalf("有他人学习不应免票选: got=%v err=%v", got, err)
	}
	// 创建者自己的 progress 不算「他人」
	st3 := openTemp(t)
	seedCourse(t, st3, "course/c3", authorA, []string{"course/c3/lesson/l1"})
	seedProgress(t, st3, authorA, "course/c3/lesson/l1")
	if got, err := freeRemoveEligible(st3.db, "course/c3", authorA); err != nil || !got {
		t.Fatalf("仅创建者自己的 progress 仍应可免票选: got=%v err=%v", got, err)
	}
	// 课时同规则（册子 §5 第 4 条）：条件 2 不适用，只看条件 3
	st4 := openTemp(t)
	if _, err := st4.UpsertSegmentSubmission(SegmentSubmission{
		ItemID: "course/c4/lesson/l1", Type: "lesson", Title: "课",
		Segments: []Segment{{ItemID: "course/c4/lesson/l1", Seq: -1, Kind: "attr.cover", Text: "x"}},
		AuthorID: authorA, AuthorSig: "00",
	}); err != nil {
		t.Fatalf("造课时: %v", err)
	}
	if got, err := freeRemoveEligible(st4.db, "course/c4/lesson/l1", authorA); err != nil || !got {
		t.Fatalf("课时无他人学习应可免票选: got=%v err=%v", got, err)
	}
	seedProgress(t, st4, authorB, "course/c4/lesson/l1")
	if got, err := freeRemoveEligible(st4.db, "course/c4/lesson/l1", authorA); err != nil || got {
		t.Fatalf("课时有他人学习不应免票选: got=%v err=%v", got, err)
	}
	// 非容器（article）⇒ false
	st5 := openTemp(t)
	if got, err := freeRemoveEligible(st5.db, "article/x", authorA); err != nil || got {
		t.Fatalf("非容器条目不应免票选: got=%v err=%v", got, err)
	}
}

// 无课时课程：Spec v2 §3.5 shouldFreeExec 在 CreateProposal 层直接生效（不再依赖 Settle）。
// executed_result 记 "free_exec:removed"（前缀标识免票选，后缀是 governApplyTx 的返回值）。
func TestFreeRemoveSettlesImmediately(t *testing.T) {
	st := openTemp(t)
	seedCourse(t, st, "course/c6", authorA, nil)
	it, ok, err := st.GetItem("course/c6")
	if err != nil || !ok {
		t.Fatalf("GetItem: ok=%v err=%v", ok, err)
	}
	id, err := st.CreateProposal(Proposal{
		Action: GovernActionRemove, ItemID: "course/c6", ProposerID: authorA,
		BaseContentHash: it.ContentHash, CreatedAt: 1,
	})
	if err != nil {
		t.Fatalf("CreateProposal: %v", err)
	}
	// CreateProposal 里 shouldFreeExec 应已直接执行 → executed_at 非零
	p, _, err := st.GetProposal(id)
	if err != nil {
		t.Fatalf("GetProposal: %v", err)
	}
	if p.ExecutedAt == 0 {
		t.Fatalf("shouldFreeExec 应在 CreateProposal 层直接生效: %+v", p)
	}
	if p.ExecutedResult != "free_exec:removed" {
		t.Fatalf("executed_result 应为 free_exec:removed, 得 %q", p.ExecutedResult)
	}
	// SettleGovernProposal 应幂等跳过（已定案）
	if err := st.SettleGovernProposal(id, govRoster(), false); err != nil {
		t.Fatalf("SettleGovernProposal: %v", err)
	}
	after, ok, err := st.GetItem("course/c6")
	if err != nil || !ok || after.State != "removed" {
		t.Fatalf("应已下架: ok=%v it=%+v err=%v", ok, after, err)
	}
}

// 有他人学习的课程：即便已投影，settle 也停留 pending、门槛仍 3（AC 6）。
func TestFreeRemoveNotAppliedWhenOthersLearned(t *testing.T) {
	st := openTemp(t)
	seedCourse(t, st, "course/c7", authorA, []string{"course/c7/lesson/l1"})
	seedProgress(t, st, authorB, "course/c7/lesson/l1")
	id, err := st.CreateProposal(Proposal{
		Action: GovernActionRemove, ItemID: "course/c7", ProposerID: authorA,
		BaseContentHash: "", CreatedAt: 1,
	})
	if err != nil {
		t.Fatalf("CreateProposal: %v", err)
	}
	if err := st.SettleGovernProposal(id, govRoster(), false); err != nil {
		t.Fatalf("SettleGovernProposal: %v", err)
	}
	p, _, err := st.GetProposal(id)
	if err != nil {
		t.Fatalf("GetProposal: %v", err)
	}
	if p.ExecutedAt != 0 || p.VoidedAt != 0 {
		t.Fatalf("有他人学习不应定案（门槛仍 3、票不足）: %+v", p)
	}
	if got := governThresholdLegacy(GovernActionRemove); got != 3 {
		t.Fatalf("remove 门槛应仍为 3，得 %d", got)
	}
}
