package httpapi

import (
	"encoding/json"
	"html/template"
	"log"
	"net/http"
	"sort"
	"strings"
	"time"

	"github.com/johocn/base/internal/markdown"
	"github.com/johocn/base/internal/protocol"
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

	Proposals            []pageProposal
	Roster               []pageContributor
	RosterReady          bool
	RosterSeedIDs        map[string]bool // 种子用户 ID 集（贡献者名册里标记「种子」角标用）
	ActiveUsersM         int             // 节点 7 日活跃身份数（顶部门槛公式演示）
	ThresholdBaseExample int             // 基础门槛演示值（P=F=0 的 node 级口径）
	ThresholdEnhancedExample int        // 强化门槛演示值
}

// pageProposal 是看板的一行提案卡片（册子 §7.4）。
type pageProposal struct {
	Action         string
	ActionLabel    string
	ItemID         string
	Title          string
	TermName       string // directory_add 行的词条展示名（非空时替代 Title 渲染）
	TermPending    bool   // 词条尚未 approved ⇒ 渲染「待票选」角标
	Linkable       bool
	ItemState      string
	ItemStateLabel string
	Reason         string
	VoteCount      int // V2: COUNT(DISTINCT voter_id)
	Quorum         int
	Threshold      int // V2: ThresholdV2
	Percent        int // 第一条进度条：VoterCount * 100 / Quorum
	Percent2       int // 第二条进度条：净票权条 NetWeight / (ApproveWeight+RejectWeight)
	ApproveBar     int // 赞成票权占比（0~100），用于净票权条渲染
	RejectBar      int // 反对票权占比（0~100）
	ApproveWeight  int
	RejectWeight   int
	NetWeight      int
	GovernanceLevel string // "base" | "enhanced"
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
	TagViews    []pageTag
	Body        template.HTML
	CoverBlobID string
	Badges      []string
	TitleColor  string
}

// pageTag 是文章标签 chip：Name 为原文（模板负责转义），Pending = 该标签词条尚未 approved。
type pageTag struct {
	Name    string
	Pending bool
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
	// 图章与标题色（册子 #53 §2.5）：读失败不阻塞渲染，按空处理。
	segs, err := s.st.ListSegments(itemID)
	if err != nil {
		segs = nil
	}
	badges, titleColor := articleMarks(segs)
	// 三态判定：目录读失败 ⇒ 空集 ⇒ 保持遗留行为（全部按 approved，不加角标）。
	approved := s.approvedTermSet()
	views := []pageTag{}
	for _, name := range decodeTags(art.TagsJSON) {
		key, ok := store.NormalizeTermKey(name)
		views = append(views, pageTag{Name: name, Pending: !ok || !approved[store.DirectoryKindTag+"\x00"+key]})
	}
	data := pageData{Title: art.Title, Issuer: s.opt.Issuer, PairingCode: s.opt.PairingCode, Fingerprint: s.opt.FingerprintHex, Article: &pageArticle{
		ItemID:      art.ItemID,
		Title:       art.Title,
		Digest:      art.Digest,
		PublishedAt: art.PublishedAt,
		TagViews:    views,
		Body:        markdown.Render(art.BodyMD),
		CoverBlobID: s.coverBlobID(itemID),
		Badges:      badges,
		TitleColor:  titleColor,
	}}
	s.renderPage(w, articleTmpl, data)
}

