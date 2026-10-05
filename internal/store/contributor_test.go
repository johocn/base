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

// —— T5：course / lesson 贡献载体扩展 ——

// putArticleWithAuthor 写一条达标的 article + 归属列。
func putArticleWithAuthor(t *testing.T, st *Store, itemID, authorID string) {
	t.Helper()
	body := longBody()
	if err := st.UpsertArticle(Article{
		ItemID: itemID, Title: itemID, BodyMD: body,
		ContentHash: protocol.SHA256Hex([]byte(body)), UpdatedAt: "2026-01-02T00:00:00Z",
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := st.db.Exec(`UPDATE items SET author_id=?, author_sig='00' WHERE item_id=?`, authorID, itemID); err != nil {
		t.Fatal(err)
	}
}

// putLesson 写一条 lesson（segments），子项为 children（每项是 {kind, itemID}）。
func putLesson(t *testing.T, st *Store, lessonID, authorID string, children []struct{ kind, itemID string }) {
	t.Helper()
	segs := make([]Segment, len(children))
	for i, ch := range children {
		segs[i] = Segment{Seq: i + 1, Kind: ch.kind, Text: ch.itemID}
	}
	if err := st.UpsertSegmentItem(SegmentItem{
		ItemID: lessonID, Source: "lesson", Type: "lesson",
		Title: lessonID, Segments: segs, UpdatedAt: "2026-01-02T00:00:00Z",
	}); err != nil {
		t.Fatal(err)
	}
	body := SegmentsContentHash(segs)
	if _, err := st.db.Exec(`UPDATE items SET author_id=?, author_sig='00', content_hash=?, source_rev=? WHERE item_id=?`,
		authorID, body, body[:16], lessonID); err != nil {
		t.Fatal(err)
	}
}

// putCourse 写一条 course（segments），子项为 lesson item_id 列表。
func putCourse(t *testing.T, st *Store, courseID, authorID string, lessonIDs []string) {
	t.Helper()
	segs := make([]Segment, len(lessonIDs))
	for i, lid := range lessonIDs {
		segs[i] = Segment{Seq: i + 1, Kind: "lesson", Text: lid}
	}
	if err := st.UpsertSegmentItem(SegmentItem{
		ItemID: courseID, Source: "course", Type: "course",
		Title: courseID, Segments: segs, UpdatedAt: "2026-01-02T00:00:00Z",
	}); err != nil {
		t.Fatal(err)
	}
	body := SegmentsContentHash(segs)
	if _, err := st.db.Exec(`UPDATE items SET author_id=?, author_sig='00', content_hash=?, source_rev=? WHERE item_id=?`,
		authorID, body, body[:16], courseID); err != nil {
		t.Fatal(err)
	}
}

// TestCourseAndLessonQualify：
// - course 达标（≥3 达标课时）→ course 计 1，且它下面的达标课时**不再计**；
// - lesson 达标（≥1 达标子项）→ lesson 计 1（父 course 不达标或无 course 时）；
// - 不达标载体不计贡献。
func TestCourseAndLessonQualify(t *testing.T) {
	st, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = st.Close() }()

	// authorA：一条达标 lesson（含 1 达标子项 article）+ 一条不达标 lesson。
	// authorA 的 article 与 lesson 同 author。
	putArticleWithAuthor(t, st, "article/a-pass", authorA)
	putLesson(t, st, "lesson/a-pass", authorA, []struct{ kind, itemID string }{{"article", "article/a-pass"}})
	putLesson(t, st, "lesson/a-fail", authorA, []struct{ kind, itemID string }{{"cover", "cover/xxx"}})

	// authorB：一条达标 course（3 个达标课时；每个课时含 1 个达标 article）。
	for i := 0; i < 3; i++ {
		aID := fmt.Sprintf("article/b-l%d", i)
		lID := fmt.Sprintf("lesson/b-l%d", i)
		putArticleWithAuthor(t, st, aID, authorB)
		putLesson(t, st, lID, authorB, []struct{ kind, itemID string }{{"article", aID}})
	}
	putCourse(t, st, "course/b", authorB, []string{"lesson/b-l0", "lesson/b-l1", "lesson/b-l2"})

	got, err := st.ContributorRoster()
	if err != nil {
		t.Fatal(err)
	}
	// authorA: article(1) + lesson(1, 无 course 归属) = 2
	// authorB: 3 article + course(1, course 达标吞掉 3 lesson) = 4
	want := []Contributor{{ID: authorB, Count: 4}, {ID: authorA, Count: 2}}
	if len(got) != len(want) {
		t.Fatalf("名册长度 = %d, want %d；got = %+v", len(got), len(want), got)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("第 %d 名 = %+v, want %+v", i, got[i], want[i])
		}
	}
}

