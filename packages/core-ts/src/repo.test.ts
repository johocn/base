// 本地库建表/补列的回归守卫：`items.author_id` / `author_sig` 曾经只在读写侧存在，
// 建表语句与补列函数都漏了，导致全新库上 listItems() 一律 `no such column: author_id`
// （评论页内容 chips、myitems / favorite / search 全部拿不到数据），而 SCHEMA_SQL 此前无任何测试引用。
import { describe, expect, it } from 'vitest';

import type { LocalDb } from './platform/adapter';
import { MemoryRepo } from './fakes';
import type { GossipRow, NodeRow } from './repo';
import { SCHEMA_SQL, ensureItemsColumns } from './repo';

/** 只实现 `ensureItemsColumns` 用到的两条语句：PRAGMA 读列名、ALTER 记账。 */
class ColumnsDb implements LocalDb {
  readonly alters: string[] = [];

  constructor(private readonly cols: string[]) {}

  async select(sql: string): Promise<Record<string, unknown>[]> {
    if (sql !== `PRAGMA table_info(items)`) throw new Error(`未预期的 select: ${sql}`);
    return this.cols.map((name) => ({ name }));
  }

  async execute(sql: string): Promise<void> {
    this.alters.push(sql);
  }

  async tx(): Promise<void> {
    throw new Error('未预期的事务');
  }
}

describe('items 表的后加列', () => {
  it('新建库：建表语句自带 author_id / author_sig / tags_json / like_count / conflicted', () => {
    const ddl = SCHEMA_SQL.find((s) => s.includes('CREATE TABLE IF NOT EXISTS items'));
    expect(ddl).toContain('author_id');
    expect(ddl).toContain('author_sig');
    expect(ddl).toContain('tags_json');
    expect(ddl).toContain('like_count');
    expect(ddl).toContain('conflicted');
  });

  it('存量库：缺列时幂等补齐五列', async () => {
    const db = new ColumnsDb(['item_id', 'source', 'type', 'title', 'rev', 'content_hash', 'state', 'updated_at']);
    await ensureItemsColumns(db);
    expect(db.alters).toEqual([
      `ALTER TABLE items ADD COLUMN author_id TEXT NOT NULL DEFAULT ''`,
      `ALTER TABLE items ADD COLUMN author_sig TEXT NOT NULL DEFAULT ''`,
      `ALTER TABLE items ADD COLUMN tags_json TEXT NOT NULL DEFAULT '[]'`,
      `ALTER TABLE items ADD COLUMN like_count INTEGER NOT NULL DEFAULT 0`,
      `ALTER TABLE items ADD COLUMN conflicted INTEGER NOT NULL DEFAULT 0`,
    ]);
  });

  it('已补过：不重复 ALTER', async () => {
    const db = new ColumnsDb(['item_id', 'author_id', 'author_sig', 'tags_json', 'like_count', 'conflicted']);
    await ensureItemsColumns(db);
    expect(db.alters).toEqual([]);
  });

  it('表还不存在：跳过，等建表语句建全', async () => {
    const db = new ColumnsDb([]);
    await ensureItemsColumns(db);
    expect(db.alters).toEqual([]);
  });
});

// ---------- mesh 一期（#82）：nodes 锚点 + gossip 收件（仓储语义用 MemoryRepo 断言，
// 手法与 progress-repo.test.ts 一致；SQL↔DDL 一致性由 schema-check.test.ts 守卫） ----------

function nodeRow(over: Partial<NodeRow> = {}): NodeRow {
  return {
    nodeId: 'n'.repeat(32),
    url: 'https://node.example.com',
    tlsFingerprint: 'aa'.repeat(32),
    signPubkey: 'bb'.repeat(32),
    authorityOrder: 2147483647,
    lastSeenAt: '',
    ...over,
  };
}

function gossipRow(over: Partial<GossipRow> = {}): GossipRow {
  return {
    eventId: 'e'.repeat(16),
    type: 'comment.v1',
    targetId: 'article/a',
    actor: 'a'.repeat(32),
    createdAt: 1_000_000_000,
    receivedAt: 1_000_000_000,
    payloadCid: 'c'.repeat(32),
    payloadPath: '/work/gossip/x',
    sig: 's'.repeat(128),
    relayed: 0,
    ...over,
  };
}

