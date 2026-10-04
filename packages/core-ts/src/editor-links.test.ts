import { describe, expect, it } from 'vitest';

import {
  buildBlobImage,
  buildExternalLink,
  buildItemLink,
  searchLocalBlobs,
  searchLocalItems,
} from './editor-links';

describe('buildItemLink：按 itemId 前缀选 SPA hash 路由', () => {
  const BASE = 'https://base.example.com';

  it('article/* → #/pages/article/detail', () => {
    expect(buildItemLink(BASE, 'article/hello-world', '你好世界')).toBe(
      '[你好世界](https://base.example.com/#/pages/article/detail?itemId=article%2Fhello-world)',
    );
  });

  it('course/* → #/pages/course/detail', () => {
    expect(buildItemLink(BASE, 'course/rust-101', 'Rust 入门')).toBe(
      '[Rust 入门](https://base.example.com/#/pages/course/detail?itemId=course%2Frust-101)',
    );
  });

  it('course/*/lesson/* → #/pages/lesson/detail（最具体的优先匹配）', () => {
    expect(buildItemLink(BASE, 'course/rust-101/lesson/ownership', '所有权')).toBe(
      '[所有权](https://base.example.com/#/pages/lesson/detail?itemId=course%2Frust-101%2Flesson%2Fownership)',
    );
  });

  it('comment/* → #/pages/comment/detail（占位）', () => {
    expect(buildItemLink(BASE, 'comment/abc', '评论')).toContain('#/pages/comment/detail');
  });

  it('group/* → #/pages/group/detail（占位）', () => {
    expect(buildItemLink(BASE, 'group/xyz', '小组')).toContain('#/pages/group/detail');
  });

  it('未知前缀 → #/pages/item/detail（通用路由）', () => {
    expect(buildItemLink(BASE, 'video/my-mp4', '视频')).toContain('#/pages/item/detail');
  });

  it('baseUrl 带尾斜杠会被去掉', () => {
    expect(buildItemLink(BASE + '/', 'article/x', '标题')).toBe(
      '[标题](https://base.example.com/#/pages/article/detail?itemId=article%2Fx)',
    );
  });
});

describe('buildBlobImage', () => {
  it('标准：不带尾斜杠', () => {
    expect(buildBlobImage('https://base.example.com', 'abc123', '示意图')).toBe(
      '![示意图](https://base.example.com/v1/blob/abc123)',
    );
  });

  it('baseUrl 带 1 个尾斜杠自动去掉', () => {
    expect(buildBlobImage('https://base.example.com/', 'abc123', 'alt')).toBe(
      '![alt](https://base.example.com/v1/blob/abc123)',
    );
  });

  it('baseUrl 带多个尾斜杠只去掉一次（replace /\/+$/)', () => {
    expect(buildBlobImage('https://base.example.com//', 'abc', 'x')).toBe(
      '![x](https://base.example.com/v1/blob/abc)',
    );
  });

  it('空 alt 也正常产出', () => {
    expect(buildBlobImage('https://b.io', 'xyz', '')).toBe('![](https://b.io/v1/blob/xyz)');
  });
});

describe('buildExternalLink', () => {
  it('标准：`[text](url)`', () => {
    expect(buildExternalLink('https://example.com', '示例')).toBe('[示例](https://example.com)');
  });

  it('文本与 URL 相同也能产出（允许）', () => {
    expect(buildExternalLink('https://x.com', 'https://x.com')).toBe('[https://x.com](https://x.com)');
  });
});

/** 测试 FakeDb：记录收到的 SQL + params，按预设响应返回。 */
class FakeDb {
  lastSql = '';
  lastParams: unknown[] | undefined = undefined;
  responses = new Map<string, any[]>();
  /** 用 sql 片段匹配预设响应；找不到返回 [] */
  setResponse(needle: string, rows: any[]) {
    this.responses.set(needle, rows);
  }
  async select(sql: string, params?: unknown[]): Promise<any[]> {
    this.lastSql = sql;
    this.lastParams = params;
    for (const [needle, rows] of this.responses) {
      if (sql.includes(needle)) return rows;
    }
    return [];
  }
}

