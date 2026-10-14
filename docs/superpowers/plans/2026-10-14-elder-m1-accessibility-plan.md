# M1 适老化改造（字阶令牌 + 首页 A+B 融合 + 27 页三档）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** App 全量适老化：固定字阶令牌（标注 15/大 19/超大 24px）、首页宫格+大卡重排、全部页面字号变量化与点击目标 ≥48px。

**Architecture:** 字阶以 CSS 变量落在 App.vue 全局 style（项目无 scoped、无变量入口，一次定义全端生效）；页面按三档改造（重排/放大/批量过）；tabBar 为原生系统控件不动，页面内放大为主。

**Tech Stack:** uni-app Vue3、TypeScript、vitest、vue-tsc。上游册子：`specs/2026-10-14-base-elder-accessibility-blueprint-design.md` §3（M1）。

**执行约定：**
- 所有 git 命令在 `e:\code\base` 下执行；PowerShell 不支持 `&&`，用 `;` 链接。
- 每个 Task 结束即 commit（只 add 该 Task 文件）；最后一个 Task 完成后 push。
- commit 前跑该 Task 门禁，绿了才提交。

**字号映射规则表（Task 4/5 共用，逐值替换）：**

| 现状 font-size | 替换为 | 语义 |
|---|---|---|
| ≤13px | `var(--fs-annotate)` | 标注字（meta/时间/提示） |
| 14px–17px | `var(--fs-body)` | 大字（正文/列表项/按钮） |
| ≥18px | `var(--fs-title)` | 超大字（页标题/区块标题） |
| 行高 | 统一 `1.6` | 适老阅读节奏 |

**点击目标规则：** 可点击元素（列表项/按钮/菜单项）补 `min-height: 48px;`（按钮类同时 `padding: 12px 16px;`）；确认弹窗主按钮 `min-height: 52px;`。

---

### Task 1: 字阶令牌落全局（App.vue）

**Files:**
- Modify: `apps/mobile/src/App.vue`（现状仅 script 启动逻辑，无 style 块——文件尾新增）

- [ ] **Step 1: 实现**

`App.vue` 文件尾追加（App.vue 的 style 即全局样式，uni-app 官方语义）：

```html
<style>
/* 适老化固定字阶（册子 #84 §3.1）：全部页面 font-size 一律引用变量，禁止新写死字号 */
:root {
  --fs-annotate: 15px;
  --fs-body: 19px;
  --fs-title: 24px;
}
page {
  font-size: var(--fs-body);
  line-height: 1.6;
}
.fs-annotate { font-size: var(--fs-annotate); }
.fs-body { font-size: var(--fs-body); }
.fs-title { font-size: var(--fs-title); }
</style>
```

- [ ] **Step 2: 验证**

Run: `cd apps/mobile; npx vue-tsc --noEmit; npm run build:h5`
Expected: 均成功。

- [ ] **Step 3: Commit**

```powershell
git add apps/mobile/src/App.vue
git commit -m "feat(mobile): 适老化字阶令牌全局变量（标注15/大19/超大24）(#84)"
```

---

### Task 2: 首页重排（index.vue 宫格 + 大卡）

**Files:**
- Modify: `apps/mobile/src/pages/index/index.vue`（现场先读全文，按下方目标结构重排模板与样式；数据获取逻辑保留）

- [ ] **Step 1: 读取现状**

读 `index.vue` 全文，记录：现有数据加载函数与列表渲染变量名（保留复用）、现有 tabBar 首项指向确认。

- [ ] **Step 2: 模板重排**

模板按此结构改写（`{{ }}` 内沿用页面现有数据绑定名，区块顺序固定）：

