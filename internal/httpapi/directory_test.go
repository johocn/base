package httpapi

import (
	"net/http"
	"testing"

	"github.com/johocn/base/internal/store"
)

// directoryHarness 起一个可匿名读的节点（复用 newTestServer），返回 store 与进程内 server。
func directoryHarness(t *testing.T) (*store.Store, *inprocServer) {
	t.Helper()
	st, _, ts := newTestServer(t)
	return st, ts
}

// approvedTermForTest 造一条**已生效**的目录词条（autoApprove=true ⇒ 写目录行 + version+1）。
func approvedTermForTest(t *testing.T, st *store.Store, kind, display, author string) {
	t.Helper()
	p := directoryProposalForTest(kind, display, author)
	if _, _, err := st.CreateDirectoryProposal(p, true); err != nil {
		t.Fatalf("CreateDirectoryProposal(auto=true): %v", err)
	}
}

// pendingProposalForTest 造一条**未定案**的目录提案（autoApprove=false ⇒ 不写目录行），返回 pid。
func pendingProposalForTest(t *testing.T, st *store.Store, kind, display, author string) int64 {
	t.Helper()
	p := directoryProposalForTest(kind, display, author)
	pid, _, err := st.CreateDirectoryProposal(p, false)
	if err != nil {
		t.Fatalf("CreateDirectoryProposal(auto=false): %v", err)
	}
	return pid
}

// directoryProposalForTest 只用导出 API 构造形态合法的目录提案（item_id / body_md / 载荷哈希按契约派生）。
func directoryProposalForTest(kind, display, author string) store.Proposal {
	termKey, ok := store.NormalizeTermKey(display)
	if !ok {
		panic("测试词条键非法: " + display)
	}
	return store.Proposal{
		Action:          store.GovernActionDirectoryAdd,
		ItemID:          store.DirectoryProposalItemID(kind, termKey),
		ProposerID:      author,
		Reason:          "新增词条",
		Title:           display,
		BodyMD:          termKey,
		BaseContentHash: store.DirectoryPayloadHash(kind, termKey),
		CreatedAt:       1,
	}
}

func TestDirectoryGetAnonymousEmpty(t *testing.T) {
	_, ts := directoryHarness(t)
	code, body := getJSON(t, ts.URL+"/v1/directory")
	if code != http.StatusOK {
		t.Fatalf("directory: code=%d body=%v", code, body)
	}
	if _, ok := body["version"].(float64); !ok {
		t.Fatalf("version 缺失或非数字: %#v", body["version"])
	}
	ap, ok := body["approved"].([]any)
	if !ok {
		t.Fatalf("approved 应为数组（空时 [] 而非 null）: %#v", body["approved"])
	}
	if len(ap) != 0 {
		t.Fatalf("approved = %d, want 0", len(ap))
	}
	pd, ok := body["pending"].([]any)
	if !ok {
		t.Fatalf("pending 应为数组（空时 [] 而非 null）: %#v", body["pending"])
	}
	if len(pd) != 0 {
		t.Fatalf("pending = %d, want 0", len(pd))
	}
}

func TestDirectoryGetApprovedAndVersionShortCircuit(t *testing.T) {
	st, ts := directoryHarness(t)
	approvedTermForTest(t, st, store.DirectoryKindCategory, "数学", "author-key-1")

	code, body := getJSON(t, ts.URL+"/v1/directory")
	if code != http.StatusOK {
		t.Fatalf("directory: code=%d body=%v", code, body)
	}
	if body["version"].(float64) != 1 {
		t.Fatalf("version = %v, want 1", body["version"])
	}
	ap := body["approved"].([]any)
	if len(ap) != 1 {
		t.Fatalf("approved = %d, want 1", len(ap))
	}
	first := ap[0].(map[string]any)
	if first["term_key"] != "数学" || first["kind"] != "category" || first["display_name"] != "数学" {
		t.Fatalf("approved 首项异常: %v", first)
	}

	// 带 version 且未变 ⇒ 短路返回 unchanged，且不携带 approved/pending 字段。
	code, body = getJSON(t, ts.URL+"/v1/directory?version=1")
	if code != http.StatusOK {
		t.Fatalf("短路: code=%d body=%v", code, body)
	}
	if body["version"].(float64) != 1 || body["unchanged"] != true {
		t.Fatalf("短路响应异常: %v", body)
	}
	if _, has := body["approved"]; has {
		t.Fatalf("短路响应不应带 approved: %v", body)
	}
}

func TestDirectoryGetPendingWithVotesAndThreshold(t *testing.T) {
	st, ts := directoryHarness(t)
	pendingProposalForTest(t, st, store.DirectoryKindInstructor, "李老师", "author-key-2")

	code, body := getJSON(t, ts.URL+"/v1/directory")
	if code != http.StatusOK {
		t.Fatalf("directory: code=%d body=%v", code, body)
	}
	pd := body["pending"].([]any)
	if len(pd) != 1 {
		t.Fatalf("pending = %d, want 1", len(pd))
	}
	item := pd[0].(map[string]any)
	if item["kind"] != "instructor" || item["term_key"] != "李老师" || item["display_name"] != "李老师" {
		t.Fatalf("pending 首项异常: %v", item)
	}
	// 测试节点名册为空 ⇒ rosterOK=true 且 0<10 ⇒ 门槛 1；票权按名册过滤 ⇒ 0 票。
	if got, ok := item["votes"].(float64); !ok || got != 0 {
		t.Fatalf("votes = %v, want 0", item["votes"])
	}
	if got, ok := item["threshold"].(float64); !ok || got != 1 {
		t.Fatalf("threshold = %v, want 1", item["threshold"])
	}
}
