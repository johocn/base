package store

import (
	"encoding/json"
	"os"
	"testing"

	"github.com/johocn/base/internal/protocol"
)

func entryOf(t *testing.T, st *Store, itemID string) PackEntry {
	t.Helper()
	a, ok, err := st.GetArticle(itemID)
	if err != nil || !ok {
		t.Fatalf("GetArticle %s: ok=%v err=%v", itemID, ok, err)
	}
	return PackEntry{
		ItemID: a.ItemID, Source: "article", Type: "article", Title: a.Title,
		SourceRev: a.SourceRev, ContentHash: a.ContentHash, SQLiteTable: "articles",
		DistClass: "public", Digest: a.Digest, PublishedAt: a.PublishedAt, TagsJSON: a.TagsJSON, BodyMD: a.BodyMD,
	}
}

func TestImportPackAtomicAndIdempotent(t *testing.T) {
	st := openTemp(t)
	if err := st.UpsertArticle(Article{
		ItemID: "article:a", Title: "甲", BodyMD: "甲正文\n", ContentHash: protocol.SHA256Hex([]byte("甲正文\n")),
		SourceRev: "rev1", TagsJSON: `[]`,
	}); err != nil {
		t.Fatalf("seed: %v", err)
	}
	e := entryOf(t, st, "article:a")

	res, err := st.ImportPack(5, []PackEntry{e}, nil)
	if err != nil {
		t.Fatalf("ImportPack: %v", err)
	}
	if res.Entries != 1 || len(res.Rejected) != 0 {
		t.Fatalf("res = %+v", res)
	}
	if v, _ := st.ContentVersion(); v != 5 {
		t.Fatalf("content_version = %d, want 5", v)
	}
	// 幂等：重复导入同一版本不报错、不产生新行
	if _, err := st.ImportPack(5, []PackEntry{e}, nil); err != nil {
		t.Fatalf("重复导入: %v", err)
	}
	if _, ok, _ := st.GetArticle("article:a"); !ok {
		t.Fatal("条目应仍在")
	}
}

func TestImportPackTombstoneRemovesRowsAndReportsBlobs(t *testing.T) {
	st := openTemp(t)
	id := putBlob(t, st, "视频块0", "lesson:v", 0)
	if err := st.UpsertMediaItem(MediaItem{
		ItemID: "lesson:v", Source: "lesson", Type: "video", Title: "视频",
		SourceRev: "rev", ContentHash: protocol.SHA256Hex([]byte(id)), SQLiteTable: "media_meta",
		MIME: "video/mp4", Size: 10, ChunkSize: 1 << 20, ChunkHashes: []string{id},
	}); err != nil {
		t.Fatalf("seed: %v", err)
	}

	res, err := st.ImportPack(6, nil, []protocol.Tombstone{{ItemID: "lesson:v", RevokedRev: 6}})
	if err != nil {
		t.Fatalf("ImportPack: %v", err)
	}
	if len(res.RemovedBlobs) != 1 || res.RemovedBlobs[0] != id {
		t.Fatalf("RemovedBlobs = %v, want [%s]", res.RemovedBlobs, id)
	}
	if _, ok, _ := st.GetItem("lesson:v"); ok {
		t.Fatal("items 行应被删")
	}
	if _, _, _, _, _, ok, _ := st.GetMediaMeta("lesson:v"); ok {
		t.Fatal("media_meta 行应被删")
	}
	if has, _, _ := st.HasBlob(id); has {
		t.Fatal("blobs 行应被删")
	}
	// 块文件本体不在事务里删：由调用方负责
	if _, err := os.Stat(st.BlobPath(id)); err != nil {
		t.Fatalf("块文件本不应在本步被删: %v", err)
	}
	ts, _ := st.ListTombstones()
	if len(ts) != 1 || ts[0].RevokedRev != 6 {
		t.Fatalf("tombstones = %+v", ts)
	}
}

