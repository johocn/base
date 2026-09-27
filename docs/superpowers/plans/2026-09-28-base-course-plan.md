# 课程体系（course → lesson → article/video/quiz）落地 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `item_id` 切到路径式命名空间（`course/<cid>/lesson/<lid>/<kind>/<slug>`），借 `segments` 表承载课程/课时容器（零新表零新字段），本地导入器按 front-matter 产出归属与顺序，手机端落三级浏览与「未归类」分组；旧 `<source>:<slug>` 条目按 `-retire-legacy` 开关一次性墓碑退役。

**Architecture:** 五处链路一次性打通 `segments`——节点写读（`internal/store`）、导出（`internal/packexport`）、入库（`internal/store.ImportPack`）、跨节点读包校验（`internal/peersync`）、手机端建表与读取（`apps/mobile/src/core`）。容器条目与载体条目同处 `items` 表，归属靠 `item_id` 前缀表达，顺序靠 `segments.seq` 表达；`manifest.json` 仍扁平，`pack.sqlite` 仍是五张表。手机端旧 id 用户数据（`user_state` / `quiz_attempt`）走一次性启发式平移。

**Tech Stack:** Go 1.22+（`modernc.org/sqlite`）、uni-app（Vue 3 + TS）、vitest（node 环境）、`core/fakes.ts` 假适配器、`@base/protocol-ts`。

**上游 spec:** `docs/superpowers/specs/2026-09-28-base-course-design.md`（#14，本计划是它的实现展开，冲突时以 spec 为准）

**基线:** `go build ./...` / `go test ./...` 全包通过；mobile `npx vitest run` 96/96、`npx tsc --noEmit` 干净（0.6.0）。

---

## 文件结构

| 路径 | 动作 | 职责 |
| --- | --- | --- |
| `internal/store/segments.go` | 新建 | `Segment` / `SegmentItem` 结构、`SegmentsContentHash`、`UpsertSegmentItem`、`ListSegments`、`RetireItem`、`NextContentVersion` |
| `internal/store/segments_test.go` | 新建 | 写读往返、哈希口径稳定、退役与版本口径 |
| `internal/store/packimport.go` | 修改 | 墓碑清理补 `DELETE FROM segments`；`PackEntry` 加 `Segments`；`switch e.SQLiteTable` 补 `segments` 分支 |
| `internal/store/packimport_test.go` | 修改 | 补「墓碑连带清 segments」用例 |
| `internal/packexport/export.go` | 修改 | 白名单常量化 `exportableTables`；`writePackSQLite` 补 `segments` 写出分支 |
| `internal/packexport/segments_test.go` | 新建 | 白名单仍是显式集合；segments 导出记录、顺序与确定性 |
| `internal/peersync/packimport.go` | 修改 | `readAndVerifyPack` 补 `segments` 行级校验分支 |
| `internal/peersync/packimport_test.go` | 修改 | 补 segments 读包校验用例（含篡改拒绝） |
| `internal/importer/course.go` | 新建 | 归属解析 `resolvePlacement`、列表合并 `mergeChildren`、容器重建 `rebuildContainers`、`ensureLessonChild` |
| `internal/importer/md.go` | 修改 | `Doc` 增课程字段；`Run` 改 `Run(st, dir, opts)` 两阶段；载体 id 走 `course.go`；新增 `-retire-legacy` |
| `internal/importer/video.go` | 修改 | `VideoOptions` 增 `Course` / `Lesson`（必填）；id 改 `.../video/<slug>`；导入后并入课时清单 |
| `internal/importer/md_test.go`、`quiz_test.go`、`video_test.go` | 修改 | 调用点与 id 断言同步到新命名空间 |
| `internal/importer/course_test.go` | 新建 | spec §4.2 六条规则 + 顺序确定性 + 幂等 |
| `internal/httpapi/web.go` | 修改 | `coverBlobID` 改 `item_id + "/cover"` |
| `internal/httpapi/server.go` | 修改 | 公开文章路由改 `GET /a/{item_id...}`（id 含 `/`） |
| `internal/httpapi/httpapi_test.go`、`web_test.go` | 修改 | 夹具与断言切到 `article/aaa` 等新形态 |
| `cmd/based/import.go` | 修改 | 新增 `-retire-legacy` 开关，调用新签名 |
| `cmd/based/importvideo.go` | 修改 | 新增 `-course` / `-lesson`（必填） |
| `apps/mobile/src/core/types.ts` | 修改 | 新增 `SegmentRow` |
| `apps/mobile/src/core/repo.ts` | 修改 | `SCHEMA_SQL` 加 `segments`；`PackApply` 加 `segments`；`applyPack` 写/删 segments；`LocalRepo` 加 `listSegments` / `listLocalItemIds` / `renameItemId` |
| `apps/mobile/src/core/sync.ts` | 修改 | `readPackSegments` + 行级/条目级 hash 校验 + 行数守卫 + 落库 + 触发 id 平移 |
| `apps/mobile/src/core/fakes.ts` | 修改 | `MemoryRepo` 实现 3 个新方法；`FakePackReader` 支持 `segments` |
| `apps/mobile/src/core/course-tree.ts` | 新建 | 纯逻辑：前缀切树 + `seq` 排序 + 「未归类」集合 |
| `apps/mobile/src/core/course-tree.test.ts` | 新建 | 树形切分与排序用例 |
| `apps/mobile/src/core/id-migrate.ts` | 新建 | 一次性幂等平移（末段匹配、多候选放弃、打标） |
| `apps/mobile/src/core/id-migrate.test.ts` | 新建 | spec §5.3 六条规则用例 |
| `apps/mobile/src/pages/course/course.vue` | 修改 | 主页改「课程」+「未归类」两组 |
| `apps/mobile/src/pages/course/detail.vue` | 新建 | 课程详情：课时按 `seq` 排序、「第 N 讲 + 标题」、单载体直达 |
| `apps/mobile/src/pages/article/article.vue` | 修改 | 封面路径改 `row.itemId + '/cover'` |
| `apps/mobile/src/pages.json` | 修改 | 注册 `pages/course/detail` |
| `apps/mobile/src/manifest.json` | 修改 | `versionName 0.7.0` / `versionCode 8` |

约定：Go 命令的工作目录是 `e:\code\base`；mobile 命令的工作目录是 `e:\code\base\apps\mobile`。

**本机环境（0.6.0 踩过的坑，照做）**：PowerShell 5.1 **不支持 `&&`**，多条命令拆行执行；Go 在 `D:\Go`，Shell 里先跑 `$env:PATH='D:\go\bin;D:\gopath\bin;'+$env:PATH`；`git` 前先 `$env:Path += ";C:\Program Files\Git\cmd"`；ssh 远程命令里不要用双引号（`sed` 的引号除外）。

---

### Task 1: 节点 store——segments 读写与旧条目退役

**Files:**
- Create: `internal/store/segments.go`
- Create: `internal/store/segments_test.go`
- Modify: `internal/store/packimport.go`
- Modify: `internal/store/packimport_test.go`

`segments` 表 DDL 已在 `internal/store/schema.go` 第 39–46 行存在，**本任务不建表**，只补读写与退役动作。

- [ ] **Step 1: 先写失败测试 `internal/store/segments_test.go`**

```go
package store

import (
	"testing"

	"github.com/johocn/base/internal/protocol"
)

func TestSegmentsRoundTripAndHash(t *testing.T) {
	st, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()

	segs := []Segment{
		{Seq: 0, Kind: "digest", Text: "从哈希寻址讲到 Merkle 清单"},
		{Seq: 1, Kind: "lesson", Text: "course/c1/lesson/l1"},
		{Seq: 2, Kind: "lesson", Text: "course/c1/lesson/l2"},
	}
	if err := st.UpsertSegmentItem(SegmentItem{
		ItemID: "course/c1", Source: "course", Type: "course", Title: "内容寻址入门", Segments: segs,
	}); err != nil {
		t.Fatalf("UpsertSegmentItem: %v", err)
	}

	got, err := st.ListSegments("course/c1")
	if err != nil || len(got) != 3 {
		t.Fatalf("ListSegments = %d 行, err=%v", len(got), err)
	}
	for i, s := range got {
		if s.Seq != i {
			t.Fatalf("第 %d 行 seq = %d（必须按 seq 升序读回）", i, s.Seq)
		}
		if s.ContentHash != protocol.SHA256Hex([]byte(s.Text)) {
			t.Fatalf("行级 hash 口径不符: %+v", s)
		}
	}
	it, ok, _ := st.GetItem("course/c1")
	if !ok || it.SQLiteTable != "segments" || it.Source != "course" || it.Type != "course" {
		t.Fatalf("条目行异常: %+v ok=%v", it, ok)
	}
	if it.ContentHash != SegmentsContentHash(segs) {
		t.Fatalf("条目级 hash 口径不符: %s != %s", it.ContentHash, SegmentsContentHash(segs))
	}

	// 幂等重写：同 item_id 再写一次，行数不叠加、顺序不漂移
	if err := st.UpsertSegmentItem(SegmentItem{
		ItemID: "course/c1", Source: "course", Type: "course", Title: "改了标题", Segments: segs[:2],
	}); err != nil {
		t.Fatal(err)
	}
	got2, _ := st.ListSegments("course/c1")
	if len(got2) != 2 {
		t.Fatalf("重写后行数 = %d, want 2（先删同 item_id 旧行）", len(got2))
	}
}

func TestSegmentsContentHashIsStable(t *testing.T) {
	segs := []Segment{{Seq: 0, Kind: "digest", Text: "简介"}, {Seq: 1, Kind: "video", Text: "course/c/lesson/l/video/v"}}
	if SegmentsContentHash(segs) != SegmentsContentHash(append([]Segment{}, segs...)) {
		t.Fatal("同一份 segments 的条目级 hash 必须相等")
	}
	// 口径写死：按 seq 升序拼接 "<kind>\t<text>\n"
	want := protocol.SHA256Hex([]byte("digest\t简介\nvideo\tcourse/c/lesson/l/video/v\n"))
	if SegmentsContentHash(segs) != want {
		t.Fatalf("拼接口径不符: %s != %s", SegmentsContentHash(segs), want)
	}
}

func TestRetireItemAndNextContentVersion(t *testing.T) {
	st, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	if v, err := st.BumpContentVersion(); err != nil || v != 1 {
		t.Fatalf("BumpContentVersion = %d, err=%v", v, err)
	}
	next, err := st.NextContentVersion()
	if err != nil || next != 2 {
		t.Fatalf("NextContentVersion = %d, err=%v（只读，不递增）", next, err)
	}
	if again, _ := st.NextContentVersion(); again != 2 {
		t.Fatalf("NextContentVersion 不得改变计数器: %d", again)
	}

	if err := st.UpsertArticle(Article{ItemID: "article:old", Title: "旧", BodyMD: "旧正文",
		ContentHash: protocol.SHA256Hex([]byte("旧正文")), SourceRev: "r"}); err != nil {
		t.Fatal(err)
	}
	if err := st.RetireItem("article:old", next); err != nil {
		t.Fatalf("RetireItem: %v", err)
	}
	it, ok, _ := st.GetItem("article:old")
	if !ok || it.State != "removed" {
		t.Fatalf("退役后 state 应为 removed: %+v ok=%v", it, ok)
	}
	active, _ := st.ListItems("active")
	if len(active) != 0 {
		t.Fatalf("退役条目不应出现在 active 列表: %+v", active)
	}
	ts, _ := st.ListTombstones()
	if len(ts) != 1 || ts[0].ItemID != "article:old" || ts[0].RevokedRev != 2 {
		t.Fatalf("墓碑异常: %+v", ts)
	}
}
```

