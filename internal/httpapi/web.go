package httpapi

import (
	"encoding/json"
	"html/template"
	"log"
	"net/http"
	"strings"

	"github.com/johocn/base/web"
)

// 每页一个独立模板集合：base.html 提供骨架，页面文件只定义 content 块。
// 合并成一个集合会导致后解析的 content 覆盖前一个，故必须分开。
var (
	indexTmpl   = template.Must(template.New("index").ParseFS(web.FS, "templates/base.html", "templates/index.html"))
	articleTmpl = template.Must(template.New("article").ParseFS(web.FS, "templates/base.html", "templates/article.html"))
)

type pageData struct {
	Title       string
	Issuer      string
	PairingCode string
	Fingerprint string
	Items       []pageItem
	Article     *pageArticle
}

type pageItem struct {
	ItemID string
	Type   string
	Title  string
	Rev    string
}

type pageArticle struct {
	ItemID      string
	Title       string
	Digest      string
	PublishedAt string
	Tags        []string
	Paragraphs  []string
	CoverBlobID string
}

// handleIndex 渲染公开内容目录，只列 active + public 的 article 条目。
func (s *Server) handleIndex(w http.ResponseWriter, r *http.Request) {
	items, err := s.st.ListItems("active")
	if err != nil {
		s.writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	data := pageData{
		Title:       "内容目录",
		Issuer:      s.opt.Issuer,
		PairingCode: s.opt.PairingCode,
		Fingerprint: s.opt.FingerprintHex,
	}
	for _, it := range items {
		if it.DistClass != "public" || it.Type != "article" {
			continue
		}
		data.Items = append(data.Items, pageItem{ItemID: it.ItemID, Type: it.Type, Title: it.Title, Rev: it.SourceRev})
	}
	s.renderPage(w, indexTmpl, data)
}

// handleArticlePage 渲染文章正文。正文经 html/template 自动转义，杜绝注入。
func (s *Server) handleArticlePage(w http.ResponseWriter, r *http.Request) {
	itemID := r.PathValue("item_id")
	it, ok, err := s.st.GetItem(itemID)
	if err != nil {
		s.writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	if !ok || it.Type != "article" || it.State != "active" || it.DistClass != "public" {
		s.writeError(w, http.StatusNotFound, "文章不存在")
		return
	}
	art, ok, err := s.st.GetArticle(itemID)
	if err != nil {
		s.writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	if !ok {
		s.writeError(w, http.StatusNotFound, "文章正文不存在")
		return
	}
	data := pageData{Title: art.Title, Issuer: s.opt.Issuer, PairingCode: s.opt.PairingCode, Fingerprint: s.opt.FingerprintHex, Article: &pageArticle{
		ItemID:      art.ItemID,
		Title:       art.Title,
		Digest:      art.Digest,
		PublishedAt: art.PublishedAt,
		Tags:        decodeTags(art.TagsJSON),
		Paragraphs:  splitParagraphs(art.BodyMD),
		CoverBlobID: s.coverBlobID(itemID),
	}}
	s.renderPage(w, articleTmpl, data)
}

// coverBlobID 按约定 cover:<slug> 找文章封面块；缺失返回空串，不阻塞渲染。
func (s *Server) coverBlobID(articleItemID string) string {
	slug := strings.TrimPrefix(articleItemID, "article:")
	refs, err := s.st.ListBlobsForItem("cover:" + slug)
	if err != nil || len(refs) == 0 {
		return ""
	}
	return refs[0].BlobID
}

func (s *Server) renderPage(w http.ResponseWriter, tmpl *template.Template, data pageData) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusOK)
	if err := tmpl.ExecuteTemplate(w, "base.html", data); err != nil {
		// 响应头已发出，无法再改状态码，只能记日志
		log.Printf("httpapi: 渲染页面失败: %v", err)
	}
}

// decodeTags 解析 tags_json；坏数据不阻塞渲染。
func decodeTags(tagsJSON string) []string {
	if tagsJSON == "" {
		return nil
	}
	var tags []string
	if err := json.Unmarshal([]byte(tagsJSON), &tags); err != nil {
		return nil
	}
	return tags
}

// splitParagraphs 按空行切段；P0 不做 Markdown 渲染，原样纯文本展示。
func splitParagraphs(body string) []string {
	var out []string
	normalized := strings.ReplaceAll(body, "\r\n", "\n")
	for _, p := range strings.Split(normalized, "\n\n") {
		if p = strings.TrimSpace(p); p != "" {
			out = append(out, p)
		}
	}
	return out
}