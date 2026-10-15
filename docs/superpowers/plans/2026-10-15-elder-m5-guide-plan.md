# M5 学习指引（首启引导 + 使用帮助页）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 首次启动 3 屏引导流（是什么/能做什么/开始使用）+「使用帮助」页（四节图文大字）+「我的」页入口，发版 0.21.4。

**Architecture:** 全新两页 guide/help（适老样式全引 `--fs-*` 令牌）；首启标记用 `repo.getConfig/setConfig`（config 表 KV 既有接口）；首页 course.vue onShow 检查 `guide_seen` 标记，缺则跳引导页。

**Tech Stack:** uni-app Vue3。上游册子：`specs/2026-10-14-base-elder-accessibility-blueprint-design.md` §7。

**执行约定：** git 在 `e:\code\base`；PowerShell 用 `;` 不用 `&&`；每 Task 只 add 该 Task 文件；门禁三连（每 Task）：`cd apps/mobile; npx vue-tsc --noEmit; npx vitest run --reporter=dot; npm run build:h5`；docs/README.md 勿碰。

---

### Task 1: guide 页 + help 页 + 注册与入口

**Files:**
- Create: `apps/mobile/src/pages/guide/guide.vue`
- Create: `apps/mobile/src/pages/help/help.vue`
- Modify: `apps/mobile/src/pages.json`（注册两页，样式同相邻条目）
- Modify: `apps/mobile/src/pages/mine/mine.vue`（菜单 L20-36 区「设置」前加「使用帮助」→ `/pages/help/help`）

- [ ] **Step 1: guide.vue**：`<swiper current>` 全屏 3 屏大字卡片，每屏：大图标（emoji 或内置 icon）+ 标题（var(--fs-title)）+ 2-3 行说明（var(--fs-body) 行高 1.6）+ 页点指示器：
  1. 「欢迎来到 base」——面向学习者的内容平台
  2. 「学课程 · 看文章 · 投稿创作」——三大入口说明
  3. 「开始使用」——底部主按钮（min-height 52px）「开始使用」→ `setConfig('guide_seen','1')` → `uni.switchTab('/pages/course/course')`；前两屏底部「跳过」文字按钮（var(--fs-annotate)）同处理。repo 实例化手法同 mine.vue 现场对齐。
- [ ] **Step 2: help.vue**：四节图文大字（每节：var(--fs-title) 节题 + var(--fs-body) 正文若干行 + 关键入口路径说明），内容：
  1. 「首页怎么用」——宫格四入口（学课程滚到列表/看文章/去投稿/我的）+ 搜索
  2. 「怎么投稿」——底部 tab 投稿 → 选类型 → 写正文（工具栏/字号/颜色/图库）→ 保存进「我创建的」
  3. 「圈子怎么玩」——tab 圈子 → 新建（开放/封闭）→ 邀请码 → 圈内发言可引用课程文章
  4. 「私有笔记」——我的 → 我的笔记 → 仅本机可见，换机不带
  顶部返回按钮（navigateBack）。
- [ ] **Step 3**: 门禁三连全绿。Commit：

```powershell
git add apps/mobile/src/pages/guide/guide.vue apps/mobile/src/pages/help/help.vue apps/mobile/src/pages.json apps/mobile/src/pages/mine/mine.vue
git commit -m "feat(mobile): 首启引导页+使用帮助页+我的页入口 (#84)"
```

---

### Task 2: 首启引导流

**Files:** Modify: `apps/mobile/src/pages/course/course.vue`

- [ ] **Step 1**: onShow 里数据加载之后加：

```ts
const seen = await repo.getConfig('guide_seen');
if (!seen) {
  uni.navigateTo({ url: '/pages/guide/guide' });
}
```

（repo 与 getConfig 的 import 手法现场对齐 mine.vue / 其他页面既有用法；防抖：加 `guideChecked` 标志位避免 onShow 反复跳。）

- [ ] **Step 2**: 门禁三连全绿。Commit：

```powershell
git add apps/mobile/src/pages/course/course.vue
git commit -m "feat(mobile): 首次启动进引导页（guide_seen 标记）(#84)"
```

---

### Task 3: 发版

- [ ] **Step 1**: manifest.json bump `versionName: 0.21.4`、`versionCode: 43`。
- [ ] **Step 2**: 全量门禁：protocol-ts `npm test`；core-ts `npx vitest run`；`go test ./...`；mobile 三连。全绿。
- [ ] **Step 3**: Commit + push（只 add manifest.json，信息 `chore(mobile): 发版 0.21.4 (43)——学习指引`）。
- [ ] **Step 4: 真机验收清单**：①卸载重装首启出 3 屏引导，「开始使用」回首页且不再弹 ②「跳过」同样生效 ③我的→使用帮助→四节内容大字可读 ④引导/帮助页字号与触控目标 ⑤H5 同过。
