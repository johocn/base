package httpapi

import (
	"encoding/json"
	"html/template"
	"log"
	"net/http"
	"time"

	"github.com/johocn/base/internal/markdown"
	"github.com/johocn/base/internal/store"
	"github.com/johocn/base/web"
)

// 每页一个独立模板集合：base.html 提供骨架，页面文件只定义 content 块。
// 合并成一个集合会导致后解析的 content 覆盖前一个，故必须分开。
var (
	indexTmpl      = template.Must(template.New("index").ParseFS(web.FS, "templates/base.html", "templates/index.html"))
	articleTmpl    = template.Must(template.New("article").ParseFS(web.FS, "templates/base.html", "templates/article.html"))
	governanceTmpl = template.Must(template.New("governance").ParseFS(web.FS, "templates/base.html", "templates/governance.html"))
)

type pageData struct {
	Title       string
	Issuer      string
	PairingCode string
	Fingerprint string
	Items       []pageItem
	Article     *pageArticle

	Proposals       []pageProposal
	Roster          []pageContributor
	RosterReady     bool
	RemoveThreshold int
	EditThreshold   int
}

// pageProposal 是看板的一行提案卡片（册子 §7.4）。
type pageProposal struct {
	Action         string
	ActionLabel    string
	ItemID         string
	Title          string
	Linkable       bool
	ItemState      string
	ItemStateLabel string
	Reason         string
	VoteCount      int
	Threshold      int
	Percent        int
	Status         string
	StatusLabel    string
	CreatedAt      string
	Voters         []pageContributor
	Edit           *pageProposalEdit
}

// pageProposalEdit 只在 Action == edit 时非空（匿名读接口本就返回这两个字段）。
type pageProposalEdit struct {
	Title  string
	BodyMD string
}

type pageContributor struct {
	ID    string
	Name  string
	Count int
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
	Body        template.HTML
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

// handleArticlePage 渲染文章正文。正文经 markdown.Render 消毒后直出（全仓唯一一处显式绕过模板转义）。
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
		Body:        markdown.Render(art.BodyMD),
		CoverBlobID: s.coverBlobID(itemID),
	}}
	s.renderPage(w, articleTmpl, data)
}

// coverBlobID 按约定 <item_id>/cover 找文章封面块；缺失返回空串，不阻塞渲染。
func (s *Server) coverBlobID(articleItemID string) string {
	refs, err := s.st.ListBlobsForItem(articleItemID + "/cover")
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

// governActionLabel 是动作徽章的中文（看板不显示英文码）。
func governActionLabel(action string) string {
	switch action {
	case store.GovernActionRemove:
		return "下架"
	case store.GovernActionEdit:
		return "改写"
	case store.GovernActionRevive:
		return "复活"
	default:
		return action
	}
}

func governStatusLabel(status string) string {
	switch status {
	case store.GovernStatusPending:
		return "待决"
	case store.GovernStatusEffective:
		return "已生效"
	case store.GovernStatusVoid:
		return "已作废"
	default:
		return status
	}
}

func itemStateLabel(state string) string {
	switch state {
	case "active":
		return "在架"
	case "removed":
		return "已下架"
	default:
		return ""
	}
}

// nameOrShortID 与 GET /v1/contributors 同一口径：缺昵称回退 id 前 8 位。
func nameOrShortID(name, id string) string {
	if name != "" {
		return name
	}
	if len(id) > 8 {
		return id[:8]
	}
	return id
}

// formatMillis 把毫秒时间戳格式化为本地时间；0 返回空串（未发生的事不渲染）。
func formatMillis(ms int64) string {
	if ms == 0 {
		return ""
	}
	return time.UnixMilli(ms).Local().Format("2006-01-02 15:04")
}

// handleGovernancePage 渲染治理看板：服务端直接读库，**不调接口**（册子 §7.2）。
//
// 复用 governRoster() 而不是自己建集合，是为了继承它的降级口径：
// 派生失败按空名册继续渲染（票数自然为 0），页面提示「名册暂不可用」，与接口侧一致。
func (s *Server) handleGovernancePage(w http.ResponseWriter, r *http.Request) {
	roster, rosterOK := s.governRoster()
	views, err := s.st.ListProposalViews(roster)
	if err != nil {
		s.writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	// ProfileNames(nil)：空 ids = 全部（store/contributor.go）
	names, err := s.st.ProfileNames(nil)
	if err != nil {
		s.writeError(w, http.StatusInternalServerError, err.Error())
		return
	}

	data := pageData{
		Title:           "治理看板",
		Issuer:          s.opt.Issuer,
		PairingCode:     s.opt.PairingCode,
		Fingerprint:     s.opt.FingerprintHex,
		RosterReady:     rosterOK,
		RemoveThreshold: store.GovernThreshold(store.GovernActionRemove),
		EditThreshold:   store.GovernThreshold(store.GovernActionEdit),
	}
	if contribs, err := s.st.ContributorRoster(); err == nil {
		for _, c := range contribs {
			data.Roster = append(data.Roster, pageContributor{ID: c.ID, Name: nameOrShortID(names[c.ID], c.ID), Count: c.Count})
		}
	}
	// ListProposalViews 按 proposal_id 升序（旧 → 新）返回；这里只做纯展示反转（新提案在前，册子 §7.4）
	for i := len(views) - 1; i >= 0; i-- {
		data.Proposals = append(data.Proposals, s.proposalPageRow(views[i], names))
	}
	s.renderPage(w, governanceTmpl, data)
}

// proposalPageRow 把一条提案视图折成看板行。**票数与门槛一律用 ListProposalViews 给的**，看板不自己算。
func (s *Server) proposalPageRow(v store.ProposalView, names map[string]string) pageProposal {
	row := pageProposal{
		Action:      v.Action,
		ActionLabel: governActionLabel(v.Action),
		ItemID:      v.ItemID,
		Title:       v.ItemID, // 缺条目或非公开时回退显示 item_id（册子 §7.3 护栏 1）
		Reason:      v.Reason,
		VoteCount:   len(v.Votes),
		Threshold:   v.Threshold,
		Status:      v.Status,
		StatusLabel: governStatusLabel(v.Status),
		CreatedAt:   formatMillis(v.CreatedAt),
	}
	if row.Threshold > 0 {
		row.Percent = row.VoteCount * 100 / row.Threshold
		if row.Percent > 100 {
			row.Percent = 100
		}
	}
	for _, id := range v.Votes {
		row.Voters = append(row.Voters, pageContributor{ID: id, Name: nameOrShortID(names[id], id)})
	}
	if v.Action == store.GovernActionEdit {
		row.Edit = &pageProposalEdit{Title: v.Title, BodyMD: v.BodyMD}
	}
	// 两条可见性护栏（册子 §7.3）：标题只在 public 时显示；链接只挂 active + public
	if it, ok, err := s.st.GetItem(v.ItemID); err == nil && ok {
		row.ItemState = it.State
		row.ItemStateLabel = itemStateLabel(it.State)
		if it.DistClass == "public" {
			row.Title = it.Title
			row.Linkable = it.State == "active"
		}
	}
	return row
}