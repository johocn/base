# 课程分类属性槽位 实施计划（A 主线 第 6 册）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把课程分类降为课程自身的属性槽位 `attr.category`（新增 kind，取值 = 分类 slug，随 course 容器一起提交），使 App 自建课程有分类入口；分组读取改为**双来源 + 优先级**（优先 `attr.category`，缺失才回退导入器产 `category/<slug>` 清单行），组标题优先取已有分类容器 `title`、否则回落 slug。**零新接口、零新表、零新字段、不加配置项、不 bump `schema_version`、导入器一行不改、老条目不破哈希。**

**Architecture:** `attr.category` 是 `#40 §2.1` 已立的 `seq<0` 属性槽位机制内的**新 kind**——双端常量三处同步（`internal/protocol/attrs.go` / `apps/mobile/src/core/attrs.ts` / `vectors/v1/attrs.json`）由契约向量守门。读取分组是**纯函数、只读**：库与清单行都不动，导入器路径零改动。App 侧只写课程自己的属性行，**不新建 `category/<slug>` 容器**。

**Tech Stack:** Go 1.2x（`internal/protocol`）／ TS + Vue 3 + uni-app（`apps/mobile`）／ vitest ／ `vectors/v1/*.json` 双端契约向量。

**上游 spec:** `specs/2026-09-30-base-course-category-attr-design.md`（`#49`，**已定稿**）；批次编排 `plans/2026-09-30-base-batch-f3-f9-plan.md`（`#45`）；`#36`（分类契约）与 `#40`（槽位机制）为共同上游。

---

## 开工前已核实的现状（执行时勿重新调研）

| 事实 | 位置 |
| --- | --- |
| 槽位常量（六项，**无** `attr.category`）/ `AttrKindPrefix` / `DigestKind`；`AttrKindSet`；`IsAttrKind` | `internal/protocol/attrs.go:6-36` |
| `AssignAttrSeqs`：按 `kind` **字典序**从 `-1` 起递减；同 kind 至多一行，唯 `attr.attachment` 多行占连续递减区间；返回按 seq 降序 | `internal/protocol/attrs.go:58-88` |
| `AttrSeqsCanonical`：与入参数组顺序无关（两侧按 seq 升序对齐后逐行比对） | `internal/protocol/attrs.go:93-111`；回归 `internal/protocol/attrs_vector_test.go:61-99` |
| TS 镜像常量（六项）/ `ATTR_KIND_PREFIX` / `ATTR_KIND_SET` / `assignAttrSeqs` / `attrSeqsCanonical` / `segmentsContentHash` | `apps/mobile/src/core/attrs.ts:12-38,65-120` |
| 契约向量外层 `{version:1, cases:[{name,lines,slots}]}`，现存 3 例（六属性全给 / 仅封面与讲师 / 无属性） | `vectors/v1/attrs.json:1-41` |
| 向量读法：Go `os.ReadFile(filepath.Join("..","..","vectors","v1",name))`；TS `readFileSync(new URL('../../../../vectors/v1/x.json', import.meta.url),'utf8')`（层深 4） | `internal/protocol/attrs_vector_test.go:11`、`apps/mobile/src/core/attrs.test.ts:25-27` |
| 节点校验：`seq<0` 行须 `protocol.IsAttrKind` 且整组 `AttrSeqsCanonical`；**不**按容器类型限制属性 kind；未知 kind ⇒ `item_segments_invalid`(400) | `internal/httpapi/submit.go:91-123` |
| `ContainerForm`（`itemId/type/title/digest/cover/instructor/difficulty/durationSec/attachments/bodyMd/children`，**无** category）/ `emptyContainerForm` / `startNewCourse` | `apps/mobile/src/core/course-edit.ts:48-88` |
| `buildContainerSegments`：属性行 → `assignAttrSeqs`；`bodyMd` 仅 `type==='lesson'` 产行 | `apps/mobile/src/core/course-edit.ts:99-114` |
| `loadContainerForm`：标题取 `items`、其余取 `attrsOf` 三区间；`saveContainer` | `apps/mobile/src/core/course-edit.ts:117-147` |
| `ContainerAttrs`（`cover/instructor/difficulty/duration/attachments/bodyMd`）/ `emptyAttrs` / `attrsOf`（`default` 分支静默忽略未知 kind）/ `digestOf` / `childrenRowsOf` / `childCounts` | `apps/mobile/src/core/container-view.ts:24-100` |
| 分类读取：`splitCategories`（`source==='category'`，按 `itemId` 升序）/ `coursesOfCategory`（读清单 `seq>=1`，悬空引用静默跳过）/ `childrenOf` | `apps/mobile/src/core/course-tree.ts:20-52` |
| 课程页模板四段（标题栏 / 搜索 / 分类分组 / 未归类 / 独立内容）；`load()` 逐分类取清单、空清单跳过、`referenced` 集合算未归类 | `apps/mobile/src/pages/course/course.vue:15-49,81-117` |
| 课程编辑页字段区（标题 / 简介 / 封面 / 讲师 / 难度 / 时长 / 附件 / 课时清单），**无**分类输入；难度 chips 是 `toggle` 单选范式可复用 | `apps/mobile/src/pages/course/edit.vue:6-73,116-125` |
| 导入器（**只读，一行不改**）：`validateCategories` 单归属硬校验；`rebuildCategories` 全量重算产 `category/<slug>`（`seq>=1 kind=course`）；front-matter `category_*` 解析 | `internal/importer/course.go:56-83,197-286`、`internal/importer/md.go:179-187` |
| `ItemRow`/`SegmentRow` 字段（`ItemRow` 有 `source`/`type`/`title`/`state`；`SegmentRow` 有 `seq`/`kind`/`text`）；core 层单测可用既有假实现（无需真 `uni`） | `apps/mobile/src/core/types.ts:1-11,51-58`、`apps/mobile/src/core/fakes.ts` |
| 版本：基线 `0.15.0` / `20`（批次目标 `0.16.0` / `21`）；门禁与发布前硬检查见 Task 6 | `apps/mobile/src/manifest.json:5-6` |

