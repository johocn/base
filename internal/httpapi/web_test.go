package httpapi

import (
	"io"
	"net/http"
	"reflect"
	"strings"
	"testing"

	"github.com/johocn/base/internal/protocol"
	"github.com/johocn/base/internal/store"
)

func getText(t *testing.T, url string) (int, string) {
	t.Helper()
	resp, err := http.Get(url)
	if err != nil {
		t.Fatalf("GET %s: %v", url, err)
	}
	defer resp.Body.Close()
	b, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatal(err)
	}
	return resp.StatusCode, string(b)
}

func TestIndexPageListsPublicArticles(t *testing.T) {
	_, _, ts := newTestServer(t)
	code, body := getText(t, ts.URL+"/")
	if code != http.StatusOK {
		t.Fatalf("首页状态 = %d", code)
	}
	for _, want := range []string{"内容目录", "甲", "乙", `href="/a/article/aaa"`, `href="/a/article/bbb"`} {
		if !strings.Contains(body, want) {
			t.Fatalf("首页缺少 %q\n页面内容：\n%s", want, body)
		}
	}
	if strings.Contains(body, "甲封面") {
		t.Fatalf("首页不应列出 cover 条目：\n%s", body)
	}
}

func TestArticlePageRendersBody(t *testing.T) {
	_, _, ts := newTestServer(t)
	code, body := getText(t, ts.URL+"/a/article/aaa")
	if code != http.StatusOK {
		t.Fatalf("文章页状态 = %d", code)
	}
	for _, want := range []string{"甲", "甲正文", "甲摘要"} {
		if !strings.Contains(body, want) {
			t.Fatalf("文章页缺少 %q\n%s", want, body)
		}
	}
}

func TestArticlePageShowsCoverBlob(t *testing.T) {
	_, _, ts := newTestServer(t)
	code, body := getText(t, ts.URL+"/a/article/aaa")
	if code != http.StatusOK {
		t.Fatalf("文章页状态 = %d", code)
	}
	if !strings.Contains(body, "/v1/blob/"+protocol.BlobID(testCover)) {
		t.Fatalf("有封面的文章页应引用封面块\n%s", body)
	}

	code, body = getText(t, ts.URL+"/a/article/bbb")
	if code != http.StatusOK {
		t.Fatalf("无封面文章页状态 = %d", code)
	}
	if strings.Contains(body, "/v1/blob/") {
		t.Fatalf("无封面的文章页不应出现块链接\n%s", body)
	}
}

func TestArticlePageEscapesHTML(t *testing.T) {
	st, err := store.Open(t.TempDir())
	if err != nil {
		t.Fatalf("store.Open: %v", err)
	}
	t.Cleanup(func() { _ = st.Close() })

	evil := "<script>alert(1)</script>"
	if err := st.UpsertArticle(store.Article{
		ItemID: "article/evil", Title: "<b>坏标题</b>", Digest: "摘要",
		PublishedAt: "2026-01-01T00:00:00Z", TagsJSON: `["演示"]`, BodyMD: evil,
		ContentHash: protocol.SHA256Hex([]byte(evil)), SourceRev: "rev-1", UpdatedAt: "2026-01-02T00:00:00Z",
	}); err != nil {
		t.Fatalf("UpsertArticle: %v", err)
	}
	srv, err := New(st, Options{Issuer: "base-node-1", Version: "test"})
	if err != nil {
		t.Fatalf("httpapi.New: %v", err)
	}
	ts := newInprocServer(srv.Handler())
	t.Cleanup(ts.Close)

	code, body := getText(t, ts.URL+"/a/article/evil")
	if code != http.StatusOK {
		t.Fatalf("文章页状态 = %d", code)
	}
	if strings.Contains(body, "<script>alert(1)</script>") {
		t.Fatalf("正文未转义，存在注入：\n%s", body)
	}
	if !strings.Contains(body, "&lt;script&gt;") {
		t.Fatalf("缺少转义后的正文：\n%s", body)
	}
	if strings.Contains(body, "<b>坏标题</b>") {
		t.Fatalf("标题未转义：\n%s", body)
	}
}

