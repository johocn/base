package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/johocn/base/internal/protocol"
	"github.com/johocn/base/internal/store"
)

// Options 是迁移运行参数。
type Options struct {
	BaseURL     string
	Headers     map[string]string
	PageSize    int
	Limit       int
	HTTPTimeout time.Duration
	DryRun      bool
}

// Result 是迁移统计。
type Result struct {
	Seen      int
	Published int
	Skipped   int
	Imported  int
	Covers    int
}

// Client 是最小 Strapi REST 客户端（只做 GET）。
type Client struct {
	base    string
	http    *http.Client
	headers map[string]string
}

func NewClient(base string, headers map[string]string, timeout time.Duration) *Client {
	if timeout <= 0 {
		timeout = 60 * time.Second
	}
	return &Client{
		base:    strings.TrimRight(base, "/"),
		http:    &http.Client{Timeout: timeout},
		headers: headers,
	}
}

func (c *Client) do(rawURL string) ([]byte, string, error) {
	req, err := http.NewRequest(http.MethodGet, rawURL, nil)
	if err != nil {
		return nil, "", err
	}
	req.Header.Set("Accept", "application/json")
	for k, v := range c.headers {
		// 特例：Host 不能走 Header（Go 的 transport 会忽略 Header["Host"]），必须设 req.Host
		if strings.EqualFold(k, "Host") {
			req.Host = v
			continue
		}
		req.Header.Set(k, v)
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return nil, "", fmt.Errorf("migrate: GET %s: %w", rawURL, err)
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 64<<20))
	if err != nil {
		return nil, "", err
	}
	if resp.StatusCode != http.StatusOK {
		return nil, "", fmt.Errorf("migrate: GET %s: HTTP %d: %s", rawURL, resp.StatusCode, truncate(string(body), 200))
	}
	return body, resp.Header.Get("Content-Type"), nil
}

// listArticles 拉一页列表，兼容裸数组与 Strapi 5 的 {data,meta} 两种形态。
func (c *Client) listArticles(page, pageSize int) ([]map[string]any, int, error) {
	q := url.Values{}
	q.Set("page", strconv.Itoa(page))
	q.Set("pageSize", strconv.Itoa(pageSize))
	q.Set("sort", "publishedAt:asc")
	body, _, err := c.do(c.base + "/api/zhao-website/v1/articles?" + q.Encode())
	if err != nil {
		return nil, 0, err
	}
	var bare []map[string]any
	if err := json.Unmarshal(body, &bare); err == nil {
		return bare, 0, nil
	}
	var wrapped struct {
		Data []map[string]any `json:"data"`
		Meta struct {
			Pagination struct {
				PageCount int `json:"pageCount"`
			} `json:"pagination"`
		} `json:"meta"`
	}
	if err := json.Unmarshal(body, &wrapped); err != nil {
		return nil, 0, fmt.Errorf("migrate: 列表响应既不是数组也不是 {data,meta}: %w", err)
	}
	return wrapped.Data, wrapped.Meta.Pagination.PageCount, nil
}

// article 拉详情（按 slug），并摊平 {data}/{attributes} 包裹。
func (c *Client) article(slug string) (map[string]any, error) {
	body, _, err := c.do(c.base + "/api/zhao-website/v1/articles/" + url.PathEscape(slug))
	if err != nil {
		return nil, err
	}
	var raw any
	if err := json.Unmarshal(body, &raw); err != nil {
		return nil, fmt.Errorf("migrate: 详情响应不是 JSON: %w", err)
	}
	return flatten(raw), nil
}

// bytes 下载媒体文件（相对路径按 Strapi 基址拼接）。
func (c *Client) bytes(rawURL string) (string, []byte, error) {
	u := rawURL
	if strings.HasPrefix(u, "/") {
		u = c.base + u
	}
	body, ctype, err := c.do(u)
	if err != nil {
		return "", nil, err
	}
	if i := strings.IndexByte(ctype, ';'); i >= 0 {
		ctype = strings.TrimSpace(ctype[:i])
	}
	return ctype, body, nil
}

// flatten 摊平 {data:...} / {attributes:...} 包裹；非对象返回空 map。
func flatten(v any) map[string]any {
	obj, ok := v.(map[string]any)
	if !ok {
		return map[string]any{}
	}
	if inner, ok := obj["data"]; ok {
		if m := flatten(inner); len(m) > 0 {
			return m
		}
	}
	out := map[string]any{}
	for k, val := range obj {
		if k == "data" {
			continue
		}
		out[k] = val
	}
	if attrs, ok := obj["attributes"].(map[string]any); ok {
		for k, val := range attrs {
			out[k] = val
		}
		delete(out, "attributes")
	}
	return out
}

func str(o map[string]any, keys ...string) string {
	for _, k := range keys {
		v, ok := o[k]
		if !ok {
			continue
		}
		switch t := v.(type) {
		case string:
			if t != "" {
				return t
			}
		case float64:
			return strconv.FormatFloat(t, 'f', -1, 64)
		}
	}
	return ""
}