**环境注意（Windows PowerShell 5.1，无 `pwsh`）：** 不支持 `&&`（用 `;`）与 heredoc（commit 消息写临时文件 + `git commit -F`）。

**工作区注意：** 有未提交的 `.gitignore` 改动与未跟踪的 `based-linux-amd64`，**不要动、不要 add**，每次只 `git add` 本任务文件。

**上游册子回填（已随本计划完成）：** `#40 §2.1` 槽位表新增 `attr.category` 一行、`#40 §0` 追加 `### 0.3`；`#36 §0` 追加 `### 0.3`（指向 `#49`，并申明导入器契约与 `category/<slug>` 形态一字不改）；总纲 §6.0 / 分类条款**经核对无缺口，不改**。

---

## 文件结构

**节点侧（Go）**

| 文件 | 动作 | 职责 |
| --- | --- | --- |
| `internal/protocol/attrs.go` | 修改 | 新增 `AttrKeyCategory = "attr.category"`，加入 `AttrKindSet`（**仅常量与集合，不改 `AssignAttrSeqs` 规则**） |
| `vectors/v1/attrs.json` | 修改 | 新增「含 `attr.category`」用例；**老条目无该行不破排布的回归由既有用例 + TS 单测守住** |

**手机端（TS / Vue）**（下表路径省略前缀 `apps/mobile/src/`）

