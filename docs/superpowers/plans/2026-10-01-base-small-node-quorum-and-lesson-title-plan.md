# 小节点票选豁免与创作入口实施计划（A 主线 第 12 册 · 计划 #66）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修掉 `0.20.2`/`27` 真机回归暴露的 4 条 —— 小节点 `directory_add` 不能免票选、台账入口课时显示 id 而非标题、课程页缺「发表文章」入口、课时提交失败无码无线索。

**Architecture:** 一处节点侧门槛判定对齐（`SettleGovernProposal` 在小节点豁免档把门槛降为 0）+ 三处手机端（词条提交后刷新目录缓存、课程详情课时清单派生统一、课程页加跳转按钮）+ 一处取证增强（无码失败把响应体原文并入文案）。零新接口、零新表、不改任何契约。

**Tech Stack:** Go 1.2x（`internal/store`，纯 Go SQLite）／ TypeScript + Vue 3 + uni-app（`apps/mobile`）／ vitest ／ `core/fakes.ts`（`MemoryRepo` / `FakeHttp` / `MemoryFs`）／ vue-tsc ／ PowerShell 5.1。

**上游 spec:** `docs/superpowers/specs/2026-10-01-base-small-node-quorum-and-lesson-title-design.md`（册子 `#65`，本册权威需求来源）；直接上游 `#58`（节点级目录与票选准入）、`#29`（创作 UI）、`#63`+`#64`（运行路径落盘根与存量台账自愈，已发布 `0.20.2`/`27`）。

---

## 执行环境约定（每个 Task 都适用）

1. **PowerShell 5.1**：不支持 `&&` 与 heredoc。多命令用 `;`；`git commit` 用多个 `-m`。
2. **只 `git add` 当前 Task 列出的文件**；工作区另有未提交改动（`.gitignore`、`apps/mobile/src/core/types.ts`、`internal/httpapi/web.go`、未跟踪的 `based-linux-amd64`）——**一律不碰**。
3. **两阶段审查**：每个 Task 完成后先跑该 Task 的验收命令，再做一次代码审查（对照本 Task 的 Files 列表逐条核对），通过才进下一个 Task。
4. **门禁命令（cwd 见括号）**：
   - mobile 单测：`npx vitest run`（cwd = `apps/mobile`）
   - mobile 类型：`npm run typecheck`（cwd = `apps/mobile`，实为 `vue-tsc --noEmit`）
   - H5 构建：`npm run build:h5`（cwd = `apps/mobile`）
   - App 构建：`npm run build:app`（cwd = `apps/mobile`）
   - 节点：`go test ./...`（cwd = 仓库根 `e:\code\base`）
   - 模板 `.value` 硬检查（cwd = 仓库根）：`git grep -nE '="[^"]*\.value|\{\{[^}]*\.value' -- apps/mobile/src/pages` 必须无输出
5. **类型检查基线**：`typecheck` 恒有 **2 条册外既有错误**（`src/pages/governance/governance.vue(58,7)` TS2741、`src/pages/submit/submit.vue(156,5)` TS2322）。判据是「**不新增**」，不要试图修这两条。

---

## 开工前已核实的现状（执行时直接用，不要重新调研）

| 事实 | 位置（仓库根 = `e:\code\base`） |
| --- | --- |
| 门槛分档函数：`directory_add && rosterReady && rosterLen < DirectorySmallNodeRosterMax(10)` ⇒ 1，否则走 `GovernThreshold`（remove 3 / 其它 2） | `internal/store/govern.go:40-58` |
| `SettleGovernProposal`：算 `effective` → `threshold := GovernThresholdForRoster(...)` → `if len(effective) < threshold { return nil }`；**同函数内 remove 已有 `threshold = 0` 旁路**（`:171-178`），`freeResult` 槽位在 `:213-215` 覆写 `executed_result` | `internal/store/govern_projection.go:148-221` |
| `addVoteTx`（HTTP 投票端点）另一处同门槛判定：`out.Threshold = GovernThresholdForRoster(p.Action, len(roster), true)`，remove 同样有 `out.Threshold = 0` 旁路 | `internal/store/govern.go:488-502` |
| `governApplyTx` 对 `directory_add` 返回 `directoryExecutedResult = "directory_approved"` | `internal/store/govern.go:585-598`、`:29-31` |
| 提案事件结构 `GovernProposalEvent{ProposalID int64; TargetItemID, Verb, ContentHash, Reason, Title, BodyMD string; ContentVersion, RevokedRev, CreatedAt int64; EventID, Actor string}` | `internal/store/govern_projection.go:19-32` |
| 事件路径投影：首次投影 INSERT 提案行 + **提案人自投第 1 票** | `internal/store/govern_projection.go:61-75` |
| 事件路径调用点：`roster, rosterOK := s.governRoster()` → `s.st.SettleGovernProposal(pid, roster, rosterOK)` | `internal/httpapi/govern_event.go:210-213` |
| 签名路径 `POST /v1/proposal` 的小节点短路：`auto := rosterOK && len(roster) < DirectorySmallNodeRosterMax` → `CreateDirectoryProposal(p, auto)` | `internal/httpapi/govern.go:192-198` |
| 测试基建：`openTemp(t)`、`authorA`、`seedCourse`、`seedProgress`、`govRoster(ids...)`、`seedRoster(t, st, n)`、`rosterOf(t, st)`、`dirProposal(kind, display, proposer)` | `internal/store/store_test.go:9`、`contributor_test.go:56`、`govern_test.go:183`、`directory_govern_test.go:13-62` |
| 目录提案常量：`DirectoryKindCategory` / `DirectoryKindInstructor` / `DirectoryKindTag`、`DirectoryStateApproved`、`DirectoryProposalItemID(kind, termKey)`、`DirectoryPayloadHash(kind, termKey)`、`NormalizeTermKey(display)` | `internal/store/directory*.go`（`directory_govern_test.go:50-62` 已按此构造） |
| `apply.vue` 提交词条：`createProposal(ctx, {action:'directory_add', itemId:'', reason:'', directory:{kind, termKey, displayName}})` → `uni.showToast({title:'已提交 · 待票选'})` → `navigateBack()`；**提交后不刷新目录缓存** | `apps/mobile/src/pages/directory/apply.vue:39-65` |
| `pullDirectory(o: DirectoryOptions)` 只在 `syncOnce` 里被调用（`?version=n` 未变会短路 `unchanged`，**不写缓存**） | `apps/mobile/src/core/directory.ts:148-168`、`apps/mobile/src/core/sync.ts:285-291` |
| `DirectoryOptions = { adapters, repo, nodeBaseUrl }`；`loadDirectory(repo)`；`termState(snapshot, kind, key)` | `apps/mobile/src/core/directory.ts:24-28`、`:174-219` |
| 课程详情台账分支：`lessons.value = form.children.map((c,i) => ({ itemId: c.itemId, no: i+1, title: c.itemId, sub: '本地未同步（点开按 id 直接查）', tags: [] }))` | `apps/mobile/src/pages/course/detail.vue:121-128` |
| 课程详情普通分支：`rows = childrenRowsOf(segs)` → 每项 `repo.getItem` + `repo.listSegments` + `childCounts` + `attrsOf` → `title: lrow?.title \|\| lid`、`no: lessonNo(segs, lid) \|\| i+1` | `apps/mobile/src/pages/course/detail.vue:158-184` |
| 页内 `interface LessonVM`（`itemId/no/title/sub/tags`）与 `KIND_LABEL = {article:'文章',quiz:'测验',video:'视频',audio:'音频'}` | `apps/mobile/src/pages/course/detail.vue:62-69`、`:96` |
| `tagsOf(rows, targetId)`：过滤 + 按 tagId 升序（空行集 ⇒ `[]`） | `apps/mobile/src/core/tags.ts:116-118` |
| `toLocalContainer(form, updatedAt)` → `{ item, segments }`；`emptyContainerForm(type, itemId)`；`MemoryRepo.upsertLocalContainer(item, segments)` | `apps/mobile/src/core/course-edit.ts:205-225`、`apps/mobile/src/core/fakes.ts:287` |
| 课程页顶部 bar（`课程` + 「新建课程」+「同步」） | `apps/mobile/src/pages/course/course.vue:3-7` |
| 投稿页路由与双 tab：`/pages/submit/submit`（title「投稿」，内部「文章 / 题库」） | `apps/mobile/src/pages.json:60-61`、`apps/mobile/src/pages/submit/submit.vue:1-8` |
| `mapSubmitFailure(status, raw, itemId)`：`code = errorCodeOf(raw)`；无码 ⇒ `message = '提交失败（HTTP ${status}）'`；有码 ⇒ `<中文>（<code>）`；429 单列 | `apps/mobile/src/core/submit.ts:221-231` |
| 既有邻近用例：`'码原文进文案：无码走裸兜底、有码追加（<code>）（册子 #63 §4.2.1）'`（用 `env()` + `http.postRoutes.set(...)` + `retrySubmission`） | `apps/mobile/src/core/submit.test.ts:463-473` |
| 版本 `0.20.2` / `27` | `apps/mobile/src/manifest.json:5-6` |

