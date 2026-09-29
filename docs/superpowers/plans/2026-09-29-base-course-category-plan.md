# 课程分类与答题关联（category → course → lesson → 载体）落地 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让课程多一层「分类」组织——导入器按 front-matter `category` / `category_title` / `category_digest` 产出 `category/<slug>` 容器条目（借既有 `segments` 链路承载，节点侧零新表零新字段），同一课程声明两个分类即 fail-fast 报错；手机端首页改成「分类分组 + 未归类」四级浏览（全站无分类时退化为两级），并把答题入口明确到课程页 / 课时页 / 文章页三处（零契约变更）。

**Architecture:** 分类容器与 course / lesson 容器**同形**，直接复用 #14 已打通的 `segments` 全链（`store.UpsertSegmentItem` / `packexport` 白名单 / `ImportPack` 的 `segments` 分支 / 手机端 `listSegments`），因此节点侧只有 `internal/importer` 有实质新增。归属模型是**分类侧单向清单**：`category/<slug>` 的 `seq>=1` 行列出 `course/<cid>`，课程条目的 `item_id` 与 `content_hash` 一字不动；分类清单**全量重算**（与 lesson/course 容器的 `mergeChildren` 合并口径刻意不同），否则课程换分类后旧分类会残留。手机端新增三个纯函数 + 两处页面改造，不新增本地表。

**Tech Stack:** Go 1.22+（`modernc.org/sqlite`）、uni-app（Vue 3 + TS）、vitest（node 环境）、`core/fakes.ts` 假适配器。

**上游 spec:** `docs/superpowers/specs/2026-09-29-base-course-category-design.md`（#36，本计划是它的实现展开，冲突时以 spec 为准）
**直接上游:** `docs/superpowers/specs/2026-09-28-base-course-design.md`（#14：`segments` 行语义与两条哈希口径）

**基线（开工前实测，2026-09-29）:** `go build ./...` / `go vet ./...` / `go test ./...` 全包 ok；mobile `npx vitest run` **18 文件 / 169 项全绿**、`npx tsc --noEmit` 干净；`apps/mobile/src/manifest.json` = `versionName "0.10.0"` / `versionCode "14"`。

**⚠️ 同工作区并发前提:** `docs/superpowers/plans/2026-09-29-base-governance-circle-plan.md`（#35）的执行进程在同一 worktree 活动，会改写 `apps/mobile/src/manifest.json`（0.11.0/15、0.12.0/16）与 `docs/README.md` §4/§5。本计划的**每一次提交都必须用明确路径**（`git add <具体文件>` 或 `git commit -- <路径>`），**绝不 `git add -A` / `git add .`**；工作区常驻未提交项 `.gitignore` 永不提交。

---

## 文件结构

| 路径 | 动作 | 职责 |
| --- | --- | --- |
| `internal/protocol/id.go` | 修改 | 新增契约级 `ValidSlug`（`[a-z0-9][a-z0-9-]{0,63}`），投稿与导入器共用一个判定源 |
| `internal/protocol/id_test.go` | 修改 | `ValidSlug` 边界用例（首位、长度 64/65、大写、下划线、中文） |
| `internal/httpapi/submit.go` | 修改 | 删本地 `validSlug`，改调 `protocol.ValidSlug`（行为逐字节不变） |
| `internal/httpapi/submit_test.go` | 修改 | 两处 `validSlug` 调用点改 `protocol.ValidSlug`，断言不变 |
| `internal/importer/md.go` | 修改 | `parsedMD` 增分类三字段；`Run` 增「阶段 1.5 分类硬校验」与「阶段 3.5 分类容器重算」 |
| `internal/importer/course.go` | 修改 | 新增 `validateCategories`（fail-fast）与 `rebuildCategories`（全量重算） |
| `internal/importer/category_test.go` | 新建 | 单归属报错、slug 校验、分类容器产出与顺序、改分类后旧分类清空、幂等、确定性 |
| `internal/packexport/category_test.go` | 新建 | 端到端：带分类导入 → 导出 pack.sqlite 含 `category/<slug>` 条目与清单行 → 另一方 `ImportPack` 后逐行一致 |
| `apps/mobile/src/core/course-tree.ts` | 修改 | 新增 `splitCategories` / `coursesOfCategory` / `lessonOfCarrier`；既有函数全保留 |
| `apps/mobile/src/core/course-tree.test.ts` | 修改 | 三个新函数的用例（含悬空引用跳过、乱序 seq、非课时载体返回空） |
| `apps/mobile/src/pages/course/course.vue` | 修改 | 首页改「分类分组（可折叠）+ 未归类课程 + 独立内容」，无分类时退化为两级 |
| `apps/mobile/src/pages/course/detail.vue` | 修改 | 增「本课程测验」块（按课时分组），点入既有 quiz 页 |
| `apps/mobile/src/pages/article/article.vue` | 修改 | 增「本课测验」块（该文章所属课时内的 quiz），无课程归属时不显示 |
| `apps/mobile/src/manifest.json` | 修改 | `versionName "0.13.0"` / `versionCode "17"` |
| `docs/README.md` | 修改 | §3 第 36 行状态改「已执行」；§4/§5 若 #35 已落地则同步（否则留待 #35 收口） |
| `docs/superpowers/specs/2026-09-29-base-course-category-design.md` | 修改 | 回填实现期口径（分类清单排序、未声明分类清空、AC 7 措辞） |

约定：Go 命令工作目录 `e:\code\base`；mobile 命令工作目录 `e:\code\base\apps\mobile`。

**本机环境（照做）**：PowerShell 5.1 **不支持 `&&`**，多条命令用 `;` 分隔；无 heredoc（`git commit -m` 用临时文件 + `-F`）；`go` 若不在 PATH 先 `$env:PATH='D:\go\bin;D:\gopath\bin;'+$env:PATH`，`git` 若不在 PATH 先 `$env:Path += ";C:\Program Files\Git\cmd"`。

---

### Task 1: 契约级 slug 规则上提（`protocol.ValidSlug`）

**Files:**
- Modify: `internal/protocol/id.go`
- Modify: `internal/protocol/id_test.go`
- Modify: `internal/httpapi/submit.go:33-52,58`
- Modify: `internal/httpapi/submit_test.go:19,24`

理由：spec §3.1 要求 `category` slug 沿用 #25 §2.4 的 `[a-z0-9][a-z0-9-]{0,63}`，而该判定当前只存在于 `internal/httpapi/submit.go` 的包内私有函数 `validSlug`。导入器是另一个包，直接复制一份就是两处独立口径。slug 形态是**契约级编码规则**（与 `protocol.IdentityID`、`BlobID` 同级），上提到 `internal/protocol` 是它唯一的正确归属。

- [ ] **Step 1: 先写失败测试 `internal/protocol/id_test.go`（追加）**

```go
func TestValidSlug(t *testing.T) {
	ok := []string{"a", "c1", "course-2026", strings.Repeat("a", 64), "a-b-c"}
	for _, s := range ok {
		if !ValidSlug(s) {
			t.Fatalf("ValidSlug(%q) = false, want true", s)
		}
	}
	bad := []string{"", "-a", "A", "a_b", "中文", "a/b", strings.Repeat("a", 65)}
	for _, s := range bad {
		if ValidSlug(s) {
			t.Fatalf("ValidSlug(%q) = true, want false", s)
		}
	}
}
```

若 `id_test.go` 未导入 `strings`，同步补进 import 块。

- [ ] **Step 2: 跑测试确认失败**

Run: `go test ./internal/protocol -run TestValidSlug -v`
Expected: FAIL — `undefined: ValidSlug`

- [ ] **Step 3: 在 `internal/protocol/id.go` 追加实现**

```go
// ValidSlug 校验 slug 形态（册子 #25 §2.4）：[a-z0-9][a-z0-9-]{0,63}，总长 1..64。
// 这是契约级规则：投稿 item_id 的 slug 段、导入器产出的 category slug 都按它判定，
// 故落在 protocol 而非任一调用方包内，避免两处口径漂移。
func ValidSlug(s string) bool {
	if len(s) == 0 || len(s) > 64 {
		return false
	}
	for i := 0; i < len(s); i++ {
		c := s[i]
		isAlnum := (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9')
		if i == 0 {
			if !isAlnum {
				return false
			}
			continue
		}
		if !isAlnum && c != '-' {
			return false
		}
	}
	return true
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `go test ./internal/protocol -run TestValidSlug -v`
Expected: PASS

- [ ] **Step 5: `httpapi` 去掉本地副本，改调上提后的函数**

`internal/httpapi/submit.go`：删除第 33–52 行整段 `validSlug`（含其注释），把第 58 行的调用改为：

```go
	if !ok || (prefix != itemTypeArticle && prefix != itemTypeQuiz) || !protocol.ValidSlug(rest) {
		return "", "item_id_invalid"
	}
