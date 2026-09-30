package httpapi

import (
	"encoding/json"
	"errors"
	"net/http"
	"sort"
	"strings"
	"unicode/utf8"

	"github.com/johocn/base/internal/protocol"
	"github.com/johocn/base/internal/store"
)

// 本册的文档级常量（册子 §5）：不做配置项，校准走「改册子 + 改常量」。
const (
	// maxSubmitBytes 是单条投稿正文的 UTF-8 字节上限，远小于 authmw 的 64 KiB。
	maxSubmitBytes = 32768

	// 写限速：按已验签身份与客户端 IP 双维度，超限 429 item_rate_limited。
	submitPerMinutePerID = 6
	submitBurstPerID     = 3
	submitPerMinutePerIP = 30
	submitBurstPerIP     = 10

	// submitSignableAlgs 的两种载体：本册只收独立 article 与独立 quiz（册子 §2.4）。
	itemTypeArticle = "article"
	itemTypeQuiz    = "quiz"
	itemTypeTag     = "tag"

	// 容器形态（本册 §4.1）：course/<cid> 与 course/<cid>/lesson/<lid>。
	itemTypeCourse = "course"
	itemTypeLesson = "lesson"

	// maxTitleRunes 是标题的 rune 上限（册子 §2.1）。
	maxTitleRunes = 200
)

// splitSubmitItemID 校验 item_id 形态并返回 slug；code 非空即失败，
// 取值 item_id_invalid（形态/前缀/slug 不合法，含 course/ 前缀）或 item_type_mismatch（册子 §2.4）。
func splitSubmitItemID(itemID, typ string) (slug, code string) {
	prefix, rest, ok := strings.Cut(itemID, "/")
	if !ok || (prefix != itemTypeArticle && prefix != itemTypeQuiz) || !protocol.ValidSlug(rest) {
		return "", "item_id_invalid"
	}
	if prefix != typ {
		return "", "item_type_mismatch"
	}
	return rest, ""
}

// containerShapeOf 解析容器 item_id 形态：course/<cid> → course；course/<cid>/lesson/<lid> → lesson。
// 各段都须是合法 slug；其余一律不识别（本册 §4.1，无顶层 lesson 命名空间）。
func containerShapeOf(itemID string) (shape string, ok bool) {
	parts := strings.Split(itemID, "/")
	switch len(parts) {
	case 2:
		if parts[0] == itemTypeCourse && protocol.ValidSlug(parts[1]) {
			return itemTypeCourse, true
		}
	case 4:
		if parts[0] == itemTypeCourse && protocol.ValidSlug(parts[1]) &&
			parts[2] == itemTypeLesson && protocol.ValidSlug(parts[3]) {
			return itemTypeLesson, true
		}
	}
	return "", false
}

// childKindsByContainer 是容器清单行（seq>=1）的合法 kind 取值域（本册 §2.1 铁律 3）。
var childKindsByContainer = map[string]map[string]bool{
	itemTypeCourse: {itemTypeLesson: true},
	itemTypeLesson: {
		itemTypeArticle: true, "video": true, "audio": true, itemTypeQuiz: true,
	},
}

// submitSegment 是一条待落库的容器行（本册 §4.1）：seq<0 属性行、seq=0 简介、seq>=1 子项。
type submitSegment struct {
	Seq  int    `json:"seq"`
	Kind string `json:"kind"`
	Text string `json:"text"`
}

