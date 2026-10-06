// 本地库建表/补列的回归守卫：`items.author_id` / `author_sig` 曾经只在读写侧存在，
// 建表语句与补列函数都漏了，导致全新库上 listItems() 一律 `no such column: author_id`
// （评论页内容 chips、myitems / favorite / search 全部拿不到数据），而 SCHEMA_SQL 此前无任何测试引用。
import { describe, expect, it } from 'vitest';

import type { LocalDb } from './platform/adapter';
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
  it('新建库：建表语句自带 author_id / author_sig / tags_json / like_count', () => {
    const ddl = SCHEMA_SQL.find((s) => s.includes('CREATE TABLE IF NOT EXISTS items'));
    expect(ddl).toContain('author_id');
    expect(ddl).toContain('author_sig');
    expect(ddl).toContain('tags_json');
    expect(ddl).toContain('like_count');
  });

  it('存量库：缺列时幂等补齐四列', async () => {
    const db = new ColumnsDb(['item_id', 'source', 'type', 'title', 'rev', 'content_hash', 'state', 'updated_at']);
    await ensureItemsColumns(db);
    expect(db.alters).toEqual([
      `ALTER TABLE items ADD COLUMN author_id TEXT NOT NULL DEFAULT ''`,
      `ALTER TABLE items ADD COLUMN author_sig TEXT NOT NULL DEFAULT ''`,
      `ALTER TABLE items ADD COLUMN tags_json TEXT NOT NULL DEFAULT '[]'`,
      `ALTER TABLE items ADD COLUMN like_count INTEGER NOT NULL DEFAULT 0`,
    ]);
  });

  it('已补过：不重复 ALTER', async () => {
    const db = new ColumnsDb(['item_id', 'author_id', 'author_sig', 'tags_json', 'like_count']);
    await ensureItemsColumns(db);
    expect(db.alters).toEqual([]);
  });

  it('表还不存在：跳过，等建表语句建全', async () => {
    const db = new ColumnsDb([]);
    await ensureItemsColumns(db);
    expect(db.alters).toEqual([]);
  });
});
