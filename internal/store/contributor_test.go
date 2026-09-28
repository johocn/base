package store

import (
	"fmt"
	"strings"
	"testing"

	"github.com/johocn/base/internal/protocol"
)

func TestMigrateAddsAuthorColumnsAndProfiles(t *testing.T) {
	dir := t.TempDir()
	st, err := Open(dir)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	cols, err := tableColumns(st.db, "items")
	if err != nil {
		t.Fatal(err)
	}
	for _, c := range []string{"author_id", "author_sig"} {
		if !cols[c] {
			t.Fatalf("items 缺少列 %s", c)
		}
	}
	if !cols["state"] {
		t.Fatal("items 既有列丢失")
	}
	pcols, err := tableColumns(st.db, "profiles")
	if err != nil {
		t.Fatal(err)
	}
	for _, c := range []string{"id", "name", "updated_at"} {
		if !pcols[c] {
			t.Fatalf("profiles 缺少列 %s", c)
		}
	}
	if err := st.Close(); err != nil {
		t.Fatal(err)
	}
	// 二次打开：列已存在时迁移必须幂等（对应老库补列的路径）
	st2, err := Open(dir)
	if err != nil {
		t.Fatalf("二次 Open: %v", err)
	}
	defer func() { _ = st2.Close() }()
	if _, err := st2.db.Exec(`SELECT author_id, author_sig FROM items LIMIT 1`); err != nil {
		t.Fatalf("补列后仍不可查询: %v", err)
	}
	if _, err := st2.db.Exec(`SELECT id, name, updated_at FROM profiles LIMIT 1`); err != nil {
		t.Fatalf("profiles 不可查询: %v", err)
	}
}

const (
	authorA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	authorB = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
	authorC = "cccccccccccccccccccccccccccccccc"
)

func longBody() string { return strings.Repeat("字", 200) }

func TestDeriveRosterQualityGates(t *testing.T) {
	cands := []Candidate{
		{ItemID: "article:a", AuthorID: authorA, Type: "article", BodyMD: longBody()},
		{ItemID: "article:b", AuthorID: authorB, Type: "article", BodyMD: strings.Repeat("字", 199)},
		{ItemID: "article:c", AuthorID: authorC, Type: "article", BodyMD: " \n" + longBody() + "\t"},
		{ItemID: "video:a", AuthorID: authorA, Type: "video", DurationSeconds: 60},
		{ItemID: "video:b", AuthorID: authorB, Type: "video", DurationSeconds: 59},
		{ItemID: "video:z", AuthorID: authorC, Type: "video", DurationSeconds: 0},
		{ItemID: "quiz:a", AuthorID: authorA, Type: "quiz", QuestionCount: 3},
		{ItemID: "quiz:b", AuthorID: authorB, Type: "quiz", QuestionCount: 2},
		{ItemID: "cover:a", AuthorID: authorC, Type: "cover"},
		{ItemID: "article:d", AuthorID: "", Type: "article", BodyMD: longBody()},
	}
	got := deriveRoster(cands)
	want := []Contributor{{ID: authorA, Count: 3}, {ID: authorC, Count: 1}}
	if len(got) != len(want) {
		t.Fatalf("名册 = %+v, want %+v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("名册第 %d 名 = %+v, want %+v", i, got[i], want[i])
		}
	}
}