| 文件 | 动作 | 职责 |
| --- | --- | --- |
| `core/attrs.ts` | 修改 | 新增 `ATTR_CATEGORY` 常量，加入 `ATTR_KIND_SET` |
| `core/attrs.test.ts` | 修改 | 断言新常量在 `ATTR_KIND_SET`（`isAttrKind`）；向量用例自动覆盖 |
| `core/container-view.ts` | 修改 | `ContainerAttrs` 增 `category`；`emptyAttrs` / `attrsOf` 解析 `ATTR_CATEGORY` |
| `core/container-view.test.ts` | 修改 | `attrsOf` 解析 `category`（含缺行 = 空串） |
| `core/course-edit.ts` | 修改 | `ContainerForm` 增 `category`；`emptyContainerForm` 初值；`buildContainerSegments` 对 `type==='course'` 产行；`loadContainerForm` 回填 |
| `core/course-edit.test.ts` | 修改 | 行集构造（含/不含该行）/ 回填单测 |
| `core/course-tree.ts` | 修改 | 新增分组纯函数（双来源 + 优先级 + 组标题解析 + 未归类） |
| `core/course-tree.test.ts` | 修改 / 创建 | 上述纯函数单测 |
| `pages/course/edit.vue` | 修改 | 新增「分类」字段（手填 slug）+ 本机候选点选（`splitCategories(listItems())`，零新接口） |
| `pages/course/course.vue` | 修改 | 分组展示改走新读取（`groups` VM 由 `category.itemId/title` 改为 `slug/title`） |
| `manifest.json` | 修改 | 版本 `0.16.0` / `21`（随批次单次发布） |

---

### Task 1: 双端 `attr.category` 常量 + 契约向量（含老条目不破排布回归）

**Files:** Modify `internal/protocol/attrs.go`、`vectors/v1/attrs.json`、`apps/mobile/src/core/attrs.ts`、`apps/mobile/src/core/attrs.test.ts`

- [ ] **Step 1: 写失败的测试（TS 侧先加断言）**

在 `core/attrs.test.ts` 的 `isAttrKind` 用例里补 `ATTR_CATEGORY`：`expect(isAttrKind(ATTR_CATEGORY)).toBe(true)`（并 import 该常量）。

Run（cwd `apps/mobile`）: `npx vitest run src/core/attrs.test.ts` ⇒ **失败**（`ATTR_CATEGORY` 未定义 / 编译失败）。

- [ ] **Step 2: 双端加常量与集合条目**

Go `internal/protocol/attrs.go`：常量块内加 `AttrKeyCategory = "attr.category"`（**按现有书写顺序插入于 `AttrKeyBodyMD` 之后**，仅可读性，不影响字典序）；`AttrKindSet` 加 `AttrKeyCategory: true`。
TS `core/attrs.ts`：加 `export const ATTR_CATEGORY = 'attr.category';`；`ATTR_KIND_SET` 加 `[ATTR_CATEGORY]: true`。

**判据**：`AssignAttrSeqs` / `assignAttrSeqs` **不带任何改动**——它们只对**传入的** kind 分配 seq，新增 kind 条目本身不改变任何既有输入的排布（老条目无该行 ⇒ 逐字节不变）。

- [ ] **Step 3: 向量新增用例（含 `attr.category`）**

`vectors/v1/attrs.json` 的 `cases` 追加一例（**逐字节写死，勿格式化改动**），断言 `attr.category` 落在 `attr.body_md` 与 `attr.cover` 之间：

```json
{
  "name": "含课程分类（attr.category）",
  "lines": [
    {"kind": "attr.instructor", "text": "李老师"},
    {"kind": "attr.category", "text": "math"},
    {"kind": "attr.cover", "text": "00112233445566778899aabbccddeeff"},
    {"kind": "attr.body_md", "text": "# 正文\n\n段落\n"}
  ],
  "slots": [
    {"seq": -1, "kind": "attr.body_md", "text": "# 正文\n\n段落\n"},
    {"seq": -2, "kind": "attr.category", "text": "math"},
    {"seq": -3, "kind": "attr.cover", "text": "00112233445566778899aabbccddeeff"},
    {"seq": -4, "kind": "attr.instructor", "text": "李老师"}
  ]
}
```

（字典序：`attr.body_md` < `attr.category` < `attr.cover` < `attr.instructor`。）

- [ ] **Step 4: 老条目不破排布的回归**

既有三例（`六属性全给` / `仅封面与讲师` / `无属性`）的 `slots` **一字不改**——它们是「老条目 ⇒ 排布不变」的回归证据。补一条 TS 单测（`attrs.test.ts` 的分配规则边界 describe）：对**不含** `ATTR_CATEGORY` 的同一字段集，`assignAttrSeqs` 结果与加入该常量前逐字节一致（即既有断言仍成立）。

Run（cwd `apps/mobile`）: `npx vitest run src/core/attrs.test.ts` ⇒ 全绿。

