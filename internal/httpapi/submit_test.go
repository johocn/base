package httpapi

import (
	"testing"

	"github.com/johocn/base/internal/protocol"
)

func TestValidSlug(t *testing.T) {
	ok := []string{"a", "abc", "a1", "0", "a-b-c", "a" + repeat("b", 63)}
	bad := []string{"", "-a", "A", "a_b", "a b", "é", "a" + repeat("b", 64), "a/b"}
	for _, s := range ok {
		if !validSlug(s) {
			t.Fatalf("应合法: %q", s)
		}
	}
	for _, s := range bad {
		if validSlug(s) {
			t.Fatalf("应非法: %q", s)
		}
	}
}

func TestSplitSubmitItemID(t *testing.T) {
	cases := []struct {
		itemID, typ, wantSlug, wantCode string
	}{
		{"article/hello", "article", "hello", ""},
		{"quiz/q-1", "quiz", "q-1", ""},
		{"article/hello", "quiz", "", "item_type_mismatch"},
		{"quiz/q-1", "article", "", "item_type_mismatch"},
		{"course/c1", "article", "", "item_id_invalid"},
		{"course/c1/lesson/l1/quiz/q1", "quiz", "", "item_id_invalid"},
		{"article/", "article", "", "item_id_invalid"},
		{"article/Bad", "article", "", "item_id_invalid"},
		{"article/a/b", "article", "", "item_id_invalid"},
		{"lesson/x", "article", "", "item_id_invalid"},
	}
	for _, c := range cases {
		slug, code := splitSubmitItemID(c.itemID, c.typ)
		if slug != c.wantSlug || code != c.wantCode {
			t.Fatalf("splitSubmitItemID(%q, %q) = (%q, %q), want (%q, %q)",
				c.itemID, c.typ, slug, code, c.wantSlug, c.wantCode)
		}
	}
}

func TestValidItemTitle(t *testing.T) {
	if !validItemTitle("a") {
		t.Fatal("1 rune 应合法")
	}
	if !validItemTitle("  标题  ") {
		t.Fatal("去首尾空白后非空应合法")
	}
	if !validItemTitle(repeat("文", 200)) {
		t.Fatal("200 rune 应合法")
	}
	bad := []string{"", "   ", repeat("文", 201), "标\x00题", "标\x1f题", "标\x7f题"}
	for _, s := range bad {
		if validItemTitle(s) {
			t.Fatalf("应非法: %q", s)
		}
	}
}

func TestValidQuestionJSON(t *testing.T) {
	ok := `{"schema_version":1,"questions":[{"q":"1","options":["a"],"answer":0,"explain":""}]}`
	if !validQuestionJSON(ok) {
		t.Fatal("合法题组应通过")
	}
	// 未知键不参与判定（与内部解析器同口径：只看 schema_version 与 questions）。
	if !validQuestionJSON(`{"schema_version":1,"questions":[{"q":"1"}],"extra":1}`) {
		t.Fatal("额外键不应导致拒绝")
	}
	bad := []string{
		"",
		"不是 JSON",
		`{"questions":[{"q":"1"}]}`,
		`{"schema_version":2,"questions":[{"q":"1"}]}`,
		`{"schema_version":1}`,
		`{"schema_version":1,"questions":[]}`,
		`{"schema_version":1,"questions":"x"}`,
	}
	for _, s := range bad {
		if validQuestionJSON(s) {
			t.Fatalf("应非法: %q", s)
		}
	}
}

// content_hash 必须与导入器逐字节同构：UTF-8 字节的 sha256，不走 canonicalize。
func TestSubmissionContentHash(t *testing.T) {
	body := "中文正文\n"
	if got, want := submissionContentHash("article", body, ""), protocol.SHA256Hex([]byte(body)); got != want {
		t.Fatalf("article content_hash = %s, want %s", got, want)
	}
	qj := `{"schema_version":1,"questions":[]}`
	if got, want := submissionContentHash("quiz", "", qj), protocol.SHA256Hex([]byte(qj)); got != want {
		t.Fatalf("quiz content_hash = %s, want %s", got, want)
	}
}

func repeat(s string, n int) string {
	out := ""
	for i := 0; i < n; i++ {
		out += s
	}
	return out
}
