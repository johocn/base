package httpapi

import (
	"encoding/json"
	"net/http"
	"os"
	"reflect"
	"strings"
	"testing"

	"github.com/johocn/base/internal/protocol"
	"github.com/johocn/base/internal/store"
)

// G3 双端对拍（#79 Task 11）：同数据集下 comment / catalog / reported 三读面
// JSON 逐字段一致。golden fixture 与 Node 侧 apps/node/src/golden-like.test.ts 共享。
//
// 固定数据集（两侧逐字一致）：
//   - pack v1（pack-golden-0001）+ 条目 article/a1（active/public，正文 "甲正文\n"）
//   - 评论 c1（actorA，created_at=300，2 赞 2 举报人）、c2（actorB，created_at=200，like+unlike 归零、1 举报）
//   - 条目自身 A、B 各一赞 → catalog like_count=2
const goldenPath = "../../docs/superpowers/plans/fixtures/like-golden.json"

const goldenBody = "甲正文\n"

func loadGolden(t *testing.T) map[string]any {
	t.Helper()
	raw, err := os.ReadFile(goldenPath)
	if err != nil {
		t.Fatalf("读 golden fixture: %v", err)
	}
	var out map[string]any
	if err := json.Unmarshal(raw, &out); err != nil {
		t.Fatalf("解析 golden fixture: %v", err)
	}
	return out
}

// assertGoldenFace 反序列化后与 golden 逐字段比较（与 Node 侧 toEqual 同口径）。
func assertGoldenFace(t *testing.T, golden map[string]any, face string, body []byte) {
	t.Helper()
	var got any
	if err := json.Unmarshal(body, &got); err != nil {
		t.Fatalf("%s 面: 响应非 JSON: %v", face, err)
	}
	if !reflect.DeepEqual(golden[face], got) {
		want, _ := json.Marshal(golden[face])
		t.Fatalf("%s 面与 golden 不一致:\n want: %s\n  got: %s", face, want, body)
	}
}

// seedGoldenEvent 直接落一行事件（手法同 seedLikeEvent，读面不验签）。
func seedGoldenEvent(t *testing.T, st *store.Store, eventID, id, typ, bodyJSON, target, payloadCID, replyTo string, createdAt int64) {
	t.Helper()
	if err := st.PutEvent(store.Event{EventID: eventID, ID: id, Type: typ, BodyJSON: bodyJSON,
		CreatedAt: createdAt, ReceivedAt: createdAt, TargetID: target, PayloadCID: payloadCID, ReplyTo: replyTo}); err != nil {
		t.Fatalf("PutEvent(%s): %v", eventID, err)
	}
}

func TestGoldenLike(t *testing.T) {
	golden := loadGolden(t)

	st, err := store.Open(t.TempDir())
	if err != nil {
		t.Fatalf("store.Open: %v", err)
	}
	t.Cleanup(func() { _ = st.Close() })

	// 固定数据集：pack v1 + 条目 article/a1。
	if err := st.UpsertArticle(store.Article{
		ItemID: "article/a1", Title: "甲", Digest: "甲摘要", PublishedAt: "2026-01-01T00:00:00Z",
		TagsJSON: `["演示"]`, BodyMD: goldenBody, ContentHash: protocol.SHA256Hex([]byte(goldenBody)),
		SourceRev: "rev-1", UpdatedAt: "2026-01-02T00:00:00Z",
	}); err != nil {
		t.Fatalf("UpsertArticle: %v", err)
	}
	if err := st.InsertPack(store.PackRecord{
		PackID: "pack-golden-0001", ContentVersion: 1, Dir: "packs/pack-golden-0001",
		MerkleRoot: strings.Repeat("0", 64), Signature: "golden",
		IssuedAt: "2026-01-03T00:00:00Z", ItemCount: 1,
	}); err != nil {
		t.Fatalf("InsertPack: %v", err)
	}

	c1, c2 := eventIDOf(1), eventIDOf(2)
	cid1, cid2 := strings.Repeat("b", 32), strings.Repeat("d", 32)
	seedGoldenEvent(t, st, c1, "actorA", "comment.v1",
		`{"sig":"00","target_id":"article/a1","text":"评论一"}`, "article/a1", cid1, "", 300)
	seedGoldenEvent(t, st, c2, "actorB", "comment.v1",
		`{"sig":"00","target_id":"article/a1","text":"评论二"}`, "article/a1", cid2, "", 200)

	likeBody := func(target, action string) string {
		return `{"action":"` + action + `","sig":"00","target_id":"` + target + `"}`
	}
	// c1：A、B 各一赞 → 2；c2：A 赞后 unlike 取消 → 0（§4.1 LWW）。
	seedGoldenEvent(t, st, eventIDOf(11), "A", "like.v1", likeBody(c1, "like"), c1, "", "", 1000)
	seedGoldenEvent(t, st, eventIDOf(12), "B", "like.v1", likeBody(c1, "like"), c1, "", "", 1001)
	seedGoldenEvent(t, st, eventIDOf(13), "A", "like.v1", likeBody(c2, "like"), c2, "", "", 1002)
	seedGoldenEvent(t, st, eventIDOf(14), "A", "like.v1", likeBody(c2, "unlike"), c2, "", "", 1003)
	// 条目 article/a1：A、B 各一赞 → catalog like_count=2。
	seedGoldenEvent(t, st, eventIDOf(15), "A", "like.v1", likeBody("article/a1", "like"), "article/a1", "", "", 1004)
	seedGoldenEvent(t, st, eventIDOf(16), "B", "like.v1", likeBody("article/a1", "like"), "article/a1", "", "", 1005)
	// c1 被 R1、R2 两人举报；c2 被 R3 举报 → reported 面 report_count 降序 c1 在前。
	reportBody := func(target string) string {
		return `{"reason":"spam","sig":"00","target_id":"` + target + `"}`
	}
	seedGoldenEvent(t, st, eventIDOf(21), "R1", "report.v1", reportBody(c1), c1, "", "", 1006)
	seedGoldenEvent(t, st, eventIDOf(22), "R2", "report.v1", reportBody(c1), c1, "", "", 1007)
	seedGoldenEvent(t, st, eventIDOf(23), "R3", "report.v1", reportBody(c2), c2, "", "", 1008)

	srv, err := New(st, Options{Issuer: "base-node-1", SignKeyHex: testSeed, Version: "test", ReviewKey: "review-key"})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	ts := newInprocServer(srv.Handler())
	t.Cleanup(ts.Close)

	// ① GET /v1/comment：created_at 倒序两行，like_count 内联（2 / 0）。
	code, raw := doRaw(t, http.MethodGet, ts.URL+"/v1/comment?target_id=article/a1", "", nil)
	if code != http.StatusOK {
		t.Fatalf("comment: code=%d body=%s", code, raw)
	}
	assertGoldenFace(t, golden, "comment", raw)

	// ② GET /v1/catalog：pack v1 + 单条目 like_count=2。
	code, raw = doRaw(t, http.MethodGet, ts.URL+"/v1/catalog", "", nil)
	if code != http.StatusOK {
		t.Fatalf("catalog: code=%d body=%s", code, raw)
	}
	assertGoldenFace(t, golden, "catalog", raw)

	// ③ POST /v1/admin/review/reported：report_count 降序 + reporters 去重。
	code, raw = doRaw(t, http.MethodPost, ts.URL+"/v1/admin/review/reported", `{}`,
		map[string]string{"X-Base-Review-Key": "review-key"})
	if code != http.StatusOK {
		t.Fatalf("reported: code=%d body=%s", code, raw)
	}
	assertGoldenFace(t, golden, "reported", raw)
}