---

## File Structure

| 文件 | 动作 | 责任 |
| --- | --- | --- |
| `internal/store/govern_projection.go` | Modify | 结算点门槛判定：小节点豁免档把 `threshold` 降为 0 |
| `internal/store/directory_govern_test.go` | Modify | 事件路径豁免 + 越界护栏两条新用例 |
| `apps/mobile/src/pages/directory/apply.vue` | Modify | 提交词条后重拉目录 + 按实况出 toast |
| `apps/mobile/src/core/lesson-list.ts` | **Create** | 课时 id 列表 → `LessonVM[]` 的唯一派生（异步、收 repo） |
| `apps/mobile/src/core/lesson-list.test.ts` | **Create** | 上述派生的单测 |
| `apps/mobile/src/pages/course/detail.vue` | Modify | 两条分支改用派生助手；删本地 `LessonVM` / `KIND_LABEL` |
| `apps/mobile/src/pages/course/course.vue` | Modify | 顶部 bar 加「发表文章」 |
| `apps/mobile/src/core/submit.ts` | Modify | 无码失败补响应体原文片段 |
| `apps/mobile/src/core/submit.test.ts` | Modify | 无码摘录 / 有码不变的断言 |
| `apps/mobile/src/manifest.json` | Modify | `0.20.3` / `28` |

**为何 §3 要新建 `core/lesson-list.ts` 而不是写在页面里**：`core/course-tree.ts` 与 `core/container-view.ts` 的模块注释都写明「纯函数、不碰 IO」；本条派生必须读库（`getItem` / `listSegments`），与 `course-edit.ts`、`creator-migrate.ts` 同类。放进页面则无法单测（本仓库无 `.vue` 测试基建），而 spec §6 要求这条派生有单测。故新建一个**收 `LocalRepo` 的异步模块**，页面只做接线。

---

### Task 1: 节点侧 —— 小节点 `directory_add` 在结算点免票选（缺陷 ②）

**Files:**
- Modify: `internal/store/govern_projection.go:167-181`
- Test: `internal/store/directory_govern_test.go`（在文件末尾追加两个函数）

- [ ] **Step 1: 写失败用例（先红）** —— 在 `internal/store/directory_govern_test.go` 末尾追加：

  ```go
  // 事件路径的小节点豁免（本册 §2）：名册就绪且为空（< DirectorySmallNodeRosterMax）⇒ 投影后结算即生效。
  // authorA 无任何达标内容 ⇒ 不在名册内，正是线上小节点创建者的真实形态（旧口径下自投那票会被过滤掉）。
  func TestDirectoryAddSettlesOnSmallNodeViaEventPath(t *testing.T) {
  	st := openTemp(t)
  	p := dirProposal(DirectoryKindCategory, "语文", authorA)
  	if err := st.ProjectGovernProposal(GovernProposalEvent{
  		ProposalID:   7,
  		TargetItemID: p.ItemID,
  		Verb:         GovernActionDirectoryAdd,
  		ContentHash:  p.BaseContentHash,
  		Reason:       p.Reason,
  		Title:        p.Title,
  		BodyMD:       p.BodyMD,
  		CreatedAt:    1,
  		EventID:      "evt-small-node-1",
  		Actor:        authorA,
  	}); err != nil {
  		t.Fatalf("ProjectGovernProposal: %v", err)
  	}
  	if err := st.SettleGovernProposal(7, govRoster(), true); err != nil {
  		t.Fatalf("SettleGovernProposal: %v", err)
  	}
  	view, ok, err := st.GetProposal(7)
  	if err != nil || !ok {
  		t.Fatalf("GetProposal ok=%v err=%v", ok, err)
  	}
  	if view.ExecutedAt == 0 || view.ExecutedResult != directoryExecutedResult {
  		t.Fatalf("小节点应提交即生效: executed_at=%d result=%q", view.ExecutedAt, view.ExecutedResult)
  	}
  	got, ok, err := st.GetDirectoryTerm(DirectoryKindCategory, p.BodyMD)
  	if err != nil || !ok || got.State != DirectoryStateApproved {
  		t.Fatalf("词条 ok=%v err=%v got=%+v, want approved", ok, err, got)
  	}
  	if v, err := st.DirectoryVersion(); err != nil || v != 1 {
  		t.Fatalf("DirectoryVersion=%d err=%v, want 1", v, err)
  	}
  }

  // 越界护栏（本册 §2.2）：名册 = 10 时该分支不进入，提案人不在名册内 ⇒ 有效票 0 < 门槛 2 ⇒ 仍 pending。
  func TestDirectoryAddStaysPendingAtRosterTenViaEventPath(t *testing.T) {
  	st := openTemp(t)
  	ids := seedRoster(t, st, 10)
  	roster := rosterOf(t, st)
  	if len(roster) != 10 {
  		t.Fatalf("名册=%d, want 10", len(roster))
  	}
  	// authorA 不在 seedRoster 造出的 ids 里 ⇒ 不在名册内。
  	p := dirProposal(DirectoryKindInstructor, "王老师", authorA)
  	if err := st.ProjectGovernProposal(GovernProposalEvent{
  		ProposalID:   8,
  		TargetItemID: p.ItemID,
  		Verb:         GovernActionDirectoryAdd,
  		ContentHash:  p.BaseContentHash,
  		Reason:       p.Reason,
  		Title:        p.Title,
  		BodyMD:       p.BodyMD,
  		CreatedAt:    1,
  		EventID:      "evt-roster-10",
  		Actor:        authorA,
  	}); err != nil {
  		t.Fatalf("ProjectGovernProposal: %v", err)
  	}
  	if roster[authorA] {
  		t.Fatalf("前置不成立：authorA 不应在名册内")
  	}
  	_ = ids
  	if err := st.SettleGovernProposal(8, roster, true); err != nil {
  		t.Fatalf("SettleGovernProposal: %v", err)
  	}
  	view, _, err := st.GetProposal(8)
  	if err != nil {
  		t.Fatal(err)
  	}
  	if view.ExecutedAt != 0 {
  		t.Fatalf("名册=10 不应豁免: executed_at=%d result=%q", view.ExecutedAt, view.ExecutedResult)
  	}
  	if _, ok, err := st.GetDirectoryTerm(DirectoryKindInstructor, p.BodyMD); err != nil || ok {
  		t.Fatalf("未达门槛不应写目录行: ok=%v err=%v", ok, err)
  	}
  }
  ```

