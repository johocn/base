package httpapi

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"github.com/johocn/base/internal/protocol"
	"github.com/johocn/base/internal/store"
)

// tagGov2Seed / tagOutsiderSeed 是两个用于打标场景的测试身份（seedGovernor2 / seedOutsider）。
const (
	tagGov2Seed     = "3b1f2a4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708"
	tagOutsiderSeed = "4c2e3b5d6f708192a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f8091a"
)

// tagSubmitBody 造一个 type=tag 的签名请求体（content_hash 按容器口径由客户端算）。
func tagSubmitBody(t *testing.T, seed, name, chapter, section string, links []map[string]string) []byte {
	t.Helper()
	itemID, ok := protocol.TagItemID(name, chapter, section)
	if !ok {
		t.Fatalf("TagItemID(%q,%q,%q) 失败", name, chapter, section)
	}
	title := protocol.TagTitle(name, chapter, section)
	// 与服务端同构：按 (kind 固定序, target_id 升序) 物化后拼 "<kind>\t<text>\n"
	order := map[string]int{"course": 0, "lesson": 1, "article": 2, "comment": 3}
	sorted := append([]map[string]string{}, links...)
	for i := 0; i < len(sorted); i++ {
		for j := i + 1; j < len(sorted); j++ {
			if order[sorted[j]["kind"]] < order[sorted[i]["kind"]] ||
				(order[sorted[j]["kind"]] == order[sorted[i]["kind"]] && sorted[j]["target_id"] < sorted[i]["target_id"]) {
				sorted[i], sorted[j] = sorted[j], sorted[i]
			}
		}
	}
	concat := ""
	for _, l := range sorted {
		concat += l["kind"] + "\t" + l["target_id"] + "\n"
	}
	contentHash := protocol.SHA256Hex([]byte(concat))
	sig := signAuthorForTest(t, seed, itemID, contentHash)
	body, err := json.Marshal(map[string]any{
		"type": "tag", "item_id": itemID, "title": title,
		"links": links, "author_sig": sig,
	})
	if err != nil {
		t.Fatal(err)
	}
	return body
}

// signAuthorForTest 按既有 submitBody 的写法签一条作者归属签名。
func signAuthorForTest(t *testing.T, seed, itemID, contentHash string) string {
	t.Helper()
	id, _ := identityFromSeed(t, seed)
	signBytes, err := protocol.AuthorSignBytes(itemID, contentHash, id)
	if err != nil {
		t.Fatalf("AuthorSignBytes: %v", err)
	}
	sig, err := protocol.Sign(seed, signBytes)
	if err != nil {
		t.Fatalf("Sign: %v", err)
	}
	return sig
}

// seedGovernor 用 testSeed（newSubmitNode 已登记）投一条达质量门槛的 article，使其进入名册。
func seedGovernor(t *testing.T, n *submitNode) string {
	t.Helper()
	body := submitBody(t, testSeed, "article", "article/tag-gov-1", "治理人甲", "body_md", repeat("甲", 200))
	if code, out := postSubmit(t, n, testSeed, body); code != http.StatusOK {
		t.Fatalf("seedGovernor 投稿 code=%d out=%v", code, out)
	}
	return testSeed
}

// seedGovernor2 用另一个 seed 登记并投一条达门槛的 article。
func seedGovernor2(t *testing.T, n *submitNode) string {
	t.Helper()
	n.registerSeed(t, tagGov2Seed)
	body := submitBody(t, tagGov2Seed, "article", "article/tag-gov-2", "治理人乙", "body_md", repeat("乙", 200))
	if code, out := postSubmit(t, n, tagGov2Seed, body); code != http.StatusOK {
		t.Fatalf("seedGovernor2 投稿 code=%d out=%v", code, out)
	}
	return tagGov2Seed
}

// seedOutsider 登记但不投稿 ⇒ 不在名册、不属于任何圈。
func seedOutsider(t *testing.T, n *submitNode) string {
	t.Helper()
	n.registerSeed(t, tagOutsiderSeed)
	return tagOutsiderSeed
}

// seedItem 造一条 active 的容器条目（source/type 取 itemID 首段）。
func (n *submitNode) seedItem(t *testing.T, itemID string) error {
	t.Helper()
	p, _, _ := strings.Cut(itemID, "/")
	return n.st.UpsertSegmentItem(store.SegmentItem{ItemID: itemID, Source: p, Type: p, Title: itemID})
}

// seedEvent 造一条真实入库的事件，返回 event_id。
func (n *submitNode) seedEvent(t *testing.T, groupID, typ string) string {
	t.Helper()
	eid := "0123456789abcdef0123456789abcdef"
	if err := n.st.PutEvent(store.Event{
		EventID: eid, ID: "seed-actor", Type: typ, BodyJSON: `{"action":"msg"}`,
		CreatedAt: 1, TargetID: "group/" + groupID,
	}); err != nil {
		t.Fatalf("PutEvent: %v", err)
	}
	return eid
}

// tagLinkCount 返回一个标签的 tag_links 行数。
func (n *submitNode) tagLinkCount(t *testing.T, tagID string) int {
	t.Helper()
	links, err := n.st.ListTagLinks(tagID)
	if err != nil {
		t.Fatalf("ListTagLinks: %v", err)
	}
	return len(links)
}

// itemExists 判定条目是否存在于 items 表。
func (n *submitNode) itemExists(t *testing.T, itemID string) bool {
	t.Helper()
	_, ok, err := n.st.GetItem(itemID)
	if err != nil {
		t.Fatalf("GetItem: %v", err)
	}
	return ok
}

