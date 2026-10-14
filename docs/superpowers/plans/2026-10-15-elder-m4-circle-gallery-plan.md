# M4 圈子收尾核查 + 图库分页优化 + 圈子引用课程文章 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 圈子链路核查收尾（功能已基本在位）+ 图库三项优化（滚动自动加载/搜索增强/图片管理）+ 圈子发布可引用公开课程文章并跳读返回，发版 0.21.3。

**Architecture:** 图库优化在 submit.vue / lesson/edit.vue / note/edit.vue 三页同构（图库弹层已是三份拷贝，跟随现状）；圈子引用复用 lesson/edit.vue 既有内链搜索手法（搜索本机课程/文章 items → 插入内链 markdown），渲染端 group.vue 消息正文内链可点跳转，navigateBack 返回圈子。

**Tech Stack:** uni-app Vue3、TypeScript。上游册子：`specs/2026-10-14-base-elder-accessibility-blueprint-design.md` §4（M4 收尾）。

**执行约定：** git 在 `e:\code\base`；PowerShell 用 `;` 不用 `&&`；每 Task 只 add 该 Task 文件；门禁绿了才提交；docs/README.md 勿碰。门禁三连（每 Task）：`cd apps/mobile; npx vue-tsc --noEmit; npx vitest run --reporter=dot; npm run build:h5`。

---

### Task 1: 图库滚动自动加载（三页同构）

**Files:** Modify: `apps/mobile/src/pages/submit/submit.vue`、`lesson/edit.vue`、`note/edit.vue`（图库弹层「加载更多」按钮区 + scroll 容器）

- [ ] **Step 1**: 先读 submit.vue 图库弹层模板与分页状态（page/hasMore/loadMore 类函数，0.20.13 版：50 条/页 + 手动「加载更多」按钮）。改造：弹层图片网格外层若非 scroll-view 则包 `<scroll-view scroll-y style="max-height:60vh" @scrolltolower="onGalleryScrollLower">`；`onGalleryScrollLower` 在 `hasMore && !loading` 时调既有 loadMore（防重入）；**删除**手动「加载更多」按钮；底部改显示「上滑加载更多（剩 N）」fs-annotate 提示，无更多时显示「已全部加载」。lesson/edit.vue、note/edit.vue 同构。
- [ ] **Step 2**: 门禁三连全绿。Commit：

```powershell
git add apps/mobile/src/pages/submit/submit.vue apps/mobile/src/pages/lesson/edit.vue apps/mobile/src/pages/note/edit.vue
git commit -m "feat(mobile): 图库滚动自动加载（触底翻页，三页同构）(#84)"
```

---

### Task 2: 图库搜索增强

**Files:**
- Modify: `packages/core-ts/src/editor-links.ts`（searchLocalBlobs 的 WHERE）
- Test: `packages/core-ts/src/editor-links.test.ts`（追加 1 条）

- [ ] **Step 1: 失败测试**（追加到 searchLocalBlobs describe）：

```ts
  it('搜索词为包含匹配（%kw%）且同时命中 original_name 与 blob_id', async () => {
    const db = new FakeDb();
    db.setResponse('FROM blob_index', []);
    await searchLocalBlobs({ db, keyword: '海' });
    expect(db.lastSql).toContain('LIKE');
    expect(db.lastSql).toContain("'%海%'");
  });
```

（`searchLocalBlobs` 签名与 FakeDb 用法以该测试文件既有用例为准现场对齐。）

- [ ] **Step 2**: `cd packages/core-ts; npx vitest run src/editor-links.test.ts` → FAIL（现状为前缀或仅 name 匹配）。
- [ ] **Step 3**: 实现：WHERE 改为 `(b.original_name LIKE '%' || ? || '%' OR b.blob_id LIKE '%' || ? || '%')`（keyword 参数传两份；现若已包含匹配则核对两列皆覆盖后直接过）。`npx vitest run` 全绿。
- [ ] **Step 4**: Commit：

