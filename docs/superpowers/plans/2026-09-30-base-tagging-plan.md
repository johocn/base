# 统一标签体系（`名称 / 章 / 节` → 目标关联）落地 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让站点有了「统一标签」——三元组 `名称 / 章 / 节`（三级均必填、全站唯一）编码成 `item_id` `tag/<名称>/<章>/<节>`，作为一等条目；标签与 `course / lesson / article / comment` 的关联由节点侧新表 `tag_links` 承载（**唯一权威**），写入时同事务物化进既有 `segments` 行使得**内容包规范一字不改**；治理人给**无标签**内容直打（`POST /v1/submit` 的 `type=tag`），已有标签内容的改动走 `#27` 的 `edit` 提案（2 票）；手机端新增标签页并从同步下来的 `segments` 行重建本地派生表。

**Architecture:** 标签条目与 course / lesson 容器**同形**（`source=tag` / `type=tag` / `sqlite_table=segments`），因此直接复用 #14 已打通的 `segments` 全链（`packexport` 白名单、`ImportPack` 的 `segments` 分支、手机端 `segments` 表）；**唯一的存储新增是 `tag_links` 表**，而它是写入侧权威、**不进内容包**——导出时靠同一次写入物化出的 `segments` 行传播，接收侧与手机端据这些行回填各自的派生表。`content_hash` 走 #14 §3.3 的容器口径（哈希只看 `segments` 行），因此**同一份输入一次写入**，节点库与导出包不可能分叉。直打资格（#23 名册 ∪ #33 各圈治者）与「目标当前无标签」两条判定都必须在**写入事务内/前**完成，不做合并、不做部分生效。

**Tech Stack:** Go 1.25（`modernc.org/sqlite`）、uni-app（Vue 3 + TS）、vitest（node 环境）、`core/fakes.ts` 假仓储、`@base/protocol-ts`（`sha256Hex` / `utf8` / `authorSignBytes` / `sign`）。

**上游 spec:** `docs/superpowers/specs/2026-09-29-base-tagging-design.md`（#37，本计划是它的实现展开，冲突时以 spec 为准）
**直接上游:** `docs/superpowers/specs/2026-09-28-base-course-design.md`（#14：`segments` 行语义与两条哈希口径）、`docs/superpowers/specs/2026-09-28-base-submission-design.md`（#25 §0.2：`type=tag`）、`docs/superpowers/specs/2026-09-28-base-approval-governance-design.md`（#27 §0.5：`edit` 载体扩到 `tag`）、`docs/superpowers/specs/2026-09-28-base-creation-ui-design.md`（#29：`my_submissions` 与投稿编排）

**基线（开工前实测，2026-09-30）:** `go build ./...` / `go vet ./...` / `go test ./...` 全包 ok；mobile `npx vitest run` **18 文件 / 176 项全绿**、`npx tsc --noEmit` 干净；`apps/mobile/src/manifest.json` = `versionName "0.13.1"` / `versionCode "18"`。**本册据此升 `0.14.0`/`19`。**

**本册开工前已核实的现状（照做，勿重复探究）:**

