# 首页 Discuz 化改版实施计划（册子 2026-10-15-home-discuz-redesign）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** tabBar 四项调整、首页公告轮播（票选生效）、每行 3 大图标网格、课程/文章/圈子各 20 条角标平铺、本地操作移「我的」，发版 0.21.5。

**Architecture:** 同步镜像展示（本机 items=节点 catalog 镜像，零协议改动）；公告走 govern.v1 提案扩 announcement 类型；角标本地规则映射。册子：`specs/2026-10-15-home-discuz-redesign-design.md`。

**Tech Stack:** uni-app Vue3、TypeScript。

**执行约定：** git 在 `e:\code\base`；PowerShell 用 `;` 不用 `&&`；每 Task 只 add 该 Task 文件；门禁三连（每 Task）：`cd apps/mobile; npx vue-tsc --noEmit; npx vitest run --reporter=dot; npm run build:h5`；docs/README.md 既有改动勿碰。

---

### Task 1: tabBar 调整

**Files:** Modify: `apps/mobile/src/pages.json`（tabBar list：评论项→文章项 text「文章」icon 保持风格、pagePath `pages/search/search`）；`apps/mobile/src/pages/search/search.vue`（页标题/navigationBarTitleText 改「文章」）

- [ ] **Step 1**: 改 tabBar（四项：课程/圈子/文章/我的）；search.vue 标题改「文章」。grep 确认代码中无硬编码 tabBar index 跳转残留（switchTab 调用全走路径）。
- [ ] **Step 2**: 门禁三连全绿。Commit：

```powershell
git add apps/mobile/src/pages.json apps/mobile/src/pages/search/search.vue
git commit -m "feat(mobile): tabBar 去评论改文章（文章 tab 指向搜索页）(#84)"
```

---

### Task 2: 公告票选链路

**Files:**
- Modify: `packages/core-ts/src/govern.ts`（提案类型扩 `announcement`，枚举处+校验处现场对齐）
- Modify: `apps/mobile/src/pages/governance/governance.vue`（「发起公告提案」入口：大字表单→postGovernEvent）
- Modify: `apps/mobile/src/pages/course/course.vue`（公告条组件段：读 config `announcements_active`，多条 CSS 竖向轮播 3s/条，空隐藏）
- Modify: `apps/mobile/src/pages/group/group.vue`（顶部同款公告条）
- Test: `packages/core-ts/src/govern.test.ts`（announcement 提案可构造+通过校验 1 条）

- [ ] **Step 1: 失败测试**（govern.test.ts 追加）：构造 type=announcement 的提案经既有校验函数不抛错（现场对齐既有提案构造用例写法）。
- [ ] **Step 2**: `cd packages/core-ts; npx vitest run src/govern.test.ts` → FAIL（枚举不含）。
- [ ] **Step 3**: 实现：govern.ts 类型枚举/校验加 `announcement`；governance.vue 发起入口（表单文本 → 既有 postGovernEvent 链路）；生效写回：投票达门槛处（现场定位决议状态流转函数）追加「若 type=announcement 且生效 → repo.setConfig('announcements_active', 现有数组+本条 JSON)（上限 10 条）」；course.vue/group.vue 公告条（同一模板手法：`<view class="notice-bar">` 内 swiper 或 CSS steps 动画竖向轮播，字阶 var(--fs-body)，标签「公告」var(--fs-annotate)）。
- [ ] **Step 4**: `npx vitest run` 全绿 + 门禁三连全绿。Commit：

```powershell
git add packages/core-ts/src/govern.ts packages/core-ts/src/govern.test.ts apps/mobile/src/pages/governance/governance.vue apps/mobile/src/pages/course/course.vue apps/mobile/src/pages/group/group.vue
git commit -m "feat: 公告走票选（govern announcement 提案+生效轮播条，首页与圈子页）(#84)"
```

---

### Task 3: 首页大图标网格

