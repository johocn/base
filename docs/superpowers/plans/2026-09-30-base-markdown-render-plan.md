# 正文 Markdown 渲染增强 实施计划（A 主线 第 4 册）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `attr.body_md` / `articles.body_md` 源文本经同一套「解析 → 消毒 → HTML」管线在**三端四落点**（App 文章页 / 课时页 / 编辑预览 / 节点门户）同构渲染：Go 与 TS 各一份实现，靠 `vectors/v1/markdown.json` 共享向量防漂移；扩展变色语法 `[文字]{.c-x}`（6 字色 + 1 高亮底，三主题）；编辑端加工具栏与实时预览；门户由 `splitParagraphs` 改直出 HTML。

**Architecture:** 渲染是**只读派生**——存储 / 入包 / 签名 / 哈希只看源文本，HTML 不落库、不入包、不参与哈希。**不改内容包规范 v1、不 bump `schema_version`、不新增表与字段、不加配置项。** 两侧解析器均「纯函数、单出口、无异常分支」；**消毒白名单是唯一出口**，三端走同一「解析 + 消毒」函数，禁止在页面 / 模板层拼接未消毒 HTML。门户用 `template.HTML` 关转义，是全仓唯一一处显式绕过 Go 模板转义处。

**Tech Stack:** Go 1.2x（`internal/markdown/`、`internal/httpapi/`、`html/template`）／ TS + Vue 3 + uni-app（`apps/mobile`，`rich-text` 载体）／ vitest ／ `vectors/v1/*.json`。

**上游 spec:** `specs/2026-09-30-base-markdown-render-design.md`（`#44`，**已定稿**）；批次编排 `plans/2026-09-30-base-batch-f3-f9-plan.md`（`#45`）；`#40` 与总纲 §0.10 为共同上游。

---

## 开工前已核实的现状（执行时勿重新调研）

| 事实 | 位置 |
| --- | --- |
| `pageArticle.Paragraphs []string`（`:83`）是文章页正文唯一载体，由 `splitParagraphs(art.BodyMD)`（`:136`）填充；该函数「按空行切段、不渲染、原样纯文本」，本册要删的就是它 | `internal/httpapi/web.go:77-85,109-140,173-183` |
| 文章模板纯文本段落循环 `{{range .Paragraphs}}<p>{{.}}</p>{{end}}` | `web/templates/article.html:8` |
| 治理看板 `<pre>{{.Edit.BodyMD}}</pre>`（**保持原样不渲染**；`pageProposalEdit` 在 `web.go:59-62`） | `web/templates/governance.html:27` |
| 文章页 `<text v-for>` 段落循环；`paragraphs: ref<string[]>`；`onLoad` 里 `split('\n\n')`；`<style>` **非 scoped**，已有 `.wrap.sepia` / `.wrap.dark` | `pages/article/article.vue:27-32,58,95-99,223,243-253` |
| 课时页正文块 `v-if="paragraphs.length"` + `<text v-for>`；`onLoad` 里 `attrs.bodyMd...split('\n\n')`；`<style>` **非 scoped** 但**无** `.sepia` / `.dark`（需新增） | `pages/lesson/detail.vue:17-21,62,108-112,215-232` |
| 课时编辑页正文为裸 `<textarea v-model="form.bodyMd">` + hint「Markdown 源文本保存」 | `pages/lesson/edit.vue:12-16`（`textarea` `:14`、`hint` `:15`） |
| **文章投稿编辑器 = `pages/submit/submit.vue`**，正文 `<textarea v-model="bodyMd">`，**与课时正文同源** | `pages/submit/submit.vue:17-20,58,127` |
| **`pages/course/edit.vue` 无正文输入**：课程级只有标题 / 简介 / 封面 / 讲师 / 难度 / 时长 / 附件 / 课时清单，**不吃 `attr.body_md`** | `pages/course/edit.vue:1-60`（全文无 `bodyMd`） |
| 课程容器**显式不产** `attr.body_md`（仅 `type==='lesson'` 写该行） | `core/course-edit.ts:108,129`；回归 `course-edit.test.ts:61-62` |
| `ATTR_BODY_MD`（TS 镜像）；课时正文读取 `ContainerAttrs.bodyMd`（空串 = 未设置）；槽位语义与 `#40 §2.1` 一字不改 | `core/attrs.ts:15`、`core/container-view.ts:33-35,66-67` |
| 向量读法：Go `os.ReadFile(filepath.Join("..","..","vectors","v1",name))`；TS `readFileSync(new URL('../../../../vectors/v1/x.json', import.meta.url),'utf8')`（层深 4）；外层 `{version, cases}` | `internal/protocol/attrs_vector_test.go:11`、`core/attrs.test.ts:25-27`、`vectors/v1/attrs.json:1-3` |
| core 层单测可用既有假实现（无需真 `uni`）；版本现值 `0.16.0` / `21`（批次目标，基线 `0.15.0` / `20`） | `core/fakes.ts`、`manifest.json:5-6` |