- [ ] **Step 2: 跑失败**

Run（cwd `e:\code\base`）:

```bash
$env:PATH='D:\go\bin;D:\gopath\bin;'+$env:PATH
go test ./internal/store/ -run 'Segments|RetireItem' -v
```

Expected: 编译失败（`undefined: Segment` / `SegmentItem` / `SegmentsContentHash` / `RetireItem` / `NextContentVersion`）。

- [ ] **Step 3: 实现 `internal/store/segments.go`**

```go
package store

import (
	"database/sql"
	"errors"
	"fmt"
	"sort"
	"strconv"
	"strings"

	"github.com/johocn/base/internal/protocol"
)

// Segment 是 segments 表的一行（册子 §3.1）。
// seq=0 固定留给简介（kind=digest），seq>=1 固定为子项清单；text 是子项的 item_id。
type Segment struct {
	ItemID      string
	Seq         int
	Kind        string
	Text        string
	ContentHash string
}

// SegmentItem 是一个待写入的 segments 类条目（course 或 lesson 容器）。
// Segments 必须按 seq 升序、seq 从 0 起连续；缺简介时可省略 seq=0，子项仍从 1 起。
type SegmentItem struct {
	ItemID    string
	Source    string // course | lesson
	Type      string // course | lesson
	Title     string
	Segments  []Segment
	UpdatedAt string
}

// SegmentsContentHash 是条目级 content_hash：按 seq 升序拼接 "<kind>\t<text>\n" 的 UTF-8 字节（册子 §3.3）。
// 拼接形状写死是确定性导出的前提，勿改。
func SegmentsContentHash(segs []Segment) string {
	ordered := append([]Segment{}, segs...)
	sort.Slice(ordered, func(i, j int) bool { return ordered[i].Seq < ordered[j].Seq })
	var b strings.Builder
	for _, s := range ordered {
		b.WriteString(s.Kind)
		b.WriteByte('\t')
		b.WriteString(s.Text)
		b.WriteByte('\n')
	}
	return protocol.SHA256Hex([]byte(b.String()))
}

// UpsertSegmentItem 幂等写入一个容器条目（items + segments 同事务）：
// 先 upsert items，再删同 item_id 的旧 segments 行，最后按 seq 升序逐行写入。
func (s *Store) UpsertSegmentItem(it SegmentItem) error {
	if strings.TrimSpace(it.ItemID) == "" {
		return fmt.Errorf("store: segment item_id 不能为空")
	}
	ordered := append([]Segment{}, it.Segments...)
	sort.Slice(ordered, func(i, j int) bool { return ordered[i].Seq < ordered[j].Seq })
	hash := SegmentsContentHash(ordered)
	updated := it.UpdatedAt
	if updated == "" {
		updated = nowUTC()
	}
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	if _, err := tx.Exec(`INSERT INTO items(item_id,source,type,title,source_rev,content_hash,sqlite_table,dist_class,state,updated_at)
		VALUES(?,?,?,?,?,?,?,'public','active',?)
		ON CONFLICT(item_id) DO UPDATE SET
			source=excluded.source, type=excluded.type, title=excluded.title, source_rev=excluded.source_rev,
			content_hash=excluded.content_hash, sqlite_table=excluded.sqlite_table,
			dist_class=excluded.dist_class, state=excluded.state, updated_at=excluded.updated_at`,
		it.ItemID, it.Source, it.Type, it.Title, hash[:16], hash, "segments", updated); err != nil {
		return fmt.Errorf("store: upsert segment item: %w", err)
	}
	if _, err := tx.Exec(`DELETE FROM segments WHERE item_id=?`, it.ItemID); err != nil {
		return fmt.Errorf("store: 清旧 segments: %w", err)
	}
	for _, seg := range ordered {
		if _, err := tx.Exec(`INSERT INTO segments(item_id,seq,kind,text,content_hash) VALUES(?,?,?,?,?)`,
			it.ItemID, seg.Seq, seg.Kind, seg.Text, protocol.SHA256Hex([]byte(seg.Text))); err != nil {
			return fmt.Errorf("store: 写 segments %s seq=%d: %w", it.ItemID, seg.Seq, err)
		}
	}
	return tx.Commit()
}

// ListSegments 按 seq 升序返回某条目的 segments 行。
func (s *Store) ListSegments(itemID string) ([]Segment, error) {
	rows, err := s.db.Query(`SELECT item_id,seq,kind,text,content_hash FROM segments WHERE item_id=? ORDER BY seq ASC`, itemID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Segment{}
	for rows.Next() {
		var seg Segment
		if err := rows.Scan(&seg.ItemID, &seg.Seq, &seg.Kind, &seg.Text, &seg.ContentHash); err != nil {
			return nil, err
		}
		out = append(out, seg)
	}
	return out, rows.Err()
}

// RetireItem 退役一个条目：写墓碑（revoked_rev 取大值覆盖）并置 state='removed'（册子 §2.2）。
// 只置状态不删行：内容行与块文件保留在源节点，旧条目自此不进 active 列表、不参与导出；
// 接收侧按 manifest 里的墓碑走既有删除路径。
func (s *Store) RetireItem(itemID string, revokedRev int64) error {
	if _, err := s.db.Exec(`INSERT INTO tombstones(item_id,revoked_rev) VALUES(?,?)
		ON CONFLICT(item_id) DO UPDATE SET revoked_rev=MAX(revoked_rev,excluded.revoked_rev)`, itemID, revokedRev); err != nil {
		return fmt.Errorf("store: 退役写墓碑 %s: %w", itemID, err)
	}
	if _, err := s.db.Exec(`UPDATE items SET state='removed' WHERE item_id=?`, itemID); err != nil {
		return fmt.Errorf("store: 退役置状态 %s: %w", itemID, err)
	}
	return nil
}

// NextContentVersion 返回下一次导出将使用的全局 content_version（只读，不递增）。
// 用于把「退役生效版本」与紧随其后的那次导出版本对齐（册子 §2.2）。
func (s *Store) NextContentVersion() (int64, error) {
	var raw string
	err := s.db.QueryRow(`SELECT value FROM meta WHERE key=?`, metaContentVersion).Scan(&raw)
	if errors.Is(err, sql.ErrNoRows) {
		return 1, nil
	}
	if err != nil {
		return 0, err
	}
	cur, err := strconv.ParseInt(raw, 10, 64)
	if err != nil {
		return 0, fmt.Errorf("store: bad content_version %q", raw)
	}
	return cur + 1, nil
}
```

- [ ] **Step 4: `internal/store/packimport.go` 补 segments 的入库与墓碑清理**

四处改动：

1. `PackEntry` 结构体末尾追加字段：

```go
	// SQLiteTable == "segments"
	Segments []Segment
```

2. 墓碑清理的语句列表（`for _, q := range []string{...}`）里补一条 `DELETE FROM segments WHERE item_id=?`（放在 `articles` 之后即可）。

3. 条目入库 `switch e.SQLiteTable` 在 `case "articles":` 之前插入 `case "segments":`：

```go
		case "segments":
			ordered := append([]Segment{}, e.Segments...)
			sort.Slice(ordered, func(i, j int) bool { return ordered[i].Seq < ordered[j].Seq })
			if _, err := tx.Exec(`DELETE FROM segments WHERE item_id=?`, e.ItemID); err != nil {
				return res, fmt.Errorf("store: 入库 segments 清旧行 %s: %w", e.ItemID, err)
			}
			for _, seg := range ordered {
				if _, err := tx.Exec(`INSERT INTO segments(item_id,seq,kind,text,content_hash) VALUES(?,?,?,?,?)`,
					e.ItemID, seg.Seq, seg.Kind, seg.Text, protocol.SHA256Hex([]byte(seg.Text))); err != nil {
					return res, fmt.Errorf("store: 入库 segments %s seq=%d: %w", e.ItemID, seg.Seq, err)
				}
			}
```