```powershell
git add packages/core-ts/src/editor-links.ts packages/core-ts/src/editor-links.test.ts
git commit -m "feat(core-ts): 图库搜索包含匹配（文件名+blob_id）(#84)"
```

---

### Task 3: 图片管理增强（长按操作）

**Files:** Modify: 三页图库弹层（同 Task 1 文件）

- [ ] **Step 1**: 网格图片项加 `@longpress`：`uni.showActionSheet` 两项——「预览大图」→ `uni.previewImage({ urls: [该图 src] })`；「复制引用」→ `uni.setClipboardData({ data: buildBlobImage(blobId, name) })`（import 自 core-ts，现场对齐导出名）+ toast「引用已复制」。适老：ActionSheet 系统组件原生可用。三页同构。
- [ ] **Step 2**: 门禁三连全绿。Commit：

```powershell
git add apps/mobile/src/pages/submit/submit.vue apps/mobile/src/pages/lesson/edit.vue apps/mobile/src/pages/note/edit.vue
git commit -m "feat(mobile): 图库长按预览大图与复制引用（三页同构）(#84)"
```

---

### Task 4: 圈子引用公开课程文章（阅读后返回）

**Files:** Modify: `apps/mobile/src/pages/group/group.vue`

- [ ] **Step 1**: 现场核查 group.vue 发言输入区现状（是纯 textarea 还是已有工具栏/内链能力）与 lesson/edit.vue 的内链搜索手法（搜本机课程/文章 items 的函数与弹层）。
- [ ] **Step 2**: 实现：发言输入区上方加「引用课程/文章」按钮（min-height 48px，fs-body）→ 弹层列出本机 items 中 type ∈ {course, article} 的条目（标题大字 + 类型标注，可滚 60vh，顶部搜索框过滤）→ 点选在发言正文末尾插入内链 markdown（格式与 lesson/edit.vue 内链插入逐字一致，现场对齐）。
- [ ] **Step 3**: 渲染端：group.vue 消息列表正文渲染处，把内链标记解析为可点链接（样式 fs-body、下划线区分）；点击 `uni.navigateTo` 到对应详情页（course → /pages/course/detail?id=，article → /pages/article/article?id=，参数形态现场对齐）；从详情页返回（navigateBack）即回到圈子会话页。
- [ ] **Step 4**: 门禁三连全绿。Commit：

```powershell
git add apps/mobile/src/pages/group/group.vue
git commit -m "feat(mobile): 圈子发言引用公开课程文章（内链插入+可点跳读返回）(#84)"
```

---

### Task 5: 圈子链路核查 + 发版

- [ ] **Step 1**: 核查（不改代码，报告为准）：①tabBar/首页宫格 → circle 页可达 ②circle → group（点列表项）→ governance / contribution 跳转链路 ③四页（circle/group/governance/contribution）写死字号与 48px 复查（`Select-String -Pattern 'font-size:\s*\d+px'`，预期 0）④发现断链或缺失入口才修（最小改动，随本 Task 提交）。
- [ ] **Step 2**: manifest.json bump `versionName: 0.21.3`、`versionCode: 42`。
- [ ] **Step 3**: 全量门禁：protocol-ts `npm test`；core-ts `npx vitest run`；`go test ./...`；mobile 三连。全绿。
- [ ] **Step 4**: Commit + push：

```powershell
git add apps/mobile/src/manifest.json
git commit -m "chore(mobile): 发版 0.21.3 (42)——圈子收尾与图库优化"
git push
```

- [ ] **Step 5: 真机验收清单**：①图库滚动到底自动出下一页，无手动按钮 ②图库搜「海」能命中文件名含海字的图（包含匹配）③长按图可预览大图/复制引用，粘贴正文可用 ④圈子发言点「引用课程/文章」→ 选条目 → 正文出现内链 ⑤发送后圈友点内链跳详情、返回回到圈子 ⑥决议/贡献/席位页可达无断链 ⑦四页适老字号与 48px ⑧H5 同过。