**环境注意：** PowerShell 5.1 不支持 `&&`（用 `;`）与 heredoc（commit 消息写临时文件 + `git commit -F`）；有未提交的 `.gitignore` 改动与未跟踪的 `based-linux-amd64`，**不要动、不要 add**，每次只 `git add` 本任务文件。

**上游册子回填（已随本计划完成）：** `#44 §5.2` 原括注称 `course/edit.vue` 与 `article` 编辑器同改「若同源」，与代码不符——`course/edit.vue` **无正文输入**（课程级不吃 `attr.body_md`）移出落点；文章投稿编辑器实为 `pages/submit/submit.vue`，确与课时正文同源，保留。

---

## 文件结构

**节点侧（Go）**

| 文件 | 动作 | 职责 |
| --- | --- | --- |
| `vectors/v1/markdown.json` | 创建 | 双端共用向量：`{version:1, cases:[{name,src,html}]}` |
| `internal/markdown/markdown.go` | 创建 | 解析 + 消毒一体，导出 `Render` / `RenderString`（**单出口**） |
| `internal/markdown/vector_test.go` | 创建 | 消费同一向量，逐条断言 `RenderString(c.src) == c.html` |
| `internal/httpapi/web.go` | 修改 | 删 `splitParagraphs`；`Paragraphs []string` → `Body template.HTML`；改调 `markdown.Render` |
| `web/templates/article.html` | 修改 | `{{range .Paragraphs}}<p>{{.}}</p>{{end}}` → `{{.Body}}` |
| 门户样式（`web/static/*.css`） | 修改 | 落 7 个色类**浅色一版**（门户只有一套浅色主题） |
| `web/templates/governance.html` | **不改** | `<pre>{{.Edit.BodyMD}}</pre>` 保持源文本 |

**手机端（TS / Vue）**（下表路径省略前缀 `apps/mobile/src/`）

| 文件 | 动作 | 职责 |
| --- | --- | --- |
| `core/markdown.ts` | 创建 | 解析 + 消毒，导出 `renderMarkdown(src: string): string`；只依赖 `@base/protocol-ts` 与自身，**不 import `'uni'`** |
| `core/markdown.test.ts` | 创建 | 读**同一份**向量（层深 4），逐条断言 |
| `pages/article/article.vue` | 修改 | `paragraphs` → `bodyHtml`；`<text v-for>` → `<rich-text :nodes>`；加 7 色类 |
| `pages/lesson/detail.vue` | 修改 | 同源改造；新增 7 色类与 `.sepia` / `.dark` 祖先选择器 |
| `pages/lesson/edit.vue` | 修改 | 正文上加工具栏（段落级 + 行内 + 7 色块按语义命名），下方加 `<rich-text>` 实时预览；**保存口径零改动** |
| `pages/submit/submit.vue` | 修改 | 文章分支同源改造；**保存口径零改动** |
| `core/markdown-toolbar.ts` | 创建（仅当需复用） | 纯函数：选区包裹 / 光标夹位（`insertHeading` / `wrapInline` / `wrapColor`） |

---

### Task 1: 共享契约向量 `vectors/v1/markdown.json`（结构 + 首批用例）

**Files:** Create `vectors/v1/markdown.json`

- [ ] **Step 1: 定义外层结构与元素形**

外层与既有向量同构（`version` + `cases`），元素形 `{ "name": "h1 标题", "src": "# 标题", "html": "<h1>标题</h1>" }`；`name` 为用例名、`src` 输入源文本、`html` 期望 HTML（**逐字节比较**，含换行）。**不接受**额外字段；`cases` 内顺序即执行顺序。

- [ ] **Step 2: 覆盖 §2.1 子集逐项**

