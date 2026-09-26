package store

import (
	"fmt"

	"github.com/johocn/base/internal/protocol"
)

// UpsertBlobReplica 登记「peer 声明持有该块」，seen_at 刷新为当前轮次时间。
func (s *Store) UpsertBlobReplica(blobID, peer string, seenAt int64) error {
	if !protocol.IsBlobID(blobID) {
		return fmt.Errorf("store: invalid blob id %q", blobID)
	}
	_, err := s.db.Exec(`INSERT INTO blob_replicas(blob_id,peer,seen_at) VALUES(?,?,?)
		ON CONFLICT(blob_id,peer) DO UPDATE SET seen_at=excluded.seen_at`, blobID, peer, seenAt)
	return err
}

// ReplicaPeers 返回声明持有该块的 peer 列表（升序）。scrub 用它决定去哪儿补齐。
func (s *Store) ReplicaPeers(blobID string) ([]string, error) {
	rows, err := s.db.Query(`SELECT peer FROM blob_replicas WHERE blob_id=? ORDER BY peer ASC`, blobID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []string{}
	for rows.Next() {
		var p string
		if err := rows.Scan(&p); err != nil {
			return nil, err
		}
		out = append(out, p)
	}
	return out, rows.Err()
}

// CountBlobsWithoutReplica 返回「本地持有但没有任何 peer 声明持有」的块数。
// 副本数定义 = 本地持有(1) + blob_replicas 行数；本地持有恒为 1（按 blobs 表统计），故 <2 ⇔ 无 peer 行。
func (s *Store) CountBlobsWithoutReplica() (int, error) {
	var n int
	err := s.db.QueryRow(`SELECT COUNT(*) FROM blobs b
		WHERE NOT EXISTS(SELECT 1 FROM blob_replicas r WHERE r.blob_id=b.blob_id)`).Scan(&n)
	return n, err
}
