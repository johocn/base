package importer

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	"github.com/johocn/base/internal/protocol"
	"github.com/johocn/base/internal/store"
)

// ChunkSize 是视频分块的定长粒度（总纲 §6.3）：1048576 字节，最后一块可短。
const ChunkSize = 1 << 20

// VideoOptions 是视频导入参数。
type VideoOptions struct {
	Path     string // 源文件路径
	Slug     string // 条目 slug，item_id = lesson:<slug>
	Title    string // 空则取文件名（不含扩展名）
	MIME     string // 空则按扩展名推断
	Duration int64  // 秒；0 = 未知
}

// VideoResult 是导入结果。
type VideoResult struct {
	ItemID      string
	Chunks      int
	TotalSize   int64
	Written     int // 本次真正写盘的块数（已存在的同字节块跳过写盘）
	ContentHash string
}

// ImportVideo 把一个文件按定长 1 MiB 分块入库。
// 条目级 content_hash = hex(sha256(按 seq 升序拼接的每个块的 blob_id))：只依赖块 id 序列，可复算。
// 失败语义：任一块写盘失败即报错，已写入的块与登记保留（块是内容寻址的，重跑即续上），不回滚。
func ImportVideo(st *store.Store, opt VideoOptions) (VideoResult, error) {
	if strings.TrimSpace(opt.Path) == "" || strings.TrimSpace(opt.Slug) == "" {
		return VideoResult{}, fmt.Errorf("importer: -file 与 -slug 都是必填")
	}
	f, err := os.Open(opt.Path)
	if err != nil {
		return VideoResult{}, fmt.Errorf("importer: 打开视频: %w", err)
	}
	defer f.Close()
	fi, err := f.Stat()
	if err != nil {
		return VideoResult{}, fmt.Errorf("importer: stat 视频: %w", err)
	}
	if fi.Size() == 0 {
		return VideoResult{}, fmt.Errorf("importer: 视频为空（0 字节），分块后没有任何块文件，无法导出")
	}

	itemID := "lesson:" + opt.Slug
	res := VideoResult{ItemID: itemID, TotalSize: fi.Size()}
	hashes := []string{}
	buf := make([]byte, ChunkSize)
	for seq := 0; ; seq++ {
		n, err := io.ReadFull(f, buf)
		if n > 0 {
			data := buf[:n]
			id := protocol.BlobID(data)
			hashes = append(hashes, id)
			res.Chunks++
			ok, _, herr := st.HasBlob(id)
			if herr != nil {
				return res, fmt.Errorf("importer: 探测块 %s: %w", id, herr)
			}
			if !ok {
				if perr := st.PutBlob(id, data, itemID, seq); perr != nil {
					return res, fmt.Errorf("importer: 写块 %s(seq=%d): %w", id, seq, perr)
				}
				res.Written++
			}
		}
		if err == io.EOF || err == io.ErrUnexpectedEOF {
			break
		}
		if err != nil {
			return res, fmt.Errorf("importer: 读视频: %w", err)
		}
	}

	sum := sha256.Sum256([]byte(strings.Join(hashes, "")))
	res.ContentHash = hex.EncodeToString(sum[:])

	title := opt.Title
	if title == "" {
		title = strings.TrimSuffix(filepath.Base(opt.Path), filepath.Ext(opt.Path))
	}
	mime := opt.MIME
	if mime == "" {
		mime = guessVideoMIME(opt.Path)
	}
	if err := st.UpsertMediaItem(store.MediaItem{
		ItemID: itemID, Source: "lesson", Type: "video", Title: title,
		SourceRev:   res.ContentHash[:16],
		ContentHash: res.ContentHash,
		SQLiteTable: "media_meta",
		MIME:        mime,
		Size:        fi.Size(),
		Duration:    opt.Duration,
		ChunkSize:   ChunkSize,
		ChunkHashes: hashes,
	}); err != nil {
		return res, fmt.Errorf("importer: 登记条目: %w", err)
	}
	return res, nil
}

func guessVideoMIME(path string) string {
	switch strings.ToLower(filepath.Ext(path)) {
	case ".mp4", ".m4v":
		return "video/mp4"
	case ".webm":
		return "video/webm"
	case ".mkv":
		return "video/x-matroska"
	case ".mov":
		return "video/quicktime"
	default:
		return "application/octet-stream"
	}
}