func TestArticlePageRendersNestedCoursePath(t *testing.T) {
	st, err := store.Open(t.TempDir())
	if err != nil {
		t.Fatalf("store.Open: %v", err)
	}
	t.Cleanup(func() { _ = st.Close() })

	body := "课程正文\n"
	if err := st.UpsertArticle(store.Article{
		ItemID: "course/c1/lesson/l1/article/deep", Title: "深文章", Digest: "深摘要",
		PublishedAt: "2026-01-01T00:00:00Z", TagsJSON: `["演示"]`, BodyMD: body,
		ContentHash: protocol.SHA256Hex([]byte(body)), SourceRev: "rev-1", UpdatedAt: "2026-01-02T00:00:00Z",
	}); err != nil {
		t.Fatalf("UpsertArticle: %v", err)
	}
	srv, err := New(st, Options{Issuer: "base-node-1", Version: "test"})
	if err != nil {
		t.Fatalf("httpapi.New: %v", err)
	}
	ts := newInprocServer(srv.Handler())
	t.Cleanup(ts.Close)

	code, page := getText(t, ts.URL+"/a/course/c1/lesson/l1/article/deep")
	if code != http.StatusOK {
		t.Fatalf("多级文章页状态 = %d", code)
	}
	for _, want := range []string{"深文章", "课程正文", "深摘要"} {
		if !strings.Contains(page, want) {
			t.Fatalf("多级文章页缺少 %q\n%s", want, page)
		}
	}
}

func TestArticlePageMissingIs404(t *testing.T) {
	_, _, ts := newTestServer(t)
	if code, _ := getText(t, ts.URL+"/a/article/nope"); code != http.StatusNotFound {
		t.Fatalf("不存在的文章状态 = %d, want 404", code)
	}
	// 非 article 类型（这里是 cover）不能被当成文章页渲染
	if code, _ := getText(t, ts.URL+"/a/article/aaa/cover"); code != http.StatusNotFound {
		t.Fatalf("cover 条目当文章页的状态 = %d, want 404", code)
	}
}

// TestPagesShowPairingCode 覆盖 Task 13 的配对码展示。
// 本机本地 TCP 出站被阻断（见项目记忆），无法用浏览器/curl 做人工验收，故断言改在进程内分发上做。
func TestPagesShowPairingCode(t *testing.T) {
	const code, fp = "AAAA-BBBB-CCCC-DDDD", "3e3f61d9b4c09638586fb091285b3722659e14e99da07cd1cdd6b7c261c62e78"

	st, err := store.Open(t.TempDir())
	if err != nil {
		t.Fatalf("store.Open: %v", err)
	}
	t.Cleanup(func() { _ = st.Close() })
	seedStore(t, st)
	srv, err := New(st, Options{Issuer: "base-node-1", SignKeyHex: testSeed, Version: "test", PairingCode: code, FingerprintHex: fp})
	if err != nil {
		t.Fatalf("httpapi.New: %v", err)
	}
	ts := newInprocServer(srv.Handler())
	t.Cleanup(ts.Close)

	for _, path := range []string{"/", "/a/article/aaa"} {
		status, body := getText(t, ts.URL+path)
		if status != http.StatusOK {
			t.Fatalf("%s 状态 = %d", path, status)
		}
		for _, want := range []string{`class="pair"`, "节点配对码", code, fp} {
			if !strings.Contains(body, want) {
				t.Fatalf("%s 缺少 %q\n%s", path, want, body)
			}
		}
	}

	// 未启用 TLS 的节点（两个字段都为空）不应渲染配对码区块。
	_, _, plain := newTestServer(t)
	if _, body := getText(t, plain.URL+"/"); strings.Contains(body, `class="pair"`) {
		t.Fatalf("未启用 TLS 的节点不应展示配对码：\n%s", body)
	}
}