// tagsJSON 把 tags 原样序列化成字符串（P0 不做标签建模）。
func tagsJSON(o map[string]any) string {
	v, ok := o["tags"]
	if !ok || v == nil {
		return "[]"
	}
	buf, err := json.Marshal(v)
	if err != nil {
		return "[]"
	}
	return string(buf)
}

// coverOf 取封面媒体对象；数组取第一项；缺失返回 nil。
func coverOf(o map[string]any) map[string]any {
	v, ok := o["coverImage"]
	if !ok || v == nil {
		return nil
	}
	switch t := v.(type) {
	case map[string]any:
		return flatten(t)
	case []any:
		if len(t) == 0 {
			return nil
		}
		return flatten(t[0])
	}
	return nil
}

// Run 执行迁移：列表分页 → 详情取正文 → 幂等写入内容库。
func Run(st *store.Store, opt Options) (Result, error) {
	if strings.TrimSpace(opt.BaseURL) == "" {
		return Result{}, fmt.Errorf("migrate: 缺少 Strapi 基址（-strapi 或环境变量 STRAPI）")
	}
	if opt.PageSize <= 0 {
		opt.PageSize = 50
	}
	c := NewClient(opt.BaseURL, opt.Headers, opt.HTTPTimeout)
	var res Result
	pageCount := 0
	for page := 1; ; page++ {
		if opt.Limit > 0 && res.Imported >= opt.Limit {
			return res, nil
		}
		sums, pc, err := c.listArticles(page, opt.PageSize)
		if err != nil {
			return res, err
		}
		if pageCount == 0 && pc > 0 {
			pageCount = pc
		}
		if len(sums) == 0 {
			return res, nil
		}
		for _, s := range sums {
			res.Seen++
			status := str(s, "status")
			if status != "" && status != "published" {
				res.Skipped++
				continue
			}
			slug := str(s, "slug")
			if slug == "" {
				return res, fmt.Errorf("migrate: 条目缺少 slug（documentId=%s）", str(s, "documentId"))
			}
			doc, err := c.article(slug)
			if err != nil {
				return res, err
			}
			for k, v := range s { // 详情缺字段时回退列表值
				if _, ok := doc[k]; !ok {
					doc[k] = v
				}
			}
			res.Published++
			body := str(doc, "content", "body", "bodyMd")
			title := str(doc, "title")
			rev := str(doc, "updatedAt", "publishedAt")
			itemID := "article:" + slug

			if opt.DryRun {
				fmt.Printf("[dry-run] %s title=%q body=%d bytes rev=%s\n", itemID, title, len(body), rev)
				res.Imported++
				continue
			}
			if err := st.UpsertArticle(store.Article{
				ItemID:      itemID,
				Title:       title,
				Digest:      str(doc, "excerpt"),
				PublishedAt: str(doc, "publishedAt"),
				TagsJSON:    tagsJSON(doc),
				BodyMD:      body,
				ContentHash: protocol.SHA256Hex([]byte(body)),
				SourceRev:   rev,
				UpdatedAt:   rev,
			}); err != nil {
				return res, err
			}
			res.Imported++
			if cover := coverOf(doc); cover != nil {
				if err := importCover(c, st, itemID, cover, title, rev); err != nil {
					// spec §14：封面缺失/失败不阻塞迁移
					fmt.Printf("migrate: 封面跳过 %s: %v\n", itemID, err)
				} else {
					res.Covers++
				}
			}
		}
		if pageCount > 0 && page >= pageCount {
			return res, nil
		}
		if pageCount == 0 && len(sums) < opt.PageSize {
			return res, nil
		}
	}
}

// importCover 下载封面并按内容寻址入库，登记为 type=cover 的 media_meta 条目。
func importCover(c *Client, st *store.Store, articleItemID string, cover map[string]any, title, rev string) error {
	raw := str(cover, "url", "URL")
	if raw == "" {
		return fmt.Errorf("coverImage 无 url")
	}
	mime, data, err := c.bytes(raw)
	if err != nil {
		return err
	}
	if len(data) == 0 {
		return fmt.Errorf("封面为空文件")
	}
	if mime == "" {
		mime = str(cover, "mime")
	}
	if mime == "" {
		mime = "application/octet-stream"
	}
	blob := protocol.BlobID(data)
	hash := protocol.SHA256Hex(data)
	coverID := "cover:" + strings.TrimPrefix(articleItemID, "article:")
	if err := st.PutBlob(blob, data, coverID, 0); err != nil {
		return err
	}
	return st.UpsertMediaItem(store.MediaItem{
		ItemID: coverID, Source: "article", Type: "cover", Title: title + " 封面",
		SourceRev: rev, ContentHash: hash, SQLiteTable: "media_meta",
		MIME: mime, Size: int64(len(data)), Duration: 0, ChunkSize: int64(len(data)),
		ChunkHashes: []string{hash}, UpdatedAt: rev,
	})
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "..."
}