func TestImportPackTombstoneClearsSegments(t *testing.T) {
	st := openTemp(t)
	if err := st.UpsertSegmentItem(SegmentItem{
		ItemID: "course:old", Source: "course", Type: "course", Title: "旧课程",
		Segments: []Segment{
			{Seq: 0, Kind: "digest", Text: "简介"},
			{Seq: 1, Kind: "lesson", Text: "course:old/lesson:l1"},
		},
	}); err != nil {
		t.Fatalf("seed: %v", err)
	}

	if _, err := st.ImportPack(6, nil, []protocol.Tombstone{{ItemID: "course:old", RevokedRev: 6}}); err != nil {
		t.Fatalf("ImportPack: %v", err)
	}
	if _, ok, _ := st.GetItem("course:old"); ok {
		t.Fatal("items 行应被删")
	}
	segs, err := st.ListSegments("course:old")
	if err != nil {
		t.Fatalf("ListSegments: %v", err)
	}
	if len(segs) != 0 {
		t.Fatalf("墓碑应连带清掉 segments 行, got %+v", segs)
	}
}

func TestImportPackRejectsRollback(t *testing.T) {
	st := openTemp(t)
	if err := st.AddTombstone("article:a", 7); err != nil {
		t.Fatalf("AddTombstone: %v", err)
	}
	e := PackEntry{
		ItemID: "article:a", Source: "article", Type: "article", Title: "甲",
		ContentHash: protocol.SHA256Hex([]byte("甲")), SQLiteTable: "articles",
		DistClass: "public", BodyMD: "甲", TagsJSON: `[]`,
	}
	// 同版本（7）重现 → 拒该条目
	res, err := st.ImportPack(7, []PackEntry{e}, nil)
	if err != nil {
		t.Fatalf("ImportPack: %v", err)
	}
	if len(res.Rejected) != 1 || res.Rejected[0] != "article:a" || res.Entries != 0 {
		t.Fatalf("res = %+v", res)
	}
	if _, ok, _ := st.GetArticle("article:a"); ok {
		t.Fatal("被拒条目不得入库")
	}
	// 更大版本（8）= 正常重新发布 → 允许入库，且墓碑 revoked_rev 取大值
	res, err = st.ImportPack(8, []PackEntry{e}, nil)
	if err != nil {
		t.Fatalf("ImportPack v8: %v", err)
	}
	if res.Entries != 1 || len(res.Rejected) != 0 {
		t.Fatalf("res = %+v", res)
	}
	if _, ok, _ := st.GetArticle("article:a"); !ok {
		t.Fatal("重新发布应入库")
	}
}

func TestImportPackSkipsNonPublic(t *testing.T) {
	st := openTemp(t)
	res, err := st.ImportPack(1, []PackEntry{{
		ItemID: "article:x", Source: "article", Type: "article", SQLiteTable: "articles",
		DistClass: "controlled", ContentHash: "h", BodyMD: "x",
	}}, nil)
	if err != nil {
		t.Fatalf("ImportPack: %v", err)
	}
	if res.Skipped != 1 || res.Entries != 0 {
		t.Fatalf("res = %+v", res)
	}
	if _, ok, _ := st.GetItem("article:x"); ok {
		t.Fatal("非 public 条目不得入库")
	}
}