func TestGovernanceBoardRendersProposal(t *testing.T) {
	st, _, ts := newTestServer(t)
	if _, err := st.CreateProposal(store.Proposal{
		Action: store.GovernActionRemove, ItemID: "article/aaa", ProposerID: "proposer-1",
		Reason: "内容不准确", BaseContentHash: "deadbeef", CreatedAt: 1790000000000,
	}); err != nil {
		t.Fatalf("CreateProposal: %v", err)
	}

	code, body := getText(t, ts.URL+"/governance")
	if code != http.StatusOK {
		t.Fatalf("看板状态 = %d", code)
	}
	// 动作徽章 / 理由 / 门槛（remove 3 票）/ 状态 / 公开条目的文章页链接
	for _, want := range []string{"治理看板", "下架", "内容不准确", "0 / 3 票", "待决", `href="/a/article/aaa"`} {
		if !strings.Contains(body, want) {
			t.Fatalf("看板缺少 %q\n页面内容：\n%s", want, body)
		}
	}
}

func TestGovernanceBoardHidesRemovedItemLink(t *testing.T) {
	st, _, ts := newTestServer(t)
	if err := st.RetireItem("article/aaa", 1); err != nil {
		t.Fatalf("RetireItem: %v", err)
	}
	if _, err := st.CreateProposal(store.Proposal{
		Action: store.GovernActionRemove, ItemID: "article/aaa", ProposerID: "proposer-1",
		Reason: "已下架", BaseContentHash: "deadbeef", CreatedAt: 1790000000000,
	}); err != nil {
		t.Fatalf("CreateProposal: %v", err)
	}

	code, body := getText(t, ts.URL+"/governance")
	if code != http.StatusOK {
		t.Fatalf("看板状态 = %d", code)
	}
	if !strings.Contains(body, "已下架") {
		t.Fatalf("下架条目应显示状态徽章\n%s", body)
	}
	// 护栏 2：handleArticlePage 对 removed 条目回 404，看板不能给死链
	if strings.Contains(body, `href="/a/article/aaa"`) {
		t.Fatalf("下架条目不应给文章页死链\n%s", body)
	}
}

func TestGovernanceBoardEmptyState(t *testing.T) {
	_, _, ts := newTestServer(t)
	code, body := getText(t, ts.URL+"/governance")
	if code != http.StatusOK {
		t.Fatalf("看板状态 = %d", code)
	}
	for _, want := range []string{"本节点暂无提案。", "暂无贡献者。"} {
		if !strings.Contains(body, want) {
			t.Fatalf("空态缺少 %q\n%s", want, body)
		}
	}
}

// TestArticleMarks 覆盖册子 #53 §2.4 的服务端白名单派生：域外值静默丢弃，
// 图章按码位升序（与写入端规范序一致），子项行 / 简介行不参与。
func TestArticleMarks(t *testing.T) {
	cases := []struct {
		name       string
		segs       []store.Segment
		wantBadges []string
		wantColor  string
	}{
		{
			name: "域内值按码位升序",
			segs: []store.Segment{
				{Seq: -1, Kind: protocol.AttrKeyBadge, Text: "活动,悬赏"},
				{Seq: -2, Kind: protocol.AttrKeyTitleColor, Text: "red"},
			},
			wantBadges: []string{"悬赏", "活动"},
			wantColor:  "red",
		},
		{
			name: "域外值全部丢弃",
			segs: []store.Segment{
				{Seq: -1, Kind: protocol.AttrKeyBadge, Text: "自定义词"},
				{Seq: -2, Kind: protocol.AttrKeyTitleColor, Text: "c-mark"},
				{Seq: -3, Kind: protocol.AttrKeyTitleColor, Text: "yellow"},
			},
			wantBadges: nil,
			wantColor:  "",
		},
		{
			name:       "空 segments",
			segs:       nil,
			wantBadges: nil,
			wantColor:  "",
		},
		{
			name: "子项行与简介行不参与",
			segs: []store.Segment{
				{Seq: 0, Kind: "digest", Text: "活动"},
				{Seq: 1, Kind: protocol.AttrKeyBadge, Text: "悬赏"},
			},
			wantBadges: nil,
			wantColor:  "",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			badges, color := articleMarks(tc.segs)
			if !reflect.DeepEqual(badges, tc.wantBadges) {
				t.Fatalf("badges = %v, want %v", badges, tc.wantBadges)
			}
			if color != tc.wantColor {
				t.Fatalf("titleColor = %q, want %q", color, tc.wantColor)
			}
		})
	}
}