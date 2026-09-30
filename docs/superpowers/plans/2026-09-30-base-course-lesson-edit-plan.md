# 课程与课时字段模型 + 双端编辑 实施计划（A 主线 第 3 册）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用 `segments` 的 `attr.*` 槽位把课程 / 课时的全部字段落库（零新表），新开 `POST /v1/blob` 上传面，手机端补齐课程 / 课时编辑页，并把课程页改纯课时清单、新增课时页（方案 A）。

**Architecture:** 节点侧新增 `protocol.AssignAttrSeqs` 的确定性 `seq<0` 分配（双端契约向量守门）、`store.UpsertSegmentSubmission`（容器投稿同事务落库）、`POST /v1/submit` 扩 `course|lesson` 两个容器形态、`POST /v1/blob`（multipart 单块内容寻址）。手机端镜像同一套属性规则生成 `segments` 行集，经既有投稿台账（`my_submissions`）提交与离线补发。

**Tech Stack:** Go 1.2x（`internal/protocol`、`internal/store`、`internal/httpapi`、`internal/importer`）／ TypeScript + Vue 3 + uni-app（`apps/mobile`）／ vitest ／ `vectors/v1/*.json` 双端契约向量。

**上游 spec:** `docs/superpowers/specs/2026-09-30-base-course-lesson-edit-design.md`（#40，已批准）。

---

## 开工前已核实的现状（执行时不要重新调研，直接用）

| 事实 | 位置 |
| --- | --- |
| `maxJSONBody = 64 << 10`，`authenticate` 内 `io.LimitReader(r.Body, maxJSONBody+1)`、超限回 `413 auth_body_too_large` | `internal/httpapi/identity.go:20`、`internal/httpapi/authmw.go:193,199` |
| `requireAuth` / `optionalAuth` 是 `authenticate` 的两个包装 | `internal/httpapi/authmw.go:93,105` |
| `GET/HEAD /v1/blob/{blob_id}` 已挂在 `publicMux`；`POST` 未挂 | `internal/httpapi/server.go:107-108` |
| `protocol.BlobID(b) = hex(sha256(b))[:32]`、`IsBlobID` = 32 hex | `internal/protocol/hash.go:20,25` |
| `store.PutBlob(blobID, data, itemID, seq)`：校验 id ↔ 内容一致后加密落盘 + upsert `blobs` | `internal/store/store.go:326` |
| `store.SegmentsContentHash(segs)`：按 seq 升序拼 `"<kind>\t<text>\n"` 的 sha256 | `internal/store/segments.go:37` |
| `store.UpsertSegmentItem`：先 upsert items、再 `DELETE FROM segments WHERE item_id=?`、再按 seq 升序插入；**不写 author_id** | `internal/store/segments.go:52` |
| `store.UpsertSubmission`：占用判定 `SELECT author_id FROM items WHERE item_id=?`；`sql.ErrNoRows`→created、`cur != AuthorID`（含空归属）→`ErrItemTaken` | `internal/store/submission.go:28` |
| `httpapi.splitSubmitItemID` 现只认 `article/<slug>` / `quiz/<slug>`；`course/` 一律 `item_id_invalid` | `internal/httpapi/submit.go:36` |
| `handleSubmitPost` 已有 `author_id_forbidden` / `item_type_unsupported` / `item_id_invalid` / `item_type_mismatch` / `item_title_invalid` / `item_body_too_large` / `item_question_invalid` / `item_rate_limited` / `author_sig_invalid` / `item_id_taken` 全部分支 | `internal/httpapi/submit.go:102-242` |
| 错误码 → 人读文案表 `authErrText`；**无** `item_segments_invalid` / `blob_too_large` / `bad_multipart` | `internal/httpapi/authmw.go:20-75` |
| `importer.rebuildContainer` / `rebuildCategories` / `ensureLessonChild`；`childIDsOf`(seq>=1) / `digestTextOf`(seq==0) / `mergeChildren` | `internal/importer/course.go:110-269` |
| `importer.Result{Imported,Failed,Errors}`；`Run` 阶段 3 `rebuildContainers`、阶段 3.5 `rebuildCategories` | `internal/importer/md.go:35-39,240,247` |
| `store.replaceTagLinksTx` 里 `DELETE FROM segments WHERE item_id=?` | `internal/store/tag.go:82` |
| 手机端 `childrenOf` 只认 `seq>=1`；`lessonNo` = 清单位次；`lessonOfCarrier` | `apps/mobile/src/core/course-tree.ts` |
| `HttpAdapter.post(url, body: Uint8Array, headers)`（**非 2xx 不抛错**） | `apps/mobile/src/platform/adapter.ts:24-29` |
| `core/submit.ts`：`SubmitDraft{itemId,type,title,bodyMd,questionJson,links?}`、`contentHashOf`、`buildSubmitBody`、`enqueueOrSend`、`flushSubmissions`；`newItemID` 只产 `article|quiz` | `apps/mobile/src/core/submit.ts` |
| `my_submissions` 表列：`item_id,type,title,body_md,question_json,links_json,state,reason,created,queued_at,sent_at` | `apps/mobile/src/core/repo.ts:126-129` |
| `pages.json` 现有页：`pages/course/course`、`pages/course/detail`、`pages/submit/submit` 等（**无** 课时页 / 课程编辑页 / 课时编辑页） | `apps/mobile/src/pages.json` |
| 手机端版本现值 `versionName "0.14.0"` / `versionCode "19"` | `apps/mobile/src/manifest.json:5-6` |
| Go 契约向量读法：`os.ReadFile(filepath.Join("..","..","vectors","v1",name))` | `internal/protocol/authorsig_vector_test.go:11` |
| TS 契约向量读法：`readFileSync(new URL("../../../../vectors/v1/x.json", import.meta.url),"utf8")`（`apps/mobile/src/core/*.test.ts` 层深 = 4） | `packages/protocol-ts/src/aead.test.ts:51` |
| 手机端测试入口：`npx vitest run`（当前 19 文件全绿）、`npx tsc --noEmit` | `apps/mobile/package.json:10-11` |
| 节点二进制部署：`GOOS=linux GOARCH=amd64 go build -o based-linux-amd64 ./cmd/based` → `scp` → `/opt/base/based` → 重启 `base` + `base-cache` | `docs/superpowers/plans/2026-09-30-base-tagging-plan.md:3404-3441` |

**工作区注意：** 有未提交的 `.gitignore` 改动与未跟踪的 `based-linux-amd64`，**不要动、不要 add**。

---

## 文件结构（先定边界，再拆任务）

**节点侧（Go）**

| 文件 | 动作 | 职责 |
| --- | --- | --- |
| `internal/protocol/attrs.go` | 创建 | `attr.*` kind 常量、`IsAttrKind`、`AttrLine`/`AttrSlot`、`AssignAttrSeqs`、`AttrSeqsCanonical` |
| `internal/protocol/attrs_vector_test.go` | 创建 | 消费 `vectors/v1/attrs.json`，锁死 `seq<0` 分配规则 |
| `vectors/v1/attrs.json` | 创建 | 双端共用的属性行 → 槽位契约向量 |
| `internal/store/submission.go` | 修改 | 新增 `SegmentSubmission` + `UpsertSegmentSubmission`（容器投稿同事务） |
| `internal/httpapi/submit.go` | 修改 | 新增 `itemTypeCourse`/`itemTypeLesson`、`containerShapeOf`、`submitSegment`、`validateSubmitSegments`，`handleSubmitPost` 加容器分支 |
| `internal/httpapi/authmw.go` | 修改 | `authenticate` 体上限参数化；新增 `requireAuthLimit`；补 3 个错误码文案 |
| `internal/httpapi/identity.go` | 修改 | `decodeJSON` 的 `maxJSONBody` 语义注释（不改行为） |
| `internal/httpapi/blob.go` | 创建 | `POST /v1/blob`（multipart 单块） |
| `internal/httpapi/server.go` | 修改 | 挂 `POST /v1/blob` 到 `publicMux`（走 `requireAuthLimit`） |
| `internal/importer/course.go` | 修改 | 三处重建保留 `seq<0` 行；投稿域容器跳过（sentinel error） |
| `internal/importer/md.go` | 修改 | `Result.Warnings`；`rebuildContainers` 把跳过转 warning |
| `internal/importer/video.go` | 修改 | `ensureLessonChild` 的跳过转 warning |
| `internal/store/tag.go` | 修改 | `replaceTagLinksTx` 只删 `seq>=1` |

**手机端（TS / Vue）**

| 文件 | 动作 | 职责 |
| --- | --- | --- |
| `apps/mobile/src/core/attrs.ts` | 创建 | 属性规则镜像（`assignAttrSeqs` / `attrSeqsCanonical` / 常量） |
| `apps/mobile/src/core/attrs.test.ts` | 创建 | 消费同一份 `vectors/v1/attrs.json` |
| `apps/mobile/src/core/container-view.ts` | 创建 | 容器属性解析（`attrsOf` / `digestOf` / `lessonDigest` / 子项计数） |
| `apps/mobile/src/core/container-view.test.ts` | 创建 | 上述纯函数单测 |
| `apps/mobile/src/core/blob.ts` | 创建 | multipart 体构造 + `POST /v1/blob` 上传封装 |
| `apps/mobile/src/core/blob.test.ts` | 创建 | 上传幂等 / 超限 / 无签名单测（FakeHttp） |
| `apps/mobile/src/core/course-edit.ts` | 创建 | 课程 / 课时编辑编排：表单 → 完整行集 → 台账提交；编辑回填 |
| `apps/mobile/src/core/course-edit.test.ts` | 创建 | 行集构造 / 回填 / 离线入队单测 |
| `apps/mobile/src/core/submit.ts` | 修改 | `SubmitDraft` 扩 `course|lesson`；`newItemID` 扩两型；`buildSubmitBody` 走 `segments` |
| `apps/mobile/src/core/types.ts` | 修改 | `MySubmissionRow.type` 扩 `course|lesson`；`SubmitSegmentRow` |
| `apps/mobile/src/core/repo.ts` | 修改 | `toMySubmissionRow` 的 type 归一扩两型；`my_submissions` 新增 `segments_json` 列 + 幂等补列 |
| `apps/mobile/src/pages/course/edit.vue` | 创建 | 课程编辑页（新建 / 编辑两模式） |
| `apps/mobile/src/pages/lesson/edit.vue` | 创建 | 课时编辑页 |
| `apps/mobile/src/pages/lesson/detail.vue` | 创建 | 课时页（方案 A） |
| `apps/mobile/src/pages/course/detail.vue` | 修改 | 改纯课时清单：下线手风琴与测验汇总块、空课时与悬空引用占位、页顶课程级字段、编辑入口 |
| `apps/mobile/src/pages.json` | 修改 | 注册三张新页 |
| `apps/mobile/src/manifest.json` | 修改 | 版本 `0.15.0` / `20` |

> **为什么 `my_submissions` 要加一列：** 现有台账只有 `body_md` / `question_json` / `links_json` 三个载荷列，容器行集塞不进去。新增 `segments_json TEXT NOT NULL DEFAULT ''`（走既有 `ensureSubmissionColumns` 幂等补列手法），比新表更省——台账仍是「我的条目」的唯一列表本体（spec §6）。

---

### Task 1: `protocol.AssignAttrSeqs` 与双端契约向量

**Files:**
- Create: `internal/protocol/attrs.go`
- Create: `internal/protocol/attrs_vector_test.go`
- Create: `vectors/v1/attrs.json`

- [ ] **Step 1: 写失败的测试**

创建 `internal/protocol/attrs_vector_test.go`：

```go
package protocol

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestAttrVectorFile(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("..", "..", "vectors", "v1", "attrs.json"))
	if err != nil {
		t.Fatalf("read vectors: %v", err)
	}
	var f struct {
		Version int `json:"version"`
		Cases   []struct {
			Name  string     `json:"name"`
			Lines []AttrLine `json:"lines"`
			Slots []AttrSlot `json:"slots"`
		} `json:"cases"`
	}
	if err := json.Unmarshal(raw, &f); err != nil {
		t.Fatalf("parse vectors: %v", err)
	}
	if f.Version != 1 || len(f.Cases) == 0 {
		t.Fatalf("向量文件结构错误: version=%d cases=%d", f.Version, len(f.Cases))
	}
	for _, c := range f.Cases {
		t.Run(c.Name, func(t *testing.T) {
			got := AssignAttrSeqs(c.Lines)
			if len(got) != len(c.Slots) {
				t.Fatalf("槽位数 %d != %d: got=%+v", len(got), len(c.Slots), got)
			}
			for i := range got {
				if got[i] != c.Slots[i] {
					t.Fatalf("第 %d 槽: got=%+v want=%+v", i, got[i], c.Slots[i])
				}
			}
			// 向量自身必须是「规范排布」，否则 AttrSeqsCanonical 的门就形同虚设。
			if !AttrSeqsCanonical(c.Slots) {
				t.Fatalf("向量 slots 不是规范排布: %+v", c.Slots)
			}
		})
	}
}

// 同一 kind 至多一行（唯 attachment 可多行）：超出部分按确定性规则取首行，不报错。
func TestAssignAttrSeqsSingleRowPerKind(t *testing.T) {
	got := AssignAttrSeqs([]AttrLine{
		{Kind: AttrKeyInstructor, Text: "甲"},
		{Kind: AttrKeyInstructor, Text: "乙"},
	})
	if len(got) != 1 || got[0].Text != "甲" || got[0].Seq != -1 {
		t.Fatalf("同 kind 多行应只留首行: %+v", got)
	}
}

func TestIsAttrKind(t *testing.T) {
	if !IsAttrKind(AttrKeyCover) || !IsAttrKind(AttrKeyBodyMD) {
		t.Fatal("六种属性 kind 均应通过")
	}
	for _, k := range []string{"", "attr.", "attr.unknown", "digest", "lesson", "article"} {
		if IsAttrKind(k) {
			t.Fatalf("应非法: %q", k)
		}
	}
}
```

- [ ] **Step 2: 跑测试确认失败**

Run（仓库根）: `go test ./internal/protocol/ -run 'TestAttr' -v`
Expected: FAIL —— `undefined: AttrLine` / `undefined: AssignAttrSeqs`（编译失败）。

- [ ] **Step 3: 写契约向量文件**

创建 `vectors/v1/attrs.json`（逐字节写死，勿格式化改动）：

```json
{
  "version": 1,
  "cases": [
    {
      "name": "六属性全给",
      "lines": [
        {"kind": "attr.instructor", "text": "李老师"},
        {"kind": "attr.duration", "text": "3600"},
        {"kind": "attr.difficulty", "text": "basic"},
        {"kind": "attr.cover", "text": "00112233445566778899aabbccddeeff"},
        {"kind": "attr.body_md", "text": "# 正文\n\n段落\n"},
        {"kind": "attr.attachment", "text": "ffffffffffffffffffffffffffffffff\t附录.pdf"},
        {"kind": "attr.attachment", "text": "00000000000000000000000000000000\t讲义.pdf"}
      ],
      "slots": [
        {"seq": -1, "kind": "attr.attachment", "text": "00000000000000000000000000000000\t讲义.pdf"},
        {"seq": -2, "kind": "attr.attachment", "text": "ffffffffffffffffffffffffffffffff\t附录.pdf"},
        {"seq": -3, "kind": "attr.body_md", "text": "# 正文\n\n段落\n"},
        {"seq": -4, "kind": "attr.cover", "text": "00112233445566778899aabbccddeeff"},
        {"seq": -5, "kind": "attr.difficulty", "text": "basic"},
        {"seq": -6, "kind": "attr.duration", "text": "3600"},
        {"seq": -7, "kind": "attr.instructor", "text": "李老师"}
      ]
    },
    {
      "name": "仅封面与讲师",
      "lines": [
        {"kind": "attr.instructor", "text": "王老师"},
        {"kind": "attr.cover", "text": "00112233445566778899aabbccddeeff"}
      ],
      "slots": [
        {"seq": -1, "kind": "attr.cover", "text": "00112233445566778899aabbccddeeff"},
        {"seq": -2, "kind": "attr.instructor", "text": "王老师"}
      ]
    },
    {
      "name": "无属性",
      "lines": [],
      "slots": []
    }
  ]
}
```

- [ ] **Step 4: 写最小实现**

创建 `internal/protocol/attrs.go`：

```go
package protocol

import "sort"

// 属性行的 kind 取值域（本册 §2.1 槽位表）：seq<0 只放属性行，kind 必以 "attr." 开头。
const (
	AttrKindPrefix = "attr."

	AttrKeyAttachment = "attr.attachment"
	AttrKeyBodyMD     = "attr.body_md"
	AttrKeyCover      = "attr.cover"
	AttrKeyDifficulty = "attr.difficulty"
	AttrKeyDuration   = "attr.duration"
	AttrKeyInstructor = "attr.instructor"

	// 难度枚举（本册 §2.1）。
	DifficultyIntro    = "intro"
	DifficultyBasic    = "basic"
	DifficultyAdvanced = "advanced"

	// DigestKind 是 seq=0 的简介行 kind（既有约定，一字不改）。
	DigestKind = "digest"
)

// AttrKindSet 是属性行的合法 kind 集合；只有落在这里的 kind 才算属性行。
var AttrKindSet = map[string]bool{
	AttrKeyAttachment: true,
	AttrKeyBodyMD:     true,
	AttrKeyCover:      true,
	AttrKeyDifficulty: true,
	AttrKeyDuration:   true,
	AttrKeyInstructor: true,
}

// IsAttrKind 判定 kind 是否为合法属性行（本册 §2.1 铁律 1）。
func IsAttrKind(kind string) bool { return AttrKindSet[kind] }

// AttrLine 是一条待分配 seq 的属性行；AttrSlot 是分配后的结果。
type AttrLine struct {
	Kind string `json:"kind"`
	Text string `json:"text"`
}

type AttrSlot struct {
	Seq  int    `json:"seq"`
	Kind string `json:"kind"`
	Text string `json:"text"`
}

// AssignAttrSeqs 按本册 §2.1 铁律 2 为属性行分配 seq<0：
//  1. 按 kind **字典序**从 -1 起递减；
//  2. 同一 kind 至多一行，唯 attr.attachment 可多行——多行占**连续递减区间**，
//     同一 kind 内按 text（含 `<blob_id>\t<文件名>` 的整串）升序映射到递减 seq。
//
// 返回值天然按 seq 升序（第一个元素 seq 最小 = -1）。这是确定性导出的前提：
// 任何一端改了顺序，双端 content_hash 立刻漂移且不会报错（本册 §8 风险 2）。
func AssignAttrSeqs(lines []AttrLine) []AttrSlot {
	byKind := map[string][]string{}
	kinds := make([]string, 0, len(lines))
	for _, l := range lines {
		if _, ok := byKind[l.Kind]; !ok {
			kinds = append(kinds, l.Kind)
		}
		byKind[l.Kind] = append(byKind[l.Kind], l.Text)
	}
	sort.Strings(kinds)
	out := make([]AttrSlot, 0, len(lines))
	next := -1
	for _, k := range kinds {
		texts := byKind[k]
		if k == AttrKeyAttachment {
			sorted := append([]string{}, texts...)
			sort.Strings(sorted)
			for _, t := range sorted {
				out = append(out, AttrSlot{Seq: next, Kind: k, Text: t})
				next--
			}
			continue
		}
		if len(texts) == 0 {
			continue
		}
		out = append(out, AttrSlot{Seq: next, Kind: k, Text: texts[0]})
		next--
	}
	return out
}

// AttrSeqsCanonical 报告一组属性行是否已按 AssignAttrSeqs 的规则排布（调用方按 seq 升序传入）。
func AttrSeqsCanonical(slots []AttrSlot) bool {
	lines := make([]AttrLine, 0, len(slots))
	for _, s := range slots {
		lines = append(lines, AttrLine{Kind: s.Kind, Text: s.Text})
	}
	want := AssignAttrSeqs(lines)
	if len(want) != len(slots) {
		return false
	}
	for i := range want {
		if want[i] != slots[i] {
			return false
		}
	}
	return true
}
```

- [ ] **Step 5: 跑测试确认通过**

Run（仓库根）: `go test ./internal/protocol/ -run 'TestAttr|TestIsAttrKind|TestAssignAttrSeqs' -v`
Expected: PASS（4 个测试全绿）。

- [ ] **Step 6: 提交**

```bash
git add internal/protocol/attrs.go internal/protocol/attrs_vector_test.go vectors/v1/attrs.json
git commit -m "feat(protocol): 新增 attr.* 属性行槽位与确定性 seq<0 分配（含双端契约向量）"
```

---

### Task 2: `store.UpsertSegmentSubmission`（容器投稿同事务落库）

**Files:**
- Modify: `internal/store/submission.go`
- Test: `internal/store/submission_test.go`（已存在则追加；不存在则创建）

- [ ] **Step 1: 写失败的测试**

先 Glob 确认 `internal/store/submission_test.go` 是否存在；无论存在与否，**追加**以下内容（若文件不存在，则新建并只含 `package store` + 下面两个函数）：

```go
// 容器投稿：新建 → created=true；本人重投 → created=false 且行集被整体替换。
func TestUpsertSegmentSubmissionLifecycle(t *testing.T) {
	st := newTestStore(t)
	segs := []Segment{
		{ItemID: "course/c1", Seq: -1, Kind: "attr.cover", Text: "00112233445566778899aabbccddeeff"},
		{ItemID: "course/c1", Seq: 0, Kind: "digest", Text: "简介\n"},
		{ItemID: "course/c1", Seq: 1, Kind: "lesson", Text: "course/c1/lesson/l1"},
	}
	created, err := st.UpsertSegmentSubmission(SegmentSubmission{
		ItemID: "course/c1", Type: "course", Title: "甲课", Segments: segs, AuthorID: "aa", AuthorSig: "ff",
	})
	if err != nil || !created {
		t.Fatalf("新建: created=%v err=%v", created, err)
	}
	it, ok, err := st.GetItem("course/c1")
	if err != nil || !ok {
		t.Fatalf("GetItem: ok=%v err=%v", ok, err)
	}
	if it.AuthorID != "aa" || it.AuthorSig != "ff" || it.SQLiteTable != "segments" || it.Type != "course" {
		t.Fatalf("items 行不对: %+v", it)
	}
	if want := SegmentsContentHash(segs); it.ContentHash != want {
		t.Fatalf("content_hash=%s want=%s", it.ContentHash, want)
	}
	got, err := st.ListSegments("course/c1")
	if err != nil || len(got) != 3 {
		t.Fatalf("segments 行数 %d err=%v", len(got), err)
	}
	if got[0].Seq != -1 || got[2].Seq != 1 {
		t.Fatalf("segments 未按 seq 升序: %+v", got)
	}

	// 重投：整体替换（旧 seq=1 行消失）
	created2, err := st.UpsertSegmentSubmission(SegmentSubmission{
		ItemID: "course/c1", Type: "course", Title: "甲课改", AuthorID: "aa", AuthorSig: "ee",
		Segments: []Segment{{ItemID: "course/c1", Seq: -2, Kind: "attr.instructor", Text: "李老师"}},
	})
	if err != nil || created2 {
		t.Fatalf("重投: created=%v err=%v", created2, err)
	}
	got2, _ := st.ListSegments("course/c1")
	if len(got2) != 1 || got2[0].Seq != -2 {
		t.Fatalf("重投未整体替换: %+v", got2)
	}
}

// 空归属存量条目也拒（沿用 #25 口径）；他人条目同样拒，且两者都不得写入。
func TestUpsertSegmentSubmissionTaken(t *testing.T) {
	st := newTestStore(t)
	legacy := []Segment{{ItemID: "course/c2", Seq: 1, Kind: "lesson", Text: "course/c2/lesson/l1"}}
	if err := st.UpsertSegmentItem(SegmentItem{
		ItemID: "course/c2", Source: "course", Type: "course", Title: "存量", Segments: legacy,
	}); err != nil {
		t.Fatalf("UpsertSegmentItem: %v", err)
	}
	_, err := st.UpsertSegmentSubmission(SegmentSubmission{
		ItemID: "course/c2", Type: "course", Title: "认领", AuthorID: "aa", AuthorSig: "ff",
		Segments: []Segment{{ItemID: "course/c2", Seq: 0, Kind: "digest", Text: "x"}},
	})
	if !errors.Is(err, ErrItemTaken) {
		t.Fatalf("空归属条目应拒: err=%v", err)
	}
	got, _ := st.ListSegments("course/c2")
	if len(got) != 1 || got[0].Seq != 1 || got[0].Text != "course/c2/lesson/l1" {
		t.Fatalf("拒绝时不得写入: %+v", got)
	}
}
```