const DAY_MS = 24 * 3600 * 1000;

describe('nodes 锚点仓储（#82 spec §1.2 双锚 / §2.2 权威序）', () => {
  it('首落：TOFU 全字段写入，缺省序位 2147483647；listNodesByOrder 按 authority_order ASC', async () => {
    const repo = new MemoryRepo();
    await repo.upsertNode(nodeRow({ nodeId: 'n-b', authorityOrder: 2147483647 }));
    await repo.upsertNode(nodeRow({ nodeId: 'n-a', authorityOrder: 1 }));
    await repo.upsertNode(nodeRow({ nodeId: 'n-c' }));
    expect(await repo.getNode('n-a')).toEqual(nodeRow({ nodeId: 'n-a', authorityOrder: 1 }));
    expect(await repo.getNode('nope')).toBeNull();
    expect((await repo.listNodesByOrder()).map((n) => n.nodeId)).toEqual(['n-a', 'n-b', 'n-c']);
  });

  it('更新：keepAuthorityOrder=true 不覆盖已配序位，其余字段照常刷新', async () => {
    const repo = new MemoryRepo();
    await repo.upsertNode(nodeRow({ nodeId: 'n1', authorityOrder: 1, url: 'https://old.example.com', lastSeenAt: '2026-10-01T00:00:00Z' }));
    await repo.upsertNode(
      nodeRow({ nodeId: 'n1', authorityOrder: 2147483647, url: 'https://new.example.com', lastSeenAt: '2026-10-17T00:00:00Z' }),
      { keepAuthorityOrder: true },
    );
    expect(await repo.getNode('n1')).toEqual(
      nodeRow({ nodeId: 'n1', authorityOrder: 1, url: 'https://new.example.com', lastSeenAt: '2026-10-17T00:00:00Z' }),
    );
  });

  it('更新：不带 opts 时 authority_order 被覆盖', async () => {
    const repo = new MemoryRepo();
    await repo.upsertNode(nodeRow({ nodeId: 'n1', authorityOrder: 1 }));
    await repo.upsertNode(nodeRow({ nodeId: 'n1', authorityOrder: 5 }));
    expect((await repo.getNode('n1'))!.authorityOrder).toBe(5);
  });

  it('touchNode：只动 last_seen_at', async () => {
    const repo = new MemoryRepo();
    await repo.upsertNode(nodeRow({ nodeId: 'n1', authorityOrder: 1, lastSeenAt: '' }));
    await repo.touchNode('n1', '2026-10-17T08:00:00Z');
    expect(await repo.getNode('n1')).toEqual(nodeRow({ nodeId: 'n1', authorityOrder: 1, lastSeenAt: '2026-10-17T08:00:00Z' }));
  });
});

