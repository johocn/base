// 多节点权威序（spec §2.2）：写序 = 只写序首可达；读序 = 序首超时 3s 才 failover。
// 断网区仲裁铁律（spec §2.2 写死）：rev 高者 → 签名者 authority_order 小者 → content_hash 字典序。
import type { LocalRepo, NodeRow } from '../repo';

export const READ_FAILOVER_TIMEOUT_MS = 3000;

/** authority_order ASC（缺省 2147483647 = +∞ 语义；未知节点视作序位 +∞，spec §2.2）。 */
export function sortNodesByAuthority(rows: NodeRow[]): NodeRow[] {
  return [...rows].sort((a, b) => a.authorityOrder - b.authorityOrder);
}

export interface WriteOutcome { nodeId: string; degradedFrom: string | null }

/**
 * 写路径：逐序位探测（探测函数由调用方注入，通常 = hello 或 HEAD /healthz）；
 * 序 1 可达只写序 1；写失败降级序 2 且记录降级（degradedFrom）。
 */
export async function pickWriteNode(input: {
  repo: LocalRepo;
  probe: (node: NodeRow) => Promise<boolean>;
  write: (node: NodeRow) => Promise<boolean>; // 真写；false = 该节点写失败
}): Promise<WriteOutcome | null> {
  const nodes = sortNodesByAuthority(await input.repo.listNodesByOrder());
  let degradedFrom: string | null = null;
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i]!;
    if (!(await input.probe(n))) continue;
    if (i > 0 && degradedFrom === null) degradedFrom = nodes[0]!.nodeId;
    if (await input.write(n)) return { nodeId: n.nodeId, degradedFrom };
    if (degradedFrom === null) degradedFrom = nodes[0]!.nodeId;
  }
  return null;
}

export interface CatalogCandidate {
  rev: number;
  contentHash: string;
  signerAuthorityOrder: number; // 未知节点 = 2147483647
}

/** 断网区仲裁（spec §2.2 铁律 1-3，确定性收尾）。返回胜者索引；平局不可能（hash 字典序全序）。 */
export function arbitrateCatalogEntry(candidates: CatalogCandidate[]): number {
  let best = 0;
  for (let i = 1; i < candidates.length; i++) {
    const a = candidates[best]!;
    const b = candidates[i]!;
    if (b.rev > a.rev) best = i;
    else if (b.rev === a.rev) {
      if (b.signerAuthorityOrder < a.signerAuthorityOrder) best = i;
      else if (b.signerAuthorityOrder === a.signerAuthorityOrder && b.contentHash > a.contentHash) best = i;
    }
  }
  return best;
}