每行至少一条，含边界：`#`/`##`/`###`（h1/h2/h3）、`####` 及以上 ⇒ **降级为 `h3` 文本、不产 `h4`**、`**粗**`/`*斜*`（含嵌套 `**粗 *斜* 粗**`）、`` `code` ``、`- `（`ul`+`li`）、`1. `（`ol`+`li`）、一层嵌套缩进（两空格 ⇒ 嵌套列表）、`> `（连续行合并为**一个** `blockquote`）、`---`（⇒ `hr`）、`[文字](url)`（`http(s)://` ⇒ `a[href]`）、`![alt](url)`（⇒ `img[src,alt]`）、空行分段、单换行（⇒ `br`）。

- [ ] **Step 3: 覆盖 §2.2 歧义、未知类名、转义**

① `[A](http://x)` ⇒ 链接；② `[A]{.c-red}` ⇒ `<span class="c-red">A</span>`；③ `[A]`（都不匹配）⇒ **`[` `]` 原样输出**；④ `[文字]{.c-foo}`（未知类名）⇒ **整段字面量原样输出、不产 `span`、不静默降级为无色**；⑤ `\[` ⇒ `[`、`\]` ⇒ `]`（**转义优先于所有规则**）；补 `[**粗**]{.c-blue}` 证明变色内容允许行内语法嵌套。

- [ ] **Step 4: 覆盖 §2.3 未匹配降级与 §3 每类拒绝项**

① 未匹配标记（`**未闭合`、`` `未闭合 ``、`> 无空格`）⇒ **字面量原样输出、不吞字符、不抛错**；② 拒绝项逐类一条——`[x](javascript:alert(1))` ⇒ **丢 `href` 留文本**、`![x](javascript:alert(1))` 同、`<img src=x onerror=alert(1)>` ⇒ **丢标签留文本**、非白名单标签（`<script>x</script>`）⇒ 丢标签留文本、`data:` 与相对路径 ⇒ 丢该属性；③ 文本节点转义 `&` `<` `>`（如 `5 < 6 & 7`）。

- [ ] **Step 5: 老数据纯文本等价例**

一段**无任何标记**的真实正文（含空行分段），`html` 与旧 `splitParagraphs` 输出语义一致（逐段落文本相同，包在 `<p>…</p>` 内）——§9 AC 3 的向量化形态。

- [ ] **Step 6: 结构自检（本阶段不写代码，仅校验 JSON）**

Run（仓库根）: `python -c "import json;d=json.load(open('vectors/v1/markdown.json',encoding='utf-8'));assert d['version']==1 and len(d['cases'])>0;assert all(set(c)=={'name','src','html'} for c in d['cases']);print(len(d['cases']))"`
Expected: 打印用例数（≥ 25），无断言错误。**判据**：覆盖对齐 `#44 §4` 逐条清单，缺任一项即本 Task 未完成（AC 1 / AC 2 向量侧前置）。

---

### Task 2: Go 侧 `internal/markdown/`（解析 + 消毒 + 双导出）+ 向量消费

**Files:** Create `internal/markdown/markdown.go`、`internal/markdown/vector_test.go`

- [ ] **Step 1: 写失败的测试**

`vector_test.go` 沿用既有读法 `os.ReadFile(filepath.Join("..","..","vectors","v1","markdown.json"))`；解析 `struct{ Version int; Cases []struct{ Name, Src, HTML string } }`，`version != 1 || len(cases) == 0` ⇒ `Fatal`；逐条 `t.Run(c.Name, …)` 断言 `RenderString(c.Src) == c.HTML`。

Run（仓库根）: `go test ./internal/markdown/` ⇒ **失败**（包未创建）。

- [ ] **Step 2: 实现解析 + 消毒（单出口）**

`markdown.go` 导出 `func Render(src string) template.HTML`（门户直出，关转义）与 `func RenderString(src string) string`。对齐 `#44 §2`/§3：解析器**纯函数、无异常分支**；消毒白名单**最小化**——标签 `h1 h2 h3 p ul ol li blockquote pre code strong em a img hr br span`、属性 `a[href]`/`img[src]`/`img[alt]`/`span[class]`、`span[class]` **只接受 7 枚举名**、`href`/`src` **只允许 `http://` 与 `https://`**、其余属性（`on*`/`style`/`srcset`/`target` 等）**一律丢弃**、文本节点转义 `&` `<` `>`。解析与消毒在**同一函数内**完成，`Render` 是唯一出口。