```

（`protocol` 已在该文件 import 块内，无需新增 import。）
`internal/httpapi/submit_test.go`：第 19 行与第 24 行的 `validSlug(s)` 改为 `protocol.ValidSlug(s)`。

- [ ] **Step 6: 跑 httpapi 全包测试确认行为不变**

Run: `go test ./internal/httpapi -run 'TestSubmit|TestValidSlug' -v`
Expected: 全 PASS（无任何断言语义变化）

- [ ] **Step 7: 全仓门禁**

Run: `go build ./... ; go vet ./... ; go test ./... -count=1`
Expected: 全部 ok，无 `undefined` / `declared and not used`

- [ ] **Step 8: 提交**

```powershell
git add internal/protocol/id.go internal/protocol/id_test.go internal/httpapi/submit.go internal/httpapi/submit_test.go
git commit -m "refactor(protocol): slug 形态判定上提为 protocol.ValidSlug"
```

---

### Task 2: 导入器 front-matter 三键与分类硬校验

**Files:**
- Modify: `internal/importer/md.go`（`parsedMD` 结构、阶段 1 组装、阶段 1.5）
- Modify: `internal/importer/course.go`（新增 `validateCategories`）
- Create: `internal/importer/category_test.go`

**口径（写死，spec §3.4 的实现展开）：**

1. `category` / `category_title` / `category_digest` 三个键**文档级**，与文档的 `course` 配对；`course` 缺省时声明 `category` 是配置错误，报错而不是静默忽略。
2. 单归属判定只统计**非空** `category`：一个 `course` 出现两个不同的非空 `category` ⇒ 报错。空 `category` 不参与判定（它就是「进未归类」）。
3. 校验发生在**任何写库之前**，故失败时 `Run` 返回 `(Result{}, err)`，库里一行都没动 → 也就不可能产出包。

- [ ] **Step 1: 先写失败测试 `internal/importer/category_test.go`**

```go
package importer

import (
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/johocn/base/internal/store"
)

// writeMD、openTemp、segmentTexts 三个 helper 已存在于同包测试
// （course_test.go / video_test.go），此处直接复用。

func TestCategorySingleAttributionFailsFast(t *testing.T) {
	st := openTemp(t)
	dir := writeMD(t, map[string]string{
		"10-a.md": "---\nslug: a\ntitle: 甲\ncourse: c1\nlesson: l1\ncategory: math\n---\n\n甲",
		"20-b.md": "---\nslug: b\ntitle: 乙\ncourse: c1\nlesson: l1\ncategory: physics\n---\n\n乙",
	})
	_, err := Run(st, dir, Options{})
	if err == nil {
		t.Fatal("同一课程声明两个分类必须报错")
	}
	if !strings.Contains(err.Error(), "至多属一个分类") {
		t.Fatalf("错误文案不符: %v", err)
	}
	// 硬校验在任何写库之前：库里不得留下任何条目
	items, lerr := st.ListItems("active")
	if lerr != nil {
		t.Fatal(lerr)
	}
	if len(items) != 0 {
		t.Fatalf("报错后库内条目 = %d, want 0（必须在写库前失败）", len(items))
	}
}

func TestCategorySlugInvalidFailsFast(t *testing.T) {
	st := openTemp(t)
	dir := writeMD(t, map[string]string{
		"10-a.md": "---\nslug: a\ntitle: 甲\ncourse: c1\nlesson: l1\ncategory: Math_1\n---\n\n甲",
	})
	if _, err := Run(st, dir, Options{}); err == nil || !strings.Contains(err.Error(), "不是合法 slug") {
		t.Fatalf("非法 category slug 必须报错，实得 %v", err)
	}
}

func TestCategoryWithoutCourseFailsFast(t *testing.T) {
	st := openTemp(t)
	dir := writeMD(t, map[string]string{
		"10-a.md": "---\nslug: a\ntitle: 甲\ncategory: math\n---\n\n甲",
	})
	if _, err := Run(st, dir, Options{}); err == nil || !strings.Contains(err.Error(), "没有 course") {
		t.Fatalf("声明 category 但无 course 必须报错，实得 %v", err)
	}
}

func TestCategorySameSlugAcrossDocsIsFine(t *testing.T) {
	st := openTemp(t)
	dir := writeMD(t, map[string]string{
		"10-a.md": "---\nslug: a\ntitle: 甲\ncourse: c1\nlesson: l1\ncategory: math\ncategory_title: 数学\n---\n\n甲",
		"20-b.md": "---\nslug: b\ntitle: 乙\ncourse: c1\nlesson: l2\ncategory: math\n---\n\n乙",
	})
	res, err := Run(st, dir, Options{})
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if res.Imported != 2 || res.Failed != 0 {
		t.Fatalf("Run = %+v, want imported 2 / failed 0", res)
	}
	it, ok, _ := st.GetItem("category/math")
	if !ok || it.Source != "category" || it.Type != "category" || it.SQLiteTable != "segments" {
		t.Fatalf("分类条目异常: %+v ok=%v", it, ok)
	}
	if it.Title != "数学" {
		t.Fatalf("分类标题 = %q, want 数学（取第一个非空 category_title）", it.Title)
	}
	if got := segmentTexts(t, st, "category/math"); !reflect.DeepEqual(got, []string{"course/c1"}) {
		t.Fatalf("分类清单 = %v, want [course/c1]", got)
	}
}
```

- [ ] **Step 2: 跑测试确认失败**

Run: `go test ./internal/importer -run TestCategory -v`
Expected: FAIL — 四个用例中至少 `TestCategorySingleAttributionFailsFast` / `TestCategorySlugInvalidFailsFast` / `TestCategoryWithoutCourseFailsFast` 报「必须报错」，`TestCategorySameSlugAcrossDocsIsFine` 报 `GetItem category/math` 未命中。

- [ ] **Step 3: `parsedMD` 增分类三字段并在阶段 1 组装**

`internal/importer/md.go` 的 `parsedMD` 结构体，在 `courseTitle, courseDigest, lessonTitle, lessonDigest` 之后追加：

```go
	category, categoryTitle, categoryDigest         string
```

`Run` 阶段 1 的 `it := parsedMD{...}` 字面量，在 `lessonTitle: meta["lesson_title"], lessonDigest: meta["lesson_digest"],` 这一行**之前**插入：

```go
			category:       strings.TrimSpace(meta["category"]),
			categoryTitle:  meta["category_title"],
			categoryDigest: meta["category_digest"],
```

- [ ] **Step 4: 在 `internal/importer/course.go` 追加 `validateCategories`**

```go
// validateCategories 是导入器侧的**硬校验**（册子 §3.4），必须在任何写库之前执行，
// 失败即整批退出、不产出任何包——静默取其一会让「哪一份声明生效」取决于文件遍历顺序，
// 产生不可复现的导出结果。
//
// 三条判定：
//  1. `category` 非空时必须是合法 slug（契约级 protocol.ValidSlug）；
//  2. 声明了 `category` 就必须有 `course`（分类只承载课程归属，孤立分类是配置错误）；
//  3. 一个 course 至多属一个分类——出现两个不同的非空 category 即报错。
//     空 category 不参与判定：它就是「该课程进未归类」，不是第二个分类。
func validateCategories(items []parsedMD) error {
	seen := map[string]string{}
	for _, it := range items {
		if it.category == "" {
			continue
		}
		if !protocol.ValidSlug(it.category) {
			return fmt.Errorf("importer: %s 的 front-matter `category=%s` 不是合法 slug（[a-z0-9][a-z0-9-]{0,63}）", it.name, it.category)
		}
		if it.p.Course == "" {
			return fmt.Errorf("importer: %s 声明了 category=%s 但没有 course（分类只承载课程归属）", it.name, it.category)
		}
		if prev, ok := seen[it.p.Course]; ok && prev != it.category {
			return fmt.Errorf("importer: 课程 %s 同时声明了分类 %s 与 %s（一个课程至多属一个分类，册子 §3.4）", it.p.Course, prev, it.category)
		}
		seen[it.p.Course] = it.category
	}
	return nil
}
```

`course.go` 的 import 块补 `"github.com/johocn/base/internal/protocol"`。

- [ ] **Step 5: `Run` 插入阶段 1.5**

`internal/importer/md.go`：在阶段 1 的 `for _, name := range names { ... }` 循环结束之后、阶段 2 的 `// 阶段 2：写全部载体。` 之前插入：

```go
	// 阶段 1.5：分类硬校验（册子 §3.4）。必须在任何写库之前失败：失败即整批退出、不产出任何包。
	if err := validateCategories(items); err != nil {
		return Result{}, err
	}
```

- [ ] **Step 6: 跑测试确认前三个用例通过**（第四个仍会失败，Task 3 补）

Run: `go test ./internal/importer -run 'TestCategorySingleAttributionFailsFast|TestCategorySlugInvalidFailsFast|TestCategoryWithoutCourseFailsFast' -v`
Expected: 三个全 PASS

- [ ] **Step 7: 跑同包回归，确认既有用例未受影响**

Run: `go test ./internal/importer -count=1`
Expected: 仅 `TestCategorySameSlugAcrossDocsIsFine` FAIL（分类容器尚未产出），其余全 PASS

