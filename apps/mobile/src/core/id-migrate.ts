import type { LocalRepo } from './repo';

const DONE_KEY = 'id_migrate_v2';
/** 只有这三类载体承载用户数据（册子 §5.3 规则 3） */
const MIGRATABLE = new Set(['article', 'video', 'quiz']);

export async function migrateLegacyIds(repo: LocalRepo): Promise<number> {
  if ((await repo.getConfig(DONE_KEY)) === 'done') return 0;
  const ids = await repo.listLocalItemIds();
  const oldIds = ids.filter((id) => id.includes(':') && MIGRATABLE.has(id.slice(0, id.indexOf(':'))));
  const newIds = ids.filter((id) => !id.includes(':'));
  const bySlug = new Map<string, string[]>();
  for (const id of newIds) {
    const slug = id.slice(id.lastIndexOf('/') + 1);
    bySlug.set(slug, [...(bySlug.get(slug) ?? []), id]);
  }
  let moved = 0;
  for (const old of oldIds) {
    const slug = old.slice(old.indexOf(':') + 1);
    const candidates = bySlug.get(slug) ?? [];
    if (candidates.length !== 1) continue; // 多候选放弃、无候选保留旧行（规则 4/6）
    await repo.renameItemId(old, candidates[0]!);
    moved++;
  }
  await repo.setConfig(DONE_KEY, 'done');
  return moved;
}