- [ ] **Step 2: 跑测试确认失败**

  ```powershell
  go test ./internal/store/ -run 'TestDirectoryAddSettlesOnSmallNodeViaEventPath|TestDirectoryAddStaysPendingAtRosterTenViaEventPath' -v
  ```

  预期：`TestDirectoryAddSettlesOnSmallNodeViaEventPath` **FAIL**（`小节点应提交即生效: executed_at=0 ...`）；`TestDirectoryAddStaysPendingAtRosterTenViaEventPath` PASS（它是护栏，现状本就 pending）。

- [ ] **Step 3: 最小实现** —— 把 `internal/store/govern_projection.go` 的

  ```go
  	effective := filterRosterAtWatermarkSet(voters, roster, restored)
  	// 门槛按名册语境分档（册子 #58 §3.2）；remove 另加免票选旁路（本册 §5）。
  	threshold := GovernThresholdForRoster(p.Action, len(roster), rosterReady)
  	freeResult := ""
  ```

  替换为：

  ```go
  	effective := filterRosterAtWatermarkSet(voters, roster, restored)
  	// 门槛按名册语境分档（册子 #58 §3.2）；remove 另加免票选旁路（本册 §5）。
  	threshold := GovernThresholdForRoster(p.Action, len(roster), rosterReady)
  	// 小节点豁免（册子 #65 §2）：门槛恰为 1 只可能由 directory_add 命中
  	// （rosterReady && rosterLen < DirectorySmallNodeRosterMax，见 govern.go:53-58）⇒ 提交即达门槛。
  	// 与签名路径 CreateDirectoryProposal(auto=true) 的「提交即 approved」对齐；写法照本函数 remove 旁路。
  	if threshold == 1 {
  		threshold = 0
  	}
  	freeResult := ""
  ```

  说明：
  - 用 `threshold == 1`（而非重复 `p.Action == GovernActionDirectoryAdd && len(roster) < DirectorySmallNodeRosterMax`）——该档位由 `GovernThresholdForRoster` 单点定义，判据不在两处漂移。
  - `executed_result` **不覆写**：`governApplyTx` 对 `directory_add` 已返回 `directory_approved`（`govern.go:598`），与 `TestCreateDirectoryProposalAutoApprove` 的断言同值。
  - `addVoteTx`（`govern.go:488-502`）**不动**：手机端走事件路径；该函数对已定案提案在步 1 早退（`govern.go:505-508`）。

- [ ] **Step 4: 跑测试确认通过**

  ```powershell
  go test ./internal/store/ -run 'TestDirectoryAdd' -v
  ```

  预期：新增两条 + 既有 `TestDirectoryAddEffectiveViaVote` / `TestGovernPreconditionTxDirectoryAddBypass` / `TestDirectoryAddMergeQueries` 全 PASS。

- [ ] **Step 5: 全包回归**

  ```powershell
  go test ./...
  ```

  预期：全包 `ok`。

- [ ] **Step 6: 提交**

  ```powershell
  git add internal/store/govern_projection.go internal/store/directory_govern_test.go
  git commit -m "fix(store): 小节点 directory_add 在结算点免票选（册子 #65 §2）" -m "门槛恰为 1 时降为 0 —— 该档只可能由 directory_add 命中；与签名路径 CreateDirectoryProposal(auto=true) 语义对齐。名册 >=10 与 rosterReady=false 行为逐字不变。"
  ```

---

### Task 2: 客户端 —— 词条提交后刷新目录缓存（缺陷 ② 的可见性收口）

**Files:**
- Modify: `apps/mobile/src/pages/directory/apply.vue:4`、`:20-21`、`:52-59`

- [ ] **Step 1: 改 import 与提示文案**

  第 20 行 `import { normalizeTermKey, type TermKind } from '../../core/directory';` 改为：

  ```ts
  import { loadDirectory, normalizeTermKey, pullDirectory, termState, type TermKind } from '../../core/directory';
  ```

  第 4 行提示改为（小节点上提交通常即时生效，文案要与实况一致）：

  ```html
      <text class="hint">任何已登记身份均可提交；人数不足 10 的节点提交即通过，其余需票选（提交后显示「待票选」）。</text>
  ```

- [ ] **Step 2: 提交成功后重拉目录并按实况出 toast**

  把 `submit()` 里 `await createProposal(...)` 之后的这三行：

  ```ts
      uni.showToast({ title: '已提交 · 待票选', icon: 'none' });
      setTimeout(() => uni.navigateBack(), 600);
  ```

  替换为：

  ```ts
      // 节点在同一请求内已投影 + 结算（govern_event.go 投影后立即 settle），故此处重拉即见最终态。
      // 不重拉则本地缓存仍是旧版本 ⇒ 小节点上已通过的词条仍显示「待票选」（册子 #65 §2.2 附带核对）。
      let approved = false;
      try {
        await pullDirectory({ adapters: opts.adapters, repo, nodeBaseUrl: opts.nodeBaseUrl });
        approved = termState(await loadDirectory(repo), kind.value, termKey) === 'approved';
      } catch {
        // 目录拉取失败静默：提交本身已成功，旁路不该把成功报成失败（与 sync.ts 的 pullDirectory 同口径）。
      }
      uni.showToast({ title: approved ? '已通过' : '已提交 · 待票选', icon: 'none' });
      setTimeout(() => uni.navigateBack(), 600);
  ```