// TestCourseMergeCountOne：course 达标 + 它有 3 个达标课时 → course 计 1，课时不再重复计（合并计 1）。
// article 作为子项仍单独计（规则未把 lesson 下的 article 合并）。
func TestCourseMergeCountOne(t *testing.T) {
	st, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = st.Close() }()

	// authorA 有 3 个达标课时 + 一个达标 course 把它们全收进去。
	for i := 0; i < 3; i++ {
		aID := fmt.Sprintf("article/a-l%d", i)
		lID := fmt.Sprintf("lesson/a-l%d", i)
		putArticleWithAuthor(t, st, aID, authorA)
		putLesson(t, st, lID, authorA, []struct{ kind, itemID string }{{"article", aID}})
	}
	putCourse(t, st, "course/a", authorA, []string{"lesson/a-l0", "lesson/a-l1", "lesson/a-l2"})

	got, err := st.ContributorRoster()
	if err != nil {
		t.Fatal(err)
	}
	// 3 article 各计 1；3 lesson 被 course 吞掉跳过；course 计 1 → 共 4。
	if len(got) != 1 || got[0].ID != authorA || got[0].Count != 4 {
		t.Fatalf("course 合并计 1 失败：got = %+v, want authorA count=4（3 article + 1 course）", got)
	}
}

// TestOrphanLessonsCountIndividually：无归属 course 的达标 lesson 各计 1（没有 course 包它们）。
func TestOrphanLessonsCountIndividually(t *testing.T) {
	st, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = st.Close() }()

	// authorA 有 2 个零散达标 lesson（没有 course 归属它们）。
	putArticleWithAuthor(t, st, "article/o0", authorA)
	putLesson(t, st, "lesson/o0", authorA, []struct{ kind, itemID string }{{"article", "article/o0"}})
	putArticleWithAuthor(t, st, "article/o1", authorA)
	putLesson(t, st, "lesson/o1", authorA, []struct{ kind, itemID string }{{"article", "article/o1"}})

	got, err := st.ContributorRoster()
	if err != nil {
		t.Fatal(err)
	}
	// 2 article 各计 1；2 lesson 各计 1（无父 course） → 共 4。
	if len(got) != 1 || got[0].ID != authorA || got[0].Count != 4 {
		t.Fatalf("零散课时未各自计：got = %+v, want authorA count=4（2 article + 2 lesson）", got)
	}
}

// TestLessonInFailedCourseStillCounts：course 不达标（只有 2 达标课时 < 3）→ 它下面的达标 lesson 仍各自计 1。
func TestLessonInFailedCourseStillCounts(t *testing.T) {
	st, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = st.Close() }()

	// authorA 有 2 个达标课时 + 一个 course 挂了它们，但 course 不达标（只有 2 < 3）。
	for i := 0; i < 2; i++ {
		aID := fmt.Sprintf("article/fc-l%d", i)
		lID := fmt.Sprintf("lesson/fc-l%d", i)
		putArticleWithAuthor(t, st, aID, authorA)
		putLesson(t, st, lID, authorA, []struct{ kind, itemID string }{{"article", aID}})
	}
	// course 只有 2 达标课时，不达标。
	putCourse(t, st, "course/fc", authorA, []string{"lesson/fc-l0", "lesson/fc-l1"})

	got, err := st.ContributorRoster()
	if err != nil {
		t.Fatal(err)
	}
	// course 不达标 → course 不计（1 跳过）；但两个达标 lesson **仍各自计 1**（父 course 没达标所以不吞）。
	// article 各计 1 → 2 + 2 = 4。
	if len(got) != 1 || got[0].ID != authorA || got[0].Count != 4 {
		t.Fatalf("course 不达标时课时未各自计：got = %+v, want authorA count=4（2 article + 2 lesson）", got)
	}
}