> 若 `newTestStore(t)` 在本包里叫别的名字，先 Grep `func newTestStore` / `store.Open(t.TempDir()` 在 `internal/store/*_test.go` 的既有写法，用同一个 helper；**不要新造 helper**。若本包用 `store.WithStoreKey(...)`，照抄既有调用。

- [ ] **Step 2: 跑测试确认失败**

Run（仓库根）: `go test ./internal/store/ -run 'TestUpsertSegmentSubmission' -v`
Expected: FAIL —— `undefined: SegmentSubmission`。

- [ ] **Step 3: 写实现**

在 `internal/store/submission.go` **追加**（`UpsertSubmission` 之后）：

```go
// SegmentSubmission 是一条容器（course / lesson）投稿（本册 §2.3 / §4.1）。
// Segments 必须是**完整行集**：含 seq<0 属性行、seq=0 简介行（可省）、seq>=1 清单行。
type SegmentSubmission struct {
	ItemID    string
	Type      string // course | lesson
	Title     string
	Segments  []Segment
	AuthorID  string
	AuthorSig string
	UpdatedAt string // 空则取当前 UTC
}

// UpsertSegmentSubmission 写入/更新一条容器投稿（items + segments 同事务），created=true 表示新建。
// 占用判定与 #25 逐字同口径：已存在且 author_id 不等于投稿者——**包括空归属的存量条目**——
// 一律 ErrItemTaken，不写入。content_hash 走容器口径（SegmentsContentHash，本册 §2.3）。
func (s *Store) UpsertSegmentSubmission(sub SegmentSubmission) (created bool, err error) {
	if sub.Type != "course" && sub.Type != "lesson" {
		return false, fmt.Errorf("store: 不支持的容器类型 %q", sub.Type)
	}
	ordered := append([]Segment{}, sub.Segments...)
	sort.Slice(ordered, func(i, j int) bool { return ordered[i].Seq < ordered[j].Seq })
	hash := SegmentsContentHash(ordered)
	updated := sub.UpdatedAt
	if updated == "" {
		updated = nowUTC()
	}
	tx, err := s.db.Begin()
	if err != nil {
		return false, err
	}
	defer func() { _ = tx.Rollback() }()

	var cur string
	switch err := tx.QueryRow(`SELECT author_id FROM items WHERE item_id=?`, sub.ItemID).Scan(&cur); {
	case errors.Is(err, sql.ErrNoRows):
		created = true
	case err != nil:
		return false, err
	case cur != sub.AuthorID:
		return false, ErrItemTaken
	}

	// ON CONFLICT 刻意不写 state / dist_class：墓碑条目保持其 state，不允许靠重新投稿复活（与 #25 同口径）。
	if _, err := tx.Exec(`INSERT INTO items(item_id,source,type,title,source_rev,content_hash,sqlite_table,dist_class,state,updated_at,author_id,author_sig)
		VALUES(?,?,?,?,?,?,?,'public','active',?,?,?)
		ON CONFLICT(item_id) DO UPDATE SET
			title=excluded.title, source_rev=excluded.source_rev, content_hash=excluded.content_hash,
			updated_at=excluded.updated_at, author_id=excluded.author_id, author_sig=excluded.author_sig`,
		sub.ItemID, sub.Type, sub.Type, sub.Title, hash[:16], hash, "segments",
		updated, sub.AuthorID, sub.AuthorSig); err != nil {
		return false, fmt.Errorf("store: upsert segment submission item: %w", err)
	}
	if _, err := tx.Exec(`DELETE FROM segments WHERE item_id=?`, sub.ItemID); err != nil {
		return false, fmt.Errorf("store: 清旧 segments: %w", err)
	}
	for _, seg := range ordered {
		if _, err := tx.Exec(`INSERT INTO segments(item_id,seq,kind,text,content_hash) VALUES(?,?,?,?,?)`,
			sub.ItemID, seg.Seq, seg.Kind, seg.Text, protocol.SHA256Hex([]byte(seg.Text))); err != nil {
			return false, fmt.Errorf("store: 写 segments %s seq=%d: %w", sub.ItemID, seg.Seq, err)
		}
	}
	return created, tx.Commit()
}
```

在 `internal/store/submission.go` 顶部 import 块补 `"sort"`（`protocol` 已在该包其他文件使用；本文件需补 `"github.com/johocn/base/internal/protocol"`——若 `submission.go` 现未 import，则一并加上）。

- [ ] **Step 4: 跑测试确认通过**

Run（仓库根）: `go test ./internal/store/ -run 'TestUpsertSegmentSubmission' -v`
Expected: PASS（2 个测试全绿）。

- [ ] **Step 5: 提交**

```bash
git add internal/store/submission.go internal/store/submission_test.go
git commit -m "feat(store): 新增容器投稿 UpsertSegmentSubmission（items+segments 同事务，占用口径沿用 #25）"
```

---

### Task 3: `POST /v1/submit` 扩 `course|lesson` 两个容器形态

**Files:**
- Modify: `internal/httpapi/submit.go`
- Modify: `internal/httpapi/authmw.go:40-41`（文案）
- Create: `internal/httpapi/submit_container_test.go`

- [ ] **Step 1: 写失败的测试**

创建 `internal/httpapi/submit_container_test.go`：

```go
package httpapi

import (
	"net/http"
	"testing"

	"github.com/johocn/base/internal/protocol"
	"github.com/johocn/base/internal/store"
)

// containerSubmitBody 造一份容器投稿体：content_hash 走容器口径（SegmentsContentHash），
// 签名与 article/quiz 同域（protocol.AuthorSignBytes(itemID, contentHash, id)）。
func containerSubmitBody(t *testing.T, seed, typ, itemID, title string, segs []submitSegment) string {
	t.Helper()
	id, _ := identityFromSeed(t, seed)
	rows := make([]store.Segment, 0, len(segs))
	for _, s := range segs {
		rows = append(rows, store.Segment{ItemID: itemID, Seq: s.Seq, Kind: s.Kind, Text: s.Text})
	}
	hash := store.SegmentsContentHash(rows)
	signBytes, err := protocol.AuthorSignBytes(itemID, hash, id)
	if err != nil {
		t.Fatalf("AuthorSignBytes: %v", err)
	}
	sig, err := protocol.Sign(seed, signBytes)
	if err != nil {
		t.Fatalf("Sign: %v", err)
	}
	return mustJSON(t, map[string]any{
		"type": typ, "item_id": itemID, "title": title, "segments": segs, "author_sig": sig,
	})
}

func TestContainerShapeOf(t *testing.T) {
	ok := map[string]string{
		"course/c1":                  "course",
		"course/c1/lesson/l1":        "lesson",
		"course/a-b/lesson/l-2":      "lesson",
		"course/" + repeat("c", 64):  "course",
	}
	for id, want := range ok {
		if got, good := containerShapeOf(id); !good || got != want {
			t.Fatalf("containerShapeOf(%q) = (%q,%v), want (%q,true)", id, got, good, want)
		}
	}
	bad := []string{
		"", "course", "course/", "course/C1", "course/c1/", "course/c1/lesson",
		"course/c1/lesson/", "course/c1/lesson/L1", "lesson/l1",
		"course/c1/lesson/l1/quiz/q1", "course/" + repeat("c", 65),
	}
	for _, id := range bad {
		if got, good := containerShapeOf(id); good {
			t.Fatalf("containerShapeOf(%q) 应不识别，却得到 %q", id, got)
		}
	}
}

// 课程与课时两种容器都能落库，且 content_hash 走容器口径。
func TestSubmitAcceptsCourseAndLesson(t *testing.T) {
	n := newSubmitNode(t)
	// 课程：封面属性 + 简介 + 一个课时子项
	courseBody := containerSubmitBody(t, testSeed, "course", "course/c1", "甲课", []submitSegment{
		{Seq: -1, Kind: "attr.cover", Text: "00112233445566778899aabbccddeeff"},
		{Seq: 0, Kind: "digest", Text: "简介\n"},
		{Seq: 1, Kind: "lesson", Text: "course/c1/lesson/l1"},
	})
	code, out := postSubmit(t, n, testSeed, courseBody)
	if code != http.StatusOK || out["created"] != true {
		t.Fatalf("课程投稿: code=%d out=%v", code, out)
	}
	segs, err := n.st.ListSegments("course/c1")
	if err != nil || len(segs) != 3 {
		t.Fatalf("课程 segments: n=%d err=%v", len(segs), err)
	}
	if segs[0].Seq != -1 || segs[1].Seq != 0 || segs[2].Seq != 1 {
		t.Fatalf("课程 segments 未按 seq 升序: %+v", segs)
	}
	it, ok, err := n.st.GetItem("course/c1")
	if err != nil || !ok {
		t.Fatalf("GetItem: ok=%v err=%v", ok, err)
	}
	if want := store.SegmentsContentHash(segs); it.ContentHash != want {
		t.Fatalf("content_hash=%s want=%s", it.ContentHash, want)
	}
	if it.Type != "course" || it.AuthorID == "" {
		t.Fatalf("items 行不对: %+v", it)
	}

	// 课时：正文属性 + 一个 article 子项
	lessonBody := containerSubmitBody(t, testSeed, "lesson", "course/c1/lesson/l1", "第一讲", []submitSegment{
		{Seq: -1, Kind: "attr.body_md", Text: "# 讲稿\n\n正文\n"},
		{Seq: 1, Kind: "article", Text: "course/c1/lesson/l1/article/a1"},
	})
	code, out = postSubmit(t, n, testSeed, lessonBody)
	if code != http.StatusOK || out["created"] != true {
		t.Fatalf("课时投稿: code=%d out=%v", code, out)
	}
	lsegs, err := n.st.ListSegments("course/c1/lesson/l1")
	if err != nil || len(lsegs) != 2 || lsegs[0].Kind != "attr.body_md" || lsegs[1].Kind != "article" {
		t.Fatalf("课时 segments: %+v err=%v", lsegs, err)
	}
}

// 本人重投同一容器 → created=false，行集整体替换。
func TestSubmitContainerReSubmitByOwner(t *testing.T) {
	n := newSubmitNode(t)
	first := containerSubmitBody(t, testSeed, "course", "course/c9", "甲课", []submitSegment{
		{Seq: 1, Kind: "lesson", Text: "course/c9/lesson/l1"},
	})
	if code, out := postSubmit(t, n, testSeed, first); code != http.StatusOK {
		t.Fatalf("首次: code=%d out=%v", code, out)
	}
	second := containerSubmitBody(t, testSeed, "course", "course/c9", "甲课改", []submitSegment{
		{Seq: -1, Kind: "attr.instructor", Text: "李老师"},
	})
	code, out := postSubmit(t, n, testSeed, second)
	if code != http.StatusOK || out["created"] != false {
		t.Fatalf("重投: code=%d out=%v", code, out)
	}
	segs, _ := n.st.ListSegments("course/c9")
	if len(segs) != 1 || segs[0].Seq != -1 || segs[0].Kind != "attr.instructor" {
		t.Fatalf("重投未整体替换: %+v", segs)
	}
}

func TestSubmitRejectsBadContainerSegments(t *testing.T) {
	n := newSubmitNode(t)
	cases := []struct {
		name, typ, itemID string
		segs              []submitSegment
		want              string
	}{
		{"形态不识别", "course", "course/c1/lesson/l1/quiz/q1", nil, "item_id_invalid"},
		{"形态与 type 不符", "course", "course/c1/lesson/l1", nil, "item_type_mismatch"},
		{"seq<0 非 attr.*", "course", "course/c1", []submitSegment{{Seq: -1, Kind: "cover", Text: "x"}}, "item_segments_invalid"},
		{"属性行非规范排布", "course", "course/c1", []submitSegment{
			{Seq: -1, Kind: "attr.instructor", Text: "甲"},
			{Seq: -2, Kind: "attr.cover", Text: "00112233445566778899aabbccddeeff"},
		}, "item_segments_invalid"},
		{"seq=0 非 digest", "course", "course/c1", []submitSegment{{Seq: 0, Kind: "intro", Text: "x"}}, "item_segments_invalid"},
		{"seq 重复", "course", "course/c1", []submitSegment{
			{Seq: 1, Kind: "lesson", Text: "course/c1/lesson/l1"},
			{Seq: 1, Kind: "lesson", Text: "course/c1/lesson/l2"},
		}, "item_segments_invalid"},
		{"课程不许挂 article 子项", "course", "course/c1", []submitSegment{
			{Seq: 1, Kind: "article", Text: "article/a1"},
		}, "item_segments_invalid"},
		{"课时不许挂 lesson 子项", "lesson", "course/c1/lesson/l1", []submitSegment{
			{Seq: 1, Kind: "lesson", Text: "course/c1/lesson/l2"},
		}, "item_segments_invalid"},
	}
	for _, c := range cases {
		body := containerSubmitBody(t, testSeed, c.typ, c.itemID, "标题", c.segs)
		code, out := postSubmit(t, n, testSeed, body)
		if code != http.StatusBadRequest || out["code"] != c.want {
			t.Fatalf("%s: want %s, got code=%d out=%v", c.name, c.want, code, out)
		}
		if _, ok, _ := n.st.GetItem(c.itemID); ok {
			t.Fatalf("%s: 拒绝时不得写入", c.name)
		}
	}
}

// 他人（含空归属的存量容器）已占用 → 403 item_id_taken，且不得写入。
func TestSubmitContainerTaken(t *testing.T) {
	n := newSubmitNode(t)
	legacy := []store.Segment{{ItemID: "course/c2", Seq: 1, Kind: "lesson", Text: "course/c2/lesson/l1"}}
	if err := n.st.UpsertSegmentItem(store.SegmentItem{
		ItemID: "course/c2", Source: "course", Type: "course", Title: "存量", Segments: legacy,
	}); err != nil {
		t.Fatalf("UpsertSegmentItem: %v", err)
	}
	body := containerSubmitBody(t, testSeed, "course", "course/c2", "认领", []submitSegment{
		{Seq: 1, Kind: "lesson", Text: "course/c2/lesson/l9"},
	})
	code, out := postSubmit(t, n, testSeed, body)
	if code != http.StatusForbidden || out["code"] != "item_id_taken" {
		t.Fatalf("code=%d out=%v", code, out)
	}
	segs, _ := n.st.ListSegments("course/c2")
	if len(segs) != 1 || segs[0].Text != "course/c2/lesson/l1" {
		t.Fatalf("拒绝时不得写入: %+v", segs)
	}
}
```

- [ ] **Step 2: 跑测试确认失败**

Run（仓库根）: `go test ./internal/httpapi/ -run 'TestContainerShapeOf|TestSubmitAcceptsCourseAndLesson|TestSubmitContainer|TestSubmitRejectsBadContainerSegments' -v`
Expected: FAIL —— `undefined: containerShapeOf` / `undefined: submitSegment`（编译失败）。

- [ ] **Step 3: 写实现**

在 `internal/httpapi/submit.go` 常量块（`itemTypeTag` 之后）追加：

```go
	// 容器形态（本册 §4.1）：course/<cid> 与 course/<cid>/lesson/<lid>。
	itemTypeCourse = "course"
	itemTypeLesson = "lesson"
```

在 `splitSubmitItemID` 之后追加：

```go
// containerShapeOf 解析容器 item_id 形态：course/<cid> → course；course/<cid>/lesson/<lid> → lesson。
// 各段都须是合法 slug；其余一律不识别（本册 §4.1，无顶层 lesson 命名空间）。
func containerShapeOf(itemID string) (shape string, ok bool) {
	parts := strings.Split(itemID, "/")
	switch len(parts) {
	case 2:
		if parts[0] == itemTypeCourse && protocol.ValidSlug(parts[1]) {
			return itemTypeCourse, true
		}
	case 4:
		if parts[0] == itemTypeCourse && protocol.ValidSlug(parts[1]) &&
			parts[2] == itemTypeLesson && protocol.ValidSlug(parts[3]) {
			return itemTypeLesson, true
		}
	}
	return "", false
}

// childKindsByContainer 是容器清单行（seq>=1）的合法 kind 取值域（本册 §2.1 铁律 3）。
var childKindsByContainer = map[string]map[string]bool{
	itemTypeCourse: {itemTypeLesson: true},
	itemTypeLesson: {
		itemTypeArticle: true, "video": true, "audio": true, itemTypeQuiz: true,
	},
}

// submitSegment 是一条待落库的容器行（本册 §4.1）：seq<0 属性行、seq=0 简介、seq>=1 子项。
type submitSegment struct {
	Seq  int    `json:"seq"`
	Kind string `json:"kind"`
	Text string `json:"text"`
}

// validateSubmitSegments 按册子 §2.1 的三区间铁律校验容器行集，返回可落库的行。
// 归一化失败一律假（调用方回 item_segments_invalid）：
//  1. seq<0 只放属性行（kind 须是 protocol.IsAttrKind），且**必须**是 AssignAttrSeqs 的规范排布；
//  2. seq=0 只放一行 digest；
//  3. seq>=1 只放本容器允许的子项 kind（课程只收 lesson，课时只收 article/video/audio/quiz）；
//  4. seq 不得重复。
func validateSubmitSegments(itemID, typ string, in []submitSegment) ([]store.Segment, bool) {
	ordered := append([]submitSegment{}, in...)
	sort.Slice(ordered, func(i, j int) bool { return ordered[i].Seq < ordered[j].Seq })
	childKinds := childKindsByContainer[typ]
	attrs := []protocol.AttrSlot{}
	out := make([]store.Segment, 0, len(ordered))
	for i, s := range ordered {
		if i > 0 && s.Seq == ordered[i-1].Seq {
			return nil, false
		}
		switch {
		case s.Seq < 0:
			if !protocol.IsAttrKind(s.Kind) {
				return nil, false
			}
			attrs = append(attrs, protocol.AttrSlot{Seq: s.Seq, Kind: s.Kind, Text: s.Text})
		case s.Seq == 0:
			if s.Kind != protocol.DigestKind {
				return nil, false
			}
		default:
			if !childKinds[s.Kind] {
				return nil, false
			}
		}
		out = append(out, store.Segment{ItemID: itemID, Seq: s.Seq, Kind: s.Kind, Text: s.Text})
	}
	// 属性行必须与导出端逐字节同构，否则双端 content_hash 会静默漂移（本册 §8 风险 2）。
	if !protocol.AttrSeqsCanonical(attrs) {
		return nil, false
	}
	return out, true
}
```

在 `submitReq` 结构体里追加字段：

```go
	Segments     []submitSegment `json:"segments"`
```

在 `handleSubmitPost` 里，把 type 白名单与 item_id 校验两段改为：

```go
	if req.Type != itemTypeArticle && req.Type != itemTypeQuiz && req.Type != itemTypeTag &&
		req.Type != itemTypeCourse && req.Type != itemTypeLesson {
		s.writeAuthErr(w, http.StatusBadRequest, "item_type_unsupported")
		return
	}
	var containerSegs []store.Segment
	switch req.Type {
	case itemTypeTag:
		if _, _, _, ok := protocol.ParseTagItemID(req.ItemID); !ok {
			s.writeAuthErr(w, http.StatusBadRequest, "item_id_invalid")
			return
		}
	case itemTypeCourse, itemTypeLesson:
		shape, ok := containerShapeOf(req.ItemID)
		if !ok {
			s.writeAuthErr(w, http.StatusBadRequest, "item_id_invalid")
			return
		}
		if shape != req.Type {
			s.writeAuthErr(w, http.StatusBadRequest, "item_type_mismatch")
			return
		}
		segs, ok := validateSubmitSegments(req.ItemID, req.Type, req.Segments)
		if !ok {
			s.writeAuthErr(w, http.StatusBadRequest, "item_segments_invalid")
			return
		}
		containerSegs = segs
	default:
		if _, code := splitSubmitItemID(req.ItemID, req.Type); code != "" {
			s.writeAuthErr(w, http.StatusBadRequest, code)
			return
		}
	}
```

content_hash 计算改为：

```go
	var contentHash string
	switch req.Type {
	case itemTypeTag:
		// 容器口径（#14 §3.3）：哈希只看物化的 segments 行——与 #25 的 article/quiz 口径不同。
		contentHash = store.SegmentsContentHash(store.MaterializeTagSegments(req.ItemID, tagLinks))
	case itemTypeCourse, itemTypeLesson:
		// 容器口径（本册 §2.3）：按 seq 升序拼 "<kind>\t<text>\n"。
		contentHash = store.SegmentsContentHash(containerSegs)
	default:
		contentHash = submissionContentHash(req.Type, req.BodyMD, req.QuestionJSON)
	}
```

落库改为：

```go
	var created bool
	switch req.Type {
	case itemTypeTag:
		_, err = s.st.UpsertTagSubmission(store.TagSubmission{
			TagID: req.ItemID, Title: title, Links: tagLinks,
			AuthorID: actor, AuthorSig: req.AuthorSig,
		})
	case itemTypeCourse, itemTypeLesson:
		created, err = s.st.UpsertSegmentSubmission(store.SegmentSubmission{
			ItemID: req.ItemID, Type: req.Type, Title: title, Segments: containerSegs,
			AuthorID: actor, AuthorSig: req.AuthorSig,
		})
	default:
		created, err = s.st.UpsertSubmission(store.Submission{
			ItemID: req.ItemID, Type: req.Type, Title: title,
			BodyMD: req.BodyMD, QuestionJSON: req.QuestionJSON,
			ContentHash: contentHash, AuthorID: actor, AuthorSig: req.AuthorSig,
		})
	}
```

在 `internal/httpapi/submit.go` 顶部 import 块补 `"sort"`（`protocol` / `store` 已在）。

在 `internal/httpapi/authmw.go` 的 `authErrText` 表里把这两条替换、并新增一条：

```go
	"item_id_invalid":          "item_id 必须形如 article/<slug>、quiz/<slug>、course/<cid> 或 course/<cid>/lesson/<lid>",
	"item_type_unsupported":    "type 只能是 article、quiz、tag、course 或 lesson",
	"item_segments_invalid":    "segments 不合法：seq<0 只放 attr.* 属性行且须按确定性规则排布，seq=0 只放 digest，seq>=1 只放本容器允许的子项 kind",
```

- [ ] **Step 4: 跑测试确认通过**

Run（仓库根）: `go test ./internal/httpapi/ -run 'TestContainerShapeOf|TestSubmit' -v`
Expected: PASS（既有 `TestSubmitRejectsTypeAndItemID` 等与新增 5 个测试全绿）。

> 既有 `TestSubmitRejectsTypeAndItemID` 里 `{"article", "course/c1", "body_md", ...} → item_id_invalid` 仍然成立：article 分支走 `splitSubmitItemID`，`course/c1` 前缀不是 article/quiz → `item_id_invalid`。

- [ ] **Step 5: 提交**

```bash
git add internal/httpapi/submit.go internal/httpapi/authmw.go internal/httpapi/submit_container_test.go
git commit -m "feat(httpapi): POST /v1/submit 支持 course/lesson 容器投稿（三区间铁律校验）"
```

---

### Task 4: `POST /v1/blob`（multipart 单块内容寻址）

**Files:**
- Create: `internal/httpapi/blob.go`
- Modify: `internal/httpapi/authmw.go:29,93-117,132,193,199`
- Modify: `internal/httpapi/server.go:119`
- Create: `internal/httpapi/blob_test.go`

- [ ] **Step 1: 写失败的测试**

创建 `internal/httpapi/blob_test.go`：

