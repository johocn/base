import { describe, expect, it, vi } from 'vitest';

import { MemoryRepo } from '../fakes';
import type { NodeRow } from '../repo';
import { arbitrateCatalogEntry, pickWriteNode, READ_FAILOVER_TIMEOUT_MS, sortNodesByAuthority } from './authority';

const INF = 2147483647;

function node(nodeId: string, authorityOrder: number): NodeRow {
  return {
    nodeId, url: `https://${nodeId}.example.com`, tlsFingerprint: 'aa'.repeat(32),
    signPubkey: 'bb'.repeat(32), authorityOrder, lastSeenAt: '',
  };
}

describe('sortNodesByAuthority', () => {
  it('乱序 + 两个缺省 2147483647 → 稳定升序（缺省值间保持输入相对顺序），不改入参', () => {
    const input = [node('c', INF), node('a', 1), node('d', INF), node('b', 2)];
    const sorted = sortNodesByAuthority(input);
    expect(sorted.map((r) => r.nodeId)).toEqual(['a', 'b', 'c', 'd']);
    expect(input.map((r) => r.nodeId)).toEqual(['c', 'a', 'd', 'b']); // 入参不被改写
  });
});

describe('pickWriteNode', () => {
  async function repoWithNodes(): Promise<MemoryRepo> {
    const repo = new MemoryRepo();
    await repo.upsertNode(node('n3', 3));
    await repo.upsertNode(node('n1', 1));
    await repo.upsertNode(node('n2', 2));
    return repo;
  }

  it('序 1 可达 → 只写序 1（probe/write 均不触序 2），degradedFrom=null', async () => {
    const repo = await repoWithNodes();
    const probed: string[] = [];
    const written: string[] = [];
    const outcome = await pickWriteNode({
      repo,
      probe: vi.fn(async (n: NodeRow) => {
        probed.push(n.nodeId);
        return true;
      }),
      write: vi.fn(async (n: NodeRow) => {
        written.push(n.nodeId);
        return true;
      }),
    });
    expect(outcome).toEqual({ nodeId: 'n1', degradedFrom: null });
    expect(probed).toEqual(['n1']);
    expect(written).toEqual(['n1']);
  });

  it('序 1 probe 失败 → 降级序 2，degradedFrom=序 1', async () => {
    const repo = await repoWithNodes();
    const outcome = await pickWriteNode({
      repo,
      probe: async (n) => n.nodeId !== 'n1',
      write: async () => true,
    });
    expect(outcome).toEqual({ nodeId: 'n2', degradedFrom: 'n1' });
  });

  it('序 1 写失败 → 降级序 2，degradedFrom=序 1', async () => {
    const repo = await repoWithNodes();
    const written: string[] = [];
    const outcome = await pickWriteNode({
      repo,
      probe: async () => true,
      write: async (n) => {
        written.push(n.nodeId);
        return n.nodeId !== 'n1';
      },
    });
    expect(outcome).toEqual({ nodeId: 'n2', degradedFrom: 'n1' });
    expect(written).toEqual(['n1', 'n2']);
  });

  it('全失败（probe 全 false）→ null 且从未调用 write', async () => {
    const repo = await repoWithNodes();
    const write = vi.fn(async () => true);
    const outcome = await pickWriteNode({ repo, probe: async () => false, write });
    expect(outcome).toBeNull();
    expect(write).not.toHaveBeenCalled();
  });

  it('READ_FAILOVER_TIMEOUT_MS = 3000（spec §2.2 读序 failover 阈值）', () => {
    expect(READ_FAILOVER_TIMEOUT_MS).toBe(3000);
  });
});

describe('arbitrateCatalogEntry', () => {
  const cand = (rev: number, signerAuthorityOrder: number, contentHash: string) => ({
    rev, signerAuthorityOrder, contentHash,
  });

  it('rev 高者胜（3 候选乱序）', () => {
    const winner = arbitrateCatalogEntry([cand(1, 1, 'aa'), cand(5, 9, 'bb'), cand(3, 1, 'cc')]);
    expect(winner).toBe(1);
  });

  it('同 rev：签名者序位小者胜（未知 +∞ 输给已知序位）', () => {
    const winner = arbitrateCatalogEntry([cand(2, INF, 'aa'), cand(2, 2, 'bb'), cand(2, 9, 'cc')]);
    expect(winner).toBe(1);
  });

  it('同 rev 同序位：content_hash 字典序大者胜（确定性收尾）', () => {
    const winner = arbitrateCatalogEntry([cand(2, 3, 'aa'.repeat(32)), cand(2, 3, 'ff'.repeat(32))]);
    expect(winner).toBe(1);
    const winner2 = arbitrateCatalogEntry([cand(2, 3, 'ff'.repeat(32)), cand(2, 3, 'aa'.repeat(32))]);
    expect(winner2).toBe(0);
  });
});