// TestContributorRosterExpansionCanLoseSmallNodeExemption：#74 风险 3 硬证据。
// 造一个小节点（authorA/authorB 各 4 达标 article → rosterLen=2 < 10 → threshold=1 豁免）。
// 再加入 authorC 的达标 course（3 达标课时）——改前 authorC 不计贡献（course/lesson 在 default 分支），
// rosterLen 仍 = 2 → 豁免；改后 authorC 进名册 → rosterLen=3 < 10 但阈值逻辑仍豁免？
// 不对——豁免触发条件是 rosterLen < DirectorySmallNodeRosterMax(10)。
// 改前 rosterLen=2 → 豁免 threshold=1；改后 rosterLen 可能从 2 变 3（仍 < 10，还是豁免）。
// 需要让改后 rosterLen 跨过 >= 10 才能失去豁免。

// 调整：造 10 个 author（authorA..authorJ），各 1 达标 article → rosterLen=10 → threshold=2。
// 再加 authorK 的达标 course → 改前 rosterLen 仍 = 10（截断），改前阈值 = 2；改后 authorK 进名册（但 rosterLen 截断到 10，authorK 没进前 10？要看排序——authorK 只有 1，排在第 11 位？）。
// 不对——直接造 11 个 author，各 1 达标 article → rosterLen=10（截断），再加 authorL 的达标 course 有 2 个课时计 1 → 总 author=12 → rosterLen=10，还是豁免？
// 正确构造：造一个 author 有多个 article，再加入 course 让 rosterLen 跨过 >= 10 阈值。
// 或者：改前 rosterLen < 10（豁免），改后 rosterLen >= 10（失去豁免）。
//
// 方案：造 9 个 author，各 1 达标 article + authorA 有 1 条达标 course →
// 改前：course 不计 → rosterLen 只有 9 个 authorA..authorI（各 1） → rosterLen=9 < 10 → threshold=1 豁免
// 改后：authorA 的 course 达标 + authorA 本来就有 1 article → authorA count=2 → 仍然在名册；
// 名册 = 9 个 author（authorA 2 条，authorB..authorI 各 1） → rosterLen=9 < 10 → 还是豁免？
//
// 根本问题：豁免阈值是 rosterLen < 10，而 RosterTopN 也是 10。要让 rosterLen 跨过 10，必须有 > 10 个达标 author。
// 造 11 个 author，各 1 达标 article → rosterLen=10（截断）。加第 12 个 author 的达标 course → authorL 计 1 → 排名 11 → 被截断，rosterLen 还是 10。
//
// 结论：rosterLen 永远 <= RosterTopN=10。那豁免阈值条件 rosterLen < 10 只能在名册不足 10 人时触发。
// 所以正确的"失去豁免"构造是：**改前 rosterLen < 10（豁免），改后 rosterLen = 10（不豁免）**。
// 即：改前有 N 个 author（N < 10）都计贡献，加 course 后改前还是 N；
// 改后 course 带来新 author → N+K，但 K 让 rosterLen 从 <10 变到 >=10。
//
// 构造：authorA..authorG（7 个 author，各 1 达标 article）→ rosterLen=7 < 10 → 豁免。
// 加 authorH 的达标 course（1 course + 3 lesson → authorH 计 1）。
// 改前 authorH 不计 → rosterLen=7 → threshold=1 豁免。
// 改后 authorH 计 → rosterLen=8 < 10 → 还是豁免？
// 再加 authorI、authorJ...直到 rosterLen 从改前的 7 变改后的 10+。
// 改前 N=7（authorA..authorG 各 1 article），改前 authorH..authorK 的 course 不计 → rosterLen=7。
// 改后 authorH、authorI、authorJ、authorK 的 course 各计 1 → rosterLen=11 → 截断到 10 → threshold=2。
// 但我们要 rosterLen（截断前）在改后是 >= 10？不——ContributorRoster 截断到 10，rosterLen 永远 <= 10。
// 正确对比：改前 rosterLen=7（截断后）→ threshold=1；改后 rosterLen=10（截断后）→ threshold=2。
func TestContributorRosterExpansionCanLoseSmallNodeExemption(t *testing.T) {
	st, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = st.Close() }()

	// 先造 7 个 author（A..G），各 1 达标 article。
	for i := 0; i < 7; i++ {
		id := fmt.Sprintf("%032x", i+1) // "00000000..." ~ "00000000000000000000000000000007"
		putArticleWithAuthor(t, st, fmt.Sprintf("article/base%d", i), id)
	}

	// 再造 4 个 author（H..K），各有 1 条达标 course（3 达标课时）。
	for i := 0; i < 4; i++ {
		id := fmt.Sprintf("%032x", 100+i) // 100, 101, 102, 103
		courseID := fmt.Sprintf("course/new%d", i)
		lessonIDs := []string{}
		for j := 0; j < 3; j++ {
			aID := fmt.Sprintf("article/new%d-l%d", i, j)
			lID := fmt.Sprintf("lesson/new%d-l%d", i, j)
			putArticleWithAuthor(t, st, aID, id)
			putLesson(t, st, lID, id, []struct{ kind, itemID string }{{"article", aID}})
			lessonIDs = append(lessonIDs, lID)
		}
		putCourse(t, st, courseID, id, lessonIDs)
	}

	got, err := st.ContributorRoster()
	if err != nil {
		t.Fatal(err)
	}
	rosterLen := len(got)

	// 改前（course/lesson 在 default 分支不计贡献）：只有 7 个 authorA..G 进名册 → rosterLen=7 < 10 → threshold=1。
	// 这里我们用当前代码走真实派生——改后 course/lesson 扩展生效，rosterLen 应该变成 10（7+4=11 截断到 10）。
	// 验证：
	t.Logf("改前（旧代码下）预期 rosterLen=7 → threshold=1（豁免）")
	t.Logf("改后（新代码下）实测 rosterLen=%d", rosterLen)
	if rosterLen < 10 {
		t.Fatalf("改后 rosterLen 应 >= 10（使豁免失效），实得 %d", rosterLen)
	}

	threshold := GovernThresholdForRoster(GovernActionDirectoryAdd, rosterLen, true)
	t.Logf("改后 threshold=%d", threshold)
	if threshold != 2 {
		t.Fatalf("改后 threshold 应 =2（失去豁免），实得 %d", threshold)
	}

	// 额外：断言改前（旧代码下）GovernThresholdForRoster 应 =1——这里用纯函数模拟"改前"逻辑：
	// 把那 4 个 course author 的 item type 都当成 default → 不计贡献 → rosterLen=7 < 10 → threshold=1。
	// 我们直接断言："如果只算 article，名册长度 = 7"。
	// 用 deriveRoster 纯函数模拟改前：所有 course/lesson Candidate 都不计。
	legacyCands := []Candidate{}
	for i := 0; i < 7; i++ {
		id := fmt.Sprintf("%032x", i+1)
		legacyCands = append(legacyCands, Candidate{
			ItemID: fmt.Sprintf("article/base%d", i), AuthorID: id, Type: "article", BodyMD: longBody(),
		})
	}
	legacyRoster := deriveRoster(legacyCands)
	if len(legacyRoster) != 7 {
		t.Fatalf("改前模拟：article-only 名册长度 = %d, want 7", len(legacyRoster))
	}
	if got := GovernThresholdForRoster(GovernActionDirectoryAdd, len(legacyRoster), true); got != 1 {
		t.Fatalf("改前模拟 threshold = %d, want 1（豁免）", got)
	}
}