- [ ] **Step 3: 类型与单测**

  ```powershell
  npm run typecheck
  ```

  （cwd = `apps/mobile`）预期：仅基线 2 条既有错误（`governance.vue(58,7)` TS2741、`submit.vue(156,5)` TS2322），**不新增**。

  ```powershell
  npx vitest run
  ```

  （cwd = `apps/mobile`）预期：全绿（本 Task 不改 `core/*`，用例数不变）。

- [ ] **Step 4: 提交**

  ```powershell
  git add apps/mobile/src/pages/directory/apply.vue
  git commit -m "fix(mobile): 词条提交后重拉目录并按实况提示（册子 #65 §2.2）" -m "小节点上节点侧已即时通过，但不重拉则界面仍显示「待票选」。拉取失败静默，不把已成功的提交报成失败。"
  ```

---

### Task 3: `core/lesson-list.ts` —— 课时清单的唯一派生（缺陷 ④ 的公共出口）

**Files:**
- Create: `apps/mobile/src/core/lesson-list.ts`
- Create: `apps/mobile/src/core/lesson-list.test.ts`

- [ ] **Step 1: 写失败测试** —— 新建 `apps/mobile/src/core/lesson-list.test.ts`：

  ```ts
  import { describe, expect, it } from 'vitest';

  import { emptyContainerForm, toLocalContainer } from './course-edit';
  import { MemoryRepo } from './fakes';
  import { buildLessonList } from './lesson-list';

  /** 造一条本地课时条目（走 #56 的既有出口，不手搓 items / segments）。 */
  async function seedLesson(repo: MemoryRepo, id: string, title: string) {
    const { item, segments } = toLocalContainer({ ...emptyContainerForm('lesson', id), title }, '2026-10-01T00:00:00Z');
    await repo.upsertLocalContainer(item, segments);
  }

  describe('buildLessonList（册子 #65 §3）', () => {
    it('本地有条目 ⇒ 出标题；无条目 ⇒ 回落 id 且副标题为「本地未同步」；序号连续', async () => {
      const repo = new MemoryRepo();
      await seedLesson(repo, 'course/c1/lesson/l1', '第一讲');
      const out = await buildLessonList(
        repo,
        ['course/c1/lesson/l1', 'course/c1/lesson/l9'],
        { courseSegs: null, links: [] },
      );
      expect(out).toEqual([
        { itemId: 'course/c1/lesson/l1', no: 1, title: '第一讲', sub: '空课时', tags: [] },
        {
          itemId: 'course/c1/lesson/l9',
          no: 2,
          title: 'course/c1/lesson/l9',
          sub: '本地未同步（点开按 id 直接查）',
          tags: [],
        },
      ]);
    });

    it('有课程行集 ⇒ 序号取清单位次（不信入参次序）', async () => {
      const repo = new MemoryRepo();
      await seedLesson(repo, 'course/c1/lesson/l1', '第一讲');
      await seedLesson(repo, 'course/c1/lesson/l2', '第二讲');
      const course = {
        ...emptyContainerForm('course', 'course/c1'),
        title: '课程',
        children: [
          { kind: 'lesson', itemId: 'course/c1/lesson/l1' },
          { kind: 'lesson', itemId: 'course/c1/lesson/l2' },
        ],
      };
      const { segments } = toLocalContainer(course, '2026-10-01T00:00:00Z');
      // 只传第 2 讲，且入参次序只有一条 —— 序号仍须是 2（由课程行集决定）。
      const out = await buildLessonList(repo, ['course/c1/lesson/l2'], { courseSegs: segments, links: [] });
      expect(out.map((l) => ({ no: l.no, title: l.title }))).toEqual([{ no: 2, title: '第二讲' }]);
    });

    it('tags 由 links 行集过滤（台账入口传空行集 ⇒ 恒空）', async () => {
      const repo = new MemoryRepo();
      await seedLesson(repo, 'course/c1/lesson/l1', '第一讲');
      const links = [{ tagId: 'tag/数学/第一章/第一节', targetId: 'course/c1/lesson/l1', kind: 'lesson' as const }];
      const out = await buildLessonList(repo, ['course/c1/lesson/l1'], { courseSegs: null, links });
      expect(out[0]!.tags).toHaveLength(1);
      const none = await buildLessonList(repo, ['course/c1/lesson/l1'], { courseSegs: null, links: [] });
      expect(none[0]!.tags).toEqual([]);
    });
  });
  ```

- [ ] **Step 2: 跑测试确认失败**

  ```powershell
  npx vitest run src/core/lesson-list.test.ts
  ```

  （cwd = `apps/mobile`）预期：FAIL —— `Failed to resolve import "./lesson-list"`。

- [ ] **Step 3: 写实现** —— 新建 `apps/mobile/src/core/lesson-list.ts`：

  ```ts
  /**
   * 课程详情的课时清单视图（册子 #65 §3）：课时 id 列表 → `LessonVM[]`。
   *
   * 台账入口（`from=ledger`）与普通入口**共用这一段派生**——此前台账分支把标题硬编码回落 itemId
   * （`detail.vue` 旧实现），与普通分支口径分叉，用户看到的是 id 而不是课时标题。
   *
   * 本模块收 `LocalRepo`（与 `course-edit.ts` / `creator-migrate.ts` 同体例）：取标题与副标题都要读库；
   * 其余判定复用既有纯函数（`lessonNo` / `childCounts` / `attrsOf` / `tagsOf`），不另造口径。
   */
  import { attrsOf, childCounts } from './container-view';
  import { lessonNo } from './course-tree';
  import type { LocalRepo } from './repo';
  import { tagsOf } from './tags';
  import type { SegmentRow, TagLinkRow } from './types';

  export interface LessonVM {
    itemId: string;
    no: number;
    title: string;
    /** 徽标行：类型计数 / 附件 / 时长，或「空课时」「未同步」 */
    sub: string;
    tags: TagLinkRow[];
  }

  const KIND_LABEL: Record<string, string> = { article: '文章', quiz: '测验', video: '视频', audio: '音频' };

  export interface LessonListOptions {
    /** 课程行集，用于算「第 N 讲」位次；台账入口没有这份数据 ⇒ 传 null（序号按入参次序计） */
    courseSegs: SegmentRow[] | null;
    /** tag_links 行集；台账入口不加载 ⇒ 传 [] */
    links: TagLinkRow[];
  }

  /** 课时 id 列表 → 视图行（顺序与入参一致；序号有课程行集时取清单位次）。 */
  export async function buildLessonList(
    repo: LocalRepo,
    lessonIds: string[],
    o: LessonListOptions,
  ): Promise<LessonVM[]> {
    const out: LessonVM[] = [];
    for (let i = 0; i < lessonIds.length; i++) {
      const lid = lessonIds[i]!;
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
      out.push({
        itemId: lid,
        no: (o.courseSegs === null ? 0 : lessonNo(o.courseSegs, lid)) || i + 1,
        title: lrow?.title || lid,
        sub,
        tags: tagsOf(o.links, lid),
      });
    }
    return out;
  }
  ```

