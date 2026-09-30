# 条目图章与标题高亮 实施计划（A 主线 第 8 册）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 `#40 §2.1` 的 `seq<0` 属性行机制内新增 `attr.badge`（图章，全手动、多值落单行）与 `attr.title_color`（标题高亮，复用例 `#44 §6` 的 6 字色）两个槽位，双端 + 向量三处同步；编辑面按身份给 4 / 7 种图章候选与 6 色标题候选；展示落点挂在**已由 F5 改好的页面结构**上（App 列表页 / 详情页标题旁 + 节点门户同落点），写入复用既有 `POST /v1/submit` 条目编辑路径，**零新接口**。

**Architecture:** 两个新 kind 只是 `#40 §2.1` 槽位机制内的取值——`internal/protocol/attrs.go` 加常量与 `AttrKindSet`、`apps/mobile/src/core/attrs.ts` 同构镜像、`vectors/v1/attrs.json` 加用例（三处同步）。`AssignAttrSeqs` / `AttrSeqsCanonical` / `validateSubmitSegments` 的**逻辑一行不改**（新 kind 自动纳入）。手机端在 `core/attrs.ts` 加 `serializeBadge` / `parseBadge` / 色名白名单纯函数；`core/container-view.ts` 的 `attrsOf` 与 `core/course-edit.ts` 的 `ContainerForm` / `buildContainerSegments` / `loadContainerForm` 读写两个槽位；编辑页与展示页挂展示。标题**不进** `renderMarkdown`（`attr.title_color` 只产固定色类名）。

**Tech Stack:** Go 1.2x（`internal/protocol`、`internal/httpapi`）／ TypeScript + Vue 3 + uni-app（`apps/mobile`）／ vitest ／ `vectors/v1/attrs.json` 双端契约向量。

**上游 spec:** `docs/superpowers/specs/2026-09-30-base-badge-title-color-design.md`（`#53`，已批准）；批次编排 `docs/superpowers/plans/2026-09-30-base-batch-f3-f9-plan.md`（`#45`）。

---

## 开工前已核实的现状（执行时不要重新调研，直接用）

