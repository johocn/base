// Package markdown 提供 attr.body_md / articles.body_md 的渲染管线：
// 「解析 + 消毒」单出口，把 Markdown 子集与变色扩展 [文字]{.c-x} 转为白名单 HTML。
//
// 渲染是只读派生：产物不落库、不入包、不参与哈希。白名单在产出时逐点强制——
// 只生成 h1/h2/h3/p/ul/ol/li/blockquote/pre/code/strong/em/a/img/hr/br/span，
// 属性仅 a[href]/img[src]/img[alt]/span[class]，class 只认 7 个枚举名，
// href/src 仅 http:// 与 https://（否则只丢该属性），文本节点转义 & < >。
package markdown

import (
	"html/template"
	"regexp"
	"strings"
)

// Render 渲染并消毒 src，返回可直出的 template.HTML（门户唯一出口，显式关模板转义）。
func Render(src string) template.HTML {
	return template.HTML(RenderString(src))
}

// RenderString 渲染并消毒 src，返回 HTML 字符串。
func RenderString(src string) string {
	return renderBlocks(strings.Split(src, "\n"))
}

var (
	reHeading = regexp.MustCompile(`^(#{1,})\s+(.*)$`)
	reHR      = regexp.MustCompile(`^-{3,}$`)
	reUL      = regexp.MustCompile(`^(\s*)- +(.*)$`)
	reOL      = regexp.MustCompile(`^(\s*)[0-9]+\. +(.*)$`)
)

// colorClasses 是变色扩展的 7 个枚举类名（span[class] 的合法取值）。
var colorClasses = map[string]bool{
	"red": true, "orange": true, "green": true, "blue": true,
	"purple": true, "gray": true, "mark": true,
}

var headingTags = [4]string{"", "h1", "h2", "h3"}

func renderBlocks(lines []string) string {
	var b strings.Builder
	for i := 0; i < len(lines); {
		line := lines[i]
		switch {
		case strings.TrimSpace(line) == "":
			i++
		case reHeading.MatchString(line):
			m := reHeading.FindStringSubmatch(line)
			level := len(m[1])
			if level > 3 {
				level = 3
			}
			tag := headingTags[level]
			b.WriteString("<" + tag + ">" + inline(m[2]) + "</" + tag + ">")
			i++
		case reHR.MatchString(strings.TrimSpace(line)):
			b.WriteString("<hr>")
			i++
		case strings.HasPrefix(line, "> "):
			var parts []string
			for i < len(lines) && strings.HasPrefix(lines[i], "> ") {
				parts = append(parts, inline(lines[i][2:]))
				i++
			}
			b.WriteString("<blockquote>" + strings.Join(parts, "<br>") + "</blockquote>")
		case isListLine(line):
			start := i
			for i < len(lines) && isListLine(lines[i]) {
				i++
			}
			b.WriteString(renderList(lines[start:i]))
		default:
			var parts []string
			for i < len(lines) && strings.TrimSpace(lines[i]) != "" && !isBlockStart(lines[i]) {
				parts = append(parts, inline(lines[i]))
				i++
			}
			b.WriteString("<p>" + strings.Join(parts, "<br>") + "</p>")
		}
	}
	return b.String()
}

func isListLine(line string) bool {
	return reUL.MatchString(line) || reOL.MatchString(line)
}

func isBlockStart(line string) bool {
	return reHeading.MatchString(line) ||
		reHR.MatchString(strings.TrimSpace(line)) ||
		strings.HasPrefix(line, "> ") ||
		isListLine(line)
}

type listItem struct {
	text     string
	ordered  bool
	children []listItem
}

func renderList(lines []string) string {
	items := make([]listItem, 0, len(lines))
	outerOrdered := false
	for _, line := range lines {
		indent, content, ordered, ok := parseListItem(line)
		if !ok {
			continue
		}
		if indent == 0 {
			if len(items) == 0 {
				outerOrdered = ordered
			}
			items = append(items, listItem{text: content})
		} else if len(items) > 0 {
			last := len(items) - 1
			items[last].children = append(items[last].children, listItem{text: content, ordered: ordered})
		}
	}
	return renderListItems(items, outerOrdered)
}

func parseListItem(line string) (indent int, content string, ordered bool, ok bool) {
	if m := reUL.FindStringSubmatch(line); m != nil {
		return len(m[1]), m[2], false, true
	}
	if m := reOL.FindStringSubmatch(line); m != nil {
		return len(m[1]), m[2], true, true
	}
	return 0, "", false, false
}

func renderListItems(items []listItem, ordered bool) string {
	tag := "ul"
	if ordered {
		tag = "ol"
	}
	var b strings.Builder
	b.WriteString("<" + tag + ">")
	for _, it := range items {
		b.WriteString("<li>" + inline(it.text))
		if len(it.children) > 0 {
			b.WriteString(renderListItems(it.children, it.children[0].ordered))
		}
		b.WriteString("</li>")
	}
	b.WriteString("</" + tag + ">")
	return b.String()
}