（`sort` 需加入本文件 import。）

4. 文件头 `PackEntry` 的注释「只承载 P0 真实存在的两族」改成三族表述（articles / media_meta / segments / quizzes），避免注释与实现漂移。

- [ ] **Step 5: `internal/store/packimport_test.go` 补墓碑用例**

追加一个用例：先 `UpsertSegmentItem("course:old")`（id 含 `:` 无关紧要，只是夹具），再 `ImportPack(6, nil, []protocol.Tombstone{{ItemID: "course:old", RevokedRev: 6}})`，断言 `ListSegments("course:old")` 返回 0 行且 `GetItem` 不存在。

- [ ] **Step 6: 跑通**

```bash
go test ./internal/store/ -v
```

Expected: 全部 ok（含既有用例）。

---

### Task 2: packexport——白名单常量化与 segments 导出

**Files:**
- Modify: `internal/packexport/export.go`
- Create: `internal/packexport/segments_test.go`

- [ ] **Step 1: 先写失败测试 `internal/packexport/segments_test.go`**

覆盖 spec §7.1 第 1、2、3 条：

```go
package packexport

import (
	"database/sql"
	"path/filepath"
	"testing"

	_ "modernc.org/sqlite"

	"github.com/johocn/base/internal/store"
	"github.com/johocn/base/internal/protocol"
)

func TestExportRejectsNonWhitelistedTable(t *testing.T) {
	dir := t.TempDir()
	st, err := store.Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()

	// 直接往 items 里塞一个 sqlite_table=events 的条目：白名单必须仍是显式集合
	db, err := sql.Open("sqlite", "file:"+filepath.ToSlash(filepath.Join(dir, "base.db")))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if _, err := db.Exec(`INSERT INTO items(item_id,source,type,title,source_rev,content_hash,sqlite_table,dist_class,state,updated_at)
		VALUES('wall/1','wall','wall','t','r','h','events','public','active','2026-01-01T00:00:00Z')`); err != nil {
		t.Fatal(err)
	}
	if _, err := Export(st, fixedOptions(st)); err == nil {
		t.Fatal("非白名单 sqlite_table 必须报错")
	}
}

func TestExportSegmentsRoundTrip(t *testing.T) {
	st, _ := seedStore(t)
	segs := []store.Segment{
		{Seq: 0, Kind: "digest", Text: "课程简介"},
		{Seq: 1, Kind: "lesson", Text: "course/c1/lesson/l1"},
	}
	if err := st.UpsertSegmentItem(store.SegmentItem{
		ItemID: "course/c1", Source: "course", Type: "course", Title: "课程一", Segments: segs,
	}); err != nil {
		t.Fatal(err)
	}
	res, err := Export(st, fixedOptions(st))
	if err != nil {
		t.Fatalf("Export: %v", err)
	}
	db, err := sql.Open("sqlite", "file:"+filepath.ToSlash(res.PackPath)+"?mode=ro")
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	rows, err := db.Query(`SELECT seq,kind,text,content_hash FROM segments WHERE item_id='course/c1' ORDER BY seq ASC`)
	if err != nil {
		t.Fatalf("pack.segments: %v", err)
	}
	defer rows.Close()
	n := 0
	for rows.Next() {
		var seq int
		var kind, text, hash string
		if err := rows.Scan(&seq, &kind, &text, &hash); err != nil {
			t.Fatal(err)
		}
		if seq != n || kind != segs[n].Kind || text != segs[n].Text {
			t.Fatalf("第 %d 行不符: %d/%s/%s", n, seq, kind, text)
		}
		if hash != protocol.SHA256Hex([]byte(text)) {
			t.Fatalf("行级 hash 不符: %s", hash)
		}
		n++
	}
	if n != 2 {
		t.Fatalf("pack.segments = %d 行, want 2", n)
	}
	var entry *protocol.Entry
	for i := range res.Manifest.Entries {
		if res.Manifest.Entries[i].ItemID == "course/c1" {
			entry = &res.Manifest.Entries[i]
		}
	}
	if entry == nil || entry.SQLiteTable != "segments" || entry.ContentHash != store.SegmentsContentHash(segs) {
		t.Fatalf("manifest 条目异常: %+v", entry)
	}

	// 确定性：同参数两次导出字节一致
	second, err := Export(st, fixedOptions(st))
	if err != nil {
		t.Fatal(err)
	}
	if second.PackSHA256 != res.PackSHA256 {
		t.Fatalf("含 segments 的导出必须字节一致: %s != %s", second.PackSHA256, res.PackSHA256)
	}
}
```

- [ ] **Step 2: 跑失败**

```bash
go test ./internal/packexport/ -run 'Whitelist|Segments' -v
```

Expected: `TestExportSegmentsRoundTrip` 因 pack 里没有 segments 行而失败（导出静默跳过）；白名单用例此刻可能已通过（现有硬编码判断同样拒绝 `events`），实现后必须仍然通过。

- [ ] **Step 3: 改 `internal/packexport/export.go`**

1. 把第 91–98 行的硬编码三连判断换成显式白名单常量：

```go
// exportableTables 是可导出 sqlite_table 的**显式白名单**。
// 放宽一条就松掉一条护栏（册子 §10 风险 1），故保持集合式判断，不做前缀/正则匹配。
var exportableTables = map[string]bool{
	"articles":   true,
	"media_meta": true,
	"quizzes":    true,
	"segments":   true,
}
```

循环体改为：

```go
		if !exportableTables[it.SQLiteTable] {
			return Result{}, fmt.Errorf("packexport: 条目 %s 的 sqlite_table=%s 不在可导出白名单内", it.ItemID, it.SQLiteTable)
		}
```

2. `writePackSQLite` 的 `switch e.SQLiteTable` 补 `case "segments":`（放在 `case "media_meta":` 之后）：

```go
		case "segments":
			segs, err := st.ListSegments(e.ItemID)
			if err != nil {
				_ = tx.Rollback()
				_ = db.Close()
				return err
			}
			if len(segs) == 0 {
				_ = tx.Rollback()
				_ = db.Close()
				return fmt.Errorf("packexport: 条目 %s 在 segments 表缺失", e.ItemID)
			}
			for _, seg := range segs {
				if _, err := tx.Exec(`INSERT INTO segments(item_id,seq,kind,text,content_hash) VALUES(?,?,?,?,?)`,
					seg.ItemID, seg.Seq, seg.Kind, seg.Text, seg.ContentHash); err != nil {
					_ = tx.Rollback()
					_ = db.Close()
					return err
				}
			}
```

`ListSegments` 已按 `seq` 升序返回，写入顺序即确定；条目循环本身按 `item_id` 升序（第 99 行已有 `sort.Slice`），故导出保持确定性。

- [ ] **Step 4: 跑通**

```bash
go test ./internal/packexport/ -v
```

Expected: 全部 ok。

---

### Task 3: peersync——跨节点读包补 segments 行级校验

**Files:**
- Modify: `internal/peersync/packimport.go`
- Modify: `internal/peersync/packimport_test.go`

现状：`readAndVerifyPack` 只读 `meta` / `articles` / `media_meta`，`switch` 的 `default` 对 `quizzes` 与 `segments` 一律报「不支持入库」。`quizzes` 的缺失是既有缺口（pack 里已导出 quizzes 但读包不认），本任务**一并补上 quizzes 与 segments 两个分支**——否则课程页与答题页在跨节点复制后都是空的。

- [ ] **Step 1: 先写失败测试**

在 `internal/peersync/packimport_test.go` 追加（复用该文件既有的「造包 → 篡改 → 断言整包拒绝」夹具风格）：

1. 用例 A：源节点写一个 `course/c1`（`UpsertSegmentItem`）+ 一个 `course/c1/lesson/l1/quiz/q1`（`UpsertQuiz`）+ 一篇文章 → 导出 → `readAndVerifyPack` 成功 → `st.ImportPack` → 断言 `ListSegments("course/c1")` 与 `ListQuizzes` 均有行。
2. 用例 B：把 pack 里 `segments` 某行的 `text` 改掉（但不改 `content_hash`）→ `readAndVerifyPack` 必须报错（行级 hash 不符）。

- [ ] **Step 2: 跑失败**

```bash
go test ./internal/peersync/ -run 'Pack' -v
```

Expected: 出现 `manifest 条目 ... sqlite_table="segments" 不支持入库` / `"quizzes" 不支持入库`。

- [ ] **Step 3: 改 `readAndVerifyPack`**

1. 在读 `articles` 之后，追加读 `quizzes` 与 `segments` 两张表：

```go
	type quizRow struct{ questionJSON, contentHash string }
	quizzes := map[string]quizRow{}
	rows, err = db.Query(`SELECT item_id,question_json,content_hash FROM quizzes`)
	// …扫描进 quizzes 图…

	type segRow struct {
		seq         int
		kind, text, contentHash string
	}
	segs := map[string][]segRow{}
	rows, err = db.Query(`SELECT item_id,seq,kind,text,content_hash FROM segments ORDER BY item_id ASC, seq ASC`)
	// …按 item_id 归组，保持 seq 升序…
```

2. `PackEntry` 的 `base` 构造后，`switch e.SQLiteTable` 补两个分支：

