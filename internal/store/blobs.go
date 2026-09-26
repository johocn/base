package store

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strconv"

	"github.com/johocn/base/internal/protocol"
)

// ListBlobsPage 按 blob_id 升序（cursor 独占）分页返回块；next 为空表示没有下一页。
func (s *Store) ListBlobsPage(cursor string, limit int) ([]BlobRef, string, error) {
	if limit <= 0 {
		limit = 500
	}
	rows, err := s.db.Query(`SELECT blob_id,seq,size FROM blobs WHERE blob_id > ? ORDER BY blob_id ASC LIMIT ?`, cursor, limit)
	if err != nil {
		return nil, "", err
	}
	defer rows.Close()
	out := []BlobRef{}
	for rows.Next() {
		var b BlobRef
		if err := rows.Scan(&b.BlobID, &b.Seq, &b.Size); err != nil {
			return nil, "", err
		}
		out = append(out, b)
	}
	if err := rows.Err(); err != nil {
		return nil, "", err
	}
	next := ""
	if len(out) == limit {
		next = out[len(out)-1].BlobID
	}
	return out, next, nil
}

// ListAllBlobIDs 返回全部 blob_id（升序）。用于节点块集合的 merkle_root 与全量校验。
func (s *Store) ListAllBlobIDs() ([]string, error) {
	rows, err := s.db.Query(`SELECT blob_id FROM blobs ORDER BY blob_id ASC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []string{}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		out = append(out, id)
	}
	return out, rows.Err()
}

// ContentVersion 返回全局 content_version（无记录时为 0）。
// 这是唯一的水位读法：反熵会话与 inventory 都靠它判定「是否需要拉包」。
func (s *Store) ContentVersion() (int64, error) {
	raw := s.MetaString(metaContentVersion, "0")
	n, err := strconv.ParseInt(raw, 10, 64)
	if err != nil {
		return 0, fmt.Errorf("store: bad content_version %q", raw)
	}
	return n, nil
}

// DeleteBlobFile 删除块文件本体；文件不存在视为成功（幂等）。
func (s *Store) DeleteBlobFile(blobID string) error {
	if !protocol.IsBlobID(blobID) {
		return fmt.Errorf("store: invalid blob id %q", blobID)
	}
	if err := os.Remove(s.BlobPath(blobID)); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return nil
}

// DeleteBlob 删除块文件与 blobs 行。唯一允许的主动删除场景是 scrub 发现坏块（另见墓碑路径）。
func (s *Store) DeleteBlob(blobID string) error {
	if err := s.DeleteBlobFile(blobID); err != nil {
		return err
	}
	_, err := s.db.Exec(`DELETE FROM blobs WHERE blob_id=?`, blobID)
	return err
}

// MediaChunkIndex 返回 blob_id → 所属条目与 seq 的映射，来源是各 media_meta 的 chunk_hashes_json
// （数组下标即 seq）。补齐块时必须用它把块挂回条目，否则墓碑清不掉缓存节点上的块文件。
//
// 为什么不用 blobs 表：缓存节点解包入库时 media_meta 行已就位、而块尚未补齐，
// 此刻 blobs 里根本没有这些行，只有 media_meta 的「声明块序列」知道块的归属。
func (s *Store) MediaChunkIndex() (map[string]BlobRef, error) {
	rows, err := s.db.Query(`SELECT item_id,chunk_hashes_json FROM media_meta`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]BlobRef{}
	for rows.Next() {
		var itemID, chunkJSON string
		if err := rows.Scan(&itemID, &chunkJSON); err != nil {
			return nil, err
		}
		var hashes []string
		if err := json.Unmarshal([]byte(chunkJSON), &hashes); err != nil {
			return nil, fmt.Errorf("store: media_meta %s 的 chunk_hashes_json 非法: %w", itemID, err)
		}
		for seq, raw := range hashes {
			id := normalizeChunkID(raw)
			if !protocol.IsBlobID(id) {
				continue
			}
			if _, ok := out[id]; ok {
				continue // 同一字节可被多个条目引用：保留先到者的归属
			}
			out[id] = BlobRef{BlobID: id, Seq: seq, ItemID: itemID}
		}
	}
	return out, rows.Err()
}

// DeclaredChunks 返回条目在 media_meta 里声明的块序列：下标即 seq，长度 = ceil(size / chunk_size)。
//
// 为什么不能改用 blobs 表：块按 blob_id 天然去重（契约 §4.1），同一字节出现在多个位置时
// blobs 只留一行，长度会小于声明块数——而 manifest.entries[].chunks[] 必须与
// chunk_hashes_json 逐位一致（册子 §4.1、验收 3），故导出侧的唯一真源是声明块序列。
func (s *Store) DeclaredChunks(itemID string) ([]BlobRef, error) {
	_, size, _, chunkSize, hashes, ok, err := s.GetMediaMeta(itemID)
	if err != nil {
		return nil, err
	}
	if !ok {
		return nil, fmt.Errorf("store: media_meta 缺少条目 %s", itemID)
	}
	out := make([]BlobRef, 0, len(hashes))
	for seq, raw := range hashes {
		id := normalizeChunkID(raw)
		if !protocol.IsBlobID(id) {
			return nil, fmt.Errorf("store: media_meta %s 第 %d 块的 id %q 不是 blob_id", itemID, seq, raw)
		}
		sz := chunkSize
		if rest := size - int64(seq)*chunkSize; rest > 0 && rest < sz {
			sz = rest
		}
		out = append(out, BlobRef{BlobID: id, Seq: seq, Size: sz})
	}
	return out, nil
}

// normalizeChunkID 把 chunk_hashes_json 里声明的块 id 归一为 32 字符 blob_id。
// 存量封面路径（tools/migrate/strapi.go 的 importCover）写的是 sha256 的 64 字符全量，
// 其前 32 字符就是真正的 blob_id；视频导入路径（internal/importer/video.go）写的就是 blob_id 本身。
// 只归一，不改存量数据。
func normalizeChunkID(s string) string {
	if len(s) == 64 {
		return s[:32]
	}
	return s
}
