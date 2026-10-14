import { describe, it, expect } from 'vitest';
import { utf8 } from '@base/protocol-ts';

import { emptyContainerForm, saveContainer } from './course-edit';
import { FakeHttp, FakePackReader, MemoryFs, MemoryRepo, fakeAdapters } from './fakes';
import { writeNote, listNotes, deleteNote, newNoteID } from './notes';
import { decodeUtf8 } from './sync';
import type { SubmitOptions } from './submit';

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

const BASE = 'https://node.test';

function json(v: unknown) {
  return { status: 200, body: utf8(JSON.stringify(v)) };
}

describe('笔记隐私隔离（册子 #84 §4：不进提交/同步/catalog）', () => {
  it('saveContainer 提交文章后，所有 /v1/submit 请求体不含 note/ 前缀与笔记正文 secret', async () => {
    const http = new FakeHttp();
    const repo = new MemoryRepo();
    const adapters = fakeAdapters(http, new MemoryFs(), new FakePackReader());
    const o: SubmitOptions = { adapters, repo, nodeBaseUrl: BASE };
    http.postRoutes.set(`${BASE}/v1/identity/register`, json({}));
    http.postRoutes.set(`${BASE}/v1/submit`, json({ item_id: 'x', created: true }));

    await writeNote(repo, { noteId: newNoteID(), title: '私有', bodyMd: 'secret', tags: [], updatedAt: '2026-10-14T10:00:00Z' });
    const form = { ...emptyContainerForm('lesson', 'course/c1/lesson/l1'), title: '公开文章', bodyMd: 'public' };
    const out = await saveContainer(o, form);
    expect(out.ledgerState).toBe('sent');

    const submits = http.posted.filter((p) => p.url.endsWith('/v1/submit'));
    expect(submits.length).toBeGreaterThan(0);
    expect(submits.every((p) => !decodeUtf8(p.body).includes('note/'))).toBe(true);
    expect(submits.every((p) => !decodeUtf8(p.body).includes('secret'))).toBe(true);
  });
});
