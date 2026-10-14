# M2 私有笔记模块 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 独立私有笔记模块：仅本机存储（不上节点/不入台账/不进 catalog），列表+标签过滤、Markdown 编辑器（含工具栏与图库）、详情渲染，「我的」页入口。

**Architecture:** core 层新增独立 `notes` 表与 `notes.ts` 模块（不动 items/segments/MySubmissionRow，天然与提交链路隔离）；mobile 三页（list/edit/detail）适老样式（--fs-* 令牌），编辑器按既有两页拷贝模式同构（lesson/edit.vue 手法）。

**Tech Stack:** TypeScript、vitest（TDD）、uni-app Vue3。上游册子：`specs/2026-10-14-base-elder-accessibility-blueprint-design.md` §4。

**执行约定：** git 在 `e:\code\base`；PowerShell 用 `;` 不用 `&&`；每 Task 只 add 该 Task 文件并 commit；门禁绿了才提交；工作区 docs/README.md 既有改动勿碰。

**数据模型（全计划统一）：**

```
表 notes: note_id TEXT PRIMARY KEY, title TEXT NOT NULL, body_md TEXT NOT NULL DEFAULT '', tags TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL
NoteRow = { noteId: string; title: string; bodyMd: string; tags: string[]; updatedAt: string }  // tags 以逗号串存库，接口层转数组
noteId 形态：`note/<12位hex>`（新函数 newNoteID()，用 crypto 随机，同 newLessonID 手法）
```

---

### Task 1: core — notes 表与 repo 方法

**Files:**
- Modify: `packages/core-ts/src/repo.ts`（LocalRepo 接口 L28 区追加方法、SCHEMA_SQL L157 区追加 DDL、SqlRepo L327 区追加实现）
- Modify: `packages/core-ts/src/fakes.ts`（MemoryRepo L44 区追加 Map 与实现）
- Test: `packages/core-ts/src/notes.test.ts`（新建）

- [ ] **Step 1: 写失败测试**（`notes.test.ts` 全文）

```ts
import { describe, it, expect } from 'vitest';
import { MemoryRepo } from './fakes';
import { writeNote, listNotes, deleteNote, newNoteID } from './notes';

describe('notes 本地存储（册子 #84 §4）', () => {
  it('writeNote 落库并 listNotes 倒序返回', async () => {
    const repo = new MemoryRepo();
    await writeNote(repo, { noteId: newNoteID(), title: '第一篇', bodyMd: '内容', tags: ['语文'], updatedAt: '2026-10-14T10:00:00Z' });
    await writeNote(repo, { noteId: newNoteID(), title: '第二篇', bodyMd: '', tags: [], updatedAt: '2026-10-14T11:00:00Z' });
    const rows = await listNotes(repo);
    expect(rows.map((r) => r.title)).toEqual(['第二篇', '第一篇']);
    expect(rows[0]!.tags).toEqual([]);
  });

  it('listNotes 按标签过滤（任一命中即返回）', async () => {
    const repo = new MemoryRepo();
    await writeNote(repo, { noteId: newNoteID(), title: '甲', bodyMd: '', tags: ['语文', '备课'], updatedAt: '2026-10-14T10:00:00Z' });
    await writeNote(repo, { noteId: newNoteID(), title: '乙', bodyMd: '', tags: ['数学'], updatedAt: '2026-10-14T10:01:00Z' });
    expect((await listNotes(repo, '语文')).map((r) => r.title)).toEqual(['甲']);
    expect((await listNotes(repo, '备课')).map((r) => r.title)).toEqual(['甲']);
    expect(await listNotes(repo, '英语')).toEqual([]);
  });

  it('deleteNote 删除后列表为空；newNoteID 形态 note/<hex>', async () => {
    const repo = new MemoryRepo();
    const id = newNoteID();
    expect(id).toMatch(/^note\/[0-9a-f]{12}$/);
    await writeNote(repo, { noteId: id, title: '删我', bodyMd: '', tags: [], updatedAt: '2026-10-14T10:00:00Z' });
    await deleteNote(repo, id);
    expect(await listNotes(repo)).toEqual([]);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**：`cd packages/core-ts; npx vitest run src/notes.test.ts` → FAIL（模块不存在）。

- [ ] **Step 3: 实现**——新建 `packages/core-ts/src/notes.ts`：

```ts
/** 私有笔记（册子 #84 §4）：仅本机，绝不进入提交/同步/catalog 链路。 */
import type { LocalRepo } from './repo';

export interface NoteRow {
  noteId: string;
  title: string;
  bodyMd: string;
  tags: string[];
  updatedAt: string;
}