// validateSubmitSegments 按册子 §2.1 的三区间铁律校验容器行集，返回可落库的行。
// 归一化失败一律假（调用方回 item_segments_invalid）：
//  1. seq<0 只放属性行（kind 须是 protocol.IsAttrKind），且**必须**是 AssignAttrSeqs 的规范排布；
//  2. seq=0 只放一行 digest；
//  3. seq>=1 只放本容器允许的子项 kind（课程只收 lesson，课时只收 article/video/audio/quiz）；
//  4. seq 不得重复。
func validateSubmitSegments(itemID, typ string, in []submitSegment) ([]store.Segment, bool) {
	ordered := append([]submitSegment{}, in...)
	sort.Slice(ordered, func(i, j int) bool { return ordered[i].Seq < ordered[j].Seq })
	childKinds := childKindsByContainer[typ]
	attrs := []protocol.AttrSlot{}
	out := make([]store.Segment, 0, len(ordered))
	for i, s := range ordered {
		if i > 0 && s.Seq == ordered[i-1].Seq {
			return nil, false
		}
		switch {
		case s.Seq < 0:
			if !protocol.IsAttrKind(s.Kind) {
				return nil, false
			}
			attrs = append(attrs, protocol.AttrSlot{Seq: s.Seq, Kind: s.Kind, Text: s.Text})
		case s.Seq == 0:
			if s.Kind != protocol.DigestKind {
				return nil, false
			}
		default:
			if !childKinds[s.Kind] {
				return nil, false
			}
		}
		out = append(out, store.Segment{ItemID: itemID, Seq: s.Seq, Kind: s.Kind, Text: s.Text})
	}
	// 属性行必须与导出端逐字节同构，否则双端 content_hash 会静默漂移（本册 §8 风险 2）。
	if !protocol.AttrSeqsCanonical(attrs) {
		return nil, false
	}
	return out, true
}

// validItemTitle 按册子 §2.1：去首尾空白后 rune 长度 1..200，且不含控制字符（U+0000–U+001F、U+007F）。
func validItemTitle(title string) bool {
	n := utf8.RuneCountInString(strings.TrimSpace(title))
	if n < 1 || n > maxTitleRunes {
		return false
	}
	for _, r := range title {
		if r <= 0x1F || r == 0x7F {
			return false
		}
	}
	return true
}

// validQuestionJSON 按册子 §5：合法 JSON、schema_version == 1、questions 非空数组。
// 只认这两个键，其余键不参与判定。
func validQuestionJSON(raw string) bool {
	var doc struct {
		SchemaVersion int               `json:"schema_version"`
		Questions     []json.RawMessage `json:"questions"`
	}
	if err := json.Unmarshal([]byte(raw), &doc); err != nil {
		return false
	}
	return doc.SchemaVersion == 1 && len(doc.Questions) > 0
}

// submissionContentHash 按册子 §2.2：与 internal/importer 的既有口径逐字节同构
// （article = sha256(body_md)、quiz = sha256(question_json)，均取 UTF-8 字节，不走 canonicalize）。
func submissionContentHash(typ, bodyMD, questionJSON string) string {
	if typ == itemTypeArticle {
		return protocol.SHA256Hex([]byte(bodyMD))
	}
	return protocol.SHA256Hex([]byte(questionJSON))
}

type submitReq struct {
	Type         string          `json:"type"`
	ItemID       string          `json:"item_id"`
	Title        string          `json:"title"`
	BodyMD       string          `json:"body_md"`
	QuestionJSON string          `json:"question_json"`
	AuthorSig    string          `json:"author_sig"`
	Links        []submitLink    `json:"links"`
	Segments     []submitSegment `json:"segments"`
	AuthorID     json.RawMessage `json:"author_id"`
}

// submitLink 是 type=tag 的一条关联（册子 §3.4）。
type submitLink struct {
	TargetID string `json:"target_id"`
	Kind     string `json:"kind"`
}