- [ ] **Step 5: Go 侧跑向量 + 三连**

Run（仓库根）: `go test ./internal/protocol/ -run 'TestAttr' -v` ⇒ 全 `PASS`（新用例过，既有用例不改仍过）。
Run（仓库根）: `go build ./... ; go vet ./... ; go test ./...` ⇒ 全包 ok。

- [ ] **Step 6: 提交**

```bash
git add internal/protocol/attrs.go vectors/v1/attrs.json apps/mobile/src/core/attrs.ts apps/mobile/src/core/attrs.test.ts
git commit -m "feat(protocol): 新增 attr.category 槽位常量并同步双端契约向量"
```

---

### Task 2: `ContainerForm.category` 读写 + `ContainerAttrs.category` + vitest

**Files:** Modify `core/container-view.ts`、`core/container-view.test.ts`、`core/course-edit.ts`、`core/course-edit.test.ts`

- [ ] **Step 1: 写失败的测试**

`core/container-view.test.ts`：`attrsOf` 对一条 `{seq:-1,kind:'attr.category',text:'math'}` 返回 `category === 'math'`；无该行返回 `''`。
`core/course-edit.test.ts`：
① `buildContainerSegments({type:'course', category:'math', ...})` 行集**含** `{kind:'attr.category', text:'math'}`，且经 `assignAttrSeqs` 规范排布；
② `category:''` ⇒ **不含**该行；
③ `type:'lesson'` 且 `category:'math'` ⇒ **不含**该行（课程专用）；
④ `loadContainerForm` 从含该行的行集回填 `form.category === 'math'`。

Run（cwd `apps/mobile`）: `npx vitest run src/core/container-view.test.ts src/core/course-edit.test.ts` ⇒ **失败**。

- [ ] **Step 2: `container-view.ts` 增 `category`**

`ContainerAttrs` 加 `category: string`（注释：分类 slug，空串 = 未设置）；`emptyAttrs` 初值 `category: ''`；`attrsOf` 的 `switch` 加 `case ATTR_CATEGORY: out.category = s.text; break;`（import `ATTR_CATEGORY`）。

- [ ] **Step 3: `course-edit.ts` 增 `category`**

`ContainerForm` 加 `category: string`（注释：仅课程；分类 slug；空则不产该行）；`emptyContainerForm` 初值 `category: ''`；`buildContainerSegments` 在属性行区加：`if (form.type === 'course' && form.category !== '') lines.push({ kind: ATTR_CATEGORY, text: form.category });`（**先 trim**，见 Task 3 的写入侧软约束）；`loadContainerForm` 加 `form.category = type === 'course' ? attrs.category : '';`（import `ATTR_CATEGORY`）。

- [ ] **Step 4: 跑测试**

Run（cwd `apps/mobile`）: `npx vitest run src/core/container-view.test.ts src/core/course-edit.test.ts` ⇒ 全绿。
Run（cwd `apps/mobile`）: `npx tsc --noEmit` ⇒ 干净。

- [ ] **Step 5: 提交**

```bash
git add apps/mobile/src/core/container-view.ts apps/mobile/src/core/container-view.test.ts apps/mobile/src/core/course-edit.ts apps/mobile/src/core/course-edit.test.ts
git commit -m "feat(mobile): 容器表单与视图支持 attr.category 读写"
```

---

### Task 3: 课程编辑页「分类」输入 + 本机候选点选（零新接口）

**Files:** Modify `pages/course/edit.vue`

- [ ] **Step 1: 插入「分类」字段（模板）**

在 `讲师` 字段（`:24-27`）与 `难度` 字段（`:29-40`）之间插入：

```html
<view class="field">
  <text class="label">分类</text>
  <input v-model="categoryInput" class="input" placeholder="分类 slug，如 math（可空）" />
  <view v-if="categoryCandidates.length > 0" class="chips">
    <text
      v-for="c in categoryCandidates"
      :key="c.slug"
      class="chip"
      :class="categoryInput.trim() === c.slug ? 'chip-on' : ''"
      @click="pickCategory(c.slug)"
    >{{ c.label }}</text>
  </view>
  <text class="hint">slug 规则 [a-z0-9][a-z0-9-]{0,63}；空则不归类</text>
</view>
```