---

### Task 3: 导入器分类容器全量重算

**Files:**
- Modify: `internal/importer/course.go`（新增 `rebuildCategories`）
- Modify: `internal/importer/md.go`（阶段 3.5）
- Modify: `internal/importer/category_test.go`（追加用例）

**口径（写死）：**

| 项 | 值 | 理由 |
| --- | --- | --- |
| 覆盖集合 | 本 Run 声明的分类 **∪** 库中既有的分类 | 课程换分类后旧分类必须被重写，否则 AC 3 失败 |
| 清单内容 | **全量替换**（不是 `mergeChildren` 合并） | 与 lesson/course 容器刻意不同：后者要保住 `import-video` 产出的 video 行，分类没有第二个写入方 |
| 清单顺序 | 分类内按 `course/<cid>` 的 **cid 字典序升序** | 分类没有 `order` 键（spec §3.4 只定义三键），必须有一个不依赖文件遍历顺序的确定序 |
| 未被声明的既有分类 | 重写成**无课程行**的容器（`title` / `digest` 沿用既有） | 零新机制、零退役动作；手机端跳过空清单分类（Task 6） |
| `title` 优先级 | 本 Run 声明的 `category_title` > 既有 `items.title` > `slug` | 与 course/lesson 容器的「第一个非空声明值」口径一致 |
| `digest` 优先级 | 本 Run 声明的 `category_digest` > 既有 `seq=0` 行 | 同上 |

- [ ] **Step 1: 追加失败测试（`internal/importer/category_test.go`）**

```go
func TestCategoryListIsSortedByCourseID(t *testing.T) {
	st := openTemp(t)
	dir := writeMD(t, map[string]string{
		"10-a.md": "---\nslug: a\ntitle: 甲\ncourse: c2\nlesson: l1\ncategory: math\ncategory_digest: 数学入门\n---\n\n甲",
		"20-b.md": "---\nslug: b\ntitle: 乙\ncourse: c1\nlesson: l1\ncategory: math\n---\n\n乙",
	})
	if _, err := Run(st, dir, Options{}); err != nil {
		t.Fatalf("Run: %v", err)
	}
	segs, err := st.ListSegments("category/math")
	if err != nil {
		t.Fatal(err)
	}
	if len(segs) != 3 || segs[0].Seq != 0 || segs[0].Kind != "digest" || segs[0].Text != "数学入门" {
		t.Fatalf("seq=0 简介行异常: %+v", segs)
	}
	got := segmentTexts(t, st, "category/math")
	want := []string{"course/c1", "course/c2"} // cid 字典序，与文件遍历顺序无关
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("分类清单 = %v, want %v", got, want)
	}
}

func TestCategoryMoveClearsOldCategory(t *testing.T) {
	st := openTemp(t)
	before := writeMD(t, map[string]string{
		"10-a.md": "---\nslug: a\ntitle: 甲\ncourse: c1\nlesson: l1\ncategory: math\n---\n\n甲",
	})
	if _, err := Run(st, before, Options{}); err != nil {
		t.Fatalf("首轮 Run: %v", err)
	}
	courseBefore, ok, _ := st.GetItem("course/c1")
	if !ok {
		t.Fatal("course/c1 未落地")
	}

	after := writeMD(t, map[string]string{
		"10-a.md": "---\nslug: a\ntitle: 甲\ncourse: c1\nlesson: l1\ncategory: physics\n---\n\n甲",
	})
	if _, err := Run(st, after, Options{}); err != nil {
		t.Fatalf("次轮 Run: %v", err)
	}
	if got := segmentTexts(t, st, "category/physics"); !reflect.DeepEqual(got, []string{"course/c1"}) {
		t.Fatalf("新分类清单 = %v, want [course/c1]", got)
	}
	if got := segmentTexts(t, st, "category/math"); len(got) != 0 {
		t.Fatalf("旧分类清单 = %v, want 空（AC 3：旧分类里不再出现该课程）", got)
	}
	courseAfter, _, _ := st.GetItem("course/c1")
	if courseAfter.ContentHash != courseBefore.ContentHash {
		t.Fatalf("课程 content_hash 变了: %s → %s（AC 3 要求不变）", courseBefore.ContentHash, courseAfter.ContentHash)
	}
}

func TestCategoryRunIdempotentAndDeterministic(t *testing.T) {
	st := openTemp(t)
	dir := writeMD(t, map[string]string{
		"10-a.md": "---\nslug: a\ntitle: 甲\ncourse: c1\nlesson: l1\ncategory: math\ncategory_title: 数学\n---\n\n甲",
	})
	if _, err := Run(st, dir, Options{}); err != nil {
		t.Fatalf("首轮 Run: %v", err)
	}
	first, _, _ := st.GetItem("category/math")
	if _, err := Run(st, dir, Options{}); err != nil {
		t.Fatalf("次轮 Run: %v", err)
	}
	second, _, _ := st.GetItem("category/math")
	if first.ContentHash != second.ContentHash {
		t.Fatalf("重复导入分类条目哈希漂移: %s → %s", first.ContentHash, second.ContentHash)
	}
	if got := segmentTexts(t, st, "category/math"); !reflect.DeepEqual(got, []string{"course/c1"}) {
		t.Fatalf("重复导入后清单 = %v（行数不得叠加）", got)
	}
}

func TestCategoryDigestAndTitleSurviveUndeclaredRerun(t *testing.T) {
	st := openTemp(t)
	first := writeMD(t, map[string]string{
		"10-a.md": "---\nslug: a\ntitle: 甲\ncourse: c1\nlesson: l1\ncategory: math\ncategory_title: 数学\ncategory_digest: 数学入门\n---\n\n甲",
	})
	if _, err := Run(st, first, Options{}); err != nil {
		t.Fatalf("首轮 Run: %v", err)
	}
	// 第二轮：文档不再声明 category（课程进「未归类」），既有分类条目被重写为空清单但标题简介保留
	second := writeMD(t, map[string]string{
		"10-a.md": "---\nslug: a\ntitle: 甲\ncourse: c1\nlesson: l1\n---\n\n甲",
	})
	if _, err := Run(st, second, Options{}); err != nil {
		t.Fatalf("次轮 Run: %v", err)
	}
	it, ok, _ := st.GetItem("category/math")
	if !ok || it.Title != "数学" {
		t.Fatalf("既有分类条目应保留: %+v ok=%v", it, ok)
	}
	if got := segmentTexts(t, st, "category/math"); len(got) != 0 {
		t.Fatalf("清单 = %v, want 空", got)
	}
	segs, _ := st.ListSegments("category/math")
	if len(segs) != 1 || segs[0].Seq != 0 || segs[0].Text != "数学入门" {
		t.Fatalf("seq=0 简介行应沿用既有值: %+v", segs)
	}
}

func TestCategoryIgnoresIndependentDocuments(t *testing.T) {
	st := openTemp(t)
	dir := writeMD(t, map[string]string{
		"10-a.md": "---\nslug: a\ntitle: 甲\n---\n\n甲",
		"20-q.md": "---\ntype: quiz\nslug: q\ncourse: c1\nlesson: l1\ncategory: math\ncategory_title: 数学\n---\n\n" + quizBody(),
	})
	res, err := Run(st, dir, Options{})
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if res.Imported != 2 {
		t.Fatalf("Run = %+v, want imported 2", res)
	}
	// quiz 与 article 共用文档级三键：quiz 也能为它的课程声明分类
	if got := segmentTexts(t, st, "category/math"); !reflect.DeepEqual(got, []string{"course/c1"}) {
		t.Fatalf("分类清单 = %v, want [course/c1]", got)
	}
	// 独立文章不进任何分类清单，仍是 article/<slug>
	if _, ok, _ := st.GetItem("article/a"); !ok {
		t.Fatal("独立文章应是 article/a")
	}
}

// quizBody 返回一段合法题库正文（同包 quiz_test.go 已有同类夹具，此处取一份最小可用形态）。
func quizBody() string {
	return "Q: 1+1=?\n" +
		"A. 文本1\n" +
		"B. 文本2\n" +
		"C. 文本3\n" +
		"D. 文本4\n" +
		"answer: A\n"
}
```

> **执行时若 `quizBody` 的正文格式与该包 `quiz_test.go` 既有夹具不一致**：直接照抄 `quiz_test.go` 里已跑通的题面字符串，删掉本文件自造的 `quizBody`。不要为了这个用例改动 `quiz.go`。

- [ ] **Step 2: 跑测试确认失败**

Run: `go test ./internal/importer -run TestCategory -v`
Expected: FAIL — `category/math` 条目不存在 / 清单为空

- [ ] **Step 3: 在 `internal/importer/course.go` 追加 `rebuildCategories`**