- [ ] **Step 4: 跑测试确认通过**

  ```powershell
  npx vitest run src/core/lesson-list.test.ts
  ```

  （cwd = `apps/mobile`）预期：3 条 PASS。

- [ ] **Step 5: 提交**

  ```powershell
  git add apps/mobile/src/core/lesson-list.ts apps/mobile/src/core/lesson-list.test.ts
  git commit -m "feat(mobile): 抽出课时清单派生 buildLessonList（册子 #65 §3）" -m "台账入口与普通入口共用同一段取标题 / 副标题口径；标题缺失才回落 id。"
  ```

---

### Task 4: 课程详情两条分支改用派生助手（缺陷 ④ 的收口）

**Files:**
- Modify: `apps/mobile/src/pages/course/detail.vue:52-53`、`:62-69`、`:96`、`:121-128`、`:158-184`

- [ ] **Step 1: 换 import** —— 把第 53 行

  ```ts
  import { lessonNo } from '../../core/course-tree';
  ```

  整行删掉；把第 52 行

  ```ts
  import { attrsOf, childCounts, childrenRowsOf, digestOf, type AttachmentVM } from '../../core/container-view';
  ```

  改为：

  ```ts
  import { attrsOf, childrenRowsOf, digestOf, type AttachmentVM } from '../../core/container-view';
  ```

  并在第 55 行（`tags` 那行）之后新增一行：

  ```ts
  import { buildLessonList, type LessonVM } from '../../core/lesson-list';
  ```

- [ ] **Step 2: 删掉页内重复定义** —— 删除第 62-69 行的整个

  ```ts
  interface LessonVM {
    itemId: string;
    no: number;
    title: string;
    /** 徽标行：类型计数 / 附件 / 时长，或「空课时」「未同步」 */
    sub: string;
    tags: TagLinkRow[];
  }
  ```

  与第 96 行的 `const KIND_LABEL: Record<string, string> = { article: '文章', quiz: '测验', video: '视频', audio: '音频' };`（两者都已移入 `core/lesson-list.ts`）。

- [ ] **Step 3: 台账分支改用派生助手** —— 把第 121-128 行

  ```ts
        // children 行标题回落 itemId（台账行集不含子项标题，与既有「本地未同步」回落同口径）
        lessons.value = form.children.map((c, i) => ({
          itemId: c.itemId,
          no: i + 1,
          title: c.itemId,
          sub: '本地未同步（点开按 id 直接查）',
          tags: [],
        }));
  ```

  替换为：

  ```ts
        // 台账行集不含子项标题，但本地 items 表里有（#56 乐观落库 / #63 存量自愈都会写）⇒ 按 id 补取。
        // 序号取入参次序（台账入口没有课程行集）；tags 恒空（该入口不加载 tag_links）。
        lessons.value = await buildLessonList(
          repo,
          form.children.map((c) => c.itemId),
          { courseSegs: null, links: [] },
        );
  ```

- [ ] **Step 4: 普通分支改用派生助手** —— 把第 158-184 行

  ```ts
      const rows = childrenRowsOf(segs);
      const links = await repo.listTagLinks();
      const acc: LessonVM[] = [];
      for (let i = 0; i < rows.length; i++) {
        /* …既有整段循环… */
      }
      lessons.value = acc;
  ```

  整段替换为：

  ```ts
      const rows = childrenRowsOf(segs);
      const links = await repo.listTagLinks();
      lessons.value = await buildLessonList(repo, rows.map((r) => r.text), { courseSegs: segs, links });
  ```

- [ ] **Step 5: 类型与全量单测**

  ```powershell
  npm run typecheck
  ```

  （cwd = `apps/mobile`）预期：仅基线 2 条既有错误，**不新增**。若报 `KIND_LABEL` / `lessonNo` / `childCounts` 未定义或未使用，说明 Step 1 / Step 2 没删干净。

  ```powershell
  npx vitest run
  ```

  （cwd = `apps/mobile`）预期：全绿（含 Task 3 新增 3 条）。

  另跑模板硬检查（cwd = 仓库根）：

  ```powershell
  git grep -nE '="[^"]*\.value|\{\{[^}]*\.value' -- apps/mobile/src/pages
  ```

  预期：**无输出**。

- [ ] **Step 6: 提交**

  ```powershell
  git add apps/mobile/src/pages/course/detail.vue
  git commit -m "fix(mobile): 课程详情台账入口课时显示标题而非 id（册子 #65 §3）" -m "两条分支改用 buildLessonList；页内重复的 LessonVM / KIND_LABEL 删除。"
  ```

---

### Task 5: 课程页加「发表文章」入口（缺陷 ③）

**Files:**
- Modify: `apps/mobile/src/pages/course/course.vue:3-7`、脚本区（`createCourse` 旁）

- [ ] **Step 1: 加按钮** —— 第 3-7 行的 bar 改为：

  ```html
      <view class="bar">
        <text class="title">课程</text>
        <button size="mini" @click="createCourse">新建课程</button>
        <button size="mini" @click="publishArticle">发表文章</button>
        <button size="mini" :disabled="busy || syncBlocked" @click="doSync">{{ busy ? '同步中…' : '同步' }}</button>
      </view>
  ```

- [ ] **Step 2: 加跳转函数** —— 在脚本区 `function createCourse()` 之前插入：

  ```ts
  /** 发表文章入口（册子 #65 §4）：复用既有投稿页（内部已是「文章 / 题库」双 tab），零新页面。 */
  function publishArticle() {
    uni.navigateTo({ url: '/pages/submit/submit' });
  }
  ```

- [ ] **Step 3: 类型检查与模板硬检查**

  ```powershell
  npm run typecheck
  ```

  （cwd = `apps/mobile`）预期：仅基线 2 条既有错误。

  ```powershell
  git grep -nE '="[^"]*\.value|\{\{[^}]*\.value' -- apps/mobile/src/pages
  ```

  （cwd = 仓库根）预期：无输出。

- [ ] **Step 4: 提交**

  ```powershell
  git add apps/mobile/src/pages/course/course.vue
  git commit -m "feat(mobile): 课程页加「发表文章」入口（册子 #65 §4）" -m "跳既有投稿页 /pages/submit/submit；不改 tabBar，「我的」页入口并存。"
  ```

---

### Task 6: 无码提交失败把响应体原文并入文案（缺陷 ①）

**Files:**
- Modify: `apps/mobile/src/core/submit.ts:220-231`
- Test: `apps/mobile/src/core/submit.test.ts`（在 `retrySubmission：失败行重投` 那段的既有用例之后追加）

