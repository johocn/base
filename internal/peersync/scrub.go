package peersync

import (
	"context"
	"fmt"
	"sync"
	"time"

	"github.com/johocn/base/internal/store"
)

// scrubFirstDelay 是 scrub 首轮延迟：启动即全量哈希会与冷启动抢 IO（契约 §8）。
const scrubFirstDelay = 10 * time.Minute

// ScrubResult 是一次 scrub 的结果（契约 §8）。
type ScrubResult struct {
	Checked    int
	Repaired   int      // 从邻居拉回并通过逐块哈希校验的块数
	Dropped    int      // 本地坏块被清掉的块数（= store.VerifyBlobs 的 bad 数）
	Unrepaired []string // 所有已知 peer 都拿不到的块：保留告警，不静默、不删别的数据
}

func (r ScrubResult) String() string {
	return fmt.Sprintf("scrub checked=%d repaired=%d dropped=%d unrepaired=%d",
		r.Checked, r.Repaired, r.Dropped, len(r.Unrepaired))
}

// ScrubOnce 对本地做一次校验修复，并按 blob_replicas 登记的邻居补齐（契约 §8）。
// 只修本地：不做跨节点编排（每个节点各扫各的）。
//
// peers 只用于给 blob_replicas 里的裸 url 补上 TLS 指纹；缺项按裸 url 试（局域网调试）。
func (c Config) ScrubOnce(ctx context.Context, st *store.Store, peers []Peer, blobIDs []string) (ScrubResult, error) {
	res := ScrubResult{Unrepaired: []string{}}
	checked, bad, err := st.VerifyBlobs(blobIDs)
	if err != nil {
		return res, err
	}
	res.Checked, res.Dropped = checked, len(bad)
	if len(bad) == 0 {
		return res, nil
	}

	byURL := make(map[string]Peer, len(peers))
	for _, p := range peers {
		byURL[p.URL] = p
	}

	// 归属索引：坏块此刻已被清掉，blobs 表里没有它的归属，只有 media_meta 的声明块序列知道
	idx, err := st.MediaChunkIndex()
	if err != nil {
		return res, err
	}

	for _, b := range bad {
		urls, err := st.ReplicaPeers(b.BlobID)
		if err != nil {
			return res, err
		}
		repaired := false
		for _, url := range urls {
			if ctx.Err() != nil {
				return res, ctx.Err()
			}
			p, known := byURL[url]
			if !known {
				p = Peer{URL: url}
			}
			fr, err := c.FetchBlobs(ctx, p, []BlobSize{{BlobID: b.BlobID}}, func(id string, data []byte) error {
				ref := idx[id]
				return st.PutBlob(id, data, ref.ItemID, ref.Seq)
			})
			if err != nil {
				fmt.Printf("peersync: scrub 从 %s 取 %s 出错: %v\n", url, b.BlobID, err)
				continue
			}
			if fr.Fetched == 1 {
				res.Repaired++
				repaired = true
				break
			}
			fmt.Printf("peersync: scrub 从 %s 未取到 %s（too_large=%v）\n", url, b.BlobID, fr.TooLarge)
		}
		if !repaired {
			res.Unrepaired = append(res.Unrepaired, b.BlobID)
		}
	}
	return res, nil
}

// ScrubForever 启动 scrub 调度：延迟 10 分钟首轮，此后每 interval 一轮（契约 §8）。
// 与反熵同一套「不重入」语义：上一轮未结束则跳过下一拍。
func (c Config) ScrubForever(ctx context.Context, st *store.Store, peers []Peer, interval time.Duration, logf func(string, ...any)) {
	if interval <= 0 {
		return
	}
	var mu sync.Mutex
	running := false
	run := func() {
		mu.Lock()
		if running {
			mu.Unlock()
			logf("peersync: 上一轮 scrub 尚未结束，跳过本轮")
			return
		}
		running = true
		mu.Unlock()

		start := time.Now()
		res, err := c.ScrubOnce(ctx, st, peers, nil)
		if err != nil {
			logf("peersync: scrub 失败: %v", err)
		} else {
			logf("peersync: %s（耗时 %s）", res, time.Since(start).Round(time.Millisecond))
			for _, id := range res.Unrepaired {
				logf("peersync: **告警** 块 %s 所有已知 peer 都拿不到，保留在未修复列表（不删任何其他数据）", id)
			}
		}

		mu.Lock()
		running = false
		mu.Unlock()
	}
	go func() {
		timer := time.NewTimer(scrubFirstDelay)
		defer timer.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-timer.C:
				run()
				timer.Reset(interval)
			}
		}
	}()
}