// 同一包内「归属通过」与「归属为空」的条目各自独立处理：空归属只是不计贡献，不影响入库。
func TestImportPackStoresAuthorColumns(t *testing.T) {
	st, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = st.Close() }()
	const (
		authorID = "f78672b2f87ff80b248323a4be7c3da6"
		sigHex   = "4d60b2e2e4f998bea25bd0124dffcdf0fb44ccf2db886ae2cac9764d9e03d06668dfa029440cc3554e93737644bb5b1c1601505c14d22c672bed235b41c85203"
	)
	body := "正文"
	hash := protocol.SHA256Hex([]byte(body))
	entries := []PackEntry{
		{ItemID: "article:with-author", Source: "article", Type: "article", Title: "有归属",
			ContentHash: hash, SQLiteTable: "articles", DistClass: "public", BodyMD: body,
			AuthorID: authorID, AuthorSig: sigHex},
		{ItemID: "article:no-author", Source: "article", Type: "article", Title: "无归属",
			ContentHash: hash, SQLiteTable: "articles", DistClass: "public", BodyMD: body},
	}
	if _, err := st.ImportPack(3, entries, []protocol.Tombstone{}); err != nil {
		t.Fatalf("ImportPack: %v", err)
	}
	it, ok, err := st.GetItem("article:with-author")
	if err != nil || !ok {
		t.Fatalf("GetItem: ok=%v err=%v", ok, err)
	}
	if it.AuthorID != authorID || it.AuthorSig != sigHex {
		t.Fatalf("归属缓存未落库: %+v", it)
	}
	it2, _, err := st.GetItem("article:no-author")
	if err != nil {
		t.Fatal(err)
	}
	if it2.AuthorID != "" || it2.AuthorSig != "" {
		t.Fatalf("无归属条目两列应为空: %+v", it2)
	}

	// 再次导入同一 item 且不带归属 → 覆盖为空（避免陈旧归属残留）
	if _, err := st.ImportPack(4, []PackEntry{{
		ItemID: "article:with-author", Source: "article", Type: "article", Title: "有归属",
		ContentHash: hash, SQLiteTable: "articles", DistClass: "public", BodyMD: body,
	}}, []protocol.Tombstone{}); err != nil {
		t.Fatalf("二次 ImportPack: %v", err)
	}
	it3, _, err := st.GetItem("article:with-author")
	if err != nil {
		t.Fatal(err)
	}
	if it3.AuthorID != "" || it3.AuthorSig != "" {
		t.Fatalf("重导后归属应被覆盖为空: %+v", it3)
	}
}

// 融合钩子（轨道 B）基础验证：entries 循环后 groups + circle_assignments 都有对应行，
// creator_id 命中 author_id，origin=fusion，circle_id 由 item_id 稳定派生。
func TestImportPackFusionHook(t *testing.T) {
	st, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = st.Close() }()

	const authorID = "f78672b2f87ff80b248323a4be7c3da6"
	const itemID = "article:fusion-test"
	body := "融合正文"
	hash := protocol.SHA256Hex([]byte(body))

	if _, err := st.ImportPack(1, []PackEntry{{
		ItemID: itemID, Source: "article", Type: "article", Title: "融合文",
		ContentHash: hash, SQLiteTable: "articles", DistClass: "public", BodyMD: body,
		AuthorID: authorID,
	}}, nil); err != nil {
		t.Fatalf("ImportPack: %v", err)
	}

	// 派生 circle_id 与生产代码同口径
	expectedCircleID := protocol.SHA256Hex([]byte(itemID + ":circle"))[:16]

	// groups 行：GetGroup 能取到
	gr, ok, err := st.GetGroup(expectedCircleID)
	if err != nil {
		t.Fatalf("GetGroup: %v", err)
	}
	if !ok {
		t.Fatalf("groups 表应有 group_id=%s", expectedCircleID)
	}
	if gr.CreatorID != authorID {
		t.Fatalf("creator_id 应为 %s, got %s", authorID, gr.CreatorID)
	}
	if gr.EventID != expectedCircleID {
		t.Fatalf("event_id 应等于 circle_id, got %s", gr.EventID)
	}
	if gr.Epoch != 1 || gr.RosterRev != 0 || gr.Encrypted != 1 {
		t.Fatalf("groups 字段不对: %+v", gr)
	}
	// member_ids_json = [authorID]
	var memberList []string
	if err := json.Unmarshal([]byte(gr.MemberIDsJSON), &memberList); err != nil {
		t.Fatalf("member_ids_json 解析失败: %v", err)
	}
	if len(memberList) != 1 || memberList[0] != authorID {
		t.Fatalf("member_ids_json = %v, want [%s]", memberList, authorID)
	}
	// origin 列——GetGroup 不返回 origin，直接查
	var origin string
	if err := st.db.QueryRow(`SELECT origin FROM groups WHERE group_id=?`, expectedCircleID).Scan(&origin); err != nil {
		t.Fatalf("查 origin: %v", err)
	}
	if origin != "fusion" {
		t.Fatalf("groups.origin 应为 fusion, got %s", origin)
	}

	// circle_assignments 行
	var caItem, caCircle, caOrigin string
	if err := st.db.QueryRow(
		`SELECT item_id,circle_id,origin FROM circle_assignments WHERE item_id=?`, itemID,
	).Scan(&caItem, &caCircle, &caOrigin); err != nil {
		t.Fatalf("circle_assignments 查询失败: %v", err)
	}
	if caItem != itemID || caCircle != expectedCircleID || caOrigin != "fusion" {
		t.Fatalf("circle_assignments = (%s,%s,%s)", caItem, caCircle, caOrigin)
	}
}