**Files:** Modify: `apps/mobile/src/pages/course/course.vue`（grid 区改每行 3 + 动态分类）

- [ ] **Step 1**: grid 改 `repeat(3,1fr)`；条目：必修 / 选修 / 精品 / 文章（→search tab 页）/ 评论（→comment 页）+ 动态 term 分类（`groupCoursesByCategory` 既有分类名逐个生成 cell，点击带分类参数进筛选视图）+「更多分类」（展开/收起分类溢出）。每格结构沿用 `cell-ico`（大 emoji）+ `cell-tx`（var(--fs-title)），格高 ≥96px。必修/选修/精品点击 → 首页课程列表按对应角标类过滤（滚动到列表+设置过滤态）；具体分类点击 → 按分类过滤。
- [ ] **Step 2**: 门禁三连全绿。Commit：

```powershell
git add apps/mobile/src/pages/course/course.vue
git commit -m "feat(mobile): 首页大图标网格每行3个（必修/选修/精品/文章/评论+动态分类）(#84)"
```

---

### Task 4: 首页列表区 Discuz 化

**Files:** Modify: `apps/mobile/src/pages/course/course.vue`

- [ ] **Step 1**: 删除分组树段（groups/collapsed/groupCoursesByCategory 消费、待票选章）与操作行段（ops 三按钮，Task 5 迁移）。
- [ ] **Step 2**: 课程列表 20 条平铺：角标规则 computed——置顶=必修类课程、加精=精品类课程、推荐=updated_at 7 天内、其余正常；排序权重 置顶1>加精2>推荐3>正常4，同权重 updated_at 倒序，截 20。角标样式 `.flag-top/.flag-feat/.flag-rec`（红/橙/蓝小标，var(--fs-annotate)）。
- [ ] **Step 3**: 「精选文章」区 20 条（type=article，加精角标同规则+标题+meta）；「公开圈子」区 20 条（本机 groups 中形态=公开：圈名+形态标注+成员数，点击进 group 页）。
- [ ] **Step 4**: 空态：无数据显示「下拉同步后可见」（保留 onShow 内 syncOnce 静默同步或提示手动去我的→同步）。
- [ ] **Step 5**: 门禁三连全绿。Commit：

```powershell
git add apps/mobile/src/pages/course/course.vue
git commit -m "feat(mobile): 首页 Discuz 化平铺（角标排序20条+精选文章+公开圈子，去分组树与操作行）(#84)"
```

---

### Task 5: 我的页接收本地操作

**Files:** Modify: `apps/mobile/src/pages/mine/mine.vue`（创作组加三项大行：同步数据（迁移 course.vue 的 doSync 逻辑含 busy/syncBlocked 态）、新建课程（createCourse 迁移）、我创建的（showMyCreated 迁移，列表沿用既有视图））

- [ ] **Step 1**: 从 course.vue 迁移三函数与其依赖状态（busy/syncBlocked/myCreated），行样式沿用 mine.vue 既有菜单行（min-height 56px, var(--fs-body)）。
- [ ] **Step 2**: 门禁三连全绿。Commit：

```powershell
git add apps/mobile/src/pages/mine/mine.vue
git commit -m "feat(mobile): 本地操作迁入我的页（同步/新建课程/我创建的）(#84)"
```

---

### Task 6: 门禁 + 发版

- [ ] **Step 1**: manifest.json bump `versionName: 0.21.5`、`versionCode: 44`。
- [ ] **Step 2**: 全量门禁：protocol-ts `npm test`；core-ts `npx vitest run`；`go test ./...`；mobile 三连。全绿。
- [ ] **Step 3**: Commit + push（只 add manifest.json，信息 `chore(mobile): 发版 0.21.5 (44)——首页 Discuz 化改版`）。
- [ ] **Step 4: 真机验收**：册子 §7 九条照测（tabBar 四项/公告轮播/宫格 3 列/角标排序/三区 20 条/我的页本地操作/公告提案全链路/适老检查/H5）。
