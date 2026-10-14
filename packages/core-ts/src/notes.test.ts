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
