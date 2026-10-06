package httpapi

import (
	"net/http"
	"strings"
	"testing"
)

// ---------- #79 §5.2：catalog 读面内联 like_count（Task 3） ----------

// 条目对象带 like_count（有赞=实际数、无赞=0）；§5.4 隐私：条目行零 report 字段、零点赞者名单；
// ?since 短路响应无 items（回归不动）。
func TestCatalogInlineLikeCount(t *testing.T) {
	st, res, ts := newTestServer(t)

	seedLikeEvent(t, st, "A", strings.Repeat("aa", 16), "article/aaa", "like", 1000)
	seedLikeEvent(t, st, "B", strings.Repeat("bb", 16), "article/aaa", "like", 1001)
	// LWW 取消 → 0。
	seedLikeEvent(t, st, "C", strings.Repeat("cc", 16), "article/bbb", "like", 1002)
	seedLikeEvent(t, st, "C", strings.Repeat("dd", 16), "article/bbb", "unlike", 1003)

	code, body := getJSON(t, ts.URL+"/v1/catalog")
	if code != http.StatusOK {
		t.Fatalf("catalog: code=%d body=%v", code, body)
	}
	items := body["items"].([]any)
	if len(items) != 3 {
		t.Fatalf("items = %d, want 3", len(items))
	}
	want := map[string]float64{"article/aaa": 2, "article/aaa/cover": 0, "article/bbb": 0}
	for _, r := range items {
		it := r.(map[string]any)
		id, _ := it["item_id"].(string)
		if it["like_count"] != want[id] {
			t.Fatalf("%s like_count = %v, want %v", id, it["like_count"], want[id])
		}
		for k := range it {
			switch k {
			case "item_id", "source", "type", "title", "content_hash", "source_rev", "like_count":
			default:
				t.Fatalf("catalog 条目行多出键 %q（违反 §5.4）: %v", k, it)
			}
		}
	}

	// ?since 短路：无 items（既有 no-op 语义不动）。
	code, body = getJSON(t, ts.URL+"/v1/catalog?since="+itoa(res.ContentVersion))
	if code != http.StatusOK || len(body["items"].([]any)) != 0 {
		t.Fatalf("since 短路 code=%d items=%v", code, body["items"])
	}
}