- [ ] **Step 2: 候选源与回填（脚本）**

`const categoryInput = ref('');`、`const categoryCandidates = ref<Array<{ slug: string; label: string }>>([]);`。
`onLoad` 里（既有 `repo.listItems()` 那次复用）：`const cats = splitCategories(await repo.listItems()); categoryCandidates.value = cats.map((c) => ({ slug: c.itemId.replace(/^category\//, ''), label: c.title || c.itemId.replace(/^category\//, '') }));`（**候选源 = 本机 repo，零新接口**；import `splitCategories`）。
编辑态：`form.value = await loadContainerForm(...)` 后 `categoryInput.value = form.value.category;`。
`pickCategory(slug)`：`categoryInput.value = categoryInput.value.trim() === slug ? '' : slug;`（再点取消）。

- [ ] **Step 3: 写入侧软约束（提交前归一）**

在 `submit()` 里（`f.durationSec = durationSecOf();` 旁）加：`f.category = normalizeCategorySlug(categoryInput.value);`。`normalizeCategorySlug(raw)`：`const s = raw.trim(); return /^[a-z0-9][a-z0-9-]{0,63}$/.test(s) ? s : '';`——**空 / 非法一律归空（= 不产该行）**，非法时置 `error.value = '分类 slug 只允许 [a-z0-9][a-z0-9-]{0,63}'` 并 `return`（不提交）。

- [ ] **Step 4: 验证**

Run（cwd `apps/mobile`）: `npx tsc --noEmit` ⇒ 干净；`npm run build:h5` ⇒ 通过。
Run（仓库根，发布前硬检查）: `grep -nE '="[^"]*\.value|\{\{[^}]*\.value' apps/mobile/src/pages/*/*.vue` ⇒ **无输出**。
**人工判据（AC 3）**：本机已有 `category/<slug>` 时 chips 出现且点选回填；手填合法 slug 保存后课程行集含 `attr.category`；空 / 非法不产该行。

- [ ] **Step 5: 提交**

```bash
git add apps/mobile/src/pages/course/edit.vue
git commit -m "feat(mobile): 课程编辑页新增分类输入与本机候选项（零新接口）"
```

---

### Task 4: 分组读取纯函数（双来源 + 优先级 + 组标题解析）+ vitest

**Files:** Modify `core/course-tree.ts`、`core/course-tree.test.ts`（若无则创建）

- [ ] **Step 1: 写失败的测试**

`core/course-tree.test.ts` 覆盖四组：
① **优先级**：课程 A 的 segments 含 `attr.category=math`，同时 `category/physics` 清单行含 `course/A` ⇒ A 归 `math`，**不**归 `physics`；
② **回退**：课程 B 无 `attr.category`，`category/math` 清单行含 `course/B` ⇒ B 归 `math`；
③ **组标题**：存在 `category/math`（`title='数学'`）⇒ 标题 `数学`；slug `self` 无对应容器 ⇒ 标题 `self`（回落 slug）；
④ **未归类**：两来源都未归入的课程进 `unclassified`；空组（无课程）不显示。
另断言：分组按 slug（`category/<slug>`）升序。

Run（cwd `apps/mobile`）: `npx vitest run src/core/course-tree.test.ts` ⇒ **失败**。

- [ ] **Step 2: 实现分组纯函数**

在 `core/course-tree.ts` 新增（**不改**既有 `splitCategories` / `coursesOfCategory` / `childrenOf` / `lessonNo`）：

```ts
export interface CategoryGroup { slug: string; title: string; courses: ItemRow[]; }

/** 读取分组（#49 §3）：优先 attr.category，缺失才回退 category/<slug> 清单行；只读，不改库与清单。 */
export function groupCoursesByCategory(
  items: ItemRow[],
  segsByItemId: Map<string, SegmentRow[]>,
): { groups: CategoryGroup[]; unclassified: ItemRow[] } { /* … */ }
```