export function newNoteID(): string {
  const hex = Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) => b.toString(16).padStart(2, '0')).join('');
  return `note/${hex}`;
}

export async function writeNote(repo: LocalRepo, row: NoteRow): Promise<void> {
  await repo.upsertNote({ ...row, tags: row.tags });
}

export async function listNotes(repo: LocalRepo, tag?: string): Promise<NoteRow[]> {
  const rows = await repo.listNotes();
  const filtered = tag === undefined ? rows : rows.filter((r) => r.tags.includes(tag));
  return filtered.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
}

export async function deleteNote(repo: LocalRepo, noteId: string): Promise<void> {
  await repo.deleteNote(noteId);
}
```

`repo.ts` LocalRepo 接口追加（L155 前后接口体内）：

```ts
  upsertNote(row: { noteId: string; title: string; bodyMd: string; tags: string[]; updatedAt: string }): Promise<void>;
  listNotes(): Promise<Array<{ noteId: string; title: string; bodyMd: string; tags: string[]; updatedAt: string }>>;
  deleteNote(noteId: string): Promise<void>;
```

SCHEMA_SQL（L218 前追加 DDL）：

```sql
CREATE TABLE IF NOT EXISTS notes (
  note_id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  body_md TEXT NOT NULL DEFAULT '',
  tags TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL
);
```

SqlRepo（L391 区）实现三方法（tags `join(',')` 存 / `split(',').filter(Boolean)` 取）：

```ts
  async upsertNote(row: { noteId: string; title: string; bodyMd: string; tags: string[]; updatedAt: string }): Promise<void> {
    await this.run(
      `INSERT INTO notes (note_id, title, body_md, tags, updated_at) VALUES (?,?,?,?,?)
       ON CONFLICT(note_id) DO UPDATE SET title=excluded.title, body_md=excluded.body_md, tags=excluded.tags, updated_at=excluded.updated_at`,
      [row.noteId, row.title, row.bodyMd, row.tags.join(','), row.updatedAt],
    );
  }
  async listNotes(): Promise<Array<{ noteId: string; title: string; bodyMd: string; tags: string[]; updatedAt: string }>> {
    const rows = await this.all<{ note_id: string; title: string; body_md: string; tags: string; updated_at: string }>(
      `SELECT note_id, title, body_md, tags, updated_at FROM notes`,
    );
    return rows.map((r) => ({ noteId: r.note_id, title: r.title, bodyMd: r.body_md, tags: r.tags ? r.tags.split(',').filter(Boolean) : [], updatedAt: r.updated_at }));
  }
  async deleteNote(noteId: string): Promise<void> {
    await this.run(`DELETE FROM notes WHERE note_id = ?`, [noteId]);
  }
```

（`this.run`/`this.all` 用 SqlRepo 内既有的私有执行方法名，现场对齐；MemoryRepo 在 fakes.ts 加 `notes = new Map<string, …>()` 与同签名三方法，排序过滤逻辑复用 notes.ts 的 listNotes 即 Map 全量转数组。）

- [ ] **Step 4: 跑测试确认通过**：`cd packages/core-ts; npx vitest run` → 全绿。

- [ ] **Step 5: Commit**

```powershell
git add packages/core-ts/src/notes.ts packages/core-ts/src/notes.test.ts packages/core-ts/src/repo.ts packages/core-ts/src/fakes.ts
git commit -m "feat(core-ts): 私有笔记本地表与 CRUD（tags 过滤/倒序）(#84)"
```

---

### Task 2: core — 隐私隔离测试锁定

**Files:**
- Test: `packages/core-ts/src/notes.test.ts`（文件尾追加 describe）

- [ ] **Step 1: 写测试**（追加）：

```ts
import { saveContainer } from './course-edit';
import { emptyContainerForm } from './course-edit';
import { fakeAdapters } from './fakes';
import { FakeHttp, MemoryFs, FakePackReader, json, utf8, decodeUtf8 } from './test-utils';

