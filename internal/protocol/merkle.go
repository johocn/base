package protocol

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"sort"
)

// MerkleRoot 按契约第 8 条计算 blob_id 集合的 Merkle 根（hex64）。
func MerkleRoot(blobIDs []string) (string, error) {
	ids, err := NormalizeBlobIDs(blobIDs)
	if err != nil {
		return "", err
	}
	if len(ids) == 0 {
		return SHA256Hex([]byte("merkle:empty")), nil
	}
	level := make([][]byte, len(ids))
	for i, id := range ids {
		level[i] = SHA256Sum([]byte("leaf:" + id))
	}
	for len(level) > 1 {
		next := make([][]byte, 0, (len(level)+1)/2)
		for i := 0; i < len(level); i += 2 {
			if i+1 == len(level) {
				next = append(next, level[i])
				continue
			}
			h := sha256.New()
			h.Write([]byte("node:"))
			h.Write(level[i])
			h.Write(level[i+1])
			next = append(next, h.Sum(nil))
		}
		level = next
	}
	return hex.EncodeToString(level[0]), nil
}

// NormalizeBlobIDs 校验并返回去重、按 ASCII 升序排序后的 blob_id 列表。
func NormalizeBlobIDs(blobIDs []string) ([]string, error) {
	set := make(map[string]struct{}, len(blobIDs))
	for _, id := range blobIDs {
		if !IsBlobID(id) {
			return nil, fmt.Errorf("invalid blob id %q", id)
		}
		set[id] = struct{}{}
	}
	out := make([]string, 0, len(set))
	for id := range set {
		out = append(out, id)
	}
	sort.Strings(out)
	return out, nil
}