// articleMarks 从属性行派生门户展示用的图章与标题色：
// 取值域封闭（图章 7 词、标题色 6 名），域外值静默丢弃；色名只产固定类名，故不进消毒管线（册子 #53 §2.4）。
// 图章按码位升序（sort.Strings）返回，与写入端的规范序一致，避免门户与 App 顺序不一致。
func articleMarks(segs []store.Segment) ([]string, string) {
	badgeWords := map[string]bool{"活动": true, "悬赏": true, "推荐": true, "热门": true, "精华": true, "置顶": true, "辩论": true}
	titleColors := map[string]bool{"red": true, "orange": true, "green": true, "blue": true, "purple": true, "gray": true}
	var badges []string
	titleColor := ""
	seen := map[string]bool{}
	for _, s := range segs {
		if s.Seq >= 0 {
			continue
		}
		switch s.Kind {
		case protocol.AttrKeyBadge:
			for _, w := range strings.Split(s.Text, ",") {
				w = strings.TrimSpace(w)
				if badgeWords[w] && !seen[w] {
					seen[w] = true
					badges = append(badges, w)
				}
			}
		case protocol.AttrKeyTitleColor:
			if titleColors[s.Text] {
				titleColor = s.Text
			}
		}
	}
	sort.Strings(badges)
	return badges, titleColor
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

// governActionLabel 是动作徽章的中文（看板不显示英文码）。V2 覆盖全部 13 种治理动作。
func governActionLabel(action string) string {
	switch action {
	case store.GovernActionRemove:
		return "下架"
	case store.GovernActionEdit:
		return "改写"
	case store.GovernActionRevive:
		return "复活"
	case store.GovernActionDirectoryAdd:
		return "新增词条"
	// V2 细粒度治理动作
	case store.GovernActionEditTitle:
		return "改标题"
	case store.GovernActionEditBody:
		return "改正文"
	case store.GovernActionEditCategory:
		return "改分类"
	case store.GovernActionEditTags:
		return "改标签"
	case store.GovernActionEditInstructor:
		return "改讲师"
	case store.GovernActionHighlight:
		return "高亮"
	case store.GovernActionPin:
		return "置顶"
	case store.GovernActionRecommend:
		return "推荐"
	case store.GovernActionFeature:
		return "精华"
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

// approvedTermSet 读目录的 approved 词条，折成 "kind\x00term_key" 集合。
// 读失败返回空集：这是**有意的降级**——宁可全部按 approved 显示（不加角标），
// 也不因目录不可用把存量词条集体误标为「待票选」（册子 #58 §9 风险 2）。
func (s *Server) approvedTermSet() map[string]bool {
	terms, _, err := s.st.ListDirectory()
	if err != nil {
		return map[string]bool{}
	}
	set := make(map[string]bool, len(terms))
	for _, t := range terms {
		set[t.Kind+"\x00"+t.TermKey] = true
	}
	return set
}

// handleGovernancePage 渲染治理看板：服务端直接读库，**不调接口**（册子 §7.2）。
//
// V2 升级：顶部展示动态门槛公式演示（当前活跃用户 m → base/enhanced 门槛示例）；
// 贡献者名册改用 DeriveContributionRoster（恒 10 人 + 种子 ID 补齐），区分贡献者与初创期种子；
// 提案行全部使用 V2 动态指标（Quorum / ThresholdV2 / NetWeight / ApproveWeight / RejectWeight）。
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

	// V2: 查节点 7 日活跃身份数 → 顶部门槛公式演示
	m := s.st.NodeActiveUsers()
	thresholdBase := store.GovernThreshold("base", m, 0, 0)
	thresholdEnhanced := store.GovernThreshold("enhanced", m, 0, 0)

	data := pageData{
		Title:                   "治理看板",
		Issuer:                  s.opt.Issuer,
		PairingCode:             s.opt.PairingCode,
		Fingerprint:             s.opt.FingerprintHex,
		RosterReady:             rosterOK,
		ActiveUsersM:            m,
		ThresholdBaseExample:    thresholdBase,
		ThresholdEnhancedExample: thresholdEnhanced,
	}

	// V2: 贡献者名册恒 10 人（DeriveContributionRoster），区分贡献者 vs 初创期种子。
	if roster10, err := s.st.DeriveContributionRoster(); err == nil {
		// 贡献者 ID 集（来自 ContributorRoster）：不在此集中的是种子。
		contribSet := map[string]bool{}
		if contribs, cerr := s.st.ContributorRoster(); cerr == nil {
			for _, c := range contribs {
				contribSet[c.ID] = true
			}
		}
		data.RosterSeedIDs = map[string]bool{}
		for _, id := range roster10 {
			seed := !contribSet[id]
			if seed {
				data.RosterSeedIDs[id] = true
			}
			data.Roster = append(data.Roster, pageContributor{ID: id, Name: nameOrShortID(names[id], id)})
		}
	}

	// ListProposalViews 按 proposal_id 升序（旧 → 新）返回；这里只做纯展示反转（新提案在前，册子 §7.4）
	for i := len(views) - 1; i >= 0; i-- {
		data.Proposals = append(data.Proposals, s.proposalPageRow(views[i], names))
	}
	s.renderPage(w, governanceTmpl, data)
}

// proposalPageRow 把一条提案视图折成看板行。**票数与门槛一律用 ListProposalViews 给的**，看板不自己算。
// V2：使用 Quorum / ThresholdV2 / NetWeight 等动态指标（与 AddVoteV2 两阶段判定同源）。
func (s *Server) proposalPageRow(v store.ProposalView, names map[string]string) pageProposal {
	// V2: 进度条 1 = 独立 voter 数 / quorum；进度条 2 = 净票权占比。
	percent := 0
	if v.Quorum > 0 {
		percent = v.VoterCount * 100 / v.Quorum
		if percent > 100 {
			percent = 100
		}
	}
	percent2 := 0
	totalWeight := v.ApproveWeight + v.RejectWeight
	approveBar := 0
	rejectBar := 0
	if totalWeight > 0 {
		// 净票权占比（0~100）：正值表示赞成领先，负值表示反对领先。模板可据此渲染方向。
		percent2 = v.NetWeight * 100 / totalWeight
		approveBar = v.ApproveWeight * 100 / totalWeight
		rejectBar = v.RejectWeight * 100 / totalWeight
	}

	level := v.GovernanceLevel
	if level == "" {
		level = "base"
	}

	row := pageProposal{
		Action:          v.Action,
		ActionLabel:     governActionLabel(v.Action),
		ItemID:          v.ItemID,
		Title:           v.ItemID, // 缺条目或非公开时回退显示 item_id（册子 §7.3 护栏 1）
		Reason:          v.Reason,
		VoteCount:       v.VoterCount,
		Quorum:          v.Quorum,
		Threshold:       v.ThresholdV2,
		Percent:         percent,
		Percent2:        percent2,
		ApproveBar:      approveBar,
		RejectBar:       rejectBar,
		ApproveWeight:   v.ApproveWeight,
		RejectWeight:    v.RejectWeight,
		NetWeight:       v.NetWeight,
		GovernanceLevel: level,
		Status:          v.Status,
		StatusLabel:     governStatusLabel(v.Status),
		CreatedAt:       formatMillis(v.CreatedAt),
	}
	for _, id := range v.Votes {
		row.Voters = append(row.Voters, pageContributor{ID: id, Name: nameOrShortID(names[id], id)})
	}
	if v.Action == store.GovernActionEdit {
		row.Edit = &pageProposalEdit{Title: v.Title, BodyMD: v.BodyMD}
	}
	if v.Action == store.GovernActionDirectoryAdd {
		// 目录提案没有目标条目（GetItem 恒 !ok），标题位改渲染词条展示名。
		// 角标只在状态未定案（pending）时挂：册子 §5.1 的「待票选」定义 = 不在 approved 集；
		// 已生效的目录提案在同一个看板上已有「已生效」状态标签，再挂「待票选」会自相矛盾。
		row.TermName = store.CleanDisplayName(v.Title)
		row.TermPending = v.Status == store.GovernStatusPending
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