```go
// rebuildCategories 全量重算分类容器（册子 §3.1 / §3.2）。
//
// 与 lesson / course 容器**刻意不同**：分类清单是「本 Run 声明」的快照，**不做 mergeChildren 合并**。
// 合并会让课程换分类后仍留在旧分类清单里（AC 3 失败），也会让悬空的 course 引用永久沉淀。
//
// 覆盖集合 = 本 Run 声明的分类 ∪ 库中既有的分类：
// 未被声明的既有分类被重写成「无课程行」的容器（title / digest 沿用既有），
// 手机端跳过空清单分类（册子 §5.2），故不会出现空分组。
// 返回失败明细，不整批失败（与 rebuildContainers 同口径）。
func rebuildCategories(st *store.Store, items []parsedMD) []string {
	bySlug := map[string][]string{} // slug → cid
	title := map[string]string{}
	digest := map[string]string{}
	seen := map[string]bool{} // "<slug>/<cid>"：同一分类下的同一课程只收一次
	for _, it := range items {
		if it.p.Course == "" || it.category == "" {
			continue
		}
		if key := it.category + "/" + it.p.Course; !seen[key] {
			seen[key] = true
			bySlug[it.category] = append(bySlug[it.category], it.p.Course)
		}
		if title[it.category] == "" {
			title[it.category] = it.categoryTitle
		}
		if digest[it.category] == "" {
			digest[it.category] = it.categoryDigest
		}
	}

	existing, err := st.ListItems("active")
	if err != nil {
		return []string{"列出既有分类失败: " + err.Error()}
	}
	slugs := map[string]bool{}
	for slug := range bySlug {
		slugs[slug] = true
	}
	for _, it := range existing {
		if it.Source != "category" || !strings.HasPrefix(it.ItemID, "category/") {
			continue
		}
		slug := strings.TrimPrefix(it.ItemID, "category/")
		slugs[slug] = true
		if title[slug] == "" {
			title[slug] = it.Title
		}
	}

	ordered := make([]string, 0, len(slugs))
	for slug := range slugs {
		ordered = append(ordered, slug)
	}
	sort.Strings(ordered)

	errs := []string{}
	for _, slug := range ordered {
		itemID := "category/" + slug
		if digest[slug] == "" {
			segs, err := st.ListSegments(itemID)
			if err != nil {
				errs = append(errs, itemID+": "+err.Error())
				continue
			}
			digest[slug] = digestTextOf(segs)
		}
		courses := append([]string{}, bySlug[slug]...)
		sort.Strings(courses)

		segs := []store.Segment{}
		seq := 1
		if digest[slug] != "" {
			segs = append(segs, store.Segment{Seq: 0, Kind: "digest", Text: digest[slug]})
		}
		for _, cid := range courses {
			segs = append(segs, store.Segment{Seq: seq, Kind: "course", Text: "course/" + cid})
			seq++
		}
		t := title[slug]
		if t == "" {
			t = slug
		}
		if err := st.UpsertSegmentItem(store.SegmentItem{
			ItemID: itemID, Source: "category", Type: "category", Title: t, Segments: segs,
		}); err != nil {
			errs = append(errs, itemID+": "+err.Error())
		}
	}
	return errs
}
```

- [ ] **Step 4: `Run` 插入阶段 3.5**

`internal/importer/md.go`：在阶段 3 的循环之后、阶段 4 之前插入：

```go
	// 阶段 3.5：分类容器全量重算（册子 §3.2）。必须在课程/课时容器重建之后，
	// 因为它要读「库中既有的分类」，而不依赖本次 Run 之外的信息。
	for _, e := range rebuildCategories(st, items) {
		res.Failed++
		res.Errors = append(res.Errors, e)
	}
```

- [ ] **Step 5: 跑分类用例确认全绿**

Run: `go test ./internal/importer -run TestCategory -v`
Expected: 全部 PASS（含 Task 2 的四个）

- [ ] **Step 6: 跑同包全量回归**

Run: `go test ./internal/importer -count=1 -v`
Expected: 全 PASS

- [ ] **Step 7: 提交**

```powershell
git add internal/importer/md.go internal/importer/course.go internal/importer/category_test.go
git commit -m "feat(importer): 按 front-matter 产出 category 容器并强制单归属"
```

---

### Task 4: 节点侧端到端（导入 → 导出 → 接收侧入库）

**Files:**
- Create: `internal/packexport/category_test.go`

`internal/packexport` 的测试包已 import `internal/importer`（见 `export_test.go:11`），且 `packexport` 非测试代码不反向依赖 `importer`，故此处可安全复用 `importer.Run` 造夹具。

- [ ] **Step 1: 写测试 `internal/packexport/category_test.go`**

```go
package packexport

import (
	"database/sql"
	"os"
	"path/filepath"
	"testing"

	_ "modernc.org/sqlite"

	"github.com/johocn/base/internal/importer"
	"github.com/johocn/base/internal/protocol"
	"github.com/johocn/base/internal/store"
)

// writeCategorySeed 造一个含分类声明的 markdown 目录。
func writeCategorySeed(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	files := map[string]string{
		"10-a.md": "---\nslug: a\ntitle: 甲\ncourse: c2\nlesson: l1\ncategory: math\ncategory_title: 数学\ncategory_digest: 数学入门\n---\n\n甲的正文\n",
		"20-b.md": "---\nslug: b\ntitle: 乙\ncourse: c1\nlesson: l1\ncategory: math\n---\n\n乙的正文\n",
	}
	for name, body := range files {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(body), 0o644); err != nil {
			t.Fatalf("写 %s: %v", name, err)
		}
	}
	return dir
}

func TestExportCategoryContainer(t *testing.T) {
	st, _ := seedStore(t) // export_test.go 既有夹具
	dir := writeCategorySeed(t)
	if _, err := importer.Run(st, dir, importer.Options{}); err != nil {
		t.Fatalf("importer.Run: %v", err)
	}

	res, err := Export(st, fixedOptions(st)) // export_test.go 既有夹具
	if err != nil {
		t.Fatalf("Export: %v", err)
	}

	// 导出侧：pack.sqlite 里必须有 category/math 条目与三行清单（简介 + 两门课）
	db, err := sql.Open("sqlite", "file:"+filepath.ToSlash(res.PackPath)+"?mode=ro")
	if err != nil {
		t.Fatalf("打开 pack: %v", err)
	}
	defer db.Close()
	var source, typ, table, title string
	if err := db.QueryRow(`SELECT source,type,sqlite_table,title FROM items WHERE item_id='category/math'`).
		Scan(&source, &typ, &table, &title); err != nil {
		t.Fatalf("pack.items 里没有 category/math: %v", err)
	}
	if source != "category" || typ != "category" || table != "segments" || title != "数学" {
		t.Fatalf("分类条目列值异常: %s/%s/%s/%s", source, typ, table, title)
	}
	rows, err := db.Query(`SELECT seq,kind,text FROM segments WHERE item_id='category/math' ORDER BY seq ASC`)
	if err != nil {
		t.Fatalf("pack.segments: %v", err)
	}
	type row struct {
		seq  int
		kind string
		text string
	}
	got := []row{}
	for rows.Next() {
		var r row
		if err := rows.Scan(&r.seq, &r.kind, &r.text); err != nil {
			t.Fatal(err)
		}
		got = append(got, r)
	}
	if err := rows.Close(); err != nil {
		t.Fatal(err)
	}
	want := []row{{0, "digest", "数学入门"}, {1, "course", "course/c1"}, {2, "course", "course/c2"}}
	if len(got) != len(want) {
		t.Fatalf("分类清单 = %+v, want %+v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("第 %d 行 = %+v, want %+v", i, got[i], want[i])
		}
	}

	// manifest 里的分类条目必须是 segments 表 + 容器级哈希
	var entry *protocol.Entry
	for i := range res.Manifest.Entries {
		if res.Manifest.Entries[i].ItemID == "category/math" {
			entry = &res.Manifest.Entries[i]
		}
	}
	if entry == nil || entry.SQLiteTable != "segments" {
		t.Fatalf("manifest 缺分类条目: %+v", entry)
	}

	// 确定性：同参数两次导出字节一致（须先关只读句柄，见「执行期更正 1」）
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}
	second, err := Export(st, fixedOptions(st))
	if err != nil {
		t.Fatalf("二次 Export: %v", err)
	}
	if second.PackSHA256 != res.PackSHA256 {
		t.Fatalf("含分类条目的导出必须字节一致: %s != %s", second.PackSHA256, res.PackSHA256)
	}
}

func TestImportPackAcceptsCategoryContainer(t *testing.T) {
	st, _ := seedStore(t)
	segs := []store.Segment{
		{Seq: 0, Kind: "digest", Text: "数学入门"},
		{Seq: 1, Kind: "course", Text: "course/c1"},
	}
	res, err := st.ImportPack(9, []store.PackEntry{{
		ItemID: "category/math", Source: "category", Type: "category", Title: "数学",
		ContentHash: store.SegmentsContentHash(segs),
		SQLiteTable: "segments", DistClass: "public", Segments: segs,
	}}, nil)
	if err != nil {
		t.Fatalf("ImportPack: %v", err)
	}
	if res.Entries != 1 {
		t.Fatalf("Entries = %d, want 1", res.Entries)
	}
	back, err := st.ListSegments("category/math")
	if err != nil || len(back) != 2 {
		t.Fatalf("接收侧清单 = %d 行, err=%v", len(back), err)
	}
	if store.SegmentsContentHash(back) != store.SegmentsContentHash(segs) {
		t.Fatal("接收侧条目级哈希与导出侧不一致")
	}
	it, ok, _ := st.GetItem("category/math")
	if !ok || it.Source != "category" || it.Type != "category" || it.SQLiteTable != "segments" {
		t.Fatalf("接收侧分类条目异常: %+v ok=%v", it, ok)
	}
}
```

