# app 容器 id 解码根治 + 失败 Toast + 内置默认分类 实施计划（#80 册子）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 落地 #80 册子——课时 400 `item_id_invalid` 根治（解码优先 + 编码态孤儿迁移 + 一次性清理）、保存失败 toast 弹错误码、课程分类内置默认「从零开始」；纯客户端，节点零改动。

**Architecture:** core 层（`packages/core-ts`）改 `loadContainerForm` 的 id 解析为「解码优先 + 孤儿迁移」并新增 `purgeIllegalContainers` / `decodeSafe` / `categoryCandidates`；页面层（`apps/mobile`）入口显式解码、失败 toast、picker 接内置默认。`apps/mobile/src/core/*` 是 1:1 re-export 壳（#72），改 core-ts 即两端生效。

**Tech Stack:** TypeScript（vitest）、uni-app Vue3（vue-tsc + build:h5）。

**册子:** `docs/superpowers/specs/2026-10-07-app-container-id-decode-fix-design.md`（下称 #80）。实现与本计划冲突时以 #80 为准，先改计划再动手。

---

## 环境铁律

- 命令一律在对应包目录跑：core-ts 用 `e:\code\base\packages\core-ts`，mobile 用 `e:\code\base\apps\mobile`（PowerShell 下用工具的 cwd 参数，不要 `cd` 链）。
- 测试命令：core-ts `npx vitest run src/<file>`；全量门禁 Task 6。
- 提交纪律：每 Task 只 `git add` 该 Task 列出的文件；**绝不** add `scripts/__pycache__/`、`.bak*`、bundle 产物；push 写全 `git push origin master`。
- commit 风格：`fix(core-ts): ...` / `fix(mobile): ...` / `feat(mobile): ...`，一行说清，默认一气呵成不逐步询问。

## 文件结构（职责锁定）

| 文件 | 动作 | 职责 |
|---|---|---|
| `packages/core-ts/src/course-edit.ts` | 修改 | `decodeSafe` 导出；`loadContainerForm` 解析升级；删私有 `resolveId`；`purgeIllegalContainers` |
| `packages/core-ts/src/course-edit.test.ts` | 修改 | 解析/迁移/清理用例 |
| `packages/core-ts/src/course-tree.ts` | 修改 | `DEFAULT_CATEGORY` + `categoryCandidates` |
| `packages/core-ts/src/course-tree.test.ts` | 修改 | 候选去重用例 |
| `apps/mobile/src/pages/lesson/edit.vue` | 修改 | onLoad 解码、删页内 `decodedId`、失败 toast |
| `apps/mobile/src/pages/course/edit.vue` | 修改 | onLoad 解码（courseId/rebuildFrom）、失败 toast、picker 内置默认 |
| `apps/mobile/src/platform/index.ts` | 修改 | bootstrap 接 `purgeIllegalContainers` |
| `docs/superpowers/specs/2026-10-07-app-container-id-decode-fix-design.md` | 修改 | §3.3 措辞同步（repo 方法 → core 函数） |

---

### Task 1: core——decodeSafe 上提 + loadContainerForm「解码优先 + 孤儿迁移」

**Files:**
- Modify: `packages/core-ts/src/course-edit.ts`（L226-265：删 `resolveId` 整块，重写 `loadContainerForm`；文件内新增 `decodeSafe`）
- Test: `packages/core-ts/src/course-edit.test.ts`（追加用例）

- [ ] **Step 1.1: 写失败测试（追加到 course-edit.test.ts）**

import 处（L5-17 的 `from './course-edit'` 列表）加入 `decodeSafe`；文件尾追加：

