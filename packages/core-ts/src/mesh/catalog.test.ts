import { describe, expect, it } from 'vitest';
import {
  deriveIdentityId,
  keyPairFromSeed,
  signMeshCatalog,
  type MeshCatalogDoc,
  type MeshCatalogEntry,
} from '@base/protocol-ts';

import { MemoryRepo } from '../fakes';
import type { ItemRow } from '../types';
import { buildMeshCatalogEntries, mergeMeshCatalog, parseRev, verifyCatalogPubs } from './catalog';

// 与 Go 侧、vectors/v1/ed25519.json 相同的 RFC 8032 §7.1 TEST 密钥
const SEED = '9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60';
const WORK_SEED = '4ccd089b28ff96da9db6c346ec114e0f5b8a319f35aba624da8cf6ed4fb8a6fb';
const PUB = keyPairFromSeed(SEED).pubHex;
const OTHER_PUB = keyPairFromSeed(WORK_SEED).pubHex;

function item(itemId: string, rev: string, contentHash: string, state = 'active'): ItemRow {
  return {
    itemId, source: 'node', type: 'article', title: itemId, rev, contentHash, state,
    updatedAt: '2026-10-17T00:00:00Z', authorId: '', authorSig: '',
  };
}

async function repoWithItems(items: ItemRow[]): Promise<MemoryRepo> {
  const repo = new MemoryRepo();
  await repo.applyPack({
    version: 1, packId: 'p1', items, articles: [], quizzes: [], segments: [], tombstones: [],
    updatedAt: '2026-10-17T00:00:00Z',
  });
  return repo;
}

describe('buildMeshCatalogEntries', () => {
  it('blob_index 聚合 size 正确、inactive 排除、rev 整数化', async () => {
    const repo = await repoWithItems([
      item('article:a', '3', 'aa'.repeat(32)),
      item('article:b', '', 'bb'.repeat(32)), // rev 非 parseInt（本地乐观条目形态）→ 0
      item('article:c', '9', 'cc'.repeat(32), 'inactive'),
    ]);
    await repo.addBlob('blob-a1', 'me', '/p1', 10, '2026-10-17T00:00:00Z', undefined, undefined, 'article:a');
    await repo.addBlob('blob-a2', 'me', '/p2', 20, '2026-10-17T00:00:00Z', undefined, undefined, 'article:a');
    await repo.addBlob('blob-c1', 'me', '/p3', 99, '2026-10-17T00:00:00Z', undefined, undefined, 'article:c');

    const entries = await buildMeshCatalogEntries(repo);
    expect(entries.find((e) => e.item_id === 'article:a')).toEqual({
      item_id: 'article:a', rev: 3, content_hash: 'aa'.repeat(32), size: 30,
    });
    expect(entries.find((e) => e.item_id === 'article:b')?.rev).toBe(0);
    expect(entries.some((e) => e.item_id === 'article:c')).toBe(false);
  });
});

describe('parseRev', () => {
  it('可 parseInt 取值，失败归 0（执行期定案 2）', () => {
    expect(parseRev('42')).toBe(42);
    expect(parseRev('0')).toBe(0);
    expect(parseRev('')).toBe(0);
    expect(parseRev('rev-1')).toBe(0);
    expect(parseRev('-5')).toBe(0);
  });
});

describe('mergeMeshCatalog', () => {
  it('四分支：fetch / current / conflicted+置位 / rev_regression', async () => {
    const repo = await repoWithItems([
      item('item/hi', '2', 'aa'.repeat(32)),
      item('item/same', '3', 'bb'.repeat(32)),
      item('item/diff', '3', 'cc'.repeat(32)),
      item('item/old', '5', 'dd'.repeat(32)),
    ]);
    const decisions = await mergeMeshCatalog(repo, [
      { item_id: 'item/new', rev: 1, content_hash: 'ee'.repeat(32), size: 0 }, // 本地无 → fetch
      { item_id: 'item/hi', rev: 3, content_hash: 'aa'.repeat(32), size: 0 }, // 远端 rev 高 → fetch
      { item_id: 'item/same', rev: 3, content_hash: 'bb'.repeat(32), size: 0 }, // 同 rev 同 hash → current
      { item_id: 'item/diff', rev: 3, content_hash: 'ff'.repeat(32), size: 0 }, // 同 rev 异 hash → conflicted
      { item_id: 'item/old', rev: 4, content_hash: 'dd'.repeat(32), size: 0 }, // 远端 rev 低 → 拒绝
    ]);
    expect(decisions).toEqual([
      { itemId: 'item/new', action: 'fetch', remoteRev: 1 },
      { itemId: 'item/hi', action: 'fetch', remoteRev: 3 },
      { itemId: 'item/same', action: 'current', remoteRev: 3 },
      { itemId: 'item/diff', action: 'conflicted', remoteRev: 3 },
      { itemId: 'item/old', action: 'rev_regression', remoteRev: 4 },
    ]);
    expect(repo.conflictedItems.has('item/diff')).toBe(true);
    expect(repo.conflictedItems.has('item/old')).toBe(false);
  });
});

describe('verifyCatalogPubs', () => {
  const entries: MeshCatalogEntry[] = [
    { item_id: 'article/a', rev: 3, content_hash: 'cc'.repeat(32), size: 1234 },
  ];
  const doc: MeshCatalogDoc = signMeshCatalog({
    type: 'mesh-catalog', v: 1, node_id: deriveIdentityId(PUB), catalog_version: 7,
    entries, signed_at: '2026-10-17T00:00:00Z',
  }, SEED);

  it('任一公钥通过即可（spec §1.2 验签集合）', () => {
    expect(verifyCatalogPubs(doc, [OTHER_PUB, PUB])).toBe(true);
    expect(verifyCatalogPubs(doc, [OTHER_PUB])).toBe(false);
  });
});