- [ ] **Step 2: 跑测试并修正夹具（不改生产代码）**

Run: `go test ./internal/packexport -run 'Category|CategoryContainer' -v`
Expected: PASS

> 若 `Export` 因「条目在 segments 表缺失」等既有前置校验报错，按实际报错补齐夹具（例如 `ContentHash` 取 `store.SegmentsContentHash(segs)`）；**不得改动 `internal/packexport` 与 `internal/store` 的生产代码**。

- [ ] **Step 3: 全仓门禁**

Run: `go build ./... ; go vet ./... ; go test ./... -count=1`
Expected: 全包 ok

- [ ] **Step 4: 提交**

```powershell
git add internal/packexport/category_test.go
git commit -m "test(packexport): 补分类容器导出与接收侧入库的端到端用例"
```

---

### Task 5: 手机端 `course-tree.ts` 三个纯函数

**Files:**
- Modify: `apps/mobile/src/core/course-tree.ts`
- Modify: `apps/mobile/src/core/course-tree.test.ts`

`core/types.ts` **无需改动**：`ItemRow.source` / `type` 已是 `string`，无字面量联合。（spec §5.1 那句「若既有类型对 source 做了字面量联合」的检查结论 = 不适用。）

- [ ] **Step 1: 先写失败测试（`course-tree.test.ts` 追加）**

```ts
describe('splitCategories', () => {
  it('取 source=category 的条目，按 itemId 升序，不改动入参', () => {
    const items = [
      item('category/zz', 'category'),
      item('category/aa', 'category'),
      item('course/c1', 'course'),
    ];
    const snapshot = [...items];
    expect(splitCategories(items).map((c) => c.itemId)).toEqual(['category/aa', 'category/zz']);
    expect(items).toEqual(snapshot);
  });

  it('无分类时返回空数组（旧包兼容：首页退化为两级）', () => {
    expect(splitCategories([item('course/c1', 'course')])).toEqual([]);
  });
});

describe('coursesOfCategory', () => {
  const cat = item('category/math', 'category');
  const c1 = item('course/c1', 'course');
  const c2 = item('course/c2', 'course');

  it('按清单 seq 升序解析课程，乱序入参也按 seq', () => {
    const segs = [
      seg('category/math', 2, 'course', 'course/c2'),
      seg('category/math', 0, 'digest', '简介'),
      seg('category/math', 1, 'course', 'course/c1'),
    ];
    expect(coursesOfCategory(cat.itemId, [c1, c2], segs).map((c) => c.itemId)).toEqual([
      'course/c1',
      'course/c2',
    ]);
  });

  it('悬空引用静默跳过，不报错、不影响其它课程', () => {
    const segs = [
      seg('category/math', 1, 'course', 'course/nope'),
      seg('category/math', 2, 'course', 'course/c1'),
    ];
    expect(coursesOfCategory(cat.itemId, [c1], segs).map((c) => c.itemId)).toEqual(['course/c1']);
  });

  it('只认自己 itemId 的 segments 行', () => {
    const segs = [
      seg('category/other', 1, 'course', 'course/c1'),
      seg('category/math', 1, 'course', 'course/c2'),
    ];
    expect(coursesOfCategory(cat.itemId, [c1, c2], segs).map((c) => c.itemId)).toEqual(['course/c2']);
  });
});

describe('lessonOfCarrier', () => {
  it('课程内载体返回其课时 id', () => {
    expect(lessonOfCarrier('course/c1/lesson/l1/article/a1')).toBe('course/c1/lesson/l1');
    expect(lessonOfCarrier('course/c1/lesson/l2/quiz/q1')).toBe('course/c1/lesson/l2');
  });

  it('独立文章 / 独立题库 / 课程与课时自身返回空串', () => {
    expect(lessonOfCarrier('article/a1')).toBe('');
    expect(lessonOfCarrier('quiz/q1')).toBe('');
    expect(lessonOfCarrier('course/c1')).toBe('');
    expect(lessonOfCarrier('course/c1/lesson/l1')).toBe('');
  });
});
```

顶部 import 改为：

```ts
import { childrenOf, coursesOfCategory, lessonOfCarrier, lessonNo, splitCategories, splitCourses } from './course-tree';
```

- [ ] **Step 2: 跑测试确认失败**

Run（cwd `apps/mobile`）: `npx vitest run src/core/course-tree.test.ts`
Expected: FAIL — `splitCategories is not a function` 等

- [ ] **Step 3: 在 `course-tree.ts` 追加实现**

```ts
/** 分类条目：source=category，按 itemId 升序（册子 §5.1）。分类之间无上级容器，故不排序字段。 */
export function splitCategories(items: ItemRow[]): ItemRow[] {
  return items.filter((it) => it.source === 'category').sort(byItemId);
}

/**
 * 一个分类下的课程：按该分类清单的 seq 升序解析 course/<cid>（册子 §3.2）。
 * 悬空引用（清单指向本地不存在的课程）**静默跳过**：不显示、不报错，不是错误状态。
 */
export function coursesOfCategory(catItemId: string, items: ItemRow[], segments: SegmentRow[]): ItemRow[] {
  const byId = new Map(items.map((it) => [it.itemId, it]));
  const own = segments.filter((s) => s.itemId === catItemId);
  const out: ItemRow[] = [];
  for (const id of childrenOf(own)) {
    const row = byId.get(id);
    if (row) out.push(row);
  }
  return out;
}

/**
 * 载体 item_id 所属的课时 id（`course/<cid>/lesson/<lid>`）（册子 §4 文章页入口）。
 * 不属于任何课时（独立文章 / 独立题库 / 课程或课时自身）返回空串。
 */
export function lessonOfCarrier(itemId: string): string {
  const parts = itemId.split('/');
  if (parts.length >= 5 && parts[0] === 'course' && parts[2] === 'lesson') {
    return parts.slice(0, 4).join('/');
  }
  return '';
}
```

- [ ] **Step 4: 跑测试确认通过**

Run（cwd `apps/mobile`）: `npx vitest run src/core/course-tree.test.ts`
Expected: PASS（7 既有 + 8 新增）

- [ ] **Step 5: 提交**

```powershell
git add apps/mobile/src/core/course-tree.ts apps/mobile/src/core/course-tree.test.ts
git commit -m "feat(mobile): course-tree 增分类分组与载体课时归属的纯函数"
```

---

### Task 6: 手机端课程页四级浏览

**Files:**
- Modify: `apps/mobile/src/pages/course/course.vue`

**口径（spec §5.2）：**

```
分类（category/<slug>，按 itemId 升序；空清单分类不显示）
  └─ 课程（course/<cid>，按分类清单 seq 升序）
       └─ 课时 / 载体 —— 沿用既有 pages/course/detail 页面与路由，本页不改
未归类
  ├─ 未归类课程（未被任何分类清单引用的 course/<cid>，按 itemId 升序）
  └─ 独立内容（article/<aid> 与 quiz/<qid>，按 itemId 升序）
```

- 全站无任何**非空**分类 ⇒ 退化为两级（「课程」平铺 + 「未归类」），视觉与改版前一致。
- 分类标题**可点击折叠/展开**，默认展开（点一下才收起的交互与 `detail.vue` 的课时展开同族）。

- [ ] **Step 1: 替换模板中的列表段**

把 `course.vue` 模板里从 `<text v-if="courses.length > 0" class="group">课程</text>` 到第二个 `v-for="it in ungrouped"` 的 `</view>`（原第 14–23 行）整段替换为：