- [ ] **Step 1: 写失败测试** —— 在 `apps/mobile/src/core/submit.test.ts` 的 `describe('retrySubmission：失败行重投（册子 #61 §4.3）')` 内、`'码原文进文案…'` 那条 `it` 的收尾 `});`（`:473`）**之后、该 `describe` 的收尾 `});`（`:474`）之前**插入：

  ```ts
    it('无码 400：文案带响应体原文片段（折叠空白 + 截 120 字符）（册子 #65 §5.2）', async () => {
      const a = env();
      // 中间层 / 未解析请求：响应体没有 code 字段 ⇒ 旧口径只留一句无线索的兜底。
      a.http.postRoutes.set(`${BASE}/v1/submit`, { status: 400, body: utf8('{"error":"bad_json"}') });
      await a.repo.saveSubmission(containerRow({ state: 'failed', reason: '旧' }));
      expect((await retrySubmission(a.o, 'course/c1')).message).toBe('提交失败（HTTP 400）：{"error":"bad_json"}');

      const b = env();
      const html = `<html>\n  <head></head>\n  <body>${'x'.repeat(200)}</body>\n</html>`;
      b.http.postRoutes.set(`${BASE}/v1/submit`, { status: 400, body: utf8(html) });
      await b.repo.saveSubmission(containerRow({ state: 'failed', reason: '旧' }));
      const msg = (await retrySubmission(b.o, 'course/c1')).message;
      expect(msg.startsWith('提交失败（HTTP 400）：<html> <head></head> <body>')).toBe(true);
      // 前缀（含「）：」，共 14 个字符）+ 120 字符摘录 = 134
      expect(msg).toHaveLength('提交失败（HTTP 400）：'.length + 120);
      expect(msg.includes('\n')).toBe(false);

      const c = env();
      // 空体：摘录为空串 ⇒ 文案与现状逐字一致（不追加冒号）。
      c.http.postRoutes.set(`${BASE}/v1/submit`, { status: 400, body: utf8('   ') });
      await c.repo.saveSubmission(containerRow({ state: 'failed', reason: '旧' }));
      expect((await retrySubmission(c.o, 'course/c1')).message).toBe('提交失败（HTTP 400）');
    });
  ```

- [ ] **Step 2: 跑测试确认失败**

  ```powershell
  npx vitest run src/core/submit.test.ts
  ```

  （cwd = `apps/mobile`）预期：新增用例 FAIL（实际文案是 `提交失败（HTTP 400）`，缺摘录）。

- [ ] **Step 3: 写实现** —— 在 `apps/mobile/src/core/submit.ts` 的 `mapSubmitFailure` 之前插入常量与助手：

  ```ts
  /** 无码失败的原文摘录上限（册子 #65 §5.2）：够看出是节点的 `bad_json` 还是中间层回的 HTML。 */
  const NO_CODE_EXCERPT_MAX = 120;

  /** 折叠连续空白（含换行）为单个空格后截前 n 个字符；空串进 ⇒ 空串出。 */
  function excerptOf(raw: string, n: number): string {
    const flat = raw.trim().replace(/\s+/g, ' ');
    return flat.length <= n ? flat : flat.slice(0, n);
  }
  ```

  再把 `mapSubmitFailure` 的收尾三行

  ```ts
    // 码原文一并进文案（册子 #63 §4.2.1）：toast / 台账 reason / 编辑面日志一处改动全链路可见。
    const base = errorText(code, `提交失败（HTTP ${status}）`);
    const message = code === '' ? base : `${base}（${code}）`;
  ```

  替换为：

  ```ts
    // 码原文一并进文案（册子 #63 §4.2.1）：toast / 台账 reason / 编辑面日志一处改动全链路可见。
    const base = errorText(code, `提交失败（HTTP ${status}）`);
    // 无码时补响应体原文片段（册子 #65 §5.2）：这是「提交失败（HTTP 400）」唯一无线索的一种失败，
    // 原文使下次复现自带证据（屏上红字 / 台账 reason / edit-surface.log 三处同时可见）。
    const excerpt = code === '' ? excerptOf(raw, NO_CODE_EXCERPT_MAX) : '';
    const message = code !== '' ? `${base}（${code}）` : excerpt === '' ? base : `${base}：${excerpt}`;
  ```

- [ ] **Step 4: 跑测试确认通过**

  ```powershell
  npx vitest run src/core/submit.test.ts
  ```

  （cwd = `apps/mobile`）预期：全绿 —— 新增 1 条 + 既有「码原文进文案」（有码分支逐字不变）与 `:137` / `:240` 等处全 PASS。

- [ ] **Step 5: 提交**

  ```powershell
  git add apps/mobile/src/core/submit.ts apps/mobile/src/core/submit.test.ts
  git commit -m "feat(mobile): 无码提交失败透出响应体原文片段（册子 #65 §5）" -m "只在 code 为空时追加（trim + 空白折叠 + 截 120 字符）；有码分支与空体情形文案逐字不变。"
  ```

---

### Task 7: 版本号与全门禁

**Files:**
- Modify: `apps/mobile/src/manifest.json:5-6`

- [ ] **Step 1: 升版本**

  第 5-6 行改为：

  ```json
      "versionName" : "0.20.3",
      "versionCode" : "28",
  ```

- [ ] **Step 2: 全门禁（逐条跑，任一非预期即停）**

  ```powershell
  npx vitest run
  ```

  （cwd = `apps/mobile`）预期：全绿，用例数 = 上一册 402 + Task 3 新增 3 + Task 6 新增 1 = **406**（若 `describe` 计数与预期不符，逐条核对是哪个文件增减，不要放过）。

  ```powershell
  npm run typecheck
  ```

  （cwd = `apps/mobile`）预期：仅基线 2 条既有错误。

  ```powershell
  npm run build:h5
  ```

  （cwd = `apps/mobile`）预期：`build:h5` 通过。

  ```powershell
  npm run build:app
  ```

  （cwd = `apps/mobile`）预期：通过；并核对产物 `apps/mobile/dist/build/app/app-service.js` 中 `\.value\.value` 计数为 **0**。

  ```powershell
  go test ./...
  ```

  （cwd = 仓库根）预期：全包 `ok`。

  ```powershell
  git diff --stat -- internal/
  ```

  （cwd = 仓库根）预期：**仅** `internal/store/govern_projection.go` 与 `internal/store/directory_govern_test.go`（Task 1 已提交，此处应为空输出；若非空说明有未提交的节点改动，须查清）。

- [ ] **Step 3: 提交**

  ```powershell
  git add apps/mobile/src/manifest.json
  git commit -m "chore(mobile): 版本 0.20.3/28（册子 #65）"
  ```

---

### Task 8: 发布（含节点侧改动）

**Files:** 无源码改动；证据回填到本计划文末「执行实况」（**不落仓库产物**）