// handleSubmitPost 是签名写路径 POST /v1/submit（册子 §2.1）：已登记身份的作者
// 把自己写的独立 article / quiz 直投本节点，验签通过即生效。任何失败都不写入。
func (s *Server) handleSubmitPost(w http.ResponseWriter, r *http.Request) {
	actor := identityFrom(r)
	var req submitReq
	if !s.decodeJSON(w, r, &req) {
		return
	}
	// author_id 只能取自鉴权身份：请求体携带即等于替他人署名（册子 §2.1 硬约束）。
	if len(req.AuthorID) > 0 {
		s.writeAuthErr(w, http.StatusBadRequest, "author_id_forbidden")
		return
	}
	if req.Type != itemTypeArticle && req.Type != itemTypeQuiz && req.Type != itemTypeTag &&
		req.Type != itemTypeCourse && req.Type != itemTypeLesson {
		s.writeAuthErr(w, http.StatusBadRequest, "item_type_unsupported")
		return
	}
	var containerSegs []store.Segment
	switch req.Type {
	case itemTypeTag:
		if _, _, _, ok := protocol.ParseTagItemID(req.ItemID); !ok {
			s.writeAuthErr(w, http.StatusBadRequest, "item_id_invalid")
			return
		}
	case itemTypeCourse, itemTypeLesson:
		shape, ok := containerShapeOf(req.ItemID)
		if !ok {
			s.writeAuthErr(w, http.StatusBadRequest, "item_id_invalid")
			return
		}
		if shape != req.Type {
			s.writeAuthErr(w, http.StatusBadRequest, "item_type_mismatch")
			return
		}
		segs, ok := validateSubmitSegments(req.ItemID, req.Type, req.Segments)
		if !ok {
			s.writeAuthErr(w, http.StatusBadRequest, "item_segments_invalid")
			return
		}
		containerSegs = segs
	default:
		if _, code := splitSubmitItemID(req.ItemID, req.Type); code != "" {
			s.writeAuthErr(w, http.StatusBadRequest, code)
			return
		}
	}
	title := strings.TrimSpace(req.Title)
	if !validItemTitle(req.Title) {
		s.writeAuthErr(w, http.StatusBadRequest, "item_title_invalid")
		return
	}
	if req.Type == itemTypeTag {
		name, chapter, section, _ := protocol.ParseTagItemID(req.ItemID)
		if strings.TrimSpace(req.Title) != protocol.TagTitle(name, chapter, section) {
			// title 不是自由字段：它由 item_id 三段重建而来（册子 §3.1）
			s.writeAuthErr(w, http.StatusBadRequest, "item_title_invalid")
			return
		}
	}
	content := req.BodyMD
	if req.Type == itemTypeQuiz {
		content = req.QuestionJSON
	}
	if len(content) > maxSubmitBytes {
		s.writeAuthErr(w, http.StatusRequestEntityTooLarge, "item_body_too_large")
		return
	}
	if req.Type == itemTypeQuiz && !validQuestionJSON(req.QuestionJSON) {
		s.writeAuthErr(w, http.StatusBadRequest, "item_question_invalid")
		return
	}
	var tagLinks []store.TagLink
	if req.Type == itemTypeTag {
		links, ok := normalizeSubmitTagLinks(req.Links)
		if !ok {
			s.writeAuthErr(w, http.StatusBadRequest, "tag_links_invalid")
			return
		}
		tagLinks = links
	}
	if !s.submitLimiterByID.allow(actor) || !s.submitLimiterByIP.allow(clientIP(r)) {
		s.writeAuthErr(w, http.StatusTooManyRequests, "item_rate_limited")
		return
	}
	// content_hash 一律由服务端算（册子 §2.2）：请求体带的那个已在上文被忽略。
	var contentHash string
	switch req.Type {
	case itemTypeTag:
		// 容器口径（#14 §3.3）：哈希只看物化的 segments 行——与 #25 的 article/quiz 口径不同。
		contentHash = store.SegmentsContentHash(store.MaterializeTagSegments(req.ItemID, tagLinks))
	case itemTypeCourse, itemTypeLesson:
		// 容器口径（本册 §2.3）：按 seq 升序拼 "<kind>\t<text>\n"。
		contentHash = store.SegmentsContentHash(containerSegs)
	default:
		contentHash = submissionContentHash(req.Type, req.BodyMD, req.QuestionJSON)
	}

	it, ok, err := s.st.LookupIdentity(actor)
	if err != nil {
		s.writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	if !ok {
		s.writeAuthErr(w, http.StatusForbidden, "identity_unregistered")
		return
	}
	if req.Type == itemTypeTag {
		// 资格（册子 §3.4）：本接口第一次出现「验签通过但仍可能无权写」——判定不可省略、不可配置。
		governors, err := s.st.GovernorSet()
		if err != nil {
			s.writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		if !governors[actor] {
			s.writeAuthErr(w, http.StatusForbidden, "tag_not_governor")
			return
		}
		exists, err := s.checkTagTargetsExist(tagLinks)
		if err != nil {
			s.writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		if !exists {
			s.writeAuthErr(w, http.StatusBadRequest, "tag_target_not_found")
			return
		}
	}
	if !isHexN(req.AuthorSig, 64) {
		s.writeAuthErr(w, http.StatusBadRequest, "author_sig_invalid")
		return
	}
	// 作者公钥取本节点 identities 表：内容被搬到别的节点后，验签改走包内 contributors（#24 已落地）。
	valid, err := protocol.VerifyAuthorSig(it.PubKey, req.ItemID, contentHash, actor, req.AuthorSig)
	if err != nil || !valid {
		s.writeAuthErr(w, http.StatusBadRequest, "author_sig_invalid")
		return
	}
	var created bool
	switch req.Type {
	case itemTypeTag:
		_, err = s.st.UpsertTagSubmission(store.TagSubmission{
			TagID: req.ItemID, Title: title, Links: tagLinks,
			AuthorID: actor, AuthorSig: req.AuthorSig,
		})
	case itemTypeCourse, itemTypeLesson:
		created, err = s.st.UpsertSegmentSubmission(store.SegmentSubmission{
			ItemID: req.ItemID, Type: req.Type, Title: title, Segments: containerSegs,
			AuthorID: actor, AuthorSig: req.AuthorSig,
		})
	default:
		created, err = s.st.UpsertSubmission(store.Submission{
			ItemID: req.ItemID, Type: req.Type, Title: title,
			BodyMD: req.BodyMD, QuestionJSON: req.QuestionJSON,
			ContentHash: contentHash, AuthorID: actor, AuthorSig: req.AuthorSig,
		})
	}
	if errors.Is(err, store.ErrItemTaken) {
		s.writeAuthErr(w, http.StatusForbidden, "item_id_taken")
		return
	}
	if errors.Is(err, store.ErrTagTargetTagged) {
		s.writeAuthErr(w, http.StatusForbidden, "tag_target_tagged")
		return
	}
	if err != nil {
		s.writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	s.writeJSON(w, http.StatusOK, map[string]any{
		"item_id": req.ItemID, "type": req.Type,
		"content_hash": contentHash, "author_id": actor, "created": created,
	})
}

// normalizeSubmitTagLinks 校验并规范化 links（册子 §3.4）：kind 必须与 target_id 形态自洽，
// 同一 target_id 不得重复（tag_links 的主键是 (tag_id,target_id)）。
func normalizeSubmitTagLinks(in []submitLink) ([]store.TagLink, bool) {
	out := make([]store.TagLink, 0, len(in))
	seen := map[string]bool{}
	for _, l := range in {
		kind := protocol.TagKindOfTarget(l.TargetID)
		if kind == "" || kind != l.Kind || seen[l.TargetID] {
			return nil, false
		}
		seen[l.TargetID] = true
		out = append(out, store.TagLink{TargetID: l.TargetID, Kind: kind})
	}
	return out, true
}

// checkTagTargetsExist 逐个校验目标存在性（册子 §3.2）：条目必须在本节点且 state='active'；
// 评论必须是一条本节点已收到的 comment.v1 事件——② 类由此天然被排除（§3.7）。
func (s *Server) checkTagTargetsExist(links []store.TagLink) (bool, error) {
	for _, l := range links {
		if l.Kind == "comment" {
			ok, err := s.st.HasCommentEvent(strings.TrimPrefix(l.TargetID, "comment/"))
			if err != nil {
				return false, err
			}
			if !ok {
				return false, nil
			}
			continue
		}
		it, ok, err := s.st.GetItem(l.TargetID)
		if err != nil {
			return false, err
		}
		if !ok || it.State != "active" {
			return false, nil
		}
	}
	return true, nil
}
