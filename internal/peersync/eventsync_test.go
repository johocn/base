package peersync

import (
	"context"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/johocn/base/internal/protocol"
	"github.com/johocn/base/internal/store"
)

// commentActor 是种子评论的写入身份（本测试不验签，只要求形状合法）。
const commentActor = "a1b2c3d4e5f60718293a4b5c6d7e8f90"

func eventIDHex(i int) string { return fmt.Sprintf("%032x", i) }

// seedComment 在源节点直接落一条评论（正文块 + 事件行 + 投影列），
// 返回 payload_cid。写路径的验签由 internal/httpapi 覆盖，这里只造既成事实。
func seedComment(t *testing.T, st *store.Store, eventID, target, text, replyTo string) string {
	t.Helper()
	cid := protocol.BlobID([]byte(text))
	if err := st.PutBlob(cid, []byte(text), "comment:"+eventID, 0); err != nil {
		t.Fatalf("PutBlob: %v", err)
	}
	body := `{"target_id":"` + target + `","payload_cid":"` + cid + `"`
	if replyTo != "" {
		body += `,"reply_to":"` + replyTo + `"`
	}
	body += `,"sig":"` + strings.Repeat("ab", 64) + `"}`
	if err := st.PutEvent(store.Event{
		EventID: eventID, ID: commentActor, Type: "comment.v1", BodyJSON: body,
		CreatedAt: time.Now().UnixMilli(), TargetID: target, PayloadCID: cid, ReplyTo: replyTo,
	}); err != nil {
		t.Fatalf("PutEvent: %v", err)
	}
	return cid
}

// 验收 8：一轮反熵后缓存节点能读到该条评论，并取到正文明文。
// 这里同时守住「评论正文块的归属来自事件」——若反熵只认 media_meta，本轮取不到正文。
func TestSyncEventsPropagatesCommentBodyInOneRound(t *testing.T) {
	src, url, tr, pub := newSourceNode(t)
	text := "跨节点评论正文"
	cid := seedComment(t, src, eventIDHex(1), "article/a", text, "")

	dst := openTemp(t)
	cfg := Config{TransportFor: tr, IssuerPubKeys: map[string]string{srcIssuer: pub}}
	cfg.RunOnce(context.Background(), dst, []Peer{{URL: url}}, func(string, ...any) {})

	rows, err := dst.ListComments("article/a", 0, "", 10)
	if err != nil || len(rows) != 1 {
		t.Fatalf("缓存节点应可见该条评论 err=%v rows=%+v", err, rows)
	}
	if rows[0].EventID != eventIDHex(1) || rows[0].PayloadCID != cid ||
		rows[0].TargetID != "article/a" || rows[0].Actor != commentActor {
		t.Fatalf("投影列未随事件带过来: %+v", rows[0])
	}
	ok, size, err := dst.HasBlob(cid)
	if err != nil || !ok {
		t.Fatalf("正文块应已补齐 ok=%v err=%v", ok, err)
	}
	if size != int64(len(text)) {
		t.Fatalf("正文块明文长度 = %d, want %d", size, len(text))
	}
	data, err := dst.GetBlobBytes(cid)
	if err != nil || string(data) != text {
		t.Fatalf("取回正文 = %q err=%v", data, err)
	}

	// 第二轮：游标已推进，事件不重复；正文块已在本地的保留原归属
	ev, err := cfg.SyncEvents(context.Background(), dst, Peer{URL: url})
	if err != nil || ev.Events != 0 || ev.Tombstones != 0 {
		t.Fatalf("第二轮应无事可做 ev=%+v err=%v", ev, err)
	}
	evs, err := dst.ListEvents(commentActor, 10)
	if err != nil || len(evs) != 1 {
		t.Fatalf("重复拉取不得产生第二行 err=%v evs=%+v", err, evs)
	}
}

// 验收 11/12：墓碑跨节点收敛——缓存节点收到墓碑即删正文，且源节点仍持块也不复活。
func TestSyncEventsTombstoneDeletesBodyAndNeverResurrects(t *testing.T) {
	src, url, tr, pub := newSourceNode(t)
	cid := seedComment(t, src, eventIDHex(1), "article/a", "将被撤回的正文", eventIDHex(9))

	dst := openTemp(t)
	cfg := Config{TransportFor: tr, IssuerPubKeys: map[string]string{srcIssuer: pub}}
	cfg.RunOnce(context.Background(), dst, []Peer{{URL: url}}, func(string, ...any) {})
	if ok, _, _ := dst.HasBlob(cid); !ok {
		t.Fatal("前置条件：缓存节点应先拿到正文块")
	}

	// 源节点审核删：写墓碑，**故意不删自己的块**——模拟对端尚未收到墓碑仍持块
	if err := src.PutCommentTombstone(store.CommentTombstone{
		EventID: eventIDHex(1), PayloadCID: cid, Reason: "违规", At: time.Now().UnixMilli(),
	}); err != nil {
		t.Fatalf("PutCommentTombstone: %v", err)
	}

	cfg.RunOnce(context.Background(), dst, []Peer{{URL: url}}, func(string, ...any) {})
	if rows, err := dst.ListComments("", 0, "", 10); err != nil || len(rows) != 0 {
		t.Fatalf("墓碑到达后列表不应返回该条 err=%v rows=%+v", err, rows)
	}
	if ok, _, _ := dst.HasBlob(cid); ok {
		t.Fatal("墓碑到达后缓存节点应删掉正文块")
	}

	// 源节点仍持块：再跑两轮也不得把已撤回的块拉回来（护栏 2）
	if ok, _, _ := src.HasBlob(cid); !ok {
		t.Fatal("前置条件：源节点应仍持有该块")
	}
	for i := 0; i < 2; i++ {
		cfg.RunOnce(context.Background(), dst, []Peer{{URL: url}}, func(string, ...any) {})
		if ok, _, _ := dst.HasBlob(cid); ok {
			t.Fatalf("第 %d 轮后已撤回的块被拉回", i+1)
		}
	}
	if rows, _ := dst.ListComments("", 0, "", 10); len(rows) != 0 {
		t.Fatalf("墓碑后列表仍返回该条: %+v", rows)
	}
}