- [ ] **Step 1: 节点二进制交叉编译与部署**（本册含节点侧改动，必须做）

  ```powershell
  $env:GOOS='linux'; $env:GOARCH='amd64'; go build -o based-linux-amd64 ./cmd/based; Remove-Item Env:GOOS; Remove-Item Env:GOARCH
  ```

  （cwd = 仓库根）预期：产出 `based-linux-amd64`；记录本地 sha256。

  上传并**原子替换**（远端旧件先备份）：

  ```powershell
  scp based-linux-amd64 root@118.190.217.242:/opt/base/based.new
  ```

  ```powershell
  ssh root@118.190.217.242 "cp -a /opt/base/based /opt/base/based.bak-pre-0.20.3; mv /opt/base/based.new /opt/base/based; chmod 0755 /opt/base/based; systemctl restart base; systemctl restart base-cache; sleep 2; systemctl is-active base; systemctl is-active base-cache; sha256sum /opt/base/based"
  ```

  预期：两单元均 `active`；远端 sha256 与本地逐字一致。

- [ ] **Step 2: 只读探活（无回归）**

  ```powershell
  ssh root@118.190.217.242 "curl -s -o /dev/null -w '%{http_code}\n' https://127.0.0.1/v1/comment -k; curl -s -o /dev/null -w '%{http_code}\n' https://127.0.0.1/v1/proposal -k; curl -s -o /dev/null -w '%{http_code}\n' https://127.0.0.1/v1/directory -k; curl -s -o /dev/null -w '%{http_code}\n' -X POST https://127.0.0.1/v1/blob -k; curl -s -o /dev/null -w '%{http_code}\n' https://127.0.0.1/v1/blobzzz -k"
  ```

  预期：`200 / 200 / 200 / 400 / 404`。

- [ ] **Step 3: 四步发布（沿用 `0.20.2` 已验证口径，一气呵成）**

  1. HBuilderX `cli pack` 云打包：

     ```powershell
     & 'D:\HBuilderX\cli.exe' pack --project e:\code\base\apps\mobile --platform android --android.packagename uni.app.UNI936A667 --android.androidpacktype 3
     ```

     产物核对以**包内** `version.name=0.20.3` / `version.code=28` 为准，不看构建目录。
  2. `scp` 上传到 `/opt/appdl/base-0.20.3.apk`（核对远端 sha256 与本地逐字一致）。
  3. `/opt/appdl/index.html` **整页重写**改指 `0.20.3`（不得残留 `0.20.2`；旧页备份为 `index.html.bak-0.20.2`）。
  4. 服务器上 `based release -version-name 0.20.3 -min-version-name 0.8.0 -apk-url http://118.190.217.242/dl/base-0.20.3.apk -apk-file /opt/appdl/base-0.20.3.apk -notes <备注> -out /opt/base-cache/data/release.json`（确认无游离副本）。
  5. 线上核对：`GET /v1/release` → `0.20.3`（`apk_size` / `apk_sha256` 与本地逐字一致）、`HEAD /dl/base-0.20.3.apk` = 200（`Content-Length` 与本地一致）、`GET /dl/` 只出现 `0.20.3`；证书 SHA1 = `19:95:21:ED:09:C0:9C:AD:58:B0:EB:34:D1:B3:CF:D1:BA:89:FF:19`（与 `0.6.0`–`0.20.2` 一致 ⇒ 可覆盖安装）。

- [ ] **Step 4: 回填执行实况与本册状态**

  在本计划文末「执行实况」写：各 Task 的 commit、门禁实测数字、四步发布与节点部署证据、线上核对结果；并把 `docs/README.md` 中 `#65` 那条的结尾 `状态：**册子已定稿…实施计划待出（writing-plans）**` 改为 `状态：**已发布 `0.20.3`/`28`**（实施计划 `#66` 见 `plans/2026-10-01-base-small-node-quorum-and-lesson-title-plan.md`，Task 1–8；执行实况见其文末）`。

  ```powershell
  git add docs/README.md docs/superpowers/plans/2026-10-01-base-small-node-quorum-and-lesson-title-plan.md
  git commit -m "docs: 回填 #66 执行实况与 #65 发布状态（0.20.3/28）"
  ```

---

## 自检（写完计划后已核）

**1. Spec 覆盖**

| spec 章节 | 对应 Task |
| --- | --- |
| §2.1 症状与根因 | 无代码（已定稿在 spec） |
| §2.2 处置（含 `addVoteTx` 不动的理由） | Task 1 |
| §2.2 附带核对（客户端提交后是否刷新目录缓存 ⇒ **已核实：不刷新** ⇒ 一并补） | Task 2 |
| §2.3 兼容与影响（老客户端 / 多节点 / 幂等） | Task 1（`threshold` 判定在节点侧，读接口 `status` 自动变 `effective`；settle 幂等早退未改） |
| §3.2 台账入口课时标题 | Task 3 + Task 4 |
| §4.2 课程页「发表文章」 | Task 5 |
| §5.2 无码失败原文（trim + 空白折叠 + 截 120） | Task 6 |
| §6 门禁（6 项）与 4 条必增用例 | Task 1（用例 1、2）、Task 3（用例 3）、Task 6（用例 4）、Task 7（门禁） |
| §8 AC 1–6 | Task 1（AC 1/2/3）、Task 3+4（AC 4）、Task 5（AC 5）、Task 6（AC 6） |
| §9 发布口径 `0.20.3`/`28` + 节点二进制 | Task 7 + Task 8 |

**2. 占位符扫描** —— 全文无 `TBD` / `TODO` / 「类似 Task N」/ 「补上适当的错误处理」；每个改码步骤都给了完整代码与完整命令。Task 8 的 `-notes <备注>` 是运行时自由文本（发布命令的参数），不是未定的实现。

**3. 类型与命名一致性** —— `buildLessonList` / `LessonVM` / `LessonListOptions` / `courseSegs` / `links` 在 Task 3 定义，Task 4 按同名字段消费；`excerptOf` / `NO_CODE_EXCERPT_MAX` 在 Task 6 内自洽；`directoryExecutedResult`（Task 1 的测试断言）用的是 `internal/store` 包内既有常量，未改名。

**4. 与 spec 的显式偏差** —— 一处：spec §3.2 写「在 `detail.vue` 内抽一个 async 派生助手」，本计划改为**新建 `core/lesson-list.ts`**。理由见「File Structure」末段（spec §6 要求这条派生有单测，而本仓库无 `.vue` 测试基建）。

---

## 执行实况

**执行时间：** 2026-10-01 23:34–23:58（Asia/Shanghai）

**Task 1–7 commit**

