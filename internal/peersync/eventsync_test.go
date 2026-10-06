package peersync

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"path/filepath"
	"reflect"
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

// 验收 11（真实实现路径）：govern.v1 经一轮反熵落到缓存节点后，由 peersync 自己的投影 + 生效判定闭环，
// 提案被判 effective。名册在**接收侧**本地派生、**每页一次**后传参（更正 46 ⑧ 的重构点）——
// httpapi 侧的 drainGovernFromPeer 只是镜像，这里断言真实现（更正 45 ⑥ 的覆盖缺口）。
func TestSyncEventsGovernProposalSettlesOnPeer(t *testing.T) {
	src, url, tr, pub := newSourceNode(t)
	dst := openTemp(t)

	// 接收侧先具备两样东西：受审条目（active + 已知内容哈希）与 3 名达质量门槛的治者。
	// V2 改动：article/gb 的 author 设为 govs[0]（proposer），让 shouldFreeExec 走通
	targetHash := seedGovernArticle(t, dst, "article/gb", "a1111111111111111111111111111111")
	govs := []string{
		"a1111111111111111111111111111111",
		"b2222222222222222222222222222222",
		"c3333333333333333333333333333333",
	}
	for i, id := range govs {
		seedGovernArticle(t, dst, fmt.Sprintf("article/gov%d", i), id)
	}
	// 给 3 个 gov 插 identities（last_seen_at 在 7 天内）——V2 用 identities COUNT 算 m
	db, err := sql.Open("sqlite", "file:"+filepath.ToSlash(filepath.Join(dst.DataDir(), "base.db"))+"?mode=rw")
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	defer db.Close()
	now := time.Now().UnixMilli()
	for _, id := range govs {
		if _, err := db.Exec(`INSERT OR IGNORE INTO identities(id,alg,pubkey,created_at,last_seen_at) VALUES(?,?,?,?,?)`,
			id, "ed25519", "00", now, now); err != nil {
			t.Fatalf("insert identity %s: %v", id, err)
		}
	}

	// 源节点：提案事件（提案人自投第 1 票）+ 2 条投票事件 = remove 门槛 3 票。
	t0 := time.Now().UnixMilli()
	seedGovernEvent(t, src, eventIDHex(11), govs[0], t0, `{"action":"proposal","proposal_id":"7",`+
		`"target_item_id":"article/gb","verb":"remove","content_hash":"`+targetHash+`",`+
		`"content_version":0,"revoked_rev":0}`)
	seedGovernEvent(t, src, eventIDHex(12), govs[1], t0+1, `{"action":"vote","proposal_id":"7","choice":"yes"}`)
	seedGovernEvent(t, src, eventIDHex(13), govs[2], t0+2, `{"action":"vote","proposal_id":"7","choice":"yes"}`)

	cfg := Config{TransportFor: tr, IssuerPubKeys: map[string]string{srcIssuer: pub}}
	cfg.RunOnce(context.Background(), dst, []Peer{{URL: url}}, func(string, ...any) {})

	roster, rosterOK := deriveGovernRoster(dst)
	views, err := dst.ListProposalViews(roster)
	if err != nil || len(views) != 1 {
		t.Fatalf("缓存节点应有 1 条提案 err=%v views=%+v", err, views)
	}
	if views[0].Status != store.GovernStatusEffective || views[0].ExecutedResult == "" {
		t.Fatalf("名册就绪=%v：票满门槛后应判为生效: %+v", rosterOK, views[0])
	}
}

// seedGovernArticle 在指定节点落一篇 ≥ArticleMinRunes 的文章（名册质量门槛），
// 并按需直写归属缓存列（归属只由导入/投稿产生，测试无公开写路径），返回其内容哈希。
func seedGovernArticle(t *testing.T, st *store.Store, itemID, authorID string) string {
	t.Helper()
	body := "正文" + strings.Repeat("文", 200)
	hash := protocol.SHA256Hex([]byte(body))
	if err := st.UpsertArticle(store.Article{
		ItemID: itemID, Title: itemID, BodyMD: body,
		ContentHash: hash, UpdatedAt: "2026-01-02T00:00:00Z",
	}); err != nil {
		t.Fatalf("UpsertArticle(%s): %v", itemID, err)
	}
	if authorID == "" {
		return hash
	}
	db, err := sql.Open("sqlite", "file:"+filepath.ToSlash(filepath.Join(st.DataDir(), "base.db"))+"?mode=rw")
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	defer func() { _ = db.Close() }()
	if _, err := db.Exec(`UPDATE items SET author_id=?, author_sig=? WHERE item_id=?`, authorID, "00", itemID); err != nil {
		t.Fatalf("set cached author: %v", err)
	}
	return hash
}

