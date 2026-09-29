package httpapi

import (
	"encoding/json"
	"errors"
	"net/http"
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
	AuthorID     json.RawMessage `json:"author_id"`
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
	if req.Type != itemTypeArticle && req.Type != itemTypeQuiz {
		s.writeAuthErr(w, http.StatusBadRequest, "item_type_unsupported")
		return
	}
	if _, code := splitSubmitItemID(req.ItemID, req.Type); code != "" {
		s.writeAuthErr(w, http.StatusBadRequest, code)
		return
	}
	title := strings.TrimSpace(req.Title)
	if !validItemTitle(req.Title) {
		s.writeAuthErr(w, http.StatusBadRequest, "item_title_invalid")
		return
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
	if !s.submitLimiterByID.allow(actor) || !s.submitLimiterByIP.allow(clientIP(r)) {
		s.writeAuthErr(w, http.StatusTooManyRequests, "item_rate_limited")
		return
	}
	// content_hash 一律由服务端算（册子 §2.2）：请求体带的那个已在上文被忽略。
	contentHash := submissionContentHash(req.Type, req.BodyMD, req.QuestionJSON)

	it, ok, err := s.st.LookupIdentity(actor)
	if err != nil {
		s.writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	if !ok {
		s.writeAuthErr(w, http.StatusForbidden, "identity_unregistered")
		return
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
	created, err := s.st.UpsertSubmission(store.Submission{
		ItemID: req.ItemID, Type: req.Type, Title: title,
		BodyMD: req.BodyMD, QuestionJSON: req.QuestionJSON,
		ContentHash: contentHash, AuthorID: actor, AuthorSig: req.AuthorSig,
	})
	if errors.Is(err, store.ErrItemTaken) {
		s.writeAuthErr(w, http.StatusForbidden, "item_id_taken")
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
