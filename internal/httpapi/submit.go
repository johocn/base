package httpapi

import (
	"encoding/json"
	"strings"
	"unicode/utf8"

	"github.com/johocn/base/internal/protocol"
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

// validSlug 按册子 §2.4：[a-z0-9][a-z0-9-]{0,63}（总长 ≤ 64）。
func validSlug(s string) bool {
	if len(s) == 0 || len(s) > 64 {
		return false
	}
	for i := 0; i < len(s); i++ {
		c := s[i]
		isAlnum := (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9')
		if i == 0 {
			if !isAlnum {
				return false
			}
			continue
		}
		if !isAlnum && c != '-' {
			return false
		}
	}
	return true
}

// splitSubmitItemID 校验 item_id 形态并返回 slug；code 非空即失败，
// 取值 item_id_invalid（形态/前缀/slug 不合法，含 course/ 前缀）或 item_type_mismatch（册子 §2.4）。
func splitSubmitItemID(itemID, typ string) (slug, code string) {
	prefix, rest, ok := strings.Cut(itemID, "/")
	if !ok || (prefix != itemTypeArticle && prefix != itemTypeQuiz) || !validSlug(rest) {
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
