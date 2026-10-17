// mesh catalog 构建/合并（spec §2.2 断网区铁律 + §3.3/§3.4）。
// 终局仲裁（authority 序位）在 Task 7 接入；本文件只做构建与「rev 只进不退」合并。
import { verifyMeshCatalog, type MeshCatalogDoc, type MeshCatalogEntry } from '@base/protocol-ts';

import type { LocalRepo } from '../repo';

/** 源端构建 entries：items(active) × blob_index 聚合 size（repo 单条 GROUP BY，禁 N+1）。 */
export async function buildMeshCatalogEntries(repo: LocalRepo): Promise<MeshCatalogEntry[]> {
  const rows = await repo.meshCatalogRows();
  return rows.map((r) => ({
    item_id: r.itemId,
    rev: parseRev(r.rev),
    content_hash: r.contentHash,
    size: r.totalSize,
  }));
}

/** 执行期定案 2：rev 整数化——`source_rev` 可 parseInt 时取值，否则 0（canonicalize 只收整数）。 */
export function parseRev(sourceRev: string): number {
  const n = Number.parseInt(sourceRev, 10);
  return Number.isSafeInteger(n) && n >= 0 ? n : 0;
}

/** 验签集合内任一公钥通过即可（spec §1.2：{root_pubkey, 生效 cert new_pubkey, TOFU 锚点 sign_pubkey}）。 */
export function verifyCatalogPubs(doc: MeshCatalogDoc, pubs: string[]): boolean {
  return pubs.some((p) => verifyMeshCatalog(doc, p));
}

export interface MergeDecision {
  itemId: string;
  action: 'fetch' | 'current' | 'conflicted' | 'rev_regression';
  remoteRev: number;
}

/**
 * 目录合并（spec §3.4 步骤 3/5）：
 * - 远端 rev > 本地 rev → fetch；
 * - rev 相等且 content_hash 相等 → current；
 * - rev 相等、hash 异 → 本地保留 + conflicted=1（终局仲裁在 Task 7 arbitrateCatalogEntry）；
 * - 远端 rev < 本地 rev → rev_regression（拒绝，签名合法的回退只可能来自根密钥泄露 → 全屏告警）。
 */
export async function mergeMeshCatalog(
  repo: LocalRepo,
  entries: MeshCatalogEntry[],
): Promise<MergeDecision[]> {
  const out: MergeDecision[] = [];
  for (const e of entries) {
    const local = await repo.getItem(e.item_id);
    const localRev = local ? parseRev(local.rev) : -1;
    if (!local || e.rev > localRev) {
      out.push({ itemId: e.item_id, action: 'fetch', remoteRev: e.rev });
    } else if (e.rev === localRev) {
      if (local.contentHash === e.content_hash) {
        out.push({ itemId: e.item_id, action: 'current', remoteRev: e.rev });
      } else {
        await repo.markItemConflicted(e.item_id);
        out.push({ itemId: e.item_id, action: 'conflicted', remoteRev: e.rev });
      }
    } else {
      out.push({ itemId: e.item_id, action: 'rev_regression', remoteRev: e.rev });
    }
  }
  return out;
}