| 事实 | 位置 |
| --- | --- |
| 属性行常量块（`AttrKindPrefix` + 6 个 `AttrKey*`）、`AttrKindSet`、`IsAttrKind`、`AttrLine`/`AttrSlot`、`AssignAttrSeqs`（按 kind 字典序自 `-1` 递减）、`AttrSeqsCanonical`（与入参顺序无关） | `internal/protocol/attrs.go:6-111`（常量 L6-23、`AttrKindSet` L26-33、`AssignAttrSeqs` L58-88、`AttrSeqsCanonical` L93-111） |
| TS 镜像（逐字节同构，含 `DIFFICULTY_CHOICES`、`segmentsContentHash`） | `apps/mobile/src/core/attrs.ts:12-120`（镜像常量 L12-29、`ATTR_KIND_SET` L31-38、`assignAttrSeqs` L65-89、`attrSeqsCanonical` L95-100） |
| Go 读契约向量：`filepath.Join("..","..","vectors","v1",name)` | `internal/protocol/attrs_vector_test.go:11` |
| TS 读契约向量：`new URL('../../../../vectors/v1/x.json', import.meta.url)`（层深 4） | `apps/mobile/src/core/attrs.test.ts:26` |
| 契约向量现值：`version:1` + `cases[{name,lines,slots}]`，3 例（六属性全给 / 仅封面与讲师 / 无属性）；向量自身须 `AttrSeqsCanonical` 通过 | `vectors/v1/attrs.json:1-42`、`attrs_vector_test.go:40-44` |
| 投稿三区间校验：`validateSubmitSegments` 用 `protocol.IsAttrKind` 收 `seq<0` 行、`AttrSeqsCanonical` 判规范排布，归一失败回 `item_segments_invalid` | `internal/httpapi/submit.go:91-123` |
| `handleSubmitPost` 类型分支 `course` / `lesson` 走 `validateSubmitSegments` | `internal/httpapi/submit.go:198-225` |
| 容器读取视图：`ContainerAttrs` / `emptyAttrs` / `attrsOf`（未知 kind 与坏行静默忽略，按 `seq` 降序读） | `apps/mobile/src/core/container-view.ts:24-79`（`ContainerAttrs` L24-35、`emptyAttrs` L38-40、`attrsOf` L47-79） |
| 容器编辑编排：`ContainerForm` 字段集、`emptyContainerForm`、`buildContainerSegments`（先 push `AttrLine[]` 再 `assignAttrSeqs`）、`loadContainerForm`（经 `attrsOf` 回填） | `apps/mobile/src/core/course-edit.ts:48-66`、`99-114`、`117-132` |
| 难度下拉取值域先例：`DIFFICULTY_CHOICES = [intro,basic,advanced]`（编辑页可选项集合的写法） | `apps/mobile/src/core/attrs.ts:29` |
| 列表页：`course.vue` 课程行 `.item` → `.item-title`（课程标题），`load()` 取 `repo.listItems()` + `repo.listSegments(itemId)` | `apps/mobile/src/pages/course/course.vue:21-24,40-43,81-117` |
| 课时页标题：`lessonLabel`（`第 N 讲 · 标题`）；`attrs = attrsOf(segs)` 已在 `onLoad` 取到 | `apps/mobile/src/pages/lesson/detail.vue:8,84,99-100` |
| 文章页标题：`<text class="title">{{ article?.title }}</text>`，`onLoad` 读 `repo.getArticle` | `apps/mobile/src/pages/article/article.vue:7,82-99` |
| 门户：`pageData` / `pageArticle{Title,Paragraphs,...}` / `handleArticlePage` / `coverBlobID`；模板 `<h1>{{.Title}}</h1>` | `internal/httpapi/web.go:23-85,110-140`、`web/templates/article.html:4` |
| `#44` 的 6 字色类：`c-red` / `c-orange` / `c-green` / `c-blue` / `c-purple` / `c-gray`（+ `c-mark` 高亮底，**不参与 title_color**） | `docs/superpowers/specs/2026-09-30-base-markdown-render-design.md:116-128`（§6 色板） |
| `#44` 的落点（F5 改后的页面结构）与「标题恒纯文本、不进 `renderMarkdown`」口径 | `#44 §5.1-5.3`、`#44 §3`（消毒白名单） |
| `#27` 的 `edit` 载体范围：仅 `articles` 型与 `tag` 型（载荷 `title`+`body_md` / `links[]`），**无图章槽位** | `docs/superpowers/specs/2026-09-28-base-approval-governance-design.md:48-52,66-77` |
| `#23` 治理者名册：本节点贡献前 10 名**实时派生**（不存名册） | `docs/superpowers/specs/2026-09-28-base-contribution-roles-design.md:44` |
| 手机端版本现值 `0.15.0` / `20`（批次基线） | `apps/mobile/src/manifest.json:5-6` |
| 门禁：`go build ./...` / `go vet ./...` / `go test ./...`；`cd apps/mobile` → `npx vitest run`（`#45 §6` 基线 **23 文件 / 230 用例**，只增不减）、`npx tsc --noEmit`、`npm run build:h5`；`scripts/acceptance-d.ps1` | `apps/mobile/package.json`、`scripts/acceptance-d.ps1` |
| 发布前硬检查：`apps/mobile/src/pages/*/*.vue` 不得出现 `.value` 模板写法（`grep -nE '="[^"]*\.value|\{\{[^}]*\.value'` 必须无输出）；`build:app` 产物 `\.value\.value` 计数为 0 | `#45 §5` 末条 |
| 「给老条目加行 ⇒ 产生新版本」是既有机制：`segments` 行集变 ⇒ 容器 `content_hash` 变 ⇒ 新版本 | `#40 §2.3` / `#14 §3.3`、`#40 §8 风险 2` |

