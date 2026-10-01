package httpapi

import (
	"net/http"
	"strings"
	"testing"

	"github.com/johocn/base/internal/protocol"
	"github.com/johocn/base/internal/store"
)

// 门户「待票选」角标（册子 #58 §5）：文章标签 chips 与看板词条提案行。
// 断言一律用**转义后**的形态（&lt;b&gt;），不得引入 template.HTML 放松转义。

// TestDirectoryPortalArticlePendingBadge：标签不在目录里 ⇒ 挂角标；approved 后角标消失。
func TestDirectoryPortalArticlePendingBadge(t *testing.T) {
	st, ts := directoryHarness(t)

	code, body := doRaw(t, http.MethodGet, ts.URL+"/a/article/aaa", "", nil)
	if code != http.StatusOK {
		t.Fatalf("文章页状态 = %d\n%s", code, body)
	}
	if !strings.Contains(string(body), "待票选") {
		t.Fatalf("标签「演示」不在目录里，应挂「待票选」角标\n%s", body)
	}

	// approved 后重新 GET ⇒ 角标消失。
	approvedTermForTest(t, st, store.DirectoryKindTag, "演示", "author-x")
	code, body = doRaw(t, http.MethodGet, ts.URL+"/a/article/aaa", "", nil)
	if code != http.StatusOK {
		t.Fatalf("文章页状态 = %d\n%s", code, body)
	}
	if strings.Contains(string(body), "待票选") {
		t.Fatalf("标签已 approved，不应再挂「待票选」角标\n%s", body)
	}
}

// TestDirectoryPortalEscaping：标签与看板词条名均经模板转义（&lt;b&gt;），绝不直出原始标签。
func TestDirectoryPortalEscaping(t *testing.T) {
	st, ts := directoryHarness(t)

	const bodyMD = "正文"
	if err := st.UpsertArticle(store.Article{
		ItemID: "article/esc", Title: "转义文", Digest: "转义摘要", PublishedAt: "2026-01-01T00:00:00Z",
		TagsJSON: `["<b>x</b>"]`, BodyMD: bodyMD, ContentHash: protocol.SHA256Hex([]byte(bodyMD)),
		SourceRev: "rev-1", UpdatedAt: "2026-01-02T00:00:00Z",
	}); err != nil {
		t.Fatalf("UpsertArticle: %v", err)
	}

	code, body := doRaw(t, http.MethodGet, ts.URL+"/a/article/esc", "", nil)
	if code != http.StatusOK {
		t.Fatalf("文章页状态 = %d\n%s", code, body)
	}
	if !strings.Contains(string(body), "&lt;b&gt;") {
		t.Fatalf("标签未转义，缺少 &lt;b&gt;\n%s", body)
	}
	if strings.Contains(string(body), "<b>x</b>") {
		t.Fatalf("标签被直出，存在注入：<b>x</b>\n%s", body)
	}

	// 看板词条提案名同样必须转义。
	pendingProposalForTest(t, st, store.DirectoryKindCategory, "<b>坏</b>", "author-y")
	code, body = doRaw(t, http.MethodGet, ts.URL+"/governance", "", nil)
	if code != http.StatusOK {
		t.Fatalf("看板状态 = %d\n%s", code, body)
	}
	if !strings.Contains(string(body), "待票选") {
		t.Fatalf("待决目录提案应挂「待票选」角标\n%s", body)
	}
	if !strings.Contains(string(body), "&lt;b&gt;") {
		t.Fatalf("看板词条名未转义，缺少 &lt;b&gt;\n%s", body)
	}
	if strings.Contains(string(body), "<b>坏</b>") {
		t.Fatalf("看板词条名被直出，存在注入：<b>坏</b>\n%s", body)
	}
}

// TestDirectoryPortalGovernanceBadge：待决目录提案行含展示名 + 角标 + 动作中文；
// 已 approved 的词条不是提案，不产生看板行（角标出现次数 = 待决目录提案数）。
func TestDirectoryPortalGovernanceBadge(t *testing.T) {
	st, ts := directoryHarness(t)
	pendingProposalForTest(t, st, store.DirectoryKindCategory, "代数", "author-z")

	code, body := doRaw(t, http.MethodGet, ts.URL+"/governance", "", nil)
	if code != http.StatusOK {
		t.Fatalf("看板状态 = %d\n%s", code, body)
	}
	for _, want := range []string{"代数", "待票选", "新增词条"} {
		if !strings.Contains(string(body), want) {
			t.Fatalf("看板缺少 %q\n%s", want, body)
		}
	}
	if got := strings.Count(string(body), "待票选"); got != 1 {
		t.Fatalf("待决目录提案 1 条 ⇒ 「待票选」应出现 1 次，实际 %d\n%s", got, body)
	}

	// 已 approved 的词条不产生看板行，角标计数不变。
	approvedTermForTest(t, st, store.DirectoryKindCategory, "几何", "author-z")
	_, body = doRaw(t, http.MethodGet, ts.URL+"/governance", "", nil)
	if got := strings.Count(string(body), "待票选"); got != 1 {
		t.Fatalf("approved 词条不是提案，不应产生新的「待票选」角标：实际 %d\n%s", got, body)
	}
}