// —— Task 3: 贡献层资格派生（补齐算法）——

func newTestStoreForContributor(t *testing.T) *Store {
	t.Helper()
	st, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	return st
}

// seedContributorItems 写入 N 个作者（authorIDs）各 1 条达标的 article，让他们进贡献者集合。
// 不注册 identities——测试补齐逻辑时 identities 由 seedIdentities 单独控制。
func seedContributorItems(t *testing.T, st *Store, authorIDs []string) {
	t.Helper()
	for _, id := range authorIDs {
		body := longBody()
		itemID := "article/" + id
		if err := st.UpsertArticle(Article{
			ItemID: itemID, Title: itemID, BodyMD: body,
			ContentHash: protocol.SHA256Hex([]byte(body)), UpdatedAt: "2026-01-02T00:00:00Z",
		}); err != nil {
			t.Fatal(err)
		}
		if _, err := st.db.Exec(`UPDATE items SET author_id=?, author_sig='00' WHERE item_id=?`, id, itemID); err != nil {
			t.Fatal(err)
		}
	}
}

// seedIdentities 批量注册身份，created_at 按传入顺序递增（先传的更早注册）。
func seedIdentities(t *testing.T, st *Store, ids []string) {
	t.Helper()
	for i, id := range ids {
		if _, err := st.RegisterIdentity(id, "ed25519", "pub_"+id, int64(1000+i)); err != nil {
			t.Fatal(err)
		}
	}
}