**关键结论（写进任务，不重新推导）：** 新增两 kind 后 `AssignAttrSeqs` **只对入参里实际出现的 kind 排序**。8 kind 名次 = `attr.attachment` → **`attr.badge`** → `attr.body_md` → `attr.cover` → `attr.difficulty` → `attr.duration` → `attr.instructor` → **`attr.title_color`**。故：无该行的老条目排布**逐字节不变**（不破哈希）；含 `attr.badge` 的条目其**后续既有属性行 seq 整体下移**；含 `attr.title_color` 的条目只**追加**最低 seq。**任一新增行的条目必产生新版本**（与「无该行不变」是两件事）。

**环境注意（Windows PowerShell 5.1，无 `pwsh`）：** 不支持 `&&`（用 `;`）与 heredoc（commit 消息写临时文件 + `git commit -F`）；新增 `.ps1` 必须带 UTF-8 BOM，编辑工具保存会剥掉 BOM，每次改动后须回补。

**工作区注意：** 有未提交的 `.gitignore` 改动与未跟踪的 `based-linux-amd64`，**不要动、不要 add**。每次提交只 `git add` 本任务涉及的具体文件。

---

## 文件结构（先定边界，再拆任务）

**节点侧（Go）**

| 文件 | 动作 | 职责 |
| --- | --- | --- |
| `internal/protocol/attrs.go` | 修改 | 新增 `AttrKeyBadge = "attr.badge"` / `AttrKeyTitleColor = "attr.title_color"` 两个常量，并加入 `AttrKindSet`（**逻辑不改**：`AssignAttrSeqs` / `AttrSeqsCanonical` 一行不动） |
| `internal/protocol/attrs_vector_test.go` | 修改 | 若需断言 8 kind 名次，补一条表驱动用例（向量文件已由 `TestAttrVectorFile` 消费，通常无需改测试代码） |
| `vectors/v1/attrs.json` | 修改 | 新增用例：① 含 `attr.badge`（含其后既有行下移）② 含 `attr.title_color`（追加最低 seq）③ 老条目无该行不破排布（回归）④ 8 kind 全给 |
| `internal/httpapi/submit.go` | 不改 | `IsAttrKind` 自动收新 kind、`AttrSeqsCanonical` 自动纳入——**确认无改动** |

**手机端（TS / Vue）**

| 文件 | 动作 | 职责 |
| --- | --- | --- |
| `apps/mobile/src/core/attrs.ts` | 修改 | 新增 `ATTR_BADGE` / `ATTR_TITLE_COLOR` 常量 + `ATTR_KIND_SET` 两行；新增 `BADGE_WORDS`（7 词）、`BADGE_WORDS_AUTHOR`（4 词）、`TITLE_COLORS`（6 色）、`serializeBadge` / `parseBadge` / `isTitleColor` 纯函数 |
| `apps/mobile/src/core/attrs.test.ts` | 修改 | 序列化 / 反序列化正负例；8 kind 名次回归；读同一向量 |
| `apps/mobile/src/core/container-view.ts` | 修改 | `ContainerAttrs` 加 `badge: string[]` / `titleColor: string`；`emptyAttrs` / `attrsOf` 加两分支 |
| `apps/mobile/src/core/container-view.test.ts` | 修改 | 两槽位读写 + 坏值静默忽略 |
| `apps/mobile/src/core/course-edit.ts` | 修改 | `ContainerForm` 加 `badge` / `titleColor`；`emptyContainerForm` 扩初值；`buildContainerSegments` push 两行；`loadContainerForm` 回填 |
| `apps/mobile/src/core/course-edit.test.ts` | 修改 | 行集构造（多选图章 → 单行）/ 回填 |
| `apps/mobile/src/pages/course/edit.vue` | 修改 | 图章多选（按身份 4 / 7 种）+ 标题选色（6 色） |
| `apps/mobile/src/pages/lesson/edit.vue` | 修改 | 同上（同一套控件） |
| `apps/mobile/src/pages/course/course.vue` | 修改 | 列表行标题旁图章 chips + 标题套 `c-<name>` |
| `apps/mobile/src/pages/lesson/detail.vue` | 修改 | 详情标题旁图章 chips + 标题套 `c-<name>` |
| `apps/mobile/src/pages/article/article.vue` | 修改 | 与 `#44 §5` 同落点：标题旁图章 chips + 标题套 `c-<name>`（无载体行时自然为空） |
| `apps/mobile/src/manifest.json` | 修改 | 版本 `0.16.0` / `21`（随批次，Task 6） |