```html
<template>
  <view class="page">
    <view class="hero">
      <text class="hero-title">base 学习</text>
    </view>
    <input class="search" placeholder="搜索课程与文章" :value="keyword" @input="onSearch" />
    <!-- B 宫格区：2×2 -->
    <view class="grid">
      <view class="cell" @click="go('/pages/course/list')"><text class="cell-ico">📚</text><text class="cell-tx">学课程</text></view>
      <view class="cell" @click="go('/pages/article/list')"><text class="cell-ico">📰</text><text class="cell-tx">看文章</text></view>
      <view class="cell" @click="go('/pages/submit/submit')"><text class="cell-ico">✍️</text><text class="cell-tx">去投稿</text></view>
      <view class="cell" @click="go('/pages/mine/mine')"><text class="cell-ico">👤</text><text class="cell-tx">我的</text></view>
    </view>
    <!-- A 大卡瀑布区：最近更新 -->
    <view class="feed">
      <text class="feed-head">最近更新</text>
      <view class="card" v-for="row in rows" :key="row.itemId" @click="open(row)">
        <text class="card-title">{{ row.title }}</text>
        <text class="card-meta">{{ row.meta }}</text>
      </view>
    </view>
  </view>
</template>
```

`go/open/onSearch/rows` 若页面现有函数名不同，适配现名但职责不变（宫格跳 4 个目标页；大卡点开沿用现有详情跳转；rows 沿用现有列表数据源；页面原本若无搜索则 `onSearch` 为空实现 + `keyword` ref）。

- [ ] **Step 3: 样式（全部引用令牌）**

```css
.hero-title { font-size: var(--fs-title); font-weight: 600; }
.search { height: 48px; border-radius: 24px; background: #fff; border: 1px solid #d9e1ea; padding: 0 20px; font-size: var(--fs-body); margin: 12px 16px; }
.grid { display: flex; flex-wrap: wrap; padding: 0 8px; }
.cell { width: 50%; box-sizing: border-box; padding: 8px; }
.cell-inner, .cell { min-height: 96px; }
.cell { background: #fff; border: 1px solid #d9e1ea; border-radius: 12px; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px; }
.cell-ico { font-size: var(--fs-title); }
.cell-tx { font-size: var(--fs-title); }
.feed-head { font-size: var(--fs-title); font-weight: 600; display: block; padding: 16px 16px 8px; }
.card { background: #fff; border: 1px solid #d9e1ea; border-radius: 12px; padding: 16px; margin: 8px 16px; min-height: 48px; display: flex; flex-direction: column; gap: 6px; }
.card-title { font-size: var(--fs-body); font-weight: 500; }
.card-meta { font-size: var(--fs-annotate); color: #64748b; }
```

- [ ] **Step 4: 门禁**

Run: `cd apps/mobile; npx vue-tsc --noEmit; npx vitest run --reporter=dot; npm run build:h5`
Expected: 全绿。

- [ ] **Step 5: Commit**

```powershell
git add apps/mobile/src/pages/index/index.vue
git commit -m "feat(mobile): 首页适老重排——宫格入口+大卡瀑布 (#84)"
```

---

### Task 3: 我的页重排（mine.vue）

**Files:**
- Modify: `apps/mobile/src/pages/mine/mine.vue`（现场先读全文；菜单现含 创作/治理/私信/标签/收藏/设置 六项）

- [ ] **Step 1: 读取现状**——同 Task 2 Step 1（保留统计/打卡卡片数据绑定）。

- [ ] **Step 2: 改造要点**（结构保持，尺寸与字号适老化）：

1. 统计卡片与打卡/在学卡片：数字用 `var(--fs-title)`，标签用 `var(--fs-annotate)`，卡片 `min-height: 96px`。
2. 菜单区：每项改全宽大行（`min-height: 56px; font-size: var(--fs-body); padding: 0 16px;`，纵向堆叠不做横滑），保留六项原跳转。
3. 页标题用 `var(--fs-title)`。
4. 全部写死字号（现 20/14/13px）按映射规则表替换。

- [ ] **Step 3: 门禁** 同 Task 2 Step 4。Expected: 全绿。

- [ ] **Step 4: Commit**

```powershell
git add apps/mobile/src/pages/mine/mine.vue
git commit -m "feat(mobile): 我的页适老重排——大行菜单+字阶变量 (#84)"
```