func TestDeriveRosterTieBreakAndTruncation(t *testing.T) {
	cands := []Candidate{}
	// 12 个身份，条数依次 12,11,...,1（无并列）
	for i := 0; i < 12; i++ {
		id := fmt.Sprintf("%032x", i+1)
		for n := 0; n <= 11-i; n++ {
			cands = append(cands, Candidate{
				ItemID: fmt.Sprintf("article:%02d-%02d", i, n), AuthorID: id, Type: "article", BodyMD: longBody(),
			})
		}
	}
	got := deriveRoster(cands)
	if len(got) != RosterTopN {
		t.Fatalf("截断后应 10 条，实得 %d", len(got))
	}
	if got[0].Count != 12 || got[len(got)-1].Count != 3 {
		t.Fatalf("名次边界错误: %+v", got)
	}
	for i := 1; i < len(got); i++ {
		if got[i-1].Count < got[i].Count {
			t.Fatalf("不是条数降序: %+v", got)
		}
	}

	// 同条数按 author_id 字典序升序
	tie := deriveRoster([]Candidate{
		{ItemID: "article:1", AuthorID: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", Type: "article", BodyMD: longBody()},
		{ItemID: "article:2", AuthorID: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", Type: "article", BodyMD: longBody()},
	})
	if len(tie) != 2 || tie[0].ID != authorA || tie[1].ID != authorB {
		t.Fatalf("并列 tiebreak 错误: %+v", tie)
	}

	// 空输入 → 空名册（不足 10 人就有几名，0 人返回空数组）
	if n := len(deriveRoster(nil)); n != 0 {
		t.Fatalf("空输入应返回空名册，实得 %d", n)
	}

	// 柔性名额：只有 3 人时返回 3 条（≥1 条即入选）
	few := deriveRoster([]Candidate{
		{ItemID: "article:1", AuthorID: authorA, Type: "article", BodyMD: longBody()},
		{ItemID: "article:2", AuthorID: authorB, Type: "article", BodyMD: longBody()},
		{ItemID: "article:3", AuthorID: authorC, Type: "article", BodyMD: longBody()},
	})
	if len(few) != 3 {
		t.Fatalf("不足 10 人应返回实际人数: %+v", few)
	}
}

// 名册只吃本节点可独立验证的数据：state != active、空归属、未达门槛一律跳过；同一 item 重写多次只计 1 条。
func TestContributorRosterFromStore(t *testing.T) {
	st, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = st.Close() }()

	put := func(itemID, body string) {
		if err := st.UpsertArticle(Article{
			ItemID: itemID, Title: itemID, BodyMD: body,
			ContentHash: protocol.SHA256Hex([]byte(body)), UpdatedAt: "2026-01-02T00:00:00Z",
		}); err != nil {
			t.Fatal(err)
		}
	}
	setAuthor := func(itemID, authorID string) {
		if _, err := st.db.Exec(`UPDATE items SET author_id=?, author_sig='00' WHERE item_id=?`, authorID, itemID); err != nil {
			t.Fatal(err)
		}
	}
	put("article/long", longBody())
	setAuthor("article/long", authorA)
	put("article/short", "短")
	setAuthor("article/short", authorB)
	put("article/removed", longBody())
	setAuthor("article/removed", authorB)
	if err := st.RetireItem("article/removed", 9); err != nil {
		t.Fatal(err)
	}
	put("article/no-author", longBody())

	got, err := st.ContributorRoster()
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || got[0].ID != authorA || got[0].Count != 1 {
		t.Fatalf("名册 = %+v, want 仅 %s 一条", got, authorA)
	}

	// 同一 item 连续重写 5 次 → 仍只计 1 条
	for i := 0; i < 5; i++ {
		put("article/long", longBody()+fmt.Sprintf("%d", i))
		setAuthor("article/long", authorA)
	}
	got, err = st.ContributorRoster()
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || got[0].Count != 1 {
		t.Fatalf("重写后计数应仍为 1: %+v", got)
	}
}

func TestPutProfileAndNames(t *testing.T) {
	st, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = st.Close() }()
	if err := st.PutProfile(authorA, "阿茶", 1); err != nil {
		t.Fatal(err)
	}
	if err := st.PutProfile(authorA, "阿茶二", 2); err != nil {
		t.Fatal(err)
	}
	if err := st.PutProfile(authorB, "无属性", 3); err != nil {
		t.Fatal(err)
	}
	names, err := st.ProfileNames([]string{authorA, authorC})
	if err != nil {
		t.Fatal(err)
	}
	if names[authorA] != "阿茶二" {
		t.Fatalf("昵称覆盖失败: %v", names)
	}
	if _, ok := names[authorC]; ok {
		t.Fatalf("未设置的 id 不应出现: %v", names)
	}
}
