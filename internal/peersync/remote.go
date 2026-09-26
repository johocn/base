package peersync

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/johocn/base/internal/protocol"
)

// 本文件只做「把一个公开/内部接口包成一次调用」。
// 字段名与 internal/httpapi 的响应 DTO 一一对应（跨包不能复用未导出类型，故此处各留一份）。

// CatalogPage 对应 GET /v1/catalog 的一页。
type CatalogPage struct {
	PackID         string        `json:"pack_id"`
	ContentVersion int64         `json:"content_version"`
	Items          []CatalogItem `json:"items"`
	NextCursor     *string       `json:"next_cursor"`
}

// CatalogItem 是目录条目；反熵只用 item_id，其余留着便于诊断打印。
type CatalogItem struct {
	ItemID      string `json:"item_id"`
	Source      string `json:"source"`
	Type        string `json:"type"`
	Title       string `json:"title"`
	ContentHash string `json:"content_hash"`
	SourceRev   string `json:"source_rev"`
}

// InventoriedBlob 是 GET /v1/inventory 的一条块记录。
type InventoriedBlob struct {
	BlobID string `json:"blob_id"`
	Size   int64  `json:"size"`
}

// Inventory 是拉全量分页后的邻居块清单。
type Inventory struct {
	ContentVersion int64
	MerkleRoot     string
	Blobs          []InventoriedBlob
}

// BlobSize 是拉块切批需要的「块 id + 明文长度」。
type BlobSize struct {
	BlobID string
	Size   int64
}

// FetchResult 是一次（可能分批的）拉块结果。
type FetchResult struct {
	Requested int      // 请求过的块数
	Fetched   int      // 校验通过并交给 sink 的块数
	BadFrames int      // 帧头与内容哈希不符被丢弃的帧数
	TooLarge  []string // 单块 > FetchMaxBytes 无法走 fetch 的块（本期不做分片传输）
}

func endpoint(p Peer, path string) string {
	return strings.TrimRight(p.URL, "/") + path
}

func (c Config) get(ctx context.Context, p Peer, path string) ([]byte, error) {
	hc, err := c.client(p)
	if err != nil {
		return nil, err
	}
	res, err := c.do(ctx, hc, http.MethodGet, endpoint(p, path), nil)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	body, err := io.ReadAll(io.LimitReader(res.Body, 64<<20))
	if err != nil {
		return nil, err
	}
	if res.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("GET %s: HTTP %d %s", path, res.StatusCode, strings.TrimSpace(string(body)))
	}
	return body, nil
}

// FetchCatalog 拉目录首页（反熵只关心 pack_id 与水位，不需要翻页）。
func (c Config) FetchCatalog(ctx context.Context, p Peer, since int64) (CatalogPage, error) {
	path := "/v1/catalog"
	if since > 0 {
		path += "?since=" + strconv.FormatInt(since, 10)
	}
	body, err := c.get(ctx, p, path)
	if err != nil {
		return CatalogPage{}, err
	}
	var page CatalogPage
	if err := json.Unmarshal(body, &page); err != nil {
		return CatalogPage{}, fmt.Errorf("catalog 响应不是合法 JSON: %w", err)
	}
	return page, nil
}

// FetchManifest 拉签名 manifest，同时把原始字节一并返回（落位时要逐字节写盘）。
func (c Config) FetchManifest(ctx context.Context, p Peer, packID string) (protocol.Manifest, []byte, error) {
	body, err := c.get(ctx, p, "/v1/manifest/"+packID)
	if err != nil {
		return protocol.Manifest{}, nil, err
	}
	var m protocol.Manifest
	if err := json.Unmarshal(body, &m); err != nil {
		return protocol.Manifest{}, nil, fmt.Errorf("manifest 不是合法 JSON: %w", err)
	}
	return m, body, nil
}

// FetchPackTo 把 pack.sqlite 下载到 destDir/pack.sqlite。
// 先写 .tmp，读完整且字节数 > 0 才 rename 落位：避免半截包被当成产物（册子 §6.2 步骤 4）。
func (c Config) FetchPackTo(ctx context.Context, p Peer, packID, destDir string) (string, error) {
	hc, err := c.client(p)
	if err != nil {
		return "", err
	}
	res, err := c.do(ctx, hc, http.MethodGet, endpoint(p, "/v1/pack/"+packID), nil)
	if err != nil {
		return "", err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(io.LimitReader(res.Body, 4096))
		return "", fmt.Errorf("GET /v1/pack/%s: HTTP %d %s", packID, res.StatusCode, strings.TrimSpace(string(body)))
	}
	if err := os.MkdirAll(destDir, 0o755); err != nil {
		return "", err
	}
	final := filepath.Join(destDir, "pack.sqlite")
	tmp := final + ".tmp"
	f, err := os.Create(tmp)
	if err != nil {
		return "", err
	}
	n, err := io.Copy(f, res.Body)
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		_ = os.Remove(tmp)
		return "", fmt.Errorf("写 pack 临时文件: %w", err)
	}
	if n == 0 {
		_ = os.Remove(tmp)
		return "", fmt.Errorf("pack %s 为空文件", packID)
	}
	if err := os.Rename(tmp, final); err != nil {
		_ = os.Remove(tmp)
		return "", err
	}
	return final, nil
}