```ts
describe('loadContainerForm 解码优先与孤儿迁移（#80 §3.1）', () => {
  const T = '2026-10-07T00:00:00Z';

  it('decodeSafe 幂等：有编码解码、无编码/坏编码原样', () => {
    expect(decodeSafe('course%2Fc1%2Flesson%2Fl9')).toBe('course/c1/lesson/l9');
    expect(decodeSafe('course/c1/lesson/l9')).toBe('course/c1/lesson/l9');
    expect(decodeSafe('course%ZZ')).toBe('course%ZZ');
  });

  it('编码态新 id：空表单但 itemId 为解码态（app 端 400 根治）', async () => {
    const repo = new MemoryRepo();
    const form = await loadContainerForm(repo, 'course%2Fc1%2Flesson%2Fl9', 'lesson');
    expect(form.itemId).toBe('course/c1/lesson/l9');
    expect(form.title).toBe('');
  });

  it('编码态孤儿行：内容照搬、身份迁到解码态 id', async () => {
    const repo = new MemoryRepo();
    await repo.upsertLocalContainer(
      { itemId: 'course%2Fc1%2Flesson%2Fl9', type: 'lesson', title: '卡住的课时', contentHash: '', updatedAt: T },
      [
        { seq: 0, kind: 'digest', text: '简介' },
        { seq: -1, kind: 'attr.body_md', text: '# 讲稿' },
      ],
    );
    const form = await loadContainerForm(repo, 'course%2Fc1%2Flesson%2Fl9', 'lesson');
    expect(form.itemId).toBe('course/c1/lesson/l9');
    expect(form.title).toBe('卡住的课时');
    expect(form.digest).toBe('简介');
    expect(form.bodyMd).toBe('# 讲稿');
  });

  it('解码态与编码态并存：解码行优先（#80 §6.1）', async () => {
    const repo = new MemoryRepo();
    await repo.upsertLocalContainer(
      { itemId: 'course/c1/lesson/l9', type: 'lesson', title: '正确行', contentHash: '', updatedAt: T },
      [],
    );
    await repo.upsertLocalContainer(
      { itemId: 'course%2Fc1%2Flesson%2Fl9', type: 'lesson', title: '孤儿行', contentHash: '', updatedAt: T },
      [],
    );
    const form = await loadContainerForm(repo, 'course%2Fc1%2Flesson%2Fl9', 'lesson');
    expect(form.itemId).toBe('course/c1/lesson/l9');
    expect(form.title).toBe('正确行');
  });

  it('解码态入参命中已存在条目：#61 行为不变', async () => {
    const repo = new MemoryRepo();
    await repo.upsertLocalContainer(
      { itemId: 'course/c1/lesson/l1', type: 'lesson', title: '已有课时', contentHash: '', updatedAt: T },
      [],
    );
    const form = await loadContainerForm(repo, 'course/c1/lesson/l1', 'lesson');
    expect(form.itemId).toBe('course/c1/lesson/l1');
    expect(form.title).toBe('已有课时');
  });
});
```

- [ ] **Step 1.2: 跑测试确认失败**

cwd `e:\code\base\packages\core-ts`：`npx vitest run src/course-edit.test.ts`
预期：FAIL——`does not provide an export named 'decodeSafe'`。

- [ ] **Step 1.3: 实现（course-edit.ts）**

① 在 `emptyContainerForm` 之前（约 L105）新增导出：

```ts
/** 解码路由参数为真实 id（#80 §3.1）：幂等——无编码/坏编码原样返回。 */
export function decodeSafe(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}
```

② **整块删除** L226-242 的 `resolveId`（含其 doc 注释）——它对「raw 原样命中」的短路会让迁移分支永远走不到，语义内联进 `loadContainerForm`。

③ `loadContainerForm`（L244-265）整体替换为：

```ts
/** 从本地包回填表单：标题取 `items`，其余取 `segments` 的三区间。条目不存在也得空表单，不抛。 */
export async function loadContainerForm(repo: LocalRepo, rawId: string, type: ContainerType): Promise<ContainerForm> {
  // 解码下沉（#61 §2 + #80 §3.1）：**解码优先**——已存在解码行直接命中；
  // 编码态孤儿行（历史 Bug 落库的 `%2F` id）内容照搬、身份迁到解码态 id；
  // 全新容器一律以解码态 id 起表单。三条路径都不抛。
  const decoded = decodeSafe(rawId);
  let itemId = decoded; // 表单身份
  let sourceId = decoded; // 内容所在行
  if ((await repo.getItem(decoded)) !== null) {
    itemId = decoded;
    sourceId = decoded;
  } else if (rawId !== decoded && (await repo.getItem(rawId)) !== null) {
    // 编码态孤儿行（#80 §3.1 迁移分支）：重进即见原内容，保存即落正确 id
    itemId = decoded;
    sourceId = rawId;
  }
  const item = await repo.getItem(sourceId);
  const segs = await repo.listSegments(sourceId);
  const attrs = attrsOf(segs);
  const form = emptyContainerForm(type, itemId);
  form.title = item?.title ?? '';
  form.digest = digestOf(segs);
  form.cover = attrs.cover;
  form.instructor = attrs.instructor;
  form.difficulty = attrs.difficulty;
  form.durationSec = attrs.duration;
  form.attachments = attrs.attachments.map((a) => ({ blobId: a.blobId, name: a.name }));
  form.bodyMd = type === 'lesson' ? attrs.bodyMd : '';
  form.category = type === 'course' ? attrs.category : '';
  form.badge = attrs.badge;
  form.titleColor = attrs.titleColor;
  form.children = childrenRowsOf(segs).map((r) => ({ kind: r.kind, itemId: r.text }));
  return form;
}
```