```go
		case "quizzes":
			r, ok := quizzes[e.ItemID]
			if !ok {
				return nil, fmt.Errorf("pack 缺少 manifest 声明的题库行 %s", e.ItemID)
			}
			if r.contentHash != e.ContentHash || protocol.SHA256Hex([]byte(r.questionJSON)) != e.ContentHash {
				return nil, fmt.Errorf("pack 行级 hash 不符 %s", e.ItemID)
			}
			base.QuestionJSON = r.questionJSON
		case "segments":
			rowsList, ok := segs[e.ItemID]
			if !ok || len(rowsList) == 0 {
				return nil, fmt.Errorf("pack 缺少 manifest 声明的 segments 行 %s", e.ItemID)
			}
			ordered := make([]store.Segment, 0, len(rowsList))
			for _, r := range rowsList {
				if r.contentHash != protocol.SHA256Hex([]byte(r.text)) {
					return nil, fmt.Errorf("pack segments 行级 hash 不符 %s seq=%d", e.ItemID, r.seq)
				}
				ordered = append(ordered, store.Segment{ItemID: e.ItemID, Seq: r.seq, Kind: r.kind, Text: r.text, ContentHash: r.contentHash})
			}
			// 条目级口径必须等于 manifest 的 content_hash（册子 §3.3）
			if store.SegmentsContentHash(ordered) != e.ContentHash {
				return nil, fmt.Errorf("pack segments 条目级 hash 与 manifest 不符 %s", e.ItemID)
			}
			base.Segments = ordered
```

3. `PackEntry` 需要 `QuestionJSON` 字段——在 Task 1 已加的 `Segments` 附近一并加上（`case "quizzes"` 与 `store.ImportPack` 的 `quizzes` 分支配套）。

- [ ] **Step 4: `store.ImportPack` 补 `case "quizzes":`**

`internal/store/packimport.go` 的 `switch` 里补：

```go
		case "quizzes":
			if _, err := tx.Exec(`INSERT INTO quizzes(item_id,question_json,content_hash) VALUES(?,?,?)
				ON CONFLICT(item_id) DO UPDATE SET question_json=excluded.question_json, content_hash=excluded.content_hash`,
				e.ItemID, e.QuestionJSON, e.ContentHash); err != nil {
				return res, fmt.Errorf("store: 入库 quizzes %s: %w", e.ItemID, err)
			}
```

并补 `PackEntry` 字段 `QuestionJSON string`。

- [ ] **Step 5: 跑通**

```bash
go test ./internal/peersync/ ./internal/store/ -v
```

Expected: 全部 ok。

---

### Task 4: importer——命名空间、课程归属与容器重建

**Files:**
- Create: `internal/importer/course.go`
- Create: `internal/importer/course_test.go`
- Modify: `internal/importer/md.go`
- Modify: `internal/importer/md_test.go`
- Modify: `internal/importer/quiz_test.go`

**两个必须先写死的语义（与 spec 的实现期细化，见文末清单）：**

1. **容器清单必须用「合并式重算」而不是「按本次 Run 全量重写」**：`import-video` 产出的视频载体行不在 md 分组里，全量重写会把它们删掉。
2. **quiz 与 video 一样要求 `course` + `lesson` 齐全**：总纲 §6.0 没有顶层 `quiz` 命名空间，缺 `course` 的题库无处安放，直接报错。

- [ ] **Step 1: 先写失败测试 `internal/importer/course_test.go`**

覆盖 spec §4.2 六条规则：

```go
package importer

// 造 2 课程 × 2 课时，课时内各 1 篇，另有 1 篇无 course 的独立文章，
// 断言：id 形态、容器 segments 的顺序与 seq、order 缺省排末尾、
//       重跑幂等、import-video 产出的行不被 md 重建删掉。
```

用例至少包含：

1. `order` 升序：`l1` 下三篇 order=2/1/（缺省），清单为 `[order1, order2, 缺省(文件名升序)]`。
2. `course` 缺省 → `item_id = article/<slug>`，不进任何 segments。
3. `course` 有值、`lesson` 缺省 → `Run` 报错（该篇进 `Result.Errors`）。
4. `course_title` / `lesson_title` 缺省 → 容器 `items.title` 取 `<cid>` / `<lid>`；`course_digest` 缺省 → 无 `seq=0` 行。
5. 幂等：连跑两次，`ListSegments` 结果完全相同，`items` 条数不变。
6. 合并：先 `Run` 一次，再 `ImportVideo(Course: "c1", Lesson: "l1", Slug: "v1")`，再 `Run` 一次 → `course/c1/lesson/l1` 的清单里 video 行**仍在**。

- [ ] **Step 2: 跑失败**

```bash
go test ./internal/importer/ -run 'Course|Placement' -v
```

Expected: 编译失败（`undefined: Options` / `resolvePlacement`）。

- [ ] **Step 3: 新建 `internal/importer/course.go`**

```go
package importer

import (
	"fmt"
	"sort"
	"strings"

	"github.com/johocn/base/internal/store"
)

// placement 是一个载体（article / video / quiz）的归属解析结果（册子 §4.2）。
type placement struct {
	ItemID   string
	Course   string // 空 = 未归类
	Lesson   string
	Order    string // 空 = 缺省（排在该课时清单末尾）
	Filename string // order 相同时的次序键
}

// resolvePlacement 按 front-matter 算载体 item_id（册子 §2.1 / §4.2 规则 1–3）。
// kind ∈ {article, video, quiz}；只有 article 允许无 course。
func resolvePlacement(meta map[string]string, kind, slug, filename string) (placement, error) {
	course := strings.TrimSpace(meta["course"])
	lesson := strings.TrimSpace(meta["lesson"])
	p := placement{Course: course, Lesson: lesson, Order: strings.TrimSpace(meta["order"]), Filename: filename}
	if course == "" {
		if kind != "article" {
			return placement{}, fmt.Errorf("importer: %s 的 %s 缺少 front-matter `course`（无顶层 %s 命名空间）", filename, kind, kind)
		}
		p.ItemID = "article/" + slug
		return p, nil
	}
	if lesson == "" {
		return placement{}, fmt.Errorf("importer: %s 声明了 course=%s 但缺少 lesson（不允许只有课程没有课时的载体）", filename, course)
	}
	p.ItemID = fmt.Sprintf("course/%s/lesson/%s/%s/%s", course, lesson, kind, slug)
	return p, nil
}

// mergeChildren 是容器清单的合并式重算（册子 §4.2 规则 6 的落地口径）：
// 结果是「本次 Run 声明的子项（已确定性排序）」+「既有但本次未声明的子项（保持原相对顺序）」。
// 这样 import-video 产出的 video 行不会被 md 重建删掉，且重复执行幂等。
func mergeChildren(existing, declared []string) []string {
	seen := map[string]bool{}
	out := make([]string, 0, len(declared)+len(existing))
	for _, id := range declared {
		if seen[id] {
			continue
		}
		seen[id] = true
		out = append(out, id)
	}
	for _, id := range existing {
		if seen[id] {
			continue
		}
		seen[id] = true
		out = append(out, id)
	}
	return out
}

// sortDeclared 按 (order 升序, order 缺省排最后, 文件名升序) 排序（册子 §4.2 规则 3）。
func sortDeclared(items []placement) []placement {
	out := append([]placement{}, items...)
	sort.SliceStable(out, func(i, j int) bool {
		a, b := out[i], out[j]
		ao, bo := a.Order == "", b.Order == ""
		if ao != bo {
			return !ao // 有 order 的在前
		}
		if a.Order != b.Order {
			return a.Order < b.Order
		}
		return a.Filename < b.Filename
	})
	return out
}

// childIDsOf 取出既有 segments 里的子项 id（seq>=1）。
func childIDsOf(segs []store.Segment) []string {
	out := []string{}
	for _, s := range segs {
		if s.Seq >= 1 {
			out = append(out, s.Text)
		}
	}
	return out
}

// digestTextOf 取既有 seq=0 行的 text（缺省返回空串）。
func digestTextOf(segs []store.Segment) string {
	for _, s := range segs {
		if s.Seq == 0 {
			return s.Text
		}
	}
	return ""
}

// rebuildContainer 合并式重建一个容器条目的 segments。
// children 为本次 Run 声明的子项（已排序），digest 为空则省略 seq=0 行。
func rebuildContainer(st *store.Store, itemID, source, typ, title, digest string, children []string) error {
	existing, err := st.ListSegments(itemID)
	if err != nil {
		return err
	}
	merged := mergeChildren(childIDsOf(existing), children)
	segs := []store.Segment{}
	seq := 1
	if digest != "" {
		segs = append(segs, store.Segment{Seq: 0, Kind: "digest", Text: digest})
	}
	for _, id := range merged {
		segs = append(segs, store.Segment{Seq: seq, Kind: kindOf(id), Text: id})
		seq++
	}
	if title == "" {
		title = itemID
	}
	return st.UpsertSegmentItem(store.SegmentItem{ItemID: itemID, Source: source, Type: typ, Title: title, Segments: segs})
}

// kindOf 从子项 item_id 的倒数第二段取 kind（course/c1/lesson/l1/video/v1 → video）。
func kindOf(itemID string) string {
	parts := strings.Split(itemID, "/")
	if len(parts) < 2 {
		return ""
	}
	return parts[len(parts)-2]
}

// ensureLessonChild 把一个载体 id 并入课时清单（import-video 用）。
func ensureLessonChild(st *store.Store, course, lesson, childID string) error {
	lessonID := fmt.Sprintf("course/%s/lesson/%s", course, lesson)
	return rebuildContainer(st, lessonID, "lesson", "lesson", lesson, "", []string{childID})
}
```

- [ ] **Step 4: 改 `internal/importer/md.go`**

1. `Doc` 增字段（`PublishedAt` 之后）：

```go
	Course        string
	CourseTitle   string
	CourseDigest  string
	Lesson        string
	LessonTitle   string
	LessonDigest  string
	Order         string
```

在 `ParseMD` 里从 `meta` 取值填充（`meta["course"]` 等）。