// seedGovernEvent 直落一条 govern.v1 事件行（写路径的验签由 internal/httpapi 覆盖）。
func seedGovernEvent(t *testing.T, st *store.Store, eventID, actor string, createdAt int64, body string) {
	t.Helper()
	if err := st.PutEvent(store.Event{
		EventID: eventID, ID: actor, Type: "govern.v1", BodyJSON: body, CreatedAt: createdAt,
	}); err != nil {
		t.Fatalf("PutEvent(%s): %v", eventID, err)
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

// seedProgressEvent 在源节点直接落一条 progress.v1（双投影 + 事件行）。
// 写路径的验签由 internal/httpapi 覆盖，这里只造既成事实。
func seedProgressEvent(t *testing.T, st *store.Store, eventID, actor string, createdAt int64,
	itemID string, position int64, done bool, day string) {
	t.Helper()
	if err := st.PutProgressProjection(store.ProgressEvent{
		ID: actor, ItemID: itemID, Position: position, Done: done, Day: day,
		CreatedAt: createdAt, EventID: eventID,
	}); err != nil {
		t.Fatalf("PutProgressProjection(%s): %v", eventID, err)
	}
	body := fmt.Sprintf(`{"item_id":%q,"position":%d,"done":%t,"day":%q}`, itemID, position, done, day)
	if err := st.PutEvent(store.Event{
		EventID: eventID, ID: actor, Type: "progress.v1", BodyJSON: body,
		CreatedAt: createdAt, TargetID: itemID,
	}); err != nil {
		t.Fatalf("PutEvent(%s): %v", eventID, err)
	}
}

// #8 册子 §8.1 Go 反熵：两节点间 progress.v1 传播后，两侧 progress / checkin_days **逐字一致**；
// 重复投递幂等（第二轮不得改变结果、不得产生第二行）。
func TestSyncEventsProgressProjectionConverges(t *testing.T) {
	src, url, tr, pub := newSourceNode(t)
	dst := openTemp(t)

	actor := commentActor
	// article/a：先早后晚 —— 两端都只留 LWW 晚者。
	seedProgressEvent(t, src, eventIDHex(21), actor, 1000, "article/a", 300, false, "2026-10-01")
	seedProgressEvent(t, src, eventIDHex(22), actor, 2000, "article/a", 900, false, "2026-10-02")
	// quiz/q1：先晚后早 —— 后到达的更早事件**不得**覆盖（输者静默）。
	seedProgressEvent(t, src, eventIDHex(23), actor, 2000, "quiz/q1", 9, true, "2026-10-03")
	seedProgressEvent(t, src, eventIDHex(24), actor, 1000, "quiz/q1", 2, false, "2026-10-01")

	wantProgress := []store.ProgressRow{
		{ItemID: "article/a", Position: 900, Done: false, Day: "2026-10-02", UpdatedAt: 2000, EventID: eventIDHex(22)},
		{ItemID: "quiz/q1", Position: 9, Done: true, Day: "2026-10-03", UpdatedAt: 2000, EventID: eventIDHex(23)},
	}
	// 打卡日是事件级 insert-or-ignore：10-01 由 event21 首次写入并被 event24 复投而不改（§3.5）。
	wantDays := []store.CheckinDayRow{
		{Day: "2026-10-01", FirstEventID: eventIDHex(21), CreatedAt: 1000},
		{Day: "2026-10-02", FirstEventID: eventIDHex(22), CreatedAt: 2000},
		{Day: "2026-10-03", FirstEventID: eventIDHex(23), CreatedAt: 2000},
	}

	cfg := Config{TransportFor: tr, IssuerPubKeys: map[string]string{srcIssuer: pub}}
	if _, err := cfg.SyncEvents(context.Background(), dst, Peer{URL: url}); err != nil {
		t.Fatalf("SyncEvents: %v", err)
	}

	for _, node := range []struct {
		name string
		st   *store.Store
	}{{"源节点", src}, {"缓存节点", dst}} {
		rows, err := node.st.ListProgressByID(actor)
		if err != nil || !reflect.DeepEqual(rows, wantProgress) {
			t.Fatalf("%s progress 不符 err=%v got=%+v want=%+v", node.name, err, rows, wantProgress)
		}
		days, err := node.st.CheckinDaysOf(actor)
		if err != nil || !reflect.DeepEqual(days, wantDays) {
			t.Fatalf("%s checkin_days 不符 err=%v got=%+v want=%+v", node.name, err, days, wantDays)
		}
	}

	// 第二轮：游标已推进 ⇒ 无事件可搬，结果一字不变。
	ev, err := cfg.SyncEvents(context.Background(), dst, Peer{URL: url})
	if err != nil || ev.Events != 0 {
		t.Fatalf("第二轮应无事可做 ev=%+v err=%v", ev, err)
	}
	rows, _ := dst.ListProgressByID(actor)
	if !reflect.DeepEqual(rows, wantProgress) {
		t.Fatalf("第二轮后 progress 变了: %+v", rows)
	}
	days, _ := dst.CheckinDaysOf(actor)
	if !reflect.DeepEqual(days, wantDays) {
		t.Fatalf("第二轮后 checkin_days 变了: %+v", days)
	}
}

// T3 验收：对端 circle.v1 assign 事件到达后，本地 circle_assignments 有行。
// 用 applySyncedCircleEvent 直接调——这是对端事件经反熵落地后的投影入口。
func TestApplySyncedCircleEventAssignWritesCircleAssignments(t *testing.T) {
	st := openTemp(t)
	circleID := "00000000000000ff"
	itemID := "article/ai1"

	// action=assign 的合法事件：写 circle_assignments 一行。
	body := fmt.Sprintf(`{"action":"assign","item_id":%q,"circle_id":%q,"content_hash":"ab"}`, itemID, circleID)
	written, err := applySyncedCircleEvent(st, eventSyncItem{
		EventID: eventIDHex(1), ID: "actor", Type: "circle.v1", BodyJSON: body, CreatedAt: 123,
	})
	if err != nil || !written {
		t.Fatalf("written=%v err=%v", written, err)
	}

	// 直接查 circle_assignments 表验证行已写入（db 是私有字段，用 sql.Open 从 DataDir 读）。
	db, err := sql.Open("sqlite", "file:"+filepath.ToSlash(filepath.Join(st.DataDir(), "base.db"))+"?mode=ro")
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	defer func() { _ = db.Close() }()
	var gotItem, gotCircle, gotOrigin string
	var gotCreatedAt int64
	err = db.QueryRow(`SELECT item_id,circle_id,origin,created_at FROM circle_assignments WHERE item_id=?`, itemID).
		Scan(&gotItem, &gotCircle, &gotOrigin, &gotCreatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		t.Fatal("circle_assignments 应写入一行，实际未找到")
	}
	if err != nil {
		t.Fatalf("query circle_assignments: %v", err)
	}
	if gotItem != itemID || gotCircle != circleID || gotOrigin != "fusion" || gotCreatedAt != 123 {
		t.Fatalf("circle_assignments 行不符: item=%s circle=%s origin=%s createdAt=%d", gotItem, gotCircle, gotOrigin, gotCreatedAt)
	}

	// 幂等：同事件重放不报错、不多写（INSERT OR IGNORE）。
	if _, err2 := applySyncedCircleEvent(st, eventSyncItem{
		EventID: eventIDHex(1), ID: "actor", Type: "circle.v1", BodyJSON: body, CreatedAt: 999,
	}); err2 != nil {
		t.Fatalf("重放应无错: %v", err2)
	}
	// Go 的 INSERT OR IGNORE 即使行已存在也返回 written=true（RowsAffected==0 但我们不判 RowsAffected）。
	// 关键是 createdAt 应保留首次值 123，而非后来的 999。
	err = db.QueryRow(`SELECT created_at FROM circle_assignments WHERE item_id=?`, itemID).Scan(&gotCreatedAt)
	if err != nil {
		t.Fatalf("requery: %v", err)
	}
	if gotCreatedAt != 123 {
		t.Fatalf("幂等重放后 created_at 应保留首次值 123，实得 %d", gotCreatedAt)
	}

	// action=form：不投影（留 T4）——不应产生新行。
	formBody := fmt.Sprintf(`{"action":"form","item_id":%q,"circle_id":%q,"origin":"user"}`, itemID, "00000000000000fe")
	written3, err3 := applySyncedCircleEvent(st, eventSyncItem{
		EventID: eventIDHex(2), ID: "actor", Type: "circle.v1", BodyJSON: formBody, CreatedAt: 456,
	})
	if err3 != nil || written3 {
		t.Fatalf("form 应静默忽略 written=%v err=%v", written3, err3)
	}
	var count int
	err = db.QueryRow(`SELECT COUNT(*) FROM circle_assignments`).Scan(&count)
	if err != nil {
		t.Fatalf("count: %v", err)
	}
	if count != 1 {
		t.Fatalf("form 不应投影，circle_assignments 应仍 1 行，实得 %d", count)
	}

	// 非 circle.v1 type：直接返回。
	written4, err4 := applySyncedCircleEvent(st, eventSyncItem{
		EventID: eventIDHex(3), ID: "actor", Type: "comment.v1", BodyJSON: `{}`, CreatedAt: 0,
	})
	if err4 != nil || written4 {
		t.Fatalf("非 circle.v1 应静默返回 written=%v err=%v", written4, err4)
	}
}

// #79 §6：like.v1 / report.v1 是无 payload 事件，接收侧投影只填 target_id，
// payload_cid / reply_to 恒空（EventBlobIndex 白名单不动，同 progress.v1 先例）。
// 坏 JSON / 缺 target_id ⇒ 零投影（事件仍落行，与既有口径一致）。
func TestParseEventProjectionLikeReport(t *testing.T) {
	cases := []struct {
		name string
		typ  string
		body string
		want commentProjection
	}{
		{"like.v1 投影 target_id", "like.v1", `{"action":"like","target_id":"c1","sig":"0"}`,
			commentProjection{TargetID: "c1"}},
		{"report.v1 投影 target_id", "report.v1", `{"reason":"spam","target_id":"c1","sig":"0"}`,
			commentProjection{TargetID: "c1"}},
		{"坏 JSON 零投影", "like.v1", `{"action":bad`, commentProjection{}},
		{"缺 target_id 零投影", "report.v1", `{"reason":"spam","sig":"0"}`, commentProjection{}},
	}
	for _, tc := range cases {
		if got := parseEventProjection(tc.typ, tc.body); got != tc.want {
			t.Fatalf("%s: got %+v, want %+v", tc.name, got, tc.want)
		}
	}
}

// seedLikeEvent / seedReportEvent 直落一条无 payload 事件行（写路径验签由 internal/httpapi 覆盖，
// 这里只造既成事实）；body_json 与写侧落库形态一致：canonical({target_id,action|reason,sig})。
func seedLikeEvent(t *testing.T, st *store.Store, eventID, actor string, createdAt int64, target, action string) {
	t.Helper()
	body := fmt.Sprintf(`{"action":%q,"sig":"00","target_id":%q}`, action, target)
	if err := st.PutEvent(store.Event{
		EventID: eventID, ID: actor, Type: "like.v1", BodyJSON: body,
		CreatedAt: createdAt, TargetID: target,
	}); err != nil {
		t.Fatalf("PutEvent(%s): %v", eventID, err)
	}
}

func seedReportEvent(t *testing.T, st *store.Store, eventID, actor string, createdAt int64, target, reason string) {
	t.Helper()
	body := fmt.Sprintf(`{"reason":%q,"sig":"00","target_id":%q}`, reason, target)
	if err := st.PutEvent(store.Event{
		EventID: eventID, ID: actor, Type: "report.v1", BodyJSON: body,
		CreatedAt: createdAt, TargetID: target,
	}); err != nil {
		t.Fatalf("PutEvent(%s): %v", eventID, err)
	}
}

// #79 AC 11（Task 6）：like.v1 / report.v1 经 event-sync 从源节点传播到缓存节点后，
// 接收侧投影重建 target_id，LikeCountsByTargets / ListReportedComments 在对端与源节点一致。
// LWW（like 后 unlike 不计）与举报去重（同人重复举报只计一次）跨节点不变形。
func TestSyncEventsLikeReportAggregatesOnPeer(t *testing.T) {
	src, url, tr, pub := newSourceNode(t)

	// 源节点：评论 c1 + 甲（like→unlike，最新态 unlike ⇒ 不计）+ 乙（like ⇒ 计 1）；
	// 举报：甲重复举报两次（去重 1 人）+ 丙一次 ⇒ report_count=2。
	c1 := eventIDHex(1)
	cid := seedComment(t, src, c1, "article/a", "被点赞被举报的正文", "")
	seedLikeEvent(t, src, eventIDHex(2), commentActor, 1000, c1, "like")
	seedLikeEvent(t, src, eventIDHex(3), commentActor, 2000, c1, "unlike")
	likerB := "b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1"
	seedLikeEvent(t, src, eventIDHex(4), likerB, 1000, c1, "like")
	seedReportEvent(t, src, eventIDHex(5), commentActor, 1000, c1, "spam")
	seedReportEvent(t, src, eventIDHex(6), commentActor, 1001, c1, "abuse")
	reporterC := "c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1"
	seedReportEvent(t, src, eventIDHex(7), reporterC, 1000, c1, "other")

	dst := openTemp(t)
	cfg := Config{TransportFor: tr, IssuerPubKeys: map[string]string{srcIssuer: pub}}
	ev, err := cfg.SyncEvents(context.Background(), dst, Peer{URL: url})
	if err != nil || ev.Events != 7 {
		t.Fatalf("反熵一轮应搬来 7 条事件 ev=%+v err=%v", ev, err)
	}

	// like 计数两端一致：甲最新为 unlike 不计，乙计 1。
	for _, node := range []struct {
		name string
		st   *store.Store
	}{{"源节点", src}, {"缓存节点", dst}} {
		got, err := node.st.LikeCountsByTargets([]string{c1})
		if err != nil || got[c1] != 1 {
			t.Fatalf("%s like_count 不符 err=%v got=%+v", node.name, err, got)
		}
	}

	// 接收侧投影：like 行只填 target_id，payload 列恒空（#79 §6）。
	le, ok, err := dst.GetEventByID(eventIDHex(2))
	if err != nil || !ok {
		t.Fatalf("缓存节点应有 like 事件 ok=%v err=%v", ok, err)
	}
	if le.TargetID != c1 || le.PayloadCID != "" || le.ReplyTo != "" {
		t.Fatalf("like 投影列不符: %+v", le)
	}

	// 举报列表两端一致：被举报评论一行，report_count=2（甲去重），reporters 两名。
	wantReporters := map[string]bool{commentActor: true, reporterC: true}
	for _, node := range []struct {
		name string
		st   *store.Store
	}{{"源节点", src}, {"缓存节点", dst}} {
		rows, err := node.st.ListReportedComments()
		if err != nil || len(rows) != 1 {
			t.Fatalf("%s reported 列表不符 err=%v rows=%+v", node.name, err, rows)
		}
		r := rows[0]
		if r.EventID != c1 || r.Actor != commentActor || r.TargetID != "article/a" ||
			r.PayloadCID != cid || r.ReportCount != 2 {
			t.Fatalf("%s reported 行不符: %+v", node.name, r)
		}
		got := map[string]bool{}
		for _, id := range r.Reporters {
			got[id] = true
		}
		if !reflect.DeepEqual(got, wantReporters) {
			t.Fatalf("%s reporters 去重不符: %v", node.name, r.Reporters)
		}
	}
}

// #79 AC 11 对造用例：对端只拉到 like/report 事件、评论事件从未到达（悬空 target）——
// 计数聚合不崩（事件行自足），举报列表不出现该行（JOIN 无评论事件，§5.3 风险 4 口径）。
func TestSyncEventsDanglingLikeReportTargetDoesNotCrash(t *testing.T) {
	src, url, tr, pub := newSourceNode(t)
	ghost := eventIDHex(9) // 任何节点都没有该评论事件
	seedLikeEvent(t, src, eventIDHex(8), commentActor, 1000, ghost, "like")
	seedReportEvent(t, src, eventIDHex(10), commentActor, 1000, ghost, "spam")

	dst := openTemp(t)
	cfg := Config{TransportFor: tr, IssuerPubKeys: map[string]string{srcIssuer: pub}}
	ev, err := cfg.SyncEvents(context.Background(), dst, Peer{URL: url})
	if err != nil || ev.Events != 2 {
		t.Fatalf("反熵一轮应搬来 2 条事件 ev=%+v err=%v", ev, err)
	}

	got, err := dst.LikeCountsByTargets([]string{ghost})
	if err != nil {
		t.Fatalf("悬空 target 计数聚合不应报错: %v", err)
	}
	if got[ghost] != 1 {
		t.Fatalf("悬空 target 计数不符: %+v", got)
	}
	rows, err := dst.ListReportedComments()
	if err != nil {
		t.Fatalf("悬空 target 举报列表不应报错: %v", err)
	}
	if len(rows) != 0 {
		t.Fatalf("评论未同步的举报行不应出现在列表: %+v", rows)
	}
}