// 同一条目重复导入 → INSERT OR IGNORE 幂等，groups/circle_assignments 行数不增。
func TestImportPackFusionHookIdempotent(t *testing.T) {
	st, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = st.Close() }()

	const authorID = "f78672b2f87ff80b248323a4be7c3da6"
	const itemID = "article:idem"
	body := "幂等"
	hash := protocol.SHA256Hex([]byte(body))
	entries := []PackEntry{{
		ItemID: itemID, Source: "article", Type: "article", Title: "幂等文",
		ContentHash: hash, SQLiteTable: "articles", DistClass: "public", BodyMD: body,
		AuthorID: authorID,
	}}

	if _, err := st.ImportPack(1, entries, nil); err != nil {
		t.Fatalf("v1 ImportPack: %v", err)
	}

	countGroups := func() int {
		var c int
		if err := st.db.QueryRow(`SELECT COUNT(*) FROM groups`).Scan(&c); err != nil {
			t.Fatal(err)
		}
		return c
	}
	countCA := func() int {
		var c int
		if err := st.db.QueryRow(`SELECT COUNT(*) FROM circle_assignments`).Scan(&c); err != nil {
			t.Fatal(err)
		}
		return c
	}
	g1 := countGroups()
	ca1 := countCA()
	if g1 != 1 || ca1 != 1 {
		t.Fatalf("首轮: groups=%d circle_assignments=%d, 都应为 1", g1, ca1)
	}

	// 同条目再导一次（同版本，触发 upsert items；融合钩子再跑一次但 INSERT OR IGNORE 跳过）
	if _, err := st.ImportPack(2, entries, nil); err != nil {
		t.Fatalf("v2 ImportPack: %v", err)
	}
	g2 := countGroups()
	ca2 := countCA()
	if g2 != g1 || ca2 != ca1 {
		t.Fatalf("重复导入后: groups=%d(==%d?) circle_assignments=%d(==%d?)", g2, g1, ca2, ca1)
	}
}

// AuthorID 为空的条目 → 不触发融合。
func TestImportPackFusionHookNoAuthor(t *testing.T) {
	st, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = st.Close() }()

	body := "无归属"
	hash := protocol.SHA256Hex([]byte(body))

	if _, err := st.ImportPack(1, []PackEntry{{
		ItemID: "article:no-author", Source: "article", Type: "article", Title: "无归属",
		ContentHash: hash, SQLiteTable: "articles", DistClass: "public", BodyMD: body,
		// AuthorID 字段留空（零值）
	}}, nil); err != nil {
		t.Fatalf("ImportPack: %v", err)
	}

	var g int
	if err := st.db.QueryRow(`SELECT COUNT(*) FROM groups`).Scan(&g); err != nil {
		t.Fatal(err)
	}
	var ca int
	if err := st.db.QueryRow(`SELECT COUNT(*) FROM circle_assignments`).Scan(&ca); err != nil {
		t.Fatal(err)
	}
	if g != 0 || ca != 0 {
		t.Fatalf("无 author_id 时不应触发融合: groups=%d circle_assignments=%d", g, ca)
	}
}