**门户（Node 侧）**

| 文件 | 动作 | 职责 |
| --- | --- | --- |
| `internal/httpapi/web.go` | 修改 | `pageArticle` 扩 `Badges []string` / `TitleColor string`（由容器属性行派生） |
| `web/templates/article.html` | 修改 | `<h1>` 旁追加图章 chips；标题套 `c-<name>` |

**展示类名约定（本计划界定，不改 `#44` 色板）**

- 标题色类名 = `c-<name>`（与 `#44 §6` **同名色板**）；三端样式表复用 `#44` 已落地的 6 个字色规则（若 `#44` 未给标题元素落规则，本计划只需把 `c-<name>` 应用到标题元素，**不改 `#44` 的色值**）。
- 图章 chips 类名 = `badge`（不共用 `#37` 标签的 `.tag`，**不进标签体系**）。

---

### Task 1: 双端两个 kind 常量 + `vectors/v1/attrs.json` 用例

**Files:**
- Modify: `internal/protocol/attrs.go`
- Modify: `apps/mobile/src/core/attrs.ts`
- Modify: `vectors/v1/attrs.json`

- [ ] **Step 1: 写失败的向量用例（先写数据）**

在 `vectors/v1/attrs.json` 的 `cases` 追加下列用例（**示例值，务必按 §2.3 的码位序核对 `attr.badge` 的规范序**）。规范序（7 词全给）= `活动,悬赏,推荐,热门,精华,置顶,辩论`：

```json
{
  "name": "含图章（其后续既有属性行整体下移）",
  "lines": [
    {"kind": "attr.instructor", "text": "李老师"},
    {"kind": "attr.badge", "text": "活动,悬赏"},
    {"kind": "attr.cover", "text": "00112233445566778899aabbccddeeff"}
  ],
  "slots": [
    {"seq": -1, "kind": "attr.badge", "text": "活动,悬赏"},
    {"seq": -2, "kind": "attr.cover", "text": "00112233445566778899aabbccddeeff"},
    {"seq": -3, "kind": "attr.instructor", "text": "李老师"}
  ]
},
{
  "name": "含标题色（追加最低 seq，既有行不动）",
  "lines": [
    {"kind": "attr.instructor", "text": "李老师"},
    {"kind": "attr.title_color", "text": "red"},
    {"kind": "attr.cover", "text": "00112233445566778899aabbccddeeff"}
  ],
  "slots": [
    {"seq": -1, "kind": "attr.cover", "text": "00112233445566778899aabbccddeeff"},
    {"seq": -2, "kind": "attr.instructor", "text": "李老师"},
    {"seq": -3, "kind": "attr.title_color", "text": "red"}
  ]
},
{
  "name": "老条目无新行不破排布（回归）",
  "lines": [
    {"kind": "attr.instructor", "text": "李老师"},
    {"kind": "attr.duration", "text": "3600"}
  ],
  "slots": [
    {"seq": -1, "kind": "attr.duration", "text": "3600"},
    {"seq": -2, "kind": "attr.instructor", "text": "李老师"}
  ]
}
```

- [ ] **Step 2: 跑门禁确认红**

```powershell
go test ./internal/protocol/ -run TestAttrVectorFile -v
```

判据：新用例里 `attr.badge` / `attr.title_color` 因**尚未进 `AttrKindSet`**，`assignAttrSeqs` 仍会排（`AssignAttrSeqs` 不查集合），但 **Go 侧 `AttrKindSet` 未含新 kind ⇒ 若测试同时断言 `IsAttrKind` 则红**；本步以「向量自身是否为规范排布」+ 「8 kind 名次断言」为红点。若纯靠向量无法转红，用 Step 3 的 `IsAttrKind` 断言转红。