- [ ] **Step 1.4: 跑测试确认通过 + 存量无回归**

`npx vitest run src/course-edit.test.ts` → 全 PASS（含既有 #61 用例）。

- [ ] **Step 1.5: Commit**

```bash
git add packages/core-ts/src/course-edit.ts packages/core-ts/src/course-edit.test.ts
git commit -m "fix(core-ts): loadContainerForm 解码优先与编码态孤儿迁移（课时 400 根治）"
```

---

### Task 2: core——purgeIllegalContainers 一次性清理 + 册子措辞同步

**Files:**
- Modify: `packages/core-ts/src/course-edit.ts`（`isLegalContainerId` 之后新增）
- Modify: `docs/superpowers/specs/2026-10-07-app-container-id-decode-fix-design.md`（§3.3 一句）
- Test: `packages/core-ts/src/course-edit.test.ts`（追加用例）

- [ ] **Step 2.1: 写失败测试（追加到 course-edit.test.ts）**

```ts
describe('purgeIllegalContainers：一次性清理（#80 §3.3）', () => {
  const T = '2026-10-07T00:00:00Z';
  const sub = (itemId: string, type: string, state: 'sent' | 'failed') => ({
    itemId, type, title: itemId, bodyMd: '', questionJson: '', linksJson: '', segmentsJson: '[]',
    state, reason: state === 'failed' ? 'item_id_invalid' : '', created: 0,
    queuedAt: T, sentAt: state === 'sent' ? T : '', localOnly: false,
  });

  it('只清编码态容器行；article 不动、legal 行不动、sent 台账不动', async () => {
    const repo = new MemoryRepo();
    await repo.upsertLocalContainer({ itemId: 'course%2Fc1%2Flesson%2Fl9', type: 'lesson', title: '孤儿', contentHash: '', updatedAt: T }, []);
    await repo.upsertLocalContainer({ itemId: 'course/c1/lesson/l1', type: 'lesson', title: '正常课时', contentHash: '', updatedAt: T }, []);
    await repo.upsertLocalContainer({ itemId: 'course%2Fc2', type: 'course', title: '坏课程', contentHash: '', updatedAt: T }, []);
    await repo.upsertLocalContainer({ itemId: 'course%2Fx%2Farticle%2Fa1', type: 'article', title: '非容器', contentHash: '', updatedAt: T }, []);
    await repo.saveSubmission(sub('course%2Fc1%2Flesson%2Fl9', 'lesson', 'failed'));
    await repo.saveSubmission(sub('course%2Fc2', 'course', 'sent'));

    const purged = await purgeIllegalContainers(repo);
    expect(purged.sort()).toEqual(['course%2Fc1%2Flesson%2Fl9', 'course%2Fc2']);

    const ids = (await repo.listItems()).map((i) => i.itemId);
    expect(ids).toContain('course/c1/lesson/l1');
    expect(ids).toContain('course%2Fx%2Farticle%2Fa1');
    expect(ids).not.toContain('course%2Fc1%2Flesson%2Fl9');
    expect(ids).not.toContain('course%2Fc2');
    expect(await repo.getSubmission('course%2Fc1%2Flesson%2Fl9')).toBeNull();
    expect((await repo.getSubmission('course%2Fc2'))?.state).toBe('sent');
  });
});
```

import 列表加 `purgeIllegalContainers`。

- [ ] **Step 2.2: 跑测试确认失败**

`npx vitest run src/course-edit.test.ts`
预期：FAIL——`does not provide an export named 'purgeIllegalContainers'`。

- [ ] **Step 2.3: 实现（course-edit.ts，`isLegalContainerId` 函数之后）**