2. 新增：

```go
// Options 是 Run 的行为开关。
type Options struct {
	// RetireLegacy 把仍为 active 的旧形态（item_id 含 ':'）条目一次性墓碑退役（册子 §2.2），默认 false。
	RetireLegacy bool
}
```

3. `Run` 换成两阶段实现：

```go
func Run(st *store.Store, dir string, opts Options) (Result, error) {
	// 阶段 1：读目录、解析、按 (course, lesson) 分组，**先不写任何东西**
	//   每篇产出 {placement, doc|quiz, raw}
	// 阶段 2：写全部载体（UpsertArticle / importQuiz 走新 id）
	// 阶段 3：合并式重建受影响容器
	//   - lesson 容器：按 (course, lesson) 归组的 placement，sortDeclared 后 rebuildContainer
	//   - course 容器：受影响 course 的 lesson id 集合（lid 升序），rebuildContainer
	// 阶段 4：opts.RetireLegacy 时退役旧形态条目
}
```

细节口径：

- 阶段 2 前，任何一次解析失败都只计入 `Result.Errors` 并跳过该文件（保持既有「不整批失败」语义）。
- 阶段 3 的 `title` / `digest` 取「该 course/lesson 下第一个带 `course_title` / `course_digest`（或 `lesson_title` / `lesson_digest`）的文档」的值；都没有则 `title` 取 `<cid>` / `<lid>`、`digest` 省略（册子 §4.2 规则 4）。
- 阶段 4：

```go
	if opts.RetireLegacy {
		rev, err := st.NextContentVersion()
		if err != nil {
			return res, err
		}
		items, err := st.ListItems("active")
		if err != nil {
			return res, err
		}
		for _, it := range items {
			if !strings.Contains(it.ItemID, ":") {
				continue
			}
			if err := st.RetireItem(it.ItemID, rev); err != nil {
				res.Failed++
				res.Errors = append(res.Errors, it.ItemID+": 退役失败: "+err.Error())
			}
		}
	}
```

- `importQuiz` 签名改为 `importQuiz(st *store.Store, filename string, raw []byte, p placement) error`，内部 `ItemID: p.ItemID`；`Run` 里先用 `SplitFrontMatter(raw)` 拿 meta，再 `resolvePlacement(meta, "quiz", slug, name)`——slug 需要先解析出来，故顺序是：`ParseQuiz` → 拿 `q.Slug`/`q.Title` → `resolvePlacement` → 写库。
- 文章路径同理：`ParseMD` → `resolvePlacement(map[string]string{"course": doc.Course, ...}, "article", doc.Slug, name)`。

- [ ] **Step 5: 同步既有测试与调用点**

- `internal/importer/md_test.go`：`Run(st, mdDir)` → `Run(st, mdDir, Options{})`；`article:a` / `article:b` 断言改成 `article/a` / `article/b`。
- `internal/importer/quiz_test.go`：给 quiz 的 front-matter 补 `course` / `lesson`，id 断言改成 `course/<cid>/lesson/<lid>/quiz/<slug>`。
- `cmd/based/import.go`：调用改 `importer.Run(st, *dir, importer.Options{RetireLegacy: *retireLegacy})`，并加 flag：

```go
	retireLegacy := fs.Bool("retire-legacy", false, "退役旧形态（item_id 含 ':'）的 active 条目，默认关闭")
```

- [ ] **Step 6: 跑通**

```bash
go test ./internal/importer/ -v
```

Expected: 全部 ok。

---

### Task 5: importer 视频归属、命令行与公开页

**Files:**
- Modify: `internal/importer/video.go`
- Modify: `internal/importer/video_test.go`
- Modify: `cmd/based/importvideo.go`
- Modify: `internal/httpapi/web.go`
- Modify: `internal/httpapi/server.go`
- Modify: `internal/httpapi/httpapi_test.go`
- Modify: `internal/httpapi/web_test.go`

**两个不在 spec §4.1 清单里但必须改的点（见文末清单）：**

1. 公开文章路由 `GET /a/{item_id}` 是**单段匹配**，新 id 含 `/` 会 404。必须改 `GET /a/{item_id...}`。
2. `internal/httpapi/web.go` 的 `strings` 依赖在改动后仍需保留（`splitParagraphs` 等仍在用），只改 `coverBlobID` 的拼接方式。

- [ ] **Step 1: 先写失败测试**

`internal/importer/video_test.go` 追加：`VideoOptions{Path: p, Slug: "v1", Course: "c1", Lesson: "l1"}` → `GetMediaMeta("course/c1/lesson/l1/video/v1")` 命中；且 `ListSegments("course/c1/lesson/l1")` 里出现该 id。再追加：`Course` 或 `Lesson` 缺省时 `ImportVideo` 报错。

`internal/httpapi/web_test.go` 与 `httpapi_test.go` 的夹具 id 全部切到新形态（`article/aaa`、`article/bbb`、`article/aaa/cover`），并把 `/a/article:aaa` 换成 `/a/article/aaa`；`httpapi_test.go` 的分页断言 cursor 改成 `article/aaa` / `article/bbb`。新增一条断言：带 `/` 的文章 id 能正常渲染正文页。

- [ ] **Step 2: 跑失败**

```bash
go test ./internal/importer/ ./internal/httpapi/ -v
```

Expected: video 用例因 id 仍是 `lesson:v1` 而失败；httpapi 用例因 404 而失败。

- [ ] **Step 3: 改 `internal/importer/video.go`**

```go
type VideoOptions struct {
	Path     string
	Slug     string
	Course   string // 必填：总纲 §6.0 无顶层 video 命名空间
	Lesson   string // 必填
	Title    string
	MIME     string
	Duration int64
}
```

校验段追加：

```go
	if strings.TrimSpace(opt.Course) == "" || strings.TrimSpace(opt.Lesson) == "" {
		return VideoResult{}, fmt.Errorf("importer: -course 与 -lesson 都是必填（无顶层 video 命名空间）")
	}
```

`itemID` 改为：

```go
	itemID := fmt.Sprintf("course/%s/lesson/%s/video/%s", opt.Course, opt.Lesson, opt.Slug)
```

`UpsertMediaItem` 成功后追加：

```go
	if err := ensureLessonChild(st, opt.Course, opt.Lesson, itemID); err != nil {
		return res, fmt.Errorf("importer: 并入课时清单: %w", err)
	}
```

- [ ] **Step 4: 改 `cmd/based/importvideo.go`**

加 `course` / `lesson` 两个 flag，传入 `VideoOptions`；把文件头注释与 `-slug` 的用法说明里的 `lesson:<slug>` 改成新形态。

- [ ] **Step 5: 改 `internal/httpapi/web.go` 与 `server.go`**

`web.go`：

```go
// coverBlobID 按约定 <item_id>/cover 找文章封面块；缺失返回空串，不阻塞渲染。
func (s *Server) coverBlobID(articleItemID string) string {
	refs, err := s.st.ListBlobsForItem(articleItemID + "/cover")
	if err != nil || len(refs) == 0 {
		return ""
	}
	return refs[0].BlobID
}
```

`server.go` 第 119 行：

```go
	mux.HandleFunc("GET /a/{item_id...}", s.handleArticlePage)
```

`handleIndex`（第 46–66 行）**保持原样**：只列 active + public 的 `type=article`，课程内文章在公开页平铺列出属 P0 既有行为，本册不引入课程层级到 web 页（册子 §6 只约束手机端）。

- [ ] **Step 6: 跑通**

```bash
go test ./internal/importer/ ./internal/httpapi/ -v
```

Expected: 全部 ok。

---

### Task 6: 手机端数据面——segments 全链打通

**Files:**
- Modify: `apps/mobile/src/core/types.ts`
- Modify: `apps/mobile/src/core/repo.ts`
- Modify: `apps/mobile/src/core/sync.ts`
- Modify: `apps/mobile/src/core/fakes.ts`

- [ ] **Step 1: `types.ts` 追加 `SegmentRow`**

```ts
/** 容器条目的一行 segments（与节点侧 segments 表同形；seq=0 为简介，seq>=1 为子项 item_id） */
export interface SegmentRow {
  itemId: string;
  seq: number;
  kind: string;
  text: string;
  contentHash: string;
}
```

- [ ] **Step 2: `repo.ts` 改数据面**

1. import 行补 `SegmentRow`。
2. `PackApply` 加 `segments: SegmentRow[];`。
3. `SCHEMA_SQL` 末尾（`comment_out` 索引之后）追加：

```ts
  `CREATE TABLE IF NOT EXISTS segments(
     item_id TEXT NOT NULL, seq INTEGER NOT NULL, kind TEXT NOT NULL, text TEXT NOT NULL,
     content_hash TEXT NOT NULL, PRIMARY KEY(item_id, seq))`,
  `CREATE INDEX IF NOT EXISTS idx_segments_item ON segments(item_id)`,
```

`bootstrap()` 每次启动逐条执行 `SCHEMA_SQL`，新表靠 `IF NOT EXISTS` 自动补上（新增表，不需要列存在性检查）。

4. `LocalRepo` 接口加三个方法：

```ts
  /** 某容器条目的 segments 行，按 seq 升序 */
  listSegments(itemId: string): Promise<SegmentRow[]>;
  /** 本地全部条目 id（id 平移要先看全量集合） */
  listLocalItemIds(): Promise<string[]>;
  /** 把以旧 id 为键的用户数据（user_state / quiz_attempt）改指到新 id；目标已有行则保留目标 */
  renameItemId(from: string, to: string): Promise<void>;
```

5. `SqlRepo.applyPack`：