```html
    <block v-if="groups.length > 0">
      <block v-for="g in groups" :key="g.category.itemId">
        <text class="group group-cat" @click="toggle(g.category.itemId)">
          {{ collapsed[g.category.itemId] ? '▸ ' : '▾ ' }}{{ g.category.title }}
        </text>
        <block v-if="!collapsed[g.category.itemId]">
          <view v-for="it in g.courses" :key="it.itemId" class="item" @click="openCourse(it.itemId)">
            <text class="item-title">{{ it.title }}</text>
            <text class="meta">{{ it.itemId }} · {{ it.rev }}</text>
          </view>
        </block>
      </block>
      <text v-if="unclassified.length > 0" class="group">未归类课程</text>
      <view v-for="it in unclassified" :key="it.itemId" class="item" @click="openCourse(it.itemId)">
        <text class="item-title">{{ it.title }}</text>
        <text class="meta">{{ it.itemId }} · {{ it.rev }}</text>
      </view>
      <text v-if="standalone.length > 0" class="group">独立内容</text>
      <view v-for="it in standalone" :key="it.itemId" class="item" @click="openStandalone(it)">
        <text class="item-title">{{ it.title }}</text>
        <text class="meta">{{ it.itemId }} · {{ it.rev }}</text>
      </view>
    </block>
    <block v-else>
      <text v-if="courses.length > 0" class="group">课程</text>
      <view v-for="it in courses" :key="it.itemId" class="item" @click="openCourse(it.itemId)">
        <text class="item-title">{{ it.title }}</text>
        <text class="meta">{{ it.itemId }} · {{ it.rev }}</text>
      </view>
      <text v-if="standalone.length > 0" class="group">未归类</text>
      <view v-for="it in standalone" :key="it.itemId" class="item" @click="openStandalone(it)">
        <text class="item-title">{{ it.title }}</text>
        <text class="meta">{{ it.itemId }} · {{ it.rev }}</text>
      </view>
    </block>
```

- [ ] **Step 2: 替换脚本的数据与加载逻辑**

把 `<script setup lang="ts">` 内从 `import { splitCourses }` 到 `load()` 结束整段替换为：

```ts
import { coursesOfCategory, splitCategories, splitCourses } from '../../core/course-tree';
import type { ItemRow } from '../../core/types';
import { bootstrap } from '../../platform';
import { canSync } from '../../core/selfcheck';

interface CategoryGroupVM {
  category: ItemRow;
  courses: ItemRow[];
}

const courses = ref<ItemRow[]>([]);
const groups = ref<CategoryGroupVM[]>([]);
const unclassified = ref<ItemRow[]>([]);
const standalone = ref<ItemRow[]>([]);
const collapsed = ref<Record<string, boolean>>({});
const total = computed(
  () => courses.value.length + groups.value.reduce((n, g) => n + g.courses.length, 0) + standalone.value.length,
);
const error = ref('');
const tip = ref('');
const busy = ref(false);
const syncBlocked = ref(false);

async function load() {
  try {
    const { repo, capabilities } = await bootstrap();
    syncBlocked.value = !canSync(capabilities);
    const all = await repo.listItems();
    const active = all.filter((i) => i.state !== 'removed');
    const tree = splitCourses(active);
    courses.value = tree.courses;

    // 分类分组：逐分类取清单（分类数量级远小于课程，逐条查询即可）；
    // 清单为空的分类不显示（既有分类在课程全部改归别处后会被重写成空清单）。
    const cats = splitCategories(active);
    const built: CategoryGroupVM[] = [];
    for (const cat of cats) {
      const segs = await repo.listSegments(cat.itemId);
      const cs = coursesOfCategory(cat.itemId, active, segs);
      if (cs.length === 0) continue;
      built.push({ category: cat, courses: cs });
    }
    groups.value = built;

    // 未归类课程 = 全部课程 − 被任一分类清单引用的课程
    const referenced = new Set<string>();
    for (const g of built) for (const c of g.courses) referenced.add(c.itemId);
    unclassified.value = tree.courses.filter((c) => !referenced.has(c.itemId));

    // 独立内容 = 独立文章 article/<aid> ∪ 独立题库 quiz/<qid>（册子 §5.2）
    standalone.value = [
      ...tree.ungrouped,
      ...active.filter((i) => i.type === 'quiz' && i.itemId.startsWith('quiz/')),
    ].sort((a, b) => (a.itemId < b.itemId ? -1 : a.itemId > b.itemId ? 1 : 0));

    error.value = '';
  } catch (e) {
    error.value = (e as Error).message;
  }
}

function toggle(itemId: string) {
  collapsed.value = { ...collapsed.value, [itemId]: !collapsed.value[itemId] };
}

function openStandalone(it: ItemRow) {
  if (it.type === 'quiz') {
    uni.navigateTo({ url: `/pages/quiz/quiz?itemId=${encodeURIComponent(it.itemId)}` });
    return;
  }
  openArticle(it.itemId);
}
```

`openArticle` / `openCourse` / `doSync` / `openSearch` / `onShow` 保持原样不动。

- [ ] **Step 3: 补样式**

`<style>` 块内追加一行（其余不动）：

```css
.group-cat { color: #2b6cb0; }
```

- [ ] **Step 4: 类型与构建门禁**

Run（cwd `apps/mobile`）: `npx tsc --noEmit ; npx vitest run`
Expected: tsc 干净（exit 0）；vitest 全绿

- [ ] **Step 5: `.vue` 的真实编译检查**

Run（cwd `apps/mobile`）: `npm run build:app`
Expected: 无报错产出 `dist/build/app`

> `.vue` 不在 `tsc --noEmit` 覆盖范围（`tsconfig.json` 只 `include: ["src"]` 且无 vue 插件），`build:app` 是它唯一的真实编译检查——见 #14 计划「执行期更正 9」。

- [ ] **Step 6: 发布前硬检查（模板内不得出现 `.value`）**

用 Grep 工具在 `apps/mobile/dist/build/app/app-service.js` 搜 `\.value\.value`，期望 **0 处**。

> **不要用 `Select-String`**：PowerShell 5.1 按 ANSI 读 UTF-8 会误判 0 命中（#14 计划已有此坑）。若产物不在这个路径，先用 Glob 在 `apps/mobile/dist` 下找 `app-service.js`。

- [ ] **Step 7: 提交**

```powershell
git add apps/mobile/src/pages/course/course.vue
git commit -m "feat(mobile): 课程页改分类分组四级浏览，无分类时退化为两级"
```

---

### Task 7: 手机端答题三入口

**Files:**
- Modify: `apps/mobile/src/pages/course/detail.vue`
- Modify: `apps/mobile/src/pages/article/article.vue`

**口径（spec §4，零契约变更）：** 关联不是新机制，quiz 本就以载体形态挂在课时下。本任务只把入口显式化：

| 入口 | 呈现 |
| --- | --- |
| 课程页 | 该课程全部课时内的 quiz，**按课时顺序分组** |
| 课时页 | 该课时内的 quiz（既有 `detail.vue` 的课时展开里已含 quiz 载体，不改） |
| 文章页 | **该文章所属课时内**的 quiz；文章无课程归属时无此入口 |

**不落任何学习态字段**：本任务不新增本地的作答结果写入。`quiz_attempt` 表与 `quiz.vue` 结算时的 `addAttempt` 是**既有的** #8 范围行为，本册不动、不删、不改（见「与 spec 的实现期细化」2 与 Task 8 Step 4 的 spec 回填）。

- [ ] **Step 1: `detail.vue` —— 增「本课程测验」块**

模板：在课时 `v-for` 那一整段 `</block>` 收尾之后、`v-else` 分支的 `</block>` 之前插入：

```html
        <block v-if="quizGroups.length > 0">
          <text class="group">本课程测验（{{ quizTotal }} 组）</text>
          <block v-for="qg in quizGroups" :key="qg.lessonId">
            <text class="quiz-lesson">{{ qg.lessonLabel }}</text>
            <view v-for="qz in qg.quizzes" :key="qz.itemId" class="carrier" @click="openQuiz(qz.itemId)">
              <text class="carrier-title">{{ qz.title }}</text>
            </view>
          </block>
        </block>
```

脚本：`import { ref } from 'vue';` 改为 `import { computed, ref } from 'vue';`。

`LessonVM` 接口之后追加：

```ts
interface QuizVM {
  itemId: string;
  title: string;
}
interface QuizGroupVM {
  lessonId: string;
  lessonLabel: string;
  quizzes: QuizVM[];
}
```

`const error = ref('');` 之后追加：

```ts
const quizGroups = ref<QuizGroupVM[]>([]);
const quizTotal = computed(() => quizGroups.value.reduce((n, g) => n + g.quizzes.length, 0));
```

`onLoad` 里从 `const acc: LessonVM[] = [];` 到 `lessons.value = acc;` 这一整段替换为：

```ts
    const acc: LessonVM[] = [];
    const quizzesByLesson: QuizGroupVM[] = [];
    for (const lid of lessonIds) {
      const lrow = await repo.getItem(lid);
      const carrierIds = childrenOf(await repo.listSegments(lid));
      const carriers: CarrierVM[] = [];
      for (const cid of carrierIds) {
        const crow = await repo.getItem(cid);
        carriers.push({ itemId: cid, type: crow?.type ?? '', title: crow?.title || cid });
      }
      const no = lessonNo(segments, lid);
      const title = lrow?.title || lid;
      acc.push({ itemId: lid, no, title, carriers });
      // 课程页的答题入口：该课时内的 quiz，按课时顺序分组（册子 §4）
      const quizzes = carriers
        .filter((c) => c.type === 'quiz')
        .map((c) => ({ itemId: c.itemId, title: c.title }));
      if (quizzes.length > 0) {
        quizzesByLesson.push({ lessonId: lid, lessonLabel: no > 0 ? `第 ${no} 讲 · ${title}` : title, quizzes });
      }
    }
    lessons.value = acc;
    quizGroups.value = quizzesByLesson;
```

