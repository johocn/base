package store

import (
	"strings"
	"testing"
)

// TestNormalizeTermKey 覆盖册子 #58 §2.2 的六步规范化（双端同构）。
func TestNormalizeTermKey(t *testing.T) {
	cases := []struct {
		in   string
		want string
		ok   bool
	}{
		{"  数学  ", "数学", true},
		{"Ｍath", "math", true},               // 全角→半角 + ASCII 小写折叠
		{"A  B\tC", "a b c", true},           // 空白折叠
		{"", "", false},                      // 空 ⇒ 非法
		{strings.Repeat("字", 65), "", false}, // >64 rune ⇒ 非法
		{"\x01数学", "数学", true},               // 剥离控制字符
	}
	for _, c := range cases {
		got, ok := NormalizeTermKey(c.in)
		if ok != c.ok || got != c.want {
			t.Errorf("NormalizeTermKey(%q)=(%q,%v), want (%q,%v)", c.in, got, ok, c.want, c.ok)
		}
	}
}

// TestCleanDisplayName 展示名清洗保留全角与大小写，只做 TrimSpace + 空白折叠 + 剥离控制字符。
func TestCleanDisplayName(t *testing.T) {
	if got := CleanDisplayName("  Ｍath  数学\x01  "); got != "Ｍath 数学" {
		t.Fatalf("CleanDisplayName = %q, want %q", got, "Ｍath 数学")
	}
	if got := CleanDisplayName("   "); got != "" {
		t.Fatalf("CleanDisplayName(空白) = %q, want 空", got)
	}
}

// TestDirectoryTermRoundTrip 落库后状态 / 展示名正确，ListDirectory 正确分流 approved / pending。
func TestDirectoryTermRoundTrip(t *testing.T) {
	st := openTemp(t)
	// 空库时 ListDirectory 必须返回非 nil 空切片（响应侧要输出 [] 而非 null）。
	approved, pending, err := st.ListDirectory()
	if err != nil {
		t.Fatalf("ListDirectory(空): %v", err)
	}
	if approved == nil || pending == nil {
		t.Fatalf("ListDirectory(空) 返回 nil 切片: approved=%v pending=%v", approved, pending)
	}
	if len(approved) != 0 || len(pending) != 0 {
		t.Fatalf("空库列表非空: approved=%d pending=%d", len(approved), len(pending))
	}

	if err := approveDirectoryTermExec(st.db, DirectoryKindCategory, "数学", "数学", "id-a"); err != nil {
		t.Fatalf("approveDirectoryTermExec: %v", err)
	}
	if err := upsertDirectoryTermExec(st.db, DirectoryKindInstructor, "李老师", "李老师", "id-b", DirectoryStatePending, nowUTC()); err != nil {
		t.Fatalf("upsertDirectoryTermExec: %v", err)
	}

	got, ok, err := st.GetDirectoryTerm(DirectoryKindCategory, "数学")
	if err != nil || !ok {
		t.Fatalf("GetDirectoryTerm ok=%v err=%v", ok, err)
	}
	if got.State != DirectoryStateApproved || got.DisplayName != "数学" || got.FirstAuthorID != "id-a" {
		t.Fatalf("词条字段错误: %+v", got)
	}

	approved, pending, err = st.ListDirectory()
	if err != nil {
		t.Fatalf("ListDirectory: %v", err)
	}
	if len(approved) != 1 || approved[0].TermKey != "数学" {
		t.Fatalf("approved=%+v", approved)
	}
	if len(pending) != 1 || pending[0].TermKey != "李老师" {
		t.Fatalf("pending=%+v", pending)
	}

	if _, ok, err := st.GetDirectoryTerm(DirectoryKindTag, "nope"); err != nil || ok {
		t.Fatalf("GetDirectoryTerm(未登记) ok=%v err=%v, want false/nil", ok, err)
	}
}

// TestDirectoryVersionMonotonic 缺省 0；每次 bump 递增；DirectoryVersion 读回最新值。
func TestDirectoryVersionMonotonic(t *testing.T) {
	st := openTemp(t)
	v, err := st.DirectoryVersion()
	if err != nil || v != 0 {
		t.Fatalf("缺省 DirectoryVersion=%d err=%v, want 0", v, err)
	}
	v1, err := bumpDirectoryVersionExec(st.db)
	if err != nil || v1 != 1 {
		t.Fatalf("bump(1)=%d err=%v, want 1", v1, err)
	}
	v2, err := bumpDirectoryVersionExec(st.db)
	if err != nil || v2 != 2 {
		t.Fatalf("bump(2)=%d err=%v, want 2", v2, err)
	}
	got, err := st.DirectoryVersion()
	if err != nil || got != 2 {
		t.Fatalf("DirectoryVersion=%d err=%v, want 2", got, err)
	}
}

