package peersync

import (
	"context"
	"encoding/json"
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

// 验收 4：一轮反熵后缓存节点能读到小组名单与发言索引。
// 对端事件只有 body_json，target_id/payload_cid 必须在本地重建（F5）；roster 事件还要落
// groups 投影（否则接收节点 GET /v1/group/{id} 直接 404），密文块归属也要认得（F6）。
func TestGroupEventProjectionRestoredOnPeer(t *testing.T) {
	src, url, tr, pub := newSourceNode(t)

	const (
		groupID  = "00000000000000a1"
		otherID  = "0f1e2d3c4b5a69788796a5b4c3d2e1f0"
		msgEvent = "00000000000000000000000000000007"
		rsEvent  = "00000000000000000000000000000008"
	)
	cipher := []byte("小组密文")
	cid := protocol.BlobID(cipher)
	if err := src.PutBlob(cid, cipher, "group:"+msgEvent, 0); err != nil {
		t.Fatalf("PutBlob: %v", err)
	}
	msgBody := `{"action":"msg","epoch":1,"group_id":"` + groupID + `","payload_cid":"` + cid + `"}`
	if err := src.PutEvent(store.Event{
		EventID: msgEvent, ID: commentActor, Type: "group.v1", BodyJSON: msgBody,
		CreatedAt: time.Now().UnixMilli(), TargetID: "group/" + groupID, PayloadCID: cid,
	}); err != nil {
		t.Fatalf("PutEvent msg: %v", err)
	}
	rosterBody := `{"action":"roster","epoch":2,"group_id":"` + groupID +
		`","member_ids":["` + commentActor + `","` + otherID + `"],"name":"读书会"}`
	if err := src.PutEvent(store.Event{
		EventID: rsEvent, ID: commentActor, Type: "group.v1", BodyJSON: rosterBody,
		CreatedAt: time.Now().UnixMilli() + 1, TargetID: "group/" + groupID,
	}); err != nil {
		t.Fatalf("PutEvent roster: %v", err)
	}

	dst := openTemp(t)
	cfg := Config{TransportFor: tr, IssuerPubKeys: map[string]string{srcIssuer: pub}}
	ev, err := cfg.SyncEvents(context.Background(), dst, Peer{URL: url})
	if err != nil || ev.Events != 2 {
		t.Fatalf("反熵一轮应搬来 2 条事件 ev=%+v err=%v", ev, err)
	}

	// ① roster 落进本地 groups 投影（接收节点读接口不再 404）
	g, ok, err := dst.GetGroup(groupID)
	if err != nil || !ok {
		t.Fatalf("缓存节点应有 groups 投影 ok=%v err=%v", ok, err)
	}
	if g.Epoch != 2 || g.CreatorID != commentActor || g.EventID != rsEvent {
		t.Fatalf("groups 投影不符: %+v", g)
	}
	var members []string
	if err := json.Unmarshal([]byte(g.MemberIDsJSON), &members); err != nil ||
		len(members) != 2 || members[0] != commentActor || members[1] != otherID {
		t.Fatalf("member_ids_json 不符: %q err=%v", g.MemberIDsJSON, err)
	}

	// ② 发言事件的 target_id/payload_cid 已从 body_json 还原
	rows, err := dst.ListGroupEvents(groupID, 0, "", 10)
	if err != nil || len(rows) != 2 {
		t.Fatalf("应读到 2 条 group.v1 事件 rows=%+v err=%v", rows, err)
	}
	var msgRow *store.Event
	for i := range rows {
		if rows[i].EventID == msgEvent {
			msgRow = &rows[i]
		}
	}
	if msgRow == nil || msgRow.TargetID != "group/"+groupID || msgRow.PayloadCID != cid {
		t.Fatalf("发言投影列未还原: %+v", msgRow)
	}

	// ③ 块归属索引认得该密文（EventBlobIndex 纳入 group.v1 后才成立）
	idx, err := dst.EventBlobIndex()
	if err != nil {
		t.Fatalf("EventBlobIndex: %v", err)
	}
	if ref, ok := idx[cid]; !ok || ref.ItemID != "group:"+msgEvent {
		t.Fatalf("块归属不符: %+v ok=%v", ref, ok)
	}
}

// 验收 4：一轮反熵后缓存节点能读到私信索引与密文块归属。
// 对端事件只有 body_json，target_id / payload_cid 必须在本地重建（F5′）；
// 密文块归属也要认得 dm.v1（F6′），否则缓存节点拉不下块、scrub 还会当孤儿删掉。
func TestDMEventProjectionRestoredOnPeer(t *testing.T) {
	src, url, tr, pub := newSourceNode(t)

	const (
		peerID   = "00000000000000a1aaaaaaaaaaaaaaaa"
		msgEvent = "00000000000000000000000000000009"
	)
	cipher := []byte("私信密文")
	cid := protocol.BlobID(cipher)
	if err := src.PutBlob(cid, cipher, "dm:"+msgEvent, 0); err != nil {
		t.Fatalf("PutBlob: %v", err)
	}
	body := `{"payload_cid":"` + cid + `","to":"` + peerID + `"}`
	if err := src.PutEvent(store.Event{
		EventID: msgEvent, ID: commentActor, Type: "dm.v1", BodyJSON: body,
		CreatedAt: time.Now().UnixMilli(), TargetID: "dm/" + peerID, PayloadCID: cid,
	}); err != nil {
		t.Fatalf("PutEvent dm: %v", err)
	}

	dst := openTemp(t)
	cfg := Config{TransportFor: tr, IssuerPubKeys: map[string]string{srcIssuer: pub}}
	ev, err := cfg.SyncEvents(context.Background(), dst, Peer{URL: url})
	if err != nil || ev.Events != 1 {
		t.Fatalf("反熵一轮应搬来 1 条事件 ev=%+v err=%v", ev, err)
	}

	// ① 索引列从 body_json 还原（否则缓存节点 GET /v1/dm/{peer} 查不到）
	rows, err := dst.ListDMEvents(peerID, 0, "", 10)
	if err != nil || len(rows) != 1 {
		t.Fatalf("应读到 1 条 dm.v1 事件 rows=%+v err=%v", rows, err)
	}
	if rows[0].TargetID != "dm/"+peerID || rows[0].PayloadCID != cid {
		t.Fatalf("私信投影列未还原: %+v", rows[0])
	}

	// ② 块归属索引认得该密文（EventBlobIndex 纳入 dm.v1 后才成立）
	idx, err := dst.EventBlobIndex()
	if err != nil {
		t.Fatalf("EventBlobIndex: %v", err)
	}
	if ref, ok := idx[cid]; !ok || ref.ItemID != "dm:"+msgEvent {
		t.Fatalf("块归属不符: %+v ok=%v", ref, ok)
	}
}

// v2 三列跨节点还原（AC 10 的前置）：roster_rev / encrypted / key_envelopes 必须无损搬进本地投影。
// 信封尤其要按**包装对象**落库——读接口用 struct{Envelopes []json.RawMessage} 解包，
// 裸数组会 Unmarshal 失败并被静默忽略，对端信封恒空、成员无法从缓存节点解密。
func TestApplySyncedGroupEventV2(t *testing.T) {
	st := openTemp(t)
	body := `{"action":"roster","encrypted":1,"envelopes":[{"cipher":"zzz","from_epoch":1}],` +
		`"epoch":2,"group_id":"g1","member_ids":["a1"],"name":"读书","roster_rev":2,` +
		`"sigs":[{"id":"a1","sig":"ff"}],"sub":"rotate"}`
	written, err := applySyncedGroupEvent(st, eventSyncItem{
		EventID: eventIDHex(1), ID: "a1", Type: "group.v1", BodyJSON: body, CreatedAt: 1,
	})
	if err != nil || !written {
		t.Fatalf("written=%v err=%v", written, err)
	}
	g, ok, err := st.GetGroup("g1")
	if err != nil || !ok {
		t.Fatalf("ok=%v err=%v", ok, err)
	}
	if g.RosterRev != 2 || g.Encrypted != 1 {
		t.Fatalf("v2 三列未还原: %+v", g)
	}
	// 用读接口同一形态解包，且逐字段核对——只判「非空字符串」会漏掉裸数组这个坑。
	var wrap struct {
		Envelopes []json.RawMessage `json:"envelopes"`
	}
	if err := json.Unmarshal([]byte(g.KeyEnvelopesJSON), &wrap); err != nil {
		t.Fatalf("key_envelopes 不是包装对象: %q err=%v", g.KeyEnvelopesJSON, err)
	}
	if len(wrap.Envelopes) != 1 {
		t.Fatalf("信封应恰好 1 条: %q", g.KeyEnvelopesJSON)
	}
	var env struct {
		Cipher    string `json:"cipher"`
		FromEpoch int64  `json:"from_epoch"`
	}
	if err := json.Unmarshal(wrap.Envelopes[0], &env); err != nil || env.Cipher != "zzz" || env.FromEpoch != 1 {
		t.Fatalf("信封字段未无损还原: %s err=%v", wrap.Envelopes[0], err)
	}
}

// v1 老事件（无 encrypted 键）必须按封闭圈落库（encrypted=1）——用 int64 时零值 0 会把老事件
// 误判成开放圈（匿名可读，安全漏洞）。roster_rev 缺省 0、信封缺省 []。
func TestApplySyncedGroupEventLegacyDefaultsEncrypted(t *testing.T) {
	st := openTemp(t)
	body := `{"group_id":"g2","action":"roster","epoch":1,"member_ids":["a1"]}`
	written, err := applySyncedGroupEvent(st, eventSyncItem{
		EventID: eventIDHex(2), ID: "a1", Type: "group.v1", BodyJSON: body, CreatedAt: 1,
	})
	if err != nil || !written {
		t.Fatalf("written=%v err=%v", written, err)
	}
	g, ok, err := st.GetGroup("g2")
	if err != nil || !ok {
		t.Fatalf("ok=%v err=%v", ok, err)
	}
	if g.Encrypted != 1 {
		t.Fatalf("老事件缺省应封闭 encrypted=1，实得 %d", g.Encrypted)
	}
	if g.RosterRev != 0 || g.KeyEnvelopesJSON != "[]" {
		t.Fatalf("老事件缺省列不符: %+v", g)
	}
}

// 解散事件把名单写成 []（补充 11）：空名单必须放行落库，否则对端永远保留旧名单，
// 已解散/被移出的成员仍能读封闭圈。
func TestApplySyncedGroupEventDissolveClearsRoster(t *testing.T) {
	st := openTemp(t)
	seed := `{"action":"roster","epoch":1,"group_id":"g3","member_ids":["a1"],"encrypted":1}`
	if written, err := applySyncedGroupEvent(st, eventSyncItem{
		EventID: eventIDHex(3), ID: "a1", Type: "group.v1", BodyJSON: seed, CreatedAt: 1,
	}); err != nil || !written {
		t.Fatalf("前置条件：正常名单应先落库 written=%v err=%v", written, err)
	}
	dis := `{"action":"roster","sub":"dissolve","epoch":2,"roster_rev":2,"group_id":"g3",` +
		`"member_ids":[],"encrypted":1,"sigs":[{"id":"a1","sig":"ff"}]}`
	written, err := applySyncedGroupEvent(st, eventSyncItem{
		EventID: eventIDHex(4), ID: "a1", Type: "group.v1", BodyJSON: dis, CreatedAt: 2,
	})
	if err != nil || !written {
		t.Fatalf("解散事件应落库 written=%v err=%v", written, err)
	}
	g, ok, err := st.GetGroup("g3")
	if err != nil || !ok {
		t.Fatalf("ok=%v err=%v", ok, err)
	}
	if g.MemberIDsJSON != "[]" || g.Epoch != 2 {
		t.Fatalf("解散未清空名单: %+v", g)
	}
}

// 负向：非 roster 事件、以及空名单但非解散（sub=remove）一律静默忽略（written=false，不报错），
// 且不得改动既有投影。
func TestApplySyncedGroupEventIgnoresNonRosterAndEmptyRemove(t *testing.T) {
	st := openTemp(t)
	seed := `{"action":"roster","epoch":1,"group_id":"g4","member_ids":["a1"],"encrypted":1}`
	if written, err := applySyncedGroupEvent(st, eventSyncItem{
		EventID: eventIDHex(5), ID: "a1", Type: "group.v1", BodyJSON: seed, CreatedAt: 1,
	}); err != nil || !written {
		t.Fatalf("前置条件：正常名单应先落库 written=%v err=%v", written, err)
	}
	cases := []string{
		`{"action":"msg","epoch":5,"group_id":"g4","payload_cid":"x"}`,
		`{"action":"roster","sub":"remove","epoch":9,"roster_rev":9,"group_id":"g4","member_ids":[],"encrypted":1}`,
	}
	for i, body := range cases {
		written, err := applySyncedGroupEvent(st, eventSyncItem{
			EventID: eventIDHex(100 + i), ID: "a1", Type: "group.v1", BodyJSON: body, CreatedAt: 1,
		})
		if err != nil || written {
			t.Fatalf("case %d 应静默忽略 written=%v err=%v", i, written, err)
		}
	}
	g, ok, err := st.GetGroup("g4")
	if err != nil || !ok || g.Epoch != 1 || g.MemberIDsJSON != `["a1"]` {
		t.Fatalf("投影不应被改动: %+v ok=%v err=%v", g, ok, err)
	}
}