（`lessonLabel` 函数保持不动：模板里 `lessonLabel(ls)` 仍在使用。）

新增跳转函数（`openCarrier` 之后）：

```ts
function openQuiz(itemId: string) {
  uni.navigateTo({ url: `/pages/quiz/quiz?itemId=${encodeURIComponent(itemId)}` });
}
```

样式追加：

```css
.group { display: block; margin: 20px 0 6px; color: #888888; font-size: 13px; }
.quiz-lesson { display: block; margin: 10px 0 2px; color: #666666; font-size: 13px; }
```

- [ ] **Step 2: `article.vue` —— 增「本课测验」块**

模板：`<view class="actions">...</view>` 之后、`v-for="(p, i) in paragraphs"` 之前插入：

```html
      <block v-if="siblingQuizzes.length > 0">
        <text class="group">本课测验</text>
        <view v-for="qz in siblingQuizzes" :key="qz.itemId" class="quiz-item" @click="openQuiz(qz.itemId)">
          <text class="quiz-title">{{ qz.title }}</text>
        </view>
      </block>
```

脚本：

1. import 块内**新增一行**（只有这一条，不要写两条）：

```ts
import { childrenOf, lessonOfCarrier } from '../../core/course-tree';
```

2. `const progress = ref(0);` 之后追加：

```ts
interface SiblingQuiz {
  itemId: string;
  title: string;
}
const siblingQuizzes = ref<SiblingQuiz[]>([]);
```

3. `onLoad` 内、`await repo.markRead(...)` 之前插入：

```ts
    // 文章页的答题入口：文章所属课时内的姊妹 quiz；文章无课程归属时无此入口（册子 §4）
    const lessonId = lessonOfCarrier(row.itemId);
    if (lessonId) {
      const acc: SiblingQuiz[] = [];
      for (const id of childrenOf(await repo.listSegments(lessonId))) {
        const sib = await repo.getItem(id);
        if (sib?.type === 'quiz') acc.push({ itemId: id, title: sib.title || id });
      }
      siblingQuizzes.value = acc;
    }
```

4. 新增跳转函数（`openComments` 之后）：

```ts
function openQuiz(itemId: string) {
  uni.navigateTo({ url: `/pages/quiz/quiz?itemId=${encodeURIComponent(itemId)}` });
}
```

5. 样式追加：

```css
.group { display: block; margin: 16px 0 6px; color: #888888; font-size: 13px; }
.quiz-item { padding: 10px 0; border-bottom: 1px solid #f2f2f2; }
.quiz-title { color: #2b6cb0; font-size: 15px; }
```

- [ ] **Step 3: 类型与构建门禁**

Run（cwd `apps/mobile`）: `npx tsc --noEmit ; npx vitest run`
Expected: tsc 干净；vitest 全绿

- [ ] **Step 4: `.vue` 编译检查 + 发布前硬检查**

Run（cwd `apps/mobile`）: `npm run build:app`
Expected: 无报错

Run（用 Grep 工具，**不要用 `Select-String`**——PowerShell 5.1 按 ANSI 读 UTF-8 会误判 0 命中）：
- 在 `apps/mobile/dist/build/app/app-service.js` 搜 `\.value\.value` → 期望 **0 处**；
- 同一文件搜 `本课程测验|本课测验` → 期望 **2 处**（两个页面各一处）。

> 若 `build:app` 的产物路径不是 `dist/build/app/app-service.js`，先用 Glob 在 `apps/mobile/dist` 下找 `app-service.js` 再核。

- [ ] **Step 5: 提交**

```powershell
git add apps/mobile/src/pages/course/detail.vue apps/mobile/src/pages/article/article.vue
git commit -m "feat(mobile): 课程页与文章页补测验入口（按课时分组）"
```

---

### Task 8: 版本号、全量门禁与文档回填

**Files:**
- Modify: `apps/mobile/src/manifest.json`
- Modify: `docs/README.md`
- Modify: `docs/superpowers/specs/2026-09-29-base-course-category-design.md`

- [ ] **Step 1: 版本号**

先读现值，再 **次版本 +1、`versionCode` +1**。计划编写时的现值是 `0.10.0` / `14`，且 #35 会在本计划之前发 `0.11.0` / `15` 与 `0.12.0` / `16`，故预期落 `0.13.0` / `17`：

`apps/mobile/src/manifest.json`：`"versionName" : "0.13.0"`，`"versionCode" : "17"`。

> 若执行时现值不是 `0.12.0` / `16`（例如 #35 尚未收口），**按现值就地 +1**，并在执行实况里记下实际值——不要机械照抄 `0.13.0`。

- [ ] **Step 2: 全量门禁**

Run（仓库根）: `go build ./... ; go vet ./... ; go test ./... -count=1`
Run（cwd `apps/mobile`）: `npx vitest run ; npx tsc --noEmit ; npm run build:h5 ; npm run build:app`

发布前两条硬检查（用 Grep 工具，**不要用 `Select-String`/`-match`**——PowerShell 5.1 按 ANSI 读 UTF-8 会误判 0 命中）：

1. 模板里不得出现 `.value`：在 `apps/mobile/src/pages/**/*.vue` 搜 `\{\{[^}]*\.value` → 期望 **0 处**；
2. 产物里不得出现双重解包：在 `apps/mobile/dist/build/app/app-service.js` 搜 `\.value\.value` → 期望 **0 处**。

Expected: 全绿；两条硬检查均 0 处。
若 `build:app` 的产物路径与上面不同，先用 Glob 在 `apps/mobile/dist` 下找 `app-service.js` 再核。

- [ ] **Step 3: `docs/README.md` 回填**

- §3 第 36 行状态改为：`已定稿（**实施计划 #36 已执行**，完整度见计划「执行实况」；真机验收待人工）`；
- §4 依赖图与 §5 当前阶段：**仅在 #35 已把这两节收口后**同步加一行「#36 已落地」；若 #35 仍在改这两节，保持不动，并在本计划的「执行实况」里登记「§4/§5 由 #35 收口后统一同步」。

- [ ] **Step 4: 册子回填（`docs/superpowers/specs/2026-09-29-base-course-category-design.md`）**

在 §0 追加一条 `### 0.2 2026-09-29 执行期口径回填`，写入四处：

1. **§3.1 补「分类内清单顺序」**：分类没有 `order` 键，清单按 `course/<cid>` 的 **cid 字典序升序**；这是确定性导出的必要条件（同一输入重复导出字节一致）。
2. **§3.2 补「未被声明的既有分类」**：导入器对**库中既有**的每个 `category/*` 条目也做一次重算；本轮未声明课程的分类被重写成**无课程行**的容器（`title` / `digest` 沿用既有），客户端跳过空清单分类，故不出现空分组。
3. **§3.4 补两条 fail-fast**：`category` 非空时必须是合法 slug；声明了 `category` 就必须有 `course`（分类只承载课程归属）。
4. **§6 AC 7 措辞收窄**：原文「节点与本地均无任何作答结果行」不成立——本地 `quiz_attempt` 表与 `pages/quiz/quiz.vue` 结算时的 `addAttempt` 是 #8 范围的**既有**行为，本册不动。AC 7 判据改为「**本册不新增任何作答结果写入**；节点侧无作答结果表；分类 / 答题入口的改动不触及 `quiz_attempt`」。同时 §4「不记录任何作答结果」一句加限定词「不**新增**」。

- [ ] **Step 5: 提交**

```powershell
git add apps/mobile/src/manifest.json docs/README.md docs/superpowers/specs/2026-09-29-base-course-category-design.md
git commit -m "docs(spec): 回填课程分类执行期口径并升版本 0.13.0/17"
```

---

### Task 9: 发布四步与线上验证

**Files:** 无代码改动（只产出发布物）

本任务的**硬前置**：Task 8 Step 2 的全量门禁全绿。

- [ ] **Step 1: 节点二进制交叉编译与部署（仅当运营需要在节点上跑 `import-md`）**

```powershell
$env:GOOS="linux"; $env:GOARCH="amd64"; go build -o based-linux-amd64 ./cmd/based
```

上传后，在两个节点各备份旧二进制 → 替换 → `systemctl restart base` 与 `systemctl restart base-cache`（**两个 service 共用同一二进制，必须一起重启**）。

**探活判据（本册不新增任何 HTTP 接口与错误码，故不能用错误码探活）**：在节点上跑一次带分类的导入 + 导出，确认包里出现 `category/` 条目：

```bash
/opt/base/based import-md -dir <含 category front-matter 的目录> -data /opt/base/data
/opt/base/based export -data /opt/base/data -issuer <node> -key <sign key>
sqlite3 <新包>/pack.sqlite "SELECT item_id,source,type,sqlite_table FROM items WHERE item_id LIKE 'category/%'"
```

回滚：`mv /opt/base/based.bak-0.13.0 /opt/base/based && systemctl restart base && systemctl restart base-cache`

