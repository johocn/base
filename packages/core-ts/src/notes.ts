/** 私有笔记（册子 #84 §4）：仅本机，绝不进入提交/同步/catalog 链路。 */
import { bytesToHex, randomBytes } from '@base/protocol-ts';
import type { LocalRepo } from './repo';

export interface NoteRow {
  noteId: string;
  title: string;
  bodyMd: string;
  tags: string[];
  updatedAt: string;
}

/** `note/<12 位 hex>`（6 字节随机，同 newLessonID 的 randomBytes 手法）。 */
export function newNoteID(): string {
  return `note/${bytesToHex(randomBytes(6))}`;
}

export async function writeNote(repo: LocalRepo, row: NoteRow): Promise<void> {
  await repo.upsertNote(row);
}

export async function listNotes(repo: LocalRepo, tag?: string): Promise<NoteRow[]> {
  const rows = await repo.listNotes();
  const filtered = tag === undefined ? rows : rows.filter((r) => r.tags.includes(tag));
  return filtered.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
}

export async function deleteNote(repo: LocalRepo, noteId: string): Promise<void> {
  await repo.deleteNote(noteId);
}
