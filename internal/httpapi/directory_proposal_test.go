package httpapi

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/johocn/base/internal/store"
)

// directoryBody 造一份 directory_add 提案体（册子 #58 §3.1）。
func directoryBody(t *testing.T, kind, termKey, display string) string {
	t.Helper()
	return mustJSON(t, map[string]any{
		"action": "directory_add",
		"directory": map[string]any{
			"kind": kind, "term_key": termKey, "display_name": display,
		},
	})
}

// approvedTermKeys 读 GET /v1/directory 的 approved 词条键集。
func approvedTermKeys(t *testing.T, baseURL string) map[string]string {
	t.Helper()
	code, body := getJSON(t, baseURL+"/v1/directory")
	if code != http.StatusOK {
		t.Fatalf("GET /v1/directory code=%d body=%v", code, body)
	}
	approved, _ := body["approved"].([]any)
	out := make(map[string]string, len(approved))
	for _, raw := range approved {
		m, _ := raw.(map[string]any)
		key, _ := m["term_key"].(string)
		display, _ := m["display_name"].(string)
		out[key] = display
	}
	return out
}

// AC 1：中文词条经签名写路径落库；名册 4（< 10）小节点豁免 ⇒ 提交即 effective、目录读接口可见。
func TestDirectoryProposalAddChineseTerm(t *testing.T) {
	n := fourGovernors(t)
	code, out := n.post(t, govSeedA, "/v1/proposal", directoryBody(t, "category", "数学", "数学"))
	if code != http.StatusCreated {
		t.Fatalf("code=%d out=%v", code, out)
	}
	if out["status"] != "effective" {
		t.Fatalf("小节点应提交即 approved: %v", out)
	}
	itemID, _ := out["item_id"].(string)
	if !strings.HasPrefix(itemID, "dir/category/") {
		t.Fatalf("item_id 前缀应为 dir/category/: %q", itemID)
	}
	if got := approvedTermKeys(t, n.public); got["数学"] != "数学" {
		t.Fatalf("approved 应含数学: %v", got)
	}
}

// AC 2：term_key 与规范化结果不一致、或 kind 非法 ⇒ 400 proposal_directory_invalid。
func TestDirectoryProposalRejectsBadPayload(t *testing.T) {
	n := fourGovernors(t)
	// display_name 规范化为“数学”，而 term_key 给了 "Math" ⇒ 不一致。
	code, out := n.post(t, govSeedA, "/v1/proposal", directoryBody(t, "category", "Math", "数学"))
	if code != http.StatusBadRequest || out["code"] != "proposal_directory_invalid" {
		t.Fatalf("term_key 不一致应 400: code=%d out=%v", code, out)
	}
	code, out = n.post(t, govSeedA, "/v1/proposal", directoryBody(t, "bogus", "x", "x"))
	if code != http.StatusBadRequest || out["code"] != "proposal_directory_invalid" {
		t.Fatalf("坏 kind 应 400: code=%d out=%v", code, out)
	}
	if _, ok, _ := n.st.GetProposal(1); ok {
		t.Fatal("拒绝时不得落库")
	}
}

// AC 4：directory_add 资格放宽——非名册身份可提；对照 remove 仍要求名册内。
func TestDirectoryProposalNonGovernorAllowed(t *testing.T) {
	n := fourGovernors(t)
	if code, out := n.post(t, govSeedX, "/v1/proposal", directoryBody(t, "category", "物理", "物理")); code != http.StatusCreated {
		t.Fatalf("非名册提 directory_add 不应被拒: code=%d out=%v", code, out)
	}
	code, out := n.post(t, govSeedX, "/v1/proposal", proposalBody(t, "remove", "article/gb", nil))
	if code != http.StatusForbidden || out["code"] != "proposer_not_governor" {
		t.Fatalf("非名册提 remove 应 403: code=%d out=%v", code, out)
	}
}

// AC 5：同键归并——已 approved 时第二次提交短路为 200 merged，不再产出第二条提案。
func TestDirectoryProposalMergeOnSameKey(t *testing.T) {
	n := fourGovernors(t)
	if code, out := n.post(t, govSeedA, "/v1/proposal", directoryBody(t, "category", "数学", "数学")); code != http.StatusCreated {
		t.Fatalf("首次 code=%d out=%v", code, out)
	}
	code, out := n.post(t, govSeedB, "/v1/proposal", directoryBody(t, "category", "数学", "数学"))
	if code != http.StatusOK || out["merged"] != true {
		t.Fatalf("同键二次应 200 merged: code=%d out=%v", code, out)
	}
	count := 0
	for _, p := range proposalListOf(t, n.public) {
		if p["action"] == "directory_add" {
			count++
		}
	}
	if count != 1 {
		t.Fatalf("同键应只 1 条 directory_add 提案: %d", count)
	}
}

// AC 5：事件路径——直接投一条 directory_add 的 govern.v1 proposal 事件，目录读接口出现该词条。
func TestDirectoryProposalViaGovernEvent(t *testing.T) {
	n := fourGovernors(t)
	body := map[string]any{
		"action": "proposal", "proposal_id": "7", "target_item_id": store.DirectoryProposalItemID("category", "物理"),
		"verb": "directory_add", "content_hash": store.DirectoryPayloadHash("category", "物理"),
		"content_version": 0, "revoked_rev": 0,
		"directory_kind": "category", "directory_term_key": "物理", "directory_display_name": "物理",
	}
	if code, out := postGovernEvent(t, govSeedA, n.public, eventIDOf(91), time.Now().UnixMilli(), body); code != http.StatusOK {
		t.Fatalf("事件 code=%d out=%v", code, out)
	}
	if got := approvedTermKeys(t, n.public); got["物理"] != "物理" {
		t.Fatalf("事件路径应落词条: %v", got)
	}
}

// AC 5：parseGovernBody 严格键集——未知键 / 缺 directory_term_key 拒，完整合法放行。
func TestParseGovernBodyDirectoryKeys(t *testing.T) {
	valid := map[string]any{
		"action": "proposal", "proposal_id": "7", "target_item_id": store.DirectoryProposalItemID("category", "物理"),
		"verb": "directory_add", "content_hash": store.DirectoryPayloadHash("category", "物理"),
		"content_version": 0, "revoked_rev": 0,
		"directory_kind": "category", "directory_term_key": "物理", "directory_display_name": "物理",
	}
	// ① 未知键 ⇒ 拒。
	withUnknown := map[string]any{"foo": 1}
	for k, v := range valid {
		withUnknown[k] = v
	}
	if _, _, ok := parseGovernBody(json.RawMessage(mustJSON(t, withUnknown))); ok {
		t.Fatal("未知键应拒")
	}
	// ② verb=directory_add 但缺 directory_term_key ⇒ 拒。
	missing := map[string]any{}
	for k, v := range valid {
		missing[k] = v
	}
	delete(missing, "directory_term_key")
	if _, _, ok := parseGovernBody(json.RawMessage(mustJSON(t, missing))); ok {
		t.Fatal("缺 directory_term_key 应拒")
	}
	// ③ 完整合法 ⇒ 通过且三键可见。
	m, _, ok := parseGovernBody(json.RawMessage(mustJSON(t, valid)))
	if !ok || m["directory_kind"] != "category" || m["directory_display_name"] != "物理" {
		t.Fatalf("完整合法应通过: ok=%v m=%v", ok, m)
	}
}