describe('searchLocalItems：FakeDb 验证 SQL 和返回映射', () => {
  it('标题模糊匹配 + 列名映射（type→kind, author_id→ownerId）', async () => {
    const db = new FakeDb();
    db.setResponse('FROM items', [
      { item_id: 'course/rust', title: 'Rust 入门', type: 'course', author_id: 'alice' },
      { item_id: 'article/hi', title: '你好 Rust', type: 'article', author_id: 'bob' },
    ]);

    const rows = await searchLocalItems({ db, query: 'rust', limit: 10 });
    expect(db.lastSql).toContain('FROM items');
    expect(db.lastSql).toContain('title LIKE ?');
    expect(db.lastParams).toEqual(['%rust%', 10]);

    expect(rows).toEqual([
      { itemId: 'course/rust', title: 'Rust 入门', kind: 'course', ownerId: 'alice' },
      { itemId: 'article/hi', title: '你好 Rust', kind: 'article', ownerId: 'bob' },
    ]);
  });

  it('limit 默认 20，空查询也能跑', async () => {
    const db = new FakeDb();
    db.setResponse('FROM items', []);
    await searchLocalItems({ db, query: '' });
    expect(db.lastParams?.[1]).toBe(20);
  });

  it('返回空数组不报错', async () => {
    const db = new FakeDb();
    db.setResponse('FROM items', []);
    const rows = await searchLocalItems({ db, query: 'nope' });
    expect(rows).toEqual([]);
  });
});

describe('searchLocalBlobs：最小实现（适配现有 blob_index DDL）', () => {
  it('有关键词 → WHERE item_id LIKE + ORDER BY verified_at DESC', async () => {
    const db = new FakeDb();
    db.setResponse('WHERE item_id LIKE', [
      { blob_id: 'b1', item_id: 'course/rust/lesson/l1/cover', size: 1024, verified_at: '2026-10-01' },
      { blob_id: 'b2', item_id: 'course/rust/lesson/l2/cover', size: 2048, verified_at: '2026-10-02' },
    ]);

    const rows = await searchLocalBlobs({
      db,
      ownerIdentityId: 'alice',
      query: 'rust',
      limit: 10,
    });
    expect(db.lastSql).toContain('FROM blob_index');
    expect(db.lastSql).toContain('item_id LIKE ?');
    expect(db.lastSql).toContain('ORDER BY verified_at DESC');
    expect(db.lastParams).toEqual(['%rust%', 10]);

    expect(rows.length).toBe(2);
    expect(rows[0]!.blobId).toBe('b1');
    expect(rows[0]!.size).toBe(1024);
    expect(rows[0]!.name).toBe('');
    expect(rows[0]!.contentType).toBe('');
  });

  it('无关键词 → 只 ORDER BY + LIMIT', async () => {
    const db = new FakeDb();
    db.setResponse('ORDER BY verified_at DESC', [
      { blob_id: 'b1', item_id: 'x', size: 100, verified_at: '2026-09-01' },
    ]);
    const rows = await searchLocalBlobs({ db, ownerIdentityId: 'alice' });
    expect(rows).toHaveLength(1);
  });

  it('空关键词字符串也走「无关键词」分支', async () => {
    const db = new FakeDb();
    db.setResponse('ORDER BY verified_at DESC', []);
    await searchLocalBlobs({ db, ownerIdentityId: 'a', query: '  ' });
    // 如果误走了 LIKE 分支，FakeDb 会因为没匹配到 WHERE item_id LIKE 而返回空，
    // 但不会抛错；此处断言 SQL 不含 item_id LIKE。
    expect(db.lastSql).not.toContain('item_id LIKE');
  });

  it('limit 默认 30', async () => {
    const db = new FakeDb();
    db.setResponse('ORDER BY verified_at DESC', []);
    await searchLocalBlobs({ db, ownerIdentityId: 'a' });
    expect(db.lastParams?.[0]).toBe(30);
  });
});