算法：① `cats = splitCategories(items)`，建 `slug → catItem` 表（取标题用）；② 遍历课程（`type==='course' && itemId.startsWith('course/')`）：先读自身 `segsByItemId.get(course.itemId)` 的 `attr.category`（经 `attrsOf(...).category`）→ 命中即归该 slug；未命中则扫各 `category/*` 清单行（`coursesOfCategory` 的逆，或直接遍历分类 segments 找 `course/<cid>`）得 slug；③ 两来源都无 ⇒ `unclassified`；④ 组装 `groups`：标题 = `catItem?.title || slug`，按 `category/<slug>` 升序，**空组丢弃**。

- [ ] **Step 3: 跑测试**

Run（cwd `apps/mobile`）: `npx vitest run src/core/course-tree.test.ts` ⇒ 全绿。
Run（cwd `apps/mobile`）: `npx tsc --noEmit` ⇒ 干净。

- [ ] **Step 4: 提交**

```bash
git add apps/mobile/src/core/course-tree.ts apps/mobile/src/core/course-tree.test.ts
git commit -m "feat(mobile): 分类分组读取纯函数（双来源 + 优先级 + 组标题解析）"
```

---

### Task 5: 课程页分组展示改走新读取

**Files:** Modify `pages/course/course.vue`

- [ ] **Step 1: 数据面改造（`load()`）**

把「逐分类取清单」段（`:90-105`）换成：先取全部 active items，依次 `listSegments` 建 `segsByItemId`（仅课程与其所属分类需要，实际按需取）；调 `groupCoursesByCategory(active, segsByItemId)` 得 `groups` / `unclassified`。
VM 类型改为 `{ slug: string; title: string; courses: ItemRow[] }`（去掉 `category.itemId`）；`total` 计算同步改用 `g.courses.length`。

- [ ] **Step 2: 模板改造**

分组块（`:15-26`）：`g.category.itemId` → `g.slug`（`v-for` 的 `:key`、`toggle(...)`、`collapsed[...]`）；`g.category.title` → `g.title`。其余（未归类 / 独立内容）不变。

- [ ] **Step 3: 验证**

Run（cwd `apps/mobile`）: `npx vitest run ; npx tsc --noEmit ; npm run build:h5` ⇒ 全绿 + 构建成功。
Run（仓库根，发布前硬检查）: `grep -nE '="[^"]*\.value|\{\{[^}]*\.value' apps/mobile/src/pages/*/*.vue` ⇒ **无输出**。
**人工判据（AC 4 / AC 5）**：自建课程填 `category=self` ⇒ 课程页出现 `self` 分组（标题 = slug）；导入器产的分类标题仍显示容器 `title`；`attr.category` 优先、清单行忽略。

- [ ] **Step 4: 提交**

```bash
git add apps/mobile/src/pages/course/course.vue
git commit -m "feat(mobile): 课程页分类分组改走双来源读取"
```

---

### Task 6: 门禁与收口（`#45 §6` 全部门禁 + 发布前硬检查 + 版本 `0.16.0`/`21`）

**Files:** Modify `apps/mobile/src/manifest.json:5-6`、`docs/README.md`（`#50` 行状态、§5 当前阶段）

- [ ] **Step 1: 全量门禁（`#45 §6`）**

Run（仓库根）: `go build ./... ; go vet ./... ; go test ./...` ⇒ 全包 ok。
Run（cwd `apps/mobile`）: `npx vitest run ; npx tsc --noEmit ; npm run build:h5` ⇒ vitest 全绿（**不少于 23 文件 / 230 用例**，含新增用例）、`tsc` 干净、`build:h5` 通过。
Run（仓库根）: `scripts/acceptance-d.ps1` ⇒ D 组 TC-D01–TC-D07 全 PASS。
Run（仓库根）: `git diff --stat internal/importer` ⇒ **无输出**（AC 6：导入器一行不改）。

- [ ] **Step 2: AC 1–9 验证动作逐条落地**