```ts
/**
 * 一次性清理（#80 §3.3）：删除 itemId 形态非法的**容器**行（编码态孤儿，历史 Bug 落库）。
 * 只处理 type 为 course/lesson 的条目——其余类型不走容器 id 形态判据，绝不误删；
 * 台账行仅删未送达的（`sent` 是台账本体，#56 §9.3 不可删）；
 * blob 文件不删（孤儿文件无害，`listBlobPathsByItem` 只回路径不回 id，不为清理扩接口）。
 * 返回被清理的 item_id（调用方可提示「已清理 N 条卡死记录」）。
 */
export async function purgeIllegalContainers(repo: LocalRepo): Promise<string[]> {
  const purged: string[] = [];
  for (const it of await repo.listItems()) {
    if (it.type !== 'course' && it.type !== 'lesson') continue;
    if (isLegalContainerId(it.type, it.itemId)) continue;
    await repo.removeLocalContainer(it.itemId); // items 带 source='local' 守卫，包内条目绝不误删
    const row = await repo.getSubmission(it.itemId);
    if (row !== null && row.state !== 'sent') await repo.removeSubmission(it.itemId);
    purged.push(it.itemId);
  }
  return purged;
}
```

- [ ] **Step 2.4: 跑测试确认通过 + 全文件无回归**

`npx vitest run src/course-edit.test.ts` → 全 PASS。

- [ ] **Step 2.5: 册子措辞同步（两处）**

§3.3 old: `加一次性清理：\`repo.purgeIllegalContainers()\`——删除`
§3.3 new: `加一次性清理：core 函数 \`purgeIllegalContainers(repo)\`（\`course-edit.ts\` 导出，组合既有 repo 方法）——删除`

§3.1 第 1 条 old: `1. \`resolveId(repo, raw)\` 命中（raw 或 decoded 存在于库）→ 沿用现行为，返回命中 id。`
§3.1 第 1 条 new: `1. **解码优先命中**：\`getItem(decoded)\` 命中 → 沿用现行为（#61 语义保持，实现上 \`resolveId\` 内联进 \`loadContainerForm\`，见计划 T1）。`

- [ ] **Step 2.6: Commit**

```bash
git add packages/core-ts/src/course-edit.ts packages/core-ts/src/course-edit.test.ts docs/superpowers/specs/2026-10-07-app-container-id-decode-fix-design.md
git commit -m "fix(core-ts): purgeIllegalContainers 一次性清理非法容器行 + 册子措辞同步"
```

---

### Task 3: 页面入口显式解码（lessonId / courseId / rebuildFrom）

**Files:**
- Modify: `apps/mobile/src/pages/lesson/edit.vue`（import L249、onLoad L546-547、删页内 decodedId L579-586）
- Modify: `apps/mobile/src/pages/course/edit.vue`（import L156、onLoad L208-209）

- [ ] **Step 3.1: lesson/edit.vue 三处**

import（L249）old → new：

```ts
import { decodeSafe, loadContainerForm, saveContainer, startNewLesson, uploadAndStoreBlob, type ContainerForm } from '../../core/course-edit';
```

onLoad（L545-547）old → new：

```ts
  // 先解码（册子 #61 §2.2 + #80 §3.2）：跳转方传 `encodeURIComponent(id)`，不解码会拼出坏 id
  courseId.value = decodeSafe(String(q.courseId ?? ''));
  const lessonId = decodeSafe(String(q.lessonId ?? ''));
```

**整块删除** L579-586 页内私有函数（含注释）：

```ts
/** 解码路由参数；坏编码回落原样（与详情页 `resolveBy` 同口径）。 */
function decodedId(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}
```

- [ ] **Step 3.2: course/edit.vue 两处**

import（L156）old → new：

```ts
import { decodeSafe, loadContainerForm, saveContainer, startNewCourse, uploadAndStoreBlob, type ChildRow, type ContainerForm } from '../../core/course-edit';
```

onLoad（L208-209）old → new：

```ts
  const courseId = decodeSafe(String(q.courseId ?? ''));
  const rebuildFrom = decodeSafe(String(q.rebuildFrom ?? ''));
```

（`rebuildFrom` 同类隐患：详情页跳转若编码 path-form 台账 id，`getSubmission` 原样查必落空；`decodeSafe` 幂等，16 hex 无编码原样返回，零副作用。）

- [ ] **Step 3.3: 验证**

cwd `e:\code\base\apps\mobile`：`npx vue-tsc --noEmit` → 零错误（页内 `decodedId` 已删干净，无残留引用）。

- [ ] **Step 3.4: Commit**

```bash
git add apps/mobile/src/pages/lesson/edit.vue apps/mobile/src/pages/course/edit.vue
git commit -m "fix(mobile): 容器编辑页入口 id 显式解码（lessonId/courseId/rebuildFrom）"
```

---

### Task 4: 保存失败 Toast（两页同构）

**Files:**
- Modify: `apps/mobile/src/pages/lesson/edit.vue`（submit() L770 前）
- Modify: `apps/mobile/src/pages/course/edit.vue`（submit() L475 前）