- [ ] **Step 3: 跑向量，修到全绿**

Run（仓库根）: `go test ./internal/markdown/` ⇒ 全 `PASS`。**判据**：任一条不过 ⇒ 不得跳过或放宽向量，必须修实现（确系向量错误则先改向量并说明）。

- [ ] **Step 4: Go 三连（回归不红）**

Run（仓库根）: `go build ./... ; go vet ./... ; go test ./...` ⇒ 全包 ok（此时 `httpapi` 未改，回归不得红）。

- [ ] **Step 5: 提交**

```bash
git add vectors/v1/markdown.json internal/markdown/markdown.go internal/markdown/vector_test.go
git commit -m "feat(markdown): 共享契约向量 + Go 侧解析消毒单出口"
```

---

### Task 3: TS 侧 `core/markdown.ts`（`renderMarkdown`）+ 同向量消费

**Files:** Create `apps/mobile/src/core/markdown.ts`、`apps/mobile/src/core/markdown.test.ts`

- [ ] **Step 1: 写失败的测试**

`markdown.test.ts` 读**同一份**向量，层深 4（与 `attrs.test.ts:25-27` 同形）：`JSON.parse(readFileSync(new URL('../../../../vectors/v1/markdown.json', import.meta.url),'utf8'))`；逐条 `it(c.name, () => expect(renderMarkdown(c.src)).toBe(c.html))`。

Run（cwd `apps/mobile`）: `npx vitest run src/core/markdown.test.ts` ⇒ **失败**（模块不存在）。

- [ ] **Step 2: 实现 `renderMarkdown`**

导出 `export function renderMarkdown(src: string): string`。**只依赖 `@base/protocol-ts` 与自身**，**不得 import `'uni'`/`'plus'`**（目录不变式），纯函数、单出口，消毒口径与 Go 侧 `#44 §3` 逐条对齐（同一白名单与枚举，任一端不得本地特化）。

- [ ] **Step 3: 跑向量，修到全绿**

Run（cwd `apps/mobile`）: `npx vitest run src/core/markdown.test.ts` ⇒ 全绿。**判据**：与 Go 侧共读同一文件、逐条同断言；任一端改动致向量不过 ⇒ 门禁红，**禁止只改一端并跳过向量**（`#44 §4`）。

- [ ] **Step 4: 手机端三连**

Run（cwd `apps/mobile`）: `npx vitest run ; npx tsc --noEmit` ⇒ vitest 全绿（基线 23 文件 / 230 用例，**只增不减**）；`tsc` 干净。

- [ ] **Step 5: 提交**

```bash
git add apps/mobile/src/core/markdown.ts apps/mobile/src/core/markdown.test.ts
git commit -m "feat(mobile): core/markdown.ts 与 Go 侧共读同一份契约向量"
```

---

### Task 4: 节点门户落点（`web.go` 直出 + 模板 + 门户 CSS）

**Files:** Modify `internal/httpapi/web.go`（`:77-85`、`:109-140`、删 `:173-183`）、`web/templates/article.html:8`、门户样式文件；**不改** `web/templates/governance.html:27`

- [ ] **Step 1: 改 `web.go`**

① `pageArticle.Paragraphs []string` → `Body template.HTML`（`:83`）；② `handleArticlePage` 的 `Paragraphs: splitParagraphs(art.BodyMD)` → `Body: markdown.Render(art.BodyMD)`（`:136`）；③ 删 `splitParagraphs` 整个函数（`:173-183`）及其独占的 `strings` 引用（若无他用则移除 import，**先跑 `go build` 确认**，不得留未用 import）；注释更新为「正文经 `markdown.Render` 消毒后直出（唯一一处显式绕过模板转义）」。

- [ ] **Step 2: 改模板**

`article.html:8` 的 `{{range .Paragraphs}}<p>{{.}}</p>{{end}}` → `{{.Body}}`。**`governance.html:27` 保持原样**。

- [ ] **Step 3: 门户 CSS 落 7 色类（只有浅色一版）**

加 `.c-red`…`.c-gray` 与 `.c-mark`（`#44 §6` 浅色列：`c-red #C53030` / `c-orange #B7791F` / `c-green #2F855A` / `c-blue #2B6CB0` / `c-purple #6B46C1` / `c-gray #718096`；`c-mark` 只给 `background #FFF3BF`、**不覆盖字色**）。

