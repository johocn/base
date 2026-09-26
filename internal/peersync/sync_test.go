package peersync

import (
	"context"
	"testing"

	"github.com/johocn/base/internal/protocol"
	"github.com/johocn/base/internal/store"
)

// nodePair 起源节点 + 缓存节点；返回源 store、缓存 store、源侧 URL、缓存侧 Config。
func nodePair(t *testing.T) (*store.Store, *store.Store, string, Config) {
	t.Helper()
	src, url, tr, pub := newSourceNode(t)
	seedSource(t, src)
	dst := openTemp(t)
	return src, dst, url, Config{TransportFor: tr, IssuerPubKeys: map[string]string{srcIssuer: pub}}
}

func TestSyncPeerConvergesBlobSetsAndRegistersReplicas(t *testing.T) {
	src, dst, url, cfg := nodePair(t)

	res, err := cfg.SyncPeer(context.Background(), dst, Peer{URL: url}, 1)
	if err != nil {
		t.Fatalf("SyncPeer: %v", err)
	}
	if !res.Imported || res.Equal {
		t.Fatalf("首轮应「导入包 + 集合不等」，got %+v", res)
	}
	// 源节点 1 个封面块 → 缓存节点应补齐 1 块
	if res.Missing != 1 || res.Fetched != 1 || res.BadFrames != 0 {
		t.Fatalf("补齐统计 = %+v", res)
	}
	if res.NoReplica != 0 {
		t.Fatalf("副本登记后「无副本块数」应为 0，got %d", res.NoReplica)
	}

	// 第二轮：集合已一致 → equal，不再拉 inventory
	res2, err := cfg.SyncPeer(context.Background(), dst, Peer{URL: url}, 2)
	if err != nil {
		t.Fatalf("SyncPeer 2: %v", err)
	}
	if res2.Imported || !res2.Equal {
		t.Fatalf("第二轮应为 equal，got %+v", res2)
	}

	// 两侧块集合完全一致
	srcIDs, _ := src.ListAllBlobIDs()
	dstIDs, _ := dst.ListAllBlobIDs()
	if len(srcIDs) != len(dstIDs) {
		t.Fatalf("块集合不一致: src=%v dst=%v", srcIDs, dstIDs)
	}
	for i := range srcIDs {
		if srcIDs[i] != dstIDs[i] {
			t.Fatalf("块集合不一致: src=%v dst=%v", srcIDs, dstIDs)
		}
	}
	// 块文件内容哈希正确（补齐时逐块校验过）
	for _, id := range dstIDs {
		data, err := dst.GetBlobBytes(id)
		if err != nil {
			t.Fatalf("读补齐块 %s: %v", id, err)
		}
		if protocol.BlobID(data) != id {
			t.Fatalf("补齐块 %s 哈希不符", id)
		}
	}
	// 副本登记：把块挂回了 cover:aaa（墓碑才删得掉块文件）
	if err := dst.AddTombstone("cover:aaa", 9); err != nil {
		t.Fatalf("AddTombstone: %v", err)
	}
	refs, err := dst.ListBlobsForItem("cover:aaa")
	if err != nil {
		t.Fatalf("ListBlobsForItem: %v", err)
	}
	if len(refs) != 1 {
		t.Fatalf("块应挂在 cover:aaa 上，got %+v", refs)
	}
}

func TestRunOnceKeepsGoingAfterPeerFailure(t *testing.T) {
	_, dst, url, cfg := nodePair(t)
	logs := []string{}
	results := cfg.RunOnce(context.Background(), dst, []Peer{
		{URL: "https://未登记的邻居.test"}, // 必然失败
		{URL: url},
	}, func(f string, a ...any) { logs = append(logs, f) })
	if len(results) != 1 {
		t.Fatalf("失败 peer 应被跳过、成功的仍返回，got %d 个结果", len(results))
	}
	if len(logs) == 0 {
		t.Fatal("必须把失败写进日志")
	}
}