| Task | commit | 内容 |
| --- | --- | --- |
| 1 | `98bdffb` | 节点侧 `SettleGovernProposal` 小节点档（门槛恰为 1）把门槛降为 0 + 2 条用例 |
| 2 | `e3aaa04` | 词条提交后重拉目录并按实况出 toast |
| 3 | `e5c409f` | 新建 `core/lesson-list.ts` + 3 条用例 |
| 4 | `d43e30c` | 课程详情两分支改用 `buildLessonList`，删页内 `LessonVM` / `KIND_LABEL` |
| 5 | `cbd0ae7` | 课程页加「发表文章」入口 |
| 6 | `6b6e372` | 无码失败透出响应体原文片段（trim + 空白折叠 + 截 120） |
| 7 | `efee918` | `manifest.json` → `0.20.3`/`28` |

**门禁实测（Task 7 时点，全绿）**

| 项 | 结果 |
| --- | --- |
| `npx vitest run`（cwd `apps/mobile`） | **37 文件 / 455 用例全通过**。计划写的 406 是编写时估算；实际基线 451 + Task 3 的 3 + Task 6 的 1 = 455 |
| `npm run typecheck` | **恰 2 条册外既有错**：`governance.vue(58,7)` TS2741、`submit.vue(156,5)` TS2322；**零新增** |
| `npm run build:h5` | 通过（`DONE Build complete.`） |
| `npm run build:app` | 通过；`dist/build/app/app-service.js` 中 `.value.value` 计数 **0** |
| `go test ./...` | 全包 `ok`（含 `internal/store`） |
| `git diff --stat -- internal/` | **空输出**（Task 1 节点改动已提交） |
| 模板 `.value` 硬检查 | 无输出 |

**执行期偏差登记（2 条，均已就地修正）**

1. **计划 Task 3 测试有类型笔误**：Step 1 把 `toLocalContainer(...).segments`（`SubmitSegmentRow[]`）传给 `courseSegs`，而实现与 Task 4 的 `repo.listSegments()` 都是本地库口径 `SegmentRow[]`（多 `itemId` / `contentHash`）。按实现正确的一侧修正测试：改用显式构造的 `SegmentRow[]` 并从 `./types` 引入类型；断言与语义不变。
2. **计划 Task 6 漏判既有断言**：新口径使 **3 条既有「无码 + 非空响应体」** 断言的期望值必然改变（`submit.test.ts:143` 500 `boom`、`:273` flush 同款、`:467` 400 `{"error":"boom"}`），已随新口径同步。`:467` 那条用例名（原「无码走裸兜底」）改为「无码非空体带原文片段」以与新行为一致。**有码分支与空体**情形的文案逐字未变（空体裸兜底由 Task 6 新用例守住）。

**Task 8 节点侧部署（本册含节点改动）**

| 步骤 | 证据 |
| --- | --- |
| 交叉编译 | `$env:GOOS='linux'; $env:GOARCH='amd64'; go build -o based-linux-amd64 ./cmd/based` → **21919663 字节 / sha256 `985f8ed43e0b56d51e0d839cde2c4f2ba5ddf03010da6f477603a239bdf6b1a0`** |
| 上传 + 原子替换 | `scp` 至 `/opt/base/based.new`（远端 sha256 与本地逐字一致）；`cp -a /opt/base/based /opt/base/based.bak-pre-0.20.3` → `mv` → `chmod 0755` → 重启 `base` / `base-cache` |
| 生效核对 | `systemctl is-active base` = `active`、`base-cache` = `active`、`nginx` = `active`；`sha256sum /opt/base/based` = `985f8ed4…`（与本地逐字一致） |
| 只读探活 | `/v1/comment` = `200`、`/v1/proposal` = `200`、`/v1/directory` = `200`、`POST /v1/blob`（空体）= `400`、`/v1/blobzzz` = `404`（无回归） |

**四步发布（`0.20.3`/`28`）**

| 步骤 | 证据 |
| --- | --- |
| ① 云打包 | `D:\HBuilderX\cli.exe pack --project e:\code\base\apps\mobile --platform android --android.packagename uni.app.UNI936A667 --android.androidpacktype 3`；23:53:44 起 → **23:55:13 打包成功**（编译器 5.26 vue3、Android云端证书）；产物经临时下载地址取回 = **27449533 字节 / sha256 `25c1c5479858d07c63c499a026e5b6de09c1f9a6d20f7bf3774d8b8964559a2a`** |
| ② 上传 | **包内**核对 `assets/apps/__UNI__936A667/www/manifest.json` = `"version":{"code":"28","name":"0.20.3"}`；证书 SHA1 = `19:95:21:ED:09:C0:9C:AD:58:B0:EB:34:D1:B3:CF:D1:BA:89:FF:19`（与 `0.6.0`–`0.20.2` 逐字一致 ⇒ 可覆盖安装）；`scp` 至 `/opt/appdl/base-0.20.3.apk`，**远端 sha256 逐字一致** |
| ③ 落地页 | `/opt/appdl/index.html` **整页重写**改指 `./base-0.20.3.apk`（`GET /dl/` 只出现 `base-0.20.3.apk` 1 次、`0.20.2` 命中 **0**）；旧页备份 `/opt/appdl/index.html.bak-0.20.2` |
| ④ 签发 | `set -a; . /opt/base/base.secret.env; set +a; /opt/base/based release -version-name 0.20.3 -min-version-name 0.8.0 -apk-url http://118.190.217.242/dl/base-0.20.3.apk -apk-file /opt/appdl/base-0.20.3.apk -notes 小节点票选豁免_创作入口_课时标题_无码取证 -out /opt/base-cache/data/release.json` → `apk_size=27449533`、`apk_sha256=25c1c547…`、`public_key 48c33db9cf859e107fe89651d15fc5faaa8b16ffbb7d4b483aa167a0cff824f4`（与 0.20.0–0.20.2 同一把源节点公钥）；`/opt/base/data/release.json` **不存在**（无游离副本） |

**线上核对（公网 :80）**

| 检查项 | 结果 |
| --- | --- |
| `GET /v1/release` | `200`；`version_name=0.20.3`、`min_version_name=0.8.0`、`apk_size=27449533`、`apk_sha256=25c1c547…`（与本地逐字一致）、`apk_url=http://118.190.217.242/dl/base-0.20.3.apk`、`notes=小节点票选豁免_…`、`issuer=base-node-1`、`signature` 128 hex |
| `HEAD /dl/base-0.20.3.apk` | `200` / `application/octet-stream` / `Content-Length: 27449533`（与本地一致） |
| `GET /dl/` 落地页 | `200`；只出现 `base-0.20.3.apk`，`0.20.2` 残留 **0** |

**发布链偏差登记（1 条）**

- 本计划 Task 8 Step 3 ④ 的命令**漏写签名来源**，直接执行报 `release: 缺少 -sign-key（或环境变量 BASE_SIGN_KEY）：没有私钥不能签发升级文档`。实际口径沿用 `0.20.0`–`0.20.2`：先 `set -a; . /opt/base/base.secret.env; set +a;` 再执行（`base.secret.env` 内即源节点私钥）。
