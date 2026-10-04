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
  it('协议引用：只含 blob:{hash}，不硬编码节点 URL', () => {
    expect(buildBlobImage('abc123', 'alt')).toBe('![alt](blob:abc123)');
  });

  it('空 alt 也正常产出', () => {
    expect(buildBlobImage('xyz', '')).toBe('![](blob:xyz)');
  });
});

describe('resolveBlobUrl', () => {
  it('blob: 协议 → 当前节点 baseUrl 拼接', () => {
    expect(resolveBlobUrl('https://base.com', 'blob:abc123')).toBe('https://base.com/v1/blob/abc123');
  });
  it('带尾斜杠的 baseUrl 自动去掉', () => {
    expect(resolveBlobUrl('https://base.com/', 'blob:abc')).toBe('https://base.com/v1/blob/abc');
  });
  it('已经是绝对 URL → 直接返回（兼容老数据）', () => {
    expect(resolveBlobUrl('https://new-node.com', 'https://old-node.com/v1/blob/abc')).toBe(
      'https://old-node.com/v1/blob/abc',
    );
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

  it('limit 默认 20，空查询返回最近条目', async () => {
    const db = new FakeDb();
    db.setResponse('FROM items', []);
    await searchLocalItems({ db, query: '' });
    // 空关键词走 ORDER BY updated_at DESC LIMIT ?，只有一个 param
    expect(db.lastSql).toContain('ORDER BY updated_at DESC');
    expect(db.lastParams).toEqual([20]);
  });

  it('非空查询走 title LIKE 分支', async () => {
    const db = new FakeDb();
    db.setResponse('FROM items', []);
    await searchLocalItems({ db, query: 'rust' });
    expect(db.lastSql).toContain('title LIKE ?');
    expect(db.lastParams).toEqual(['%rust%', 20]);
  });

  it('返回空数组不报错', async () => {
    const db = new FakeDb();
    db.setResponse('FROM items', []);
    const rows = await searchLocalItems({ db, query: 'nope' });
    expect(rows).toEqual([]);
  });
});

describe('searchLocalBlobs：按 content_type 过滤图片 + 文件名/条目路径搜索', () => {
  it('有关键词 → original_name LIKE OR item_id LIKE + 图片过滤', async () => {
    const db = new FakeDb();
    db.setResponse('FROM blob_index', [
      { blob_id: 'b1', item_id: 'course/rust/lesson/l1/cover', size: 1024, verified_at: '2026-10-01', original_name: 'cover.png', content_type: 'image/png' },
      { blob_id: 'b2', item_id: 'course/rust/lesson/l2/cover', size: 2048, verified_at: '2026-10-02', original_name: '', content_type: '' },
    ]);

    const rows = await searchLocalBlobs({
      db,
      query: 'rust',
      limit: 10,
    });
    expect(db.lastSql).toContain('FROM blob_index');
    expect(db.lastSql).toContain('(b.content_type LIKE');
    expect(db.lastSql).toContain('(b.original_name LIKE ? OR b.item_id LIKE ? OR b.owner_id LIKE ?)');
    expect(db.lastSql).toContain('ORDER BY b.verified_at DESC');
    expect(db.lastSql).toContain('GROUP BY b.blob_id');
    expect(db.lastSql).toContain('LEFT JOIN blob_references');
    // query 三搜 original_name/item_id/owner_id 各 1 param，最后 limit 共 4
    expect(db.lastParams).toEqual(['%rust%', '%rust%', '%rust%', 10]);

    expect(rows.length).toBe(2);
    expect(rows[0]!.blobId).toBe('b1');
    expect(rows[0]!.name).toBe('cover.png');
    expect(rows[0]!.contentType).toBe('image/png');
    expect(rows[0]!.refs).toBe(0);
  });

  it('无关键词 → 只 ORDER BY + LIMIT + 图片过滤', async () => {
    const db = new FakeDb();
    db.setResponse('FROM blob_index', [
      { blob_id: 'b1', item_id: 'x', size: 100, verified_at: '2026-09-01', original_name: '', content_type: 'image/jpeg' },
    ]);
    const rows = await searchLocalBlobs({ db });
    expect(rows).toHaveLength(1);
    expect(db.lastSql).toContain('ORDER BY b.verified_at DESC');
  });

  it('空关键词字符串也走「无关键词」分支（无 OR LIKE）', async () => {
    const db = new FakeDb();
    db.setResponse('FROM blob_index', []);
    await searchLocalBlobs({ db, query: '  ' });
    expect(db.lastSql).not.toContain('original_name LIKE');
  });

  it('limit 默认 50', async () => {
    const db = new FakeDb();
    db.setResponse('FROM blob_index', []);
    await searchLocalBlobs({ db });
    expect(db.lastParams?.[db.lastParams.length - 1]).toBe(50);
  });

  it("filter='all' 时不加 content_type 条件", async () => {
    const db = new FakeDb();
    db.setResponse('FROM blob_index', []);
    await searchLocalBlobs({ db, filter: 'all' });
    expect(db.lastSql).not.toContain('content_type LIKE');
    expect(db.lastSql).toContain('ORDER BY b.verified_at DESC');
  });
});