```go
package httpapi

import (
	"bytes"
	"mime/multipart"
	"net/http"
	"strings"
	"testing"

	"github.com/johocn/base/internal/protocol"
)

// multipartBody 造一个单块 multipart 体（字段名 field），返回体与 Content-Type。
func multipartBody(t *testing.T, field, filename string, data []byte) (string, string) {
	t.Helper()
	var b bytes.Buffer
	mw := multipart.NewWriter(&b)
	fw, err := mw.CreateFormFile(field, filename)
	if err != nil {
		t.Fatalf("CreateFormFile: %v", err)
	}
	if _, err := fw.Write(data); err != nil {
		t.Fatalf("write part: %v", err)
	}
	if err := mw.Close(); err != nil {
		t.Fatalf("close writer: %v", err)
	}
	return b.String(), mw.FormDataContentType()
}

// postBlob 发一条签名 blob 上传，返回 (HTTP 状态, 响应体)。
func postBlob(t *testing.T, n *submitNode, seed, body, contentType string) (int, map[string]any) {
	t.Helper()
	req := signedRequest(t, seed, http.MethodPost, n.public+"/v1/blob", body)
	req.Header.Set("Content-Type", contentType)
	return sendAuth(t, req)
}

// 往返 + 内容寻址幂等：同内容重复上传返回同一 blob_id，块只落一份。
func TestBlobPostRoundTripAndIdempotent(t *testing.T) {
	n := newSubmitNode(t)
	data := []byte("hello blob\n")
	body, ct := multipartBody(t, "file", "a.txt", data)
	want := protocol.BlobID(data)
	for i := 1; i <= 2; i++ {
		code, out := postBlob(t, n, testSeed, body, ct)
		if code != http.StatusOK || out["blob_id"] != want {
			t.Fatalf("第 %d 次: code=%d out=%v want=%s", i, code, out, want)
		}
	}
	ok, size, err := n.st.HasBlob(want)
	if err != nil || !ok || size != int64(len(data)) {
		t.Fatalf("HasBlob: ok=%v size=%d err=%v", ok, size, err)
	}
}

// 超限（> 8 MiB）→ 413 blob_too_large。
func TestBlobPostTooLarge(t *testing.T) {
	n := newSubmitNode(t)
	data := bytes.Repeat([]byte("x"), maxBlobBytes+1)
	body, ct := multipartBody(t, "file", "big.bin", data)
	code, out := postBlob(t, n, testSeed, body, ct)
	if code != http.StatusRequestEntityTooLarge || out["code"] != "blob_too_large" {
		t.Fatalf("code=%d out=%v", code, out)
	}
}

// 无签名头 → 400 auth_missing_header（blob 与其它写路径同auth 口径）。
func TestBlobPostRequiresAuth(t *testing.T) {
	n := newSubmitNode(t)
	body, ct := multipartBody(t, "file", "a.txt", []byte("x"))
	req, err := http.NewRequest(http.MethodPost, n.public+"/v1/blob", strings.NewReader(body))
	if err != nil {
		t.Fatalf("NewRequest: %v", err)
	}
	req.Header.Set("Content-Type", ct)
	code, out := sendAuth(t, req)
	if code != http.StatusBadRequest || out["code"] != "auth_missing_header" {
		t.Fatalf("code=%d out=%v", code, out)
	}
}

// 缺 file 字段 → 400 bad_multipart。
func TestBlobPostRejectsMissingFileField(t *testing.T) {
	n := newSubmitNode(t)
	body, ct := multipartBody(t, "other", "a.txt", []byte("x"))
	code, out := postBlob(t, n, testSeed, body, ct)
	if code != http.StatusBadRequest || out["code"] != "bad_multipart" {
		t.Fatalf("code=%d out=%v", code, out)
	}
}
```

- [ ] **Step 2: 跑测试确认失败**

Run（仓库根）: `go test ./internal/httpapi/ -run 'TestBlobPost' -v`
Expected: FAIL —— 404（`POST /v1/blob` 未挂）或 `undefined: maxBlobBytes`。

- [ ] **Step 3: 写实现**

创建 `internal/httpapi/blob.go`：

```go
package httpapi

import (
	"errors"
	"io"
	"net/http"

	"github.com/johocn/base/internal/protocol"
)

// maxBlobBytes 是单块上传的明文上限（本册 §5）：8 MiB，与正文 32 KiB 不同量级，不复用 maxSubmitBytes。
const maxBlobBytes = 8 << 20

// handleBlobPost 是签名写路径 POST /v1/blob（本册 §2.4）：multipart/form-data 单块、字段名 file、
// 上限 maxBlobBytes、内容寻址幂等——同一内容重复上传返回同一 blob_id，块只落一份。
// 块在明文上算出 blob_id 后加密落盘（store.PutBlob），故客户端可自行预知 blob_id。
func (s *Server) handleBlobPost(w http.ResponseWriter, r *http.Request) {
	mr, err := r.MultipartReader()
	if err != nil {
		s.writeAuthErr(w, http.StatusBadRequest, "bad_multipart")
		return
	}
	var data []byte
	for {
		part, err := mr.NextPart()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			s.writeAuthErr(w, http.StatusBadRequest, "bad_multipart")
			return
		}
		if part.FormName() != "file" {
			_ = part.Close()
			continue
		}
		buf, err := io.ReadAll(io.LimitReader(part, maxBlobBytes+1))
		_ = part.Close()
		if err != nil {
			s.writeAuthErr(w, http.StatusBadRequest, "bad_multipart")
			return
		}
		if len(buf) > maxBlobBytes {
			s.writeAuthErr(w, http.StatusRequestEntityTooLarge, "blob_too_large")
			return
		}
		data = buf
		break
	}
	if len(data) == 0 {
		s.writeAuthErr(w, http.StatusBadRequest, "bad_multipart")
		return
	}
	blobID := protocol.BlobID(data)
	// item_id / seq 留空：这是「先传块、后投稿」的两步上传，块与条目的关联由投稿时的 attr.attachment 行建立。
	if err := s.st.PutBlob(blobID, data, "", 0); err != nil {
		s.writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	s.writeJSON(w, http.StatusOK, map[string]any{"blob_id": blobID, "size": len(data)})
}
```

在 `internal/httpapi/authmw.go` 里改 `authenticate` 的体上限为参数：

1. 签名改 `func (s *Server) authenticate(w http.ResponseWriter, r *http.Request, maxBody int64) (actorID string, authed bool)`；
2. 第 193 行 `io.LimitReader(r.Body, maxJsonBody+1)` → `io.LimitReader(r.Body, maxBody+1)`；
3. 第 199 行 `int64(len(body)) > maxJsonBody` → `int64(len(body)) > maxBody`。

`requireAuth` 改为委托给新的 `requireAuthLimit`：

```go
// requireAuth 包装需要签名头的处理器：体上限取默认的 maxJSONBody（64 KiB）。
func (s *Server) requireAuth(next http.HandlerFunc) http.Handler {
	return s.requireAuthLimit(maxJSONBody)(next)
}

// requireAuthLimit 同 requireAuth，但显式指定体上限（POST /v1/blob 需要 8 MiB 量级的体）。
func (s *Server) requireAuthLimit(maxBody int64) func(http.HandlerFunc) http.Handler {
	return func(next http.HandlerFunc) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			id, ok := s.authenticate(w, r, maxBody)
			if !ok {
				return
			}
			next(w, withIdentity(r, id))
		})
	}
}
```

`optionalAuth` 内的 `s.authenticate(w, r)` → `s.authenticate(w, r, maxJSONBody)`。

`authErrText` 里把 `auth_body_too_large` 文案改中性、并新增两条：

```go
	"auth_body_too_large":      "请求体超过本接口上限",
	"blob_too_large":           "上传块超过 8 MiB",
	"bad_multipart":            "请求必须是 multipart/form-data，且含字段 file",
```

在 `internal/httpapi/server.go` 的 `publicMux` 里，`POST /v1/submit` 那行之后追加：

```go
	// 块上传（本册 §2.4）：multipart 单块，体上限 = 8 MiB + 4 KiB（multipart 边界开销）。
	mux.Handle("POST /v1/blob", s.requireAuthLimit(maxBlobBytes+(4<<10))(s.handleBlobPost))
```

- [ ] **Step 4: 跑测试确认通过**

Run（仓库根）: `go test ./internal/httpapi/ -run 'TestBlobPost' -v`
Expected: PASS（4 个测试全绿）。

Run（仓库根）: `go build ./... && go test ./internal/httpapi/ -count=1`
Expected: PASS（既有 auth 测试不受 `authenticate` 参数化影响）。

- [ ] **Step 5: 提交**

```bash
git add internal/httpapi/blob.go internal/httpapi/blob_test.go internal/httpapi/authmw.go internal/httpapi/server.go
git commit -m "feat(httpapi): 新增 POST /v1/blob（multipart 单块内容寻址，体上限参数化）"
```

---

### Task 5: 三处重建路径保留 `seq<0` 属性行

**Files:**
- Modify: `internal/importer/course.go:110-152,172-252`
- Modify: `internal/importer/md.go:330,347`（调用点不变，行为由 course.go 决定）
- Modify: `internal/store/tag.go:82`
- Create: `internal/importer/attrs_preserve_test.go`

- [ ] **Step 1: 写失败的测试**

创建 `internal/importer/attrs_preserve_test.go`：

```go
package importer

import (
	"strings"
	"testing"

	"github.com/johocn/base/internal/store"
)

func openImporterStore(t *testing.T) *store.Store {
	t.Helper()
	st, err := store.Open(t.TempDir(), store.WithStoreKey("9f2c1d4a7b3e5081f6a9c2d5e8b10432a7c9e6b3d0f84261c5a8e2b7d4f01963"))
	if err != nil {
		t.Fatalf("store.Open: %v", err)
	}
	t.Cleanup(func() { _ = st.Close() })
	return st
}

// 重建课程容器时必须原样保留既有的 seq<0 属性行（本册 §2.2）。
func TestRebuildContainerPreservesAttrs(t *testing.T) {
	st := openImporterStore(t)
	first := []store.Segment{
		{ItemID: "course/c1", Seq: -1, Kind: "attr.cover", Text: "00112233445566778899aabbccddeeff"},
		{ItemID: "course/c1", Seq: -2, Kind: "attr.instructor", Text: "李老师"},
		{ItemID: "course/c1", Seq: 1, Kind: "lesson", Text: "course/c1/lesson/l1"},
	}
	if err := st.UpsertSegmentItem(store.SegmentItem{
		ItemID: "course/c1", Source: "course", Type: "course", Title: "甲课", Segments: first,
	}); err != nil {
		t.Fatalf("UpsertSegmentItem: %v", err)
	}
	// 导入器再重建一次（新增一个课时）：属性行与封面必须留着。
	if err := rebuildContainer(st, "course/c1", "course", "course", "甲课", "新简介", []string{"course/c1/lesson/l2"}); err != nil {
		t.Fatalf("rebuildContainer: %v", err)
	}
	segs, err := st.ListSegments("course/c1")
	if err != nil {
		t.Fatalf("ListSegments: %v", err)
	}
	attrs := attrSegsOf(segs)
	if len(attrs) != 2 || attrs[0].Seq != -2 || attrs[1].Seq != -1 {
		t.Fatalf("属性行未保留: %+v", attrs)
	}
	if segs[0].Kind != "attr.instructor" || segs[1].Kind != "attr.cover" {
		t.Fatalf("属性行未按 seq 排在最前: %+v", segs)
	}
	if digestTextOf(segs) != "新简介" {
		t.Fatalf("简介未更新: %+v", segs)
	}
	// 合并式重建：既有的 l1 与新增的 l2 都在。
	kids := childIDsOf(segs)
	if len(kids) != 2 || !strings.Contains(strings.Join(kids, ","), "l1") || !strings.Contains(strings.Join(kids, ","), "l2") {
		t.Fatalf("子项合并不对: %+v", kids)
	}
}

// 标签关联全量替换后，seq<=0 的行必须留下（本册 §2.2 的第四处重建）。
func TestReplaceTagLinksKeepsNonChildRows(t *testing.T) {
	st := openImporterStore(t)
	if err := st.UpsertSegmentItem(store.SegmentItem{
		ItemID: "tag/t1", Source: "tag", Type: "tag", Title: "t1",
		Segments: []store.Segment{
			{ItemID: "tag/t1", Seq: 0, Kind: "digest", Text: "标签简介"},
			{ItemID: "tag/t1", Seq: 1, Kind: "article", Text: "article/a1"},
		},
	}); err != nil {
		t.Fatalf("UpsertSegmentItem: %v", err)
	}
	if _, err := st.UpsertTagSubmission(store.TagSubmission{
		TagID: "tag/t1", Title: "t1",
		Links:    []store.TagLink{{TargetID: "article/a2", Kind: "article"}},
		AuthorID: "aa", AuthorSig: "ff",
	}); err != nil {
		t.Fatalf("UpsertTagSubmission: %v", err)
	}
	segs, _ := st.ListSegments("tag/t1")
	if digestTextOf(segs) != "标签简介" {
		t.Fatalf("seq=0 行被误删: %+v", segs)
	}
	kids := childIDsOf(segs)
	if len(kids) != 1 || kids[0] != "article/a2" {
		t.Fatalf("子项未整体替换: %+v", kids)
	}
}
```

- [ ] **Step 2: 跑测试确认失败**

Run（仓库根）: `go test ./internal/importer/ ./internal/store/ -run 'TestRebuildContainerPreservesAttrs|TestReplaceTagLinksKeepsNonChildRows' -v`
Expected: FAIL —— `undefined: attrSegsOf`；或属性行被删（`len(attrs) != 2`）。

- [ ] **Step 3: 写实现**

在 `internal/importer/course.go` 的 `digestTextOf` 之后追加：

```go
// attrSegsOf 取既有 segments 里的属性行（seq<0），按 seq 升序原样返回（本册 §2.1 铁律 1）。
// 重建容器时这些行必须原样保留：它们是课程 / 课时的封面、讲师、难度等字段的唯一载体。
func attrSegsOf(segs []store.Segment) []store.Segment {
	out := []store.Segment{}
	for _, s := range segs {
		if s.Seq < 0 {
			out = append(out, s)
		}
	}
	return out
}
```

`rebuildContainer` 改为（只改 `segs` 的初值与首行拼接）：

```go
func rebuildContainer(st *store.Store, itemID, source, typ, title, digest string, children []string) error {
	existing, err := st.ListSegments(itemID)
	if err != nil {
		return err
	}
	merged := mergeChildren(childIDsOf(existing), children)
	segs := attrSegsOf(existing) // 先搬既有属性行，再拼 seq=0 与 seq>=1
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
```

`rebuildCategories` 里 `for _, slug := range ordered {` 循环内，把「按需 ListSegments」改成「总是读一次并保留属性行」：

```go
	for _, slug := range ordered {
		itemID := "category/" + slug
		existingSegs, err := st.ListSegments(itemID)
		if err != nil {
			errs = append(errs, itemID+": "+err.Error())
			continue
		}
		if digest[slug] == "" {
			digest[slug] = digestTextOf(existingSegs)
		}
		courses := append([]string{}, bySlug[slug]...)
		sort.Strings(courses)

		segs := attrSegsOf(existingSegs)
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
```

`internal/store/tag.go:82` 改为：

```go
	if _, err := tx.Exec(`DELETE FROM segments WHERE item_id=? AND seq>=1`, tagID); err != nil {
```

- [ ] **Step 4: 跑测试确认通过**

Run（仓库根）: `go test ./internal/importer/ ./internal/store/ -count=1`
Expected: PASS（新增 2 个测试 + 既有全绿）。

- [ ] **Step 5: 提交**

```bash
git add internal/importer/course.go internal/importer/attrs_preserve_test.go internal/store/tag.go
git commit -m "fix(importer,tag): 三处重建路径保留 seq<0 属性行，不再整段抹掉课程/课时字段"
```

---

### Task 6: 导入器跳过投稿域容器（转 warning）

**Files:**
- Modify: `internal/importer/course.go:131-152`
- Modify: `internal/importer/md.go:34-39,240-243,317-352`
- Modify: `internal/importer/video.go:31-37,116-118`
- Create: `internal/importer/submitted_skip_test.go`

- [ ] **Step 1: 写失败的测试**

创建 `internal/importer/submitted_skip_test.go`：

```go
package importer

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/johocn/base/internal/store"
)

// 投稿域容器（items.author_id 非空）不得被导入器覆盖：跳过并产 warning，不产 error。
func TestRunSkipsSubmittedContainer(t *testing.T) {
	st := openImporterStore(t)
	// 造一个「投稿域」课程容器：author_id 非空 → 导入器必须绕开。
	if _, err := st.UpsertSegmentSubmission(store.SegmentSubmission{
		ItemID: "course/c1", Type: "course", Title: "投稿的课", AuthorID: "aa", AuthorSig: "ff",
		Segments: []store.Segment{{ItemID: "course/c1", Seq: 1, Kind: "lesson", Text: "course/c1/lesson/l1"}},
	}); err != nil {
		t.Fatalf("UpsertSegmentSubmission: %v", err)
	}
	dir := t.TempDir()
	md := "---\nslug: a1\ntitle: 甲文\ncourse: c1\nlesson: l1\nlesson_title: 第一讲\n---\n\n正文\n"
	if err := os.WriteFile(filepath.Join(dir, "a1.md"), []byte(md), 0o644); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}
	res, err := Run(st, dir, Options{})
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if res.Failed != 0 {
		t.Fatalf("投稿域跳过不应计 Failed: %+v", res)
	}
	if len(res.Warnings) == 0 || !strings.Contains(strings.Join(res.Warnings, "\n"), "course/c1") {
		t.Fatalf("应产出 course/c1 的 warning: %+v", res.Warnings)
	}
	// 容器原样保留（title 与行集都没被导入器改写）。
	it, ok, _ := st.GetItem("course/c1")
	if !ok || it.Title != "投稿的课" {
		t.Fatalf("投稿域容器被改写: %+v", it)
	}
}

// 空归属的存量容器（导入器自建）仍可被导入器重建。
func TestRunRebuildsUnattributedContainer(t *testing.T) {
	st := openImporterStore(t)
	if err := st.UpsertSegmentItem(store.SegmentItem{
		ItemID: "course/c2", Source: "course", Type: "course", Title: "旧课",
		Segments: []store.Segment{{ItemID: "course/c2", Seq: 1, Kind: "lesson", Text: "course/c2/lesson/l1"}},
	}); err != nil {
		t.Fatalf("UpsertSegmentItem: %v", err)
	}
	dir := t.TempDir()
	md := "---\nslug: a2\ntitle: 乙文\ncourse: c2\nlesson: l1\ncourse_title: 新课\n---\n\n正文\n"
	if err := os.WriteFile(filepath.Join(dir, "a2.md"), []byte(md), 0o644); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}
	res, err := Run(st, dir, Options{})
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if len(res.Warnings) != 0 {
		t.Fatalf("空归属容器不应跳过: %+v", res.Warnings)
	}
	it, _, _ := st.GetItem("course/c2")
	if it.Title != "新课" {
		t.Fatalf("空归属容器应被重建: %+v", it)
	}
}
```

- [ ] **Step 2: 跑测试确认失败**

Run（仓库根）: `go test ./internal/importer/ -run 'TestRunSkipsSubmittedContainer|TestRunRebuildsUnattributedContainer' -v`
Expected: FAIL —— `res.Warnings undefined`（编译失败）。

- [ ] **Step 3: 写实现**

在 `internal/importer/course.go` 顶部（`import` 之后）追加 sentinel 与判定：

```go
// errSubmittedContainer 表示目标容器属于投稿域（items.author_id 非空），导入器一律不覆盖。
// 它不是失败：调用方把它转成 Result.Warnings（本册 §6.3）。
var errSubmittedContainer = errors.New("importer: 投稿域容器，导入器不覆盖")

// isSubmittedContainer 判定一个容器是否已由投稿登记（author_id 非空）。
// 空归属的存量容器（导入器自建）返回 false，故导入器仍可重建它们（本册 §2.1 占用口径）。
func isSubmittedContainer(st *store.Store, itemID string) (bool, error) {
	it, ok, err := st.GetItem(itemID)
	if err != nil {
		return false, err
	}
	return ok && it.AuthorID != "", nil
}
```

在 `internal/importer/course.go` import 块补 `"errors"`。

`rebuildContainer` 开头加守卫：

```go
func rebuildContainer(st *store.Store, itemID, source, typ, title, digest string, children []string) error {
	submitted, err := isSubmittedContainer(st, itemID)
	if err != nil {
		return err
	}
	if submitted {
		return errSubmittedContainer
	}
	existing, err := st.ListSegments(itemID)
	if err != nil {
		return err
	}
	// …（后续不变）
```

在 `internal/importer/md.go` 的 `Result` 结构体加一行：

```go
// Result 是导入统计。
type Result struct {
	Imported int
	Failed   int
	Errors   []string
	Warnings []string
}
```

`Run` 阶段 3 改为：

```go
	// 阶段 3：合并式重建受影响容器。投稿域容器不覆盖，转 warning 不转 error。
	{
		errs, warns := rebuildContainers(st, items)
		res.Warnings = append(res.Warnings, warns...)
		for _, e := range errs {
			res.Failed++
			res.Errors = append(res.Errors, e)
		}
	}
```

`rebuildContainers` 签名改为 `func rebuildContainers(st *store.Store, items []parsedMD) (errs, warns []string)`，并在文件末尾把 `errs := []string{}` 改为 `errs, warns = []string{}, []string{}`（函数体开头），两处 `rebuildContainer` 调用点改为：

```go
		if err := rebuildContainer(st, lessonID, "lesson", "lesson", title, lessonDigest[k], children); err != nil {
			if errors.Is(err, errSubmittedContainer) {
				warns = append(warns, "skipped: "+lessonID+" 投稿域，导入器不覆盖")
			} else {
				errs = append(errs, lessonID+": "+err.Error())
			}
		}
```

```go
		if err := rebuildContainer(st, courseID, "course", "course", title, courseDigest[cid], courseLessons[cid]); err != nil {
			if errors.Is(err, errSubmittedContainer) {
				warns = append(warns, "skipped: "+courseID+" 投稿域，导入器不覆盖")
			} else {
				errs = append(errs, courseID+": "+err.Error())
			}
		}
```

函数末尾 `return errs` → `return errs, warns`。在 `internal/importer/md.go` import 块补 `"errors"`。

在 `internal/importer/video.go` 的 `VideoResult` 加字段：

```go
// VideoResult 是导入结果。
type VideoResult struct {
	ItemID      string
	Chunks      int
	TotalSize   int64
	Written     int // 本次真正写盘的块数（已存在的同字节块跳过写盘）
	ContentHash string
	Warnings    []string // 投稿域课时容器被跳过等非致命提示
}
```

`ImportVideo` 第 116 行调用点改为：

```go
	if err := ensureLessonChild(st, opt.Course, opt.Lesson, itemID); err != nil {
		if errors.Is(err, errSubmittedContainer) {
			res.Warnings = append(res.Warnings, "skipped: "+
				fmt.Sprintf("course/%s/lesson/%s", opt.Course, opt.Lesson)+" 投稿域，导入器不覆盖")
		} else {
			return res, fmt.Errorf("importer: 并入课时清单: %w", err)
		}
	}
```

在 `internal/importer/video.go` import 块补 `"errors"`。

- [ ] **Step 4: 跑测试确认通过**

Run（仓库根）: `go test ./internal/importer/ -count=1`
Expected: PASS（新增 2 个 + 既有全绿）。

Run（仓库根）: `go build ./... && go test ./... -count=1`
Expected: PASS（全仓库绿；`cmd/` 若有引用 `importer.Result` 的打印逻辑需一并带上 Warnings，见下）。

> 若 `cmd/` 里打印 `Result` 的代码存在，追加一行 `for _, w := range res.Warnings { fmt.Fprintln(os.Stderr, "warning:", w) }`；不确定就先 `go build ./...`，编译通过即说明无需改。

- [ ] **Step 5: 提交**

```bash
git add internal/importer/course.go internal/importer/md.go internal/importer/video.go internal/importer/submitted_skip_test.go
git commit -m "feat(importer): 导入器跳过投稿域容器并产 warning，不再覆盖作者自建课程/课时"
```

---

### Task 7: 手机端属性规则镜像 `core/attrs.ts`（读同一份契约向量）

**Files:**
- Create: `apps/mobile/src/core/attrs.ts`
- Create: `apps/mobile/src/core/attrs.test.ts`
- Modify: `apps/mobile/tsconfig.json:10`（`types` 加 `"node"`，测试要 `readFileSync` 读向量）

- [ ] **Step 1: 写失败的测试**

创建 `apps/mobile/src/core/attrs.test.ts`：

