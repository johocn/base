package peersync

import (
	"context"
	"os"
	"testing"

	"github.com/johocn/base/internal/protocol"
)

// 坏块能从 blob_replicas 登记的邻居补齐（契约 §8 第 4 步）。
func TestScrubOnceRepairsFromReplica(t *testing.T) {
	_, dst, url, cfg := nodePair(t)
	if _, err := cfg.SyncPeer(context.Background(), dst, Peer{URL: url}, 1); err != nil {
		t.Fatalf("SyncPeer: %v", err)
	}
	ids, err := dst.ListAllBlobIDs()
	if err != nil || len(ids) != 1 {
		t.Fatalf("同步后应有 1 块：ids=%v err=%v", ids, err)
	}
	id := ids[0]

	// 把块文件改坏（blobs 行仍在）→ scrub 报 hash_mismatch 并从 url 补齐
	if err := os.WriteFile(dst.BlobPath(id), []byte("tampered"), 0o600); err != nil {
		t.Fatalf("覆写块文件: %v", err)
	}

	res, err := cfg.ScrubOnce(context.Background(), dst, []Peer{{URL: url}}, nil)
	if err != nil {
		t.Fatalf("ScrubOnce: %v", err)
	}
	if res.Checked != 1 || res.Dropped != 1 || res.Repaired != 1 || len(res.Unrepaired) != 0 {
		t.Fatalf("scrub = %+v", res)
	}
	data, err := dst.GetBlobBytes(id)
	if err != nil {
		t.Fatalf("补齐后读取: %v", err)
	}
	if protocol.BlobID(data) != id {
		t.Fatalf("补齐回来的块哈希不符")
	}
}

// 没有任何邻居声明持有 → 记 Unrepaired，不静默、不错删别的数据。
func TestScrubOnceReportsUnrepairedWithoutReplica(t *testing.T) {
	st := openTemp(t)
	body := []byte("孤儿块")
	id := protocol.BlobID(body)
	if err := st.PutBlob(id, body, "lesson:x", 0); err != nil {
		t.Fatalf("PutBlob: %v", err)
	}
	if err := os.Remove(st.BlobPath(id)); err != nil {
		t.Fatalf("删块文件: %v", err)
	}

	res, err := Config{}.ScrubOnce(context.Background(), st, nil, nil)
	if err != nil {
		t.Fatalf("ScrubOnce: %v", err)
	}
	if res.Dropped != 1 || res.Repaired != 0 || len(res.Unrepaired) != 1 || res.Unrepaired[0] != id {
		t.Fatalf("scrub = %+v", res)
	}
}
