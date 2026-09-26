package store

import (
	"errors"
	"os"

	"github.com/johocn/base/internal/protocol"
)

// BadBlob 是一个校验失败的块。
type BadBlob struct {
	BlobID string
	Reason string // hash_mismatch | missing
}

// VerifyBlobs 逐块重算哈希并清理坏块；blobIDs 为空表示全量。
// 语义（契约 §8）：
//   - 文件不存在但 blobs 行存在 → 删行，记 missing；
//   - 文件存在但重算哈希与 id 不符 → 删块文件与行，记 hash_mismatch；
//   - 只修本地：从邻居补齐由 internal/peersync 负责（本包不发出站请求）。
//
// 重算走 GetBlobBytes（内部透明解密）：L4a′ 只改磁盘表示，逻辑字节仍是明文/密文原文。
func (s *Store) VerifyBlobs(blobIDs []string) (int, []BadBlob, error) {
	ids := blobIDs
	if len(ids) == 0 {
		all, err := s.ListAllBlobIDs()
		if err != nil {
			return 0, nil, err
		}
		ids = all
	}
	checked := 0
	bad := []BadBlob{}
	for _, id := range ids {
		if !protocol.IsBlobID(id) {
			continue
		}
		if _, err := os.Stat(s.BlobPath(id)); err != nil {
			if !errors.Is(err, os.ErrNotExist) {
				return checked, bad, err
			}
			if err := s.deleteBlobRow(id); err != nil {
				return checked, bad, err
			}
			bad = append(bad, BadBlob{BlobID: id, Reason: "missing"})
			continue
		}
		checked++
		data, err := s.GetBlobBytes(id)
		if err != nil {
			// 解不开（密文被破坏）：同样按坏块处理
			if err := s.DeleteBlob(id); err != nil {
				return checked, bad, err
			}
			bad = append(bad, BadBlob{BlobID: id, Reason: "hash_mismatch"})
			continue
		}
		if got := protocol.BlobID(data); got != id {
			if err := s.DeleteBlob(id); err != nil {
				return checked, bad, err
			}
			bad = append(bad, BadBlob{BlobID: id, Reason: "hash_mismatch"})
		}
	}
	return checked, bad, nil
}

func (s *Store) deleteBlobRow(blobID string) error {
	_, err := s.db.Exec(`DELETE FROM blobs WHERE blob_id=?`, blobID)
	return err
}