// inline 解析行内标记，逐字节扫描以保证多字节 UTF-8 不被破坏。
func inline(s string) string {
	var b strings.Builder
	for i := 0; i < len(s); {
		c := s[i]
		switch {
		case c == '\\' && i+1 < len(s) && (s[i+1] == '[' || s[i+1] == ']'):
			b.WriteByte(s[i+1])
			i += 2
		case c == '`':
			if j := strings.IndexByte(s[i+1:], '`'); j >= 0 {
				b.WriteString("<code>" + escapeText(s[i+1:i+1+j]) + "</code>")
				i += j + 2
			} else {
				b.WriteByte('`')
				i++
			}
		case c == '*':
			if html, n, ok := parseEmphasis(s[i:]); ok {
				b.WriteString(html)
				i += n
			} else {
				b.WriteByte('*')
				i++
			}
		case c == '!':
			if html, n, ok := parseImage(s[i:]); ok {
				b.WriteString(html)
				i += n
			} else {
				b.WriteByte('!')
				i++
			}
		case c == '[':
			if html, n, ok := parseBracket(s[i:]); ok {
				b.WriteString(html)
				i += n
			} else {
				b.WriteByte('[')
				i++
			}
		default:
			writeEscapedByte(&b, c)
			i++
		}
	}
	return b.String()
}

func parseEmphasis(s string) (string, int, bool) {
	if len(s) >= 2 && s[1] == '*' {
		if j := strings.Index(s[2:], "**"); j >= 0 {
			return "<strong>" + inline(s[2:2+j]) + "</strong>", 2 + j + 2, true
		}
		return "", 0, false
	}
	if j := strings.IndexByte(s[1:], '*'); j >= 0 {
		return "<em>" + inline(s[1:1+j]) + "</em>", 1 + j + 1, true
	}
	return "", 0, false
}

func parseImage(s string) (string, int, bool) {
	if len(s) < 2 || s[1] != '[' {
		return "", 0, false
	}
	k := strings.IndexByte(s[2:], ']')
	if k < 0 {
		return "", 0, false
	}
	closeIdx := 2 + k
	alt := s[2:closeIdx]
	rest := s[closeIdx+1:]
	if !strings.HasPrefix(rest, "(") {
		return "", 0, false
	}
	url, after, ok := parseURL(rest)
	if !ok {
		return "", 0, false
	}
	var b strings.Builder
	b.WriteString("<img")
	if safeURL(url) {
		b.WriteString(` src="` + escapeAttr(url) + `"`)
	}
	b.WriteString(` alt="` + escapeAttr(alt) + `">`)
	return b.String(), closeIdx + 1 + after, true
}

// parseBracket 处理 [文字] 后缀消歧：先试变色后缀 {.c-，再试链接后缀 (。
func parseBracket(s string) (string, int, bool) {
	k := strings.IndexByte(s[1:], ']')
	if k < 0 {
		return "", 0, false
	}
	closeIdx := 1 + k
	content := s[1:closeIdx]
	rest := s[closeIdx+1:]
	if strings.HasPrefix(rest, "{.c-") {
		end := strings.IndexByte(rest, '}')
		if end < 0 {
			return "", 0, false
		}
		n := closeIdx + 1 + end + 1
		class := rest[4:end]
		if colorClasses[class] {
			return `<span class="c-` + class + `">` + inline(content) + "</span>", n, true
		}
		// 未知类名：整段按字面量原样输出，不产 span。
		return "[" + escapeText(content) + "]" + escapeText(rest[:end+1]), n, true
	}
	if strings.HasPrefix(rest, "(") {
		url, after, ok := parseURL(rest)
		if !ok {
			return "", 0, false
		}
		href := ""
		if safeURL(url) {
			href = ` href="` + escapeAttr(url) + `"`
		}
		return "<a" + href + ">" + inline(content) + "</a>", closeIdx + 1 + after, true
	}
	return "", 0, false
}

// parseURL 从 s[0]=='(' 起按括号配平取到匹配的 ')'，返回 url 与其后位移。
func parseURL(s string) (string, int, bool) {
	depth := 0
	for j := 0; j < len(s); j++ {
		switch s[j] {
		case '(':
			depth++
		case ')':
			depth--
			if depth == 0 {
				return s[1:j], j + 1, true
			}
		}
	}
	return "", 0, false
}

func safeURL(u string) bool {
	return strings.HasPrefix(u, "http://") || strings.HasPrefix(u, "https://")
}

func writeEscapedByte(b *strings.Builder, c byte) {
	switch c {
	case '&':
		b.WriteString("&amp;")
	case '<':
		b.WriteString("&lt;")
	case '>':
		b.WriteString("&gt;")
	default:
		b.WriteByte(c)
	}
}

func escapeText(s string) string {
	s = strings.ReplaceAll(s, "&", "&amp;")
	s = strings.ReplaceAll(s, "<", "&lt;")
	return strings.ReplaceAll(s, ">", "&gt;")
}

func escapeAttr(s string) string {
	s = strings.ReplaceAll(s, "&", "&amp;")
	s = strings.ReplaceAll(s, "<", "&lt;")
	s = strings.ReplaceAll(s, ">", "&gt;")
	return strings.ReplaceAll(s, `"`, "&quot;")
}