- 墓碑分支追加 `DELETE FROM segments WHERE item_id=?`；
- `items` 循环后追加 segments 写入（**先删同 itemId 旧行再写**，否则旧 seq 会在重排后残留）：

```ts
    const segItems = new Set(p.segments.map((s) => s.itemId));
    for (const id of segItems) {
      stmts.push({ sql: `DELETE FROM segments WHERE item_id=?`, params: [id] });
    }
    for (const s of p.segments) {
      stmts.push({
        sql: `INSERT INTO segments(item_id,seq,kind,text,content_hash) VALUES(?,?,?,?,?)`,
        params: [s.itemId, s.seq, s.kind, s.text, s.contentHash],
      });
    }
```

6. `SqlRepo` 末尾实现三个新方法：

```ts
  async listSegments(itemId: string): Promise<SegmentRow[]> {
    const rows = await this.db.select(
      `SELECT item_id,seq,kind,text,content_hash FROM segments WHERE item_id=? ORDER BY seq ASC`,
      [itemId],
    );
    return rows.map(toSegmentRow);
  }

  async listLocalItemIds(): Promise<string[]> {
    const rows = await this.db.select(`SELECT item_id FROM items`);
    return rows.map((r) => String(r.item_id));
  }

  async renameItemId(from: string, to: string): Promise<void> {
    await this.db.tx([
      { sql: `UPDATE OR IGNORE user_state SET item_id=? WHERE item_id=?`, params: [to, from] },
      { sql: `DELETE FROM user_state WHERE item_id=?`, params: [from] },
      { sql: `UPDATE OR IGNORE quiz_attempt SET item_id=? WHERE item_id=?`, params: [to, from] },
      { sql: `DELETE FROM quiz_attempt WHERE item_id=?`, params: [from] },
    ]);
  }
```

并加 `toSegmentRow` 转换函数（与 `toArticleRow` 同风格）。

- [ ] **Step 3: `sync.ts` 读包与校验**

追加：

```ts
async function readPackSegments(conn: SqliteConnection): Promise<SegmentRow[]> {
  const rows = await conn.select(`SELECT item_id,seq,kind,text,content_hash FROM segments ORDER BY item_id ASC, seq ASC`);
  return rows.map((r) => ({
    itemId: String(r.item_id),
    seq: Number(r.seq),
    kind: String(r.kind ?? ''),
    text: String(r.text ?? ''),
    contentHash: String(r.content_hash),
  }));
}
```

`syncOnce` 内：

1. `readPackArticles` / `readPackQuizzes` 之后加 `segments = await readPackSegments(conn);`
2. 行级 + 条目级校验（与 Go 侧同一口径）：

```ts
  const byItem = new Map<string, SegmentRow[]>();
  for (const s of segments) {
    if (sha256Hex(utf8(s.text)) !== s.contentHash) throw new Error(`pack segments 行级 hash 不符: ${s.itemId} seq=${s.seq}`);
    const list = byItem.get(s.itemId) ?? [];
    list.push(s);
    byItem.set(s.itemId, list);
  }
  for (const [itemId, list] of byItem) {
    const signed = signedHashes.get(itemId);
    if (signed === undefined) throw new Error(`pack segments 未被 manifest 声明: ${itemId}`);
    const concat = list.map((s) => `${s.kind}\t${s.text}\n`).join('');
    if (sha256Hex(utf8(concat)) !== signed) throw new Error(`pack segments 条目级 hash 不符: ${itemId}`);
  }
```

3. 行数守卫（**按条目数对账，不是行数**——一个容器有多行）：

```ts
  const declaredSegments = man.entries.filter((e) => e.sqlite_table === 'segments').length;
  if (byItem.size < declaredSegments) {
    throw new Error(`pack segments 条目数不符：manifest 声明 ${declaredSegments} 个，pack 读出 ${byItem.size} 个（${packPath}）`);
  }
```

4. `applyPack` 调用处带上 `segments`。
5. `applyPack` 之后、返回之前调用 id 平移（Task 7 提供）：

```ts
  await migrateLegacyIds(o.repo);
```

- [ ] **Step 4: `fakes.ts` 对齐**

- `MemoryRepo`：新增 `segments = new Map<string, SegmentRow[]>()`；`applyPack` 墓碑分支 `this.segments.delete(t.itemId)`、条目循环 `this.segments.set(s.itemId, ...)`；实现 `listSegments` / `listLocalItemIds` / `renameItemId`（`renameItemId` 要同时搬 `favorites` / `reads` / `attempts`）。
- `FakePackReader`：`PackRows` 加 `segments: SegmentRow[]`，`set(path, articles, quizzes, segments = [])`；`open` 的 `select` 支持 `count(*) ... FROM segments`（返回**条目数**）与 `FROM segments` 查询（按 `item_id, seq` 升序返回）。

- [ ] **Step 5: 类型检查与回归**

```bash
npx tsc --noEmit
npx vitest run
```

Expected: `tsc` 干净（`SqlRepo` 与 `MemoryRepo` 必须同时实现 3 个新方法，这是两地不漂移的唯一保证）；既有 96 项测试全绿。

---

### Task 7: 手机端纯逻辑——课程树与 id 平移

**Files:**
- Create: `apps/mobile/src/core/course-tree.ts`
- Create: `apps/mobile/src/core/course-tree.test.ts`
- Create: `apps/mobile/src/core/id-migrate.ts`
- Create: `apps/mobile/src/core/id-migrate.test.ts`

- [ ] **Step 1: 先写失败测试**

`course-tree.test.ts`：给定 `items` + `segments`，断言
1. 「课程」集合 = `type==='course'` 且 `itemId.startsWith('course/')` 的条目，按 `itemId` 升序；
2. 「未归类」集合 = `type==='article'` 且 `!itemId.startsWith('course/')`；
3. 课时列表 = `segments(courseId)` 里 `seq>=1` 的 `text`，按 `seq` 升序；序号从 1 计；
4. 课时载体 = `segments(lessonId)` 里 `seq>=1` 的 `text`，按 `seq` 升序。

`id-migrate.test.ts`：覆盖 spec §5.3 六条
1. 旧 `article:aaa` 在存在唯一新 `article/aaa` 时被平移（`user_state` 与 `quiz_attempt` 都跟着走）；
2. `video:` / `quiz:` 前缀同样参与，`cover:` / `comment:` 不参与；
3. 末段有多个候选（如 `article/aaa` 与 `course/c1/lesson/l1/article/aaa`）→ **放弃平移、旧行保留**；
4. 无候选（内容已下架）→ 旧行保留不删；
5. 第二次调用直接返回（`config.id_migrate_v2 === 'done'`）；
6. 平移后相同 `(item_id, answered_at)` 冲突不报错。

- [ ] **Step 2: 跑失败**

```bash
npx vitest run src/core/course-tree.test.ts src/core/id-migrate.test.ts
```

Expected: 模块不存在，导入失败。

- [ ] **Step 3: 实现 `course-tree.ts`**

纯函数、不依赖 UI：

```ts
export interface CourseTree {
  /** 课程容器条目，按 itemId 升序 */
  courses: ItemRow[];
  /** 未归类文章，按既有平铺口径（itemId 升序） */
  ungrouped: ItemRow[];
}

export function splitCourses(items: ItemRow[]): CourseTree { /* … */ }

/** 容器的子项 item_id（seq>=1），按 seq 升序 */
export function childrenOf(segs: SegmentRow[]): string[] { /* … */ }

/** 课时序号：第 N 讲 = 在课程清单里的位次（从 1 计） */
export function lessonNo(segs: SegmentRow[], lessonId: string): number { /* … */ }
```

- [ ] **Step 4: 实现 `id-migrate.ts`**

```ts
import type { LocalRepo } from './repo';

const DONE_KEY = 'id_migrate_v2';
/** 只有这三类载体承载用户数据（册子 §5.3 规则 3） */
const MIGRATABLE = new Set(['article', 'video', 'quiz']);

export async function migrateLegacyIds(repo: LocalRepo): Promise<number> {
  if ((await repo.getConfig(DONE_KEY)) === 'done') return 0;
  const ids = await repo.listLocalItemIds();
  const oldIds = ids.filter((id) => id.includes(':') && MIGRATABLE.has(id.slice(0, id.indexOf(':'))));
  const newIds = ids.filter((id) => !id.includes(':'));
  const bySlug = new Map<string, string[]>();
  for (const id of newIds) {
    const slug = id.slice(id.lastIndexOf('/') + 1);
    bySlug.set(slug, [...(bySlug.get(slug) ?? []), id]);
  }
  let moved = 0;
  for (const old of oldIds) {
    const slug = old.slice(old.indexOf(':') + 1);
    const candidates = bySlug.get(slug) ?? [];
    if (candidates.length !== 1) continue; // 多候选放弃、无候选保留旧行（规则 4/6）
    await repo.renameItemId(old, candidates[0]!);
    moved++;
  }
  await repo.setConfig(DONE_KEY, 'done');
  return moved;
}
```

- [ ] **Step 5: 跑通**

```bash
npx vitest run src/core/course-tree.test.ts src/core/id-migrate.test.ts
```

Expected: 全部通过。

---

### Task 8: 手机端页面——主页分组、课程详情与封面路径

**Files:**
- Modify: `apps/mobile/src/pages/course/course.vue`
- Create: `apps/mobile/src/pages/course/detail.vue`
- Modify: `apps/mobile/src/pages/article/article.vue`
- Modify: `apps/mobile/src/pages.json`

**两处与 spec §6 的实现期取舍（见文末清单）：**

1. spec §6 把「课时页（载体列表）」画成独立一层；P0 常态是单载体，**合进课程详情页**：单载体直接跳载体页，多载体就地展开清单。不新增第四个页面。
2. 主页原来的「答题」分组**去掉**：题库现在都挂在课时下，平铺列出会产生两套入口（册子 §6 只保留「课程」+「未归类」）。

