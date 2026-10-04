import { describe, expect, it } from 'vitest';
import { extractBlobRefs } from './blob-refs';
import { MemoryRepo } from './fakes';

describe('extractBlobRefs', () => {
  it('标准图片 markdown：单图', () => {
    const ids = extractBlobRefs('hello world\n![alt](https://base/v1/blob/aaaabbbbccccddddeeeeffffaaaabbbb)\n');
    expect(ids).toEqual(['aaaabbbbccccddddeeeeffffaaaabbbb']);
  });

  it('多图 + 去重', () => {
    const md = `
# 标题
![封面](https://a.com/v1/blob/11111111111111111111111111111111)
正文...
![插图](https://b.com/v1/blob/22222222222222222222222222222222)
![封面再引用一次](https://a.com/v1/blob/11111111111111111111111111111111)
`;
    expect(extractBlobRefs(md).sort()).toEqual([
      '11111111111111111111111111111111',
      '22222222222222222222222222222222',
    ]);
  });

  it('无 blob 引用 → 空数组', () => {
    expect(extractBlobRefs('plain text no images')).toEqual([]);
  });

  it('短 hex（< 32）不匹配（不是有效 blob）', () => {
    expect(extractBlobRefs('![x](/v1/blob/abc123)')).toEqual([]);
  });

  it('不同 baseUrl 不影响', () => {
    const md = `
![x](http://node.a/v1/blob/aaaabbbbccccddddeeeeffffaaaabbbb)
![y](https://xxx.yyy:8080/v1/blob/11111111111111111111111111111111)
`;
    expect(extractBlobRefs(md).length).toBe(2);
  });

  it('新格式 blob: 协议引用也能提取（内容寻址）', () => {
    const md = `
# 正文
![封面](blob:aaaabbbbccccddddeeeeffffaaaabbbb)
![插图](blob:11111111111111111111111111111111)
`;
    const ids = extractBlobRefs(md);
    expect(ids.sort()).toEqual([
      '11111111111111111111111111111111',
      'aaaabbbbccccddddeeeeffffaaaabbbb',
    ]);
  });

  it('新旧格式混排 → 去重合并', () => {
    const md = `
![a](blob:aaaabbbbccccddddeeeeffffaaaabbbb)
![b](https://old.node.com/v1/blob/aaaabbbbccccddddeeeeffffaaaabbbb)
`;
    expect(extractBlobRefs(md)).toEqual(['aaaabbbbccccddddeeeeffffaaaabbbb']);
  });
});

describe('blob_references 追踪', () => {
  const repo = new MemoryRepo();
  const BLOB_A = 'a'.repeat(32);
  const BLOB_B = 'b'.repeat(32);

  it('refreshBlobRefs：先 DELETE 旧引用，再 INSERT 新引用', async () => {
    // item1 引用 A + B
    await repo.refreshBlobRefs('item1', [BLOB_A, BLOB_B]);
    expect(await repo.countBlobRefs(BLOB_A)).toBe(1);
    expect(await repo.countBlobRefs(BLOB_B)).toBe(1);

    // item1 改成只引用 A 了
    await repo.refreshBlobRefs('item1', [BLOB_A]);
    expect(await repo.countBlobRefs(BLOB_A)).toBe(1);
    expect(await repo.countBlobRefs(BLOB_B)).toBe(0); // B 的引用被删了
  });

  it('countBlobRefs：多条目引用同一 blob → 计数正确', async () => {
    await repo.refreshBlobRefs('item2', [BLOB_A]);
    await repo.refreshBlobRefs('item3', [BLOB_A]);
    // BLOB_A 被 item1 + item2 + item3 引用
    expect(await repo.countBlobRefs(BLOB_A)).toBe(3);
  });

  it('removeBlob：无引用可以删（count=0 才安全删）', async () => {
    // 删掉 item2/item3 的引用 → BLOB_A 只剩 item1 引用
    await repo.refreshBlobRefs('item2', []);
    await repo.refreshBlobRefs('item3', []);
    expect(await repo.countBlobRefs(BLOB_A)).toBe(1); // 有引用 → UI 应该阻止

    // 清空 item1 的引用
    await repo.refreshBlobRefs('item1', []);
    expect(await repo.countBlobRefs(BLOB_A)).toBe(0); // 无引用 → 可以删
  });
});