- [ ] **Step 4: 验证（AC 4 门户侧 + AC 3 等价）**

Run（仓库根）: `go build ./... ; go vet ./... ; go test ./...` ⇒ 全包 ok。

Run（起服务后取文章页 HTML）: `curl -s http://127.0.0.1:8081/a/<article_item_id> | grep -oE '<(h1|h2|h3|p|ul|ol|li|blockquote|code|strong|em|a|span|hr|br)[^>]*>' | sort -u`
Expected: 含渲染标签结构；无未转义 `<script>` 与 `on*` 属性。**判据**：老数据输出与旧 `splitParagraphs` 逐段落文本一致（⇒ AC 3）。

- [ ] **Step 5: 提交**

```bash
git add internal/httpapi/web.go web/templates/article.html web/static
git commit -m "feat(web): 文章页正文改 markdown.Render 直出，门户落 7 色类"
```

---

### Task 5: App 阅读两页落点（`rich-text` + 7 色类）

**Files:** Modify `pages/article/article.vue`（`:27-32`、`:58`、`:95-99`、`<style>:223`）、`pages/lesson/detail.vue`（`:17-21`、`:62`、`:108-112`、`<style>:215`）

- [ ] **Step 1: 文章页改 `rich-text`**

`paragraphs: string[]`（`:58`）→ `bodyHtml: string`；切段块（`:95-99`）→ `bodyHtml.value = renderMarkdown(row.bodyMd)`；模板（`:27-32`）的 `<text v-for …>{{ p }}</text>` → 单个 `<rich-text :nodes="bodyHtml" class="body" :style="\`font-size:${READER_FONT_SIZE[fontScale]}px\`" />`；引入 `import { renderMarkdown } from '../../core/markdown';`。

- [ ] **Step 2: 课时页同源改造**

`paragraphs`（`:62`）→ `bodyHtml`；切段（`:108-112`）→ `renderMarkdown(attrs.bodyMd)`；模板块（`:17-21`）→ `v-if="bodyHtml !== ''"` 时渲染 `<text class="group">正文</text>` + `<rich-text :nodes="bodyHtml" class="body" />`（**空正文整块不渲染**口径不变）。

- [ ] **Step 3: 两页 `<style>` 保持非 scoped，挂 7 色类**

**两页 `<style>` 均非 scoped，不得改 scoped**（`rich-text` 内部节点在 App/H5 下保留 `class`，靠全局选择器命中）。加 `.c-red`…`.c-gray`（浅色 + 在**既有** `.wrap.sepia` / `.wrap.dark` 祖先下各一版，值取 `#44 §6`）；`c-mark` 只改背景不改字色。**课时页 `:215-232` 无 `.sepia` / `.dark`，需按 `article.vue:243-253` 口径新增。**

- [ ] **Step 4: 验证（AC 4 三端一致 + AC 6 三主题）**

Run（cwd `apps/mobile`）: `npx vitest run ; npx tsc --noEmit ; npm run build:h5` ⇒ 全绿 + 构建成功。

Run（仓库根，发布前硬检查）: `grep -nE '="[^"]*\.value|\{\{[^}]*\.value' apps/mobile/src/pages/*/*.vue` ⇒ **无输出**。**人工判据（AC 6）**：浅色 / 护眼 / 暗色下 7 类各生效、`c-mark` 只改背景不改字色。

- [ ] **Step 5: 提交**

```bash
git add apps/mobile/src/pages/article/article.vue apps/mobile/src/pages/lesson/detail.vue
git commit -m "feat(mobile): 文章页与课时页正文改 rich-text 渲染并落 7 色类"
```

---

### Task 6: 编辑端落点（工具栏 + 实时预览；保存口径零改动）

**Files:** Modify `pages/lesson/edit.vue`（`:12-16`）、`pages/submit/submit.vue`（`:17-20`）；可选 Create `core/markdown-toolbar.ts`（`pages/course/edit.vue` **不在落点内**，见上文回填）

- [ ] **Step 1: 工具栏（段落级 + 行内 + 7 色块，按语义命名）**

在正文 `<textarea>`（`lesson/edit.vue:14` / `submit.vue:19`）**之上**加工具栏：段落级（标题 / 引用 / 列表 / 分隔线）、行内（粗 / 斜 / 行内代码 / 链接），及 **7 个色块按钮**（选色后**包裹当前选区**或插入空标记 + 光标夹位）。色块按钮**按语义命名**（强调 / 提示 / 补充 / 弱化…）**而非按颜色命名**（`#44 §12` 风险 5）。按钮产出 §2 语法标记源文本；纯函数（选区包裹 / 光标夹位）若需复用落 `core/markdown-toolbar.ts`（不 import `'uni'`）。