- [ ] **Step 3: 加常量与集合（节点侧）**

`internal/protocol/attrs.go` 常量块（L6-23）追加：

```go
	AttrKeyBadge      = "attr.badge"
	AttrKeyTitleColor = "attr.title_color"
```

`AttrKindSet`（L26-33）追加两行：

```go
	AttrKeyBadge:      true,
	AttrKeyTitleColor: true,
```

**不加任何排序逻辑**——`AssignAttrSeqs` / `AttrSeqsCanonical` 一行不改（新 kind 自动纳入字典序）。

- [ ] **Step 4: 加常量与集合（手机端镜像）**

`apps/mobile/src/core/attrs.ts` 镜像常量（L12-29）追加：

```ts
export const ATTR_BADGE = 'attr.badge';
export const ATTR_TITLE_COLOR = 'attr.title_color';
```

`ATTR_KIND_SET`（L31-38）追加：

```ts
  [ATTR_BADGE]: true,
  [ATTR_TITLE_COLOR]: true,
```

- [ ] **Step 5: 跑门禁确认绿**

```powershell
go test ./internal/protocol/ -run TestAttrVectorFile -v
cd apps/mobile; npx vitest run src/core/attrs.test.ts
```

判据：Go 与 vitest **共读同一份 `vectors/v1/attrs.json`** 全绿；8 kind 名次与「开工前已核实」段一致。

- [ ] **Step 6: 提交**

`git add` 三个文件后提交（消息示例）：`feat(attrs): 新增 attr.badge / attr.title_color 两个 kind 与契约向量 #53`。

---

### Task 2: 序列化 / 反序列化纯函数 + vitest

**Files:**
- Modify: `apps/mobile/src/core/attrs.ts`
- Modify: `apps/mobile/src/core/attrs.test.ts`

- [ ] **Step 1: 写失败的测试**

在 `attrs.test.ts` 追加：

```ts
describe('attrs：图章序列化与标题色白名单', () => {
  it('serializeBadge：去重 + 码位升序 + 半角逗号', () => {
    expect(serializeBadge(['悬赏', '活动', '悬赏', '置顶'])).toBe('活动,悬赏,置顶');
    expect(serializeBadge(['辩论', '热门', '精华', '推荐', '置顶', '悬赏', '活动'])).toBe(
      '活动,悬赏,推荐,热门,精华,置顶,辩论',
    );
    expect(serializeBadge([])).toBe('');
  });

  it('parseBadge：域外词静默丢弃 + 再次去重排序', () => {
    expect(parseBadge('')).toEqual([]);
    expect(parseBadge('活动,活动')).toEqual(['活动']);
    expect(parseBadge('活动,自定义词,悬赏')).toEqual(['活动', '悬赏']);
    expect(parseBadge('悬赏,活动')).toEqual(['活动', '悬赏']); // 读入也归一
  });

  it('标题色白名单：只认 6 色，c-mark 不算', () => {
    for (const c of TITLE_COLORS) expect(isTitleColor(c)).toBe(true);
    for (const c of ['', 'mark', 'c-mark', 'yellow']) expect(isTitleColor(c)).toBe(false);
  });
});
```

- [ ] **Step 2: 跑门禁确认红**

```powershell
cd apps/mobile; npx vitest run src/core/attrs.test.ts
```

判据：`serializeBadge` / `parseBadge` / `TITLE_COLORS` / `isTitleColor` 未定义 ⇒ 编译 / 断言红。

- [ ] **Step 3: 实现纯函数**

在 `attrs.ts` 追加（**纯函数、无异常分支、单出口**）：