> 若本节点不承担内容导入（导入在别的机器上做），**可跳过本步**，只做后面三步；此时须在「执行实况」里写明跳过原因。

- [ ] **Step 2: 云打包 APK**

```powershell
D:\HBuilderX\cli.exe pack --project e:\code\base\apps\mobile --platform android --android.packagename uni.app.UNI936A667 --android.androidpacktype 3
```

- 记录字节数与 sha256，存到 `apps/mobile/dist/release/apk/base-0.13.0.apk`；
- **证书 SHA1 必须仍是 `19:95:21:ED:09:C0:9C:AD:58:B0:EB:34:D1:B3:CF:D1:BA:89:FF:19`**（与前几版一致才能覆盖安装）。

- [ ] **Step 3: 上线到 `/opt/appdl` 并改落地页**

```powershell
scp apps/mobile/dist/release/apk/base-0.13.0.apk root@118.190.217.242:/opt/appdl/base-0.13.0.apk
```

落地页 `/opt/appdl/index.html` **整页重写**（改指 `base-0.13.0.apk`）后 `scp`；改完确认页面上只出现新版本号（`sed` 后不得残留旧版本号）。

- [ ] **Step 4: 签发 release 文档并线上验证**

```bash
/opt/base/based release -out /opt/base-cache/data/release.json
```

线上验证：

```powershell
(Invoke-WebRequest http://118.190.217.242/v1/release -UseBasicParsing).Content
```

Expected: `version_name=0.13.0`、`apk_size` / `apk_sha256` 与本地一致；
`http://118.190.217.242/dl/base-0.13.0.apk` 返回 `200` 且 `Content-Length` 与本地一致；
客户端 `verifyRelease` 对线上文档实测 `true`。

- [ ] **Step 5: 回填「执行实况」并提交**

在本文档末尾「执行实况」章节按 #14 计划的体例逐条记录：提交哈希、门禁实况、APK 字节数/sha256、证书 SHA1、线上返回、与计划的差异。然后：

```powershell
git add docs/superpowers/plans/2026-09-29-base-course-category-plan.md
git commit -m "docs(plan): 回填课程分类执行实况与更正"
git push origin master
```

- [ ] **Step 6: 真机 / 模拟器验收（人工）**

1. 首页在有分类的节点数据下显示「分类 → 课程」分组，点标题可折叠；
2. 同步一个**不含分类**的旧包，首页退化为「课程 / 未归类」两级，且全部课程都在「课程」组（AC 6）；
3. 课程详情页出现「本课程测验」，按课时分组；文章页出现「本课测验」；两者都能进答题页。

---

## 自检清单（写完计划后核过）

**Spec 覆盖**

| spec 小节 | 落点 |
| --- | --- |
| §3.1 分类条目形态（`item_id` / `source` / `type` / `sqlite_table` / `title` / slug 规则） | Task 2 Step 4（slug 校验）、Task 3 Step 3（条目产出） |
| §3.2 归属模型（单归属 · 分类侧单向清单 · 悬空引用静默跳过） | Task 2 Step 4 / 5（单归属 fail-fast）、Task 3（全量重算）、Task 5 `coursesOfCategory` |
| §3.3 哈希口径（两条口径一字不改） | Task 3（走 `SegmentsContentHash`，无新规则）、Task 4 断言 |
| §3.4 front-matter 三键 + 单归属报错 | Task 2（全部） |
| §3.5 与既有包互通 | Task 5 `splitCategories([]) === []`、Task 9 Step 6 第 2 条 |
| §4 答题三入口（零契约变更、不落学习态） | Task 7；`quiz_attempt` 的既有行为在 Task 8 Step 4 回填 spec |
| §5.1 数据面（零新表、三个纯函数） | Task 5 |
| §5.2 四级浏览 + 空态退化 | Task 6 |
| §6 AC 1 端到端 | Task 4 |
| §6 AC 2 单归属 | Task 2 `TestCategorySingleAttributionFailsFast` |
| §6 AC 3 归属可换且课程哈希不变 | Task 3 `TestCategoryMoveClearsOldCategory` |
| §6 AC 4 `item_id` 不动 | Task 3 全部用例（全程不写 `course/` 前缀的条目 id）、Task 4 |
| §6 AC 5 确定性导出 | Task 3 `TestCategoryRunIdempotentAndDeterministic`、Task 4 |
| §6 AC 6 老包兼容 | Task 5 `splitCategories` 空数组用例、Task 9 Step 6 |
| §6 AC 7 答题入口 | Task 7（并收窄措辞，见下） |
| §6 AC 8 悬空引用 | Task 5 `coursesOfCategory` 悬空用例 |
| §6 AC 9 门禁全绿 | Task 1 Step 7、Task 4 Step 3、Task 6 Step 4–6、Task 7 Step 3–4、Task 8 Step 2 |
| §7.2 红线 1–5 | 红线 1/4 → Task 3 只产出 `digest`+`course` 两类行；红线 2 → Task 3 不重命名任何既有 id；红线 3 → 本计划不碰 `internal/httpapi` 的写路径（Task 1 仅等价替换）；红线 5 → Task 7 明确不新增作答写入 |
| §9 回填清单 | Task 8 Step 3（README）、Step 4（册子） |

**与 spec 的实现期细化（必须同步回填 spec，已写进 Task 8 Step 4）**

1. **分类内清单的排序规则 spec 未定义**：必须写死为 `course/<cid>` 的 cid 字典序升序，否则导出结果依赖文件遍历顺序，违反 §3.3 的确定性要求。
2. **「未被本 Run 声明的既有分类」spec 未定义**：必须重算（否则 AC 3 直接失败）；重算结果为空清单，客户端跳过空清单分类。
3. **§3.4 漏了两条 fail-fast**：`category` 必须是合法 slug；声明 `category` 必须有 `course`。
4. **§6 AC 7 的措辞与既有实现冲突**：本地 `quiz_attempt`（`repo.addAttempt` + `pages/quiz/quiz.vue` 结算）是 #8 范围的既有行为，本册不动。AC 7 须收窄为「本册不**新增**任何作答结果写入」。
5. **§5.1 未列 `lessonOfCarrier`**：文章页入口（§4）必须从 `item_id` 反推所属课时，故新增这一个纯函数。

**额外强调的实现约束**

- **分类硬校验是导入器「单文件失败不整批失败」契约的唯一例外**：`Run` 的阶段 1 只计 `Errors` 跳过坏文件，但分类冲突必须 `return Result{}, err` 整批退出——这是 spec §3.4 明写的 fail-fast，不要为了「与既有风格一致」把它降级成 `res.Errors`。
- **生产代码不得调用测试文件里的 helper**：`containsID` 定义在 `internal/importer/course_test.go`（测试文件），`rebuildCategories` 里的去重必须自建 map，不能复用它——否则 `go build ./...` 直接不过。
- **分类容器与 lesson/course 容器的合并口径刻意不同**：后者用 `mergeChildren`（要保住 `import-video` 产出的 video 行），分类是**全量替换**。混用会让 AC 3 失败。
- **分类硬校验必须在阶段 1.5（写库前）**：否则「报错退出」时库里已落了半批条目，「不产出任何包」就不再成立。
- **不得改动 `internal/store`、`internal/packexport`（非测试）、`internal/store/packimport.go` 的任何生产代码**：spec §2 已核实 `segments` 链路（写入 / 白名单 / 入库）全部零改动。本计划 Task 4 是**只加测试**。
- **`course/<cid>` 的 `item_id` 与 `content_hash` 全程不得变化**：Task 3 的分类重算只写 `category/*` 条目。
- **`.vue` 不在 `tsc --noEmit` 覆盖范围**：改 `.vue` 的任务必须跑 `npm run build:app`。
- **提交一律精确路径**：#35 的进程在同一 worktree，`git add -A` 会把它未提交的 spec/plan 一起卷进来。

---

## 执行实况

> 待执行后回填：每个 Task 的提交哈希、门禁实测数字、发布物字节数与 sha256、与计划的差异、以及需要登记为「更正 N」的项。

| # | 项 | 结果 |
| --- | --- | --- |
| 1 | Task 1 提交哈希 | 待填 |
| 2 | Task 2+3 提交哈希 | 待填 |
| 3 | Task 4 提交哈希 | 待填 |
| 4 | Task 5 提交哈希 | 待填 |
| 5 | Task 6 提交哈希 | 待填 |
| 6 | Task 7 提交哈希 | 待填 |
| 7 | Task 8 提交哈希（版本号与回填） | 待填 |
| 8 | 全量门禁实况（go / vitest / tsc / build:h5 / build:app） | 待填 |
| 9 | 云打包结果（字节数 / sha256 / 证书 SHA1） | 待填 |
| 10 | 线上验证（`/v1/release`、APK 200、`verifyRelease`） | 待填 |
| 11 | 真机验收三条（人工） | 待填 |
| 12 | `docs/README.md` §4/§5 是否已随 #35 收口 | 待填 |