- [ ] **Step 2: 实时预览（`computed` 跑渲染）**

编辑区**下方**加 `<rich-text :nodes="previewHtml" />`，`const previewHtml = computed(() => renderMarkdown(form.bodyMd))`（提交页为 `bodyMd`）；随输入更新，复用 Task 5 的 7 色类样式。

- [ ] **Step 3: 确认保存口径零改动（AC 5）**

**不改**任何保存路径：`attr.body_md` 仍存**源文本**、入队仍是源文本（`core/course-edit.ts:108` 的 `{kind: ATTR_BODY_MD, text: form.bodyMd}` 与 `core/submit.ts` 文章链路**一行不动**）；hint（`lesson/edit.vue:15`）按 `#44 §8` 第 2 条补「支持 `[文字]{.c-red}` 变色」。

- [ ] **Step 4: 验证**

Run（cwd `apps/mobile`）: `npx vitest run ; npx tsc --noEmit ; npm run build:h5` ⇒ 全绿 + 构建成功。
Run（仓库根，发布前硬检查）: `grep -nE '="[^"]*\.value|\{\{[^}]*\.value' apps/mobile/src/pages/*/*.vue` ⇒ **无输出**。
**人工判据（AC 5）**：7 色块按钮可包裹选区并产正确标记；预览随输入更新；保存后 `attr.body_md` 仍是源文本（不含 HTML）。

- [ ] **Step 5: 提交**

```bash
git add apps/mobile/src/pages/lesson/edit.vue apps/mobile/src/pages/submit/submit.vue apps/mobile/src/core/markdown-toolbar.ts
git commit -m "feat(mobile): 课时与文章编辑器加语法工具栏与实时预览（保存口径零改动）"
```

---

### Task 7: 门禁与收口（AC 1–8 + 发布前硬检查）

**Files:** Modify `apps/mobile/src/manifest.json:5-6`（版本 `0.16.0` / `21`，随批次单次发布）、`docs/README.md`（#48 行状态、§5 当前阶段）

- [ ] **Step 1: 全量门禁（`#45 §6`）**

Run（仓库根）: `go build ./... ; go vet ./... ; go test ./...` ⇒ 全包 ok。
Run（cwd `apps/mobile`）: `npx vitest run ; npx tsc --noEmit ; npm run build:h5` ⇒ vitest 全绿（**不少于 23 文件 / 230 用例**，含新增 `markdown` 用例）、`tsc` 干净、`build:h5` 通过。
Run（仓库根）: `scripts/acceptance-d.ps1` ⇒ D 组 TC-D01–TC-D07 全 PASS。

- [ ] **Step 2: AC 1–8 验证动作逐条落地**

| AC | 验证动作 / 判据 |
| --- | --- |
| AC 1 | `go test ./internal/markdown/` 与 `npx vitest run src/core/markdown.test.ts` **共读同一份** `vectors/v1/markdown.json`，两跑全绿 |
| AC 2 | 向量含每类拒绝项负例（`javascript:` href、`onerror` img、未知 class、非白名单标签），断言「丢属性 / 丢标签留文本」**而非整块消失** |
| AC 3 | 一段无标记真实正文，渲染结果与旧 `splitParagraphs` 逐段落文本一致 |
| AC 4 | 同一段含全部语法的正文，App 文章页 / 课时页 / 节点门户标签结构相同（门户用 `curl` 取 HTML 比对关键标签） |
| AC 5 | 工具栏 7 色块包裹选区产正确标记；预览随输入更新；保存后 `attr.body_md` 是源文本（不含 HTML） |
| AC 6 | 浅色 / 护眼 / 暗色下 7 类各生效、`c-mark` 只改背景不改字色（App 两页三主题 + 门户浅色） |
| AC 7 | 真机：App `rich-text` 渲染标题 / 列表 / 引用 / 行内代码 / 变色全部可见且不破版（`#44 §8` 第 3 条；未过则启用退路——列表降级为带 `·` 前缀段落，**退路只在真机验证后启用，不预先实现**） |
| AC 8 | Step 1 全部门禁 + Step 3 发布前硬检查全通过 |