```ts
import { readFileSync } from 'node:fs';

import { sha256Hex, utf8 } from '@base/protocol-ts';
import { describe, expect, it } from 'vitest';

import {
  ATTR_BODY_MD,
  ATTR_COVER,
  ATTR_INSTRUCTOR,
  assignAttrSeqs,
  attrSeqsCanonical,
  isAttrKind,
  segmentsContentHash,
  type AttrSlot,
} from './attrs';

interface VectorCase {
  name: string;
  lines: Array<{ kind: string; text: string }>;
  slots: AttrSlot[];
}

const vectors = JSON.parse(
  readFileSync(new URL('../../../../vectors/v1/attrs.json', import.meta.url), 'utf8'),
) as { version: number; cases: VectorCase[] };

describe('attrs：与 Go 共读同一份契约向量', () => {
  it('向量文件结构', () => {
    expect(vectors.version).toBe(1);
    expect(vectors.cases.length).toBeGreaterThan(0);
  });

  for (const c of vectors.cases) {
    it(c.name, () => {
      expect(assignAttrSeqs(c.lines)).toEqual(c.slots);
      // 向量自身必须是规范排布，否则 canonical 这道门形同虚设
      expect(attrSeqsCanonical(c.slots)).toBe(true);
    });
  }
});

describe('attrs：分配规则边界', () => {
  it('同 kind 至多一行（唯 attachment 可多行），超出取首行', () => {
    expect(
      assignAttrSeqs([
        { kind: ATTR_INSTRUCTOR, text: '甲' },
        { kind: ATTR_INSTRUCTOR, text: '乙' },
      ]),
    ).toEqual([{ seq: -1, kind: ATTR_INSTRUCTOR, text: '甲' }]);
  });

  it('isAttrKind 只认六种属性 kind', () => {
    expect(isAttrKind(ATTR_COVER)).toBe(true);
    expect(isAttrKind(ATTR_BODY_MD)).toBe(true);
    for (const k of ['', 'attr.', 'attr.unknown', 'digest', 'lesson', 'article']) {
      expect(isAttrKind(k)).toBe(false);
    }
  });

  it('非规范排布（顺序颠倒）不得通过 canonical', () => {
    expect(
      attrSeqsCanonical([
        { seq: -1, kind: ATTR_INSTRUCTOR, text: '甲' },
        { seq: -2, kind: ATTR_COVER, text: '00112233445566778899aabbccddeeff' },
      ]),
    ).toBe(false);
  });
});

describe('attrs：容器 content_hash 口径', () => {
  it('按 seq 升序拼 "<kind>\\t<text>\\n"', () => {
    const rows = [
      { seq: 1, kind: 'lesson', text: 'course/c1/lesson/l1' },
      { seq: -1, kind: ATTR_COVER, text: '00112233445566778899aabbccddeeff' },
      { seq: 0, kind: 'digest', text: '简介' },
    ];
    expect(segmentsContentHash(rows)).toBe(
      sha256Hex(utf8('attr.cover\t00112233445566778899aabbccddeeff\ndigest\t简介\nlesson\tcourse/c1/lesson/l1\n')),
    );
    // 输入顺序不影响：内部按 seq 升序归一
    expect(segmentsContentHash([...rows].reverse())).toBe(segmentsContentHash(rows));
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run（cwd `apps/mobile`）: `npx vitest run src/core/attrs.test.ts`
Expected: FAIL —— `Failed to resolve import "./attrs"`。

- [ ] **Step 3: 写实现**

创建 `apps/mobile/src/core/attrs.ts`：

```ts
/**
 * 属性槽位镜像（本册 §2.1）：与 Go 侧 `internal/protocol/attrs.go` **逐字节同构**。
 *
 * 两端都要自己算 `content_hash`（作者签名覆盖它），任一端改了 `seq<0` 的分配顺序都会让
 * 同一字段集在两端算出不同哈希——且**不会报错**，只会被当成新版本静默入库（§8 风险 2）。
 * 故 `vectors/v1/attrs.json` 由两端共读，是这条规则唯一的守门（AC 1）。
 */
import { sha256Hex, utf8 } from '@base/protocol-ts';

import type { SegmentRow } from './types';

export const ATTR_KIND_PREFIX = 'attr.';

export const ATTR_ATTACHMENT = 'attr.attachment';
export const ATTR_BODY_MD = 'attr.body_md';
export const ATTR_COVER = 'attr.cover';
export const ATTR_DIFFICULTY = 'attr.difficulty';
export const ATTR_DURATION = 'attr.duration';
export const ATTR_INSTRUCTOR = 'attr.instructor';

export const DIFFICULTY_INTRO = 'intro';
export const DIFFICULTY_BASIC = 'basic';
export const DIFFICULTY_ADVANCED = 'advanced';

/** `seq=0` 的简介行 kind（既有约定，一字不改）。 */
export const DIGEST_KIND = 'digest';

/** 编辑页难度下拉的取值域（与上面三个常量同源）。 */
export const DIFFICULTY_CHOICES = [DIFFICULTY_INTRO, DIFFICULTY_BASIC, DIFFICULTY_ADVANCED];

const ATTR_KIND_SET: Record<string, true> = {
  [ATTR_ATTACHMENT]: true,
  [ATTR_BODY_MD]: true,
  [ATTR_COVER]: true,
  [ATTR_DIFFICULTY]: true,
  [ATTR_DURATION]: true,
  [ATTR_INSTRUCTOR]: true,
};

/** 判定 kind 是否为合法属性行（本册 §2.1 铁律 1）。 */
export function isAttrKind(kind: string): boolean {
  return ATTR_KIND_SET[kind] === true;
}

export interface AttrLine {
  kind: string;
  text: string;
}

export interface AttrSlot {
  seq: number;
  kind: string;
  text: string;
}

/**
 * 按本册 §2.1 铁律 2 为属性行分配 `seq<0`（与 `protocol.AssignAttrSeqs` 同一规则）：
 *  1. 按 kind **字典序**从 -1 起递减；
 *  2. 同一 kind 至多一行，唯 `attr.attachment` 可多行——多行占**连续递减区间**，
 *     同一 kind 内按 text（含 `<blob_id>\t<文件名>` 的整串）升序映射到递减 seq。
 *
 * 返回值天然按 seq 升序（首元素 seq 最小 = -1）。
 */
export function assignAttrSeqs(lines: AttrLine[]): AttrSlot[] {
  const byKind = new Map<string, string[]>();
  for (const l of lines) {
    const cur = byKind.get(l.kind);
    if (cur) cur.push(l.text);
    else byKind.set(l.kind, [l.text]);
  }
  const kinds = [...byKind.keys()].sort();
  const out: AttrSlot[] = [];
  let next = -1;
  for (const k of kinds) {
    const texts = byKind.get(k) ?? [];
    if (k === ATTR_ATTACHMENT) {
      for (const t of [...texts].sort()) {
        out.push({ seq: next, kind: k, text: t });
        next -= 1;
      }
      continue;
    }
    if (texts.length === 0) continue;
    out.push({ seq: next, kind: k, text: texts[0]! });
    next -= 1;
  }
  return out;
}

/** 报告一组属性行是否已按 `assignAttrSeqs` 的规则排布（调用方按 seq 升序传入）。 */
export function attrSeqsCanonical(slots: AttrSlot[]): boolean {
  const want = assignAttrSeqs(slots.map((s) => ({ kind: s.kind, text: s.text })));
  if (want.length !== slots.length) return false;
  return want.every((w, i) => w.seq === slots[i]!.seq && w.kind === slots[i]!.kind && w.text === slots[i]!.text);
}

/** 一条待提交的 `segments` 行（`POST /v1/submit` 的 `segments` 元素，本册 §2.3）。 */
export interface SubmitSegmentRow {
  seq: number;
  kind: string;
  text: string;
}

/**
 * 容器口径 `content_hash`（#14 §3.3 / 本册 §2.3）：按 seq 升序拼 `"<kind>\t<text>\n"` 的 sha256。
 * 与节点 `store.SegmentsContentHash` 逐字节同构——作者签名覆盖它，故客户端必须自己算出来。
 */
export function segmentsContentHash(rows: Array<Pick<SegmentRow, 'seq' | 'kind' | 'text'>>): string {
  const ordered = [...rows].sort((a, b) => a.seq - b.seq);
  return sha256Hex(utf8(ordered.map((r) => `${r.kind}\t${r.text}\n`).join('')));
}
```

改 `apps/mobile/tsconfig.json` 的 `types`（测试用 `node:fs` 读向量，`@types/node` 由仓库根 workspace 提供）：

```json
    "types": ["@dcloudio/types", "node"]
```

- [ ] **Step 4: 跑测试确认通过**

Run（cwd `apps/mobile`）: `npx vitest run src/core/attrs.test.ts`
Expected: PASS（3 个向量 case + 4 个边界/哈希用例全绿）。

- [ ] **Step 5: 类型门禁**

Run（cwd `apps/mobile`）: `npx tsc --noEmit`
Expected: 无输出（通过）。

- [ ] **Step 6: 提交**

```bash
git add apps/mobile/src/core/attrs.ts apps/mobile/src/core/attrs.test.ts apps/mobile/tsconfig.json
git commit -m "feat(mobile): 镜像 attr.* 属性槽位规则并共读契约向量"
```

---

### Task 8: `core/container-view.ts`（容器读取视图）

**Files:**
- Create: `apps/mobile/src/core/container-view.ts`
- Create: `apps/mobile/src/core/container-view.test.ts`

- [ ] **Step 1: 写失败的测试**

创建 `apps/mobile/src/core/container-view.test.ts`：

```ts
import { describe, expect, it } from 'vitest';

import { ATTR_ATTACHMENT, ATTR_BODY_MD, ATTR_COVER, ATTR_DIFFICULTY, ATTR_DURATION, ATTR_INSTRUCTOR } from './attrs';
import { attrsOf, childCounts, childrenRowsOf, digestOf, firstLine, lessonDigest } from './container-view';
import type { SegmentRow } from './types';

function seg(seq: number, kind: string, text: string): SegmentRow {
  return { itemId: 'course/c1/lesson/l1', seq, kind, text, contentHash: `h${seq}` };
}

describe('attrsOf：解析 seq<0 属性行', () => {
  it('六种属性齐全', () => {
    const got = attrsOf([
      seg(-1, ATTR_ATTACHMENT, '00000000000000000000000000000000\t讲义.pdf'),
      seg(-2, ATTR_ATTACHMENT, 'ffffffffffffffffffffffffffffffff\t附录.pdf'),
      seg(-3, ATTR_BODY_MD, '# 讲稿\n\n正文\n'),
      seg(-4, ATTR_COVER, '00112233445566778899aabbccddeeff'),
      seg(-5, ATTR_DIFFICULTY, 'basic'),
      seg(-6, ATTR_DURATION, '3600'),
      seg(-7, ATTR_INSTRUCTOR, '李老师'),
    ]);
    expect(got).toEqual({
      cover: '00112233445566778899aabbccddeeff',
      instructor: '李老师',
      difficulty: 'basic',
      duration: 3600,
      attachments: [
        { blobId: '00000000000000000000000000000000', name: '讲义.pdf' },
        { blobId: 'ffffffffffffffffffffffffffffffff', name: '附录.pdf' },
      ],
      bodyMd: '# 讲稿\n\n正文\n',
    });
  });

  it('无属性 → 全空；未知 kind 与坏形状静默忽略', () => {
    expect(attrsOf([])).toEqual({ cover: '', instructor: '', difficulty: '', duration: 0, attachments: [], bodyMd: '' });
    const got = attrsOf([seg(-1, 'attr.unknown', 'x'), seg(-2, ATTR_ATTACHMENT, '没有制表符'), seg(-3, ATTR_DURATION, 'soon')]);
    expect(got.attachments).toEqual([]);
    expect(got.duration).toBe(0);
  });
});

describe('digestOf / childrenRowsOf / childCounts', () => {
  it('digest 只认 seq=0 且 kind=digest', () => {
    expect(digestOf([seg(0, 'digest', '简介'), seg(1, 'lesson', 'course/c1/lesson/l1')])).toBe('简介');
    expect(digestOf([seg(0, 'intro', 'x')])).toBe('');
  });

  it('清单行按 seq 升序带 kind；seq<0 与 seq=0 不算子项', () => {
    const rows = [
      seg(2, 'quiz', 'course/c1/lesson/l1/quiz/q1'),
      seg(-1, ATTR_COVER, '00112233445566778899aabbccddeeff'),
      seg(1, 'article', 'course/c1/lesson/l1/article/a1'),
      seg(0, 'digest', '简介'),
    ];
    expect(childrenRowsOf(rows)).toEqual([
      { kind: 'article', text: 'course/c1/lesson/l1/article/a1' },
      { kind: 'quiz', text: 'course/c1/lesson/l1/quiz/q1' },
    ]);
    expect(childCounts(rows)).toEqual({ article: 1, quiz: 1 });
  });
});