- [ ] **Step 1: 改 `course.vue`**

`load()`：

```ts
    const all = await repo.listItems();
    const active = all.filter((i) => i.state !== 'removed');
    const tree = splitCourses(active);
    courses.value = tree.courses;
    ungrouped.value = tree.ungrouped;
```

模板：删掉「文章」/「答题」两组与 `openQuiz`，改成「课程」组（点击 `openCourse(it.itemId)` → `/pages/course/detail?courseId=`）与「未归类」组（点击 `openArticle`）。`total` 用两组之和。空态提示保持不变。

- [ ] **Step 2: 新建 `pages/course/detail.vue`**

`onLoad` 拿 `courseId` → `repo.getItem` + `repo.listSegments(courseId)` → 课时 id 列表（`childrenOf`）；对每个课时再 `repo.listSegments(lid)` 得载体列表、`repo.getItem(lid)` 得标题。渲染「第 N 讲 + 标题」（`lessonNo`），点击时：

- 载体数 0 → `uni.showToast({ title: '该课时还没有内容' })`；
- 载体数 1 → 按类型跳 `/pages/article/article?itemId=` 或 `/pages/quiz/quiz?itemId=`；`type==='video'` → toast 提示「视频播放待后续版本」（spec §6：不做播放器）；
- 载体数 >1 → 就地展开该课时的载体清单，逐条同样规则跳转。

- [ ] **Step 3: 改 `article.vue` 封面路径**

第 77–78 行：

```ts
    const path = await repo.findBlobPathByItem(`${row.itemId}/cover`);
```

（`slug` 变量不再需要，删掉。）

- [ ] **Step 4: `pages.json` 注册新页**

`pages` 数组里 `pages/article/article` 之前插入：

```json
    {
      "path": "pages/course/detail",
      "style": { "navigationBarTitleText": "课程详情" }
    },
```

- [ ] **Step 5: 类型检查与回归**

```bash
npx tsc --noEmit
npx vitest run
```

Expected: 全绿。

---

### Task 9: 版本 0.7.0、全量自测与推送

**Files:**
- Modify: `apps/mobile/src/manifest.json`
- Modify: `docs/README.md`

- [ ] **Step 1: 升版本**

`apps/mobile/src/manifest.json`：`versionName` → `"0.7.0"`，`versionCode` → `"8"`。

- [ ] **Step 2: 全量自测**

```bash
$env:PATH='D:\go\bin;D:\gopath\bin;'+$env:PATH
go build ./...
go test ./...
```

```bash
npx vitest run
npx tsc --noEmit
npm run build:app
```

Expected: Go 全包 ok；mobile 全绿（项数 = 96 + 本册新增，以全绿为准）；`build:app` 产出 `dist/build/app` 无报错。

- [ ] **Step 3: 文档登记回填 `docs/README.md`**

1. §3 表格第 14 行状态改为 `已定稿（计划 #22 已出）`；新增第 22 行：

```
| 22 | `plans/2026-09-28-base-course-plan.md` | 课程体系实施计划（Task 1–10：store segments 读写与退役、packexport 白名单、peersync 读包、importer 归属与容器重建、视频归属与公开页、手机端数据面与三级浏览、0.7.0 发布） | 不新增表/字段与枚举值；不做权限、学习进度、手机端播放器；不改 `tools/migrate` | 册子 #14 | 已执行 |
```

（执行完成后再把状态写成「已执行」；计划刚落地时先写「已出计划」。）

2. §4 依赖图：`内容分发 (#5) ── 课程体系 (#6)` 一行补计划节点 `#6 册子 (#14) ── 计划 (#22)`；关键路径那句改为「#6 册子与计划均已出，实施中」。
3. §5 当前阶段补一句本册子计划的落地状态。

- [ ] **Step 4: 提交与推送**

```bash
$env:Path += ";C:\Program Files\Git\cmd"
git add internal/store/segments.go internal/store/segments_test.go internal/store/packimport.go internal/store/packimport_test.go internal/packexport/export.go internal/packexport/segments_test.go internal/peersync/packimport.go internal/peersync/packimport_test.go internal/importer/course.go internal/importer/course_test.go internal/importer/md.go internal/importer/md_test.go internal/importer/quiz_test.go internal/importer/video.go internal/importer/video_test.go internal/httpapi/web.go internal/httpapi/server.go internal/httpapi/httpapi_test.go internal/httpapi/web_test.go cmd/based/import.go cmd/based/importvideo.go apps/mobile/src/core/types.ts apps/mobile/src/core/repo.ts apps/mobile/src/core/sync.ts apps/mobile/src/core/fakes.ts apps/mobile/src/core/course-tree.ts apps/mobile/src/core/course-tree.test.ts apps/mobile/src/core/id-migrate.ts apps/mobile/src/core/id-migrate.test.ts apps/mobile/src/pages/course/course.vue apps/mobile/src/pages/course/detail.vue apps/mobile/src/pages/article/article.vue apps/mobile/src/pages.json apps/mobile/src/manifest.json docs/README.md docs/superpowers/plans/2026-09-28-base-course-plan.md
git commit -m "feat(course): item_id 切路径式命名空间并打通 segments 全链"
git push
```

**只 add 本 Task 的文件**，不碰工作区其它未提交改动。

---

### Task 10: 云打包与发布 0.7.0、真机验收与回填

**Files:**
- Create: `apps/mobile/dist/release/apk/base-0.7.0.apk`（云打包产物另存）
- Modify: `docs/superpowers/plans/2026-09-28-base-course-plan.md`（本文件「执行期更正」小节）

- [ ] **Step 1: 云打包**

Run（任意 cwd）:

```
D:\HBuilderX\cli.exe pack --project e:\code\base\apps\mobile --platform android --android.packagename uni.app.UNI936A667 --android.androidpacktype 3
```

Expected: 打印一个临时下载地址。**必须自己下载并另存到** `e:\code\base\apps\mobile\dist\release\apk\base-0.7.0.apk`——CLI 不会落到该目录。下载用 `Invoke-WebRequest`（本地 `curl.exe` 会报 `getaddrinfo() thread failed`）：

```powershell
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
Invoke-WebRequest -Uri '<临时地址>' -OutFile 'e:\code\base\apps\mobile\dist\release\apk\base-0.7.0.apk'
```

- [ ] **Step 2: 记录指纹并核对证书未变**

```bash
certutil -hashfile dist\release\apk\base-0.7.0.apk SHA256
D:\HBuilderX\plugins\amazon-corretto\bin\keytool.exe -printcert -jarfile dist\release\apk\base-0.7.0.apk
```

Expected: sha256 记下备用；证书 `SHA1: 19:95:21:ED:09:C0:9C:AD:58:B0:EB:34:D1:B3:CF:D1:BA:89:FF:19`（与 0.6.0 一致，才可覆盖安装）。只用 `keytool` 指纹判断证书，不看 `CERT.RSA` 文件字节。

- [ ] **Step 3: 上传并更新落地页**

```bash
scp e:\code\base\apps\mobile\dist\release\apk\base-0.7.0.apk me:/opt/appdl/base-0.7.0.apk
ssh me "sed -i 's/base-0.6.0.apk/base-0.7.0.apk/g' /opt/appdl/index.html && grep -o 'base-0.[0-9.]*.apk' /opt/appdl/index.html"
```

Expected: `grep` 输出 `base-0.7.0.apk`

- [ ] **Step 4: 签发升级文档**

`-notes` 必须是**不含空格的一个 token**：

```bash
ssh me "BASE_SIGN_KEY=37a6f57960600162228f272f0e33b062a9e5d06e33c218d932afb68c07feb0ce /opt/base/based release -version-name 0.7.0 -min-version-name 0.6.0 -apk-url http://118.190.217.242/dl/base-0.7.0.apk -apk-file /opt/appdl/base-0.7.0.apk -notes 课程体系上线：课程_课时_三级浏览_未归类分组 -out /opt/base-cache/data/release.json"
```

Expected: 打印 `version_name=0.7.0`、`apk_size`、`apk_sha256`，且 `apk_sha256` 与 Step 2 一致。若误写了副本，清掉：`ssh me "rm -f /opt/base/data/release.json"`

- [ ] **Step 5: 线上验证**

```bash
ssh me "curl -sS http://127.0.0.1/v1/release"
curl.exe -sSI http://118.190.217.242/dl/base-0.7.0.apk
```

Expected: `/v1/release` 返回 `version_name":"0.7.0"`；APK `200` 且 `Content-Length` 与文档 `apk_size` 一致；用客户端验签器 `verifyRelease` 为 `true`。

- [ ] **Step 6: 复核已发布 APK 内确实含本次改动**

从 APK 取出 `assets/apps/__UNI__936A667/www/app-service.js`（0.6.0 实测单尾 `__`）与 `www/manifest.json`，核对：`未归类`、`第`、`id_migrate_v2`、`/cover` 命中，`version.name` 为 `0.7.0`。

**中文特征串核对不要用 `Select-String`**（PowerShell 5.1 按 ANSI 读 UTF-8 会误判 0 命中）：用 `[System.IO.File]::ReadAllText($path, [System.Text.Encoding]::UTF8)` 再 `.Contains(...)`。

- [ ] **Step 7: 真机验收（对照 spec §7.3 逐条打勾）**

| # | 验收项 | 判定 |
| --- | --- | --- |
| 1 | 升级后旧收藏与答题记录仍在 | 「我的收藏」条目数与升级前一致；答题统计（次数 / 正确率）不变 |
| 2 | 课程页课时顺序与 `order` 一致，「第 N 讲」序号正确 | 课程详情里课时按 `order` 升序，序号从 1 连续 |
| 3 | 「未归类」里的独立文章可正常打开 | 点进去有标题与正文，封面按 `<item_id>/cover` 命中（若有封面） |