| # | 事实 | 出处 |
|---|---|---|
| 1 | `store.SegmentsContentHash(segs)` 按 `seq` 升序拼 `"<kind>\t<text>\n"`；`UpsertSegmentItem` 幂等写 `items + segments` | [segments.go](file:///e:/code/base/internal/store/segments.go#L35-L87) |
| 2 | `ImportPack` 的 `case "segments"` 分支已存在，且**整包在一个 `sql.Tx` 里**（末尾写 `content_version` 后 `Commit`）——回填加在同一事务内即可 | [packimport.go](file:///e:/code/base/internal/store/packimport.go#L99-L185) |
| 3 | `UpsertSubmission` 的占用判定只看 `items.author_id`（空归属存量条目也拒），返回 `ErrItemTaken` | [submission.go](file:///e:/code/base/internal/store/submission.go#L28-L57) |
| 4 | `ContributorRoster()` 实时派生前 10 名（`map` 派生，不落表）；`DeriveSeats(members, creatorID, rosterRev, epoch, events)` 返回 `SeatSnapshot{Governors []string, ...}` | [contributor.go](file:///e:/code/base/internal/store/contributor.go#L88-L164)、[groupseats.go](file:///e:/code/base/internal/store/groupseats.go#L134-L174) |
| 5 | `proposalColumns` 是**单一常量**，`scanProposal` 与之逐列对应；`governColumnMigrations` 是既有的「后加列」幂等补列表 | [govern.go](file:///e:/code/base/internal/store/govern.go#L88-L90)、[schema.go](file:///e:/code/base/internal/store/schema.go#L239-L247) |
| 6 | `handleProposalPost` 的 `edit` 校验在 `GetItem` **之前**，且把载体写死成 `it.SQLiteTable != "articles"` → 需把载体相关校验挪到 `GetItem` 之后 | [govern.go](file:///e:/code/base/internal/httpapi/govern.go#L126-L164) |
| 7 | `protocol.isHex32` 已存在（评论 `event_id` = 32 hex）；`protocol.ParseTagItemID` **不存在**，需新写 | [hash.go](file:///e:/code/base/internal/protocol/hash.go#L28) |
| 8 | 手机端 `applyPack` 一次 `db.tx(stmts)` 写完全部；`segments` 的「先按 item_id 删、再插」就是现成模板 | [repo.ts](file:///e:/code/base/apps/mobile/src/core/repo.ts#L202-L215) |
| 9 | `buildSubmitBody` 内部现算签名，`submitItem` 是补发与直发**唯一的发送入口**；`authorSignBytes(itemId, contentHash, authorId)` 可直接复用 | [submit.ts](file:///e:/code/base/apps/mobile/src/core/submit.ts#L120-L128) |
| 10 | `fetchGroup(o, groupId)` 返回 `GroupInfo`（含 `governors: string[]`）；`roster(o)` / `myIdentityId(o)` 在 `core/contribution.ts` | [group.ts](file:///e:/code/base/apps/mobile/src/core/group.ts#L827-L921)、[contribution.ts](file:///e:/code/base/apps/mobile/src/core/contribution.ts#L35-L60) |

**⚠️ 开工前用户已定的六条口径（照做，勿再讨论）:**

1. **单计划一次落地**（节点 + 手机端 + 发布同册收口）。
2. **不做节点侧 `ListUntagged`**：册子 §4 那一行**作废**，「待补标签」是纯客户端反查（由本地 `tag_links` 反查得出）。Task 11 回填册子。
3. **直打资格判定落在 store 单函数** `GovernorSet() map[string]bool`（名册 ∪ 各圈治者），`submit.go` 只调用它。
4. **发布口径 `0.14.0` / `19` 独立发布**（册子 §5.3 写的 `code 18` 已被 `0.13.1` 占用，Task 11 回填该收窄）。
5. **改标提案的载荷存新列** `govern_proposals.links_json TEXT NOT NULL DEFAULT ''`（走既有 `governColumnMigrations` 幂等补列），不复用 `body_md`。
6. **不做 NFC 归一化**：Go 标准库无 NFC、仓库不含 `golang.org/x/text`，本册口径收窄为「去首尾空白（`TrimSpace` / `trim`）+ 非空 + ≤ 64 rune」，客户端同步不做 `normalize('NFC')`。Task 11 回填册子 §3.1。

**本机环境（照做）:** PowerShell 5.1 **不支持 `&&`**，多条命令用 `;` 分隔；`go` 若不在 PATH 先 `$env:PATH='D:\go\bin;D:\gopath\bin;'+$env:PATH`，`git` 若不在 PATH 先 `$env:Path += ";C:\Program Files\Git\cmd"`。**提交一律精确路径**（`git commit -m "..." -- <路径>`），**绝不 `git add -A`**；工作区常驻未提交项 `.gitignore` 永不提交、根目录 `based-linux-amd64` 是构建残留不提交不删。

---

## 文件结构

| 路径 | 动作 | 职责 |
| --- | --- | --- |
| `internal/protocol/tag.go` | 新建 | 契约级三元组：`TagItemID`（编码）/ `ParseTagItemID`（解码并重建校验）/ `TagTitle` / `TagKindOfTarget`（由 `target_id` 形态判定 `kind`）。节点与手机端同一口径的唯一来源 |
| `internal/protocol/tag_test.go` | 新建 | 编码边界（`/` `\` `%` 控制字符、中文、64/65 rune、空段、带空格）、解码往返、`TagKindOfTarget` 六种形态与非法形态 |
| `internal/store/tag.go` | 新建 | `tag_links` 表的唯一读写：`TagLink` / `TagSubmission` / `MaterializeTagSegments`（§3.3 排序口径）/ `replaceTagLinksTx`（直打与提案生效**共用**的写函数）/ `UpsertTagSubmission`（占用 + 直打条件）/ `ListTagLinks` / `ListTagsOf` / `HasCommentEvent` / `listSegmentsTx` / `backfillTagLinksTx` |
| `internal/store/governorset.go` | 新建 | `GovernorSet()`：#23 名册 ∪ 各圈 `DeriveSeats().Governors` 的去重并集 |
| `internal/store/schema.go` | 修改 | `schemaStatements` 追加 `tag_links` 表与 `idx_tag_links_target`；`govern_proposals` DDL 追加 `links_json` 列 + `governColumnMigrations` 补一行 |
| `internal/store/tag_test.go` | 新建 | 物化排序与哈希、直打条件（已有标签整体拒）、占用、幂等、`ListTagsOf` 反查、`GovernorSet` 并集 |
| `internal/store/packimport.go` | 修改 | 条目循环内收集 `tag/` 前缀条目，循环后**同一事务内**回填 `tag_links` |
| `internal/store/govern.go` | 修改 | `Proposal` 加 `LinksJSON`；`proposalColumns` / `scanProposal` / `CreateProposal` 三处同步；`editItemTx` 按载体系分流出 `editTagItemTx`（**author 两列不动**） |
| `internal/httpapi/submit.go` | 修改 | `type=tag` 分支：`links` 解析与去重、`kind` 形态自洽、目标存在性、治理人资格、`title` 重建校验、`content_hash` 走容器口径 |
| `internal/httpapi/govern.go` | 修改 | `edit` 载体系分流：`tag` 型收 `links[]`（拒 `body_md` / `title`），其余载体行为逐字不变 |
| `internal/httpapi/authmw.go` | 修改 | 新增四个错误码文案：`tag_not_governor` / `tag_target_tagged` / `tag_links_invalid` / `tag_target_not_found` |
| `internal/httpapi/tag_test.go` | 新建 | AC 1–6、9 的端到端：直打生效、名册外 403、已有标签 403、② 类拒、`title` 不等拒、编码唯一性 |
| `internal/packexport/tag_test.go` | 新建 | AC 7/8：打标 → 导出 `pack.sqlite` 含 `tag/*` 条目与物化 `segments` 行 → 另一方 `ImportPack` 后 `tag_links` 逐行一致；重复导出字节一致；`schema_version` 仍 1 |
| `apps/mobile/src/core/types.ts` | 修改 | `TagLinkRow`；`MySubmissionRow.type` 联合加 `'tag'` |
| `apps/mobile/src/core/repo.ts` | 修改 | `SCHEMA_SQL` 加 `tag_links` 表与索引；`applyPack` 内重建派生行（含墓碑清 `tag_id` 行）；`LocalRepo` 加 `listTagLinks` / `listTagLinksOfTargets` + 实现 |
| `apps/mobile/src/core/fakes.ts` | 修改 | `MemoryRepo` 的同名两方法与 `applyPack` 重建 |
| `apps/mobile/src/core/submit.ts` | 修改 | `SubmitDraft.type` 加 `'tag'`；`contentHashOf` / `validateDraft` / `buildSubmitBody` 三处按载体分流；`buildTagPayload` |
| `apps/mobile/src/core/tags.ts` | 新建 | `encodeTagPath` / `decodeTagPath` / `tagTitle` / `tagsOf` / `linksOf` / `untaggedTargets` / `submitTag` / `canGovern` |
| `apps/mobile/src/core/tags.test.ts` | 新建 | 编码往返、`linksOf` 排序、`tagsOf` 悬空跳过、`untaggedTargets`、`submitTag` 的断网入队与联网补发各一条 |
| `apps/mobile/src/pages/tag/list.vue` | 新建 | 全部标签（按 `item_id` 升序），点入详情 |
| `apps/mobile/src/pages/tag/detail.vue` | 新建 | 一个标签的关联目标，按 `kind` 分组（§3.3 渲染序） |
| `apps/mobile/src/pages/tag/apply.vue` | 新建 | 「补标签」表单（三元组 + 提交），入参 `target` / `kind` |
| `apps/mobile/src/pages.json` | 修改 | 注册三个新页面（**不动 `tabBar`**） |
| `apps/mobile/src/pages/mine/mine.vue` | 修改 | 「我的」页新增一组「标签」入口 |
| `apps/mobile/src/pages/course/detail.vue` | 修改 | 课程与各课时的标签区、「待补标签」标识与「补标签」按钮、已有标签时的提案提示 |
| `apps/mobile/src/pages/article/article.vue` | 修改 | 同上（文章载体） |
| `apps/mobile/src/pages/comment/comment.vue` | 修改 | **仅在已有标签时**逐条显示标签（不标「待补」） |
| `apps/mobile/src/manifest.json` | 修改 | `versionName "0.14.0"` / `versionCode "19"` |
| `docs/README.md` | 修改 | §3 新增第 38 行（本计划）；第 62 行（#37 册子）状态改「已执行」 |
| `docs/superpowers/specs/2026-09-29-base-tagging-design.md` | 修改 | 新增 `## 0.2 2026-09-30 执行期口径回填`，写进 Task 11 列出的 6 条 |

约定：Go 命令工作目录 `e:\code\base`；mobile 命令工作目录 `e:\code\base\apps\mobile`（用 Shell 的 `cwd` 参数，不 `cd`）。

---

### Task 1: 契约级三元组纯函数（`internal/protocol/tag.go`）

**Files:**
- Create: `internal/protocol/tag.go`
- Test: `internal/protocol/tag_test.go`

- [ ] **Step 1: 先写失败测试 `internal/protocol/tag_test.go`**

```go
package protocol

import "testing"

func TestTagItemIDAndTitle(t *testing.T) {
	cases := []struct {
		name, chapter, section string
		wantID                 string
		wantOK                 bool
	}{
		{"甲", "第一章", "第一节", "tag/甲/第一章/第一节", true},
		{"甲/乙", "第一章", "第一节", "tag/甲%2F乙/第一章/第一节", true},
		{"甲\\乙", "第一章", "第一节", "tag/甲%5C乙/第一章/第一节", true},
		{"100%", "第一章", "第一节", "tag/100%25/第一章/第一节", true},
		{"  甲  ", " 第一章 ", "第一节", "tag/甲/第一章/第一节", true}, // 去首尾空白（本册口径收窄：不做 NFC）
		{"", "第一章", "第一节", "", false},                        // 空段
		{"  ", "第一章", "第一节", "", false},                       // 全空白段
		{"甲", "第一章", "第一节"[:0], "", false},                    // 空节
	}
	for _, c := range cases {
		got, ok := TagItemID(c.name, c.chapter, c.section)
		if ok != c.wantOK || got != c.wantID {
			t.Errorf("TagItemID(%q,%q,%q) = (%q,%v), want (%q,%v)", c.name, c.chapter, c.section, got, ok, c.wantID, c.wantOK)
		}
	}
	if got := TagTitle("  甲 ", "第一章", "第一节"); got != "甲 · 第一章 · 第一节" {
		t.Errorf("TagTitle = %q", got)
	}
}

func TestTagItemIDMaxRunes(t *testing.T) {
	long := ""
	for i := 0; i < 64; i++ {
		long += "甲"
	}
	if _, ok := TagItemID(long, "章", "节"); !ok {
		t.Fatal("64 rune 应通过")
	}
	if _, ok := TagItemID(long+"甲", "章", "节"); ok {
		t.Fatal("65 rune 应拒绝")
	}
}

func TestParseTagItemIDRoundTrip(t *testing.T) {
	id, ok := TagItemID("甲/乙", "第一章", "第一节")
	if !ok {
		t.Fatal("构造失败")
	}
	name, chapter, section, ok := ParseTagItemID(id)
	if !ok || name != "甲/乙" || chapter != "第一章" || section != "第一节" {
		t.Fatalf("ParseTagItemID(%q) = (%q,%q,%q,%v)", id, name, chapter, section, ok)
	}
	for _, bad := range []string{
		"", "tag", "tag/甲", "tag/甲/第一章", "tag/甲/第一章/第一节/第二节",
		"tag//第一章/第一节", "tag/甲/第一章/%ZZ", "tag/ 甲 /第一章/第一节",
		"article/x", "tag/甲/第一章/第一节\t",
	} {
		if _, _, _, ok := ParseTagItemID(bad); ok {
			t.Errorf("ParseTagItemID(%q) 应失败", bad)
		}
	}
}

func TestTagKindOfTarget(t *testing.T) {
	hex32 := "0123456789abcdef0123456789abcdef"
	cases := map[string]string{
		"course/c1": "course",
		"course/c1/lesson/l1": "lesson",
		"article/a1": "article",
		"course/c1/lesson/l1/article/a1": "article",
		"comment/" + hex32: "comment",
		"course/c1/lesson/l1/quiz/q1": "",
		"video/v1": "", "group/g1": "",
		"comment/0123": "",
		"course/c1/lesson/": "",
		"tag/甲/章/节": "",
	}
	for target, want := range cases {
		if got := TagKindOfTarget(target); got != want {
			t.Errorf("TagKindOfTarget(%q) = %q, want %q", target, got, want)
		}
	}
}
```

- [ ] **Step 2: 跑测试确认失败**

```
go test ./internal/protocol/ -run 'TestTag' -count=1
```
Expected: 编译失败 `undefined: TagItemID`

- [ ] **Step 3: 写实现 `internal/protocol/tag.go`**

```go
package protocol

import (
	"fmt"
	"strconv"
	"strings"
	"unicode/utf8"
)

// TagSegmentMaxRunes 是三元组单段的 rune 上限（册子 §3.1）。
const TagSegmentMaxRunes = 64

// tagKindOrder 是关联的 kind 取值集合（册子 §3.2）；排序口径在 store 侧（册子 §3.3）。
var tagKindOrder = []string{"course", "lesson", "article", "comment"}

// normalizeTagSegment 归一化一段：去首尾空白。
// **本册口径收窄（2026-09-30 用户定案）**：不做 NFC/NFD 归一化——Go 标准库无 NFC，
// 仓库不含 golang.org/x/text，不为一个边角场景引入新依赖。客户端同步只 trim。
func normalizeTagSegment(s string) string { return strings.TrimSpace(s) }

// TagItemID 由三段重建 item_id；任一段归一化后为空或超 64 rune 即 ok=false（册子 §3.1）。
// 唯一性由 item_id 天然承载：三段归一化后相同 ⇒ 同一 item_id ⇒ 同一条件，无需判重表。
func TagItemID(name, chapter, section string) (string, bool) {
	parts := [3]string{name, chapter, section}
	enc := [3]string{}
	for i, p := range parts {
		n := normalizeTagSegment(p)
		if n == "" || utf8.RuneCountInString(n) > TagSegmentMaxRunes {
			return "", false
		}
		enc[i] = encodeTagPathSegment(n)
	}
	return "tag/" + enc[0] + "/" + enc[1] + "/" + enc[2], true
}

// TagTitle 是 items.title：三段**原文**（已归一化）以 " · " 连接，不编码（册子 §3.1）。
func TagTitle(name, chapter, section string) string {
	return normalizeTagSegment(name) + " · " + normalizeTagSegment(chapter) + " · " + normalizeTagSegment(section)
}

// ParseTagItemID 解出三段并**重建校验**：重建值必须与入参逐字相等，否则 ok=false。
// 这条重建校验是 §3.1 的「title 不是自由字段」与「唯一性」的实现基础。
func ParseTagItemID(itemID string) (name, chapter, section string, ok bool) {
	rest, found := strings.CutPrefix(itemID, "tag/")
	if !found {
		return "", "", "", false
	}
	parts := strings.Split(rest, "/")
	if len(parts) != 3 {
		return "", "", "", false
	}
	segs := [3]string{}
	for i, p := range parts {
		if p == "" {
			return "", "", "", false
		}
		d, ok := decodeTagPathSegment(p)
		if !ok {
			return "", "", "", false
		}
		segs[i] = d
	}
	rebuilt, ok := TagItemID(segs[0], segs[1], segs[2])
	if !ok || rebuilt != itemID {
		return "", "", "", false
	}
	return segs[0], segs[1], segs[2], true
}

// encodeTagPathSegment 对 `/` `\` `%` 与控制字符（U+0000–U+001F、U+007F）做百分号编码，
// 其余字符（含中文）原样保留（册子 §3.1）。
func encodeTagPathSegment(s string) string {
	var b strings.Builder
	for _, r := range s {
		switch {
		case r == '/':
			b.WriteString("%2F")
		case r == '\\':
			b.WriteString("%5C")
		case r == '%':
			b.WriteString("%25")
		case r <= 0x1F || r == 0x7F:
			fmt.Fprintf(&b, "%%%02X", r) // 控制字符均 < 0x80，字节值即 rune 值
		default:
			b.WriteRune(r)
		}
	}
	return b.String()
}

// decodeTagPathSegment 是 encodeTagPathSegment 的逆；遇到不完整或非十六进制的 `%xx` 即失败。
func decodeTagPathSegment(s string) (string, bool) {
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		if s[i] != '%' {
			b.WriteByte(s[i])
			continue
		}
		if i+3 > len(s) {
			return "", false
		}
		v, err := strconv.ParseUint(s[i+1:i+3], 16, 8)
		if err != nil {
			return "", false
		}
		b.WriteByte(byte(v))
		i += 2
	}
	return b.String(), true
}

// TagKindOfTarget 由 target_id 形态判定 kind（册子 §3.2）；不合法返回空串。
// 判定只看形态，不看存在性——存在性由调用方查库（§3.2 的表）。
func TagKindOfTarget(targetID string) string {
	parts := strings.Split(targetID, "/")
	for _, p := range parts {
		if p == "" {
			return ""
		}
	}
	switch {
	case len(parts) == 2 && parts[0] == "course":
		return "course"
	case len(parts) == 2 && parts[0] == "article":
		return "article"
	case len(parts) == 4 && parts[0] == "course" && parts[2] == "lesson":
		return "lesson"
	case len(parts) == 6 && parts[0] == "course" && parts[2] == "lesson" && parts[4] == "article":
		return "article"
	case len(parts) == 2 && parts[0] == "comment" && isHex32(parts[1]):
		// 只认 32 hex：group.v1 / dm.v1 的 event_id 由 §3.7 一律拒（② 类红线）。
		return "comment"
	default:
		return ""
	}
}

// TagKindAllowed 判定 kind 是否在 §3.2 的取值集合内（导出侧与接收侧回填的防御性过滤用）。
func TagKindAllowed(kind string) bool {
	for _, k := range tagKindOrder {
		if k == kind {
			return true
		}
	}
	return false
}
```

- [ ] **Step 4: 跑测试确认通过**

```
go test ./internal/protocol/ -run 'TestTag' -count=1 -v
```
Expected: 4 个用例 `--- PASS`

- [ ] **Step 5: 全仓门禁 + 提交**

```
go build ./... ; go vet ./... ; go test ./... -count=1
```
Expected: 全包 ok

```
git commit -m "feat(protocol): 统一标签三元组的契约级编码/解码与形态判定" -- internal/protocol/tag.go internal/protocol/tag_test.go
```

---

### Task 2: store 层 `tag_links` 表与读写（物化 · 直打条件 · 占用）

**Files:**
- Modify: `internal/store/schema.go`（`schemaStatements` 末尾追加两行）
- Create: `internal/store/tag.go`
- Test: `internal/store/tag_test.go`

- [ ] **Step 1: `internal/store/schema.go` 追加表与索引**

在 `schemaStatements` 的 `idx_govern_proposals_item` 那一条**之后**、`}` 之前追加：

```go
	// tag_links：统一标签与内容的关联（#37 册子 §3.2）。**节点侧唯一权威**——
	// 内容包不加表，导出靠同一次写入物化出的 segments 行传播（§3.3）。
	// 目标被下架（remove）后**不做级联删除**：悬空引用由客户端静默跳过（§3.2）。
	`CREATE TABLE IF NOT EXISTS tag_links(
		tag_id     TEXT NOT NULL,
		target_id  TEXT NOT NULL,
		kind       TEXT NOT NULL,
		created_at TEXT NOT NULL,
		PRIMARY KEY (tag_id, target_id)
	)`,

	`CREATE INDEX IF NOT EXISTS idx_tag_links_target ON tag_links(target_id)`,
```

> 表是**新增**的，`CREATE TABLE IF NOT EXISTS` 本身幂等，故**不加** `tagColumnMigrations`（册子 §4 那一行作废，Task 11 回填）。`govern_proposals.links_json` 才是「后加列」，那一行走 `governColumnMigrations`（Task 6）。

- [ ] **Step 2: 先写失败测试 `internal/store/tag_test.go`**

```go
package store

import (
	"errors"
	"reflect"
	"testing"

	"github.com/johocn/base/internal/protocol"
)

func tagLinksOf(t *testing.T, s *Store, tagID string) []TagLink {
	t.Helper()
	got, err := s.ListTagLinks(tagID)
	if err != nil {
		t.Fatalf("ListTagLinks: %v", err)
	}
	return got
}

func TestTagMaterializeOrderAndHash(t *testing.T) {
	links := []TagLink{
		{"tag/甲/一/一", "comment/0123456789abcdef0123456789abcdef", "comment"},
		{"tag/甲/一/一", "article/a2", "article"},
		{"tag/甲/一/一", "course/c9", "course"},
		{"tag/甲/一/一", "course/c1", "course"},
		{"tag/甲/一/一", "course/c1/lesson/l1", "lesson"},
	}
	segs := MaterializeTagSegments("tag/甲/一/一", links)
	want := []Segment{
		{ItemID: "tag/甲/一/一", Seq: 1, Kind: "course", Text: "course/c1"},
		{ItemID: "tag/甲/一/一", Seq: 2, Kind: "course", Text: "course/c9"},
		{ItemID: "tag/甲/一/一", Seq: 3, Kind: "lesson", Text: "course/c1/lesson/l1"},
		{ItemID: "tag/甲/一/一", Seq: 4, Kind: "article", Text: "article/a2"},
		{ItemID: "tag/甲/一/一", Seq: 5, Kind: "comment", Text: "comment/0123456789abcdef0123456789abcdef"},
	}
	if len(segs) != len(want) {
		t.Fatalf("行数 = %d, want %d", len(segs), len(want))
	}
	for i := range want {
		if segs[i].Seq != want[i].Seq || segs[i].Kind != want[i].Kind || segs[i].Text != want[i].Text {
			t.Errorf("行 %d = %+v, want %+v", i, segs[i], want[i])
		}
	}
	// 唯一性锚点：同一份输入（顺序打乱）必须得同一个 content_hash。
	shuffled := []TagLink{links[2], links[4], links[0], links[3], links[1]}
	if SegmentsContentHash(MaterializeTagSegments("tag/甲/一/一", shuffled)) != SegmentsContentHash(segs) {
		t.Fatal("乱序输入应得同一 content_hash")
	}
}

func TestUpsertTagSubmissionDirectWrite(t *testing.T) {
	s := newTestStore(t)
	if err := s.putItemForTest("course/c1", "course"); err != nil {
		t.Fatal(err)
	}
	created, err := s.UpsertTagSubmission(TagSubmission{
		TagID: "tag/甲/一/一", Title: "甲 · 一 · 一",
		Links:    []TagLink{{TagID: "tag/甲/一/一", TargetID: "course/c1", Kind: "course"}},
		AuthorID: "aa", AuthorSig: "sig",
	})
	if err != nil || !created {
		t.Fatalf("首次直打 created=%v err=%v", created, err)
	}
	if got := tagLinksOf(t, s, "tag/甲/一/一"); !reflect.DeepEqual(got, []TagLink{{"tag/甲/一/一", "course/c1", "course"}}) {
		t.Fatalf("tag_links = %+v", got)
	}
	segs, err := s.ListSegments("tag/甲/一/一")
	if err != nil || len(segs) != 1 || segs[0].Text != "course/c1" || segs[0].Kind != "course" {
		t.Fatalf("物化 segments = %+v err=%v", segs, err)
	}
	it, ok, err := s.GetItem("tag/甲/一/一")
	if err != nil || !ok {
		t.Fatalf("条目未建 ok=%v err=%v", ok, err)
	}
	if it.Source != "tag" || it.Type != "tag" || it.SQLiteTable != "segments" || it.AuthorID != "aa" {
		t.Fatalf("条目列 = %+v", it)
	}
	if it.ContentHash != SegmentsContentHash(segs) {
		t.Fatalf("content_hash 与容器口径不一致: %s", it.ContentHash)
	}

	// 幂等：同输入再提交仍是 1 行
	if _, err := s.UpsertTagSubmission(TagSubmission{
		TagID: "tag/甲/一/一", Title: "甲 · 一 · 一",
		Links:    []TagLink{{TagID: "tag/甲/一/一", TargetID: "course/c1", Kind: "course"}},
		AuthorID: "aa", AuthorSig: "sig2",
	}); err != nil {
		t.Fatalf("幂等重提交失败: %v", err)
	}
	if got := tagLinksOf(t, s, "tag/甲/一/一"); len(got) != 1 {
		t.Fatalf("幂等后 tag_links = %+v", got)
	}
}

func TestUpsertTagSubmissionRejectsTaggedTarget(t *testing.T) {
	s := newTestStore(t)
	if err := s.putItemForTest("course/c1", "course"); err != nil {
		t.Fatal(err)
	}
	if err := s.putItemForTest("course/c2", "course"); err != nil {
		t.Fatal(err)
	}
	if _, err := s.UpsertTagSubmission(TagSubmission{
		TagID: "tag/甲/一/一", Title: "甲 · 一 · 一",
		Links:    []TagLink{{TagID: "tag/甲/一/一", TargetID: "course/c1", Kind: "course"}},
		AuthorID: "aa",
	}); err != nil {
		t.Fatal(err)
	}
	// c1 已有标签、c2 没有 → **整体拒绝**，不部分生效，也不新建条目
	_, err := s.UpsertTagSubmission(TagSubmission{
		TagID: "tag/乙/一/一", Title: "乙 · 一 · 一",
		Links: []TagLink{
			{TagID: "tag/乙/一/一", TargetID: "course/c2", Kind: "course"},
			{TagID: "tag/乙/一/一", TargetID: "course/c1", Kind: "course"},
		},
		AuthorID: "aa",
	})
	if !errors.Is(err, ErrTagTargetTagged) {
		t.Fatalf("err = %v, want ErrTagTargetTagged", err)
	}
	if _, ok, _ := s.GetItem("tag/乙/一/一"); ok {
		t.Fatal("被拒时不得建条目")
	}
	if got := tagLinksOf(t, s, "tag/乙/一/一"); len(got) != 0 {
		t.Fatalf("被拒时不得写关联: %+v", got)
	}
}

func TestUpsertTagSubmissionOccupied(t *testing.T) {
	s := newTestStore(t)
	if _, err := s.UpsertTagSubmission(TagSubmission{
		TagID: "tag/甲/一/一", Title: "甲 · 一 · 一", AuthorID: "aa",
	}); err != nil {
		t.Fatal(err)
	}
	_, err := s.UpsertTagSubmission(TagSubmission{TagID: "tag/甲/一/一", Title: "甲 · 一 · 一", AuthorID: "bb"})
	if !errors.Is(err, ErrItemTaken) {
		t.Fatalf("err = %v, want ErrItemTaken", err)
	}
}

func TestListTagsOf(t *testing.T) {
	s := newTestStore(t)
	for _, id := range []string{"tag/甲/一/一", "tag/乙/一/一"} {
		if _, err := s.UpsertTagSubmission(TagSubmission{
			TagID: id, Title: "x", Links: []TagLink{{TagID: id, TargetID: "course/c1", Kind: "course"}}, AuthorID: "aa",
		}); err != nil {
			t.Fatal(err)
		}
	}
	got, err := s.ListTagsOf("course/c1")
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(got, []string{"tag/乙/一/一", "tag/甲/一/一"}) {
		t.Fatalf("ListTagsOf = %v", got)
	}
}

func TestHasCommentEvent(t *testing.T) {
	s := newTestStore(t)
	if err := s.putEventForTest("e1", "comment.v1"); err != nil {
		t.Fatal(err)
	}
	if err := s.putEventForTest("e2", "group.v1"); err != nil {
		t.Fatal(err)
	}
	ok, err := s.HasCommentEvent("e1")
	if err != nil || !ok {
		t.Fatalf("e1 ok=%v err=%v", ok, err)
	}
	ok, err = s.HasCommentEvent("e2")
	if err != nil || ok {
		t.Fatalf("e2（group.v1）必须为 false: ok=%v err=%v", ok, err)
	}
	ok, err = s.HasCommentEvent("nope")
	if err != nil || ok {
		t.Fatalf("不存在必须为 false: ok=%v err=%v", ok, err)
	}
}

func TestMaterializeDropsDuplicateTargets(t *testing.T) {
	segs := MaterializeTagSegments("tag/甲/一/一", []TagLink{
		{"tag/甲/一/一", "course/c1", "course"},
		{"tag/甲/一/一", "course/c1", "lesson"},
	})
	if len(segs) != 1 {
		t.Fatalf("同 target_id 去重后应为 1 行，得 %d 行", len(segs))
	}
}

func TestTagItemIDUsesProtocol(t *testing.T) {
	// 契约口径由 protocol 单一来源提供，store 不得另立编码
	id, ok := protocol.TagItemID("甲", "一", "一")
	if !ok || id != "tag/甲/一/一" {
		t.Fatalf("protocol.TagItemID = %q %v", id, ok)
	}
}
```

> 测试辅助 `newTestStore` / `putItemForTest` / `putEventForTest`：先 `grep -n "func newTestStore" internal/store/` 看既有测试基座的**真实名字与签名**，照它写；若没有写条目的现成辅助，就在 `tag_test.go` 内用 `s.UpsertSubmission`（`article` 型）或直接 `s.db.Exec` 造 `items` / `events` 行——**不要新增生产代码里的测试专用导出**。

- [ ] **Step 3: 跑测试确认失败**

```
go test ./internal/store/ -run 'TestTag|TestUpsertTag|TestListTagsOf|TestHasCommentEvent|TestMaterialize' -count=1
```
Expected: 编译失败 `undefined: MaterializeTagSegments`

- [ ] **Step 4: 写实现 `internal/store/tag.go`**

```go
package store

import (
	"database/sql"
	"errors"
	"fmt"
	"sort"
	"strings"

	"github.com/johocn/base/internal/protocol"
)

// ErrTagTargetTagged 表示直打涉及的某个目标**已有标签**（册子 §3.4）：
// 整体拒绝、不部分生效、不自动合并，人读文案引导走治理提案。
var ErrTagTargetTagged = errors.New("store: tag target already tagged")

// TagLink 是 tag_links 的一行（册子 §3.2）。
type TagLink struct {
	TagID    string
	TargetID string
	Kind     string // course | lesson | article | comment
}

// TagSubmission 是一条标签直打（册子 §3.4）。
type TagSubmission struct {
	TagID     string
	Title     string // 由调用方按 protocol.TagTitle 重建好
	Links     []TagLink
	AuthorID  string
	AuthorSig string
	UpdatedAt string
}

// tagKindRank 是物化 segments 行的 kind 固定序（册子 §3.3）。
func tagKindRank(kind string) int {
	for i, k := range []string{"course", "lesson", "article", "comment"} {
		if k == kind {
			return i
		}
	}
	return 4
}

// MaterializeTagSegments 把关联集物化成 segments 行（册子 §3.3）：seq 从 1 起，
// 先按 kind 固定序 course < lesson < article < comment，同 kind 内按 target_id 字典序升序。
// 同一 target_id 只保留一行（tag_links 的主键是 (tag_id,target_id)，重复由写入面拒绝，这里是防御）。
func MaterializeTagSegments(tagID string, links []TagLink) []Segment {
	ordered := append([]TagLink{}, links...)
	sort.Slice(ordered, func(i, j int) bool {
		ri, rj := tagKindRank(ordered[i].Kind), tagKindRank(ordered[j].Kind)
		if ri != rj {
			return ri < rj
		}
		return ordered[i].TargetID < ordered[j].TargetID
	})
	segs := make([]Segment, 0, len(ordered))
	seen := map[string]bool{}
	for _, l := range ordered {
		if seen[l.TargetID] {
			continue
		}
		seen[l.TargetID] = true
		segs = append(segs, Segment{ItemID: tagID, Seq: len(segs) + 1, Kind: l.Kind, Text: l.TargetID})
	}
	return segs
}

// replaceTagLinksTx 全量替换一个标签的关联集，返回新的**条目级** content_hash。
// 这是直打（§3.4）与提案生效（§3.5）**共用的唯一写函数**：删旧 tag_links 行 → 写新行 →
// 重算物化 segments 行。只碰 tag_links 与 segments，**不碰 items**——items 的归属列由两个调用方各自决定。
func replaceTagLinksTx(tx *sql.Tx, tagID string, links []TagLink) (string, error) {
	if _, err := tx.Exec(`DELETE FROM tag_links WHERE tag_id=?`, tagID); err != nil {
		return "", fmt.Errorf("store: 清旧 tag_links %s: %w", tagID, err)
	}
	segs := MaterializeTagSegments(tagID, links)
	for _, s := range segs {
		if _, err := tx.Exec(`INSERT INTO tag_links(tag_id,target_id,kind,created_at) VALUES(?,?,?,?)`,
			tagID, s.Text, s.Kind, nowUTC()); err != nil {
			return "", fmt.Errorf("store: 写 tag_links %s→%s: %w", tagID, s.Text, err)
		}
	}
	if _, err := tx.Exec(`DELETE FROM segments WHERE item_id=?`, tagID); err != nil {
		return "", fmt.Errorf("store: 清旧 segments %s: %w", tagID, err)
	}
	for _, s := range segs {
		if _, err := tx.Exec(`INSERT INTO segments(item_id,seq,kind,text,content_hash) VALUES(?,?,?,?,?)`,
			tagID, s.Seq, s.Kind, s.Text, protocol.SHA256Hex([]byte(s.Text))); err != nil {
			return "", fmt.Errorf("store: 写 segments %s seq=%d: %w", tagID, s.Seq, err)
		}
	}
	return SegmentsContentHash(segs), nil
}

// UpsertTagSubmission 写入/更新一条标签直打（items + tag_links + segments 同事务）。
// 占用判定与 #25 同口径（只看 items.author_id，空归属存量条目也拒）；直打条件见册子 §3.4。
func (s *Store) UpsertTagSubmission(sub TagSubmission) (created bool, err error) {
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
	switch err := tx.QueryRow(`SELECT author_id FROM items WHERE item_id=?`, sub.TagID).Scan(&cur); {
	case errors.Is(err, sql.ErrNoRows):
		created = true
	case err != nil:
		return false, err
	case cur != sub.AuthorID:
		return false, ErrItemTaken
	}
	// 直打条件（册子 §3.4）：本次涉及的**每一个**目标当前都必须无标签。
	for _, l := range sub.Links {
		var n int
		if err := tx.QueryRow(`SELECT COUNT(*) FROM tag_links WHERE target_id=?`, l.TargetID).Scan(&n); err != nil {
			return false, err
		}
		if n > 0 {
			return false, ErrTagTargetTagged
		}
	}
	hash, err := replaceTagLinksTx(tx, sub.TagID, sub.Links)
	if err != nil {
		return false, err
	}
	// ON CONFLICT 刻意不写 state / dist_class：墓碑条目保持其 state（与 #25 同口径）。
	if _, err := tx.Exec(`INSERT INTO items(item_id,source,type,title,source_rev,content_hash,sqlite_table,dist_class,state,updated_at,author_id,author_sig)
		VALUES(?,?,?,?,?,?,?,'public','active',?,?,?)
		ON CONFLICT(item_id) DO UPDATE SET
			title=excluded.title, source_rev=excluded.source_rev, content_hash=excluded.content_hash,
			updated_at=excluded.updated_at, author_id=excluded.author_id, author_sig=excluded.author_sig`,
		sub.TagID, "tag", "tag", sub.Title, hash[:16], hash, "segments", updated, sub.AuthorID, sub.AuthorSig); err != nil {
		return false, fmt.Errorf("store: upsert tag item: %w", err)
	}
	return created, tx.Commit()
}

// ListTagLinks 按 (kind 固定序, target_id 升序) 返回一个标签的关联集（§3.3 的渲染序）。
func (s *Store) ListTagLinks(tagID string) ([]TagLink, error) {
	rows, err := s.db.Query(`SELECT tag_id,target_id,kind FROM tag_links WHERE tag_id=?`, tagID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []TagLink{}
	for rows.Next() {
		var l TagLink
		if err := rows.Scan(&l.TagID, &l.TargetID, &l.Kind); err != nil {
			return nil, err
		}
		out = append(out, l)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	sortTagLinks(out)
	return out, nil
}

// ListTagsOf 反查：指向某目标的全部 tag_id（升序）。悬空引用（标签条目已退役）由调用方过滤。
func (s *Store) ListTagsOf(targetID string) ([]string, error) {
	rows, err := s.db.Query(`SELECT tag_id FROM tag_links WHERE target_id=? ORDER BY tag_id ASC`, targetID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []string{}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		out = append(out, id)
	}
	return out, rows.Err()
}

// HasCommentEvent 判定 event_id 是否为本节点已收到的 comment.v1 事件（册子 §3.2）。
// 硬过滤 type='comment.v1'：② 类（group.v1 / dm.v1）由此**天然被排除**（§3.7 红线）。
func (s *Store) HasCommentEvent(eventID string) (bool, error) {
	var n int
	err := s.db.QueryRow(`SELECT COUNT(*) FROM events WHERE type='comment.v1' AND event_id=?`, eventID).Scan(&n)
	return n > 0, err
}

// sortTagLinks 按 §3.3 的渲染序就地排序。
func sortTagLinks(links []TagLink) {
	sort.Slice(links, func(i, j int) bool {
		ri, rj := tagKindRank(links[i].Kind), tagKindRank(links[j].Kind)
		if ri != rj {
			return ri < rj
		}
		return links[i].TargetID < links[j].TargetID
	})
}

// listSegmentsTx 是 ListSegments 的事务内版本（导入回填要在同一事务里读自己的写入）。
func listSegmentsTx(tx *sql.Tx, itemID string) ([]Segment, error) {
	rows, err := tx.Query(`SELECT item_id,seq,kind,text,content_hash FROM segments WHERE item_id=? ORDER BY seq ASC`, itemID)
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

// backfillTagLinksTx 把一条已入库标签条目的 segments 行幂等回填进 tag_links（册子 §3.3）。
// 回填**不校验目标存在性**（评论事件未必已同步，引用允许悬空）；非四类 kind 的行丢弃
// （防御：导出侧只产出四类，但包里来的数据不由本节点保证）。
func backfillTagLinksTx(tx *sql.Tx, tagID string) error {
	segs, err := listSegmentsTx(tx, tagID)
	if err != nil {
		return err
	}
	links := make([]TagLink, 0, len(segs))
	for _, s := range segs {
		if !protocol.TagKindAllowed(s.Kind) || strings.TrimSpace(s.Text) == "" {
			continue
		}
		links = append(links, TagLink{TagID: tagID, TargetID: s.Text, Kind: s.Kind})
	}
	_, err = replaceTagLinksTx(tx, tagID, links)
	return err
}
```

- [ ] **Step 5: 跑测试确认通过**

```
go test ./internal/store/ -run 'TestTag|TestUpsertTag|TestListTagsOf|TestHasCommentEvent|TestMaterialize' -count=1 -v
```
Expected: 全部 `--- PASS`

- [ ] **Step 6: 同包全量回归 + 提交**

```
go test ./internal/store/ -count=1
```

```
git commit -m "feat(store): 新增 tag_links 表与标签直打写入（物化 segments 同事务）" -- internal/store/schema.go internal/store/tag.go internal/store/tag_test.go
```

---

### Task 3: 治理人集合派生（`GovernorSet`）

**Files:**
- Create: `internal/store/governorset.go`
- Test: `internal/store/governorset_test.go`

- [ ] **Step 1: 先写失败测试 `internal/store/governorset_test.go`**

```go
package store

import (
	"testing"

	"github.com/johocn/base/internal/protocol"
)

func TestGovernorSetUnionsRosterAndCircleGovernors(t *testing.T) {
	s := newTestStore(t)
	// 名册来源：一条达门槛的 article（≥200 非空白 rune）
	body := ""
	for i := 0; i < ArticleMinRunes; i++ {
		body += "甲"
	}
	hash := protocol.SHA256Hex([]byte(body))
	if _, err := s.UpsertSubmission(Submission{
		ItemID: "article/a1", Type: "article", Title: "t", BodyMD: body,
		ContentHash: hash, AuthorID: "aaa", AuthorSig: "s",
	}); err != nil {
		t.Fatal(err)
	}
	// 圈子来源：一个 m=1 的圈，唯一治者 = 创建者
	if err := s.PutGroupRosterV2(GroupRoster{
		GroupID: "g1", CreatorID: "ccc", Epoch: 1, RosterRev: 1, Encrypted: 0,
		MemberIDsJSON: `["ccc"]`, EventID: "e1",
	}); err != nil {
		t.Fatal(err)
	}
	set, err := s.GovernorSet()
	if err != nil {
		t.Fatal(err)
	}
	if !set["aaa"] || !set["ccc"] {
		t.Fatalf("集合 = %v，应同时含名册内 aaa 与圈内 ccc", set)
	}
	if set["bbb"] {
		t.Fatalf("bbb 不应在集合内: %v", set)
	}
	if len(set) != 2 {
		t.Fatalf("集合大小 = %d, want 2（去重）", len(set))
	}
}

func TestGovernorSetEmptyWhenNothingDerivable(t *testing.T) {
	s := newTestStore(t)
	set, err := s.GovernorSet()
	if err != nil {
		t.Fatal(err)
	}
	if len(set) != 0 {
		t.Fatalf("空库应得空集合，得 %v", set)
	}
}
```

> `PutGroupRosterV2` 的字段名与 `Encrypted` 取值请以 [group.go](file:///e:/code/base/internal/store/group.go#L67-L102) 为准；若测试基座里已有造圈辅助，优先复用它。

- [ ] **Step 2: 跑测试确认失败**

```
go test ./internal/store/ -run 'TestGovernorSet' -count=1
```
Expected: 编译失败 `undefined: (Store).GovernorSet`

- [ ] **Step 3: 写实现 `internal/store/governorset.go`**

```go
package store

import (
	"encoding/json"
	"sort"
)

// GovernorSet 返回本节点治理人集合 = #23 全站名册 ∪ #33 各圈治者（册子 §3.4）。
// 名册与席位都是**实时派生**、不落表；席位的判定完全复用 #35 Phase 1 的 DeriveSeats，
// 本函数不自定义任何圈子治者口径。
func (s *Store) GovernorSet() (map[string]bool, error) {
	out := map[string]bool{}
	roster, err := s.ContributorRoster()
	if err != nil {
		return nil, err
	}
	for _, c := range roster {
		out[c.ID] = true
	}
	// 先把小组行读尽再关游标：单连接池下不能在未闭合游标上发起嵌套查询。
	type groupRow struct {
		id        string
		creator   string
		epoch     int64
		rosterRev int64
		members   string
	}
	var rows []groupRow
	cur, err := s.db.Query(`SELECT group_id,creator_id,epoch,roster_rev,member_ids_json FROM groups ORDER BY group_id ASC`)
	if err != nil {
		return nil, err
	}
	for cur.Next() {
		var g groupRow
		if err := cur.Scan(&g.id, &g.creator, &g.epoch, &g.rosterRev, &g.members); err != nil {
			cur.Close()
			return nil, err
		}
		rows = append(rows, g)
	}
	if err := cur.Err(); err != nil {
		cur.Close()
		return nil, err
	}
	cur.Close()

	for _, g := range rows {
		members := []string{}
		if err := json.Unmarshal([]byte(g.members), &members); err != nil {
			continue // 名单 JSON 不可解析 = 该圈不参与资格判定，不中断其余来源
		}
		sort.Strings(members)
		events, err := s.ListGroupMsgEvents(g.id)
		if err != nil {
			return nil, err
		}
		snap := DeriveSeats(members, g.creator, g.rosterRev, g.epoch, events)
		for _, id := range snap.Governors {
			if id != "" {
				out[id] = true
			}
		}
	}
	return out, nil
}
```

- [ ] **Step 4: 跑测试确认通过**

```
go test ./internal/store/ -run 'TestGovernorSet' -count=1 -v
```

- [ ] **Step 5: 同包全量回归 + 提交**

```
go test ./internal/store/ -count=1
```

```
git commit -m "feat(store): 派生本节点治理人集合（名册 ∪ 各圈治者）" -- internal/store/governorset.go internal/store/governorset_test.go
```

---

### Task 4: `POST /v1/submit` 的 `type=tag` 分支

**Files:**
- Modify: `internal/httpapi/submit.go`
- Modify: `internal/httpapi/authmw.go`（`authErrText` 追加四条）
- Test: `internal/httpapi/tag_test.go`

- [ ] **Step 1: `authmw.go` 的 `authErrText` 追加四条文案**

在 `"govern_event_conflict"` 那一行之后追加：

```go
	"tag_not_governor":    "只有治理人（全站名册或圈子治者）能给无标签内容打标签",
	"tag_target_tagged":   "该内容已有标签，改动请走治理提案",
	"tag_links_invalid":   "links 不合法：kind 必须与 target_id 形态一致，且同一 target_id 不得重复",
	"tag_target_not_found": "打标目标不存在或已下架",
```

- [ ] **Step 2: 先写失败测试 `internal/httpapi/tag_test.go`**

测试基座沿用同目录既有约定（`signedRequest` / `sendAuth` / `doJSONMap`、种子身份 `seed`）：

```go
package httpapi

import (
	"encoding/json"
	"net/http"
	"testing"

	"github.com/johocn/base/internal/protocol"
)

// tagSubmitBody 造一个 type=tag 的签名请求体（content_hash 由客户端按容器口径算）。
func tagSubmitBody(t *testing.T, seed testSeed, name, chapter, section string, links []map[string]string) []byte {
	t.Helper()
	itemID, ok := protocol.TagItemID(name, chapter, section)
	if !ok {
		t.Fatalf("TagItemID(%q,%q,%q) 失败", name, chapter, section)
	}
	title := protocol.TagTitle(name, chapter, section)
	// 与服务端同构：按 (kind 固定序, target_id 升序) 物化后拼 "<kind>\t<text>\n"
	order := map[string]int{"course": 0, "lesson": 1, "article": 2, "comment": 3}
	sorted := append([]map[string]string{}, links...)
	for i := 0; i < len(sorted); i++ {
		for j := i + 1; j < len(sorted); j++ {
			if order[sorted[j]["kind"]] < order[sorted[i]["kind"]] ||
				(order[sorted[j]["kind"]] == order[sorted[i]["kind"]] && sorted[j]["target_id"] < sorted[i]["target_id"]) {
				sorted[i], sorted[j] = sorted[j], sorted[i]
			}
		}
	}
	concat := ""
	for _, l := range sorted {
		concat += l["kind"] + "\t" + l["target_id"] + "\n"
	}
	contentHash := protocol.SHA256Hex([]byte(concat))
	sig := signAuthorForTest(t, seed, itemID, contentHash)
	body, err := json.Marshal(map[string]any{
		"type": "tag", "item_id": itemID, "title": title,
		"links": links, "author_sig": sig,
	})
	if err != nil {
		t.Fatal(err)
	}
	return body
}

func TestSubmitTagDirectWrite(t *testing.T) {
	n := newTestNode(t)
	seed := seedGovernor(t, n) // 造一个名册内身份（达门槛的 article）
	if err := n.seedItem(t, "course/c1"); err != nil {
		t.Fatal(err)
	}
	body := tagSubmitBody(t, seed, "甲", "第一章", "第一节",
		[]map[string]string{{"target_id": "course/c1", "kind": "course"}})
	code, out := sendAuth(t, signedRequest(t, seed, http.MethodPost, n.public+"/v1/submit", body))
	if code != 200 {
		t.Fatalf("直打失败 code=%d out=%s", code, out)
	}
	// 物化 segments 行与 tag_links 行各一条
	tagID, _ := protocol.TagItemID("甲", "第一章", "第一节")
	if got := n.tagLinkCount(t, tagID); got != 1 {
		t.Fatalf("tag_links 行数 = %d", got)
	}
}

func TestSubmitTagRejectsNonGovernor(t *testing.T) {
	n := newTestNode(t)
	outsider := seedOutsider(t, n) // 已登记但不在名册、不属于任何圈
	if err := n.seedItem(t, "course/c1"); err != nil {
		t.Fatal(err)
	}
	body := tagSubmitBody(t, outsider, "甲", "第一章", "第一节",
		[]map[string]string{{"target_id": "course/c1", "kind": "course"}})
	code, out := sendAuth(t, signedRequest(t, outsider, http.MethodPost, n.public+"/v1/submit", body))
	if code != 403 || !containsCode(out, "tag_not_governor") {
		t.Fatalf("code=%d out=%s，want 403 tag_not_governor", code, out)
	}
	tagID, _ := protocol.TagItemID("甲", "第一章", "第一节")
	if n.tagLinkCount(t, tagID) != 0 {
		t.Fatal("被拒时不得写 tag_links")
	}
	if n.itemExists(t, tagID) {
		t.Fatal("被拒时不得建条目")
	}
}

func TestSubmitTagRejectsAlreadyTaggedTarget(t *testing.T) {
	n := newTestNode(t)
	seed := seedGovernor(t, n)
	if err := n.seedItem(t, "course/c1"); err != nil {
		t.Fatal(err)
	}
	first := tagSubmitBody(t, seed, "甲", "第一章", "第一节",
		[]map[string]string{{"target_id": "course/c1", "kind": "course"}})
	if code, out := sendAuth(t, signedRequest(t, seed, http.MethodPost, n.public+"/v1/submit", first)); code != 200 {
		t.Fatalf("首打失败 code=%d out=%s", code, out)
	}
	// 另一名治理人对同一目标再打（不同标签）→ 403 tag_target_tagged
	other := seedGovernor2(t, n)
	second := tagSubmitBody(t, other, "乙", "第一章", "第一节",
		[]map[string]string{{"target_id": "course/c1", "kind": "course"}})
	code, out := sendAuth(t, signedRequest(t, other, http.MethodPost, n.public+"/v1/submit", second))
	if code != 403 || !containsCode(out, "tag_target_tagged") {
		t.Fatalf("code=%d out=%s，want 403 tag_target_tagged", code, out)
	}
}

func TestSubmitTagRejectsGroupEventTarget(t *testing.T) {
	n := newTestNode(t)
	seed := seedGovernor(t, n)
	if err := n.seedEvent(t, "g1", "group.v1"); err != nil {
		t.Fatal(err)
	}
	body := tagSubmitBody(t, seed, "甲", "第一章", "第一节",
		[]map[string]string{{"target_id": "comment/" + "0123456789abcdef0123456789abcdef", "kind": "comment"}})
	code, out := sendAuth(t, signedRequest(t, seed, http.MethodPost, n.public+"/v1/submit", body))
	if code != 400 || !containsCode(out, "tag_target_not_found") {
		t.Fatalf("code=%d out=%s，want 400 tag_target_not_found", code, out)
	}
}

func TestSubmitTagRejectsTitleMismatchAndBadLinks(t *testing.T) {
	n := newTestNode(t)
	seed := seedGovernor(t, n)
	if err := n.seedItem(t, "course/c1"); err != nil {
		t.Fatal(err)
	}
	base := tagSubmitBody(t, seed, "甲", "第一章", "第一节",
		[]map[string]string{{"target_id": "course/c1", "kind": "course"}})
	var m map[string]any
	if err := json.Unmarshal(base, &m); err != nil {
		t.Fatal(err)
	}
	m["title"] = "甲 · 第一章 · 第二节" // 与 item_id 重建值不等
	bad, _ := json.Marshal(m)
	if code, out := sendAuth(t, signedRequest(t, seed, http.MethodPost, n.public+"/v1/submit", bad)); code != 400 || !containsCode(out, "item_title_invalid") {
		t.Fatalf("title 不等 code=%d out=%s", code, out)
	}

	m["title"] = protocol.TagTitle("甲", "第一章", "第一节")
	m["links"] = []map[string]string{{"target_id": "course/c1", "kind": "lesson"}} // kind 与形态不一致
	bad, _ = json.Marshal(m)
	if code, out := sendAuth(t, signedRequest(t, seed, http.MethodPost, n.public+"/v1/submit", bad)); code != 400 || !containsCode(out, "tag_links_invalid") {
		t.Fatalf("kind 不一致 code=%d out=%s", code, out)
	}
}
```

> 上面用到的 `seedGovernor` / `seedGovernor2` / `seedOutsider` / `n.seedItem` / `n.seedEvent` / `n.tagLinkCount` / `n.itemExists` / `containsCode` / `signAuthorForTest` **若同包测试基座已有等价物就复用**（先 `grep -n "func newTestNode\|func seed\|func signedRequest" internal/httpapi/*_test.go`）；确实缺的那几个，在 `tag_test.go` 内以测试专用 helper 补（**不得**为非测试代码新增导出）。`tagLinkCount` / `itemExists` 可直接用 `n.st.ListTagLinks(tagID)` / `n.st.GetItem(tagID)` 断言。

- [ ] **Step 3: 跑测试确认失败**

```
go test ./internal/httpapi/ -run 'TestSubmitTag' -count=1
```
Expected: 失败——`type=tag` 现被 `item_type_unsupported` 拒

- [ ] **Step 4: 改 `internal/httpapi/submit.go`**

(a) 常量区追加一个载体常量（放在 `itemTypeQuiz` 之后）：

```go
	itemTypeTag = "tag"
```

(b) `submitReq` 追加字段与链接类型（放在 `AuthorID` 之前）：

```go
// submitLink 是 type=tag 的一条关联（册子 §3.4）。
type submitLink struct {
	TargetID string `json:"target_id"`
	Kind     string `json:"kind"`
}
```

```go
	Links        []submitLink    `json:"links"`
```

(c) 类型判定改成三分支：

```go
	if req.Type != itemTypeArticle && req.Type != itemTypeQuiz && req.Type != itemTypeTag {
		s.writeAuthErr(w, http.StatusBadRequest, "item_type_unsupported")
		return
	}
```

(d) `item_id` 校验分流（替换原来的 `splitSubmitItemID` 调用块）：

```go
	if req.Type == itemTypeTag {
		if _, _, _, ok := protocol.ParseTagItemID(req.ItemID); !ok {
			s.writeAuthErr(w, http.StatusBadRequest, "item_id_invalid")
			return
		}
	} else if _, code := splitSubmitItemID(req.ItemID, req.Type); code != "" {
		s.writeAuthErr(w, http.StatusBadRequest, code)
		return
	}
```

(e) `title` 校验后追加标签重建校验（紧跟在 `validItemTitle` 之后）：

```go
	if req.Type == itemTypeTag {
		name, chapter, section, _ := protocol.ParseTagItemID(req.ItemID)
		if strings.TrimSpace(req.Title) != protocol.TagTitle(name, chapter, section) {
			// title 不是自由字段：它由 item_id 三段重建而来（册子 §3.1）
			s.writeAuthErr(w, http.StatusBadRequest, "item_title_invalid")
			return
		}
	}
```

(f) `links` 规范化 + 物化（放在 `content`/`maxSubmitBytes` 校验之后、限速之前）：

```go
	var tagLinks []store.TagLink
	if req.Type == itemTypeTag {
		links, ok := normalizeSubmitTagLinks(req.Links)
		if !ok {
			s.writeAuthErr(w, http.StatusBadRequest, "tag_links_invalid")
			return
		}
		tagLinks = links
	}
```

在同文件底部追加两个纯函数：

```go
// normalizeSubmitTagLinks 校验并规范化 links（册子 §3.4）：kind 必须与 target_id 形态自洽，
// 同一 target_id 不得重复（tag_links 的主键是 (tag_id,target_id)）。
func normalizeSubmitTagLinks(in []submitLink) ([]store.TagLink, bool) {
	out := make([]store.TagLink, 0, len(in))
	seen := map[string]bool{}
	for _, l := range in {
		kind := protocol.TagKindOfTarget(l.TargetID)
		if kind == "" || kind != l.Kind || seen[l.TargetID] {
			return nil, false
		}
		seen[l.TargetID] = true
		out = append(out, store.TagLink{TargetID: l.TargetID, Kind: kind})
	}
	return out, true
}

// checkTagTargetsExist 逐个校验目标存在性（册子 §3.2）：条目必须在本节点且 state='active'；
// 评论必须是一条本节点已收到的 comment.v1 事件——② 类由此天然被排除（§3.7）。
func (s *Server) checkTagTargetsExist(links []store.TagLink) (bool, error) {
	for _, l := range links {
		if l.Kind == "comment" {
			ok, err := s.st.HasCommentEvent(strings.TrimPrefix(l.TargetID, "comment/"))
			if err != nil {
				return false, err
			}
			if !ok {
				return false, nil
			}
			continue
		}
		it, ok, err := s.st.GetItem(l.TargetID)
		if err != nil {
			return false, err
		}
		if !ok || it.State != "active" {
			return false, nil
		}
	}
	return true, nil
}
```

(g) `content_hash` 计算分流（替换 `contentHash := submissionContentHash(...)` 那一行）：

```go
	var contentHash string
	if req.Type == itemTypeTag {
		// 容器口径（#14 §3.3）：哈希只看物化的 segments 行——与 #25 的 article/quiz 口径不同。
		contentHash = store.SegmentsContentHash(store.MaterializeTagSegments(req.ItemID, tagLinks))
	} else {
		contentHash = submissionContentHash(req.Type, req.BodyMD, req.QuestionJSON)
	}
```

(h) 在 `LookupIdentity` 之后、验签之前插入资格与存在性判定：

```go
	if req.Type == itemTypeTag {
		// 资格（册子 §3.4）：本接口第一次出现「验签通过但仍可能无权写」——判定不可省略、不可配置。
		governors, err := s.st.GovernorSet()
		if err != nil {
			s.writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		if !governors[actor] {
			s.writeAuthErr(w, http.StatusForbidden, "tag_not_governor")
			return
		}
		exists, err := s.checkTagTargetsExist(tagLinks)
		if err != nil {
			s.writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		if !exists {
			s.writeAuthErr(w, http.StatusBadRequest, "tag_target_not_found")
			return
		}
	}
```

(i) 写入分流（替换 `UpsertSubmission` 调用块）：

```go
	if req.Type == itemTypeTag {
		_, err = s.st.UpsertTagSubmission(store.TagSubmission{
			TagID: req.ItemID, Title: title, Links: tagLinks,
			AuthorID: actor, AuthorSig: req.AuthorSig,
		})
	} else {
		created, err = s.st.UpsertSubmission(store.Submission{
			ItemID: req.ItemID, Type: req.Type, Title: title,
			BodyMD: req.BodyMD, QuestionJSON: req.QuestionJSON,
			ContentHash: contentHash, AuthorID: actor, AuthorSig: req.AuthorSig,
		})
	}
	if errors.Is(err, store.ErrItemTaken) {
		s.writeAuthErr(w, http.StatusForbidden, "item_id_taken")
		return
	}
	if errors.Is(err, store.ErrTagTargetTagged) {
		s.writeAuthErr(w, http.StatusForbidden, "tag_target_tagged")
		return
	}
	if err != nil {
		s.writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
```

> `created` 变量需在分支前声明（`var created bool`），响应体里的 `"created": created` 对 tag 路径固定 `false`（直打不区分新建/更新：语义上「标签条目的关联集被设成这一份」）。

- [ ] **Step 5: 跑测试确认通过**

```
go test ./internal/httpapi/ -run 'TestSubmitTag' -count=1 -v
```

- [ ] **Step 6: 同包全量回归（既有 `TestSubmit*` 行为必须逐字不变）+ 提交**

```
go test ./internal/httpapi/ -count=1
```

```
git commit -m "feat(httpapi): POST /v1/submit 支持 type=tag 直打（治理人资格与无标签条件）" -- internal/httpapi/submit.go internal/httpapi/authmw.go internal/httpapi/tag_test.go
```

---

### Task 5: 接收侧回填（`ImportPack`）与跨节点端到端

**Files:**
- Modify: `internal/store/packimport.go`
- Test: `internal/packexport/tag_test.go`

- [ ] **Step 1: `internal/store/packimport.go` 加回填**

(a) 在 `ImportPack` 的 `res := ...` 之后声明收集切片：

```go
	tagIDs := []string{} // 本包内写成功的 `tag/` 前缀条目，循环后在同一事务里回填 tag_links（册子 §3.3）
```

(b) 在 `case "segments":` 分支的 `for _, seg := range ordered { ... }` **之后**、`case "articles":` 之前插入：

```go
			if strings.HasPrefix(e.ItemID, "tag/") {
				tagIDs = append(tagIDs, e.ItemID)
			}
```

(c) 在 `for _, e := range entries { ... }` 循环**之后**、写 `meta.content_version` **之前**插入：

```go
	// 标签条目的 segments 行已入库，据它们把本地 tag_links 幂等回填（册子 §3.3）。
	// 回填不校验目标存在性：评论事件未必已同步，引用允许悬空。
	for _, id := range tagIDs {
		if err := backfillTagLinksTx(tx, id); err != nil {
			return res, fmt.Errorf("store: 回填 tag_links %s: %w", id, err)
		}
	}
```

(d) 顶部 import 追加 `"strings"`。

- [ ] **Step 2: 先写端到端测试 `internal/packexport/tag_test.go`**

结构与同目录既有的 `category_test.go` 同法（导出 → 读 `pack.sqlite` 与 `manifest.Entries` → 另一方 `ImportPack`）。**注意**：`pack.sqlite` **没有 `items` 表**，条目四列从 `res.Manifest.Entries` 取，`segments` 从 `pack.sqlite` 读。

```go
package packexport

import (
	"reflect"
	"testing"

	"github.com/johocn/base/internal/protocol"
	"github.com/johocn/base/internal/store"
)

func TestTagExportImportRoundTrip(t *testing.T) {
	src := newSourceStore(t)
	// 目标内容先入库（导出侧不做存在性校验，但接收侧要能挂上）
	if err := src.putItem(t, "course/c1"); err != nil {
		t.Fatal(err)
	}
	tagID, _ := protocol.TagItemID("甲", "第一章", "第一节")
	if _, err := src.st.UpsertTagSubmission(store.TagSubmission{
		TagID: tagID, Title: protocol.TagTitle("甲", "第一章", "第一节"),
		Links:    []store.TagLink{{TagID: tagID, TargetID: "course/c1", Kind: "course"}},
		AuthorID: "aa", AuthorSig: "sig",
	}); err != nil {
		t.Fatal(err)
	}

	first := src.export(t)
	second := src.export(t)
	if !reflect.DeepEqual(first.packBytes, second.packBytes) {
		t.Fatal("重复导出必须字节一致（AC 7）")
	}
	if got := first.segmentsOf(tagID); !reflect.DeepEqual(got, []store.Segment{
		{ItemID: tagID, Seq: 1, Kind: "course", Text: "course/c1"},
	}) {
		t.Fatalf("包内 segments 行 = %+v", got)
	}
	if v := first.schemaVersion(t); v != 1 {
		t.Fatalf("schema_version = %d, want 1（AC 8）", v)
	}

	dst := newDestStore(t)
	if _, err := dst.st.ImportPack(first.version, first.entries, first.tombstones); err != nil {
		t.Fatal(err)
	}
	got, err := dst.st.ListTagLinks(tagID)
	if err != nil {
		t.Fatal(err)
	}
	want := []store.TagLink{{TagID: tagID, TargetID: "course/c1", Kind: "course"}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("接收侧 tag_links = %+v, want %+v", got, want)
	}
	// 幂等：同一包再入一次不产生重复行
	if _, err := dst.st.ImportPack(first.version, first.entries, first.tombstones); err != nil {
		t.Fatal(err)
	}
	if got, _ := dst.st.ListTagLinks(tagID); !reflect.DeepEqual(got, want) {
		t.Fatalf("重复入库后 = %+v", got)
	}
}
```

> `newSourceStore` / `newDestStore` / `src.export` / `first.segmentsOf` / `first.entries` / `first.tombstones` / `first.version` / `putItem` **全部按同目录既有测试的真实基座改写**（先读 `internal/packexport/` 下现有的 `*_test.go`，逐个对齐名字与签名）；本步骤只允许新增测试文件，**不得改任何生产代码**。

- [ ] **Step 3: 跑测试确认通过（含同包回归）**

```
go test ./internal/packexport/ -count=1 -v
```

- [ ] **Step 4: 全仓门禁 + 提交**

```
go build ./... ; go vet ./... ; go test ./... -count=1
```

```
git commit -m "feat(store): ImportPack 回填 tag_links 并补跨节点端到端测试" -- internal/store/packimport.go internal/packexport/tag_test.go
```

---

### Task 6: 改标走 `edit` 提案（`govern_proposals.links_json` 与载体系分流）

**Files:**
- Modify: `internal/store/schema.go`（DDL + `governColumnMigrations`）
- Modify: `internal/store/govern.go`（`Proposal` / `proposalColumns` / `scanProposal` / `CreateProposal` / `editItemTx`）
- Modify: `internal/httpapi/govern.go`
- Test: `internal/store/tag_edit_test.go`、`internal/httpapi/tag_test.go`（追加两个用例）

- [ ] **Step 1: `internal/store/schema.go` 两处修改**

(a) `govern_proposals` 的建表语句里，`base_content_hash TEXT NOT NULL,` **之后**追加一行：

```go
		links_json        TEXT    NOT NULL DEFAULT '', -- #37 册子 §3.5：tag 型 edit 的载荷（links[] 的规范 JSON）
```

(b) `governColumnMigrations` 末尾追加：

```go
	{"govern_proposals", "links_json", `ALTER TABLE govern_proposals ADD COLUMN links_json TEXT NOT NULL DEFAULT ''`},
```

- [ ] **Step 2: `internal/store/govern.go` 四处同步**

(a) `Proposal` 结构体在 `BodyMD` 之后加：

```go
	LinksJSON       string // 仅 tag 型 Action == GovernActionEdit 时非空（#37 册子 §3.5）
```

(b) `proposalColumns` 在 `body_md` 之后加 `,COALESCE(links_json,'')`（保持与 `scanProposal` 的 Scan 顺序一致）：

```go
const proposalColumns = `proposal_id,action,item_id,proposer_id,reason,title,body_md,COALESCE(links_json,''),base_content_hash,created_at,executed_at,voided_at,executed_result,COALESCE(source_event_id,''),content_version,revoked_rev`
```

(c) `scanProposal` 在扫 `body_md` 之后加一个 `&p.LinksJSON`。

(d) `CreateProposal` 的 INSERT 加列与参数：

```go
	res, err := tx.Exec(`INSERT INTO govern_proposals(action,item_id,proposer_id,reason,title,body_md,links_json,base_content_hash,created_at,content_version,revoked_rev)
		VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
		p.Action, p.ItemID, p.ProposerID, p.Reason, p.Title, p.BodyMD, p.LinksJSON,
		p.BaseContentHash, p.CreatedAt, ver, rev)
```

(e) 追加编码/解码纯函数与 tag 分支（放在 `editItemTx` 之后）：

```go
// EncodeTagLinks 把关联集编成可持久化的规范 JSON（tag 型 edit 的载荷，#37 册子 §3.5）。
func EncodeTagLinks(links []TagLink) (string, error) {
	b, err := json.Marshal(links)
	if err != nil {
		return "", err
	}
	return string(b), nil
}

// DecodeTagLinks 解出关联集；空串按「空关联集」处理（合法：标签可以没有任何关联）。
func DecodeTagLinks(raw string) ([]TagLink, bool) {
	if raw == "" {
		return []TagLink{}, true
	}
	var links []TagLink
	if err := json.Unmarshal([]byte(raw), &links); err != nil {
		return nil, false
	}
	return links, true
}

// editTagItemTx 执行标签条目的关联集改写（#37 册子 §3.5）：全量覆盖 → 重算物化行与 content_hash。
// **author_id / author_sig 两列不动**——标签的归属不随关联集变化而失效（与 article 的 edit 语义不同）。
func editTagItemTx(tx *sql.Tx, p Proposal) (string, error) {
	links, ok := DecodeTagLinks(p.LinksJSON)
	if !ok {
		return "", fmt.Errorf("store: 标签提案 %d 的 links_json 不可解析", p.ProposalID)
	}
	hash, err := replaceTagLinksTx(tx, p.ItemID, links)
	if err != nil {
		return "", err
	}
	if _, err := tx.Exec(`UPDATE items SET content_hash=?,source_rev=?,updated_at=? WHERE item_id=?`,
		hash, hash[:16], nowUTC(), p.ItemID); err != nil {
		return "", fmt.Errorf("store: 改写 items %s: %w", p.ItemID, err)
	}
	return "edited_links", nil
}
```

并在 `editItemTx` 函数体第一行插入分流（`switch` 换成按前缀判定）：

```go
	if strings.HasPrefix(p.ItemID, "tag/") {
		return editTagItemTx(tx, p)
	}
```

- [ ] **Step 3: `internal/httpapi/govern.go` 载体系分流**

(a) `Edit` 载荷类型加字段：

```go
	Links []submitLink `json:"links"`
```

(b) 把原来 `if req.Action == store.GovernActionEdit { ... }` 那块**通用校验**收窄为「载荷存在性」，载体相关校验挪到 `GetItem` 之后：

```go
	if req.Action == store.GovernActionEdit && req.Edit == nil {
		s.writeAuthErr(w, http.StatusBadRequest, "proposal_edit_invalid")
		return
	}
```

(c) 删除原来那行 `if req.Action == store.GovernActionEdit && it.SQLiteTable != "articles" { ... }`，替换为：

```go
	// edit 的载荷按载体系分流（#37 册子 §3.5）：article 走 title+body_md，tag 走 links[]。
	if req.Action == store.GovernActionEdit {
		switch {
		case it.SQLiteTable == "articles":
			if req.Edit.BodyMD == nil || !validItemTitle(req.Edit.Title) {
				s.writeAuthErr(w, http.StatusBadRequest, "proposal_edit_invalid")
				return
			}
			title, bodyMD = strings.TrimSpace(req.Edit.Title), *req.Edit.BodyMD
			if len(title)+len(bodyMD) > maxSubmitBytes {
				s.writeAuthErr(w, http.StatusRequestEntityTooLarge, "proposal_too_large")
				return
			}
		case it.Type == itemTypeTag:
			// tag 型：title 由 item_id 重建故不收；body_md 不适用，给了即拒。
			links, ok := normalizeSubmitTagLinks(req.Edit.Links)
			if !ok || req.Edit.BodyMD != nil || strings.TrimSpace(req.Edit.Title) != "" {
				s.writeAuthErr(w, http.StatusBadRequest, "proposal_edit_invalid")
				return
			}
			linksJSON, err = store.EncodeTagLinks(links)
			if err != nil {
				s.writeError(w, http.StatusInternalServerError, err.Error())
				return
			}
		default:
			s.writeAuthErr(w, http.StatusBadRequest, "proposal_edit_invalid")
			return
		}
	}
```

同时在 `title, bodyMD := "", ""` 那一行旁边加一个 `var linksJSON string`，并在 `CreateProposal` 调用里带上 `LinksJSON: linksJSON`。

(d) 载体系判定用 `it.Type == itemTypeTag`：`itemTypeTag` 常量在 `submit.go` 同包内已定义，直接用。

- [ ] **Step 4: 先写失败测试 `internal/store/tag_edit_test.go`**

```go
package store

import (
	"testing"

	"github.com/johocn/base/internal/protocol"
)

func TestEditTagProposalReplacesLinksAndKeepsAuthor(t *testing.T) {
	s := newTestStore(t)
	if err := s.putItemForTest("course/c1", "course"); err != nil {
		t.Fatal(err)
	}
	if err := s.putItemForTest("course/c2", "course"); err != nil {
		t.Fatal(err)
	}
	tagID, _ := protocol.TagItemID("甲", "第一章", "第一节")
	if _, err := s.UpsertTagSubmission(TagSubmission{
		TagID: tagID, Title: protocol.TagTitle("甲", "第一章", "第一节"),
		Links:    []TagLink{{TagID: tagID, TargetID: "course/c1", Kind: "course"}},
		AuthorID: "aa", AuthorSig: "sig-original",
	}); err != nil {
		t.Fatal(err)
	}
	base, ok, err := s.GetItem(tagID)
	if err != nil || !ok {
		t.Fatalf("GetItem ok=%v err=%v", ok, err)
	}
	linksJSON, err := EncodeTagLinks([]TagLink{
		{TagID: tagID, TargetID: "course/c1", Kind: "course"},
		{TagID: tagID, TargetID: "course/c2", Kind: "course"},
	})
	if err != nil {
		t.Fatal(err)
	}
	id, err := s.CreateProposal(Proposal{
		Action: GovernActionEdit, ItemID: tagID, ProposerID: "bb",
		LinksJSON: linksJSON, BaseContentHash: base.ContentHash,
	})
	if err != nil {
		t.Fatal(err)
	}
	// 2 票门槛：提案人自计 1 票，再补一票
	if _, err := s.CastVote(id, "cc"); err != nil {
		t.Fatal(err)
	}
	got, err := s.ListTagLinks(tagID)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 2 {
		t.Fatalf("生效后 tag_links = %+v，want 2 行（全量覆盖）", got)
	}
	after, ok, err := s.GetItem(tagID)
	if err != nil || !ok {
		t.Fatalf("GetItem ok=%v err=%v", ok, err)
	}
	if after.AuthorID != "aa" || after.AuthorSig != "sig-original" {
		t.Fatalf("归属两列不得变化: %+v", after)
	}
	segs, err := s.ListSegments(tagID)
	if err != nil {
		t.Fatal(err)
	}
	if after.ContentHash != SegmentsContentHash(segs) {
		t.Fatalf("content_hash 未按容器口径重算: %s", after.ContentHash)
	}
}
```

> `CastVote` 的真实签名以 [govern.go](file:///e:/code/base/internal/store/govern.go) 为准（若形如 `CastVote(proposalID int64, voterID string) (VoteResult, error)` 就照用）。

- [ ] **Step 5: 追加 httpapi 侧两个用例到 `internal/httpapi/tag_test.go`**

```go
func TestProposalEditTagCarrier(t *testing.T) {
	n := newTestNode(t)
	// 治理人直打一条标签，再由另一名治理人提 edit 提案改关联集
	// 断言：POST /v1/proposal 返回 201；body_md 非空 → 400 proposal_edit_invalid
}

func TestProposalEditTagRejectsBodyMD(t *testing.T) {
	// 同上但断言错误码
}
```

> 这两个用例的构造照 `TestSubmitTag*` 的方式写（同一基座），**断言必须具体**：`code`、`out` 中的 `code` 字段、以及提案生效后 `n.st.ListTagLinks` 的行数。

- [ ] **Step 6: 跑测试 + 全仓门禁 + 提交**

```
go test ./internal/store/ ./internal/httpapi/ -run 'TestEditTag|TestProposalEditTag' -count=1 -v ; go test ./... -count=1
```

```
git commit -m "feat(govern): edit 载体扩到 tag 型（links_json 载荷，生效后 author 不动）" -- internal/store/schema.go internal/store/govern.go internal/store/tag_edit_test.go internal/httpapi/govern.go internal/httpapi/tag_test.go
```

---

### Task 7: 手机端本地 `tag_links` 派生表（`types.ts` / `repo.ts` / `fakes.ts`）

**Files:**
- Modify: `apps/mobile/src/core/types.ts`
- Modify: `apps/mobile/src/core/repo.ts`
- Modify: `apps/mobile/src/core/fakes.ts`
- Test: 无独立用例（`SqlRepo` 的 SQL 在 Node 下不可测）；本 Task 的行为断言放在 Task 8 的 `tags.test.ts` 里用 `MemoryRepo.applyPack` 覆盖，本 Task 只跑门禁不让既有 18 文件回归。

**口径（照做）:** 本地 `tag_links` 是**派生表**——节点不下发行本身，行只从包里 `tag/*` 条目的物化 `segments` 行重建（`kind` = 行的 `kind`、`target_id` = 行的 `text`，与节点 `MaterializeTagSegments` 同构）。本地表比节点表**少一列 `created_at`**（本地不做审计）。

- [ ] **Step 1: `types.ts` 加 `TagLinkRow`，并给 `MySubmissionRow.type` 加 `'tag'`**

在 `SegmentRow` 之后插入：

```ts
/**
 * 一个标签与一个目标的关联（本地派生表 `tag_links`，#37 册子 §5.1）。
 * **权威在节点**：本地行只是从包里 `tag/*` 条目的 `segments` 行重建出来的只读投影。
 */
export interface TagLinkRow {
  /** `tag/<名称>/<章>/<节>` */
  tagId: string;
  /** `course|lesson|article` 的 `item_id`，或 `comment/<event_id>` */
  targetId: string;
  /** course | lesson | article | comment（与节点侧 kind 同一取值域） */
  kind: string;
}
```

`MySubmissionRow.type` 的联合类型改成：

```ts
  type: 'article' | 'quiz' | 'tag';
```

- [ ] **Step 2: `repo.ts` 的 `SCHEMA_SQL` 追加表与索引**

追加到 `dm_keys` 之后（`SCHEMA_SQL` 末尾）：

```ts
  `CREATE TABLE IF NOT EXISTS tag_links(
     tag_id TEXT NOT NULL, target_id TEXT NOT NULL, kind TEXT NOT NULL,
     PRIMARY KEY(tag_id, target_id))`,
  `CREATE INDEX IF NOT EXISTS idx_tag_links_target ON tag_links(target_id)`,
```

> 首次建库就带上这两条，**不需要** `ensureGroupColumns` 那类补列逻辑（本表是新增表，`CREATE TABLE IF NOT EXISTS` 本身幂等）。

- [ ] **Step 3: `LocalRepo` 接口追加两个方法**

放在 `listSegments` 之后（同一「容器 / 派生行」语义簇）：

```ts
  /**
   * 全部标签关联行，按 `tag_id ASC, kind ASC, target_id ASC`。
   * 标签列表页与「待补标签」反查都用它（本地数据量在 1e3 量级，不做分页）。
   */
  listTagLinks(): Promise<TagLinkRow[]>;
  /** 给定目标集合的关联行（顺序同上）；空数组直接返回 `[]`，不拼 SQL。 */
  listTagLinksOfTargets(targetIds: string[]): Promise<TagLinkRow[]>;
```

`repo.ts` 顶部 `types` 的 import 里加上 `TagLinkRow`。

- [ ] **Step 4: `SqlRepo` 实现两方法**

放在 `listSegments` 实现之后：

```ts
  async listTagLinks(): Promise<TagLinkRow[]> {
    const rows = await this.db.select(
      `SELECT tag_id,target_id,kind FROM tag_links ORDER BY tag_id ASC, kind ASC, target_id ASC`,
    );
    return rows.map(toTagLinkRow);
  }

  async listTagLinksOfTargets(targetIds: string[]): Promise<TagLinkRow[]> {
    if (targetIds.length === 0) return [];
    const marks = targetIds.map(() => '?').join(',');
    const rows = await this.db.select(
      `SELECT tag_id,target_id,kind FROM tag_links WHERE target_id IN (${marks}) ORDER BY tag_id ASC, kind ASC, target_id ASC`,
      targetIds,
    );
    return rows.map(toTagLinkRow);
  }
```

在文件底部 `toSegmentRow` 旁边加映射函数（照抄邻居的写法：`String(r.x ?? '')`）：

```ts
function toTagLinkRow(r: Record<string, unknown>): TagLinkRow {
  return {
    tagId: String(r.tag_id ?? ''),
    targetId: String(r.target_id ?? ''),
    kind: String(r.kind ?? ''),
  };
}
```

- [ ] **Step 5: `SqlRepo.applyPack` —— 墓碑清理 + 从 `segments` 行重建**

(a) 墓碑循环里追加一行（紧跟 `DELETE FROM segments WHERE item_id=?` 之后；**只删 `tag_id` 一侧**——目标被撤下时行留着，由 `linksOf` 悬空跳过）：

```ts
      stmts.push({ sql: `DELETE FROM tag_links WHERE tag_id=?`, params: [t.itemId] });
```

(b) 在既有 `segments` 重建块（先按 `item_id` 删、再插）**之后**追加：

```ts
    // 标签派生表：包里的 tag/* 条目的 segments 行 = (kind, target_id)。与 segments 同一取舍：先删后插。
    const incomingTagIds = new Set(p.segments.filter((s) => s.itemId.startsWith('tag/')).map((s) => s.itemId));
    for (const id of incomingTagIds) {
      stmts.push({ sql: `DELETE FROM tag_links WHERE tag_id=?`, params: [id] });
    }
    for (const s of p.segments) {
      if (!s.itemId.startsWith('tag/')) continue;
      stmts.push({
        sql: `INSERT INTO tag_links(tag_id,target_id,kind) VALUES(?,?,?)
              ON CONFLICT(tag_id,target_id) DO UPDATE SET kind=excluded.kind`,
        params: [s.itemId, s.text, s.kind],
      });
    }
```

(c) `toMySubmissionRow` 的 `type` 映射改成三分支（否则 tag 台账行会被读成 `article`，点开走错页）：

```ts
    type: String(r.type) === 'quiz' ? 'quiz' : String(r.type) === 'tag' ? 'tag' : 'article',
```

- [ ] **Step 6: `fakes.ts` 的 `MemoryRepo` 同步（同语义）**

(a) 字段放在 `segments` 之后：

```ts
  tagLinks = new Map<string, TagLinkRow>(); // `${tagId}\t${targetId}` -> row
```

`fakes.ts` 顶部 `types` 的 import 里加上 `TagLinkRow`。

(b) `applyPack` 的墓碑循环里追加：

```ts
      for (const [k, r] of [...this.tagLinks]) {
        if (r.tagId === t.itemId) this.tagLinks.delete(k);
      }
```

(c) `applyPack` 的 `segments` 重建之后追加：

```ts
    const tagIds = new Set(p.segments.filter((s) => s.itemId.startsWith('tag/')).map((s) => s.itemId));
    for (const [k, r] of [...this.tagLinks]) {
      if (tagIds.has(r.tagId)) this.tagLinks.delete(k);
    }
    for (const s of p.segments) {
      if (!s.itemId.startsWith('tag/')) continue;
      this.tagLinks.set(`${s.itemId}\t${s.text}`, { tagId: s.itemId, targetId: s.text, kind: s.kind });
    }
```

(d) 两个方法放在 `listSegments` 之后：

```ts
  async listTagLinks(): Promise<TagLinkRow[]> {
    return [...this.tagLinks.values()].sort(cmpTagLink);
  }
  async listTagLinksOfTargets(targetIds: string[]): Promise<TagLinkRow[]> {
    const want = new Set(targetIds);
    return [...this.tagLinks.values()].filter((r) => want.has(r.targetId)).sort(cmpTagLink);
  }
```

(e) 模块底部（`sameQuery` 附近）加比较函数（与 SQL 的 `ORDER BY tag_id, kind, target_id` 逐项同义）：

```ts
function cmpTagLink(a: TagLinkRow, b: TagLinkRow): number {
  if (a.tagId !== b.tagId) return a.tagId < b.tagId ? -1 : 1;
  if (a.kind !== b.kind) return a.kind < b.kind ? -1 : 1;
  if (a.targetId !== b.targetId) return a.targetId < b.targetId ? -1 : 1;
  return 0;
}
```

- [ ] **Step 7: 门禁 + 提交**

Run（cwd `apps/mobile`）: `npx tsc --noEmit ; npx vitest run`

Expected: `tsc` 无输出；vitest **18 文件 / 176 项** 全绿（本 Task 只加列与方法，未动既有语义——`sync.test.ts` 的 `applyPack` 用例必须逐字仍过）。

```
git commit -m "feat(mobile): 本地 tag_links 派生表与两个反查方法" -- apps/mobile/src/core/types.ts apps/mobile/src/core/repo.ts apps/mobile/src/core/fakes.ts
```

---

### Task 8: `core/tags.ts`（编码 · 反查 · 待补 · 资格 · 打标）

**Files:**
- Create: `apps/mobile/src/core/tags.ts`
- Test: `apps/mobile/src/core/tags.test.ts`

**编码口径的对齐义务（最重要）:** `encodeTagPathSegment` / `tagKindOfTarget` 是**节点 `internal/protocol/tag.go` 的逐字符镜像**——执行时先 `Read` 那份 Go 源码，把函数体一比一翻成 TS（大小写、转义集合、控制字符的十六进制**大小写**都必须一致）。TS 侧不得增加 Go 侧没有的归一化（本册**不做 NFC**）。

- [ ] **Step 1: 先写失败测试 `apps/mobile/src/core/tags.test.ts`**

```ts
import { describe, expect, it } from 'vitest';

import { utf8 } from '@base/protocol-ts';

import { ensureRegistered } from './comment';
import { FakeHttp, FakePackReader, MemoryFs, MemoryRepo, fakeAdapters } from './fakes';
import {
  TAG_KIND_ORDER,
  canGovern,
  decodeTagPath,
  encodeTagPath,
  encodeTagPathSegment,
  linksOf,
  tagKindOfTarget,
  tagTitle,
  tagsOf,
  untaggedTargets,
  submitTag,
} from './tags';
import type { SubmitOptions } from './submit';
import type { ItemRow, TagLinkRow } from './types';

const BASE = 'https://node.test';
/**
 * 与 `internal/protocol/tag_test.go` 的 `cases` 表**逐行同源**（`raw` = 用例入参、`norm` = 归一化后、
 * `id` = `wantID`）。两边任何一处漂移都会让本册的「同一标签 = 同一 item_id」失效。
 */
const GO_CASES: Array<{ raw: [string, string, string]; norm: [string, string, string]; id: string }> = [
  { raw: ['甲', '第一章', '第一节'], norm: ['甲', '第一章', '第一节'], id: 'tag/甲/第一章/第一节' },
  { raw: ['甲/乙', '第一章', '第一节'], norm: ['甲/乙', '第一章', '第一节'], id: 'tag/甲%2F乙/第一章/第一节' },
  { raw: ['甲\\乙', '第一章', '第一节'], norm: ['甲\\乙', '第一章', '第一节'], id: 'tag/甲%5C乙/第一章/第一节' },
  { raw: ['100%', '第一章', '第一节'], norm: ['100%', '第一章', '第一节'], id: 'tag/100%25/第一章/第一节' },
  { raw: ['  甲  ', ' 第一章 ', '第一节'], norm: ['甲', '第一章', '第一节'], id: 'tag/甲/第一章/第一节' },
];

function json(v: unknown) {
  return { status: 200, body: utf8(JSON.stringify(v)) };
}

function fixture() {
  const http = new FakeHttp();
  const repo = new MemoryRepo();
  const adapters = fakeAdapters(http, new MemoryFs(), new FakePackReader());
  const o: SubmitOptions = { adapters, repo, nodeBaseUrl: BASE };
  return { http, repo, o };
}

function item(itemId: string, type: string, title = itemId): ItemRow {
  return { itemId, source: 'importer', type, title, rev: '1', contentHash: 'h', state: 'active', updatedAt: '' };
}

function link(tagId: string, targetId: string, kind: string): TagLinkRow {
  return { tagId, targetId, kind };
}

describe('标签路径编码（与节点 protocol/tag.go 同口径）', () => {
  it('三段的编码/解码往返，且与 Go 侧期望值逐字一致', () => {
    for (const c of GO_CASES) {
      expect(encodeTagPath(c.raw[0], c.raw[1], c.raw[2])).toBe(c.id);
      expect(decodeTagPath(c.id)).toEqual({ name: c.norm[0], chapter: c.norm[1], section: c.norm[2] });
    }
  });

  it('斜杠、反斜杠、百分号与控制字符都被转义；中文与空格不转义', () => {
    expect(encodeTagPathSegment('a/b')).toBe('a%2Fb');
    expect(encodeTagPathSegment('a\\b')).toBe('a%5Cb');
    expect(encodeTagPathSegment('50%')).toBe('50%25');
    expect(encodeTagPathSegment('甲 乙')).toBe('甲 乙');
    expect(encodeTagPathSegment('a\nb')).toBe('a%0Ab'); // 控制字符用大写十六进制（与 Go 的 %02X 一致）
  });

  it('title = 三段以 ` · ` 连接', () => {
    expect(tagTitle('甲', '第一章', '第一节')).toBe('甲 · 第一章 · 第一节');
  });

  it('decodeTagPath 拒绝非 tag 前缀、段数不符、非十六进制转义，以及重建后不逐字相等的畸形 id', () => {
    expect(decodeTagPath('course/c1')).toBeNull();
    expect(decodeTagPath('tag')).toBeNull();
    expect(decodeTagPath('tag/甲/第一章')).toBeNull();
    expect(decodeTagPath('tag/甲/第一章/第一节/第二节')).toBeNull();
    expect(decodeTagPath('tag//第一章/第一节')).toBeNull();
    expect(decodeTagPath('tag/甲/第一章/%ZZ')).toBeNull();
    // 带空格：段能解出来，但重建值（已 trim）与入参不逐字相等 ⇒ 拒（与 Go 侧同一重建校验）
    expect(decodeTagPath('tag/ 甲 /第一章/第一节')).toBeNull();
  });
});

describe('目标形态判定', () => {
  it('六种合法形态各归其类，其余一律空串', () => {
    const hex32 = '0123456789abcdef0123456789abcdef';
    expect(tagKindOfTarget('course/c1')).toBe('course');
    expect(tagKindOfTarget('article/a1')).toBe('article');
    expect(tagKindOfTarget('course/c1/lesson/l1')).toBe('lesson');
    expect(tagKindOfTarget('course/c1/lesson/l1/article/a1')).toBe('article');
    expect(tagKindOfTarget(`comment/${hex32}`)).toBe('comment');
    expect(tagKindOfTarget('course/c1/lesson/l1/quiz/q1')).toBe('');
    expect(tagKindOfTarget(`dm/${hex32}`)).toBe('');
    expect(tagKindOfTarget('video/v1')).toBe('');
    expect(tagKindOfTarget('group/g1')).toBe('');
    expect(tagKindOfTarget('comment/0123')).toBe('');
    expect(tagKindOfTarget('course/c1/lesson/')).toBe('');
    expect(tagKindOfTarget('tag/甲/章/节')).toBe('');
    expect(tagKindOfTarget('course/')).toBe('');
  });
});

describe('本地反查与待补标签', () => {
  const rows = [
    link('tag/乙/一/一', 'course/c1', 'course'),
    link('tag/甲/一/一', 'course/c1', 'course'),
    link('tag/甲/一/一', 'course/c1/lesson/l1', 'lesson'),
    link('tag/甲/一/一', 'course/c9', 'course'), // 悬空：本地没有 course/c9
  ];

  it('tagsOf 按 target 过滤、按 tag_id 升序', () => {
    expect(tagsOf(rows, 'course/c1').map((r) => r.tagId)).toEqual(['tag/甲/一/一', 'tag/乙/一/一']);
    expect(tagsOf(rows, 'course/c2')).toEqual([]);
  });

  it('linksOf 按 kind 固定序（course<lesson<article<comment）再按 target_id 升序，并跳过悬空目标', () => {
    const known = new Set(['course/c1', 'course/c1/lesson/l1']);
    const got = linksOf(rows, 'tag/甲/一/一', known);
    expect(got.map((r) => r.targetId)).toEqual(['course/c1', 'course/c1/lesson/l1']);
    expect(TAG_KIND_ORDER.course).toBeLessThan(TAG_KIND_ORDER.lesson);
    expect(TAG_KIND_ORDER.lesson).toBeLessThan(TAG_KIND_ORDER.article);
    expect(TAG_KIND_ORDER.article).toBeLessThan(TAG_KIND_ORDER.comment);
  });

  it('untaggedTargets 只认 ① 类三型（course / lesson / article），quiz 与评论永不进「待补」', () => {
    const items = [
      item('course/c1', 'course'),
      item('course/c1/lesson/l1', 'lesson'),
      item('course/c1/lesson/l1/article/a1', 'article'),
      item('quiz/q1', 'quiz'),
      item('article/a2', 'article'),
    ];
    const only = rows.filter((r) => r.targetId !== 'course/c9');
    expect(untaggedTargets(items, only)).toEqual(['course/c1/lesson/l1/article/a1', 'article/a2']);
  });
});

describe('打标提交（复用 #29 台账）', () => {
  it('联网：直发 200 → 台账 sent，且请求体键序与节点同构', async () => {
    const { http, repo, o } = fixture();
    http.postRoutes.set(`${BASE}/v1/identity/register`, json({}));
    http.postRoutes.set(`${BASE}/v1/submit`, json({ item_id: 'tag/甲/第一章/第一节', created: false }));
    const out = await submitTag(o, { name: '甲', chapter: '第一章', section: '第一节', targetId: 'course/c1' });
    expect(out.ledgerState).toBe('sent');
    const wire = JSON.parse(new TextDecoder().decode(http.posted[1]!.body)) as Record<string, unknown>;
    expect(Object.keys(wire)).toEqual(['type', 'item_id', 'title', 'links', 'author_sig']);
    expect(wire.type).toBe('tag');
    expect(wire.title).toBe('甲 · 第一章 · 第一节');
    expect(wire.links).toEqual([{ target_id: 'course/c1', kind: 'course' }]);
    expect((await repo.getSubmission('tag/甲/第一章/第一节'))?.type).toBe('tag');
  });

  it('三段归一化后为空即拒绝，不发请求', async () => {
    const { http, o } = fixture();
    http.postRoutes.set(`${BASE}/v1/identity/register`, json({}));
    const err = await submitTag(o, { name: '甲', chapter: '', section: '第一节', targetId: 'course/c1' }).catch(
      (e: unknown) => e,
    );
    expect((err as Error).message).toBe('请填写章');
    expect(http.posted).toHaveLength(0);
  });

  it('断网：入队 pending（联网后由既有 flushSubmissions 补发）', async () => {
    const { http, repo, o } = fixture();
    http.postRoutes.set(`${BASE}/v1/identity/register`, json({}));
    const real = http.post.bind(http);
    http.post = async (url, body, headers) => {
      if (url.endsWith('/v1/submit')) throw new Error('断网');
      return real(url, body, headers);
    };
    const out = await submitTag(o, { name: '甲', chapter: '第一章', section: '第一节', targetId: 'course/c1' });
    expect(out.ledgerState).toBe('pending');
    expect((await repo.listSubmissions('pending')).map((r) => r.itemId)).toEqual(['tag/甲/第一章/第一节']);
  });
});

describe('治理人资格（名册 ∪ 各圈治者）', () => {
  it('离线（名册拉不到）⇒ false，按钮不显示', async () => {
    const { o } = fixture();
    expect(await canGovern(o)).toBe(false);
  });

  it('名册内 ⇒ true', async () => {
    const { http, o } = fixture();
    http.postRoutes.set(`${BASE}/v1/identity/register`, json({}));
    const ident = await ensureRegistered(o); // 落本地身份（与 core/submit.test.ts 同一套）
    http.routes.set(`${BASE}/v1/contributors`, json({ contributors: [{ id: ident.id, name: '甲', count: 3 }] }));
    expect(await canGovern(o)).toBe(true);
  });

  it('名册外 ⇒ false（圈拉不到时不影响结论）', async () => {
    const { http, o } = fixture();
    http.postRoutes.set(`${BASE}/v1/identity/register`, json({}));
    await ensureRegistered(o);
    http.routes.set(`${BASE}/v1/contributors`, json({ contributors: [{ id: 'b'.repeat(64), name: '乙', count: 9 }] }));
    expect(await canGovern(o)).toBe(false);
  });

  it('名册外但在某个圈的 governors 里 ⇒ true', async () => {
    const { http, repo, o } = fixture();
    http.postRoutes.set(`${BASE}/v1/identity/register`, json({}));
    const ident = await ensureRegistered(o);
    http.routes.set(`${BASE}/v1/contributors`, json({ contributors: [] }));
    await repo.saveGroup({
      groupId: 'c'.repeat(32), name: '圈', creatorId: ident.id, epoch: 1, encrypted: 0,
      rosterRev: 1, memberIdsJson: JSON.stringify([ident.id]), joinedAt: '2026-09-30T00:00:00Z',
    });
    // 圈页路由照 `core/group.test.ts` 里既有的 `GET /v1/group/{32hex}` fixture 造（字段含 `governors`）
    http.routes.set(`${BASE}/v1/group/${'c'.repeat(32)}`, json({
      group_id: 'c'.repeat(32), creator_id: ident.id, epoch: 1, encrypted: 0, roster_rev: 1,
      name: '圈', member_ids: [ident.id], seat_count: 1, governors: [ident.id], envelopes: [], events: [],
    }));
    expect(await canGovern(o)).toBe(true);
  });
});
```

> 上面第三个用例的 `GET /v1/group/{id}` 响应字段名**以 `core/group.ts` 的 `parseGroupPage` 实际读的键为准**（`core/group.test.ts` 里有现成的成功响应体可抄）；照抄后 `canGovern` 必须返回 `true`，**响应体对不上时以 `fetchGroup` 的解析结果为准，不要改 `group.ts`**。若既有 fixture 无论如何都造不出 `governors`，把该用例降级为「单圈抛错不影响名册结论」，并在「执行实况」里记明。

- [ ] **Step 2: 跑测试确认失败**

Run（cwd `apps/mobile`）: `npx vitest run src/core/tags.test.ts`

Expected: FAIL —— `Failed to resolve import "./tags"`

- [ ] **Step 3: 建 `apps/mobile/src/core/tags.ts`**

```ts
/**
 * 统一标签（#37 册子 §5.2）：三元组的编码/解码、按目标反查、待补标签、治理人资格、打标提交。
 *
 * 本文件是 `internal/protocol/tag.go` 的客户端镜像（编码与形态判定必须逐字符同口径）；
 * 只依赖注入的 `Adapters` / `LocalRepo`，不 import 'uni'，因此可在 Node 下用 `core/fakes.ts` 完整测试。
 */
import { myIdentityId, roster } from './contribution';
import { fetchGroup } from './group';
import { enqueueOrSend, type SubmitOptions, type SubmitOutcome } from './submit';
import type { ItemRow, TagLinkRow } from './types';

/** 与节点 `store.tagKindRank` 同一序：物化与渲染都按它（册子 §3.3）。 */
export const TAG_KIND_ORDER: Record<string, number> = { course: 0, lesson: 1, article: 2, comment: 3 };

/**
 * 单段归一化 = 去首尾空白（与节点 `protocol.normalizeTagSegment` 同口径）。
 * **本册不做 NFC/NFD**（2026-09-30 用户定案）：Go 侧无 NFC、仓库不含 `golang.org/x/text`，客户端同步只 trim。
 */
function normalizeTagSegment(s: string): string {
  return s.trim();
}

const TAG_ESCAPE: Record<string, string> = { '/': '%2F', '\\': '%5C', '%': '%25' };

/** 单段转义：`/` `\` `%` 与 C0 控制字符 + DEL 转成 `%XX`（大写十六进制，与 Go 的 `%02X` 一致）。 */
export function encodeTagPathSegment(s: string): string {
  let out = '';
  for (const ch of s) {
    const esc = TAG_ESCAPE[ch];
    if (esc !== undefined) {
      out += esc;
      continue;
    }
    const code = ch.codePointAt(0) ?? 0;
    if (code <= 0x1f || code === 0x7f) {
      out += `%${code.toString(16).toUpperCase().padStart(2, '0')}`;
      continue;
    }
    out += ch;
  }
  return out;
}

/** 单段还原；遇到不完整或非十六进制的 `%xx` 即 `null`（与 Go 侧同样严格，不放宽容忍）。 */
export function decodeTagPathSegment(s: string): string | null {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== '%') {
      out += s[i];
      continue;
    }
    if (i + 3 > s.length) return null;
    const hex = s.slice(i + 1, i + 3);
    if (!/^[0-9a-fA-F]{2}$/.test(hex)) return null;
    out += String.fromCharCode(parseInt(hex, 16)); // 转义只可能产出 < 0x80 的字节
    i += 2;
  }
  return out;
}

/** `tag/<名称>/<章>/<节>`；三段各自**归一化**后转义（与 `TagItemID` 同序同口径）。 */
export function encodeTagPath(name: string, chapter: string, section: string): string {
  return [
    'tag',
    encodeTagPathSegment(normalizeTagSegment(name)),
    encodeTagPathSegment(normalizeTagSegment(chapter)),
    encodeTagPathSegment(normalizeTagSegment(section)),
  ].join('/');
}

/** 三段**归一化后**以 ` · ` 连接（`title` 不是自由字段，由 `item_id` 重建）。 */
export function tagTitle(name: string, chapter: string, section: string): string {
  return `${normalizeTagSegment(name)} · ${normalizeTagSegment(chapter)} · ${normalizeTagSegment(section)}`;
}

/** 解码并**重建校验**：段为空、转义非法、或重建后与入参不逐字相等 ⇒ `null`（册子 §3.1）。 */
export function decodeTagPath(itemId: string): { name: string; chapter: string; section: string } | null {
  if (!itemId.startsWith('tag/')) return null;
  const parts = itemId.slice(4).split('/');
  if (parts.length !== 3) return null;
  const segs: string[] = [];
  for (const p of parts) {
    if (p === '') return null;
    const d = decodeTagPathSegment(p);
    if (d === null) return null;
    segs.push(d);
  }
  if (encodeTagPath(segs[0]!, segs[1]!, segs[2]!) !== itemId) return null;
  return { name: segs[0]!, chapter: segs[1]!, section: segs[2]! };
}

/** 与 `protocol.isHex32` 同一形态：**只认小写** 32 hex（节点侧即如此，`group.v1`/`dm.v1` 的 id 由此被拒）。 */
function isHex32(s: string): boolean {
  return /^[0-9a-f]{32}$/.test(s);
}

/** 由 `target_id` 形态判定 `kind`（与节点 `protocol.TagKindOfTarget` 一一对应）；非法形态返回空串。 */
export function tagKindOfTarget(targetId: string): string {
  const parts = targetId.split('/');
  if (parts.some((p) => p === '')) return '';
  if (parts.length === 2) {
    if (parts[0] === 'comment') return isHex32(parts[1]!) ? 'comment' : '';
    if (parts[0] === 'course') return 'course';
    if (parts[0] === 'article') return 'article';
    return '';
  }
  if (parts.length === 4 && parts[0] === 'course' && parts[2] === 'lesson') return 'lesson';
  if (parts.length === 6 && parts[0] === 'course' && parts[2] === 'lesson' && parts[4] === 'article') return 'article';
  return '';
}

/** 某目标已挂的标签行，按 `tag_id` 升序。 */
export function tagsOf(rows: TagLinkRow[], targetId: string): TagLinkRow[] {
  return rows.filter((r) => r.targetId === targetId).sort((a, b) => (a.tagId < b.tagId ? -1 : a.tagId > b.tagId ? 1 : 0));
}

/** 某标签关联的目标行：按 kind 固定序 + `target_id` 升序；`known` 里没有的目标（悬空引用）静默跳过。 */
export function linksOf(rows: TagLinkRow[], tagId: string, known: Set<string>): TagLinkRow[] {
  return rows
    .filter((r) => r.tagId === tagId && known.has(r.targetId))
    .sort((a, b) => {
      const d = (TAG_KIND_ORDER[a.kind] ?? 99) - (TAG_KIND_ORDER[b.kind] ?? 99);
      if (d !== 0) return d;
      return a.targetId < b.targetId ? -1 : a.targetId > b.targetId ? 1 : 0;
    });
}

/**
 * 「待补标签」清单（纯客户端反查，册子 §4 明确节点侧不做）。
 * **只认 ① 类三型**：quiz 与评论永不进待补（评论是 ① 类但按册子 §5.3 不标「待补」）。
 */
export function untaggedTargets(items: ItemRow[], rows: TagLinkRow[]): string[] {
  const tagged = new Set(rows.map((r) => r.targetId));
  return items
    .filter((i) => (i.type === 'course' || i.type === 'lesson' || i.type === 'article') && !tagged.has(i.itemId))
    .map((i) => i.itemId)
    .sort();
}

/** 打标入参：三元组 + 一个目标（一次直打只标一个目标；多目标由 `edit` 提案生效，册子 §3.5）。 */
export interface TagInput {
  name: string;
  chapter: string;
  section: string;
  targetId: string;
}

/** 打标：复用 #29 的台账与补发（联网直发、断网入队），载荷走 `core/submit.ts` 的 tag 分支。 */
export async function submitTag(o: SubmitOptions, input: TagInput): Promise<SubmitOutcome> {
  const itemId = encodeTagPath(input.name, input.chapter, input.section);
  return enqueueOrSend(o, {
    itemId,
    type: 'tag',
    title: tagTitle(input.name, input.chapter, input.section),
    bodyMd: '',
    questionJson: '',
    links: [{ tagId: itemId, targetId: input.targetId, kind: tagKindOfTarget(input.targetId) }],
  });
}

/**
 * 打标资格（册子 §3.4）：#23 全站名册 ∪ #33 各圈治者集合。
 * **判不出就不给按钮**：名册都拉不到（离线）⇒ false；单圈拉取失败只跳过该圈。
 */
export async function canGovern(o: SubmitOptions): Promise<boolean> {
  const myId = await myIdentityId(o);
  if (myId === '') return false;
  try {
    if ((await roster(o)).some((c) => c.id === myId)) return true;
  } catch {
    return false;
  }
  for (const g of await o.repo.listGroups()) {
    try {
      const page = await fetchGroup(o, g.groupId);
      if (page.group.governors.includes(myId)) return true;
    } catch {
      // 单圈失败不影响其余圈
    }
  }
  return false;
}
```

> `tags.ts` **不 import `@base/protocol-ts`**：签名与哈希一律由 `core/submit.ts` 现算（本册不新增第二条签名路径）。

- [ ] **Step 4: 跑测试确认通过**

Run（cwd `apps/mobile`）: `npx vitest run src/core/tags.test.ts`

Expected: PASS

- [ ] **Step 5: 全量门禁 + 提交**

Run（cwd `apps/mobile`）: `npx tsc --noEmit ; npx vitest run`

Expected: 全绿（文件数 19）

```
git commit -m "feat(mobile): core/tags.ts（编码镜像 · 反查 · 待补 · 资格 · 打标）" -- apps/mobile/src/core/tags.ts apps/mobile/src/core/tags.test.ts
```

---

### Task 9: `core/submit.ts` 扩 `tag` 载体与台账 `links_json`

**Files:**
- Modify: `apps/mobile/src/core/types.ts`（`MySubmissionRow.linksJson`）
- Modify: `apps/mobile/src/core/repo.ts`（`SCHEMA_SQL` 的 `my_submissions` 加列 + 新 `ensureSubmissionColumns` + `saveSubmission` / `listSubmissions` / `getSubmission` / `toMySubmissionRow`）
- Modify: `apps/mobile/src/platform/index.ts`（调用 `ensureSubmissionColumns`）
- Modify: `apps/mobile/src/core/submit.ts`（`SubmitDraft.type` 加 `'tag'`、`links`、`contentHashOf` / `validateDraft` / `buildSubmitBody` / `buildTagPayload` / `writeLedger` / 补发重建草稿）
- Modify: `apps/mobile/src/core/tags.ts`（`submitTag` 的三段本地校验）
- Test: `apps/mobile/src/core/submit.test.ts`（追加两条：tag 载荷与键序、台账 `links_json` 往返补发）

**为什么不复用 `body_md` 存目标:** 补发是从**台账行**重建草稿的（[submit.ts](file:///e:/code/base/apps/mobile/src/core/submit.ts#L281-L288)），台账不存 `links` 就补不出 `content_hash` 与签名。`links_json` 与节点侧 `govern_proposals.links_json` 同一命名与同一 JSON 形态（`[{target_id,kind}]`），不另立第二套。

- [ ] **Step 1: 台账加 `links_json` 列（4 处）**

(a) `types.ts` 的 `MySubmissionRow` 在 `questionJson` 之后加：

```ts
  /** 标签关联的 JSON 文本（`[{target_id,kind}]`）；非 tag 载体恒为空串。补发要从它重建草稿。 */
  linksJson: string;
```

(b) `repo.ts` 的 `SCHEMA_SQL`：`my_submissions` 建表语句里 `question_json TEXT NOT NULL,` 之后加一行

```ts
     links_json TEXT NOT NULL DEFAULT '',
```

(c) `repo.ts` 新增存量库补列函数（紧邻 `ensureGroupColumns`）：

```ts
/**
 * 存量库幂等补列（`my_submissions.links_json`，#37）。
 * `CREATE TABLE IF NOT EXISTS` 对既有表不补列，故与 `ensureGroupColumns` 同一手法。
 */
export async function ensureSubmissionColumns(db: LocalDb): Promise<void> {
  const cols = new Set((await db.select(`PRAGMA table_info(my_submissions)`)).map((r) => String(r.name)));
  if (!cols.has('links_json')) {
    await db.execute(`ALTER TABLE my_submissions ADD COLUMN links_json TEXT NOT NULL DEFAULT ''`);
  }
}
```

(d) `platform/index.ts`：import 加上 `ensureSubmissionColumns`，在 `ensureGroupColumns(db);` 之后加一行

```ts
  await ensureSubmissionColumns(db); // 存量库幂等补 my_submissions.links_json
```

(e) `repo.ts` 的 `SqlRepo` 三处同步：

```ts
  // saveSubmission
      `INSERT INTO my_submissions(item_id,type,title,body_md,question_json,links_json,state,reason,created,queued_at,sent_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(item_id) DO UPDATE SET type=excluded.type,title=excluded.title,body_md=excluded.body_md,
         question_json=excluded.question_json,links_json=excluded.links_json,state=excluded.state,reason=excluded.reason,
         created=excluded.created,queued_at=excluded.queued_at,sent_at=excluded.sent_at`,
      [row.itemId, row.type, row.title, row.bodyMd, row.questionJson, row.linksJson, row.state, row.reason, row.created, row.queuedAt, row.sentAt],
```

```ts
  // listSubmissions 的 cols 与 getSubmission 的 SELECT 都加上 links_json
    const cols = `item_id,type,title,body_md,question_json,links_json,state,reason,created,queued_at,sent_at`;
```

```ts
  // toMySubmissionRow
    linksJson: String(r.links_json ?? ''),
```

- [ ] **Step 2: 跑既有用例，确认台账改动没打破别的**

Run（cwd `apps/mobile`）: `npx vitest run`

Expected: 全绿（19 文件）。`core/fakes.ts` 的 `MemoryRepo` **无需改动**（它按对象存行，字段自动带上）。

- [ ] **Step 3: 追加两条用例到 `apps/mobile/src/core/submit.test.ts`**

```ts
describe('标签载体', () => {
  it('键序固定为 type→item_id→title→links→author_sig，且 content_hash 走物化文本', () => {
    const draft: SubmitDraft = {
      itemId: 'tag/甲/第一章/第一节', type: 'tag', title: '甲 · 第一章 · 第一节', bodyMd: '', questionJson: '',
      links: [
        { tagId: 'tag/甲/第一章/第一节', targetId: 'course/c1/lesson/l1', kind: 'lesson' },
        { tagId: 'tag/甲/第一章/第一节', targetId: 'course/c1', kind: 'course' },
      ],
    };
    // 物化序 = kind 固定序（course < lesson）→ target 升序，与节点 store.MaterializeTagSegments 同构
    expect(contentHashOf(draft)).toBe(sha256Hex(utf8('course\tcourse/c1\nlesson\tcourse/c1/lesson/l1\n')));
    const wire = decodeUtf8(buildTagPayload(draft.itemId, draft.title, draft.links!, 'ff'.repeat(64)));
    expect(wire).toBe(
      '{"type":"tag","item_id":"tag/甲/第一章/第一节","title":"甲 · 第一章 · 第一节",' +
        '"links":[{"target_id":"course/c1","kind":"course"},{"target_id":"course/c1/lesson/l1","kind":"lesson"}],' +
        '"author_sig":"' + 'ff'.repeat(64) + '"}',
    );
  });

  it('断网入队 → 台账存下 links_json → 补发时草稿可完整重建', async () => {
    const { http, repo, o } = fixture();
    http.postRoutes.set(`${BASE}/v1/identity/register`, json({}));
    const state = gateSubmit(http); // 与既有用例同一开关
    await enqueueOrSend(o, {
      itemId: 'tag/甲/第一章/第一节', type: 'tag', title: '甲 · 第一章 · 第一节', bodyMd: '', questionJson: '',
      links: [{ tagId: 'tag/甲/第一章/第一节', targetId: 'course/c1', kind: 'course' }],
    });
    const row = await repo.getSubmission('tag/甲/第一章/第一节');
    expect(row?.type).toBe('tag');
    expect(row?.linksJson).toBe('[{"target_id":"course/c1","kind":"course"}]');

    state.offline = false;
    http.postRoutes.set(`${BASE}/v1/submit`, json({ item_id: 'tag/甲/第一章/第一节', created: false }));
    const res = await flushSubmissions(o);
    expect(res.sent).toBe(1);
    const wire = JSON.parse(decodeUtf8(http.posted.at(-1)!.body)) as { links: unknown };
    expect(wire.links).toEqual([{ target_id: 'course/c1', kind: 'course' }]);
  });
});
```

- [ ] **Step 4: 跑测试确认失败**

Run（cwd `apps/mobile`）: `npx vitest run src/core/submit.test.ts`

Expected: FAIL —— `buildTagPayload` 不存在 / `type` 不含 `'tag'`

- [ ] **Step 5: 改 `apps/mobile/src/core/submit.ts`**

(a) 顶部 import 加类型：

```ts
import type { MySubmissionRow, TagLinkRow } from './types';
```

(b) `SubmitDraft` 加 tag 与 links（放在 `questionJson` 之后）：

```ts
  /** tag 专有：本次直打要建立的关联集（其余载体不传）。 */
  links?: TagLinkRow[];
```

`type` 联合类型改成：

```ts
  type: 'article' | 'quiz' | 'tag';
```

(c) `contentHashOf` 前面加物化与排序（**不 import `core/tags.ts`，避免模块环**）：

```ts
/** kind 固定序：与 `core/tags.ts` 的 `TAG_KIND_ORDER`、节点 `store.tagKindRank` 同序。 */
const TAG_KIND_RANK: Record<string, number> = { course: 0, lesson: 1, article: 2, comment: 3 };

/** 按 (kind 固定序, target_id 升序) 排序——物化与请求体都用这一份。 */
function sortTagLinks(links: TagLinkRow[]): TagLinkRow[] {
  return [...links].sort((a, b) => {
    const d = (TAG_KIND_RANK[a.kind] ?? 99) - (TAG_KIND_RANK[b.kind] ?? 99);
    if (d !== 0) return d;
    return a.targetId < b.targetId ? -1 : a.targetId > b.targetId ? 1 : 0;
  });
}

/** 物化文本：`"<kind>\t<target_id>\n"`——与节点 `store.MaterializeTagSegments` 逐字同构。 */
export function materializeTagText(links: TagLinkRow[]): string {
  return sortTagLinks(links)
    .map((l) => `${l.kind}\t${l.targetId}\n`)
    .join('');
}
```

(d) `contentHashOf` 改为三分支：

```ts
export function contentHashOf(draft: SubmitDraft): string {
  if (draft.type === 'tag') {
    // 容器口径（#14 §3.3）：哈希只看物化的 segments 行，与 article/quiz 的「取正文」口径不同。
    return sha256Hex(utf8(materializeTagText(draft.links ?? [])));
  }
  return sha256Hex(utf8(draft.type === 'quiz' ? draft.questionJson : draft.bodyMd));
}
```

(e) `buildQuizPayload` 之后加：

```ts
/** `tag` 请求体字节。键序固定：type → item_id → title → links → author_sig。 */
export function buildTagPayload(itemId: string, title: string, links: TagLinkRow[], authorSig: string): Uint8Array {
  return utf8(
    JSON.stringify({
      type: 'tag',
      item_id: itemId,
      title,
      links: sortTagLinks(links).map((l) => ({ target_id: l.targetId, kind: l.kind })),
      author_sig: authorSig,
    }),
  );
}
```

(f) `validateDraft` 首行（`title` 检查）**之前**插入 tag 分支：

```ts
  if (draft.type === 'tag') {
    // 三段的逐段文案（「请填写章」）在 `core/tags.ts` 的 submitTag 里给；这里只兜「有目标」这条兜底，
    // 节点还会做完整的形态 + 存在性 + 资格校验（册子 §3.4）。
    if ((draft.links ?? []).length === 0) return { ok: false, message: '缺少打标目标' };
    return { ok: true, message: '' };
  }
```

(g) `buildSubmitBody` 的三分支：

```ts
  if (draft.type === 'tag') return buildTagPayload(draft.itemId, title, draft.links ?? [], sig);
  return draft.type === 'quiz'
    ? buildQuizPayload(draft.itemId, title, draft.questionJson, sig)
    : buildArticlePayload(draft.itemId, title, draft.bodyMd, sig);
```

(h) `writeLedger` 的 `saveSubmission({...})` 里加一行：

```ts
    linksJson: draft.type === 'tag' ? JSON.stringify(sortTagLinks(draft.links ?? []).map((l) => ({ target_id: l.targetId, kind: l.kind }))) : '',
```

(i) `runFlushSubmissions` 重建草稿处（[submit.ts](file:///e:/code/base/apps/mobile/src/core/submit.ts#L282-L288)）加一行：

```ts
      links: row.type === 'tag' ? decodeLedgerLinks(row.itemId, row.linksJson) : undefined,
```

并在文件底部（`runFlushSubmissions` 之后）加：

```ts
/** 台账 `links_json` → 草稿 `links`；空串或解析失败按空数组（节点会拒，不会写出错数据）。 */
function decodeLedgerLinks(tagId: string, raw: string): TagLinkRow[] {
  if (raw === '') return [];
  try {
    const arr = JSON.parse(raw) as Array<{ target_id?: string; kind?: string }>;
    if (!Array.isArray(arr)) return [];
    return arr.map((l) => ({ tagId, targetId: String(l.target_id ?? ''), kind: String(l.kind ?? '') }));
  } catch {
    return [];
  }
}
```

- [ ] **Step 6: `core/tags.ts` 的 `submitTag` 加三段本地校验**

(a) import 补上错误类与常量：

```ts
import { SubmitError, enqueueOrSend, type SubmitOptions, type SubmitOutcome } from './submit';
```

(b) 文件顶部（`TAG_KIND_ORDER` 之后）加：

```ts
/** 三元组单段的 rune 上限（与节点 `protocol.TagSegmentMaxRunes` 同值）。 */
export const TAG_SEGMENT_MAX_RUNES = 64;
```

(c) `submitTag` 改成先校后发（**文案与字段一一对应**，测试依赖它）：

```ts
export async function submitTag(o: SubmitOptions, input: TagInput): Promise<SubmitOutcome> {
  const labels = ['名称', '章', '节'];
  const segs = [input.name.trim(), input.chapter.trim(), input.section.trim()];
  for (let i = 0; i < 3; i++) {
    if (segs[i] === '') throw new SubmitError('client', `请填写${labels[i]}`);
    if ([...segs[i]!].length > TAG_SEGMENT_MAX_RUNES) {
      throw new SubmitError('client', `${labels[i]}不能超过 ${TAG_SEGMENT_MAX_RUNES} 个字`);
    }
  }
  const kind = tagKindOfTarget(input.targetId);
  if (kind === '') throw new SubmitError('client', '打标目标形态不合法');
  const itemId = encodeTagPath(segs[0]!, segs[1]!, segs[2]!);
  return enqueueOrSend(o, {
    itemId,
    type: 'tag',
    title: tagTitle(segs[0]!, segs[1]!, segs[2]!),
    bodyMd: '',
    questionJson: '',
    links: [{ tagId: itemId, targetId: input.targetId, kind }],
  });
}
```

- [ ] **Step 7: 全量门禁 + 提交**

Run（cwd `apps/mobile`）: `npx tsc --noEmit ; npx vitest run ; npm run build:h5`

Expected: 全绿（19 文件，`submit.test.ts` +2 项）；`build:h5` 通过。

```
git commit -m "feat(mobile): 投稿编排扩 tag 载体与台账 links_json" -- apps/mobile/src/core/types.ts apps/mobile/src/core/repo.ts apps/mobile/src/core/submit.ts apps/mobile/src/core/submit.test.ts apps/mobile/src/core/tags.ts apps/mobile/src/platform/index.ts
```

---

### Task 10: 手机端标签三页与四类内容页入口

**Files:**
- Create: `apps/mobile/src/pages/tag/list.vue`
- Create: `apps/mobile/src/pages/tag/detail.vue`
- Create: `apps/mobile/src/pages/tag/apply.vue`
- Modify: `apps/mobile/src/pages.json`（注册三页，**不动 `tabBar`**）
- Modify: `apps/mobile/src/pages/mine/mine.vue`（新增一组「标签」入口）
- Modify: `apps/mobile/src/pages/course/detail.vue`（课程 + 逐课时标签区）
- Modify: `apps/mobile/src/pages/article/article.vue`（文章标签区）
- Modify: `apps/mobile/src/pages/comment/comment.vue`（**仅在已有标签时**逐条显示）
- Modify: `apps/mobile/src/pages/myitems/myitems.vue`（`tag` 行走标签详情）

**口径（spec §3.6 / §5.3，照做）:**

| 项 | 规则 |
| --- | --- |
| 标签页入口 | 挂在「我的」页新增一组；**不动四 tab、不动 `tabBar` 图标** |
| 「待补标签」 | **只**在 `course` / `lesson` / `article` 三类页显示，且**仅治理人**（`canGovern` 为真）可见；评论**永不**标「待补」 |
| 补标签 | 只有「无标签 + 治理人」时出现；有标签时该位置改显「已有标签，改动需提案」→ 跳既有治理页（**不新开写面**） |
| ② 类 | 小组页 / 私信页**不加任何标签入口**（本任务不碰 `pages/group`、`pages/dm`） |
| 目标点击 | 标签详情里的关联目标可点回内容页；`lesson` 目标回到它所属课程详情页，`comment` 目标切到评论 tab 并锚定该事件（评论事件不在本地内容表里，故其标题显示为事件号短码 `评论 0123abcd`） |

- [ ] **Step 1: 新建 `apps/mobile/src/pages/tag/list.vue`**

```vue
<template>
  <view class="wrap">
    <text class="title">全部标签</text>
    <text v-if="error" class="error">{{ error }}</text>
    <text v-if="!error && rows.length === 0" class="hint">还没有标签</text>
    <view v-for="r in rows" :key="r.itemId" class="card" @click="open(r.itemId)">
      <text class="t">{{ r.title || r.itemId }}</text>
      <text class="meta">{{ r.itemId }}</text>
    </view>
  </view>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import { onShow } from '@dcloudio/uni-app';

import type { ItemRow } from '../../core/types';
import { bootstrap } from '../../platform';

const rows = ref<ItemRow[]>([]);
const error = ref('');

// onShow 而不是 onLoad：从详情页或补标签页返回后条数可能已变
onShow(async () => {
  error.value = '';
  try {
    const { repo } = await bootstrap();
    rows.value = (await repo.listItems())
      .filter((i) => i.type === 'tag')
      .sort((a, b) => (a.itemId < b.itemId ? -1 : a.itemId > b.itemId ? 1 : 0));
  } catch (e) {
    error.value = (e as Error).message;
  }
});

function open(tagId: string) {
  uni.navigateTo({ url: `/pages/tag/detail?tagId=${encodeURIComponent(tagId)}` });
}
</script>

<style>
.wrap { padding: 16px; }
.title { display: block; font-size: 20px; font-weight: 600; margin-bottom: 12px; }
.card { border: 1px solid #eeeeee; border-radius: 8px; padding: 10px; margin-bottom: 10px; }
.t { display: block; font-size: 15px; }
.meta { display: block; color: #888888; font-size: 12px; }
.hint { color: #888888; font-size: 13px; }
.error { display: block; color: #c53030; font-size: 13px; }
</style>
```

> 排序口径与节点 `ListTagLinks` / 物化 `segments` 的 `tag_id` 序一致（`item_id` 升序），保证同一批数据两端渲染序相同。

- [ ] **Step 2: 新建 `apps/mobile/src/pages/tag/detail.vue`**

```vue
<template>
  <view class="wrap">
    <text v-if="error" class="error">{{ error }}</text>
    <block v-else>
      <text class="title">{{ title || tagId }}</text>
      <text class="meta">{{ tagId }}</text>
      <text v-if="groups.length === 0" class="hint">这个标签还没有关联内容</text>
      <block v-for="g in groups" :key="g.kind">
        <text class="group">{{ kindLabel(g.kind) }}（{{ g.rows.length }}）</text>
        <view v-for="r in g.rows" :key="r.targetId" class="row" @click="openTarget(r)">
          <text class="t">{{ r.title }}</text>
          <text class="meta">{{ r.targetId }}</text>
        </view>
      </block>
    </block>
  </view>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import { onLoad } from '@dcloudio/uni-app';

import { setPendingTarget } from '../../core/comment';
import { linksOf } from '../../core/tags';
import type { TagLinkRow } from '../../core/types';
import { bootstrap } from '../../platform';

interface TargetVM {
  targetId: string;
  kind: string;
  title: string;
}
interface GroupVM {
  kind: string;
  rows: TargetVM[];
}

const KIND_LABEL: Record<string, string> = { course: '课程', lesson: '课时', article: '文章', comment: '评论' };

const tagId = ref('');
const title = ref('');
const groups = ref<GroupVM[]>([]);
const error = ref('');

onLoad(async (query) => {
  const raw = String((query as Record<string, string> | undefined)?.tagId ?? '');
  tagId.value = raw;
  try {
    const { repo } = await bootstrap();
    const alt = decodedId(raw);
    const row = (await repo.getItem(raw)) ?? (alt === raw ? null : await repo.getItem(alt));
    if (row) {
      tagId.value = row.itemId;
      title.value = row.title || row.itemId;
    }
    // `known` = 本地能定位到标题的目标集合。条目走 `items`；**评论事件不在本地内容表里**
    // （评论页是实时从节点拉的），但既然关联行已同步下来，就一并放行、标题退化为事件号短码；
    // 其余查不到的目标按悬空引用静默跳过（册子 §3.2）。
    const links = await repo.listTagLinks();
    const known = new Set(await repo.listLocalItemIds());
    for (const l of links) if (l.kind === 'comment') known.add(l.targetId);
    const acc: GroupVM[] = [];
    for (const l of linksOf(links, tagId.value, known)) {
      const t = await repo.getItem(l.targetId);
      const vm: TargetVM = { targetId: l.targetId, kind: l.kind, title: t?.title || shortTarget(l) };
      const last = acc[acc.length - 1];
      if (last && last.kind === l.kind) last.rows.push(vm);
      else acc.push({ kind: l.kind, rows: [vm] });
    }
    groups.value = acc;
  } catch (e) {
    error.value = (e as Error).message;
  }
});

function kindLabel(kind: string): string {
  return KIND_LABEL[kind] ?? kind;
}

/** 评论事件不在本地内容表里，标题退化为事件号短码（`comment/<32hex>` → `评论 0123abcd`） */
function shortTarget(l: TagLinkRow): string {
  return l.kind === 'comment' ? `评论 ${(l.targetId.split('/')[1] ?? '').slice(0, 8)}` : l.targetId;
}

function openTarget(r: TargetVM): void {
  const parts = r.targetId.split('/');
  if (r.kind === 'article') {
    uni.navigateTo({ url: `/pages/article/article?itemId=${encodeURIComponent(r.targetId)}` });
    return;
  }
  if (r.kind === 'course') {
    uni.navigateTo({ url: `/pages/course/detail?courseId=${encodeURIComponent(r.targetId)}` });
    return;
  }
  if (r.kind === 'lesson') {
    // 课时没有独立页面：回到它所属课程（课时在课程页展开）
    uni.navigateTo({ url: `/pages/course/detail?courseId=${encodeURIComponent(`course/${parts[1] ?? ''}`)}` });
    return;
  }
  if (r.kind === 'comment') {
    setPendingTarget(r.targetId);
    uni.switchTab({ url: '/pages/comment/comment' });
    return;
  }
  uni.showToast({ title: '暂不支持的类型', icon: 'none' });
}

/** 页面间传参在个别机型上会保留百分号编码，按原样查不到就按解码后再查 */
function decodedId(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}
</script>

<style>
.wrap { padding: 16px; }
.title { display: block; font-size: 20px; font-weight: 600; }
.meta { display: block; color: #888888; font-size: 12px; margin-bottom: 12px; }
.group { display: block; margin: 14px 0 6px; color: #888888; font-size: 13px; }
.row { padding: 10px 0; border-bottom: 1px solid #f2f2f2; }
.t { font-size: 15px; }
.hint { color: #888888; font-size: 13px; }
.error { display: block; color: #c53030; font-size: 13px; }
</style>
```

- [ ] **Step 3: 新建 `apps/mobile/src/pages/tag/apply.vue`**

```vue
<template>
  <view class="wrap">
    <text class="title">补标签</text>
    <text class="target">{{ targetLabel }}</text>
    <text v-if="!allowed" class="warn">本机身份不在治理人名册、也不在任何圈子治者内：提交会被节点拒绝（403 tag_not_governor）。</text>

    <view class="field">
      <text class="label">名称</text>
      <input v-model="name" class="input" placeholder="必填，≤ 64 字" />
    </view>
    <view class="field">
      <text class="label">章</text>
      <input v-model="chapter" class="input" placeholder="必填，≤ 64 字" />
    </view>
    <view class="field">
      <text class="label">节</text>
      <input v-model="section" class="input" placeholder="必填，≤ 64 字" />
    </view>

    <text class="hint">三段组成标签「名称 · 章 · 节」，三段都必填；三段完全相同即同一个标签（不会重复建条目）。</text>

    <text v-if="error" class="error">{{ error }}</text>
    <text v-if="notice" class="notice">{{ notice }}</text>
    <button class="submit" :disabled="busy" @click="submit">{{ busy ? '提交中…' : '提交' }}</button>
  </view>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import { onLoad } from '@dcloudio/uni-app';

import { canGovern, submitTag, tagKindOfTarget } from '../../core/tags';
import type { SubmitOptions } from '../../core/submit';
import { bootstrap } from '../../platform';

const KIND_LABEL: Record<string, string> = { course: '课程', lesson: '课时', article: '文章', comment: '评论' };

const target = ref('');
const kind = ref('');
const targetLabel = ref('');
const allowed = ref(false);
const name = ref('');
const chapter = ref('');
const section = ref('');
const busy = ref(false);
const error = ref('');
const notice = ref('');

onLoad(async (query) => {
  const q = (query as Record<string, string> | undefined) ?? {};
  target.value = String(q.target ?? '');
  kind.value = String(q.kind ?? '') || tagKindOfTarget(target.value);
  try {
    const { opts, repo } = await bootstrap();
    const o: SubmitOptions = { adapters: opts.adapters, repo, nodeBaseUrl: opts.nodeBaseUrl };
    const t = await repo.getItem(target.value);
    targetLabel.value = `给${KIND_LABEL[kind.value] ?? '内容'}「${t?.title || target.value}」补标签`;
    allowed.value = await canGovern(o);
  } catch (e) {
    error.value = (e as Error).message;
  }
});

async function submit() {
  error.value = '';
  notice.value = '';
  busy.value = true;
  try {
    const { opts, repo } = await bootstrap();
    const out = await submitTag(
      { adapters: opts.adapters, repo, nodeBaseUrl: opts.nodeBaseUrl },
      { name: name.value, chapter: chapter.value, section: section.value, targetId: target.value },
    );
    if (out.ledgerState === 'sent') {
      uni.showToast({ title: out.created ? '已打标' : '已更新', icon: 'success' });
      setTimeout(() => uni.navigateBack(), 600);
      return;
    }
    // 未送达：pending 会自动补发，failed 需回「我的条目」删除后重投
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
.title { display: block; font-size: 20px; font-weight: 600; margin-bottom: 8px; }
.target { display: block; color: #444444; font-size: 14px; margin-bottom: 12px; }
.warn { display: block; color: #c05621; font-size: 12px; margin-bottom: 12px; }
.field { margin-bottom: 14px; }
.label { display: block; font-size: 14px; color: #666666; margin-bottom: 6px; }
.input { border: 1px solid #eeeeee; border-radius: 6px; padding: 8px; font-size: 14px; }
.hint { display: block; font-size: 12px; color: #999999; margin-bottom: 12px; }
.error { display: block; color: #c53030; font-size: 13px; margin: 8px 0; }
.notice { display: block; color: #b7791f; font-size: 13px; margin: 8px 0; }
.submit { margin-top: 16px; background: #2b6cb0; color: #ffffff; }
</style>
```

> 三段校验与 `title` 重建都在 `core/tags.ts` 的 `submitTag` 里（Task 9 Step 6），页面只负责取值与提示——**不在页面里复制一份校验**。

- [ ] **Step 4: `pages.json` 注册三页（不动 `tabBar`）**

把 `pages/dm/chat` 那一项末尾的 `}` 改成 `},`，并在其之后追加：

```json
    {
      "path": "pages/tag/list",
      "style": { "navigationBarTitleText": "全部标签" }
    },
    {
      "path": "pages/tag/detail",
      "style": { "navigationBarTitleText": "标签" }
    },
    {
      "path": "pages/tag/apply",
      "style": { "navigationBarTitleText": "补标签" }
    }
```

`tabBar.list` **一字不改**（仍是 `course` / `circle` / `comment` / `mine` 四项）。

- [ ] **Step 5: `pages/mine/mine.vue` 新增「标签」入口组**

在 `<text class="group">私信</text>` 那一组（含 `好友与私信`）之后插入：

```html
    <text class="group">标签</text>
    <navigator url="/pages/tag/list" class="link">全部标签</navigator>
```

其余不动（`stats` / `pendingText` / `rosterText` 与 `onShow` 逻辑逐字保留）。

- [ ] **Step 6: `pages/course/detail.vue` 课程与课时的标签区**

(a) 模板 —— `<text class="title">{{ courseTitle }}</text>` 之后插入课程标签区：

```html
        <view class="tags">
          <text v-for="t in courseTags" :key="t.tagId" class="tag" @click="openTag(t.tagId)">{{ tagLabel(t.tagId) }}</text>
          <text v-if="pendingOf(courseId)" class="tag-pending" @click="applyTag(courseId, 'course')">待补标签 · 补标签</text>
          <text v-else-if="courseTags.length > 0" class="tag-note" @click="proposeTag(courseTags[0]!.tagId)">已有标签，改动需提案</text>
        </view>
```

(b) 模板 —— 课时行 `</view>`（`.lesson` 那个 view 的收尾）之后、`<block v-if="expanded === ls.itemId">` 之前插入课时标签区：

```html
          <view class="tags">
            <text v-for="t in lessonTags[ls.itemId] ?? []" :key="t.tagId" class="tag" @click.stop="openTag(t.tagId)">{{ tagLabel(t.tagId) }}</text>
            <text v-if="pendingOf(ls.itemId)" class="tag-pending" @click.stop="applyTag(ls.itemId, 'lesson')">待补标签 · 补标签</text>
            <text v-else-if="(lessonTags[ls.itemId] ?? []).length > 0" class="tag-note" @click.stop="proposeTag(lessonTags[ls.itemId]![0]!.tagId)">已有标签，改动需提案</text>
          </view>
```

> 必须 `@click.stop`：课时行本身绑了 `onLesson`（展开/收起），标签点击不该触发它。

(c) 脚本 —— import 追加：

```ts
import { canGovern, tagsOf, untaggedTargets } from '../../core/tags';
import type { TagLinkRow } from '../../core/types';
```

(d) 脚本 —— `const quizGroups = ref<QuizGroupVM[]>([]);` 之后追加：

```ts
const courseId = ref('');
const courseTags = ref<TagLinkRow[]>([]);
const lessonTags = ref<Record<string, TagLinkRow[]>>({});
const tagTitles = ref<Record<string, string>>({});
const untagged = ref<Set<string>>(new Set());
const governor = ref(false);
```

(e) 脚本 —— `onLoad` 里 `const { repo } = await bootstrap();` 改为 `const { opts, repo } = await bootstrap();`；并在 `lessons.value = acc;` 之后、`loaded.value = true;` 之前追加：

```ts
    courseId.value = course.itemId;
    const links = await repo.listTagLinks();
    const all = await repo.listItems();
    untagged.value = new Set(untaggedTargets(all, links));
    tagTitles.value = Object.fromEntries(all.filter((i) => i.type === 'tag').map((i) => [i.itemId, i.title || i.itemId]));
    courseTags.value = tagsOf(links, course.itemId);
    const byLesson: Record<string, TagLinkRow[]> = {};
    for (const ls of acc) byLesson[ls.itemId] = tagsOf(links, ls.itemId);
    lessonTags.value = byLesson;
    governor.value = await canGovern({ adapters: opts.adapters, repo, nodeBaseUrl: opts.nodeBaseUrl });
```

(f) 脚本 —— `decodedId` 函数之后追加：

```ts
function tagLabel(tagId: string): string {
  return tagTitles.value[tagId] ?? tagId;
}

/** 「待补标签」只在治理人眼里出现；非治理人看不到任何提示（册子 §3.6） */
function pendingOf(id: string): boolean {
  return governor.value && untagged.value.has(id);
}

function openTag(tagId: string) {
  uni.navigateTo({ url: `/pages/tag/detail?tagId=${encodeURIComponent(tagId)}` });
}

function applyTag(targetId: string, kind: string) {
  uni.navigateTo({ url: `/pages/tag/apply?target=${encodeURIComponent(targetId)}&kind=${kind}` });
}

/** 已有标签的内容要改动 = 对该标签提 `edit` 提案（提案粒度是整个关联集，册子 §3.5） */
function proposeTag(tagId: string) {
  uni.navigateTo({ url: `/pages/governance/governance?itemId=${encodeURIComponent(tagId)}` });
}
```

(g) 样式追加：

```css
.tags { display: flex; flex-wrap: wrap; align-items: center; margin: 0 0 10px; }
.tag { padding: 2px 8px; margin: 0 8px 6px 0; background: #ebf8ff; color: #2b6cb0; border-radius: 10px; font-size: 12px; }
.tag-pending { padding: 2px 8px; margin: 0 8px 6px 0; background: #fffaf0; color: #b7791f; border-radius: 10px; font-size: 12px; }
.tag-note { margin: 0 0 6px; color: #888888; font-size: 12px; }
```

- [ ] **Step 7: `pages/article/article.vue` 文章标签区**

(a) 模板 —— `<text class="meta">{{ article?.publishedAt }}</text>` 之后插入：

```html
      <view class="tags">
        <text v-for="t in articleTags" :key="t.tagId" class="tag" @click="openTag(t.tagId)">{{ tagLabel(t.tagId) }}</text>
        <text v-if="pendingTag" class="tag-pending" @click="applyTag">待补标签 · 补标签</text>
        <text v-else-if="articleTags.length > 0" class="tag-note" @click="proposeTag">已有标签，改动需提案</text>
      </view>
```

(b) 脚本 —— import 追加（`computed` 已在既有 import 里，不重复）：

```ts
import { canGovern, tagsOf, untaggedTargets } from '../../core/tags';
import type { ArticleRow, TagLinkRow } from '../../core/types';
```

原来的 `import type { ArticleRow } from '../../core/types';` 用上面这一行**替换**（不保留两行）。

(c) 脚本 —— `const siblingQuizzes = ref<SiblingQuiz[]>([]);` 之后追加：

```ts
const articleTags = ref<TagLinkRow[]>([]);
const tagTitles = ref<Record<string, string>>({});
const untagged = ref<Set<string>>(new Set());
const governor = ref(false);
const pendingTag = computed(() => governor.value && untagged.value.has(itemId.value));
```

(d) 脚本 —— `onLoad` 里 `const { repo } = await bootstrap();` 改为 `const { opts, repo } = await bootstrap();`；并在 `siblingQuizzes` 那段 `if (lessonId) { ... }` **之后**、`await repo.markRead(...)` 之前追加：

```ts
    const links = await repo.listTagLinks();
    const all = await repo.listItems();
    untagged.value = new Set(untaggedTargets(all, links));
    tagTitles.value = Object.fromEntries(all.filter((i) => i.type === 'tag').map((i) => [i.itemId, i.title || i.itemId]));
    articleTags.value = tagsOf(links, row.itemId);
    governor.value = await canGovern({ adapters: opts.adapters, repo, nodeBaseUrl: opts.nodeBaseUrl });
```

(e) 脚本 —— `openGovernance` **之后**追加（不要插到既有 JSDoc 与它之间——#36 计划「更正 4」踩过这个坑）：

```ts
function tagLabel(tagId: string): string {
  return tagTitles.value[tagId] ?? tagId;
}

function openTag(tagId: string) {
  uni.navigateTo({ url: `/pages/tag/detail?tagId=${encodeURIComponent(tagId)}` });
}

function applyTag() {
  uni.navigateTo({ url: `/pages/tag/apply?target=${encodeURIComponent(itemId.value)}&kind=article` });
}

function proposeTag() {
  uni.navigateTo({ url: `/pages/governance/governance?itemId=${encodeURIComponent(articleTags.value[0]!.tagId)}` });
}
```

(f) 样式追加（与 course 页同名同值）：

```css
.tags { display: flex; flex-wrap: wrap; align-items: center; margin: 0 0 10px; }
.tag { padding: 2px 8px; margin: 0 8px 6px 0; background: #ebf8ff; color: #2b6cb0; border-radius: 10px; font-size: 12px; }
.tag-pending { padding: 2px 8px; margin: 0 8px 6px 0; background: #fffaf0; color: #b7791f; border-radius: 10px; font-size: 12px; }
.tag-note { margin: 0 0 6px; color: #888888; font-size: 12px; }
```

- [ ] **Step 8: `pages/comment/comment.vue` 逐条标签（**仅在已有标签时**）**

(a) 模板 —— `cmt` 卡片里 `<text class="cmt-text">{{ c.text }}</text>` 之后插入：

```html
        <view v-if="(tagsByEvent[c.eventId] ?? []).length > 0" class="cmt-tags">
          <text v-for="(t, i) in tagsByEvent[c.eventId] ?? []" :key="i" class="cmt-tag">{{ t }}</text>
        </view>
```

> 评论**不标「待补」**、**不给「补标签」**：spec §3.6 明写评论只在已有标签时显示。故此处没有 `pending` 分支、没有跳转。

(b) 脚本 —— `const draft = ref('');` 之后追加：

```ts
/** eventId → 该评论已有标签的标题列表（空数组/无键 = 不显示，不占位） */
const tagsByEvent = ref<Record<string, string[]>>({});
```

(c) 脚本 —— `withText` 函数之后追加：

```ts
/** 逐条挂标签：只查当前可见这几条评论的关联行，不整表扫（仓储侧走 `idx_tag_links_target`） */
async function attachTags(rows: Row[]) {
  if (!opts.value) return;
  const links = await opts.value.repo.listTagLinksOfTargets(rows.map((r) => r.eventId));
  const map: Record<string, string[]> = {};
  for (const l of links) {
    const t = await opts.value.repo.getItem(l.tagId);
    (map[l.targetId] ??= []).push(t?.title || l.tagId);
  }
  tagsByEvent.value = map;
}
```

(d) 脚本 —— `refresh` 里 `list.value = await withText(visible(page.items), opts.value);` 之后加一行 `await attachTags(list.value);`；`loadMore` 里 `list.value = [...list.value, ...(await withText(visible(page.items), opts.value))];` 之后加一行 `await attachTags(list.value);`。

(e) 样式追加：

```css
.cmt-tags { display: flex; flex-wrap: wrap; margin-top: 4px; }
.cmt-tag { padding: 1px 8px; margin: 0 8px 4px 0; background: #ebf8ff; color: #2b6cb0; border-radius: 10px; font-size: 12px; }
```

- [ ] **Step 9: `pages/myitems/myitems.vue` 的 `tag` 行走标签详情**

(a) `open(row)` 整体替换为：

```ts
function open(row: MySubmissionRow) {
  if (row.type === 'tag') {
    uni.navigateTo({ url: `/pages/tag/detail?tagId=${encodeURIComponent(row.itemId)}` });
    return;
  }
  const page = row.type === 'quiz' ? 'quiz/quiz' : 'article/article';
  uni.navigateTo({ url: `/pages/${page}?itemId=${encodeURIComponent(row.itemId)}` });
}
```

(b) 「修改 / 重投更新」对标签行不适用（标签改关联集走提案，`pages/submit` 无 tag 载体的编辑形态）——待发区与已提交区两处各加 `v-if="row.type !== 'tag'"`：

```html
          <text v-if="row.type !== 'tag'" class="act" @click="edit(row)">修改</text>
```

```html
          <text v-if="row.type !== 'tag'" class="act" @click="edit(row)">重投更新</text>
```

（`删除` 按钮两处都保留：`pending` / `failed` 的标签行仍要能删。）

- [ ] **Step 10: 门禁 + 两条发布前硬检查**

Run（cwd `apps/mobile`）: `npx tsc --noEmit ; npx vitest run ; npm run build:h5 ; npm run build:app`

Expected: `tsc` 无输出；vitest 19 文件全绿；两个 build 均 `DONE Build complete`。

用 Grep 工具（**不要用 `Select-String`**）：

1. 在 `apps/mobile/src/pages/**/*.vue` 搜 `\{\{[^}]*\.value` → 期望 **0 处**；
2. 在 `apps/mobile/dist/build/app/app-service.js` 搜 `\.value\.value` → 期望 **0 处**。

- [ ] **Step 11: 提交**

```
git commit -m "feat(mobile): 标签页三页与四类内容页标签入口" -- apps/mobile/src/pages/tag/list.vue apps/mobile/src/pages/tag/detail.vue apps/mobile/src/pages/tag/apply.vue apps/mobile/src/pages.json apps/mobile/src/pages/mine/mine.vue apps/mobile/src/pages/course/detail.vue apps/mobile/src/pages/article/article.vue apps/mobile/src/pages/comment/comment.vue apps/mobile/src/pages/myitems/myitems.vue
```

---

### Task 11: 版本号、全量门禁与文档回填

**Files:**
- Modify: `apps/mobile/src/manifest.json`
- Modify: `docs/README.md`
- Modify: `docs/superpowers/specs/2026-09-29-base-tagging-design.md`

- [ ] **Step 1: 版本号**

先读现值，再**次版本 +1、`versionCode` +1**。计划编写时实测现值是 `0.13.1` / `18`，故落 `0.14.0` / `19`：

`apps/mobile/src/manifest.json`：`"versionName" : "0.14.0"`，`"versionCode" : "19"`。

> 若执行时现值不是 `0.13.1` / `18`（例如并行线又发过补丁），**按现值就地 +1**，并在「执行实况」里记下实际值——不要机械照抄。

- [ ] **Step 2: 全量门禁**

Run（仓库根）: `go build ./... ; go vet ./... ; go test ./... -count=1`

Run（cwd `apps/mobile`）: `npx vitest run ; npx tsc --noEmit ; npm run build:h5 ; npm run build:app`

Expected: Go 三个命令全包 ok（**无 `[build failed]` / `FAIL` 行**）；mobile vitest **19 文件全绿**、`tsc` 无输出、两个 build 均 `DONE Build complete`。

发布前两条硬检查（用 Grep 工具，**不要用 `Select-String`/`-match`**——PowerShell 5.1 按 ANSI 读 UTF-8 会误判 0 命中）：

1. 在 `apps/mobile/src/pages/**/*.vue` 搜 `\{\{[^}]*\.value` → 期望 **0 处**；
2. 在 `apps/mobile/dist/build/app/app-service.js` 搜 `\.value\.value` → 期望 **0 处**。

若 `build:app` 的产物路径与上面不同，先用 Glob 在 `apps/mobile/dist` 下找 `app-service.js` 再核。

- [ ] **Step 3: `docs/README.md` §3 回填**

(a) 第 62 行（#37 册子那一行，表格最后一段「状态」列）改为：

```
已定稿（上游 #14 §0.3 / #25 §0.2 / #27 §0.5 已同步回填；**实施计划 #38 已执行**，完整度见计划「执行实况」；真机验收待人工）
```

(b) 在 §3 表格**第 63 行（#35 计划那一行）之后**追加新行（本册计划 = 第 38 号）：

```
| 38 | `plans/2026-09-30-base-tagging-plan.md` | 治理线第 5 册实施计划（Task 1–12：`internal/protocol/tag.go` 三元组编码·解码·`TagKindOfTarget` 纯函数与表驱动测试、`tag_links` 表与 `internal/store/tag.go`（物化排序 · `replaceTagLinksTx` 直打与提案共用 · 直打条件 · 反查）、`GovernorSet()` 名册 ∪ 各圈治者并集、`ImportPack` 同一事务内回填 `tag_links`、`POST /v1/submit` 的 `type=tag` 分支（资格 · 直打条件 · 目标存在性 · `title` 重建 · 容器口径 `content_hash`）、#27 `edit` 提案扩到 `tag` 载体（新列 `govern_proposals.links_json` 与 `editTagItemTx`）、端到端与跨节点导出/导入测试、手机端 `core/tags.ts` 与本地派生表 `tag_links`、投稿编排扩 `tag` 载体与台账 `links_json`、标签三页与四类内容页入口、版本 `0.14.0` 与发布四步） | 不做节点侧 `ListUntagged`（册子 §4 该行作废，「待补标签」= 客户端反查）；不做 `tagColumnMigrations`（`schemaStatements` 即可）；不做 NFC 归一化（收窄为 `TrimSpace` + 非空 + ≤ 64 rune）；不做标签改名的原地路径；不做标签类跨节点提案同步；不做 ② 类打标；不改内容包规范 v1、不 bump `schema_version`、不加配置项；不做 iOS | 册子 #37 | 已执行（完整度见本计划「执行实况」；真机验收待人工） |
```

> 行号按当前文件；插入位置以「#35 计划那一行之后、`## 4. 依赖顺序` 之前」为准（若并行线又追加过行，按该位置顺延，不要把行号写错）。§4 依赖图与 §5 当前阶段**本册不改**（沿用 #36 计划「更正 5」的同一条口径：那两节随治理线收口统一同步）。

- [ ] **Step 4: 册子新增 `## 0.2 2026-09-30 执行期口径回填`**

在 `docs/superpowers/specs/2026-09-29-base-tagging-design.md` 的 `### 0.1 2026-09-29 初版` 一节之后（`## 1. 目标与判定` 之前）插入：

```markdown
### 0.2 2026-09-30 执行期口径回填

实施计划（`plans/2026-09-30-base-tagging-plan.md`，#38）执行期与本册的六处差异，**结论按本节为准**：

1. **§4 的 `ListUntagged(kind, ids)` 作废**：实施期确认它**没有任何调用点**——「待补标签」的判定完全落在客户端（`core/tags.ts` 的 `untaggedTargets(items, rows)` 用本地 `tag_links` 反查），节点侧不做、也不提供该接口。`idx_tag_links_target` 索引保留（供「这个内容有哪些标签」使用）。
2. **§4 的 `tagColumnMigrations` 不必要**：`tag_links` 是全新表，由 `schemaStatements` 直接建；`tagColumnMigrations` 只对「给已有表补列」有意义。实施期**不新增**该常量。
3. **§5.3 的版本号作废**：该行写的 code `18` 已被 `0.13.1` 占用。本册实际发布 **`0.14.0` / `19`**（独立发布）；四步流程不变。
4. **§3.1 的归一化收窄**：原文「各段先 NFC 归一化、再去首尾空白」中的 **NFC 无法落地**（Go 标准库无 NFC，仓库不含 `golang.org/x/text`，不为一个归一化引入新依赖）。实施口径为「**去首尾空白（Go `strings.TrimSpace` / 客户端 `trim`）+ 归一化后非空 + ≤ 64 rune**；客户端**不**调 `String.prototype.normalize`」。其余（百分号编码、`title` 由 `item_id` 重建、不做 `slug` 校验）逐字不变。
5. **§3.5 的改标载荷存储**：原文只写「载荷为 `links[]`」未定义存储。实施口径为**新列 `govern_proposals.links_json TEXT NOT NULL DEFAULT ''`**（走既有 `governColumnMigrations` 幂等补列），存 `links[]` 的规范 JSON；**不复用 `body_md`**（`body_md` 是 article 载体的语义，混用会让 `scanProposal` 与前端看板都需要按载体二次解释）。空串按「空关联集」解（合法）。
6. **§4 的改动面漏了三处节点侧改动**：① `internal/httpapi/govern.go` 的 `edit` 校验必须从「写死 `it.SQLiteTable != "articles"` 就拒」改成**按载体系分流**（`articles` 走 `title`+`body_md`，`tag` 型走 `links[]`），且载体相关校验要挪到 `GetItem` **之后**；② 资格判定落在 **`internal/store` 的 `GovernorSet() map[string]bool`**（#23 名册 ∪ 各圈 `DeriveSeats().Governors` 的去重并集），`submit.go` 只调用它、不自己拼集合；③ 客户端侧新增本地列 `my_submissions.links_json`（离线标签投稿补发时重建草稿用，见本册 §5.2 的「断网入网 → 联网补发」链路）。
```

- [ ] **Step 5: 提交**

```
git commit -m "chore(release): 升版本 0.14.0/19 并回填标签执行期口径" -- apps/mobile/src/manifest.json docs/README.md docs/superpowers/specs/2026-09-29-base-tagging-design.md
```

---

### Task 12: 发布四步与线上验证

**Files:** 无代码改动（只产出发布物与文档回填）

本任务的**硬前置**：Task 11 Step 2 的全量门禁全绿，且版本号已落 `0.14.0` / `19`。

- [ ] **Step 1: 节点二进制交叉编译与部署**

本册节点侧有实质改动（`tag_links` 表、`type=tag` 分支、`edit` 分流、新列 `links_json`），**必须换二进制**：

```powershell
$env:GOOS="linux"; $env:GOARCH="amd64"; go build -o based-linux-amd64 ./cmd/based
```

先备份旧二进制、记录新旧字节数与 sha256，再上传替换，然后**两个 service 一起重启**（`/opt/base/based` 被 `base.service` 与 `base-cache.service` 共用）：

```powershell
scp based-linux-amd64 root@118.190.217.242:/opt/base/based-0.14.0
ssh me "cp /opt/base/based /opt/base/based.bak-0.13.1 && cp /opt/base/based-0.14.0 /opt/base/based && systemctl restart base && systemctl restart base-cache && systemctl is-active base base-cache"
```

Expected: 两个 `active`。

探活（本册**不新增任何 HTTP 接口**，故用库结构 + 既有路由不回归两条判据）：

```bash
ls /opt/base/data                       # 定位库文件名（沿用前几册实测名）
sqlite3 /opt/base/data/<库文件> "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('tag_links')"
sqlite3 /opt/base/data/<库文件> "PRAGMA table_info(govern_proposals)" | grep links_json
```

Expected: 第一条返回 `tag_links`；第二条含 `links_json`。

```powershell
# 既有路由不回归：不带鉴权头的投稿仍被既有鉴权拒绝（不是 404，也不是 500）
ssh me "curl -s -o /dev/null -w '%{http_code}' -X POST http://127.0.0.1:8080/v1/submit -H 'Content-Type: application/json' -d '{\"type\":\"tag\",\"item_id\":\"tag/a/b/c\",\"title\":\"a · b · c\",\"links\":[],\"author_sig\":\"00\"}'"
```

Expected: 既有鉴权错误码对应的 4xx（沿用前几册实测值）；**不得**是 404（路由缺失）或 500（handler panic）。
若生产节点不使用 8080 端口，以 `systemctl cat base` 的 `ExecStart` 实测端口为准。

回滚：`cp /opt/base/based.bak-0.13.1 /opt/base/based && systemctl restart base && systemctl restart base-cache`。

> 执行期两处已知坑（#36 计划「更正 6」）：① `ssh me 'printf ...'` 传复杂命令会被 PowerShell 5.1 的引号规则 mangling ⇒ 复杂探活**本地写 `.sh` → `scp` → `ssh me "sh /tmp/x.sh"`**；② 该节点上可能有并行线留下的**未被引用的**历史二进制副本，判漂移一律以 `systemctl cat` 的 `ExecStart` 指向为准。

- [ ] **Step 2: 云打包 APK**

```powershell
D:\HBuilderX\cli.exe pack --project e:\code\base\apps\mobile --platform android --android.packagename uni.app.UNI936A667 --android.androidpacktype 3
```

- 记录字节数与 sha256，存到 `apps/mobile/dist/release/apk/base-0.14.0.apk`；
- **证书 SHA1 必须仍是 `19:95:21:ED:09:C0:9C:AD:58:B0:EB:34:D1:B3:CF:D1:BA:89:FF:19`**（与前几版一致才能覆盖安装）；
- 打包用的源码树必须含本册全部手机端提交（`git log` 逐条核对：Task 7–10 的提交都是当前 `HEAD` 的祖先）。

- [ ] **Step 3: 上线到 `/opt/appdl` 并改落地页**

```powershell
scp apps/mobile/dist/release/apk/base-0.14.0.apk root@118.190.217.242:/opt/appdl/base-0.14.0.apk
```

落地页 `/opt/appdl/index.html` **整页重写**（改指 `base-0.14.0.apk`）后 `scp`；改完确认页面上**只出现新版本号**（不得残留 `0.13.x`）。

- [ ] **Step 4: 签发 release 文档并线上验证**

```bash
/opt/base/based release -out /opt/base-cache/data/release.json
```

线上验证：

```powershell
(Invoke-WebRequest http://118.190.217.242/v1/release -UseBasicParsing).Content
```

Expected: `version_name=0.14.0`、`apk_size` / `apk_sha256` 与本地一致；
`http://118.190.217.242/dl/base-0.14.0.apk` 返回 `200` 且 `Content-Length` 与本地一致；
客户端 `verifyRelease` 对线上文档实测 `true`（需客户端执行，会话内测不了就在「执行实况」里写明未实测）。

- [ ] **Step 5: 回填「执行实况」并提交推送**

在本文档末尾「执行实况」章节逐条记录：提交哈希、门禁实况、节点二进制字节数/sha256、APK 字节数/sha256、证书 SHA1、线上返回、与计划的差异与更正。然后：

```powershell
git commit -m "docs(plan): 回填统一标签执行实况与更正" -- docs/superpowers/plans/2026-09-30-base-tagging-plan.md
git push origin master
```

- [ ] **Step 6: 真机 / 模拟器验收（人工）**

1. 治理人身份下，课程详情页对**无标签**课程看到「待补标签 · 补标签」，提交后课程页出现该标签；点标签进详情，`kind` 分组与顺序正确（AC 10）；
2. 同一课程再进补标签页（若仍可进）应由节点回 `403 tag_target_tagged`；课程页该位置改显「已有标签，改动需提案」，点击跳到治理页（AC 5 / §5.3）；
3. 非治理人 / 未登记身份：**看不到**「待补标签」与「补标签」，「我的 → 全部标签」仍可浏览已有标签（AC 10）；
4. 评论页：**只有已打标的评论**显示标签，未打标的评论**不出现**「待补」字样（§3.6、AC 10）；
5. 断网状态下提交一个标签 → 「我的条目 → 待发」出现该行；恢复网络后自动补发**仅一条**，`sent` 区出现且不再重复（AC 11）；
6. 小组页与私信页**没有任何标签入口**（§3.7 红线）；
7. 「我的条目」里 `tag` 行的「查看」进标签详情，且**没有**「修改 / 重投更新」按钮。

---

## 自检清单（写完计划后核过）

**Spec 覆盖**

| spec 小节 | 落点 |
| --- | --- |
| §0.1 口径收窄（写入时同事务物化，`tag_links` 仍是唯一权威；`packexport` 零改动） | Task 2（`replaceTagLinksTx` 一处写两处）、Task 4（哈希走容器口径）、Task 5（导出/导入端到端断言 `schema_version` 仍 1） |
| §1 目标 1–8（唯一 / 必填 / 直打 / 资格 / 改标 / ①类 / 传播 / 包不变） | 依次见下 AC 1–8 行 |
| §2 现状 10 行（哪一处零改动、哪一处必须改） | 计划头部「开工前已核实的现状」表；Task 2/4/6 各自引用对应行号 |
| §3.1 三元组语义与编码（三段必填 · 百分号编码 · `title` 由 `item_id` 重建 · 不做 slug 校验 · 唯一性） | Task 1（`TagItemID` / `ParseTagItemID` / `TagTitle` + 表驱动测试）、Task 4（`title` 不等 → `item_title_invalid`） |
| §3.1 归一化 | Task 1（`normalizeTagSegment` = `TrimSpace`）、Task 8（客户端 `trim` 镜像）——NFC 收窄见「与 spec 的实现期细化」4 |
| §3.2 关联模型（`tag_links` DDL 与 `idx_tag_links_target`、四种 `kind` 与存在性校验、多对多、`video` 不设 kind、悬空不级联） | Task 2（DDL + `ListTagLinks` / `ListTagsOf`）、Task 4（`checkTagTargetsExist`）、Task 10（详情页悬空跳过） |
| §3.3 传播（物化行 `seq=1..n`、排序口径、不写 `seq=0`、不由导入器产出、接收侧幂等回填且不校验存在性） | Task 2（`MaterializeTagSegments`）、Task 4（`contentHash = SegmentsContentHash(...)`）、Task 5（`backfillTagLinksTx` 同一事务内）、Task 7（手机端同步重建） |
| §3.4 直打（`type=tag` 请求体、资格并集、每目标必须无标签、空 `links` 合法、其余校验沿用 #25） | Task 3（`GovernorSet`）、Task 4（全部分支与 `tag_not_governor` / `tag_target_tagged` / `tag_links_invalid` / `tag_target_not_found`）、Task 9（客户端载荷与物化哈希同构） |
| §3.5 改标（走 #27 `edit`、2 票、生效时全量覆盖 + 重算哈希 + `author_id`/`author_sig` 不动、粒度 = 整个关联集） | Task 6（`links_json` 列 + `editTagItemTx` + `httpapi/govern.go` 载体系分流 + 测试断言两列不动）、Task 10（「已有标签，改动需提案」跳治理页） |
| §3.6 必填范围与软规则（节点不强制、仅 UI「待补标签」、评论不标待补） | Task 10（`pendingOf` 仅治理人 + 只在三类页；评论页无待补分支） |
| §3.7 只覆盖 ① 类（② 类一律拒） | Task 1（`TagKindOfTarget` 只认 `comment/<32hex>`）、Task 4（`HasCommentEvent` 查 `comment.v1`，`group.v1` / `dm.v1` 天然查不到）、Task 10（小组/私信页零入口） |
| §4 节点改动面 | Task 1–6（含三处册子未列的改动，见「与 spec 的实现期细化」6）；`ListUntagged` 与 `tagColumnMigrations` 作废、`packexport` / `importer` 零改动见同一节 1、2 |
| §5.1 本地表与重建（只新增一张派生表、按 `segments` 行幂等重写、`idx_tag_links_target`） | Task 7（`SCHEMA_SQL` + `applyPack` 墓碑与重建 + `MemoryRepo` 同步） |
| §5.2 `core/tags.ts` 六个函数 | Task 8（`encodeTagPath` / `decodeTagPath` / `tagsOf` / `linksOf` / `untaggedTargets` / `canGovern`）、Task 9（`submitTag` 的三段本地校验） |
| §5.3 UI（四类内容页 · 标签两页 · 「我的」入口 · 改标入口 · ② 类无入口 · 发布前两条硬检查） | Task 10（全部）、Task 11 Step 2（两条硬检查） |
| §5.3 版本发布四步 | Task 11 Step 1（`0.14.0` / `19`）、Task 12（四步 + 线上验证；节点二进制另含 Step 1） |
| §6 AC 1 三元组唯一 | Task 1（编码往返表）、Task 4（同三段两次提交 → 同一 `item_id`，`items` 只一行）、Task 8（`GO_CASES` 含带空格一段） |
| §6 AC 2 三段必填 | Task 1（空段 → `false`）、Task 4（`item_title_invalid`）、Task 9（`submitTag` 的三条文案） |
| §6 AC 3 直打 | Task 4（端到端：课程 / 课时 / 文章 / 公开评论四型）、Task 2（物化行数与排序断言） |
| §6 AC 4 资格 | Task 3（`GovernorSet` 并集）、Task 4（名册外 → `403 tag_not_governor`，且断言**未建条目**） |
| §6 AC 5 改标走治理 | Task 6（`tag_target_tagged` 原数据不变 + `edit` 提案第 2 票生效 + 全量覆盖） |
| §6 AC 6 ② 类不打标 | Task 4（用 `group.v1` / `dm.v1` 的 `event_id` → 拒） |
| §6 AC 7 跨节点传播 | Task 5（A 导出 → B 导入后逐行一致、排序一致；重复导出字节一致） |
| §6 AC 8 内容包不变 | Task 2（不加表不加列）、Task 5（`schema_version` 仍 1、五表 DDL 与列顺序未变） |
| §6 AC 9 软规则 | Task 4（无标签内容照常导入/导出/浏览/评论；节点不因缺标签拒写）、Task 10（无标签内容页照常渲染） |
| §6 AC 10 手机端 | Task 10（三类页才标待补、评论不标、治理人才见「补标签」） |
| §6 AC 11 离线写入 | Task 8（断网入队）、Task 9（`links_json` 往返补发）、Task 12 Step 6 第 5 条 |
| §6 AC 12 门禁全绿 | Task 1–9 各自的 Step（Go 包级）、Task 10 Step 10、Task 11 Step 2（全量 + 两条硬检查） |
| §7.2 红线 1–7 | 红线 1 → Task 1/4（`comment` 只认 `comment.v1`，② 类无 `kind`）；红线 2 → Task 2（`replaceTagLinksTx` 是唯一写函数，直打与提案共用）；红线 3 → 本计划不新增任何 HTTP 路由（Task 12 Step 1 探活据此设计）；红线 4 → Task 3/4（资格在节点判定，请求体无资格字段）；红线 5 → 全计划不碰 `articles.tags_json`；红线 6 → Task 2（**只加新表**）、Task 5（`schema_version` 断言）；红线 7 → 本计划不新增任何学习态字段 |
| §9 回填清单 1–5 | 1–4 已随册子定稿完成（不在本计划内）；第 5 条 → Task 11 Step 3（README §3 第 38 行 + 第 62 行状态；§4/§5 按口径保持不动） |

**与 spec 的实现期细化（必须同步回填 spec，已写进 Task 11 Step 4）**

1. **§4 的 `ListUntagged(kind, ids)` 无调用点**：删掉该行的方法清单项。反查落在客户端 `untaggedTargets(items, rows)`（本地 `tag_links` 全量很小，`idx_tag_links_target` 仍保留给「这个内容有哪些标签」）。
2. **§4 的 `tagColumnMigrations` 不必要**：`tag_links` 是全新表，`schemaStatements` 直接建即可；该常量不新增。
3. **§5.3 的 code `18` 已被占用**：实际落 `0.14.0` / `19`。
4. **§3.1 的 NFC 无法落地**：收窄为 `TrimSpace` / `trim` + 非空 + ≤ 64 rune；客户端不引入 `normalize`。
5. **§3.5 未定义 `links[]` 的存储**：定为新列 `govern_proposals.links_json TEXT NOT NULL DEFAULT ''`（走既有 `governColumnMigrations`），空串 = 空关联集。
6. **§4 的改动面漏了三处**：`internal/httpapi/govern.go` 的 `edit` 载体系分流（且载体校验必须挪到 `GetItem` 之后）、`GovernorSet()` 单函数、客户端 `my_submissions.links_json` 列。

**额外强调的实现约束**

- **不得引入第二份关联真相**（spec §7.2 红线 2）：`tag_links` 是唯一权威，物化 `segments` 行只能由 `replaceTagLinksTx` 在同一次写入里产出。计划里**没有**任何「只改 `tag_links`」或「只改 `segments`」的路径，执行期也不要为了修一个测试断言去手写 SQL 补行。
- **资格判定不得由客户端声明**（红线 4）：请求体里**没有**任何资格字段，节点用 `GovernorSet()` 自己判；客户端的 `canGovern` 只决定「按钮显不显示」，不参与授权。
- **② 类不给 `kind`**（红线 1）：`TagKindOfTarget` 对 `group/...`、`dm/...` 一律返回空串；存在性校验走 `HasCommentEvent`（查 `comment.v1`），**不要**放宽成「`events` 表里有这个 id 就算存在」——那会把 `group.v1` / `dm.v1` 放进来。
- **`tag` 条目的 `content_hash` 必须走容器口径**：`store.SegmentsContentHash(store.MaterializeTagSegments(...))`，客户端用同一「kind 固定序 + `target_id` 升序」物化后拼 `"<kind>\t<target_id>\n"` 再 `sha256Hex`。两侧排序函数各写一份但**必须同序**（Task 8 的 `TAG_KIND_ORDER` 与 Task 2 的 `tagKindRank`）。
- **`packexport` 与 `internal/importer` 的生产代码一行不改**：标签条目的导出靠既有 `segments` 分支；本册只**加测试**（Task 5）。
- **不引入新依赖**：不为 NFC 加 `golang.org/x/text`，不为表单加 UI 库。Go 侧只用标准库 + `modernc.org/sqlite`；客户端密码学一律来自 `@base/protocol-ts`，`core/tags.ts` **不 import** 它（签名与哈希由 `core/submit.ts` 现算，避免第二条签名路径）。
- **避免 `submit.ts` ↔ `tags.ts` 模块环**：`TAG_KIND_RANK` 在 `submit.ts` 内联一份（Task 9），不要从 `tags.ts` `import` 排序表。
- **台账必须落 `links_json`**：补发是从台账行重建草稿的，不落 `links` 则 tag 草稿补发时 `content_hash` 与签名必错（AC 11 直接失败）。不复用 `body_md`——那是 article 载体的语义。
- **`.vue` 不在 `tsc --noEmit` 覆盖范围**（`tsconfig.json` 只 `include: ["src"]` 且无 vue 插件）：改前端页面的任务**必须**跑 `npm run build:app`，它是 `.vue` 唯一的真实编译检查（#14 计划「执行期更正 9」）。
- **两条发布前硬检查必须用 Grep 工具**：PowerShell 5.1 的 `Select-String` 按 ANSI 读 UTF-8 会误判 0 命中（#14 计划已踩）。检查项 ① 是**模板**里的 `{{ ... .value }}`，本计划的模板一律写 `tagsByEvent[c.eventId] ?? []` 这类形态、不写 `.value`。
- **`@click.stop` 不能省**：课时行整行绑了 `onLesson`（展开/收起），课时标签区的点击若不 `.stop` 会连带切换展开态。
- **提案跳转只带 `itemId`**：改标提案的 `item_id` 是**标签条目**的 id（提案粒度是整个关联集，spec §3.5）。内容页跳转时带的是该内容**第一个**标签的 id——多标签目标下这是有损的（提案只能覆盖其中一个标签），本册照实接受、不新开写面。
- **提交一律精确路径**：并行治理线的进程在同一 worktree，`git commit` 必须带 `-- <路径>`，**绝不** `git add -A`（工作区另有常驻未提交 `.gitignore` 与构建残留 `based-linux-amd64`，都不提交）。
- **迁移补列走既有机制**：`govern_proposals.links_json` 只加进 `governColumnMigrations`，**不要**新写第二套补列函数（节点库是既有库，`CREATE TABLE IF NOT EXISTS` 不会补列）。

---

## 执行实况

> 本表在 Task 12 Step 5 回填：逐条记提交哈希、门禁实况、节点二进制与 APK 的字节数/sha256、证书 SHA1、线上返回、真机验收结论。

| # | 项 | 结果 |
| --- | --- | --- |
| 1 | Task 1 提交哈希（`protocol/tag.go` + 测试） | |
| 2 | Task 2–3 提交哈希（`tag_links` 表与 `store/tag.go`、`GovernorSet`） | |
| 3 | Task 4–5 提交哈希（`type=tag` 分支与端到端、导入回填） | |
| 4 | Task 6 提交哈希（`edit` 载体系与 `links_json`） | |
| 5 | Task 7 提交哈希（手机端派生表） | |
| 6 | Task 8–9 提交哈希（`core/tags.ts`、`submit.ts` 扩 `tag` 与 `links_json`） | |
| 7 | Task 10 提交哈希（标签三页与内容页入口） | |
| 8 | Task 11 提交哈希（版本 `0.14.0`/`19`、README 与册子回填） | |
| 9 | 全量门禁实况 | |
| 10 | 节点二进制（字节数 / sha256 / 探活） | |
| 11 | APK（字节数 / sha256 / 证书 SHA1） | |
| 12 | 线上验证（`/v1/release`、APK 200、`verifyRelease`） | |
| 13 | 真机验收七条（人工） | |
| 14 | 与计划的差异笔数 | |

### 更正（执行期与计划的差异）

> 每条按 #14 / #36 计划体例写：现象 → 计划写的是什么 → 实际怎么做的 → 依据。无差异则写「无」。

**更正 1（Task 2 · 直打条件排除自身旧行）**
现象：Task 2 Step 5 的 `TestUpsertTagSubmissionDirectWrite` 幂等断言必红——同标签同目标重提交被 `ErrTagTargetTagged` 拒。
计划写的是：`SELECT COUNT(*) FROM tag_links WHERE target_id=?`（Task 2 Step 4 代码块）。
实际怎么做的：加 `AND tag_id<>?`，即「该目标不得被**别的标签**占用」；其余逻辑逐字不变（提交 `50c285f`）。
依据：§3.4 的直打条件要求「每个目标当前无标签」，但同一标签的**重试/全量替换**必须幂等（§3.4 自身写明 `links` 为全量替换语义）；Task 4 的 `TestSubmitTagRejectsAlreadyTaggedTarget` 用的是**不同**标签（甲已占用 → 乙 403），与本收窄相容。

**更正 2（Task 2 · `TestListTagsOf` 用例缺陷）**
现象：原用例让两个不同标签（甲、乙）**都通过直打**写同一个 `course/c1`，与 §3.4 及 Task 4 的 403 用例直接对立，同一函数无法既放又拒。
计划写的是：两次 `UpsertTagSubmission` 都成功，再断言 `ListTagsOf` 升序。
实际怎么做的：第一条仍走直打，第二条改为直接造 `tag_links` 行（断言与排序覆盖不变）；改标提案生效路径落 Task 6（提交 `50c285f`）。
依据：本用例的意图是覆盖**反查排序**，不是覆盖直打条件；跨标签共用目标的正规入口是 §3.5 提案，Task 6 落地后由它覆盖。

**更正 3（Task 4 · `TestSubmitTagRejectsGroupEventTarget` 用例缺陷）**
现象：Task 4 Step 2 的该用例先 `n.seedEvent(t, "g1", "group.v1")` 造一条 ② 类事件，但请求体里的目标是写死的假 id `comment/0123456789abcdef0123456789abcdef`——**与刚入库的事件毫无关系**。于是该用例退化为「一个库里不存在的 event_id 被拒」，与 §3.7「② 类 event_id 一律拒」这条红线的意图无关：即便 `HasCommentEvent` 完全不硬过滤 `type='comment.v1'`，用例照样绿。
计划写的是：`seedEvent` 造事件，再用固定假 id 作目标（Step 2 代码块）。
实际怎么做的：`n.seedEvent` 返回真实 `event_id`，用例用 `"comment/" + eid` 作目标，断言仍为 `400 tag_target_not_found`（提交 `8b1e495`）。
依据：§3.7 的红线要证明的是「事件**确实存在**但类型是 ② 类时仍被拒」；只有把真事件 id 喂进去，`HasCommentEvent` 的 `type='comment.v1'` 硬过滤才是被真正覆盖的那一行代码。

**更正 4（Task 4 · 测试基座假定与实况不符）**
现象：Task 4 Step 2 假定的 `newTestNode` / `seedGovernor` / `seedGovernor2` / `seedOutsider` / `n.seedItem` / `n.seedEvent` / `n.tagLinkCount` / `n.itemExists` / `containsCode` / `signAuthorForTest` **在 `internal/httpapi` 里一个都不存在**；且 `tagSubmitBody` 按计划返回 `[]byte`，而真实 `signedRequest` 的 body 形参是 `string`。
计划写的是：直接使用上述 helper，并附注「若同包测试基座已有等价物就复用；缺的在 `tag_test.go` 内以测试专用 helper 补」。
实际怎么做的：复用既有等价物 `newSubmitNode`（返回 `*submitNode{st,public}`，已登记 `testSeed`）、`registerSeed`、`signedRequest`/`sendAuth`，错误码断言改回同包风格 `out["code"] != "…"`；缺的 helper 全部在 `tag_test.go` 内补齐（含两个 64-hex 测试 seed 常量）；名册内身份用「登记 + 走 `POST /v1/submit` 投 200 字 article」造，不直写库；`signedRequest` 调用处把 `[]byte` 显式转 `string`（提交 `8b1e495`）。
依据：该附注本身就是计划预留的口径；`store.ArticleMinRunes` 未导出，同包测试只能写字面量 200。非测试代码零新增导出，契约未变。

**更正 5（Task 7 · `SubmitDraft.type` 的拓宽被错划到 Task 9）**
现象：Task 7 Step 1 给 `MySubmissionRow.type` 加 `'tag'` 后，`submit.ts` 的 `runFlushSubmissions` 里 `const draft: SubmitDraft = { … type: row.type … }` 立即报 `TS2322`（`'tag'` 不可赋给 `'article' | 'quiz'`）；即 Task 7 的「`tsc` 无输出」门禁**跨到了 Task 9 才成立**，Task 7 单独执行时必红。
计划写的是：Task 7（计划表第 64 行与本 Task Files 段）只列 `types.ts` / `repo.ts` / `fakes.ts` 三文件，`SubmitDraft.type` 的拓宽归 Task 9 Step 5。
实际怎么做的：在 `submit.ts` 只改 `SubmitDraft.type` 一行（`'article' | 'quiz'` → `'article' | 'quiz' | 'tag'`），随 Task 7 一并提交；Task 9 此步遂为既有事实，其余不动。
依据：类型拓宽是 Task 7 自身语义（台账 `type` 含 `tag`）的**直接、不可分割的后果**，延后只会让「每个 Task 结束即门禁全绿」这一纪律破功；只挪一行、不引入任何运行期语义变化，也不改变 Task 9 的其余契约。

**更正 6（Task 8 / Task 9 · 两 Task 互为前置，执行次序互换）**
现象：计划把 Task 8（`core/tags.ts`）排在 Task 9（`submit.ts` 扩 `tag` 载体）之前，但两者**互为前置**，按计划次序任一个都无法单独门禁全绿：Task 8 的 `tags.test.ts` 断言 `submitTag` 的请求体键序含 `links`、台账行 `type === 'tag'`——这些全由 Task 9 的 `submit.ts` 载体提供（`enqueueOrSend` 的 `links` 字段、`buildTagPayload`、`writeLedger` 的 `links_json`），Task 9 未落地时 Task 8 必红；而 Task 9 Step 6 又要改 Task 8 才创建的 `core/tags.ts`。
计划写的是：Task 8 全量（含 Step 5 提交）→ Task 9 全量（Step 1–7，其 Step 6 改 `tags.ts`）。
实际怎么做的：**次序互换并拆分落点**——先执行 Task 9 的 Step 1–5（台账 `links_json` 列 + `ensureSubmissionColumns` + `submit.ts` 载体 + `submit.test.ts` 两条用例），提交 `156cc06`（文件同计划，**不含 `tags.ts`**，该文件此轮尚未创建）；Step 6（`tags.ts` 的三段本地校验与 `TAG_SEGMENT_MAX_RUNES`）**随 Task 8 周期一并落地**，于是 Task 8 的提交含 `tags.ts` + `tags.test.ts`。
依据：Step 6 的全部内容都在 `tags.ts` 内，它天然属于 Task 8 的产物；把它留在 Task 9 会让 Task 9 的提交无法独立门禁（缺 `tags.ts`），反之并入 Task 8 则两个提交都各自全绿。契约、用例语义与最终文件内容**均未变**，只是两批改动的归属与提交次序调整。