describe('lessonDigest / firstLine：摘要回落口径（本册 §2.2）', () => {
  it('优先 seq=0 的 digest', () => {
    expect(lessonDigest([seg(0, 'digest', '既有简介'), seg(-1, ATTR_BODY_MD, '正文首段')])).toBe('既有简介');
  });

  it('缺 digest 才回落正文首段截断', () => {
    expect(lessonDigest([seg(-1, ATTR_BODY_MD, '# 标题\n\n后面')])).toBe('标题');
    expect(lessonDigest([seg(-1, ATTR_BODY_MD, '')])).toBe('');
  });

  it('firstLine：跳空行与标题记号，超长截断加省略号', () => {
    expect(firstLine('\n\n## 甲\n乙', 60)).toBe('甲');
    expect(firstLine('一二三四五', 3)).toBe('一二三…');
    expect(firstLine('   \n  ', 60)).toBe('');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run（cwd `apps/mobile`）: `npx vitest run src/core/container-view.test.ts`
Expected: FAIL —— `Failed to resolve import "./container-view"`。

- [ ] **Step 3: 写实现**

创建 `apps/mobile/src/core/container-view.ts`：

```ts
/**
 * 容器（课程 / 课时）的读取视图（本册 §5）：从 `segments` 行集里解析属性行、简介、子项清单与计数。
 * 纯函数、不碰 IO——页面只负责把 `repo.listSegments` 的结果喂进来。
 *
 * 三区间口径与节点一字不改：`seq<0` = 属性行、`seq=0` = 简介、`seq>=1` = 子项清单。
 */
import {
  ATTR_ATTACHMENT,
  ATTR_BODY_MD,
  ATTR_COVER,
  ATTR_DIFFICULTY,
  ATTR_DURATION,
  ATTR_INSTRUCTOR,
  DIGEST_KIND,
} from './attrs';
import type { SegmentRow } from './types';

export interface AttachmentVM {
  blobId: string;
  /** `attr.attachment` 里 `\t` 之后的名字 */
  name: string;
}

export interface ContainerAttrs {
  /** blob_id；空串 = 未设置 */
  cover: string;
  instructor: string;
  /** intro | basic | advanced；空串 = 未设置 */
  difficulty: string;
  /** 秒；0 = 未设置 */
  duration: number;
  attachments: AttachmentVM[];
  /** 仅课时有：`attr.body_md` 的 Markdown 源；空串 = 未设置 */
  bodyMd: string;
}

/** 空属性集（新建表单的初值，也是 `attrsOf` 的基底）。 */
export function emptyAttrs(): ContainerAttrs {
  return { cover: '', instructor: '', difficulty: '', duration: 0, attachments: [], bodyMd: '' };
}

/**
 * 解析 `seq<0` 的属性行。
 * 未知 kind、`attr.attachment` 缺制表符、`attr.duration` 非正数一律**静默忽略**：
 * 属性行是「有则显示」的可选展示字段，坏一行不该让整门课打不开。
 */
export function attrsOf(segs: SegmentRow[]): ContainerAttrs {
  const out = emptyAttrs();
  for (const s of [...segs].filter((r) => r.seq < 0).sort((a, b) => a.seq - b.seq)) {
    switch (s.kind) {
      case ATTR_COVER:
        out.cover = s.text;
        break;
      case ATTR_INSTRUCTOR:
        out.instructor = s.text;
        break;
      case ATTR_DIFFICULTY:
        out.difficulty = s.text;
        break;
      case ATTR_DURATION: {
        const n = Number(s.text);
        out.duration = Number.isFinite(n) && n > 0 ? n : 0;
        break;
      }
      case ATTR_BODY_MD:
        out.bodyMd = s.text;
        break;
      case ATTR_ATTACHMENT: {
        const i = s.text.indexOf('\t');
        if (i > 0) out.attachments.push({ blobId: s.text.slice(0, i), name: s.text.slice(i + 1) });
        break;
      }
      default:
        break;
    }
  }
  return out;
}

/** 简介：`seq=0` 且 `kind=digest` 的行文本；无则空串（既有约定，本册不改语义）。 */
export function digestOf(segs: SegmentRow[]): string {
  const hit = segs.find((s) => s.seq === 0 && s.kind === DIGEST_KIND);
  return hit ? hit.text : '';
}

/** 子项清单行（`seq>=1`，按 seq 升序）：带 kind，供编辑回填与徽标计数。 */
export function childrenRowsOf(segs: SegmentRow[]): Array<{ kind: string; text: string }> {
  return [...segs]
    .filter((s) => s.seq >= 1)
    .sort((a, b) => a.seq - b.seq)
    .map((s) => ({ kind: s.kind, text: s.text }));
}

/** 清单行的 kind 计数（课程页徽标用）；未知 kind 照数，由页面决定显不显示。 */
export function childCounts(segs: SegmentRow[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of childrenRowsOf(segs)) out[r.kind] = (out[r.kind] ?? 0) + 1;
  return out;
}

/** 首段：跳过空行与 `#` 标题记号，取第一行非空文本；超长按 max 截断加省略号。 */
export function firstLine(md: string, max = 60): string {
  for (const raw of md.split('\n')) {
    const line = raw.replace(/^#{1,6}\s*/, '').trim();
    if (line !== '') return line.length > max ? `${line.slice(0, max)}…` : line;
  }
  return '';
}

/**
 * 课时摘要（本册 §2.2）：**优先 `seq=0` 的既有 digest**，缺失才回落正文首段截断。
 * 新写路径不产 digest 行，故新课时恒走回落分支。
 */
export function lessonDigest(segs: SegmentRow[], max = 60): string {
  const d = digestOf(segs);
  if (d !== '') return firstLine(d, max);
  return firstLine(attrsOf(segs).bodyMd, max);
}
```

- [ ] **Step 4: 跑测试确认通过**

Run（cwd `apps/mobile`）: `npx vitest run src/core/container-view.test.ts`
Expected: PASS（8 个用例全绿）。

- [ ] **Step 5: 类型门禁**

Run（cwd `apps/mobile`）: `npx tsc --noEmit`
Expected: 无输出。

- [ ] **Step 6: 提交**

```bash
git add apps/mobile/src/core/container-view.ts apps/mobile/src/core/container-view.test.ts
git commit -m "feat(mobile): 新增容器读取视图（属性行 / 简介 / 清单计数 / 课时摘要回落）"
```

---

### Task 9: `core/blob.ts`（块上传与取回）

**Files:**
- Create: `apps/mobile/src/core/blob.ts`
- Create: `apps/mobile/src/core/blob.test.ts`

- [ ] **Step 1: 写失败的测试**

创建 `apps/mobile/src/core/blob.test.ts`：

```ts
import { utf8 } from '@base/protocol-ts';
import { describe, expect, it } from 'vitest';

import { MAX_BLOB_BYTES, buildMultipartBody, fetchBlob, uploadBlob, type BlobOptions } from './blob';
import { FakeHttp, FakePackReader, MemoryFs, MemoryRepo, fakeAdapters } from './fakes';
import { decodeUtf8 } from './sync';

const BASE = 'https://node.test';

function json(v: unknown) {
  return { status: 200, body: utf8(JSON.stringify(v)) };
}

function fixture() {
  const http = new FakeHttp();
  const repo = new MemoryRepo();
  const adapters = fakeAdapters(http, new MemoryFs(), new FakePackReader());
  const o: BlobOptions = { adapters, repo, nodeBaseUrl: BASE };
  http.postRoutes.set(`${BASE}/v1/identity/register`, json({}));
  return { http, repo, o };
}

describe('blob 上传', () => {
  it('multipart 体：字段名 file、边界闭合、字节可逐段还原', () => {
    const body = buildMultipartBody('BOUND', 'a.txt', utf8('hi'));
    expect(decodeUtf8(body)).toBe(
      '--BOUND\r\nContent-Disposition: form-data; name="file"; filename="a.txt"\r\n' +
        'Content-Type: application/octet-stream\r\n\r\nhi\r\n--BOUND--\r\n',
    );
  });

  it('上传：先补登记，再带签名头 POST；Content-Type 带同一 boundary，返回节点算的 blob_id', async () => {
    const { http, o } = fixture();
    const want = 'a'.repeat(32);
    http.postRoutes.set(`${BASE}/v1/blob`, json({ blob_id: want, size: 2 }));

    expect(await uploadBlob(o, utf8('hi'), 'a.txt')).toBe(want);
    expect(http.posted.map((p) => p.url)).toEqual([`${BASE}/v1/identity/register`, `${BASE}/v1/blob`]);

    const wire = http.posted[1]!;
    const ct = wire.headers['Content-Type'] ?? '';
    expect(ct.startsWith('multipart/form-data; boundary=')).toBe(true);
    const boundary = ct.slice('multipart/form-data; boundary='.length);
    expect(decodeUtf8(wire.body).startsWith(`--${boundary}\r\n`)).toBe(true);
    expect(wire.headers['X-Base-Sig']).toBeTruthy();
  });

  it('本地拦截：空文件与超限不发请求', async () => {
    const { http, o } = fixture();
    await expect(uploadBlob(o, new Uint8Array(0), 'a.txt')).rejects.toThrow('文件内容为空');
    await expect(uploadBlob(o, new Uint8Array(MAX_BLOB_BYTES + 1), 'a.bin')).rejects.toThrow('文件超过 8 MiB');
    expect(http.posted).toHaveLength(0);
  });

  it('节点 413 blob_too_large → 可读错误', async () => {
    const { http, o } = fixture();
    http.postRoutes.set(`${BASE}/v1/blob`, { status: 413, body: utf8(JSON.stringify({ code: 'blob_too_large' })) });
    await expect(uploadBlob(o, utf8('x'), 'a.txt')).rejects.toThrow('上传块超过 8 MiB');
  });

  it('未配置节点：不发请求', async () => {
    const { http, o } = fixture();
    o.nodeBaseUrl = '';
    await expect(uploadBlob(o, utf8('x'), 'a.txt')).rejects.toThrow('未配置节点地址，无法上传');
    expect(http.posted).toHaveLength(0);
  });
});

describe('blob 取回', () => {
  it('GET /v1/blob/{id} 原样返回字节', async () => {
    const { http, o } = fixture();
    const id = 'b'.repeat(32);
    http.routes.set(`${BASE}/v1/blob/${id}`, { status: 200, body: utf8('附件正文') });
    expect(decodeUtf8(await fetchBlob(o, id))).toBe('附件正文');
  });

  it('非 2xx → 可读错误', async () => {
    const { http, o } = fixture();
    await expect(fetchBlob(o, 'c'.repeat(32))).rejects.toThrow('读取附件失败（HTTP 404）');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run（cwd `apps/mobile`）: `npx vitest run src/core/blob.test.ts`
Expected: FAIL —— `Failed to resolve import "./blob"`。

- [ ] **Step 3: 写实现**

创建 `apps/mobile/src/core/blob.ts`：

```ts
/**
 * 块上传 / 取回（本册 §3 / §5.2）：封面与附件先 `POST /v1/blob` 拿 `blob_id`，
 * 再把 `attr.cover` / `attr.attachment` 行写进容器投稿。
 *
 * 只依赖注入的 `Adapters` / `LocalRepo` 与 `core/identity`，不 import 'uni'，
 * 因此可在 Node 下用 `core/fakes.ts` 完整测试（与 core/submit.ts 同一约定）。
 */
import { bytesToHex, randomBytes, utf8 } from '@base/protocol-ts';

import type { Adapters } from '../platform/adapter';
import { CommentError, ensureRegistered, type CommentOptions } from './comment';
import { errorCodeOf, errorText } from './errors';
import { signRequestHeaders } from './identity';
import { decodeUtf8 } from './sync';

/** 与 `core/comment.ts` 同一组依赖（同一套 `ensureRegistered`）。 */
export type BlobOptions = CommentOptions;

/** 单请求上限 8 MiB——与节点 `maxBlobBytes` 同值（本册 §3）。 */
export const MAX_BLOB_BYTES = 8 << 20;

/** 上传 / 取回失败的用户可读错误；`rejected` = 节点明确拒绝（4xx）。 */
export class BlobError extends Error {
  constructor(
    readonly code: 'client' | 'network' | 'rejected' | 'server',
    message: string,
  ) {
    super(message);
    this.name = 'BlobError';
  }
}

/** 造 `multipart/form-data` 单块体：字段名固定 `file`（与节点 `handleBlobPost` 同契约）。 */
export function buildMultipartBody(boundary: string, filename: string, data: Uint8Array): Uint8Array {
  const head = utf8(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
      'Content-Type: application/octet-stream\r\n\r\n',
  );
  const tail = utf8(`\r\n--${boundary}--\r\n`);
  const out = new Uint8Array(head.length + data.length + tail.length);
  out.set(head, 0);
  out.set(data, head.length);
  out.set(tail, head.length + data.length);
  return out;
}

/**
 * 上传一块，返回节点算出的 `blob_id`（内容寻址：同字节重复上传返回同一 id，块只落一份）。
 * 封面 / 附件的调用方随后把该 id 写进 `attr.cover` / `attr.attachment`。
 */
export async function uploadBlob(o: BlobOptions, data: Uint8Array, filename: string): Promise<string> {
  if (o.nodeBaseUrl === '') throw new BlobError('client', '未配置节点地址，无法上传');
  if (data.length === 0) throw new BlobError('client', '文件内容为空');
  if (data.length > MAX_BLOB_BYTES) throw new BlobError('client', '文件超过 8 MiB');

  let ident;
  try {
    ident = await ensureRegistered(o);
  } catch (e) {
    if (e instanceof CommentError) {
      throw new BlobError(e.code === 'network' ? 'network' : 'client', e.message);
    }
    throw new BlobError('client', `身份准备失败：${(e as Error).message ?? String(e)}`);
  }

  const boundary = `----base${bytesToHex(randomBytes(12))}`;
  const body = buildMultipartBody(boundary, filename, data);

  let headers;
  try {
    headers = signRequestHeaders(ident, { method: 'POST', path: '/v1/blob', body });
  } catch (e) {
    throw new BlobError('client', `签名请求失败：${(e as Error).message ?? String(e)}`);
  }

  let res;
  try {
    res = await o.adapters.http.post(`${o.nodeBaseUrl}/v1/blob`, body, {
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
      ...headers,
    });
  } catch {
    throw new BlobError('network', '无法连接节点，请稍后重试');
  }
  if (res.status !== 200) throw mapBlobFailure(res.status, decodeUtf8(res.body));

  const out = JSON.parse(decodeUtf8(res.body)) as { blob_id?: string };
  const blobId = String(out.blob_id ?? '');
  if (blobId === '') throw new BlobError('server', '节点未返回 blob_id');
  return blobId;
}

/** 取回一块的明文字节（课时页的「附件另存」用，本册 §5.2）。 */
export async function fetchBlob(o: BlobOptions, blobId: string): Promise<Uint8Array> {
  let res;
  try {
    res = await o.adapters.http.get(`${o.nodeBaseUrl}/v1/blob/${blobId}`);
  } catch {
    throw new BlobError('network', '无法连接节点，请稍后重试');
  }
  if (res.status !== 200) throw new BlobError('server', `读取附件失败（HTTP ${res.status}）`);
  return res.body;
}

/** 节点错误码 → 用户可读错误（码表在 `core/errors.ts`，本文件只补 blob 专有文案）。 */
function mapBlobFailure(status: number, raw: string): BlobError {
  const code = errorCodeOf(raw);
  if (code === 'blob_too_large') return new BlobError('rejected', '上传块超过 8 MiB');
  const message = errorText(code, `上传失败（HTTP ${status}）`);
  return new BlobError(status >= 400 && status < 500 ? 'rejected' : 'server', message);
}
```

在 `apps/mobile/src/core/errors.ts` 的 `SERVER_ERROR_TEXT` 表里补两条（放在 `item_id_taken` 之后）：

```ts
  blob_too_large: '上传块超过 8 MiB',
  bad_multipart: '上传格式错误（需 multipart/form-data 且含字段 file）',
```

- [ ] **Step 4: 跑测试确认通过**

Run（cwd `apps/mobile`）: `npx vitest run src/core/blob.test.ts`
Expected: PASS（7 个用例全绿）。

- [ ] **Step 5: 类型门禁**

Run（cwd `apps/mobile`）: `npx tsc --noEmit`
Expected: 无输出。

- [ ] **Step 6: 提交**

```bash
git add apps/mobile/src/core/blob.ts apps/mobile/src/core/blob.test.ts apps/mobile/src/core/errors.ts
git commit -m "feat(mobile): 新增 POST /v1/blob 上传与取回封装"
```

---

### Task 10: 投稿载荷与台账扩 `course|lesson`（`submit.ts` / `types.ts` / `repo.ts`）

**Files:**
- Modify: `apps/mobile/src/core/submit.ts`
- Modify: `apps/mobile/src/core/types.ts:109-129`
- Modify: `apps/mobile/src/core/repo.ts:126-129,164-169,507-532,643-658`
- Modify: `apps/mobile/src/core/submit.test.ts`

- [ ] **Step 1: 先改测试（失败的测试）**

`apps/mobile/src/core/submit.test.ts` 三处改动：

1) import 行加容器载荷与草稿类型：

```ts
import { buildArticlePayload, buildContainerPayload, buildQuizPayload, buildTagPayload, contentHashOf, enqueueOrSend, flushSubmissions, newItemID, submitItem, type SubmitDraft, type SubmitOptions } from './submit';
```

2) `newItemID` 用例的循环加上 `'course'`：

```ts
    for (const type of ['article', 'quiz', 'course'] as const) {
```

3) 把「`course/` 前缀：错误码提示后另加一句」这个用例**整段替换**为容器用例（旧行为已废止：`course/` 不再一律拒）：

```ts
describe('容器载体（course / lesson）', () => {
  const containerDraft = (over: Partial<SubmitDraft> = {}): SubmitDraft => ({
    itemId: 'course/c1',
    type: 'course',
    title: '甲课',
    bodyMd: '',
    questionJson: '',
    segments: [
      { seq: -1, kind: 'attr.cover', text: '00112233445566778899aabbccddeeff' },
      { seq: 0, kind: 'digest', text: '简介' },
      { seq: 1, kind: 'lesson', text: 'course/c1/lesson/l1' },
    ],
    ...over,
  });

  it('载荷键序固定为 type→item_id→title→segments→author_sig，且 segments 按 seq 升序', () => {
    const wire = decodeUtf8(
      buildContainerPayload(
        'course',
        'course/c1',
        '甲课',
        [
          { seq: 1, kind: 'lesson', text: 'course/c1/lesson/l1' },
          { seq: -1, kind: 'attr.cover', text: '00112233445566778899aabbccddeeff' },
        ],
        'ff'.repeat(64),
      ),
    );
    expect(wire).toBe(
      '{"type":"course","item_id":"course/c1","title":"甲课",' +
        '"segments":[{"seq":-1,"kind":"attr.cover","text":"00112233445566778899aabbccddeeff"},' +
        '{"seq":1,"kind":"lesson","text":"course/c1/lesson/l1"}],' +
        '"author_sig":"' +
        'ff'.repeat(64) +
        '"}',
    );
  });

  it('content_hash 走容器口径（与节点 store.SegmentsContentHash 同构）', () => {
    expect(contentHashOf(containerDraft())).toBe(
      sha256Hex(utf8('attr.cover\t00112233445566778899aabbccddeeff\ndigest\t简介\nlesson\tcourse/c1/lesson/l1\n')),
    );
  });

  it('首投：作者签名可被节点按同一字节重建验证', async () => {
    const { http, o } = fixture();
    http.postRoutes.set(`${BASE}/v1/identity/register`, json({}));
    http.postRoutes.set(`${BASE}/v1/submit`, json({ item_id: 'course/c1', created: true }));

    await submitItem(o, containerDraft());
    const sent = JSON.parse(decodeUtf8(http.posted[1]!.body)) as Record<string, Json>;
    const pub = registeredPub(http);
    const authorId = (JSON.parse(decodeUtf8(http.posted[0]!.body)) as { id: string }).id;
    expect(verifyAuthorSig(pub, 'course/c1', contentHashOf(containerDraft()), authorId, sent.author_sig as string)).toBe(true);
    expect((sent.segments as unknown[]).length).toBe(3);
  });

  it('断网入队 → 台账存下 segments_json → 补发时行集完整重建', async () => {
    const { http, repo, o } = fixture();
    http.postRoutes.set(`${BASE}/v1/identity/register`, json({}));
    const state = gateSubmit(http);

    const out = await enqueueOrSend(o, containerDraft());
    expect(out.ledgerState).toBe('pending');
    const row = await repo.getSubmission('course/c1');
    expect(row?.type).toBe('course');
    expect(row?.bodyMd).toBe('');
    expect(row?.segmentsJson).toBe(
      '[{"seq":-1,"kind":"attr.cover","text":"00112233445566778899aabbccddeeff"},' +
        '{"seq":0,"kind":"digest","text":"简介"},' +
        '{"seq":1,"kind":"lesson","text":"course/c1/lesson/l1"}]',
    );

    state.offline = false;
    http.postRoutes.set(`${BASE}/v1/submit`, json({ item_id: 'course/c1', created: false }));
    expect((await flushSubmissions(o)).sent).toBe(1);
    const wire = JSON.parse(decodeUtf8(http.posted.at(-1)!.body)) as { segments: unknown[] };
    expect(wire.segments).toHaveLength(3);
  });

  it('本地校验：容器只拦标题为空', async () => {
    const { http, o } = fixture();
    const err = await enqueueOrSend(o, containerDraft({ title: '  ' })).catch((e: unknown) => e);
    expect((err as Error).message).toBe('请填写标题');
    expect(http.posted).toHaveLength(0);
  });

  it('非容器形态回 item_id_invalid，且不再附加「不能指定课程」', async () => {
    const { http, repo, o } = fixture();
    http.postRoutes.set(`${BASE}/v1/identity/register`, json({}));
    http.postRoutes.set(`${BASE}/v1/submit`, { status: 400, body: utf8(JSON.stringify({ code: 'item_id_invalid' })) });

    const r = await enqueueOrSend(o, containerDraft({ itemId: 'course/c1/lesson/l1/quiz/q1' }));
    expect(r.ledgerState).toBe('failed');
    expect((await repo.getSubmission('course/c1/lesson/l1/quiz/q1'))!.reason).toBe('条目 id 不合法');
  });
});
```

4) 两处直接构造 `MySubmissionRow` 的字面量（补发用例）各补一个 `segmentsJson: ''` 字段——TS 的 `strict` 下缺列即编译失败：

```ts
      await repo.saveSubmission({
        itemId: id, type: 'article', title: id, bodyMd: '正文', questionJson: '', linksJson: '', segmentsJson: '',
        state: 'pending', reason: null, created: 0, queuedAt: `2026-09-28T00:00:0${id.slice(-1) === 'e' ? 1 : id.slice(-1) === 'o' ? 2 : 3}Z`, sentAt: '',
      });
```

```ts
    await repo.saveSubmission({
      itemId: 'article/one', type: 'article', title: '甲', bodyMd: '正文', questionJson: '', linksJson: '', segmentsJson: '',
      state: 'pending', reason: null, created: 0, queuedAt: '2026-09-28T00:00:01Z', sentAt: '',
    });
```

- [ ] **Step 2: 跑测试确认失败**

Run（cwd `apps/mobile`）: `npx vitest run src/core/submit.test.ts`
Expected: FAIL —— `buildContainerPayload` 未导出、`segmentsJson` 不在 `MySubmissionRow` 上。

- [ ] **Step 3: 改 `core/types.ts`**

`MySubmissionRow` 的 `type` 扩两型，并新增 `segmentsJson`：

```ts
export interface MySubmissionRow {
  /** `<type>/<slug>`，与节点侧同一 id */
  itemId: string;
  /** course / lesson 是容器（本册 §2.3）；其余不变 */
  type: 'article' | 'quiz' | 'tag' | 'course' | 'lesson';
  title: string;
  /** 文章正文（quiz / 容器行为空串） */
  bodyMd: string;
  /** 题库 JSON 字符串（其余为空串） */
  questionJson: string;
  /** 标签关联的 JSON 文本（`[{target_id,kind}]`）；非 tag 载体恒为空串。补发要从它重建草稿。 */
  linksJson: string;
  /** 容器行集 JSON 文本（`[{seq,kind,text}]`，按 seq 升序）；非容器载体恒为空串。补发要从它重建行集（本册 §4.1）。 */
  segmentsJson: string;
  state: 'pending' | 'sent' | 'failed';
  /** `state='failed'` 时的用户可读原因（错误码映射后的中文）；可空 */
  reason: string | null;
  /** 服务端 `created` 回填：1 新建、0 更新 */
  created: number;
  /** 入队时刻 ISO8601（补发排序键） */
  queuedAt: string;
  /** 送达时刻 ISO8601；未送达为空串 */
  sentAt: string;
}
```

- [ ] **Step 4: 改 `core/repo.ts`**

1) `SCHEMA_SQL` 的建表语句（第 126-129 行）加列：

```ts
  `CREATE TABLE IF NOT EXISTS my_submissions(
     item_id TEXT PRIMARY KEY, type TEXT NOT NULL, title TEXT NOT NULL, body_md TEXT NOT NULL,
     question_json TEXT NOT NULL, links_json TEXT NOT NULL DEFAULT '', segments_json TEXT NOT NULL DEFAULT '',
     state TEXT NOT NULL, reason TEXT, created INTEGER NOT NULL,
     queued_at TEXT NOT NULL, sent_at TEXT NOT NULL)`,
```

2) `ensureSubmissionColumns` 追加幂等补列：

```ts
export async function ensureSubmissionColumns(db: LocalDb): Promise<void> {
  const cols = new Set((await db.select(`PRAGMA table_info(my_submissions)`)).map((r) => String(r.name)));
  if (!cols.has('links_json')) {
    await db.execute(`ALTER TABLE my_submissions ADD COLUMN links_json TEXT NOT NULL DEFAULT ''`);
  }
  if (!cols.has('segments_json')) {
    await db.execute(`ALTER TABLE my_submissions ADD COLUMN segments_json TEXT NOT NULL DEFAULT ''`);
  }
}
```

3) `saveSubmission` 的列与参数：

```ts
  async saveSubmission(row: MySubmissionRow): Promise<void> {
    await this.db.execute(
      `INSERT INTO my_submissions(item_id,type,title,body_md,question_json,links_json,segments_json,state,reason,created,queued_at,sent_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(item_id) DO UPDATE SET type=excluded.type,title=excluded.title,body_md=excluded.body_md,
         question_json=excluded.question_json,links_json=excluded.links_json,segments_json=excluded.segments_json,
         state=excluded.state,reason=excluded.reason,
         created=excluded.created,queued_at=excluded.queued_at,sent_at=excluded.sent_at`,
      [row.itemId, row.type, row.title, row.bodyMd, row.questionJson, row.linksJson, row.segmentsJson, row.state, row.reason, row.created, row.queuedAt, row.sentAt],
    );
  }
```

4) `listSubmissions` / `getSubmission` 的列清单：

```ts
  async listSubmissions(state?: 'pending' | 'sent' | 'failed'): Promise<MySubmissionRow[]> {
    const cols = `item_id,type,title,body_md,question_json,links_json,segments_json,state,reason,created,queued_at,sent_at`;
    const rows = state
      ? await this.db.select(`SELECT ${cols} FROM my_submissions WHERE state=? ORDER BY queued_at ASC`, [state])
      : await this.db.select(`SELECT ${cols} FROM my_submissions ORDER BY queued_at ASC`);
    return rows.map(toMySubmissionRow);
  }

  async getSubmission(itemId: string): Promise<MySubmissionRow | null> {
    const rows = await this.db.select(
      `SELECT item_id,type,title,body_md,question_json,links_json,segments_json,state,reason,created,queued_at,sent_at FROM my_submissions WHERE item_id=?`,
      [itemId],
    );
    return rows.length > 0 ? toMySubmissionRow(rows[0]) : null;
  }
```

5) `toMySubmissionRow` 的 type 归一与 `segmentsJson`：

```ts
function toMySubmissionRow(r: Record<string, unknown>): MySubmissionRow {
  const state = String(r.state);
  const raw = String(r.type);
  const type: MySubmissionRow['type'] =
    raw === 'quiz' || raw === 'tag' || raw === 'course' || raw === 'lesson' ? raw : 'article';
  return {
    itemId: String(r.item_id),
    type,
    title: String(r.title ?? ''),
    bodyMd: String(r.body_md ?? ''),
    questionJson: String(r.question_json ?? ''),
    linksJson: String(r.links_json ?? ''),
    segmentsJson: String(r.segments_json ?? ''),
    state: state === 'sent' ? 'sent' : state === 'failed' ? 'failed' : 'pending',
    reason: toNullableString(r.reason),
    created: Number(r.created ?? 0),
    queuedAt: String(r.queued_at ?? ''),
    sentAt: String(r.sent_at ?? ''),
  };
}
```

6) `fakes.ts` 的 `MemoryRepo` 不用改（`saveSubmission` 直接存整行对象）。

- [ ] **Step 5: 改 `core/submit.ts`**

1) import 补属性模块（**只引入本文件用得到的两个符号**，多余符号会让 `tsc` 因未使用变量报错）：

```ts
import { segmentsContentHash, type SubmitSegmentRow } from './attrs';
```

2) 草稿与 id 生成：

```ts
/** 容器载体的两种类型（本册 §2.3）。 */
export type ContainerSubmitType = 'course' | 'lesson';

/** 一条待投内容：与台账行的可编辑字段一一对应。 */
export interface SubmitDraft {
  itemId: string;
  type: 'article' | 'quiz' | 'tag' | ContainerSubmitType;
  title: string;
  bodyMd: string;
  /** quiz 专有；其余恒为空串 */
  questionJson: string;
  /** tag 专有：本次直打要建立的关联集（其余载体不传）。 */
  links?: TagLinkRow[];
  /** course / lesson 专有：完整 segments 行集（含 seq<0 属性行与 seq>=1 清单行，本册 §4.1）。 */
  segments?: SubmitSegmentRow[];
}

/** 生成一个新条目的 id：`<type>/<16 位 hex>`（恒满足 `[a-z0-9][a-z0-9-]{0,63}`，本册 §3）。 */
export function newItemID(type: 'article' | 'quiz' | 'course'): string {
  return `${type}/${bytesToHex(randomBytes(8))}`;
}

/** 课时 id：`course/<cid>/lesson/<16 位 hex>`——课时不独立存在，必须挂在课程下（本册 §6）。 */
export function newLessonID(courseId: string): string {
  return `${courseId}/lesson/${bytesToHex(randomBytes(8))}`;
}
```

3) `contentHashOf` 加容器分支：

```ts
export function contentHashOf(draft: SubmitDraft): string {
  if (draft.type === 'tag') {
    // 容器口径（#14 §3.3）：哈希只看物化的 segments 行，与 article/quiz 的「取正文」口径不同。
    return sha256Hex(utf8(materializeTagText(draft.links ?? [])));
  }
  if (draft.type === 'course' || draft.type === 'lesson') {
    // 容器口径（本册 §2.3）：哈希看**完整行集**，含 seq<0 属性行——与 #37 的 tag 口径同源。
    return segmentsContentHash(draft.segments ?? []);
  }
  return sha256Hex(utf8(draft.type === 'quiz' ? draft.questionJson : draft.bodyMd));
}
```

4) 新增容器请求体构造（放在 `buildTagPayload` 之后）：

```ts
/** `course` / `lesson` 请求体字节。键序固定：type → item_id → title → segments → author_sig。 */
export function buildContainerPayload(
  type: ContainerSubmitType,
  itemId: string,
  title: string,
  segments: SubmitSegmentRow[],
  authorSig: string,
): Uint8Array {
  return utf8(
    JSON.stringify({
      type,
      item_id: itemId,
      title,
      segments: [...segments].sort((a, b) => a.seq - b.seq).map((s) => ({ seq: s.seq, kind: s.kind, text: s.text })),
      author_sig: authorSig,
    }),
  );
}
```

5) `validateDraft` 加容器分支（插在 tag 分支之后）：

```ts
  if (draft.type === 'course' || draft.type === 'lesson') {
    // 容器只拦「客户端一定判断得了」的这一条：标题非空。行集的三区间铁律交服务端裁决（本册 §4.1）。
    if (draft.title.trim() === '') return { ok: false, message: '请填写标题' };
    return { ok: true, message: '' };
  }
```

6) `buildSubmitBody` 加容器分支：

```ts
export function buildSubmitBody(draft: SubmitDraft, ident: Identity): Uint8Array {
  const title = draft.title.trim();
  const contentHash = contentHashOf(draft);
  const sig = localStep('签名', () => sign(ident.seedHex, utf8(authorSignBytes(draft.itemId, contentHash, ident.id))));
  if (draft.type === 'tag') return buildTagPayload(draft.itemId, title, draft.links ?? [], sig);
  if (draft.type === 'course' || draft.type === 'lesson') {
    return buildContainerPayload(draft.type, draft.itemId, title, draft.segments ?? [], sig);
  }
  return draft.type === 'quiz'
    ? buildQuizPayload(draft.itemId, title, draft.questionJson, sig)
    : buildArticlePayload(draft.itemId, title, draft.bodyMd, sig);
}
```

7) `mapSubmitFailure` **删掉** `course/` 特判（本册 §2.3 起 `course/` 前缀不再一律拒，这句提示反而误导）：

```ts
function mapSubmitFailure(status: number, raw: string, itemId: string): SubmitError {
  const code = errorCodeOf(raw);
  if (status === 429 || code === 'item_rate_limited') {
    return new SubmitError('rate_limited', '提交过于频繁，请稍后再试');
  }
  const message = errorText(code, `提交失败（HTTP ${status}）`);
  // 4xx（除 429）= 永久失败；5xx = 节点侧问题，视为暂时
  return new SubmitError(status >= 400 && status < 500 ? 'rejected' : 'server', message);
}
```

> `itemId` 形参保留：`mapSubmitFailure` 的调用点签名不动（后续册子要用它做更细的定位）。

8) `writeLedger` 落 `segmentsJson`：

```ts
async function writeLedger(o: SubmitOptions, draft: SubmitDraft, patch: Partial<MySubmissionRow>): Promise<void> {
  const prev = await o.repo.getSubmission(draft.itemId);
  const isContainer = draft.type === 'course' || draft.type === 'lesson';
  await o.repo.saveSubmission({
    itemId: draft.itemId,
    type: draft.type,
    title: draft.title.trim(),
    bodyMd: draft.type === 'article' ? draft.bodyMd : '',
    questionJson: draft.type === 'quiz' ? draft.questionJson : '',
    linksJson: draft.type === 'tag' ? JSON.stringify(sortTagLinks(draft.links ?? []).map((l) => ({ target_id: l.targetId, kind: l.kind }))) : '',
    segmentsJson: isContainer ? JSON.stringify([...(draft.segments ?? [])].sort((a, b) => a.seq - b.seq)) : '',
    state: 'pending',
    reason: null,
    created: prev?.created ?? 0,
    queuedAt: new Date().toISOString(),
    sentAt: '',
    ...patch,
  });
}
```

9) 补发时重建行集：

```ts
    const draft: SubmitDraft = {
      itemId: row.itemId,
      type: row.type,
      title: row.title,
      bodyMd: row.bodyMd,
      questionJson: row.questionJson,
      links: row.type === 'tag' ? decodeLedgerLinks(row.itemId, row.linksJson) : undefined,
      segments: row.type === 'course' || row.type === 'lesson' ? decodeLedgerSegments(row.segmentsJson) : undefined,
    };
```

```ts
/** 台账 `segments_json` → 草稿 `segments`；空串或解析失败按空数组（节点会拒，不会写出错数据）。 */
function decodeLedgerSegments(raw: string): SubmitSegmentRow[] {
  if (raw === '') return [];
  try {
    const arr = JSON.parse(raw) as Array<{ seq?: number; kind?: string; text?: string }>;
    if (!Array.isArray(arr)) return [];
    return arr.map((s) => ({ seq: Number(s.seq ?? 0), kind: String(s.kind ?? ''), text: String(s.text ?? '') }));
  } catch {
    return [];
  }
}
```

> `DIGEST_KIND` 到这一步还没被 submit.ts 用到——**不要**放进 import，否则 `tsc` 因未使用变量报错。它由 Task 11 的 `course-edit.ts` 使用。

- [ ] **Step 6: 跑测试确认通过**

Run（cwd `apps/mobile`）: `npx vitest run src/core/submit.test.ts`
Expected: PASS（既有用例 + 6 个容器用例全绿）。

- [ ] **Step 7: 全量门禁**

Run（cwd `apps/mobile`）: `npx vitest run && npx tsc --noEmit`
Expected: 全绿、无类型错误（若有其它文件构造 `MySubmissionRow` 字面量，补 `segmentsJson: ''`）。

- [ ] **Step 8: 提交**

```bash
git add apps/mobile/src/core/submit.ts apps/mobile/src/core/submit.test.ts apps/mobile/src/core/types.ts apps/mobile/src/core/repo.ts
git commit -m "feat(mobile): 投稿载荷与台账扩 course/lesson 容器（segments_json）"
```

---

### Task 11: `core/course-edit.ts`（容器编辑编排）

**Files:**
- Create: `apps/mobile/src/core/course-edit.ts`
- Create: `apps/mobile/src/core/course-edit.test.ts`

- [ ] **Step 1: 写失败的测试**

创建 `apps/mobile/src/core/course-edit.test.ts`：