describe('笔记隐私隔离（册子 #84 §4：不进提交/同步/catalog）', () => {
  it('saveContainer 提交文章后，submits 与 repo 内均不含任何 note/*', async () => {
    const http = new FakeHttp();
    const repo = new MemoryRepo();
    const adapters = fakeAdapters(http, new MemoryFs(), new FakePackReader());
    const o = { adapters, repo, nodeBaseUrl: 'https://n1' } as never;
    http.postRoutes.set('https://n1/v1/identity/register', json({}));
    http.postRoutes.set('https://n1/v1/submit', json({ item_id: 'x', created: true }));
    await writeNote(repo, { noteId: newNoteID(), title: '私有', bodyMd: 'secret', tags: [], updatedAt: '2026-10-14T10:00:00Z' });
    await saveContainer(o, { ...emptyContainerForm('article', 'article/a1'), title: '公开文章', bodyMd: 'public' } as never);
    const submits = http.posted.filter((p) => p.url.endsWith('/v1/submit'));
    expect(submits.every((p) => !decodeUtf8(p.body).includes('note/'))).toBe(true);
    expect(submits.every((p) => !decodeUtf8(p.body).includes('secret'))).toBe(true);
  });
});
```

（`o` 与 form 的构造以 `course-edit.test.ts` 既有 fixture 手法为准，现场对齐；断言核心：submit 请求体不含 `note/` 前缀与笔记正文。）

- [ ] **Step 2: 跑测试**：`npx vitest run src/notes.test.ts` → 应直接通过（隔离是结构性的：notes 表独立于 items/segments）。若失败说明链路有耦合，修复至绿。

- [ ] **Step 3: Commit**

```powershell
git add packages/core-ts/src/notes.test.ts
git commit -m "test(core-ts): 笔记隐私隔离——提交链路不含 note 断言 (#84)"
```

---

### Task 3: mobile — 路由/入口/列表页

**Files:**
- Modify: `apps/mobile/src/pages.json`（pages 数组加 3 条，样式同相邻条目：navigationBarTitleText 适老、disableScroll 默认）
- Modify: `apps/mobile/src/pages/mine/mine.vue`（菜单数组 L20-35 区加「我的笔记」→ `/pages/note/list`）
- Create: `apps/mobile/src/pages/note/list.vue`

- [ ] **Step 1: list.vue**（适老样式全引 `--fs-*`；顶栏「新建笔记」按钮 min-height 48px；标签过滤行（横排 tags 候选取自现有笔记并集）+ 大卡列表（标题 fs-body + 时间 fs-annotate，min-height 48px）+ 长按删除 confirm；数据源 `listNotes(repo, activeTag)`，repo 实例化手法同 mine.vue 现状；空态大字提示「还没有笔记，点上方新建」）。

- [ ] **Step 2: 门禁**：`cd apps/mobile; npx vue-tsc --noEmit; npx vitest run --reporter=dot; npm run build:h5` 全绿。

- [ ] **Step 3: Commit**

```powershell
git add apps/mobile/src/pages.json apps/mobile/src/pages/mine/mine.vue apps/mobile/src/pages/note/list.vue
git commit -m "feat(mobile): 笔记列表页+我的页入口（标签过滤/长按删除）(#84)"
```

---

### Task 4: mobile — 编辑页与详情页

**Files:**
- Create: `apps/mobile/src/pages/note/edit.vue`（复制 lesson/edit.vue 结构：标题输入+正文 textarea+工具栏+图库弹层，**删除**课程/课时特有逻辑（children/保存回写/预检），保存走 `writeNote`（标题空校验 toast）；图库沿用 searchLocalBlobs+上传预览同构；编辑态经 url 参数 noteId 载入，`onLoad` 读 `getNote`（repo.listNotes 内查或加 `getNote` 方法——用 listNotes 过滤实现，避免再动接口））
- Create: `apps/mobile/src/pages/note/detail.vue`（渲染 `renderMarkdown(resolveBlobRefsInMd(row.bodyMd, nodeBaseUrl))`——article.vue:185 同口径；标题 fs-title、正文容器 fs-body/行高1.6；顶栏「编辑」「删除」按钮）

- [ ] **Step 1: 实现两页**（字段绑定 `noteId/title/bodyMd/tags`；保存成功 `uni.navigateBack`）。
- [ ] **Step 2: 门禁** 同 Task 3。全绿。
- [ ] **Step 3: Commit**

```powershell
git add apps/mobile/src/pages/note/edit.vue apps/mobile/src/pages/note/detail.vue
git commit -m "feat(mobile): 笔记编辑与详情页（工具栏/图库同构，blob 渲染）(#84)"
```

---

### Task 5: 发版

- [ ] **Step 1: manifest.json bump 0.21.1 / 40。**
- [ ] **Step 2: 全量门禁**：protocol-ts `npm test`；core-ts `npx vitest run`；`go test ./...`；mobile `vue-tsc + vitest + build:h5`。全绿。
- [ ] **Step 3: Commit + push**

```powershell
git add apps/mobile/src/manifest.json
git commit -m "chore(mobile): 发版 0.21.1 (40)"
git push
```

- [ ] **Step 4: 真机验收清单**：①我的→我的笔记→新建→写正文带图→保存→列表可见 ②标签过滤 ③删除确认 ④详情图可见 ⑤登录网页版确认节点 catalog 无任何笔记（隐私核心断言）⑥两页适老字号与 48px 目标。