---

### Task 4: 高频页放大（常规档，10 页）

**Files（每页同规则）：**
- Modify: `apps/mobile/src/pages/course/detail.vue`、`lesson/detail.vue`、`lesson/edit.vue`、`article.vue`（或 article/list 路径以实际为准）、`submit/submit.vue`、`settings/` 现有设置页、`tag/`、`favorite/`、`govern/`、`message/`（实际路径现场以 Glob `pages/**/*.vue` 对齐）

- [ ] **Step 1: 课程详情完整示例**

`course/detail.vue` 样式段：按映射规则表把 `20px → var(--fs-title)`、`14px → var(--fs-body)`（及 ≤13px → annotate）全部替换；列表项/按钮补 `min-height: 48px`；行高并入 1.6（Task 1 已全局设 `page` 行高，页面无需重复）。正文渲染基准：`.body { font-size: var(--fs-body); }`（册子 §3.4）。

- [ ] **Step 2: 其余高频页同规则执行**

逐页：字号按映射表替换、可点击元素补 `min-height: 48px`。**不做结构改动**。

- [ ] **Step 3: 门禁** 同 Task 2 Step 4。Expected: 全绿。

- [ ] **Step 4: Commit**

```powershell
git add apps/mobile/src/pages
git commit -m "feat(mobile): 高频页适老放大——字阶变量+点击目标48px (#84)"
```

---

### Task 5: 批量过（其余页）

**Files:** 其余全部 `.vue`（pages 目录排除已改页）。

- [ ] **Step 1: 规则化替换**

PowerShell 对剩余页执行映射替换（每文件替换后人工抽查 3 页渲染逻辑无误）：

```powershell
$files = Get-ChildItem apps/mobile/src/pages -Recurse -Filter *.vue | Where-Object { $_.FullName -notmatch 'index|mine|course/detail|lesson|submit|article' }
foreach ($f in $files) {
  $t = Get-Content $f.FullName -Raw
  $t = $t -replace 'font-size:\s*(1[0-3]px)', 'font-size: var(--fs-annotate)'
  $t = $t -replace 'font-size:\s*1[4-7]px', 'font-size: var(--fs-body)'
  $t = $t -replace 'font-size:\s*(1[89]px|2[0-9]px|[3-9]\dpx)', 'font-size: var(--fs-title)'
  Set-Content $f.FullName $t -NoNewline
}
```

- [ ] **Step 2: 残留检查**

Run: `cd apps/mobile; Get-ChildItem src\pages -Recurse -Filter *.vue | Select-String -Pattern 'font-size:\s*\d+px' | Measure-Object | Select-Object Count`
Expected: `Count = 0`（页面样式零写死字号；renderjs/protocol 内联样式的 px 不受此限，若命中属富文本渲染器白名单语义，豁免并记录）。

- [ ] **Step 3: 门禁** 同 Task 2 Step 4。Expected: 全绿。

- [ ] **Step 4: Commit**

```powershell
git add apps/mobile/src/pages
git commit -m "feat(mobile): 其余页面字阶批量替换 (#84)"
```

---

### Task 6: 发版

**Files:**
- Modify: `apps/mobile/src/manifest.json`

- [ ] **Step 1: bump** `versionName: 0.21.0`、`versionCode: 39`。

- [ ] **Step 2: 全量门禁**

Run: `cd packages/protocol-ts; npm test; cd ../../packages/core-ts; npx vitest run; cd ../..; go test ./...; cd apps/mobile; npx vue-tsc --noEmit; npx vitest run; npm run build:h5`
Expected: 全绿。

- [ ] **Step 3: Commit + push**

```powershell
git add apps/mobile/src/manifest.json
git commit -m "chore(mobile): 发版 0.21.0 (39)"
git push
```

- [ ] **Step 4: 真机验收清单（册子 #84 §9 M1 行）**——云打包后交用户：首页宫格四入口可达、大卡点击进详情、抽 5 页无 <15px 字、按钮点击目标手感、H5 端同过。