```ts
import { utf8 } from '@base/protocol-ts';
import { describe, expect, it } from 'vitest';

import {
  buildContainerSegments,
  emptyContainerForm,
  loadContainerForm,
  saveContainer,
  startNewCourse,
  startNewLesson,
  type ContainerForm,
} from './course-edit';
import { FakeHttp, FakePackReader, MemoryFs, MemoryRepo, fakeAdapters } from './fakes';
import { decodeUtf8 } from './sync';
import type { SubmitOptions } from './submit';

const BASE = 'https://node.test';

function json(v: unknown) {
  return { status: 200, body: utf8(JSON.stringify(v)) };
}

function lessonForm(over: Partial<ContainerForm> = {}): ContainerForm {
  return {
    ...emptyContainerForm('lesson', 'course/c1/lesson/l1'),
    title: '第一讲',
    digest: '简介',
    cover: '00112233445566778899aabbccddeeff',
    instructor: '李老师',
    difficulty: 'basic',
    durationSec: 3600,
    attachments: [
      { blobId: '00000000000000000000000000000000', name: '讲义.pdf' },
      { blobId: 'ffffffffffffffffffffffffffffffff', name: '附录.pdf' },
    ],
    bodyMd: '# 讲稿',
    children: [
      { kind: 'article', itemId: 'course/c1/lesson/l1/article/a1' },
      { kind: 'quiz', itemId: 'course/c1/lesson/l1/quiz/q1' },
    ],
    ...over,
  };
}

describe('buildContainerSegments：表单 → 行集（本册 §4.1）', () => {
  it('属性行 seq<0 规范排布，digest 占 0，清单从 1 起连续', () => {
    expect(buildContainerSegments(lessonForm())).toEqual([
      { seq: -1, kind: 'attr.attachment', text: '00000000000000000000000000000000\t讲义.pdf' },
      { seq: -2, kind: 'attr.attachment', text: 'ffffffffffffffffffffffffffffffff\t附录.pdf' },
      { seq: -3, kind: 'attr.body_md', text: '# 讲稿' },
      { seq: -4, kind: 'attr.cover', text: '00112233445566778899aabbccddeeff' },
      { seq: -5, kind: 'attr.difficulty', text: 'basic' },
      { seq: -6, kind: 'attr.duration', text: '3600' },
      { seq: -7, kind: 'attr.instructor', text: '李老师' },
      { seq: 0, kind: 'digest', text: '简介' },
      { seq: 1, kind: 'article', text: 'course/c1/lesson/l1/article/a1' },
      { seq: 2, kind: 'quiz', text: 'course/c1/lesson/l1/quiz/q1' },
    ]);
  });

  it('课程不吃正文：course 类型即使填了 bodyMd 也不产 attr.body_md', () => {
    const rows = buildContainerSegments(lessonForm({ type: 'course', itemId: 'course/c1', bodyMd: '# 不该出现' }));
    expect(rows.some((r) => r.kind === 'attr.body_md')).toBe(false);
  });

  it('空字段不产行；时长非正数不产行；纯空表单得空行集', () => {
    expect(buildContainerSegments(emptyContainerForm('course', 'course/c1'))).toEqual([]);
    const rows = buildContainerSegments(lessonForm({ durationSec: 0, attachments: [], digest: '', children: [] }));
    expect(rows.map((r) => r.kind)).toEqual(['attr.body_md', 'attr.cover', 'attr.difficulty', 'attr.instructor']);
  });
});

describe('loadContainerForm：从本地包回填', () => {
  it('标题取 items，属性 / 简介 / 清单各自归位', async () => {
    const repo = new MemoryRepo();
    await repo.applyPack({
      version: 1, packId: 'p1', updatedAt: '2026-09-30T00:00:00Z', articles: [], quizzes: [], tombstones: [],
      items: [
        { itemId: 'course/c1/lesson/l1', source: 'lesson', type: 'lesson', title: '第一讲', rev: 'r', contentHash: 'h', state: 'active', updatedAt: '' },
      ],
      segments: [
        { itemId: 'course/c1/lesson/l1', seq: -1, kind: 'attr.cover', text: '00112233445566778899aabbccddeeff', contentHash: 'h' },
        { itemId: 'course/c1/lesson/l1', seq: -2, kind: 'attr.body_md', text: '# 讲稿', contentHash: 'h' },
        { itemId: 'course/c1/lesson/l1', seq: 0, kind: 'digest', text: '简介', contentHash: 'h' },
        { itemId: 'course/c1/lesson/l1', seq: 1, kind: 'article', text: 'course/c1/lesson/l1/article/a1', contentHash: 'h' },
      ],
    });

    expect(await loadContainerForm(repo, 'course/c1/lesson/l1', 'lesson')).toEqual({
      itemId: 'course/c1/lesson/l1', type: 'lesson', title: '第一讲', digest: '简介',
      cover: '00112233445566778899aabbccddeeff', instructor: '', difficulty: '', durationSec: 0,
      attachments: [], bodyMd: '# 讲稿',
      children: [{ kind: 'article', itemId: 'course/c1/lesson/l1/article/a1' }],
    });
  });

  it('条目不存在也不抛：得空表单（保留给定 itemId 与 type）', async () => {
    const form = await loadContainerForm(new MemoryRepo(), 'course/none', 'course');
    expect(form.title).toBe('');
    expect(form.itemId).toBe('course/none');
    expect(form.type).toBe('course');
  });
});

describe('startNewCourse / startNewLesson / saveContainer', () => {
  it('startNewCourse：id 形如 course/<16 位 hex>；startNewLesson 挂在课程下', () => {
    expect(/^course\/[0-9a-f]{16}$/.test(startNewCourse().itemId)).toBe(true);
    expect(/^course\/c1\/lesson\/[0-9a-f]{16}$/.test(startNewLesson('course/c1').itemId)).toBe(true);
  });

  it('saveContainer：投稿行集与表单一致，台账落 segments_json', async () => {
    const http = new FakeHttp();
    const repo = new MemoryRepo();
    const adapters = fakeAdapters(http, new MemoryFs(), new FakePackReader());
    const o: SubmitOptions = { adapters, repo, nodeBaseUrl: BASE };
    http.postRoutes.set(`${BASE}/v1/identity/register`, json({}));
    http.postRoutes.set(`${BASE}/v1/submit`, json({ item_id: 'course/c1/lesson/l1', created: true }));

    const out = await saveContainer(o, lessonForm());
    expect(out.ledgerState).toBe('sent');
    const wire = JSON.parse(decodeUtf8(http.posted.at(-1)!.body)) as { segments: unknown[] };
    expect(wire.segments).toHaveLength(10);
    expect((await repo.getSubmission('course/c1/lesson/l1'))!.segmentsJson).toContain('"seq":-1');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run（cwd `apps/mobile`）: `npx vitest run src/core/course-edit.test.ts`
Expected: FAIL —— `Failed to resolve import "./course-edit"`。

- [ ] **Step 3: 写实现**

创建 `apps/mobile/src/core/course-edit.ts`：

```ts
/**
 * 容器（课程 / 课时）编辑编排（本册 §6）：表单模型 ↔ `segments` 行集的来回转换。
 * 纯函数 + 一个 `saveContainer` 出口（走既有 `enqueueOrSend`）；不 import 'uni'，
 * 故可在 Node 下用 `core/fakes.ts` 完整测试（与 core/submit.ts 同一约定）。
 *
 * **子项清单由编辑页直接管**：表单里的 `children` 就是 `seq>=1` 的全集，提交时整段覆盖——
 * 节点 `UpsertSegmentSubmission` 先删同 item_id 旧行再按 seq 写入，天然是「整体替换」语义。
 */
import {
  ATTR_ATTACHMENT,
  ATTR_BODY_MD,
  ATTR_COVER,
  ATTR_DIFFICULTY,
  ATTR_DURATION,
  ATTR_INSTRUCTOR,
  DIGEST_KIND,
  assignAttrSeqs,
  type AttrLine,
  type SubmitSegmentRow,
} from './attrs';
import { attrsOf, childrenRowsOf, digestOf } from './container-view';
import type { LocalRepo } from './repo';
import {
  enqueueOrSend,
  newItemID,
  newLessonID,
  type ContainerSubmitType,
  type SubmitOptions,
  type SubmitOutcome,
} from './submit';

/** 容器类型（与 submit.ts 的 `ContainerSubmitType` 同源）。 */
export type ContainerType = ContainerSubmitType;

/** 一行附件（`attr.attachment` 的 text = `<blob_id>\t<文件名>`）。 */
export interface AttachmentRow {
  blobId: string;
  name: string;
}

/** 一行子项（`seq>=1` 的清单行）；`kind` 由容器形态决定（course 收 lesson，lesson 收 article|video|audio|quiz）。 */
export interface ChildRow {
  kind: string;
  itemId: string;
}

/** 容器编辑表单：页面可编辑字段的全集，与台账 / 行集一一对应。 */
export interface ContainerForm {
  itemId: string;
  type: ContainerType;
  title: string;
  /** 简介 → `seq=0` 的 `digest` 行；空串则不产该行 */
  digest: string;
  /** 封面 blob_id；空串 = 不产该行 */
  cover: string;
  instructor: string;
  /** intro | basic | advanced；空串 = 不产该行 */
  difficulty: string;
  /** 秒；非正数 = 不产该行 */
  durationSec: number;
  attachments: AttachmentRow[];
  /** 仅课时：Markdown 正文 → `attr.body_md`；course 恒忽略 */
  bodyMd: string;
  /** 子项清单，按展示顺序；写入时 seq 从 1 起连续 */
  children: ChildRow[];
}

/** 新建 / 编辑表单初值。`itemId` 由调用方给定并**固定**（新建时页面一打开就生成，见 Task 12）。 */
export function emptyContainerForm(type: ContainerType, itemId: string): ContainerForm {
  return {
    itemId,
    type,
    title: '',
    digest: '',
    cover: '',
    instructor: '',
    difficulty: '',
    durationSec: 0,
    attachments: [],
    bodyMd: '',
    children: [],
  };
}

/** 新建课程：生成新 id 并回填。页面打开即调用，使「+ 加一课」能立刻拼出子项 id。 */
export function startNewCourse(): ContainerForm {
  return emptyContainerForm('course', newItemID('course'));
}

/** 新建课时：挂在给定课程下（课时不独立存在，本册 §6）。 */
export function startNewLesson(courseId: string): ContainerForm {
  return emptyContainerForm('lesson', newLessonID(courseId));
}

/**
 * 表单 → `segments` 行集（本册 §4.1）：属性行（seq<0）→ 可选简介（seq=0）→ 清单（seq=1..n）。
 * 属性行必须经 `assignAttrSeqs` 排布——`seq<0` 的顺序进 content_hash，两端不一致会静默出新版本（§8 风险 2）。
 */
export function buildContainerSegments(form: ContainerForm): SubmitSegmentRow[] {
  const lines: AttrLine[] = [];
  if (form.cover !== '') lines.push({ kind: ATTR_COVER, text: form.cover });
  if (form.instructor !== '') lines.push({ kind: ATTR_INSTRUCTOR, text: form.instructor });
  if (form.difficulty !== '') lines.push({ kind: ATTR_DIFFICULTY, text: form.difficulty });
  if (form.durationSec > 0) lines.push({ kind: ATTR_DURATION, text: String(Math.trunc(form.durationSec)) });
  for (const a of form.attachments) {
    if (a.blobId !== '') lines.push({ kind: ATTR_ATTACHMENT, text: `${a.blobId}\t${a.name}` });
  }
  if (form.type === 'lesson' && form.bodyMd !== '') lines.push({ kind: ATTR_BODY_MD, text: form.bodyMd });

  const out: SubmitSegmentRow[] = assignAttrSeqs(lines).map((s) => ({ seq: s.seq, kind: s.kind, text: s.text }));
  if (form.digest !== '') out.push({ seq: 0, kind: DIGEST_KIND, text: form.digest });
  form.children.forEach((c, i) => out.push({ seq: i + 1, kind: c.kind, text: c.itemId }));
  return out;
}

/** 从本地包回填表单：标题取 `items`，其余取 `segments` 的三区间。条目不存在也得空表单，不抛。 */
export async function loadContainerForm(repo: LocalRepo, itemId: string, type: ContainerType): Promise<ContainerForm> {
  const item = await repo.getItem(itemId);
  const segs = await repo.listSegments(itemId);
  const attrs = attrsOf(segs);
  const form = emptyContainerForm(type, itemId);
  form.title = item?.title ?? '';
  form.digest = digestOf(segs);
  form.cover = attrs.cover;
  form.instructor = attrs.instructor;
  form.difficulty = attrs.difficulty;
  form.durationSec = attrs.duration;
  form.attachments = attrs.attachments.map((a) => ({ blobId: a.blobId, name: a.name }));
  form.bodyMd = type === 'lesson' ? attrs.bodyMd : '';
  form.children = childrenRowsOf(segs).map((r) => ({ kind: r.kind, itemId: r.text }));
  return form;
}

/**
 * 落一条容器投稿。新建与编辑同一条路径——`enqueueOrSend` 本身就是 upsert（本册 §4.1）：
 * 送达 → 台账 `sent`；断网 / 429 / 5xx → `pending` 待补发；其余 4xx → `failed`。
 * 三种结果都会留台账行（「我的条目」的列表本体）。
 */
export function saveContainer(o: SubmitOptions, form: ContainerForm): Promise<SubmitOutcome> {
  return enqueueOrSend(o, {
    itemId: form.itemId,
    type: form.type,
    title: form.title,
    bodyMd: '',
    questionJson: '',
    segments: buildContainerSegments(form),
  });
}
```

- [ ] **Step 4: 跑测试确认通过**

Run（cwd `apps/mobile`）: `npx vitest run src/core/course-edit.test.ts`
Expected: PASS（3 + 2 + 2 = 7 个用例全绿）。

- [ ] **Step 5: 类型门禁**

Run（cwd `apps/mobile`）: `npx tsc --noEmit`
Expected: 无输出。

- [ ] **Step 6: 提交**

```bash
git add apps/mobile/src/core/course-edit.ts apps/mobile/src/core/course-edit.test.ts
git commit -m "feat(mobile): 新增容器编辑编排（表单↔segments 行集，新建课程/课时 id 生成）"
```

---

### Task 12: `pages/course/edit.vue`（课程编辑页，含课时清单）

**Files:**
- Modify: `apps/mobile/src/platform/uni.ts`（新增 `PickedFile` + `pickLocalFile`，并在 `UniGlobal` 上加可选 `chooseFile`）
- Create: `apps/mobile/src/pages/course/edit.vue`
- Modify: `apps/mobile/src/pages.json`（注册 `pages/course/edit`）

- [ ] **Step 1: 平台层加「选文件」能力**

`platform/uni.ts` 的 `UniGlobal`（第 88-101 行）加一个可选方法——**不要**把 uni 类型全局铺开，只加这里用得到的一个：

```ts
interface UniGlobal {
  getStorageSync(key: string): string;
  setStorageSync(key: string, value: string): void;
  /** 选本地文件（封面 / 附件上传用，本册 §6）；App 端 3.4.0+ 提供 */
  chooseFile?(o: {
    count: number;
    success: (res: { tempFilePaths?: string[]; tempFiles?: Array<{ path?: string; name?: string }> }) => void;
    fail: (e: unknown) => void;
  }): void;
  request(o: {
    url: string;
    method: 'GET' | 'POST';
    header?: Record<string, string>;
    /** POST 用；arraybuffer 收发，不经过字符串编解码 */
    data?: ArrayBuffer;
    responseType: 'arraybuffer';
    success: (res: { statusCode: number; data: unknown }) => void;
    fail: (e: unknown) => void;
  }): void;
}
```

文件末尾（`toUint8` 之后）追加：

```ts
/** 一次「选文件」的结果：文件名 + 字节。 */
export interface PickedFile {
  name: string;
  bytes: Uint8Array;
}

/**
 * 选一个本地文件并读成字节（封面 / 附件上传，本册 §6）。
 * 读字节复用本层的 `PlusFs.readFile`（与附件下载落盘同一实现）。
 * **用户主动取消返回 null**——取消不是错误，页面据此静默返回。
 */
export async function pickLocalFile(): Promise<PickedFile | null> {
  const uni = uniGlobal();
  if (!uni.chooseFile) throw new Error('当前运行时不支持选择文件');
  const picked = await new Promise<{ path: string; name: string } | null>((resolve, reject) => {
    uni.chooseFile!({
      count: 1,
      success: (res) => {
        const f = res.tempFiles?.[0];
        const path = f?.path ?? res.tempFilePaths?.[0] ?? '';
        if (path === '') {
          resolve(null);
          return;
        }
        resolve({ path, name: f?.name ?? path.split('/').pop() ?? 'file' });
      },
      fail: (e) => {
        // 取消也走 fail；只有非取消的错误才该让页面看到
        const msg = JSON.stringify(e ?? '');
        if (msg.includes('cancel')) resolve(null);
        else reject(new Error(`选择文件失败：${msg}`));
      },
    });
  });
  if (!picked) return null;
  const bytes = await new PlusFs(assertAppRuntime()).readFile(picked.path);
  return { name: picked.name, bytes };
}
```

- [ ] **Step 2: 写课程编辑页**

创建 `apps/mobile/src/pages/course/edit.vue`：

```vue
<template>
  <view class="wrap">
    <text class="title">{{ isEdit ? '编辑课程' : '新建课程' }}</text>
    <text class="hint">条目 id：{{ form.itemId }}（不可改，它就是身份）</text>

    <view class="field">
      <text class="label">标题</text>
      <input v-model="form.title" class="input" placeholder="1–200 字" />
    </view>

    <view class="field">
      <text class="label">简介</text>
      <textarea v-model="form.digest" class="area-sm" placeholder="课程简介（可空）" />
    </view>

    <view class="field">
      <text class="label">封面</text>
      <view class="row">
        <text class="val">{{ form.cover === '' ? '未设置' : form.cover }}</text>
        <text class="act" @click="pickCover">{{ form.cover === '' ? '选择图片' : '更换' }}</text>
      </view>
    </view>

    <view class="field">
      <text class="label">讲师</text>
      <input v-model="form.instructor" class="input" placeholder="可空" />
    </view>

    <view class="field">
      <text class="label">难度</text>
      <view class="chips">
        <text
          v-for="d in DIFFICULTY_CHOICES"
          :key="d"
          class="chip"
          :class="form.difficulty === d ? 'chip-on' : ''"
          @click="toggleDifficulty(d)"
        >{{ difficultyLabel(d) }}</text>
      </view>
    </view>

    <view class="field">
      <text class="label">时长（分钟）</text>
      <input v-model="durationMin" class="input" type="number" placeholder="可空；保存时换算成秒" />
    </view>

    <view class="field">
      <text class="label">附件</text>
      <view v-for="(a, i) in form.attachments" :key="a.blobId" class="row">
        <text class="val">{{ a.name }}</text>
        <text class="del" @click="removeAttachment(i)">删除</text>
      </view>
      <text class="add" @click="addAttachment">+ 添加附件</text>
      <text class="hint">单文件 ≤ 8 MiB；内容寻址，同字节重复上传只存一份</text>
    </view>

    <view class="section">
      <view class="shead">
        <text class="label">课时清单</text>
        <text class="add" @click="addLesson">+ 加一课</text>
      </view>
      <text v-if="form.children.length === 0" class="hint">还没有课时；保存后本课程为空课时列表</text>
      <view v-for="(c, i) in form.children" :key="c.itemId" class="row">
        <view class="row-main" @click="openLesson(c)">
          <text class="val">第 {{ i + 1 }} 讲 · {{ lessonTitle(c.itemId) }}</text>
          <text class="sub">{{ c.itemId }}</text>
        </view>
        <text class="act" @click="move(i, -1)">上移</text>
        <text class="act" @click="move(i, 1)">下移</text>
        <text class="del" @click="removeChild(i)">删除</text>
      </view>
      <text class="hint">顺序即「第 N 讲」；空课时也会占位，不要靠删行来隐藏</text>
    </view>

    <text v-if="error" class="error">{{ error }}</text>
    <text v-if="notice" class="notice">{{ notice }}</text>

    <button class="submit" :disabled="busy" @click="submit">{{ busy ? '提交中…' : '保存' }}</button>
  </view>
</template>

<script setup lang="ts">
import { onLoad } from '@dcloudio/uni-app';
import { ref } from 'vue';

import { DIFFICULTY_ADVANCED, DIFFICULTY_BASIC, DIFFICULTY_CHOICES, DIFFICULTY_INTRO } from '../../core/attrs';
import { uploadBlob } from '../../core/blob';
import { loadContainerForm, saveContainer, startNewCourse, type ChildRow, type ContainerForm } from '../../core/course-edit';
import { newLessonID } from '../../core/submit';
import { bootstrap } from '../../platform';
import { pickLocalFile } from '../../platform/uni';

const form = ref<ContainerForm>(startNewCourse());
const durationMin = ref('');
const isEdit = ref(false);
const lessonTitles = ref<Record<string, string>>({});
const busy = ref(false);
const error = ref('');
const notice = ref('');

onLoad(async (query) => {
  const courseId = String((query as Record<string, string> | undefined)?.courseId ?? '');
  try {
    const { repo } = await bootstrap();
    if (courseId !== '') {
      isEdit.value = true;
      form.value = await loadContainerForm(repo, courseId, 'course');
      durationMin.value = form.value.durationSec > 0 ? String(Math.round(form.value.durationSec / 60)) : '';
    }
    lessonTitles.value = Object.fromEntries((await repo.listItems()).map((i) => [i.itemId, i.title || i.itemId]));
  } catch (e) {
    error.value = (e as Error).message;
  }
});

function difficultyLabel(d: string): string {
  if (d === DIFFICULTY_INTRO) return '入门';
  if (d === DIFFICULTY_BASIC) return '基础';
  return '进阶';
}

/** 再点一次取消选择（空串 = 不产该属性行） */
function toggleDifficulty(d: string) {
  form.value.difficulty = form.value.difficulty === d ? '' : d;
}

/** 选文件 → 上传拿 blob_id；取消返回 null。封面与附件共用一条上传路径。 */
async function uploadOne(): Promise<{ blobId: string; name: string } | null> {
  const picked = await pickLocalFile();
  if (!picked) return null;
  const { opts, repo } = await bootstrap();
  const blobId = await uploadBlob(
    { adapters: opts.adapters, repo, nodeBaseUrl: opts.nodeBaseUrl },
    picked.bytes,
    picked.name,
  );
  return { blobId, name: picked.name };
}

async function pickCover() {
  error.value = '';
  try {
    const up = await uploadOne();
    if (up) form.value.cover = up.blobId;
  } catch (e) {
    error.value = (e as Error).message;
  }
}

async function addAttachment() {
  error.value = '';
  try {
    const up = await uploadOne();
    // 内容寻址：同 blob 只留一行（重复上传同一文件不该出现两条附件行）
    if (up && !form.value.attachments.some((a) => a.blobId === up.blobId)) form.value.attachments.push(up);
  } catch (e) {
    error.value = (e as Error).message;
  }
}

function removeAttachment(i: number) {
  form.value.attachments.splice(i, 1);
}

/** 加一课：id 用当前课程 id 立刻拼出（课程 id 在页面打开时就固定了），随后跳课时编辑页 */
function addLesson() {
  const id = newLessonID(form.value.itemId);
  const row: ChildRow = { kind: 'lesson', itemId: id };
  form.value.children.push(row);
  openLesson(row);
}

function openLesson(c: ChildRow) {
  uni.navigateTo({
    url: `/pages/lesson/edit?courseId=${encodeURIComponent(form.value.itemId)}&lessonId=${encodeURIComponent(c.itemId)}`,
  });
}

function lessonTitle(itemId: string): string {
  return lessonTitles.value[itemId] ?? '（新课时，未保存）';
}

function move(i: number, d: number) {
  const j = i + d;
  const arr = form.value.children;
  if (j < 0 || j >= arr.length) return;
  const t = arr[i]!;
  arr[i] = arr[j]!;
  arr[j] = t;
}

function removeChild(i: number) {
  form.value.children.splice(i, 1);
}

/** 分钟输入 → 秒（槽位收秒数字符串，本册 §2.1）；非法一律归 0（= 不产该行） */
function durationSecOf(): number {
  const raw = durationMin.value.trim();
  if (raw === '') return 0;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.round(n * 60);
}

async function submit() {
  error.value = '';
  notice.value = '';
  const f = form.value;
  f.durationSec = durationSecOf();
  busy.value = true;
  try {
    const { opts, repo } = await bootstrap();
    const out = await saveContainer({ adapters: opts.adapters, repo, nodeBaseUrl: opts.nodeBaseUrl }, f);
    if (out.ledgerState === 'sent') {
      uni.showToast({ title: out.created ? '已创建' : '已更新', icon: 'success' });
      setTimeout(() => uni.navigateBack(), 600);
      return;
    }
    // pending 会自动补发；failed 需回「我的条目」删除后重投
    notice.value = out.message;
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    busy.value = false;
  }
}
</script>