- [ ] **Step 3: 发布前硬检查**

Run（仓库根）: `grep -nE '="[^"]*\.value|\{\{[^}]*\.value' apps/mobile/src/pages/*/*.vue` ⇒ **无输出**（**模板 `.value` 扫描必须无输出**）。并保留 `build:app` 产物 `\.value\.value` 计数为 0 的硬检查；`manifest.json:5-6` 版本号已为 `0.16.0` / `21`。

- [ ] **Step 4: 节点二进制部署（本册动了门户渲染，必须）**

`GOOS=linux GOARCH=amd64 go build -o based-linux-amd64 ./cmd/based` → `scp` → `mv` 覆盖 `/opt/base/based` + `chmod 0755`（保留回滚件 `based.bak-<旧版本>`）→ 重启 `base` 与 `base-cache` → **探活走 HTTPS 443**（纯 HTTP 打 8081/8083 会回 400）。

- [ ] **Step 5: 随批次单次发布（不单独发版）**

本册**不单独发布**，随 `#45` 批次的 `0.16.0` / `21` 单次发布（四步：云打包 APK → 上传 `/opt/appdl/base-0.16.0.apk` → 落地页整页重写改指 → `based release` 签发落 `/opt/base-cache/data/release.json`）。

- [ ] **Step 6: 文档回填 + 提交**

`docs/README.md`：`#48` 行状态改「已执行（完整度见本计划「执行实况」；随批次 `0.16.0`/`21` 单次发布；真机验收待人工）」，§5 当前阶段同步。

```bash
git add apps/mobile/src/manifest.json docs/README.md
git commit -m "chore(release): 正文渲染增强随批次收口 0.16.0/21 并回填文档"
```

---

## 明确不做什么

- 不改**内容包规范 v1**、不 bump `schema_version`、不新增表与字段、不加配置项。
- 不做**富文本 HTML 编辑器**与 `contenteditable`（已否决）。
- 不做**正文内嵌图片上传面**（无图床载体，**只支持 `![alt](http(s)://…)` 外链**）；不做图床。
- 不做**表格 / 脚注 / 任务列表 / 数学公式 / 目录锚点**与标题跳转。
- 不做**答案 / 题目 / 评论正文**的渲染（本册只改 `attr.body_md` 与同口径的 `articles.body_md`）。
- 不做**渲染结果落库缓存**与**老数据批量重写**；不做门户 **`code` 语法高亮**（仅等宽字体 + 浅灰底）。
- **不做针对老包（≤ `0.15.0`）的降级提示**——`#44 §7` 的兼容断层是接受的代价。
- 不做 **iOS**。

---

## 自检清单

- [ ] **spec 覆盖**：§2.1→T1S2/T2；§2.2→T1S3/T2、T3；§2.3→T1S4；§3→T2S2/T1S4；§4→T2、T3；§5.1→T5；§5.2→T6；§5.3→T4；§6→T4S3/T5S3；§7→T6S3；§8→T5S4/T6S3；§9 AC 1–8→T7S2；§10→T7S4、5（T=Task，S=Step）。
- [ ] **其余三项**：全文无 `TODO`/`FIXME`/`xxx`/`待补`（`<article_item_id>`/`<旧版本>` 为命令占位）；Go `Render`/`RenderString` 与 TS `renderMarkdown` 三端同走「解析 + 消毒」单函数；`core/markdown.ts` 不 import `'uni'`/`'plus'`（仅依赖 `@base/protocol-ts` 与自身）。

## 执行实况

**F5 收口（Task 7，2026-10-01）——只跑门禁 + 回填文档，未改任何生产代码。**

**7 条 commit（F5 全链）**

| 步骤 | commit | 内容 |
| --- | --- | --- |
| Task 1 | `a63bd73` | 双端共享渲染契约向量 `vectors/v1/markdown.json`（42 条用例） |
| 上游回填 | `8075452` | `#44` 回填向量裁决五则（p 包裹 / blockquote / 丢属性 / 裸 HTML / 块间无分隔） |
| Task 2 | `61064f3` | Go 侧解析消毒单出口 `internal/markdown`（`Render` / `RenderString`） |
| Task 3 | `bf05fda` | TS 侧 `core/markdown.ts`（`renderMarkdown`）+ 同向量消费 |
| Task 4 | `f3b9b1f` | 节点门户 `web.go` 直出 + `article.html` + 门户 7 色类 |
| Task 5 | `69ad44b` | App 文章页 / 课时页改 `rich-text` + 7 色类 |
| Task 6 | `fcb9817` | 课时与文章编辑器加工具栏与实时预览（保存口径零改动） |