| AC | 验证动作 / 判据 |
| --- | --- |
| AC 1 | 双端共读 `vectors/v1/attrs.json`：`go test ./internal/protocol/` 与 `npx vitest run src/core/attrs.test.ts` 全绿 |
| AC 2 | 老条目：既有三例向量 `slots` 未改且仍过；新增「含 `attr.category`」用例过；`AttrSeqsCanonical` 顺序无关回归过 |
| AC 3 | 编辑页分类：合法 slug 产 `attr.category`、空/非法不产、本机候选可点选（人工 H5） |
| AC 4 | 双来源优先级：`attr.category` 命中的课程不出现在清单行给出的另一分类（`course-tree.test.ts`） |
| AC 5 | 组标题：容器 `title` 优先、无容器回落 slug（`course-tree.test.ts`） |
| AC 6 | `git diff --stat internal/importer` 无输出；分组读取只读 |
| AC 7 | 代码核对：零新接口 / 零新表 / 零新字段 / 零配置 / 不 bump `schema_version` / 不新增 `source`·`type` 枚举 |
| AC 8 | Step 1 全部门禁 + Step 3 发布前硬检查全通过 |
| AC 9 | 真机：新建课程填分类 → 分组可见（标题按口径）→ 冲突时 `attr.category` 优先 |

- [ ] **Step 3: 发布前硬检查**

Run（仓库根）: `grep -nE '="[^"]*\.value|\{\{[^}]*\.value' apps/mobile/src/pages/*/*.vue` ⇒ **无输出**。保留 `build:app` 产物 `\.value\.value` 计数为 0 的硬检查；`manifest.json:5-6` 版本号已为 `0.16.0` / `21`。

- [ ] **Step 4: 节点二进制部署（本册改了 `internal/protocol/attrs.go`，必须）**

`GOOS=linux GOARCH=amd64 go build -o based-linux-amd64 ./cmd/based` → `scp` → `mv` 覆盖 `/opt/base/based` + `chmod 0755`（保留回滚件 `based.bak-<旧版本>`）→ 重启 `base` 与 `base-cache` → **探活走 HTTPS 443**（纯 HTTP 打 8081/8083 会回 400）。未部署则含 `attr.category` 的投稿被拒为 `item_segments_invalid`(400)。

- [ ] **Step 5: 随批次单次发布（不单独发版）**

本册**不单独发布**，随 `#45` 批次的 `0.16.0` / `21` 单次发布（四步：云打包 APK → 上传 `/opt/appdl/base-0.16.0.apk` → 落地页整页重写改指 → `based release` 签发落 `/opt/base-cache/data/release.json`）。

- [ ] **Step 6: 文档回填 + 提交**

`docs/README.md`：`#50` 行状态改「已执行（完整度见本计划「执行实况」；随批次 `0.16.0`/`21` 单次发布；真机验收待人工）」，§5 当前阶段同步。

```bash
git add apps/mobile/src/manifest.json docs/README.md
git commit -m "chore(release): 课程分类属性槽位随批次收口 0.16.0/21 并回填文档"
```

---

## 明确不做什么

- 不做**分类多级树**与**多归属**。
- 不做**节点侧分类管理接口**（增删改一律走导入器）。
- **不在 App 里新建 `category/<slug>` 容器**（那会新开写面）。
- 不改 **`#36` 的导入器契约与 `category/<slug>` 形态**。
- 不改 **`#40` 两条哈希口径**。
- 不新增**表 / 字段 / `source`·`type` 枚举值 / 配置项**；不 bump `schema_version`。
- 不做 **iOS**。
- 不改**导入器** `internal/importer/*`（一行不动）。

---

## 自检清单

- [ ] **spec 覆盖**：§2.1→T1S2；§2.2→T1S3/T3S3；§3.1/§3.2→T4S2；§3.3→T4S2；§3.4→T4S2/T5S1；§4.1→T2/T3；§4.2→T5；§5 老条目→T1S4；§6 AC 1–9→T6S2；§7→T6S4、5（T=Task，S=Step）。
- [ ] **其余三项**：全文无 `TODO`/`FIXME`/`xxx`/`待补`（`<version>`/`<旧版本>` 为命令占位）；`attr.category` 在**读时**生效、库与清单行不动；`AssignAttrSeqs` / `assignAttrSeqs` **未改规则**（仅新增 kind 条目）。

## 执行实况

（留空待执行时回填）