<style>
.wrap { padding: 16px; }
.title { display: block; font-size: 20px; font-weight: 600; margin-bottom: 6px; }
.field { margin-bottom: 14px; }
.section { margin-top: 18px; padding-top: 12px; border-top: 1px solid #eeeeee; }
.shead { display: flex; justify-content: space-between; align-items: center; }
.label { display: block; font-size: 14px; color: #666666; margin-bottom: 6px; }
.hint { display: block; font-size: 12px; color: #999999; margin-top: 4px; }
.sub { display: block; font-size: 11px; color: #aaaaaa; }
.input { border: 1px solid #eeeeee; border-radius: 6px; padding: 8px; font-size: 14px; }
.area-sm { border: 1px solid #eeeeee; border-radius: 6px; padding: 8px; width: 100%; height: 90px; font-size: 14px; }
.chips { display: flex; flex-wrap: wrap; }
.chip { padding: 4px 14px; border: 1px solid #dddddd; border-radius: 14px; margin: 0 10px 6px 0; color: #666666; font-size: 13px; }
.chip-on { border-color: #2b6cb0; color: #2b6cb0; }
.row { display: flex; align-items: center; justify-content: space-between; padding: 8px 0; border-bottom: 1px solid #f5f5f5; }
.row-main { flex: 1; }
.val { flex: 1; font-size: 14px; color: #333333; }
.act { color: #2b6cb0; font-size: 13px; padding: 0 6px; }
.del { color: #c53030; font-size: 13px; padding: 0 6px; }
.add { display: block; color: #2b6cb0; font-size: 14px; padding: 6px 0; }
.error { display: block; color: #c53030; font-size: 13px; margin: 8px 0; }
.notice { display: block; color: #b7791f; font-size: 13px; margin: 8px 0; }
.submit { margin-top: 16px; background: #2b6cb0; color: #ffffff; }
</style>
```

- [ ] **Step 3: 注册页面**

`apps/mobile/src/pages.json` 的 `pages` 数组里，紧跟 `pages/course/detail` 之后插入两条（另一条 `pages/lesson/edit` 由 Task 13 加）：

```json
    {
      "path": "pages/course/edit",
      "style": { "navigationBarTitleText": "编辑课程" }
    },
```

- [ ] **Step 4: 门禁**

Run（cwd `apps/mobile`）: `npx tsc --noEmit && npm run build:h5`
Expected: tsc 无输出；`build:h5` 构建成功（页面模板与脚本编译通过）。

- [ ] **Step 5: 提交**

```bash
git add apps/mobile/src/platform/uni.ts apps/mobile/src/pages/course/edit.vue apps/mobile/src/pages.json
git commit -m "feat(mobile): 新增课程编辑页（字段 + 封面上传 + 课时清单增删排序）"
```

---

### Task 13: `pages/lesson/edit.vue`（课时编辑页，含载体清单与正文）

**Files:**
- Create: `apps/mobile/src/pages/lesson/edit.vue`
- Modify: `apps/mobile/src/pages.json`（注册 `pages/lesson/edit`）

- [ ] **Step 1: 写课时编辑页**

创建 `apps/mobile/src/pages/lesson/edit.vue`：

```vue
<template>
  <view class="wrap">
    <text class="title">编辑课时</text>
    <text class="hint">条目 id：{{ form.itemId }}（不可改，它就是身份）</text>
    <text class="hint">所属课程：{{ courseId }}</text>

    <view class="field">
      <text class="label">标题</text>
      <input v-model="form.title" class="input" placeholder="1–200 字" />
    </view>

    <view class="field">
      <text class="label">正文（Markdown）</text>
      <textarea v-model="form.bodyMd" class="area" placeholder="课时正文；留空则不显示正文块" />
      <text class="hint">正文以 Markdown 源文本保存（槽位 attr.body_md），与文章同口径</text>
    </view>

    <view class="field">
      <text class="label">摘要 / 简介</text>
      <textarea v-model="form.digest" class="area-sm" placeholder="可空；只影响列表摘要，不影响正文" />
    </view>

    <view class="field">
      <text class="label">封面</text>
      <view class="row">
        <text class="val">{{ form.cover === '' ? '未设置' : form.cover }}</text>
        <text class="act" @click="pickCover">{{ form.cover === '' ? '选择图片' : '更换' }}</text>
      </view>
    </view>

    <view class="field">
      <text class="label">讲师</text>
      <input v-model="form.instructor" class="input" placeholder="可空" />
    </view>

    <view class="field">
      <text class="label">难度</text>
      <view class="chips">
        <text
          v-for="d in DIFFICULTY_CHOICES"
          :key="d"
          class="chip"
          :class="form.difficulty === d ? 'chip-on' : ''"
          @click="toggleDifficulty(d)"
        >{{ difficultyLabel(d) }}</text>
      </view>
    </view>

    <view class="field">
      <text class="label">时长（分钟）</text>
      <input v-model="durationMin" class="input" type="number" placeholder="可空；保存时换算成秒" />
    </view>

    <view class="field">
      <text class="label">附件</text>
      <view v-for="(a, i) in form.attachments" :key="a.blobId" class="row">
        <text class="val">{{ a.name }}</text>
        <text class="del" @click="removeAttachment(i)">删除</text>
      </view>
      <text class="add" @click="addAttachment">+ 添加附件</text>
    </view>

    <view class="section">
      <view class="shead">
        <text class="label">载体清单</text>
        <text class="add" @click="addCarrier">+ 添加载体</text>
      </view>
      <text v-if="form.children.length === 0" class="hint">还没有载体；空课时也会在课程页占一行的位次</text>
      <view v-for="(c, i) in form.children" :key="i" class="card">
        <view class="chead">
          <text class="label">第 {{ i + 1 }} 项</text>
          <view>
            <text class="act" @click="move(i, -1)">上移</text>
            <text class="act" @click="move(i, 1)">下移</text>
            <text class="del" @click="removeChild(i)">删除</text>
          </view>
        </view>
        <view class="chips">
          <text
            v-for="k in CARRIER_KINDS"
            :key="k"
            class="chip"
            :class="c.kind === k ? 'chip-on' : ''"
            @click="c.kind = k"
          >{{ k }}</text>
        </view>
        <input v-model="c.itemId" class="input" placeholder="载体的 item_id，如 article/xxxx" />
      </view>
      <text class="hint">顺序即课时页里的展示顺序；kind 必须是 article / quiz / video / audio 之一</text>
    </view>

    <text v-if="error" class="error">{{ error }}</text>
    <text v-if="notice" class="notice">{{ notice }}</text>

    <button class="submit" :disabled="busy" @click="submit">{{ busy ? '提交中…' : '保存' }}</button>
  </view>
</template>

<script setup lang="ts">
import { onLoad } from '@dcloudio/uni-app';
import { ref } from 'vue';

import { DIFFICULTY_ADVANCED, DIFFICULTY_BASIC, DIFFICULTY_CHOICES, DIFFICULTY_INTRO } from '../../core/attrs';
import { uploadBlob } from '../../core/blob';
import { loadContainerForm, saveContainer, startNewLesson, type ChildRow, type ContainerForm } from '../../core/course-edit';
import { bootstrap } from '../../platform';
import { pickLocalFile } from '../../platform/uni';

/** 课时可挂的载体类型（本册 §2.4；audio 登记在册但播放能力待后续版本） */
const CARRIER_KINDS = ['article', 'quiz', 'video', 'audio'];

const courseId = ref('');
const form = ref<ContainerForm>(startNewLesson(''));
const durationMin = ref('');
const busy = ref(false);
const error = ref('');
const notice = ref('');

onLoad(async (query) => {
  const q = (query as Record<string, string> | undefined) ?? {};
  courseId.value = String(q.courseId ?? '');
  const lessonId = String(q.lessonId ?? '');
  try {
    const { repo } = await bootstrap();
    if (lessonId !== '') {
      form.value = await loadContainerForm(repo, lessonId, 'lesson');
      durationMin.value = form.value.durationSec > 0 ? String(Math.round(form.value.durationSec / 60)) : '';
    } else if (courseId.value !== '') {
      form.value = startNewLesson(courseId.value);
    } else {
      error.value = '缺少课程 id，无法定位课时';
    }
  } catch (e) {
    error.value = (e as Error).message;
  }
});

function difficultyLabel(d: string): string {
  if (d === DIFFICULTY_INTRO) return '入门';
  if (d === DIFFICULTY_BASIC) return '基础';
  return '进阶';
}

function toggleDifficulty(d: string) {
  form.value.difficulty = form.value.difficulty === d ? '' : d;
}

async function uploadOne(): Promise<{ blobId: string; name: string } | null> {
  const picked = await pickLocalFile();
  if (!picked) return null;
  const { opts, repo } = await bootstrap();
  const blobId = await uploadBlob(
    { adapters: opts.adapters, repo, nodeBaseUrl: opts.nodeBaseUrl },
    picked.bytes,
    picked.name,
  );
  return { blobId, name: picked.name };
}

async function pickCover() {
  error.value = '';
  try {
    const up = await uploadOne();
    if (up) form.value.cover = up.blobId;
  } catch (e) {
    error.value = (e as Error).message;
  }
}

async function addAttachment() {
  error.value = '';
  try {
    const up = await uploadOne();
    if (up && !form.value.attachments.some((a) => a.blobId === up.blobId)) form.value.attachments.push(up);
  } catch (e) {
    error.value = (e as Error).message;
  }
}

function removeAttachment(i: number) {
  form.value.attachments.splice(i, 1);
}

/** 新载体行的 item_id 允许先留空再填；空 id 在提交时会被拦下（不当成「静默丢弃」）。 */
function addCarrier() {
  const row: ChildRow = { kind: 'article', itemId: '' };
  form.value.children.push(row);
}

function move(i: number, d: number) {
  const j = i + d;
  const arr = form.value.children;
  if (j < 0 || j >= arr.length) return;
  const t = arr[i]!;
  arr[i] = arr[j]!;
  arr[j] = t;
}

function removeChild(i: number) {
  form.value.children.splice(i, 1);
}

function durationSecOf(): number {
  const raw = durationMin.value.trim();
  if (raw === '') return 0;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.round(n * 60);
}

async function submit() {
  error.value = '';
  notice.value = '';
  const f = form.value;
  const blank = f.children.findIndex((c) => c.itemId.trim() === '');
  if (blank >= 0) {
    error.value = `第 ${blank + 1} 个载体的 item_id 不能为空（不需要就删掉这行）`;
    return;
  }
  f.durationSec = durationSecOf();
  busy.value = true;
  try {
    const { opts, repo } = await bootstrap();
    const out = await saveContainer({ adapters: opts.adapters, repo, nodeBaseUrl: opts.nodeBaseUrl }, f);
    if (out.ledgerState === 'sent') {
      uni.showToast({ title: out.created ? '已创建' : '已更新', icon: 'success' });
      setTimeout(() => uni.navigateBack(), 600);
      return;
    }
    notice.value = out.message;
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    busy.value = false;
  }
}
</script>

<style>
.wrap { padding: 16px; }
.title { display: block; font-size: 20px; font-weight: 600; margin-bottom: 6px; }
.field { margin-bottom: 14px; }
.section { margin-top: 18px; padding-top: 12px; border-top: 1px solid #eeeeee; }
.shead { display: flex; justify-content: space-between; align-items: center; }
.label { display: block; font-size: 14px; color: #666666; margin-bottom: 6px; }
.hint { display: block; font-size: 12px; color: #999999; margin-top: 4px; }
.input { border: 1px solid #eeeeee; border-radius: 6px; padding: 8px; font-size: 14px; }
.area { border: 1px solid #eeeeee; border-radius: 6px; padding: 8px; width: 100%; height: 220px; font-size: 14px; }
.area-sm { border: 1px solid #eeeeee; border-radius: 6px; padding: 8px; width: 100%; height: 80px; font-size: 14px; }
.chips { display: flex; flex-wrap: wrap; }
.chip { padding: 4px 14px; border: 1px solid #dddddd; border-radius: 14px; margin: 0 10px 6px 0; color: #666666; font-size: 13px; }
.chip-on { border-color: #2b6cb0; color: #2b6cb0; }
.card { border: 1px solid #eeeeee; border-radius: 8px; padding: 10px; margin-bottom: 12px; }
.chead { display: flex; justify-content: space-between; align-items: center; }
.row { display: flex; align-items: center; justify-content: space-between; padding: 8px 0; border-bottom: 1px solid #f5f5f5; }
.val { flex: 1; font-size: 14px; color: #333333; }
.act { color: #2b6cb0; font-size: 13px; padding: 0 6px; }
.del { color: #c53030; font-size: 13px; padding: 0 6px; }
.add { display: block; color: #2b6cb0; font-size: 14px; padding: 6px 0; }
.error { display: block; color: #c53030; font-size: 13px; margin: 8px 0; }
.notice { display: block; color: #b7791f; font-size: 13px; margin: 8px 0; }
.submit { margin-top: 16px; background: #2b6cb0; color: #ffffff; }
</style>
```

- [ ] **Step 2: 注册页面**

`apps/mobile/src/pages.json` 的 `pages` 数组里，紧跟 `pages/course/edit` 之后插入：

```json
    {
      "path": "pages/lesson/edit",
      "style": { "navigationBarTitleText": "编辑课时" }
    },
```

- [ ] **Step 3: 门禁**

Run（cwd `apps/mobile`）: `npx tsc --noEmit && npm run build:h5`
Expected: tsc 无输出；`build:h5` 构建成功。

- [ ] **Step 4: 提交**

```bash
git add apps/mobile/src/pages/lesson/edit.vue apps/mobile/src/pages.json
git commit -m "feat(mobile): 新增课时编辑页（正文 Markdown + 载体清单 + 附件）"
```

---

### Task 14: 课时页（新增）与课程页改版

**Files:**
- Create: `apps/mobile/src/pages/lesson/detail.vue`
- Modify: `apps/mobile/src/pages/course/detail.vue`（整页重写，下线手风琴与测验汇总块）
- Modify: `apps/mobile/src/pages/course/course.vue`（列表页加「新建课程」入口）
- Modify: `apps/mobile/src/pages.json`（注册 `pages/lesson/detail`）

- [ ] **Step 1: 写课时页（方案 A）**

创建 `apps/mobile/src/pages/lesson/detail.vue`：

```vue
<template>
  <view class="wrap">
    <text v-if="error" class="error">{{ error }}</text>
    <block v-else>
      <text v-if="!loaded" class="hint">加载中…</text>
      <block v-else>
        <image v-if="coverPath" :src="coverPath" mode="widthFix" class="cover" />
        <text class="title">{{ lessonLabel }}</text>
        <text class="meta">{{ metaLine }}</text>
        <view class="tags">
          <text v-for="t in selfTags" :key="t.tagId" class="tag" @click="openTag(t.tagId)">{{ tagLabel(t.tagId) }}</text>
          <text v-if="pendingOf(lessonId)" class="tag-pending" @click="applyTag">待补标签 · 补标签</text>
          <text v-else-if="selfTags.length > 0" class="tag-note" @click="proposeTag">已有标签，改动需提案</text>
        </view>
        <text v-if="canEdit" class="act" @click="openEdit">编辑本课时</text>

        <!-- 正文：缺失整块不渲染（老包无 attr.body_md），不显示空块 -->
        <block v-if="paragraphs.length > 0">
          <text class="group">正文</text>
          <text v-for="(p, i) in paragraphs" :key="i" class="para">{{ p }}</text>
        </block>

        <text class="group">载体（{{ carriers.length }}）</text>
        <text v-if="carriers.length === 0" class="hint">这个课时还没有载体</text>
        <view v-for="c in carriers" :key="c.itemId" class="carrier" @click="openCarrier(c)">
          <text class="carrier-title">{{ c.title }}</text>
          <text class="meta">{{ c.type }} · {{ c.itemId }}</text>
        </view>

        <block v-if="attachments.length > 0">
          <text class="group">附件（{{ attachments.length }}）</text>
          <view v-for="a in attachments" :key="a.blobId" class="attach" @click="openAttachment(a)">
            <text class="carrier-title">{{ a.name }}</text>
          </view>
        </block>
      </block>
    </block>
  </view>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import { onLoad } from '@dcloudio/uni-app';

import { fetchBlob } from '../../core/blob';
import { attrsOf, childrenRowsOf, type AttachmentVM } from '../../core/container-view';
import { lessonNo } from '../../core/course-tree';
import { canGovern, tagsOf, untaggedTargets } from '../../core/tags';
import type { TagLinkRow } from '../../core/types';
import { bootstrap } from '../../platform';

interface CarrierVM {
  itemId: string;
  type: string;
  title: string;
}

const lessonId = ref('');
const courseId = ref('');
const lessonLabel = ref('');
const metaLine = ref('');
const paragraphs = ref<string[]>([]);
const carriers = ref<CarrierVM[]>([]);
const attachments = ref<AttachmentVM[]>([]);
const coverPath = ref('');
const selfTags = ref<TagLinkRow[]>([]);
const tagTitles = ref<Record<string, string>>({});
const untagged = ref<Set<string>>(new Set());
const governor = ref(false);
const loaded = ref(false);
const canEdit = ref(false);
const error = ref('');

onLoad(async (query) => {
  const q = (query as Record<string, string> | undefined) ?? {};
  const raw = String(q.lessonId ?? '');
  const cid = String(q.courseId ?? '');
  lessonId.value = raw;
  try {
    const { opts, repo } = await bootstrap();
    const lid = wait(raw);
    const row = await repo.getItem(lid);
    const segs = await repo.listSegments(lid);
    const attrs = attrsOf(segs);

    // 课程 id：优先取传参；没有就从 `course/<cid>/lesson/<lid>` 剥出来（保证课时页条目自洽）
    const mid = lid.indexOf('/lesson/');
    courseId.value = cid !== '' ? cid : mid > 0 ? lid.slice(0, mid) : '';

    // 「第 N 讲」口径与课程页同源：拿课程清单算出位次（拿不到课程就不显示位次）
    let no = 0;
    if (courseId.value !== '') {
      try {
        no = lessonNo(await repo.listSegments(courseId.value), lid);
      } catch {
        no = 0;
      }
    }
    const title = row?.title || lid;
    lessonLabel.value = no > 0 ? `第 ${no} 讲 · ${title}` : title;

    const meta: string[] = [];
    if (attrs.instructor !== '') meta.push(`讲师 ${attrs.instructor}`);
    if (attrs.difficulty !== '') meta.push(`难度 ${difficultyLabel(attrs.difficulty)}`);
    if (attrs.duration > 0) meta.push(`约 ${Math.round(attrs.duration / 60)} 分钟`);
    metaLine.value = meta.join(' · ');

    paragraphs.value = attrs.bodyMd
      .replace(/\r\n/g, '\n')
      .split('\n\n')
      .map((s) => s.trim())
      .filter((s) => s !== '');

    const rows = childrenRowsOf(segs);
    const built: CarrierVM[] = [];
    for (const r of rows) {
      const c = await repo.getItem(r.text);
      built.push({ itemId: r.text, type: c?.type || r.kind, title: c?.title || r.text });
    }
    carriers.value = built;
    attachments.value = attrs.attachments;

    const path = await repo.findBlobPathByItem(`${lid}/cover`);
    coverPath.value = path ? (path.startsWith('file://') ? path : `file://${path}`) : '';

    const links = await repo.listTagLinks();
    const all = await repo.listItems();
    untagged.value = new Set(untaggedTargets(all, links));
    tagTitles.value = Object.fromEntries(all.filter((i) => i.type === 'tag').map((i) => [i.itemId, i.title || i.itemId]));
    selfTags.value = tagsOf(links, lid);
    governor.value = await canGovern({ adapters: opts.adapters, repo, nodeBaseUrl: opts.nodeBaseUrl });
    // 编辑入口的可见性：包内 items 不含 author_id，用本地台账代理（state='sent' 才算「我建的」）
    canEdit.value = (await repo.getSubmission(lid))?.state === 'sent';
    loaded.value = true;
  } catch (e) {
    error.value = (e as Error).message;
  }
});

/** 个别机型会把 id 的百分号编码原样带过来 */
function wait(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

function difficultyLabel(d: string): string {
  return d === 'intro' ? '入门' : d === 'basic' ? '基础' : d === 'advanced' ? '进阶' : d;
}

function tagLabel(tagId: string): string {
  return tagTitles.value[tagId] ?? tagId;
}

function pendingOf(id: string): boolean {
  return governor.value && untagged.value.has(id);
}

function openTag(tagId: string) {
  uni.navigateTo({ url: `/pages/tag/detail?tagId=${encodeURIComponent(tagId)}` });
}

function applyTag() {
  uni.navigateTo({ url: `/pages/tag/apply?target=${encodeURIComponent(lessonId.value)}&kind=lesson` });
}

function proposeTag() {
  uni.navigateTo({ url: `/pages/governance/governance?itemId=${encodeURIComponent(selfTags.value[0]!.tagId)}` });
}

function openEdit() {
  uni.navigateTo({
    url: `/pages/lesson/edit?courseId=${encodeURIComponent(courseId.value)}&lessonId=${encodeURIComponent(lessonId.value)}`,
  });
}

function openCarrier(c: CarrierVM) {
  if (c.type === 'article') {
    uni.navigateTo({ url: `/pages/article/article?itemId=${encodeURIComponent(c.itemId)}` });
    return;
  }
  if (c.type === 'quiz') {
    uni.navigateTo({ url: `/pages/quiz/quiz?itemId=${encodeURIComponent(c.itemId)}` });
    return;
  }
  if (c.type === 'video' || c.type === 'audio') {
    uni.showToast({ title: `${c.type} 播放待后续版本`, icon: 'none' });
    return;
  }
  uni.showToast({ title: '暂不支持的类型', icon: 'none' });
}

/** 附件按需取回：下载字节 → 落本地文件 → 交给系统打开 */
async function openAttachment(a: AttachmentVM) {
  error.value = '';
  try {
    const { opts, repo } = await bootstrap();
    const bytes = await fetchBlob({ adapters: opts.adapters, repo, nodeBaseUrl: opts.nodeBaseUrl }, a.blobId);
    const root = await opts.adapters.fs.rootDir();
    const path = `${root}/${a.blobId}-${a.name}`;
    await opts.adapters.fs.writeFile(path, bytes);
    uni.openDocument({
      filePath: path,
      showMenu: true,
      fail: () => uni.showToast({ title: '系统不支持打开该类型', icon: 'none' }),
    });
  } catch (e) {
    error.value = (e as Error).message;
  }
}
</script>

<style>
.wrap { padding: 16px; }
.title { display: block; font-size: 20px; font-weight: 600; margin-bottom: 4px; }
.meta { display: block; color: #888888; font-size: 12px; }
.cover { width: 100%; margin-bottom: 12px; border-radius: 6px; }
.para { display: block; font-size: 15px; line-height: 1.7; margin-bottom: 10px; }
.carrier { padding: 10px 0; border-bottom: 1px solid #f2f2f2; }
.carrier-title { color: #2b6cb0; font-size: 15px; }
.attach { padding: 8px 0; }
.hint { color: #888888; }
.error { color: #c53030; font-size: 13px; }
.group { display: block; margin: 18px 0 6px; color: #888888; font-size: 13px; }
.act { display: block; color: #2b6cb0; font-size: 14px; padding: 6px 0; }
.tags { display: flex; flex-wrap: wrap; align-items: center; margin: 6px 0 10px; }
.tag { padding: 2px 8px; margin: 0 8px 6px 0; background: #ebf8ff; color: #2b6cb0; border-radius: 10px; font-size: 12px; }
.tag-pending { padding: 2px 8px; margin: 0 8px 6px 0; background: #fffaf0; color: #b7791f; border-radius: 10px; font-size: 12px; }
.tag-note { margin: 0 0 6px; color: #888888; font-size: 12px; }
</style>
```

- [ ] **Step 2: 重写课程页（课时清单）**

把 `apps/mobile/src/pages/course/detail.vue` **整文件替换**为：

```vue
<template>
  <view class="wrap">
    <text v-if="error" class="error">{{ error }}</text>
    <block v-else>
      <text v-if="!loaded" class="hint">加载中…</text>
      <block v-else>
        <image v-if="coverPath" :src="coverPath" mode="widthFix" class="cover" />
        <text class="title">{{ courseTitle }}</text>
        <text v-if="digest !== ''" class="digest">{{ digest }}</text>
        <text v-if="metaLine !== ''" class="meta">{{ metaLine }}</text>
        <view class="tags">
          <text v-for="t in courseTags" :key="t.tagId" class="tag" @click="openTag(t.tagId)">{{ tagLabel(t.tagId) }}</text>
          <text v-if="pendingOf(courseId)" class="tag-pending" @click="applyTag(courseId, 'course')">待补标签 · 补标签</text>
          <text v-else-if="courseTags.length > 0" class="tag-note" @click="proposeTag(courseTags[0]!.tagId)">已有标签，改动需提案</text>
        </view>
        <text v-if="canEdit" class="act" @click="openEdit">编辑本课程</text>

        <block v-if="attachments.length > 0">
          <text class="group">附件（{{ attachments.length }}）</text>
          <view v-for="a in attachments" :key="a.blobId" class="attach" @click="openAttachment(a)">
            <text class="attach-name">{{ a.name }}</text>
          </view>
        </block>

        <text class="group">课时（{{ lessons.length }}）</text>
        <text v-if="lessons.length === 0" class="hint">这门课程还没有课时</text>
        <view v-for="ls in lessons" :key="ls.itemId" class="lesson" @click="openLesson(ls)">
          <text class="lesson-title">第 {{ ls.no }} 讲 · {{ ls.title }}</text>
          <text class="meta">{{ ls.sub }}</text>
          <view class="tags">
            <text v-for="t in ls.tags" :key="t.tagId" class="tag" @click.stop="openTag(t.tagId)">{{ tagLabel(t.tagId) }}</text>
            <text v-if="pendingOf(ls.itemId)" class="tag-pending" @click.stop="applyTag(ls.itemId, 'lesson')">待补标签 · 补标签</text>
          </view>
        </view>
      </block>
    </block>
  </view>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import { onLoad } from '@dcloudio/uni-app';

import { fetchBlob } from '../../core/blob';
import { attrsOf, childCounts, childrenRowsOf, digestOf, type AttachmentVM } from '../../core/container-view';
import { lessonNo } from '../../core/course-tree';
import { canGovern, tagsOf, untaggedTargets } from '../../core/tags';
import type { TagLinkRow } from '../../core/types';
import { bootstrap } from '../../platform';

interface LessonVM {
  itemId: string;
  no: number;
  title: string;
  /** 徽标行：类型计数 / 附件 / 时长，或「空课时」「未同步」 */
  sub: string;
  tags: TagLinkRow[];
}

const courseId = ref('');
const courseTitle = ref('');
const digest = ref('');
const metaLine = ref('');
const coverPath = ref('');
const attachments = ref<AttachmentVM[]>([]);
const lessons = ref<LessonVM[]>([]);
const courseTags = ref<TagLinkRow[]>([]);
const tagTitles = ref<Record<string, string>>({});
const untagged = ref<Set<string>>(new Set());
const governor = ref(false);
const loaded = ref(false);
const canEdit = ref(false);
const error = ref('');

const KIND_LABEL: Record<string, string> = { article: '文章', quiz: '测验', video: '视频', audio: '音频' };

onLoad(async (query) => {
  const raw = String((query as Record<string, string> | undefined)?.courseId ?? '');
  try {
    const { opts, repo } = await bootstrap();
    const cid = decodedId(raw);
    const course = (await repo.getItem(raw)) ?? (cid === raw ? null : await repo.getItem(cid));
    if (!course) {
      error.value = '本地没有这门课程，请返回先同步';
      return;
    }
    courseId.value = course.itemId;
    courseTitle.value = course.title || course.itemId;

    const segs = await repo.listSegments(course.itemId);
    const attrs = attrsOf(segs);
    digest.value = digestOf(segs);
    attachments.value = attrs.attachments;

    const meta: string[] = [];
    if (attrs.instructor !== '') meta.push(`讲师 ${attrs.instructor}`);
    if (attrs.difficulty !== '') meta.push(`难度 ${difficultyLabel(attrs.difficulty)}`);
    if (attrs.duration > 0) meta.push(`共约 ${Math.round(attrs.duration / 60)} 分钟`);
    metaLine.value = meta.join(' · ');

    const path = await repo.findBlobPathByItem(`${course.itemId}/cover`);
    coverPath.value = path ? (path.startsWith('file://') ? path : `file://${path}`) : '';

    const rows = childrenRowsOf(segs);
    const links = await repo.listTagLinks();
    const acc: LessonVM[] = [];
    for (let i = 0; i < rows.length; i++) {
      const lid = rows[i]!.text;
      const lrow = await repo.getItem(lid);
      const lsegs = await repo.listSegments(lid);
      const counts = childCounts(lsegs);
      const lattrs = attrsOf(lsegs);
      const parts: string[] = [];
      for (const k of ['article', 'quiz', 'video', 'audio']) {
        const n = counts[k] ?? 0;
        if (n > 0) parts.push(`${KIND_LABEL[k]} ${n}`);
      }
      if (lattrs.attachments.length > 0) parts.push(`附件 ${lattrs.attachments.length}`);
      if (lattrs.duration > 0) parts.push(`约 ${Math.round(lattrs.duration / 60)} 分钟`);
      // 位次由 seq 决定：空课时与未同步都照占一行，不吃掉后面课时的序号
      const sub = !lrow ? '本地未同步（点开按 id 直接查）' : parts.length === 0 ? '空课时' : parts.join(' · ');
      acc.push({
        itemId: lid,
        no: lessonNo(segs, lid) || i + 1,
        title: lrow?.title || lid,
        sub,
        tags: tagsOf(links, lid),
      });
    }
    lessons.value = acc;

    const all = await repo.listItems();
    untagged.value = new Set(untaggedTargets(all, links));
    tagTitles.value = Object.fromEntries(all.filter((i) => i.type === 'tag').map((i) => [i.itemId, i.title || i.itemId]));
    courseTags.value = tagsOf(links, course.itemId);
    governor.value = await canGovern({ adapters: opts.adapters, repo, nodeBaseUrl: opts.nodeBaseUrl });
    canEdit.value = (await repo.getSubmission(course.itemId))?.state === 'sent';
    loaded.value = true;
  } catch (e) {
    error.value = (e as Error).message;
  }
});

function decodedId(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

function difficultyLabel(d: string): string {
  return d === 'intro' ? '入门' : d === 'basic' ? '基础' : d === 'advanced' ? '进阶' : d;
}

function tagLabel(tagId: string): string {
  return tagTitles.value[tagId] ?? tagId;
}

function pendingOf(id: string): boolean {
  return governor.value && untagged.value.has(id);
}

function openLesson(ls: LessonVM) {
  uni.navigateTo({
    url: `/pages/lesson/detail?courseId=${encodeURIComponent(courseId.value)}&lessonId=${encodeURIComponent(ls.itemId)}`,
  });
}

function openEdit() {
  uni.navigateTo({ url: `/pages/course/edit?courseId=${encodeURIComponent(courseId.value)}` });
}

function openTag(tagId: string) {
  uni.navigateTo({ url: `/pages/tag/detail?tagId=${encodeURIComponent(tagId)}` });
}

function applyTag(targetId: string, kind: string) {
  uni.navigateTo({ url: `/pages/tag/apply?target=${encodeURIComponent(targetId)}&kind=${kind}` });
}

function proposeTag(tagId: string) {
  uni.navigateTo({ url: `/pages/governance/governance?itemId=${encodeURIComponent(tagId)}` });
}

/** 附件按需取回：下载字节 → 落本地文件 → 交给系统打开（附件块不在 blob_index，不能按 item 查路径） */
async function openAttachment(a: AttachmentVM) {
  error.value = '';
  try {
    const { opts, repo } = await bootstrap();
    const bytes = await fetchBlob({ adapters: opts.adapters, repo, nodeBaseUrl: opts.nodeBaseUrl }, a.blobId);
    const root = await opts.adapters.fs.rootDir();
    const path = `${root}/${a.blobId}-${a.name}`;
    await opts.adapters.fs.writeFile(path, bytes);
    uni.openDocument({
      filePath: path,
      showMenu: true,
      fail: () => uni.showToast({ title: '系统不支持打开该类型', icon: 'none' }),
    });
  } catch (e) {
    error.value = (e as Error).message;
  }
}
</script>

<style>
.wrap { padding: 16px; }
.title { display: block; font-size: 20px; font-weight: 600; margin-bottom: 6px; }
.digest { display: block; color: #555555; font-size: 14px; line-height: 1.6; margin-bottom: 8px; }
.meta { display: block; color: #888888; font-size: 12px; }
.cover { width: 100%; margin-bottom: 12px; border-radius: 6px; }
.lesson { padding: 12px 0; border-bottom: 1px solid #eeeeee; }
.lesson-title { font-size: 17px; }
.attach { padding: 8px 0; }
.attach-name { color: #2b6cb0; font-size: 14px; }
.hint { color: #888888; }
.error { color: #c53030; font-size: 13px; }
.group { display: block; margin: 18px 0 6px; color: #888888; font-size: 13px; }
.act { display: block; color: #2b6cb0; font-size: 14px; padding: 4px 0 8px; }
.tags { display: flex; flex-wrap: wrap; align-items: center; margin: 4px 0 6px; }
.tag { padding: 2px 8px; margin: 0 8px 6px 0; background: #ebf8ff; color: #2b6cb0; border-radius: 10px; font-size: 12px; }
.tag-pending { padding: 2px 8px; margin: 0 8px 6px 0; background: #fffaf0; color: #b7791f; border-radius: 10px; font-size: 12px; }
.tag-note { margin: 0 0 6px; color: #888888; font-size: 12px; }
</style>
```

> 注意：重写后 `expanded` / `quizGroups` / `onLesson` / `openCarrier` / `openQuiz` 全部消失——「本课程测验（N 组）」汇总块与手风琴是**刻意下线**的（本册 §5.1）。本文件**不导入** `uploadBlob` / `pickLocalFile`（只读页，不做上传），多余的 import 会被 `tsc` 判为未使用而报错。

- [ ] **Step 3: 课程列表页加「新建课程」入口**

`apps/mobile/src/pages/course/course.vue` 的 `bar` 里，在「同步」按钮前加一个：

```html
      <button size="mini" @click="createCourse">新建课程</button>
```

脚本里加：

```ts
function createCourse() {
  uni.navigateTo({ url: '/pages/course/edit' });
}
```

- [ ] **Step 4: 注册课时页**

`apps/mobile/src/pages.json` 的 `pages` 数组里，紧跟 `pages/course/edit` 之后插入：

```json
    {
      "path": "pages/lesson/detail",
      "style": { "navigationBarTitleText": "课时" }
    },
```

- [ ] **Step 5: 门禁**

Run（cwd `apps/mobile`）: `npx tsc --noEmit && npm run build:h5`
Expected: tsc 无输出；`build:h5` 构建成功。

- [ ] **Step 6: 提交**

```bash
git add apps/mobile/src/pages/lesson/detail.vue apps/mobile/src/pages/course/detail.vue apps/mobile/src/pages/course/course.vue apps/mobile/src/pages.json
git commit -m "feat(mobile): 新增课时页（正文/载体/附件/标签），课程页改为课时清单并下线手风琴"
```

---

### Task 15: 版本 · 全量门禁 · 发布 · 文档回填

**Files:**
- Modify: `apps/mobile/src/manifest.json:5-6`（版本 `0.15.0` / `20`）
- Modify: `docs/README.md`（#40 行状态、新增 #41 行、§5 当前阶段）
- Modify: `docs/superpowers/specs/2026-09-30-base-course-lesson-edit-design.md`（§0 改版说明追加执行期更正）

- [ ] **Step 1: 落版本号**

`apps/mobile/src/manifest.json` 第 5-6 行（基线 `0.14.0` / `19`，本册整体 +1）：

```json
    "versionName" : "0.15.0",
    "versionCode" : "20",
```

- [ ] **Step 2: 全量门禁**

Run（仓库根）: `go build ./... && go vet ./... && go test ./...`
Expected: 全包 ok（无 FAIL）。

Run（cwd `apps/mobile`）: `npx vitest run && npx tsc --noEmit && npm run build:h5`
Expected: vitest 全绿（基线 178 项 + 本册新增：`attrs` / `container-view` / `blob` / `submit` 容器用例 / `course-edit`），`tsc` 无输出，`build:h5` 构建成功。

Run（仓库根，发布前页面硬检查，源自 #31 更正 14 的教训）: `grep -nE '="[^"]*\.value|\{\{[^}]*\.value' apps/mobile/src/pages/*/*.vue`
Expected: **无输出**（模板里手写 `.value` 会在 app-vue inline 编译下双层解包 ⇒ 整页渲染中断）。

- [ ] **Step 3: 节点二进制部署**

```bash
GOOS=linux GOARCH=amd64 go build -o based-linux-amd64 ./cmd/based
scp based-linux-amd64 root@<节点主机>:/opt/base/based
ssh root@<节点主机> "systemctl restart base && systemctl restart base-cache && systemctl is-active base base-cache"
```

Expected: 两个单元均 `active`；`/opt/base/based` 远端 sha256 与本地 HEAD 构建逐字一致。探活（只读，不改数据）：

```bash
curl -s -o /dev/null -w '%{http_code}\n' http://<节点主机>/v1/comment          # 200
curl -s -o /dev/null -w '%{http_code}\n' http://<节点主机>/v1/proposal         # 200
curl -s -X POST http://<节点主机>/v1/blob                                      # 400（bad_multipart，证明新路由已上线）
```

- [ ] **Step 4: 发布四步（与 0.5.0–0.14.0 同口径）**

1. HBuilderX 云打包 `0.15.0`（`versionName 0.15.0` / `versionCode 20`），记录 APK 字节数与 sha256、证书 SHA1（应与 0.6.0–0.14.0 一致，保证可覆盖安装）。
2. 上传到 `/opt/appdl/base-0.15.0.apk`，核对远端 sha256 与本地逐字一致。
3. 落地页整页重写，把所有 `base-0.14.0.apk` 改指 `base-0.15.0.apk`，版本号文案同步。
4. `based release` 签发，落 `/opt/base-cache/data/release.json`；核对无游离副本。

**验收命令**：

```bash
curl -s http://<节点主机>/v1/release                 # version=0.15.0
curl -sI http://<节点主机>/dl/base-0.15.0.apk         # 200
```

- [ ] **Step 5: 文档回填**

1) `docs/README.md` 第 66 行（`#40` 行）末列改为已实施口径，形如：

```
已定稿（上游回填已同步：总纲 §0.9 + §7.3、#14 §0.4 + §3.1、#25 §0.3；**实施计划 #41 已执行**，完整度见计划「执行实况」；`0.15.0`/`20` 已发布上线；真机验收待人工）
```

2) `docs/README.md` 清单里紧随 `#40` 之后新增一行：

```
| 41 | `plans/2026-09-30-base-course-lesson-edit-plan.md` | A 主线第 3 册实施计划（Task 1–15：`protocol.AssignAttrSeqs` 与双端契约向量、`store.UpsertSegmentSubmission`、`POST /v1/submit` 的 `course|lesson` 容器分支与三区间校验、`POST /v1/blob`、三处重建路径保留 `seq<0`、导入器跳过投稿域容器并产 warning、手机端 `core/attrs.ts` / `core/container-view.ts` / `core/blob.ts` / `course-edit.ts` / `submit.ts` 扩容器、课程编辑页 / 课时编辑页 / 课时页、课程页改纯清单、版本 `0.15.0`） | 见册子 #40 的「不做」表 | 册子 #40 | 已执行（完整度见本计划「执行实况」；`0.15.0`/`20` 已发布上线；真机验收待人工） |
```

3) `docs/README.md` §5「当前阶段」的「已完成」段追加本册落地说明，「待人工」段追加本册真机验收清单（课程新建 → 加两课 → 编辑课时正文 → 课程页看清单与「第 N 讲」→ 点进课时页看正文/载体/附件 → 断网保存后联网自动补发仅一条 → 编辑入口只在本人建的容器上可见）。

4) 册子 `docs/superpowers/specs/2026-09-30-base-course-lesson-edit-design.md` 的 `## 0. 改版说明` 下追加本次执行期发现（**有几条写几条，没有就只写一条「无更正」**）。

- [ ] **Step 6: 提交**

```bash
git add apps/mobile/src/manifest.json docs/README.md docs/superpowers/specs/2026-09-30-base-course-lesson-edit-design.md
git commit -m "chore(release): 课程与课时编辑落 0.15.0/20 并回填文档"
```

---

## 自检清单

- [ ] **spec 覆盖**：本册 §2.1 槽位 → Task 1/7；§2.2 课时不写 digest → Task 7/8/11；§2.3 两个容器形态 → Task 3/10；§2.4 `audio` 登记 → Task 13/14；§3 上传面 → Task 4/9；§4.1 写路径 → Task 2/10/11；§4.2 三处保留 `seq<0` → Task 5；§4.3 导入器跳过 → Task 6；§5.1 课程页 → Task 14；§5.2 课时页 → Task 14；§6 编辑面 → Task 12/13；§7 兼容 → Task 3/5/6/10；§9 AC → Task 15 Step 2 与执行实况；§10 版本 → Task 15 Step 1；§11 文档回填 → Task 15 Step 5。
- [ ] **占位符扫描**：全文无 `TODO` / `FIXME` / `xxx` / `待补`（`<节点主机>` 是部署命令的环境变量占位，属既定口径）。
- [ ] **类型一致性**：`SubmitSegmentRow`（attrs.ts）＝ `SubmitDraft.segments` 元素 ＝ `buildContainerSegments` 返回元素 ＝ `decodeLedgerSegments` 返回元素；`ContainerForm.children` 元素 `{kind, itemId}` 与 `SubmitSegmentRow` 的 `{kind, text}` 在 Task 11 显式映射；`AttachmentVM`（container-view）与 `AttachmentRow`（course-edit）结构同形。
- [ ] **目录不变式**：`core/*.ts` 不得 import `'uni'` / `'plus'`（Task 7–11 全部只依赖注入的 `Adapters` / `LocalRepo`），平台能力一律经 `platform/`（Task 12 的 `pickLocalFile` 落在 `platform/uni.ts`）。

## 执行实况

执行方式：**子代理驱动**（每个 Task 一个全新子代理，Task 间由主线做核对复查；Task 1–14 结束即 commit + push，节点部署与发布集中在 Task 15）。基线 `0.14.0` / `19`，本册整体 +1 = `0.15.0` / `20`。

### 1. 提交清单（全部已 push 到 `master`）

| 步骤 | commit | 内容 |
| --- | --- | --- |
| 立稿 | `65f33c2` | 本计划落库；并把册子 §10 的 `versionCode` 由 18 更正为 20 |
| Task 1 | `1b9988b` | `protocol/attrs.go` + `attrs_vector_test.go` + `vectors/v1/attrs.json` |
| Task 2 | `b3a99d7` | `store/submission.go` 的 `SegmentSubmission` + `UpsertSegmentSubmission` |
| Task 3 | `e277e5b` | `/v1/submit` 扩 `course\|lesson` 容器分支与三区间校验；补 `item_segments_invalid` 文案 |
| Task 4 | `1746907` | `httpapi/blob.go` 的 `POST /v1/blob`；`authenticate` 体上限参数化 + `requireAuthLimit` |
| Task 5 | `41d0cdb` | 三处重建路径保留 `seq<0` 属性行（`importer` 两处 + `store/tag.go` 一处） |
| Task 6 | `ef58105` | 导入器跳过投稿域容器并产 warning（`Result.Warnings` / `VideoResult.Warnings`） |
| Task 7 | `34aece0` | `core/attrs.ts`（共读契约向量）+ `tsconfig` 补 `node` types |
| Task 8 | `66f1a88` | `core/container-view.ts` + 单测 |
| Task 9 | `e633fe5` | `core/blob.ts`（multipart 拼装 + 上传/取回）+ `core/errors.ts` 补两码 |
| Task 10 | `212c76f` | `submit.ts` / `types.ts` / `repo.ts` 扩容器；`my_submissions.segments_json` |
| Task 11 | `c9bc23e` | `core/course-edit.ts`（表单 ↔ 行集 ↔ 台账） |
| Task 12 | `d755493` | `pages/course/edit.vue`；`platform/uni.ts` 加 `pickLocalFile()`；注册页面 |
| Task 13 | `5adec95` | `pages/lesson/edit.vue`；注册页面 |
| 清理 | `a01da20` | 清掉两张编辑页未使用的 `DIFFICULTY_ADVANCED` 引入 |
| Task 14 | `8f969d3` | `pages/lesson/detail.vue`（新增）+ `pages/course/detail.vue`（重写）+ `course.vue` 新建入口 |
| Task 15 | `422fcf9` | 版本 `0.15.0` / `20`；README `#40` 改口径 + 新增 `#41` + §5 两段；册子 §0.2 执行期更正 |

工作区自始至终另有 `.gitignore` 的未提交改动与未跟踪的 `based-linux-amd64`（构建产物）——**全程未 add、未提交**。

### 2. 门禁实况

- 节点侧（每个 Go Task 后各跑一次，最终一次全量）：`go build ./...`、`go vet ./...`、`go test ./...` **全部通过，无 FAIL**。
- 手机端（每个 TS/Vue Task 后各跑一次）：`npx vitest run`、`npx tsc --noEmit`、`npm run build:h5` **全部通过**。最终态 **23 个测试文件 / 229 个用例全绿**（基线 19 文件 / 178 用例）。
- 发布前模板硬检查（#31 更正 14 的教训）：`grep -nE '="[^"]*\.value|\{\{[^}]*\.value' apps/mobile/src/pages/*/*.vue` → **无输出**。

### 3. 部署与发布产物

| 项 | 值 |
| --- | --- |
| 节点二进制 | **21771765 字节** / sha256 `7c2fb7abea19c19f159b95cee87287595d6828cd41445b0dd48f8f5627278596` |
| 替换前远端二进制 | 21736332 字节 / `7cefae47…`，已备份为 `/opt/base/based.bak-0.14.0` |
| 服务状态 | `base` = active、`base-cache` = active（两单元共用 `/opt/base/based`） |
| 只读探活 | `/v1/comment` → 200；`/v1/proposal` → 200；`POST /v1/blob` → **400**（对照 `/v1/blobzzz` → 404、`GET /v1/blob` → 405，证明新路由确已上线） |
| APK | **27431470 字节** / sha256 `7f18ed1c089e464f3ce6dd71db9f17cc2a4625408199b019ebeda194b1710bc7` |
| 证书 SHA1 | `19:95:21:ED:09:C0:9C:AD:58:B0:EB:34:D1:B3:CF:D1:BA:89:FF:19`（与 0.6.0–0.14.0 一致，可覆盖安装） |
| 线上 `/v1/release` | `version_name=0.15.0`、`apk_size=27431470`、sha256 与本地逐字一致、`min_version_name=0.8.0`、`issuer=base-node-1`、`issued_at=2026-09-30T11:38:15Z` |
| 线上 `/dl/base-0.15.0.apk` | `HEAD` → 200，`Content-Length` 与本地一致；落地页只出现 `0.15.0` |

### 4. 执行期更正（均在对应文档或代码中已收口）

1. **Task 8 读序口径**：计划稿的 `attrsOf` 按 `seq` **升序**读属性行，与 `assignAttrSeqs` 的产出顺序（`seq` **降序** = 附件按 text 升序占递减 `seq`）不自洽，实现改为 `seq` 降序读。已回填册子 §0.2。
2. **Task 12/13 死引入**：两张编辑页 import 了未使用的 `DIFFICULTY_ADVANCED`，执行期清掉（`a01da20`）。已回填册子 §0.2。
3. **Task 5 测试前置**：`TestReplaceTagLinksKeepsNonChildRows` 需先调一次 `UpsertTagSubmission` 占住 author——`UpsertSegmentItem` 不写 `author_id`，空归属 ≠ 指定作者会撞 `ErrItemTaken`。**仅测试修正，生产代码未动。**
4. **Task 9 文件表漏列**：计划 Files 表只列 `blob.ts` / `blob.test.ts`，但步骤正文要求同步补 `core/errors.ts` 两条码表；按步骤正文执行。
5. **Task 12 `pages.json` 描述**：计划 Step 3 文字误把课时编辑页一并算进本 Task，实际只插 `pages/course/edit`（课时编辑页归 Task 13），与计划 JSON 块一致。
6. **Task 15 部署口径三处实测更正**：① `cp` 覆盖运行中二进制会 `Text file busy`，改用 `mv` 原子替换 + `chmod 755`（scp 落地件为 0644，否则 `203/EXEC`）；② `based release` 实测必填 `-version-name` / `-min-version-name` / `-apk-url` / `-apk-file` 且需 `BASE_SIGN_KEY`（从 `/opt/base/base.secret.env` 载入，未打印密钥）；③ 本机 `curl.exe` 的 DNS 解析异常（IP 直连正常），APK 下载校验改用 `Invoke-WebRequest`。
7. **Task 15 `/v1/blob` 探活判据**：计划预期 400 `bad_multipart`，实测回的是 400 `auth_missing_header`——鉴权先于 multipart 解析。判据等价（**不是 404**），并补了 `/v1/blobzzz` → 404 的反向对照。

### 5. 未实测（待人工）

1. `#41` 真机 7 条验收：课程新建 → 加两课 → 编辑课时正文 → 课程页看清单与「第 N 讲」→ 点进课时页看正文 / 载体 / 附件 → 断网保存后联网自动补发**仅一条** → 编辑入口只在本人建的容器上可见。
2. 客户端 `verifyRelease` 对线上文档的实测验签（需真机执行）。
3. 课时页附件的「另存」在真机上的落盘与 `openDocument` 打开效果。

---