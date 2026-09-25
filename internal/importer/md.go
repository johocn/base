// Package importer 提供 P0 的本地 markdown 内容导入（一次性工具路径，
// 与 tools/migrate 的 Strapi 导入共用 store 写入语义：以 (source,item_id) 为幂等键）。
package importer

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/johocn/base/internal/protocol"
	"github.com/johocn/base/internal/store"
)

const sourceModule = "article"

// Doc 是一篇待导入的文章。
type Doc struct {
	Slug        string
	Title       string
	Digest      string
	PublishedAt string
	Tags        []string
	Body        string
}

// Result 是导入统计。
type Result struct {
	Imported int
	Failed   int
	Errors   []string
}

// ParseMD 解析带可选 front-matter 的 markdown。
// front-matter：首行 --- 起、到下一个独立 --- 行止，内容为 `key: value`。
func ParseMD(filename string, raw []byte) (Doc, error) {
	text := strings.ReplaceAll(string(raw), "\r\n", "\n")
	meta := map[string]string{}
	body := text
	if strings.HasPrefix(text, "---\n") {
		rest := text[len("---\n"):]
		if idx := strings.Index(rest, "\n---\n"); idx >= 0 {
			block := rest[:idx]
			body = rest[idx+len("\n---\n"):]
			for _, line := range strings.Split(block, "\n") {
				line = strings.TrimSpace(line)
				if line == "" || strings.HasPrefix(line, "#") {
					continue
				}
				k, v, ok := strings.Cut(line, ":")
				if !ok {
					continue
				}
				meta[strings.TrimSpace(k)] = strings.Trim(strings.TrimSpace(v), `"'`)
			}
		}
	}
	body = strings.Trim(body, "\n")
	if body == "" {
		return Doc{}, fmt.Errorf("importer: %s 正文为空", filename)
	}
	stem := strings.TrimSuffix(filepath.Base(filename), filepath.Ext(filename))
	doc := Doc{
		Slug:        meta["slug"],
		Title:       meta["title"],
		Digest:      meta["digest"],
		PublishedAt: meta["published_at"],
		Body:        body,
	}
	if doc.Slug == "" {
		doc.Slug = stem
	}
	if doc.Title == "" {
		if first := strings.SplitN(body, "\n", 2)[0]; strings.HasPrefix(first, "# ") {
			doc.Title = strings.TrimSpace(strings.TrimPrefix(first, "# "))
			doc.Body = strings.Trim(strings.TrimSpace(strings.SplitN(body, "\n", 2)[1]), "\n")
			body = doc.Body
		} else {
			doc.Title = stem
		}
	}
	if t := meta["tags"]; t != "" {
		for _, part := range strings.Split(t, ",") {
			if p := strings.TrimSpace(part); p != "" {
				doc.Tags = append(doc.Tags, p)
			}
		}
	}
	if doc.PublishedAt == "" {
		doc.PublishedAt = "1970-01-01T00:00:00Z"
	}
	if doc.Digest == "" {
		doc.Digest = firstLine(body)
	}
	return doc, nil
}

func firstLine(body string) string {
	line := strings.SplitN(body, "\n", 2)[0]
	line = strings.TrimSpace(strings.TrimPrefix(line, "# "))
	runes := []rune(line)
	if len(runes) > 80 {
		line = string(runes[:80])
	}
	return line
}

// Run 导入目录下全部 *.md（按文件名升序），幂等覆盖同 slug 条目。
func Run(st *store.Store, dir string) (Result, error) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return Result{}, fmt.Errorf("importer: read dir %s: %w", dir, err)
	}
	names := []string{}
	for _, e := range entries {
		if e.IsDir() || !strings.EqualFold(filepath.Ext(e.Name()), ".md") {
			continue
		}
		names = append(names, e.Name())
	}
	sort.Strings(names)

	res := Result{}
	for _, name := range names {
		raw, err := os.ReadFile(filepath.Join(dir, name))
		if err != nil {
			res.Failed++
			res.Errors = append(res.Errors, name+": "+err.Error())
			continue
		}
		doc, err := ParseMD(name, raw)
		if err != nil {
			res.Failed++
			res.Errors = append(res.Errors, name+": "+err.Error())
			continue
		}
		tags := doc.Tags
		if tags == nil {
			tags = []string{}
		}
		tagsJSON, err := json.Marshal(tags)
		if err != nil {
			res.Failed++
			res.Errors = append(res.Errors, name+": "+err.Error())
			continue
		}
		bodyBytes := []byte(doc.Body)
		hash := protocol.SHA256Hex(bodyBytes)
		if err := st.UpsertArticle(store.Article{
			ItemID:      sourceModule + ":" + doc.Slug,
			Title:       doc.Title,
			Digest:      doc.Digest,
			PublishedAt: doc.PublishedAt,
			TagsJSON:    string(tagsJSON),
			BodyMD:      doc.Body,
			ContentHash: hash,
			SourceRev:   hash[:16],
		}); err != nil {
			res.Failed++
			res.Errors = append(res.Errors, name+": "+err.Error())
			continue
		}
		res.Imported++
	}
	return res, nil
}