- [ ] **Step 8: 回填执行期更正与提交**

把上面各步的实测结果、与计划不符之处（命令、字段、判定口径）与 0.7.0 发布实况（APK 字节数 / sha256 / 证书指纹 / `release.json` 内容）追加到本文件「执行期更正」小节；`docs/README.md` §3 第 22 行状态改为「已执行」、§5 当前阶段补 0.7.0 上线实况。然后：

```bash
git add docs/superpowers/plans/2026-09-28-base-course-plan.md docs/README.md
git commit -m "docs(plans): 回填 0.7.0 课程体系发布实况与执行期更正"
git push
```

---

## 自检清单（写完计划后核过）

**Spec 覆盖**

| spec 小节 | 落点 |
| --- | --- |
| §2.1 命名空间与 `source`/`type`/`sqlite_table` 取值表 | Task 1（store 写读）、Task 4（md 载体与容器）、Task 5（video）、Task 6–8（手机端读取） |
| §2.2 旧 id 退役（`-retire-legacy` 默认关闭） | Task 1 `RetireItem` + `NextContentVersion`；Task 4 Step 4 |
| §3.1 承载表（`segments` 行语义、`seq=0` 简介、子项 kind 约束） | Task 1 `UpsertSegmentItem`；Task 4 `rebuildContainer` |
| §3.2 排序模型（顺序即 seq，不改 item_id） | Task 4 `sortDeclared` + `mergeChildren`；Task 7 `childrenOf` / `lessonNo` |
| §3.3 哈希口径（行级 / 条目级） | Task 1 `SegmentsContentHash`；Task 3 读包校验；Task 6 `readPackSegments` 校验 |
| §4.1 节点侧改动面 | Task 1（store）、Task 2（packexport）、Task 4（md.go）、Task 5（video.go / web.go） |
| §4.2 front-matter 六条规则 | Task 4（`course_test.go` 逐条覆盖） |
| §4.3 手机端改动面 + 选项顺序副作用 | Task 6（repo/sync/fakes）、Task 7（course-tree / id-migrate）、Task 8（course.vue / detail.vue）；副作用在 Task 8 第 1 步的取舍里明写 |
| §5.3 启发式平移六条 | Task 7 `id-migrate.ts` + 用例 1–6 |
| §6 三级浏览与「未归类」 | Task 8（含两处实现期取舍） |
| §7.1 契约锁测试 | Task 2（白名单 / 往返 / 哈希稳定） |
| §7.2 端到端 | Task 9 Step 2 全量自测 + 手工端到端（importer 造 2×2 → 导出 → 手机同步 → 分组） |
| §7.3 真机验收 | Task 10 Step 7 |
| §8 版本 0.6.0 → 0.7.0 | Task 9 Step 1、Task 10 |
| §9 文档登记 | Task 9 Step 3、Task 10 Step 8 |
| §10 风险 1–4 | 风险 1 → Task 2 白名单常量 + 测试；风险 2 → Task 3 + Task 6 步 5；风险 3 → Task 7 规则 4；风险 4 → Task 4 `order` 缺省排序 + 幂等用例 |

**与 spec 的实现期细化（必须同步回填 spec）**

1. **spec §4.3 漏列两个必改文件**：`apps/mobile/src/pages/article/article.vue`（封面查找 `cover:<slug>` → `<item_id>/cover`）与 `apps/mobile/src/pages.json`（注册 `pages/course/detail`）。
2. **spec §4.2 规则 6 的「统一重建」必须是合并式重算**：`import-video` 产出的视频载体行不在 md 分组里，按分组全量重写会把它们删掉（`UpsertSegmentItem` 是 delete-then-insert）。落地口径 = `mergeChildren(既有子项, 本次声明的子项)`，本次声明在前、既有未声明项按原相对顺序接在后面，幂等。
3. **`sqlite_table` 的分支在四处而非一处**：`packexport` 白名单（Task 2）、`store.ImportPack` 的 `switch`（Task 1）、`peersync.readAndVerifyPack` 的 `switch`（Task 3，**顺带补上 `quizzes` 这一既有缺口**）、`apps/mobile` 的 `readPack*` + 行数守卫（Task 6）。任一处漏改都表现为「课程页空白」而不是报错。
4. **公开文章路由必须改成通配**：`internal/httpapi/server.go` 的 `GET /a/{item_id}` 是单段匹配，新 id 含 `/` 会 404，须改 `GET /a/{item_id...}`。spec §4.1 只写了 `coverBlobID`。
5. **quiz 与 video 一样要求 `course` + `lesson` 齐全**：总纲 §6.0 无顶层 `quiz` 命名空间；spec §4.2 规则 1/5 只说了 article 的降级与 quiz 走同一套键，未点明「缺 course 即报错」。
6. **封面取舍**：`tools/migrate` 明确不改，其产出仍是 `article:<slug>` + `cover:<slug>`；切到 `<item_id>/cover` 后这些封面不再被渲染（且 `cover:<slug>` 条目在 `-retire-legacy` 下会被连带退役）。**因此 `-retire-legacy` 只能在「内容已全部由本地 importer 重导」的节点上执行**，否则会连带退役 Strapi 迁移来的整批内容。执行前须先确认目标节点不含 migrate 产物。
7. **`Run` 签名与 `VideoOptions` 变更的调用点**：`cmd/based/import.go`、`cmd/based/importvideo.go`、`internal/importer/md_test.go`、`video_test.go`、`quiz_test.go`、`internal/packexport/export_test.go`（用了 `importVideo` 夹具）都要同步。
8. **`sync.ts` 的 segments 行数守卫按「条目数」而非「行数」对账**：一个容器在 `segments` 里有多行，按行数比对会误报。

**额外强调的实现约束**

- Go 侧 `segments` 的 `content_hash` **一律由 store 现算**（行级 = `sha256(text)`，条目级 = `SegmentsContentHash`），调用方传的 hash 一律忽略，避免口径分叉。
- `SqlRepo` 与 `MemoryRepo` 必须同时实现 `listSegments` / `listLocalItemIds` / `renameItemId`，否则 `npx tsc --noEmit` 报错——这是两地实现不漂移的唯一保证。
- `segments` 写入一律「先删同 `item_id` 旧行再写」：直接按 `(item_id,seq)` upsert 会让重排后的旧高 `seq` 行残留。
- `MemoryDb` 不动：课程体系测试走 `MemoryRepo` / `FakePackReader`，`MemoryDb` 只服务自检探测。
- `handleIndex` 保持原样，不把课程层级引入 web 公开页（册子 §6 只约束手机端）。

---

## 执行期更正（已实施后回填，后续 Task 请以本节为准）

1. **Task 2 —— Windows 下连续两次 `packexport.Export` 同一路径会失败**：第二次导出前必须 `db.Close()`，否则报 `vacuum into: output file already exists`。
2. **Task 4 —— `ensureLessonChild` 不得覆盖既有课时标题**：计划原写法会把既有课时 `items.title` 覆盖成裸 `lid`；落地改为「已存在则沿用既有 `title` 与 `seq=0` digest」。
3. **Task 4 —— `internal/importer/quiz_test.go` 实际无需改动**（该文件无 `Run` 调用与旧 id 断言），未纳入任何变更。
4. **Task 4 —— 用例 6 的夹具改走 store 直连**：计划原写 `ImportVideo(Course:..., Lesson:...)`，但 `VideoOptions.Course/Lesson` 属 Task 5；Task 4 改为直连 `UpsertMediaItem` + `ensureLessonChild`。
5. **Task 5 —— 额外改了计划清单外的 `internal/packexport/export_test.go`**：`VideoOptions.Course/Lesson` 必填校验落地后，该测试的 `importVideo` 夹具必须同步，属保证全仓绿的最小必要改动。
6. **Task 6 / Task 7 —— 前置依赖拆分**：计划 Task 6 Step 3.5 要求 `syncOnce` 调 `migrateLegacyIds`，但该模块属 Task 7，Task 6 引入会让 `tsc` 失败。落地为 Task 6 不接线，改由 Task 7 追加 `apps/mobile/src/core/sync.ts` 一行接线（Task 7 因此多改一个文件）。
7. **Task 6 —— `sync.test.ts` 额外补 1 正 1 反两个 segments 用例**（计划文件清单未列），以真正覆盖行级 / 条目级校验与条目数守卫；vitest 由 96 → 98。
8. **Task 7 —— `sync.test.ts` 额外补 1 条「同步成功后自动触发旧 id 平移」集成断言**；vitest 由 98 → 112。
9. **`.vue` 不在 `tsc --noEmit` 覆盖范围**：`apps/mobile/tsconfig.json` 只 `include: ["src"]` 且无 vue 插件，`.vue` 的唯一真实编译检查是 `npm run build:app`（Task 8 起把 `build:app` 列为 `.vue` 验收项）。
10. **工具 / 环境副作用**：Task 8 期间出现计划外文件改写（`internal/importer/{course.go,course_test.go,md.go}` 被 gofmt 重排、5 个已提交 mobile TS 文件尾换行被剥离），已 `git restore` 回 HEAD，未纳入任何提交。

**Task 9 全量自测实况（0.7.0）**：`go build ./...` + `go test ./...` 全包 ok；`npx tsc --noEmit` 干净（exit 0）；`npx vitest run` 12 文件 / 112 项全绿；`npm run build:app` 产出 `dist/build/app` 无报错。`apps/mobile/src/manifest.json` 已升 `versionName "0.7.0"` / `versionCode "8"`。