```ts
/** 图章取值域（封闭 7 词；不含分隔符 `,`）。 */
export const BADGE_WORDS = ['活动', '悬赏', '推荐', '热门', '精华', '置顶', '辩论'] as const;
/** 作者可选的 4 种（自建条目；`置顶` 仅限自己）。 */
export const BADGE_WORDS_AUTHOR = ['活动', '悬赏', '辩论', '置顶'] as const;
/** 标题色 6 字色（复用例 #44 §6；不含 c-mark）。 */
export const TITLE_COLORS = ['red', 'orange', 'green', 'blue', 'purple', 'gray'] as const;

/** 多值 → 单行：去重 + 码位升序 + 半角逗号连接。 */
export function serializeBadge(words: readonly string[]): string {
  return [...new Set(words)].sort().join(',');
}

/** 单行 → 多值：切分 → 去空 → 去重 → 码位升序 → 只留取值域内的词。 */
export function parseBadge(text: string): string[] {
  const set = new Set<string>(BADGE_WORDS);
  return [...new Set(text.split(',').map((s) => s.trim()).filter((s) => set.has(s)))].sort();
}

export function isTitleColor(name: string): boolean {
  return (TITLE_COLORS as readonly string[]).includes(name);
}
```

> **注意：** `Array.prototype.sort()` 默认按 **UTF-16 码元**排序，与 Go `sort.Strings`（UTF-8 字节序 = 码位序）**在这 7 个中文词上等价**（均为 BMP、无代理对）；向量用例（Task 1）已把规范序钉死，两端不一致会立刻红。

- [ ] **Step 4: 跑门禁确认绿**

```powershell
cd apps/mobile; npx vitest run src/core/attrs.test.ts; npx tsc --noEmit
```

- [ ] **Step 5: 提交**

`feat(attrs): serializeBadge / parseBadge / 标题色白名单 + 单测 #53`。

---

### Task 3: `ContainerForm` / `attrsOf` 读写两个槽位 + vitest

**Files:**
- Modify: `apps/mobile/src/core/container-view.ts`
- Modify: `apps/mobile/src/core/container-view.test.ts`
- Modify: `apps/mobile/src/core/course-edit.ts`
- Modify: `apps/mobile/src/core/course-edit.test.ts`

- [ ] **Step 1: 写失败的测试**

`container-view.test.ts` 追加：`attrsOf` 能解析 `attr.badge`（→ `['活动','悬赏']`）与 `attr.title_color`（→ `'red'`）；域外色名 / 坏图章行**静默忽略**（`titleColor===''`、`badge` 只留合法词）。

`course-edit.test.ts` 追加：

```ts
it('多选图章 → 单行（去重 + 码位升序）', () => {
  const form = { ...emptyContainerForm('course', 'course/c1'), badge: ['悬赏', '活动'], titleColor: 'red' };
  const segs = buildContainerSegments(form);
  expect(segs.find((s) => s.kind === 'attr.badge')?.text).toBe('活动,悬赏');
  expect(segs.find((s) => s.kind === 'attr.title_color')?.text).toBe('red');
  expect(attrSeqsCanonical(segs.filter((s) => s.seq < 0).map((s) => ({ seq: s.seq, kind: s.kind, text: s.text })))).toBe(true);
});
```

- [ ] **Step 2: 跑门禁确认红**

```powershell
cd apps/mobile; npx vitest run src/core/container-view.test.ts src/core/course-edit.test.ts
```

- [ ] **Step 3: 扩读取视图（`container-view.ts`）**

`ContainerAttrs`（L24-35）加两字段：

```ts
  /** 图章（已解析为数组；空数组 = 未设置） */
  badge: string[];
  /** red|orange|green|blue|purple|gray；空串 = 未设置 */
  titleColor: string;
```

`emptyAttrs`（L38-40）初值加 `badge: [], titleColor: ''`。

`attrsOf`（L47-79）`switch` 加两分支：

```ts
      case ATTR_BADGE:
        out.badge = parseBadge(s.text);
        break;
      case ATTR_TITLE_COLOR:
        out.titleColor = isTitleColor(s.text) ? s.text : '';
        break;
```

（配套 import `ATTR_BADGE` / `ATTR_TITLE_COLOR` / `parseBadge` / `isTitleColor`。）

- [ ] **Step 4: 扩编辑表单（`course-edit.ts`）**

`ContainerForm`（L48-66）加：

```ts
  /** 图章（多值；空数组 = 不产该行） */
  badge: string[];
  /** 标题色（6 色；空串 = 不产该行） */
  titleColor: string;
```

