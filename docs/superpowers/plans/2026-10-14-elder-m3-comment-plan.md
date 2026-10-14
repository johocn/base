# M3 评论补全（课程详情入口 + 评论 UI 适老核查）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 课程详情页补评论入口（跳既有评论页），评论相关 UI 适老核查到位，发版 0.21.2。

**Architecture:** 协议零改动（comment.v1 既有）：复用 `setPendingTarget(targetId)` → `/pages/comment/comment` 跳转模式（tag/detail.vue:90-103 同款手法）；评论页与文章页评论 UI 已在 M1 适老化，本计划核查补漏。

**Tech Stack:** uni-app Vue3。上游册子：`specs/2026-10-14-base-elder-accessibility-blueprint-design.md` §5。

**执行约定：** git 在 `e:\code\base`；PowerShell 用 `;` 不用 `&&`；每 Task 只 add 该 Task 文件；门禁绿了才提交；docs/README.md 既有改动勿碰。

---

### Task 1: 课程详情页评论入口

**Files:**
- Modify: `apps/mobile/src/pages/course/detail.vue`（课时列表区块之后追加评论入口区；script 区补 import 与函数）

- [ ] **Step 1: 实现**

先读 `pages/tag/detail.vue` L90-103 的评论入口手法与 `article.vue` L29-34/95-98（`setPendingTarget` import 与 `openComments`），现场对齐。在 `course/detail.vue`：

1. script 区补（import 路径与 tag/detail.vue 一致）：

```ts
import { setPendingTarget } from '../../core/comment';

function openComments() {
  setPendingTarget(course.value.itemId);
  uni.navigateTo({ url: '/pages/comment/comment' });
}
```

（`course.value.itemId` 用页面现有的课程数据 ref 名，现场对齐；跳转方式若 tag/detail 用 `switchTab` 则此处也从其手法——comment 页在 tabBar 内则 switchTab，不在则 navigateTo。）

2. 模板：课时列表区块之后追加（适老样式，变量全引 `--fs-*`）：

```html
<view class="cmt-entry">
  <button class="cmt-btn" @click="openComments">查看评论 / 发表评论</button>
</view>
```

3. 样式：

```css
.cmt-entry { padding: 16px; }
.cmt-btn { min-height: 48px; font-size: var(--fs-body); }
```

- [ ] **Step 2: 门禁**

Run: `cd apps/mobile; npx vue-tsc --noEmit; npx vitest run --reporter=dot; npm run build:h5`
Expected: 全绿。

- [ ] **Step 3: Commit**

```powershell
git add apps/mobile/src/pages/course/detail.vue
git commit -m "feat(mobile): 课程详情页评论入口（setPendingTarget 跳评论页）(#84)"
```

---

### Task 2: 评论 UI 适老核查 + 发版

**Files:**
- 核查（必要时 Modify）：`apps/mobile/src/pages/comment/comment.vue`、`article/article.vue`、`tag/detail.vue`
- Modify: `apps/mobile/src/manifest.json`

- [ ] **Step 1: 核查三处**

Run: `cd apps/mobile; Get-ChildItem src\pages\comment\comment.vue, src\pages\article\article.vue, src\pages\tag\detail.vue | Select-String -Pattern 'font-size:\s*\d+px'`
Expected: 无命中（M1 已全部变量化）。若有命中按 M1 映射规则表（≤13px→--fs-annotate / 14-17px→--fs-body / ≥18px→--fs-title）替换；同时确认三处评论按钮/评论项 `min-height: 48px`（缺则补）。

- [ ] **Step 2: manifest bump** `versionName: 0.21.2`、`versionCode: 41`。

- [ ] **Step 3: 全量门禁**

Run: `cd packages/protocol-ts; npm test; cd ../../packages/core-ts; npx vitest run; cd ../..; go test ./...; cd apps/mobile; npx vue-tsc --noEmit; npx vitest run; npm run build:h5`
Expected: 全绿。

- [ ] **Step 4: Commit + push**

```powershell
git add apps/mobile/src/manifest.json
git add apps/mobile/src/pages/comment/comment.vue apps/mobile/src/pages/article/article.vue apps/mobile/src/pages/tag/detail.vue 2>$null
git commit -m "chore(mobile): 发版 0.21.2 (41)——评论补全收尾"
git push
```

- [ ] **Step 5: 真机验收清单**：①课程详情底部「查看评论」按钮 48px 可见 ②点击进评论页、可发表课程评论 ③文章页评论行为不回归 ④评论页大字与触控目标 ⑤H5 同过。