- [ ] **Step 4.1: lesson/edit.vue**

L768-771 old：

```ts
    }
    notice.value = out.message;
    await logSubmit(out.message);
```

new：

```ts
    }
    if (out.ledgerState === 'failed') {
      // 失败必须弹（#80 §3.4）：行内小字在长页底部不可见，真机曾静默
      uni.showToast({ title: out.message, icon: 'none' });
    }
    notice.value = out.message;
    await logSubmit(out.message);
```

- [ ] **Step 4.2: course/edit.vue**

L474-476 old：

```ts
    // pending 会自动补发；failed 需回「我的条目」删除后重投
    notice.value = out.message;
    await logSubmit(out.message);
```

new：

```ts
    // pending 会自动补发；failed 需回「我的条目」删除后重投
    if (out.ledgerState === 'failed') {
      // 失败必须弹（#80 §3.4）：行内小字在长页底部不可见，真机曾静默
      uni.showToast({ title: out.message, icon: 'none' });
    }
    notice.value = out.message;
    await logSubmit(out.message);
```

- [ ] **Step 4.3: 验证**

`npx vue-tsc --noEmit` → 零错误。

- [ ] **Step 4.4: Commit**

```bash
git add apps/mobile/src/pages/lesson/edit.vue apps/mobile/src/pages/course/edit.vue
git commit -m "fix(mobile): 课时/课程保存失败 toast 提示错误码"
```

---

### Task 5: 课程分类内置默认「从零开始」

**Files:**
- Modify: `packages/core-ts/src/course-tree.ts`（文件尾追加）
- Modify: `packages/core-ts/src/course-tree.test.ts`（追加用例）
- Modify: `apps/mobile/src/pages/course/edit.vue`（import L157、L234-237）

- [ ] **Step 5.1: 写失败测试（追加到 course-tree.test.ts）**

该文件已有 `item(itemId, type)` 帮助函数（L17-29，ItemRow 全字段）。追加：

```ts
describe('categoryCandidates：内置默认分类（#80 §3.5）', () => {
  it('首项恒为「从零开始」，本机词条其后追加', () => {
    const items = [item('category/math', 'category'), item('category/zzz', 'category')];
    // item() 的 title=itemId，手动改题：
    items[0]!.title = '数学';
    const cands = categoryCandidates(items);
    expect(cands[0]).toEqual({ slug: '从零开始', label: '从零开始（默认）' });
    expect(cands.slice(1).map((c) => c.slug)).toEqual(['math', 'zzz']);
  });

  it('本机已有同名词条时去重（内置优先，不重复出现）', () => {
    const items = [item('category/从零开始', 'category'), item('category/math', 'category')];
    const slugs = categoryCandidates(items).map((c) => c.slug);
    expect(slugs.filter((s) => s === '从零开始')).toHaveLength(1);
    expect(slugs[0]).toBe('从零开始');
  });

  it('空本机词条：只有内置默认一项（空态不空）', () => {
    expect(categoryCandidates([])).toEqual([{ slug: '从零开始', label: '从零开始（默认）' }]);
  });
});
```

import 处加入 `categoryCandidates`（与 `splitCourses` 等同源 `./course-tree`）。

- [ ] **Step 5.2: 跑测试确认失败**

cwd `e:\code\base\packages\core-ts`：`npx vitest run src/course-tree.test.ts`
预期：FAIL——`does not provide an export named 'categoryCandidates'`。

- [ ] **Step 5.3: 实现（course-tree.ts 文件尾追加）**

```ts
/** 内置默认分类（#80 §3.5）：选中即写 `attr.category`，词条由节点 directory 投影自动生成。 */
export const DEFAULT_CATEGORY = '从零开始';

/**
 * 分类 picker 候选（#80 §3.5）：内置默认首项 + 本机 `category/<slug>` 词条，按 slug 去重（内置优先）。
 * 空态（本机无任何分类词条）下候选不空。
 */
export function categoryCandidates(items: ItemRow[]): Array<{ slug: string; label: string }> {
  const local = splitCategories(items).map((c) => {
    const slug = c.itemId.replace(/^category\//, '');
    return { slug, label: c.title || slug };
  });
  return [
    { slug: DEFAULT_CATEGORY, label: `${DEFAULT_CATEGORY}（默认）` },
    ...local.filter((c) => c.slug !== DEFAULT_CATEGORY),
  ];
}
```

- [ ] **Step 5.4: 跑测试确认通过**