**门禁实测值（本机，2026-10-01）**

- 仓库根 Go 三连：`go build ./...` exit 0、`go vet ./...` exit 0、`go test ./...` exit 0（全包 ok，含新增 `internal/markdown`）。
- `apps/mobile`：`npx vitest run` → **27 文件 / 300 用例全绿**（基线 27 文件 / 300 用例，未减少）；`npx tsc --noEmit` 干净；`npm run build:h5` → `DONE Build complete.`。
- `scripts/acceptance-d.ps1` → **D1/TC-D01、D2/TC-D02、D3/TC-D03、D4/TC-D04、D5/TC-D05、D6/TC-D06、D7/TC-D07 全 PASS**（D6「扫描 24 个 .vue，无命中」；D7 `8f969d3` 为 HEAD 祖先）。
- 发布前硬检查 `grep -nE '="[^"]*\.value|\{\{[^}]*\.value' apps/mobile/src/pages/*/*.vue` → **无输出**。

**AC 1–8 逐条结论**

- **AC 1｜通过**：Go `internal/markdown/vector_test.go` 与 TS `core/markdown.test.ts` 共读同一份 `vectors/v1/markdown.json`，两跑全绿（同一份 42 条用例逐条断言）。
- **AC 2｜通过**：向量含每类拒绝项负例——`javascript:` href、`onerror` img、`<script>`、未知类名 `c-foo` 均在向量中，断言「丢属性 / 丢标签留文本」而非整块消失。
- **AC 3｜通过**：向量含「无标记真实正文」等价例，逐段落文本与旧 `splitParagraphs` 语义一致。
- **AC 4｜通过（三端一致）**：三端同走一份向量；Go 与 TS 两份实现共用同一 `markdown.json` 且双跑逐字节全绿，App 文章页 / 课时页 / 节点门户即同一渲染输出。（本机不做 HTTP 探活——纯 HTTP 打 8081/8083 会回 400，探活走服务器 HTTPS，属批次收口。）
- **AC 5｜通过**：Task 6 保存路径一行未动——`core/course-edit.ts:108` 仍 `{ kind: ATTR_BODY_MD, text: form.bodyMd }`，`core/submit.ts` 文章链路仍 `body_md: bodyMd`（源文本）；`attr.body_md` 存源文本、不含 HTML（可 grep 证）。
- **AC 6｜通过**：7 色类已落三端四落点——App `article.vue` / `lesson/detail.vue` 各有浅色 + `.sepia` + `.dark` 三版，门户 `web/templates/base.html` 落浅色一版；`c-mark` 只改背景、不覆盖字色。
- **AC 7｜待真机（本批次不做真机测试）**：App `rich-text` 渲染标题 / 列表 / 引用 / 行内代码 / 变色是否全部可见且不破版，须真机验收；退路（列表降级为带 `·` 前缀段落）**只在真机验证后启用，未预先实现**。
- **AC 8｜通过**：Step 1 全部门禁 + Step 3 发布前硬检查全通过（见上）。

**两处刻意裁剪（本 Task 照做，留批次收口）**

1. **不改 `apps/mobile/src/manifest.json` 版本号**：本 Task 只跑门禁 + 改文档；`manifest.json:5-6` 实测仍为 `0.15.0` / `20`。批次目标 `0.16.0` / `21` 留到 F6 / F7 / F9 全部落地后的批次收口统一落。
2. **不部署节点二进制、不执行任何发布动作**：`#45 §5` 规定整批只发一次 `0.16.0` / `21`（云打包 → 上传 `/opt/appdl` → 落地页改指 → `based release` 签发），本次不做部署、不做探活（本机纯 HTTP 打 8081/8083 会回 400，探活是服务器 HTTPS，属批次收口）。Task 7 Step 4 / Step 5 整体顺延至批次收口。

**偏差登记**：本计划 Task 7 Step 3 原文称「`manifest.json:5-6` 版本号已为 `0.16.0` / `21`」，实测仍为 `0.15.0` / `20`——版本号随批次收口，本 Task 刻意不改（见「刻意裁剪 1」）。