`emptyContainerForm`（L69-83）初值加 `badge: [], titleColor: ''`。

`buildContainerSegments`（L99-114）在 `assignAttrSeqs` **之前** push：

```ts
  const badgeText = serializeBadge(form.badge);
  if (badgeText !== '') lines.push({ kind: ATTR_BADGE, text: badgeText });
  if (isTitleColor(form.titleColor)) lines.push({ kind: ATTR_TITLE_COLOR, text: form.titleColor });
```

`loadContainerForm`（L117-132）回填：

```ts
  form.badge = attrs.badge;
  form.titleColor = attrs.titleColor;
```

- [ ] **Step 5: 跑门禁确认绿**

```powershell
cd apps/mobile; npx vitest run src/core/container-view.test.ts src/core/course-edit.test.ts; npx tsc --noEmit
```

- [ ] **Step 6: 提交**

`feat(course-edit): ContainerForm / attrsOf 读写 attr.badge 与 attr.title_color #53`。

---

### Task 4: 编辑页 UI（图章多选 4 / 7 种；标题选色 6 色）

**Files:**
- Modify: `apps/mobile/src/pages/course/edit.vue`
- Modify: `apps/mobile/src/pages/lesson/edit.vue`

- [ ] **Step 1: 判定身份并定候选集合**

- 作者身份 = 正在编辑**自建**条目（编辑页既有可见条件，`#40 §6`）：候选 = `BADGE_WORDS_AUTHOR`（**4 种**）。
- 治理者身份 = `#23` 名册内（复用 `core/contribution.ts` 的既有名册判定，**不加新维度**）：候选 = `BADGE_WORDS`（**7 种**）。
- 两页共用一套控件；候选集合由页面 `computed` 决定。

- [ ] **Step 2: 加图章多选控件**

课程编辑页「分类」输入附近新增「图章」多选区（chip 可点选 / 取消），绑定 `form.badge`（`string[]`）；课时编辑页同款。提示文案写明「作者 4 种 / 治理者 7 种，多选后自动去重并定序」。

- [ ] **Step 3: 加标题选色控件**

新增「标题色」6 色块（`TITLE_COLORS`），单选可清空；绑定 `form.titleColor`；色块用 `c-<name>` 预览。

- [ ] **Step 4: 跑门禁确认绿**

```powershell
cd apps/mobile; npx tsc --noEmit; npm run build:h5
```

判据：模板中**不得出现 `.value` 写法**；`build:h5` 通过。

- [ ] **Step 5: 提交**

`feat(edit): 课程 / 课时编辑页图章多选与标题选色 #53`。

---

### Task 5: 展示落点（列表页 + 详情页 + 门户同落点）

**Files:**
- Modify: `apps/mobile/src/pages/course/course.vue`
- Modify: `apps/mobile/src/pages/lesson/detail.vue`
- Modify: `apps/mobile/src/pages/article/article.vue`
- Modify: `internal/httpapi/web.go`
- Modify: `web/templates/article.html`

- [ ] **Step 1: 列表页（`course.vue`）**

`load()`（L81-117）已逐课程 `repo.listSegments(itemId)`：为每个课程行派生 `badge` / `titleColor`（经 `attrsOf`），在 `.item-title` 旁渲染图章 chips（`.badge`），并给标题套 `:class="item.titleColor ? 'c-' + item.titleColor : ''"`。**不新增筛选 / 排序**，只展示。

- [ ] **Step 2: 详情页（`lesson/detail.vue`）**

`onLoad`（L74-138）已取 `attrs = attrsOf(segs)`：在 `lessonLabel` 标题（L8）旁渲染 `attrs.badge` chips，标题套 `c-<attrs.titleColor>`。样式表加 `.badge` 与 `c-<name>`（复用 `#44 §6` 色值）。

- [ ] **Step 3: 文章页（`article.vue`）**

