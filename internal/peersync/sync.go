package peersync

import (
	"context"
	"fmt"
	"math/rand"
	"sync"
	"time"

	"github.com/johocn/base/internal/protocol"
	"github.com/johocn/base/internal/store"
)

// RoundResult 是一个 peer 的一轮结果（册子 §7.2 步骤 7 的日志字段）。
type RoundResult struct {
	Peer           string
	ContentVersion int64
	PackID         string
	Imported       bool
	Equal          bool
	Missing        int
	Extra          int
	Fetched        int
	BadFrames      int
	NoReplica      int
}

func (r RoundResult) String() string {
	return fmt.Sprintf("peer=%s version=%d pack=%s imported=%v equal=%v missing=%d extra=%d fetched=%d bad_frames=%d no_replica=%d",
		r.Peer, r.ContentVersion, r.PackID, r.Imported, r.Equal, r.Missing, r.Extra, r.Fetched, r.BadFrames, r.NoReplica)
}

// SyncPeer 对一个 peer 跑完整一轮：包级复制 → 比对 → 补齐 → 副本登记（册子 §7.2）。
// 顺序不可换：条目视图与块视图必须同一轮内收敛，故先拉包再比块集合。
func (c Config) SyncPeer(ctx context.Context, st *store.Store, p Peer, now int64) (RoundResult, error) {
	res := RoundResult{Peer: p.URL}

	version, err := st.ContentVersion()
	if err != nil {
		return res, err
	}
	outcome, err := c.ImportPack(ctx, st, p, version)
	if err != nil {
		return res, err
	}
	res.Imported = outcome.Status == "imported"
	res.PackID = outcome.PackID

	version, err = st.ContentVersion()
	if err != nil {
		return res, err
	}
	res.ContentVersion = version

	localIDs, err := st.ListAllBlobIDs()
	if err != nil {
		return res, err
	}
	localRoot, err := protocol.MerkleRoot(localIDs)
	if err != nil {
		return res, err
	}
	equal, err := c.PostSync(ctx, p, version, localRoot)
	if err != nil {
		return res, err
	}
	res.Equal = equal
	if equal {
		// 块集合相等即本 peer 结束（册子 §7.2 步骤 2），不拉 inventory、不登记副本
		res.NoReplica, _ = st.CountBlobsWithoutReplica()
		return res, nil
	}

	inv, err := c.FetchInventory(ctx, p, 0)
	if err != nil {
		return res, err
	}

	// 副本登记：拿到 inventory 后把 peer 声明的每个块 upsert（册子 §7.3）
	for _, b := range inv.Blobs {
		if err := st.UpsertBlobReplica(b.BlobID, p.URL, now); err != nil {
			return res, err
		}
	}

	local := make(map[string]struct{}, len(localIDs))
	for _, id := range localIDs {
		local[id] = struct{}{}
	}
	neighbor := make(map[string]struct{}, len(inv.Blobs))
	missing := []BlobSize{}
	for _, b := range inv.Blobs {
		neighbor[b.BlobID] = struct{}{}
		if _, ok := local[b.BlobID]; !ok {
			missing = append(missing, BlobSize{BlobID: b.BlobID, Size: b.Size})
		}
	}
	for _, id := range localIDs {
		if _, ok := neighbor[id]; !ok {
			res.Extra++ // 只记录不删（册子 §7.2 步骤 4、风险 5）
		}
	}
	res.Missing = len(missing)

	if len(missing) > 0 {
		// 归属来自 media_meta 的声明块序列：此刻这些块还没进 blobs 表，只有 media_meta 知道它们属于谁
		idx, err := st.MediaChunkIndex()
		if err != nil {
			return res, err
		}
		fr, err := c.FetchBlobs(ctx, p, missing, func(blobID string, data []byte) error {
			ref := idx[blobID]
			return st.PutBlob(blobID, data, ref.ItemID, ref.Seq)
		})
		if err != nil {
			return res, err
		}
		res.Fetched, res.BadFrames = fr.Fetched, fr.BadFrames
		for _, id := range fr.TooLarge {
			fmt.Printf("peersync: 块 %s 超过单请求字节上限，无法走 fetch（本期不做分片传输）\n", id)
		}
	}

	res.NoReplica, err = st.CountBlobsWithoutReplica()
	return res, err
}

// RunOnce 逐 peer 串行跑一轮（册子 §7.1：不并发打满带宽）。
// 单 peer 失败只记日志并继续下一个，不返回错误、不终止调度器。
func (c Config) RunOnce(ctx context.Context, st *store.Store, peers []Peer, logf func(string, ...any)) []RoundResult {
	now := time.Now().Unix()
	out := make([]RoundResult, 0, len(peers))
	for _, p := range peers {
		if ctx.Err() != nil {
			break
		}
		pctx, cancel := context.WithTimeout(ctx, 2*requestTimeout)
		res, err := c.SyncPeer(pctx, st, p, now)
		cancel()
		if err != nil {
			logf("peersync: %s 本轮失败: %v", p.URL, err)
			continue
		}
		logf("peersync: %s", res)
		out = append(out, res)
	}
	return out
}

// RunForever 启动反熵调度器：延迟随机 0–60 秒后首轮，此后每 interval 一轮；单轮不重入（风险 6）。
func (c Config) RunForever(ctx context.Context, st *store.Store, peers []Peer, interval time.Duration, logf func(string, ...any)) {
	if len(peers) == 0 || interval <= 0 {
		return
	}
	var mu sync.Mutex
	running := false
	run := func() {
		mu.Lock()
		if running {
			mu.Unlock()
			logf("peersync: 上一轮尚未结束，跳过本轮")
			return
		}
		running = true
		mu.Unlock()

		start := time.Now()
		c.RunOnce(ctx, st, peers, logf)
		logf("peersync: 本轮耗时 %s", time.Since(start).Round(time.Millisecond))

		mu.Lock()
		running = false
		mu.Unlock()
	}
	go func() {
		jitter := time.Duration(rand.Int63n(int64(60 * time.Second)))
		select {
		case <-ctx.Done():
			return
		case <-time.After(jitter):
		}
		run()
		t := time.NewTicker(interval)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				run()
			}
		}
	}()
}