describe('gossip 收件仓储（#82 spec §4.2）', () => {
  it('insertGossipEvent：同 event_id 两次，第二次 false（先到先得），首收行不被改写', async () => {
    const repo = new MemoryRepo();
    expect(await repo.insertGossipEvent(gossipRow({ eventId: 'e1', relayed: 0 }))).toBe(true);
    expect(await repo.insertGossipEvent(gossipRow({ eventId: 'e1', relayed: 1, payloadPath: '/other' }))).toBe(false);
    expect(await repo.countGossip()).toBe(1);
    const row = (await repo.listGossipSince(0, '', 10))[0]!;
    expect(row).toMatchObject({ eventId: 'e1', relayed: 0, payloadPath: '/work/gossip/x' });
  });

  it('listGossipSince：游标 (received_at, event_id) 双键序翻页不重不漏', async () => {
    const repo = new MemoryRepo();
    // 同 received_at 内乱序插入，靠 event_id 决序
    const rows = [
      gossipRow({ eventId: 'e05', receivedAt: 100 }),
      gossipRow({ eventId: 'e01', receivedAt: 100 }),
      gossipRow({ eventId: 'e09', receivedAt: 100 }),
      gossipRow({ eventId: 'e03', receivedAt: 200 }),
      gossipRow({ eventId: 'e07', receivedAt: 200 }),
      gossipRow({ eventId: 'e02', receivedAt: 300 }),
      gossipRow({ eventId: 'e08', receivedAt: 300 }),
    ];
    for (const r of rows) await repo.insertGossipEvent(r);
    const expected = ['e01', 'e05', 'e09', 'e03', 'e07', 'e02', 'e08'];

    // 从头游标 (0, '') 起，limit=3 翻页
    const seen: string[] = [];
    let cursor: { at: number; id: string } = { at: 0, id: '' };
    for (;;) {
      const page = await repo.listGossipSince(cursor.at, cursor.id, 3);
      if (page.length === 0) break;
      for (const r of page) {
        // 严格大于游标（双键序），不重不漏的前提
        expect(r.receivedAt > cursor.at || (r.receivedAt === cursor.at && r.eventId > cursor.id)).toBe(true);
        seen.push(r.eventId);
      }
      const last = page[page.length - 1]!;
      cursor = { at: last.receivedAt, id: last.eventId };
    }
    expect(seen).toEqual(expected);
  });

  it('evictGossip：600 条收敛 500，驱逐的是最旧一批', async () => {
    const repo = new MemoryRepo();
    const base = 1_000_000_000;
    for (let i = 0; i < 600; i++) {
      await repo.insertGossipEvent(gossipRow({ eventId: String(i).padStart(16, '0'), receivedAt: base + i }));
    }
    const evicted = await repo.evictGossip(500, 7 * DAY_MS, base + 600);
    expect(evicted).toBe(100);
    expect(await repo.countGossip()).toBe(500);
    // 剩余全是最新 500 条（i ∈ [100, 599]）
    const rest = await repo.listGossipSince(0, '', 1000);
    expect(rest).toHaveLength(500);
    expect(rest[0]!.eventId).toBe(String(100).padStart(16, '0'));
    expect(rest[499]!.eventId).toBe(String(599).padStart(16, '0'));
  });

  it('evictGossip：旧于 7 天被逐（未触 maxRows 也逐）', async () => {
    const repo = new MemoryRepo();
    const now = 1_700_000_000_000;
    await repo.insertGossipEvent(gossipRow({ eventId: 'old', receivedAt: now - 8 * DAY_MS }));
    await repo.insertGossipEvent(gossipRow({ eventId: 'fresh1', receivedAt: now - 1 * DAY_MS }));
    await repo.insertGossipEvent(gossipRow({ eventId: 'fresh2', receivedAt: now }));
    const evicted = await repo.evictGossip(500, 7 * DAY_MS, now);
    expect(evicted).toBe(1);
    expect(await repo.countGossip()).toBe(2);
    const rest = await repo.listGossipSince(0, '', 10);
    expect(rest.map((r) => r.eventId)).toEqual(['fresh1', 'fresh2']);
  });

  it('markGossipRelayed：relayed=1；重复收到不重置标记', async () => {
    const repo = new MemoryRepo();
    await repo.insertGossipEvent(gossipRow({ eventId: 'e1' }));
    await repo.markGossipRelayed('e1');
    expect((await repo.listGossipSince(0, '', 10))[0]!.relayed).toBe(1);
    // 节点已收过代报后，同 event_id 重放不覆盖首收行（先到先得）
    await repo.insertGossipEvent(gossipRow({ eventId: 'e1', relayed: 0 }));
    expect((await repo.listGossipSince(0, '', 10))[0]!.relayed).toBe(1);
  });

  it('markItemConflicted：置位冲突条目（Task 4 catalog 合并用）', async () => {
    const repo = new MemoryRepo();
    await repo.upsertLocalContainer(
      { itemId: 'article/a', type: 'article', title: 't', contentHash: 'h1', updatedAt: '2026-10-17T00:00:00Z' },
      [],
    );
    await repo.markItemConflicted('article/a');
    expect(repo.conflictedItems.has('article/a')).toBe(true);
  });
});