func TestSubmitTagDirectWrite(t *testing.T) {
	n := newSubmitNode(t)
	seed := seedGovernor(t, n) // 造一个名册内身份（达门槛的 article）
	if err := n.seedItem(t, "course/c1"); err != nil {
		t.Fatal(err)
	}
	body := tagSubmitBody(t, seed, "甲", "第一章", "第一节",
		[]map[string]string{{"target_id": "course/c1", "kind": "course"}})
	code, out := sendAuth(t, signedRequest(t, seed, http.MethodPost, n.public+"/v1/submit", string(body)))
	if code != 200 {
		t.Fatalf("直打失败 code=%d out=%s", code, out)
	}
	tagID, _ := protocol.TagItemID("甲", "第一章", "第一节")
	if got := n.tagLinkCount(t, tagID); got != 1 {
		t.Fatalf("tag_links 行数 = %d", got)
	}
}

func TestSubmitTagRejectsNonGovernor(t *testing.T) {
	n := newSubmitNode(t)
	outsider := seedOutsider(t, n) // 已登记但不在名册、不属于任何圈
	if err := n.seedItem(t, "course/c1"); err != nil {
		t.Fatal(err)
	}
	body := tagSubmitBody(t, outsider, "甲", "第一章", "第一节",
		[]map[string]string{{"target_id": "course/c1", "kind": "course"}})
	code, out := sendAuth(t, signedRequest(t, outsider, http.MethodPost, n.public+"/v1/submit", string(body)))
	if code != 403 || out["code"] != "tag_not_governor" {
		t.Fatalf("code=%d out=%s，want 403 tag_not_governor", code, out)
	}
	tagID, _ := protocol.TagItemID("甲", "第一章", "第一节")
	if n.tagLinkCount(t, tagID) != 0 {
		t.Fatal("被拒时不得写 tag_links")
	}
	if n.itemExists(t, tagID) {
		t.Fatal("被拒时不得建条目")
	}
}

func TestSubmitTagRejectsAlreadyTaggedTarget(t *testing.T) {
	n := newSubmitNode(t)
	seed := seedGovernor(t, n)
	if err := n.seedItem(t, "course/c1"); err != nil {
		t.Fatal(err)
	}
	first := tagSubmitBody(t, seed, "甲", "第一章", "第一节",
		[]map[string]string{{"target_id": "course/c1", "kind": "course"}})
	if code, out := sendAuth(t, signedRequest(t, seed, http.MethodPost, n.public+"/v1/submit", string(first))); code != 200 {
		t.Fatalf("首打失败 code=%d out=%s", code, out)
	}
	// 另一名治理人对同一目标再打（不同标签）→ 403 tag_target_tagged
	other := seedGovernor2(t, n)
	second := tagSubmitBody(t, other, "乙", "第一章", "第一节",
		[]map[string]string{{"target_id": "course/c1", "kind": "course"}})
	code, out := sendAuth(t, signedRequest(t, other, http.MethodPost, n.public+"/v1/submit", string(second)))
	if code != 403 || out["code"] != "tag_target_tagged" {
		t.Fatalf("code=%d out=%s，want 403 tag_target_tagged", code, out)
	}
}

// ① 类红线：② 类（group.v1）事件即使真实存在于本节点，也不能作为 comment 目标。
func TestSubmitTagRejectsGroupEventTarget(t *testing.T) {
	n := newSubmitNode(t)
	seed := seedGovernor(t, n)
	eid := n.seedEvent(t, "g1", "group.v1") // 真实入库的 group.v1 事件
	body := tagSubmitBody(t, seed, "甲", "第一章", "第一节",
		[]map[string]string{{"target_id": "comment/" + eid, "kind": "comment"}})
	code, out := sendAuth(t, signedRequest(t, seed, http.MethodPost, n.public+"/v1/submit", string(body)))
	if code != 400 || out["code"] != "tag_target_not_found" {
		t.Fatalf("code=%d out=%s，want 400 tag_target_not_found", code, out)
	}
}

func TestSubmitTagRejectsTitleMismatchAndBadLinks(t *testing.T) {
	n := newSubmitNode(t)
	seed := seedGovernor(t, n)
	if err := n.seedItem(t, "course/c1"); err != nil {
		t.Fatal(err)
	}
	base := tagSubmitBody(t, seed, "甲", "第一章", "第一节",
		[]map[string]string{{"target_id": "course/c1", "kind": "course"}})
	var m map[string]any
	if err := json.Unmarshal(base, &m); err != nil {
		t.Fatal(err)
	}
	m["title"] = "甲 · 第一章 · 第二节" // 与 item_id 重建值不等
	bad, _ := json.Marshal(m)
	if code, out := sendAuth(t, signedRequest(t, seed, http.MethodPost, n.public+"/v1/submit", string(bad))); code != 400 || out["code"] != "item_title_invalid" {
		t.Fatalf("title 不等 code=%d out=%s", code, out)
	}

	m["title"] = protocol.TagTitle("甲", "第一章", "第一节")
	m["links"] = []map[string]string{{"target_id": "course/c1", "kind": "lesson"}} // kind 与形态不一致
	bad, _ = json.Marshal(m)
	if code, out := sendAuth(t, signedRequest(t, seed, http.MethodPost, n.public+"/v1/submit", string(bad))); code != 400 || out["code"] != "tag_links_invalid" {
		t.Fatalf("kind 不一致 code=%d out=%s", code, out)
	}
}