func TestDeriveContributionRoster_PaddingWithEarliestIDs(t *testing.T) {
	// 贡献者只有 3 人 → 初创期 ID 补齐到 10
	st := newTestStoreForContributor(t)
	defer func() { _ = st.Close() }()
	seedContributorItems(t, st, []string{"A", "B", "C"})
	seedIdentities(t, st, []string{"EARLIEST_0", "EARLIEST_1", "EARLIEST_2", "EARLIEST_3", "EARLIEST_4", "EARLIEST_5", "EARLIEST_6", "EARLIEST_7", "EARLIEST_8", "EARLIEST_9"})

	roster, err := st.DeriveContributionRoster()
	if err != nil {
		t.Fatal(err)
	}
	if len(roster) != 10 {
		t.Fatalf("期望恒 10 人，实际 %d: %v", len(roster), roster)
	}
	if roster[0] != "A" || roster[1] != "B" || roster[2] != "C" {
		t.Fatalf("前 3 应为贡献者 A/B/C，实际 %v", roster[:3])
	}
	if roster[3] != "EARLIEST_0" {
		t.Fatalf("补齐应从 EARLIEST_0 开始，实际 %v", roster)
	}
}

func TestDeriveContributionRoster_EmptyContributors_AllEarliestIDs(t *testing.T) {
	// 零贡献者 → 前 10 注册 ID 全额生效
	st := newTestStoreForContributor(t)
	defer func() { _ = st.Close() }()
	seedIdentities(t, st, []string{"ID_0", "ID_1", "ID_2", "ID_3", "ID_4", "ID_5", "ID_6", "ID_7", "ID_8", "ID_9", "ID_10"})

	roster, err := st.DeriveContributionRoster()
	if err != nil {
		t.Fatal(err)
	}
	if len(roster) != 10 {
		t.Fatalf("期望恒 10 人，实际 %d", len(roster))
	}
	for i, id := range roster {
		expected := fmt.Sprintf("ID_%d", i)
		if id != expected {
			t.Fatalf("位置 %d 应为 %s，实际 %s (全部: %v)", i, expected, id, roster)
		}
	}
}

func TestDeriveContributionRoster_MoreThan10Contributors_Top10Only(t *testing.T) {
	// 贡献者 12 人 → 初创期 ID 不出现
	st := newTestStoreForContributor(t)
	defer func() { _ = st.Close() }()
	seedContributorItems(t, st, []string{"A0", "A1", "A2", "A3", "A4", "A5", "A6", "A7", "A8", "A9", "A10", "A11"})
	seedIdentities(t, st, []string{"EARLIEST_0", "EARLIEST_1", "EARLIEST_2"})

	roster, err := st.DeriveContributionRoster()
	if err != nil {
		t.Fatal(err)
	}
	if len(roster) != 10 {
		t.Fatalf("期望恒 10 人，实际 %d", len(roster))
	}
	for _, id := range roster {
		if strings.HasPrefix(id, "EARLIEST_") {
			t.Fatalf("贡献者已满 10 时不应出现初创期 ID，实际 %v", roster)
		}
	}
}