`npx vitest run src/course-tree.test.ts` → 全 PASS。

- [ ] **Step 5.5: 页面接线（course/edit.vue）**

import（L157）old → new（`splitCategories` 页内仅此一处用，直接换）：

```ts
import { categoryCandidates } from '../../core/course-tree';
```

L234-237 old：

```ts
    categoryAll.value = splitCategories(items).map((c) => {
      const slug = c.itemId.replace(/^category\//, '');
      return { slug, label: c.title || slug };
    });
```

new：

```ts
    categoryAll.value = categoryCandidates(items);
```

- [ ] **Step 5.6: 验证**

cwd `e:\code\base\apps\mobile`：`npx vue-tsc --noEmit` → 零错误。

- [ ] **Step 5.7: Commit**

```bash
git add packages/core-ts/src/course-tree.ts packages/core-ts/src/course-tree.test.ts apps/mobile/src/pages/course/edit.vue
git commit -m "feat(mobile): 课程分类内置默认「从零开始」+ 候选去重"
```

---

### Task 6: bootstrap 接线清理 + 全量门禁 + push

**Files:**
- Modify: `apps/mobile/src/platform/index.ts`（bootstrap L92-95）
- Modify: `packages/core-ts/src/course-edit.ts`（import 区加 `purgeIllegalContainers` 无需——platform 从壳导入）

- [ ] **Step 6.1: platform/index.ts 接线**

import 区（既有相对导入旁）加：

```ts
import { purgeIllegalContainers } from '../core/course-edit';
```

bootstrap（L92-95）old → new：

```ts
/** 建表 + 组装适配器；重复调用复用同一实例。 */
export async function bootstrap(): Promise<AppContext> {
  if (cached) return cached;
  const ctx = plusRuntime() !== undefined ? await appBootstrap() : await h5Bootstrap();
  // 一次性清理编码态孤儿容器行（#80 §3.3）：先于任何列表页读到脏行；失败不阻塞启动，下次启动重试
  try {
    await purgeIllegalContainers(ctx.repo);
  } catch {
    // 清理失败不阻塞启动
  }
  return ctx;
}
```

（原直通 `return` 改为接 ctx → 清理 → 返回；重复调用仍走 `if (cached)` 早退，清理每会话至多一次。）

- [ ] **Step 6.2: 全量门禁**

core-ts（cwd `e:\code\base\packages\core-ts`）：`npx tsc --noEmit; npx vitest run` → 双绿。
mobile（cwd `e:\code\base\apps\mobile`）：`npx vue-tsc --noEmit; npx vitest run; npm run build:h5` → 三绿。

- [ ] **Step 6.3: Commit + push**

```bash
git add apps/mobile/src/platform/index.ts
git commit -m "fix(mobile): bootstrap 接入一次性孤儿容器清理"
git push origin master
```

---

### Task 7: 版本发布 + 真机验收（#80 §5 的 3/4/5/6 条）

- [ ] **Step 7.1: 发新包（0.20.6）**

打开 `docs/superpowers/plans/2026-10-06-base-like-report-plan.md` 的 **Task 18**（mobile 发布四步：版本号 bump → 构建 → 上传 → `/v1/release` 核对），把其中版本号 `0.20.5` 全部换成 `0.20.6` 后逐步执行。门禁：`/v1/release` 返回新版本号、下载 URL 200 且字节数一致、验签 true。

- [ ] **Step 7.2: 真机清单（结果回填 #80 册子 §5）**

1. 存量卡死课时：重进编辑 → **原内容可见** → 保存 → 成功 toast（验收 3）
2. 课程页顶部不再出现编码态孤儿行（验收 4）
3. 断网保存 → toast 弹出含错误码（验收 5）
4. 课程编辑分类 picker 首项「从零开始（默认）」→ 选中保存 → 课程页归类正确（验收 6）
5. H5 回归：浏览器添加/编辑课时正常（验收 8，Task 6 门禁已覆盖 vitest 面）

---

## 门禁总表

| 门禁 | 内容 | 落在 |
|---|---|---|
| G1 | core-ts `tsc --noEmit` + `vitest run` 全绿（含 5 个新迁移用例 + 清理用例 + 候选用例） | T6 |
| G2 | mobile `vue-tsc --noEmit` + `vitest run` + `build:h5` 全绿 | T6 |
| G3 | 线上发版核对（release/下载/验签） | T7 |
| G4 | 真机 5 条（#80 §5 验收 3/4/5/6/8） | T7 |
