import type { LocalRepo } from './repo';
import type { ItemRow } from './types';

export interface CarrierCandidate {
  kind: string;
  itemId: string;
  title: string;
}

/** course 的子项 kind 即 lesson，lesson 的子项即 article|video|audio|quiz（口径同 #40 §2.1）。 */
export function kindOfItem(item: ItemRow): string {
  return item.type;
}

/**
 * 本机可作载体的条目候选：`listItems()` → 仅 active → kind 命中 → 关键词子串匹配（空关键词不过滤）
 * → 按 itemId 升序。title 为空串时回落 itemId。
 */
export async function listCarrierCandidates(repo: LocalRepo, kinds: string[], keyword: string): Promise<CarrierCandidate[]> {
  const want = new Set(kinds);
  const needle = keyword.trim().toLowerCase();
  return (await repo.listItems())
    .filter((i) => i.state === 'active')
    .filter((i) => want.has(kindOfItem(i)))
    .filter((i) => needle === '' || i.itemId.toLowerCase().includes(needle) || i.title.toLowerCase().includes(needle))
    .sort((a, b) => (a.itemId < b.itemId ? -1 : a.itemId > b.itemId ? 1 : 0))
    .map((i) => ({ kind: kindOfItem(i), itemId: i.itemId, title: i.title || i.itemId }));
}