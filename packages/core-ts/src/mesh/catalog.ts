// mesh catalog 构建/合并/仲裁（spec §2.2 断网区铁律 + §3.3/§3.4）。
// 同 rev 异 hash 的终局仲裁走 authority.ts 的 arbitrateCatalogEntry；本文件只做构建与「rev 只进不退」合并。
import { verifyMeshCatalog, type MeshCatalogDoc, type MeshCatalogEntry } from '@base/protocol-ts';

import type { LocalRepo } from '../repo';
import { arbitrateCatalogEntry } from './authority';

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

/** 未知签名者序位 = +∞ 语义（spec §2.2：不在锚点表的节点视作序位最大）。 */
const UNKNOWN_SIGNER_ORDER = 2147483647;

/** mergeMeshCatalog 仲裁选项：arbitrate=true 且给出 signerOrder 才启用断网区仲裁，否则保持 Task 4 行为。 */
export interface MergeArbitrateOptions {
  /** 同 rev 异 hash 时启用仲裁（spec §2.2 铁律 1-3）。 */
  arbitrate?: boolean;
  /** 远端 catalog 签名者的 authority_order；查不到锚点传 2147483647。 */
  signerOrder?: number;
  /** 本地候选的签名者序位（本机为源端时取自身节点序位）；缺省 2147483647 = 本地副本无签名锚。 */
  localOrder?: number;
}

/**
 * 目录合并（spec §3.4 步骤 3/5）：
 * - 远端 rev > 本地 rev → fetch；
 * - rev 相等且 content_hash 相等 → current；
 * - rev 相等、hash 异 → 默认本地保留 + conflicted=1；opts 传 arbitrate+signerOrder 时走
 *   arbitrateCatalogEntry 铁律（rev 同 → 签名者序位小者 → hash 字典序）：远端胜 → 覆盖写入
 *   （applyRemoteCatalogEntry：rev 只进不退守卫 + 清 conflicted）并报 fetch，本地胜 → 保留 + conflicted；
 * - 远端 rev < 本地 rev → rev_regression（恒拒绝，不分仲裁；签名合法的回退只可能来自根密钥泄露 → 全屏告警）。
 */
export async function mergeMeshCatalog(
  repo: LocalRepo,
  entries: MeshCatalogEntry[],
  opts?: MergeArbitrateOptions,
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
      } else if (opts?.arbitrate === true && opts.signerOrder !== undefined) {
        // 断网区仲裁（spec §2.2 铁律）：候选 [本地, 远端]，胜者索引 1 = 远端
        const winner = arbitrateCatalogEntry([
          { rev: localRev, contentHash: local.contentHash, signerAuthorityOrder: opts.localOrder ?? UNKNOWN_SIGNER_ORDER },
          { rev: e.rev, contentHash: e.content_hash, signerAuthorityOrder: opts.signerOrder },
        ]);
        if (winner === 1) {
          await repo.applyRemoteCatalogEntry(e.item_id, e.rev, e.content_hash);
          out.push({ itemId: e.item_id, action: 'fetch', remoteRev: e.rev });
        } else {
          await repo.markItemConflicted(e.item_id);
          out.push({ itemId: e.item_id, action: 'conflicted', remoteRev: e.rev });
        }
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
