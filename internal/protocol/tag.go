package protocol

import (
	"fmt"
	"strconv"
	"strings"
	"unicode/utf8"
)

// TagSegmentMaxRunes 是三元组单段的 rune 上限（册子 §3.1）。
const TagSegmentMaxRunes = 64

// tagKindOrder 是关联的 kind 取值集合（册子 §3.2）；排序口径在 store 侧（册子 §3.3）。
var tagKindOrder = []string{"course", "lesson", "article", "comment"}

// normalizeTagSegment 归一化一段：去首尾空白。
// **本册口径收窄（2026-09-30 用户定案）**：不做 NFC/NFD 归一化——Go 标准库无 NFC，
// 仓库不含 golang.org/x/text，不为一个边角场景引入新依赖。客户端同步只 trim。
func normalizeTagSegment(s string) string { return strings.TrimSpace(s) }

// TagItemID 由三段重建 item_id；任一段归一化后为空或超 64 rune 即 ok=false（册子 §3.1）。
// 唯一性由 item_id 天然承载：三段归一化后相同 ⇒ 同一 item_id ⇒ 同一条件，无需判重表。
func TagItemID(name, chapter, section string) (string, bool) {
	parts := [3]string{name, chapter, section}
	enc := [3]string{}
	for i, p := range parts {
		n := normalizeTagSegment(p)
		if n == "" || utf8.RuneCountInString(n) > TagSegmentMaxRunes {
			return "", false
		}
		enc[i] = encodeTagPathSegment(n)
	}
	return "tag/" + enc[0] + "/" + enc[1] + "/" + enc[2], true
}

// TagTitle 是 items.title：三段**原文**（已归一化）以 " · " 连接，不编码（册子 §3.1）。
func TagTitle(name, chapter, section string) string {
	return normalizeTagSegment(name) + " · " + normalizeTagSegment(chapter) + " · " + normalizeTagSegment(section)
}

// ParseTagItemID 解出三段并**重建校验**：重建值必须与入参逐字相等，否则 ok=false。
// 这条重建校验是 §3.1 的「title 不是自由字段」与「唯一性」的实现基础。
func ParseTagItemID(itemID string) (name, chapter, section string, ok bool) {
	rest, found := strings.CutPrefix(itemID, "tag/")
	if !found {
		return "", "", "", false
	}
	parts := strings.Split(rest, "/")
	if len(parts) != 3 {
		return "", "", "", false
	}
	segs := [3]string{}
	for i, p := range parts {
		if p == "" {
			return "", "", "", false
		}
		d, ok := decodeTagPathSegment(p)
		if !ok {
			return "", "", "", false
		}
		segs[i] = d
	}
	rebuilt, ok := TagItemID(segs[0], segs[1], segs[2])
	if !ok || rebuilt != itemID {
		return "", "", "", false
	}
	return segs[0], segs[1], segs[2], true
}

// encodeTagPathSegment 对 `/` `\` `%` 与控制字符（U+0000–U+001F、U+007F）做百分号编码，
// 其余字符（含中文）原样保留（册子 §3.1）。
func encodeTagPathSegment(s string) string {
	var b strings.Builder
	for _, r := range s {
		switch {
		case r == '/':
			b.WriteString("%2F")
		case r == '\\':
			b.WriteString("%5C")
		case r == '%':
			b.WriteString("%25")
		case r <= 0x1F || r == 0x7F:
			fmt.Fprintf(&b, "%%%02X", r) // 控制字符均 < 0x80，字节值即 rune 值
		default:
			b.WriteRune(r)
		}
	}
	return b.String()
}

// decodeTagPathSegment 是 encodeTagPathSegment 的逆；遇到不完整或非十六进制的 `%xx` 即失败。
func decodeTagPathSegment(s string) (string, bool) {
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		if s[i] != '%' {
			b.WriteByte(s[i])
			continue
		}
		if i+3 > len(s) {
			return "", false
		}
		v, err := strconv.ParseUint(s[i+1:i+3], 16, 8)
		if err != nil {
			return "", false
		}
		b.WriteByte(byte(v))
		i += 2
	}
	return b.String(), true
}

// TagKindOfTarget 由 target_id 形态判定 kind（册子 §3.2）；不合法返回空串。
// 判定只看形态，不看存在性——存在性由调用方查库（§3.2 的表）。
func TagKindOfTarget(targetID string) string {
	parts := strings.Split(targetID, "/")
	for _, p := range parts {
		if p == "" {
			return ""
		}
	}
	switch {
	case len(parts) == 2 && parts[0] == "course":
		return "course"
	case len(parts) == 2 && parts[0] == "article":
		return "article"
	case len(parts) == 4 && parts[0] == "course" && parts[2] == "lesson":
		return "lesson"
	case len(parts) == 6 && parts[0] == "course" && parts[2] == "lesson" && parts[4] == "article":
		return "article"
	case len(parts) == 2 && parts[0] == "comment" && isHex32(parts[1]):
		// 只认 32 hex：group.v1 / dm.v1 的 event_id 由 §3.7 一律拒（② 类红线）。
		return "comment"
	default:
		return ""
	}
}

// TagKindAllowed 判定 kind 是否在 §3.2 的取值集合内（导出侧与接收侧回填的防御性过滤用）。
func TagKindAllowed(kind string) bool {
	for _, k := range tagKindOrder {
		if k == kind {
			return true
		}
	}
	return false
}