// TestDirectoryProposalItemID 派生 item_id 为纯 ASCII 且 ≤256 字节（validTargetID 约束），反解析可往返。
func TestDirectoryProposalItemID(t *testing.T) {
	for _, kind := range []string{DirectoryKindCategory, DirectoryKindInstructor, DirectoryKindTag} {
		for _, key := range []string{"数学", "math", "李老师", strings.Repeat("字", 64)} {
			id := DirectoryProposalItemID(kind, key)
			if !isASCIIBytes(id) || len(id) > 256 || len(id) == 0 {
				t.Fatalf("item_id %q 违反 validTargetID（ASCII / 1..256 字节）", id)
			}
			gotKind, ok := DirectoryKindOfItemID(id)
			if !ok || gotKind != kind {
				t.Fatalf("DirectoryKindOfItemID(%q)=(%q,%v), want %q", id, gotKind, ok, kind)
			}
		}
	}
	if DirectoryProposalItemID("category", "数学") != DirectoryProposalItemID("category", "数学") {
		t.Fatal("item_id 对同一 (kind,term_key) 必须确定")
	}
	if _, ok := DirectoryKindOfItemID("dir/category"); ok {
		t.Fatal("缺 hash 段应解析失败")
	}
	if _, ok := DirectoryKindOfItemID("article:demo-1"); ok {
		t.Fatal("非目录 item_id 应解析失败")
	}
}

// TestFindPendingDirectoryProposal 无提案 ⇒ 未命中；未定案 ⇒ 命中并用派生 item_id 归并；已定案 ⇒ 不再命中。
func TestFindPendingDirectoryProposal(t *testing.T) {
	st := openTemp(t)
	itemID := DirectoryProposalItemID(DirectoryKindCategory, "数学")
	if _, ok, err := st.FindPendingDirectoryProposal(itemID); err != nil || ok {
		t.Fatalf("无提案时 ok=%v err=%v, want false/nil", ok, err)
	}

	res, err := st.db.Exec(`INSERT INTO govern_proposals(action,item_id,proposer_id,reason,title,body_md,base_content_hash,created_at)
		VALUES(?,?,?,?,?,?,?,?)`,
		"directory_add", itemID, "id-a", "r", "数学", "数学", DirectoryPayloadHash(DirectoryKindCategory, "数学"), int64(1))
	if err != nil {
		t.Fatalf("插入提案行: %v", err)
	}
	pid, err := res.LastInsertId()
	if err != nil {
		t.Fatalf("LastInsertId: %v", err)
	}
	if _, err := st.db.Exec(`INSERT INTO govern_votes(proposal_id,voter_id,created_at) VALUES(?,?,?)`, pid, "id-a", int64(1)); err != nil {
		t.Fatalf("插入票: %v", err)
	}

	got, ok, err := st.FindPendingDirectoryProposal(itemID)
	if err != nil || !ok || got != pid {
		t.Fatalf("FindPendingDirectoryProposal=(%d,%v,%v), want (%d,true,nil)", got, ok, err, pid)
	}

	// 票数按名册过滤：名册含提案人 ⇒ 1；空名册 ⇒ 0。
	if n, err := st.DirectoryPendingVotes(itemID, map[string]bool{"id-a": true}); err != nil || n != 1 {
		t.Fatalf("DirectoryPendingVotes(名册含提案人)=%d err=%v, want 1", n, err)
	}
	if n, err := st.DirectoryPendingVotes(itemID, map[string]bool{}); err != nil || n != 0 {
		t.Fatalf("DirectoryPendingVotes(空名册)=%d err=%v, want 0", n, err)
	}

	// 定案后不再命中。
	if _, err := st.db.Exec(`UPDATE govern_proposals SET executed_at=? WHERE proposal_id=?`, int64(2), pid); err != nil {
		t.Fatalf("置 executed_at: %v", err)
	}
	if _, ok, err := st.FindPendingDirectoryProposal(itemID); err != nil || ok {
		t.Fatalf("已定案时 ok=%v err=%v, want false/nil", ok, err)
	}
}

// isASCIIBytes 镜像 httpapi.validTargetID 的字节约束，供本包测试断言派生 item_id 合法。
func isASCIIBytes(s string) bool {
	for i := 0; i < len(s); i++ {
		if s[i] >= 0x80 {
			return false
		}
	}
	return true
}