与 `#44 §5` 同落点：标题（L7）旁渲染图章 chips、标题套色类。**注意**：文章条目不产 `segments` 行 ⇒ 无载体行时图章为空、标题无色（**自然为空，不是缺陷**，见 `#53 §3` 第 2 条）。

- [ ] **Step 4: 门户（`web.go` + `article.html`）**

`pageArticle`（L77-85）加 `Badges []string` / `TitleColor string`（由容器属性行派生；文章无容器属性行时为空）；`handleArticlePage`（L110-140）填充；`article.html`（L4）`<h1>` 旁追加 `{{range .Badges}}<span class="badge">{{.}}</span>{{end}}`，`<h1 class="{{if .TitleColor}}c-{{.TitleColor}}{{end}}">`。门户只落浅色一版色值（与 `#44 §5.3` 同）。

> **越权注入护栏：** `Badges` / `TitleColor` 一律由**服务端从受限取值域派生**（色名只在 6 名白名单内、图章词只在封闭 7 词内），**不直接回显用户任意字符串**；`TitleColor` 只产固定类名，故**不进** `#44 §3` 消毒管线（`#53 §2.4` 说明理由）；图章词是中文白名单常量，模板 `html/template` 转义仍生效。

- [ ] **Step 5: 跑门禁确认绿**

```powershell
cd apps/mobile; npx vitest run; npx tsc --noEmit; npm run build:h5
go build ./...; go vet ./...; go test ./...
```

- [ ] **Step 6: 提交**

`feat(ui): 列表页 / 详情页 / 门户标题旁图章与标题色 #53`。

---

### Task 6: 门禁与收口

**Files:**
- Modify: `apps/mobile/src/manifest.json`

- [ ] **Step 1: 版本号**

`manifest.json`（L5-6）改为 `0.16.0` / `21`（**随批次 `#45` 单次发布**，本册不单独发布）。

- [ ] **Step 2: 全门禁（`#45 §6`）**

```powershell
go build ./...; go vet ./...; go test ./...
cd apps/mobile; npx vitest run; npx tsc --noEmit; npm run build:h5
```

判据：mobile **不少于 23 文件 / 230 用例**（批内只增不减）；向量 Go + vitest 共读全绿。

- [ ] **Step 3: 发布前硬检查**

```powershell
Select-String -Path apps/mobile/src/pages/*/*.vue -Pattern '="[^"]*\.value|\{\{[^}]*\.value'   # 必须无输出
```

并保留 `build:app` 产物 `\.value\.value` 计数为 0 的硬检查。

- [ ] **Step 4: 一键复跑**

```powershell
scripts/acceptance-d.ps1
```

判据：D 组 TC-D01–TC-D07 全 PASS。

- [ ] **Step 5: 节点部署（随批次）**

`internal/protocol/attrs.go` 已动 ⇒ **必须**交叉编译并部署：

```powershell
$env:GOOS='linux'; $env:GOARCH='amd64'; go build -o based-linux-amd64 ./cmd/based
```

`scp` → `mv` 覆盖 `/opt/base/based` + `chmod 0755`（回滚件 `based.bak-<旧版本>`）→ 重启 `base` 与 `base-cache` → 探活走 **HTTPS 443**（纯 HTTP 打 8081/8083 会回 400）。

- [ ] **Step 6: 批次四步发布（随 `#45` 收口执行，不在本册单独发）**

云打包 APK → 上传 `/opt/appdl/base-0.16.0.apk` → 落地页整页重写改指 → `based release` 签发落 `/opt/base-cache/data/release.json`；线上 `GET /v1/release` → `0.16.0`、`HEAD /dl/base-0.16.0.apk` = 200、`verifyRelease` = true。

- [ ] **Step 7: 提交**

`chore(release): F9 收口，版本 0.16.0/21（随批次） #53/#54`。

---

## 执行实况

> 本节省在实施完成后回填：逐 Task 的落地 commit、门禁命令的实际输出（mobile 文件数 / 用例数、Go 三连结果）、`build:app` 产物取证、节点二进制远端 sha256、真机验收结果（`#53` AC 8）、以及任何执行期更正（**只记 1 个问题 + 1 个改进措施**）。