// PostSync 提交本地水位与块集合 merkle_root，返回对端判定是否相等（契约 §5.2）。
func (c Config) PostSync(ctx context.Context, p Peer, version int64, merkleRoot string) (bool, error) {
	hc, err := c.client(p)
	if err != nil {
		return false, err
	}
	body, err := json.Marshal(map[string]any{"content_version": version, "merkle_root": merkleRoot})
	if err != nil {
		return false, err
	}
	res, err := c.do(ctx, hc, http.MethodPost, endpoint(p, "/v1/sync"), bytes.NewReader(body))
	if err != nil {
		return false, err
	}
	defer res.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(res.Body, 1<<20))
	if err != nil {
		return false, err
	}
	if res.StatusCode != http.StatusOK {
		return false, fmt.Errorf("POST /v1/sync: HTTP %d %s", res.StatusCode, strings.TrimSpace(string(raw)))
	}
	var out struct {
		Equal bool `json:"equal"`
	}
	if err := json.Unmarshal(raw, &out); err != nil {
		return false, fmt.Errorf("sync 响应不是合法 JSON: %w", err)
	}
	return out.Equal, nil
}

// FetchInventory 翻页拉邻居的**全量**块清单（since=0：反熵要完整集合，不要增量）。
func (c Config) FetchInventory(ctx context.Context, p Peer, since int64) (Inventory, error) {
	inv := Inventory{Blobs: []InventoriedBlob{}}
	cursor := ""
	seenCursor := map[string]bool{}
	for {
		path := "/v1/inventory?limit=2000"
		if since > 0 {
			path += "&since=" + strconv.FormatInt(since, 10)
		}
		if cursor != "" {
			path += "&cursor=" + url.QueryEscape(cursor)
		}
		body, err := c.get(ctx, p, path)
		if err != nil {
			return inv, err
		}
		var page struct {
			ContentVersion int64             `json:"content_version"`
			MerkleRoot     string            `json:"merkle_root"`
			Blobs          []InventoriedBlob `json:"blobs"`
			NextCursor     *string           `json:"next_cursor"`
		}
		if err := json.Unmarshal(body, &page); err != nil {
			return inv, fmt.Errorf("inventory 响应不是合法 JSON: %w", err)
		}
		inv.ContentVersion = page.ContentVersion
		inv.MerkleRoot = page.MerkleRoot
		inv.Blobs = append(inv.Blobs, page.Blobs...)
		if page.NextCursor == nil || *page.NextCursor == "" {
			return inv, nil
		}
		if seenCursor[*page.NextCursor] {
			return inv, fmt.Errorf("inventory 分页未推进，拒绝死循环")
		}
		seenCursor[*page.NextCursor] = true
		cursor = *page.NextCursor
	}
}

// FetchBlobs 按「块数 ≤ FetchMaxBlobs 且累计 size ≤ protocol.FetchMaxBytes」切批拉块（修正 3）。
// 每帧先校验 hex(sha256(payload))[0:32] == 帧头 blob_id，不符即丢弃并计入 BadFrames（不落盘、不登记）。
// 对端没发的块不报错，只是拿不到（契约 §5.2：缺失块整帧跳过）。
func (c Config) FetchBlobs(ctx context.Context, p Peer, want []BlobSize, sink func(blobID string, data []byte) error) (FetchResult, error) {
	out := FetchResult{TooLarge: []string{}}
	maxBlobs := c.fetchMaxBlobs()
	for len(want) > 0 {
		batch := []BlobSize{}
		var bytesTotal int64
		for _, b := range want {
			if len(batch) >= maxBlobs {
				break
			}
			if b.Size > protocol.FetchMaxBytes {
				out.TooLarge = append(out.TooLarge, b.BlobID)
				continue
			}
			if len(batch) > 0 && bytesTotal+b.Size > protocol.FetchMaxBytes {
				break
			}
			batch = append(batch, b)
			bytesTotal += b.Size
		}
		// 把 TooLarge 从 want 中摘掉，避免死循环
		if len(out.TooLarge) > 0 {
			skip := map[string]bool{}
			for _, id := range out.TooLarge {
				skip[id] = true
			}
			kept := want[:0]
			for _, b := range want {
				if !skip[b.BlobID] {
					kept = append(kept, b)
				}
			}
			want = kept
		}
		if len(batch) == 0 {
			break
		}
		if err := c.fetchBatch(ctx, p, batch, &out, sink); err != nil {
			return out, err
		}
		// 摘掉本批
		sent := map[string]bool{}
		for _, b := range batch {
			sent[b.BlobID] = true
		}
		kept := want[:0]
		for _, b := range want {
			if !sent[b.BlobID] {
				kept = append(kept, b)
			}
		}
		want = kept
	}
	return out, nil
}

func (c Config) fetchBatch(ctx context.Context, p Peer, batch []BlobSize, out *FetchResult, sink func(string, []byte) error) error {
	hc, err := c.client(p)
	if err != nil {
		return err
	}
	ids := make([]string, 0, len(batch))
	for _, b := range batch {
		ids = append(ids, b.BlobID)
	}
	reqBody, err := json.Marshal(map[string]any{"blob_ids": ids})
	if err != nil {
		return err
	}
	out.Requested += len(ids)
	res, err := c.do(ctx, hc, http.MethodPost, endpoint(p, "/v1/fetch"), bytes.NewReader(reqBody))
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(io.LimitReader(res.Body, 4096))
		return fmt.Errorf("POST /v1/fetch: HTTP %d %s", res.StatusCode, strings.TrimSpace(string(body)))
	}
	if ct := res.Header.Get("Content-Type"); ct != protocol.BlobPackContentType {
		return fmt.Errorf("fetch Content-Type = %q, want %q", ct, protocol.BlobPackContentType)
	}
	for {
		blobID, payload, err := protocol.ReadBlobFrame(res.Body)
		if errors.Is(err, io.EOF) {
			return nil
		}
		if err != nil {
			return fmt.Errorf("读 fetch 帧: %w", err)
		}
		if protocol.BlobID(payload) != blobID {
			out.BadFrames++
			continue
		}
		if err := sink(blobID, payload); err != nil {
			return err
		}
		out.Fetched++
	}
}
