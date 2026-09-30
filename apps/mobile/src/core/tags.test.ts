import { describe, expect, it } from 'vitest';

import { utf8 } from '@base/protocol-ts';

import { ensureRegistered } from './comment';
import { FakeHttp, FakePackReader, MemoryFs, MemoryRepo, fakeAdapters } from './fakes';
import {
  TAG_KIND_ORDER,
  canGovern,
  decodeTagPath,
  encodeTagPath,
  encodeTagPathSegment,
  linksOf,
  tagKindOfTarget,
  tagTitle,
  tagsOf,
  untaggedTargets,
  submitTag,
} from './tags';
import type { SubmitOptions } from './submit';
import type { ItemRow, TagLinkRow } from './types';

const BASE = 'https://node.test';
/**
 * 与 `internal/protocol/tag_test.go` 的 `cases` 表**逐行同源**（`raw` = 用例入参、`norm` = 归一化后、
 * `id` = `wantID`）。两边任何一处漂移都会让本册的「同一标签 = 同一 item_id」失效。
 */
const GO_CASES: Array<{ raw: [string, string, string]; norm: [string, string, string]; id: string }> = [
  { raw: ['甲', '第一章', '第一节'], norm: ['甲', '第一章', '第一节'], id: 'tag/甲/第一章/第一节' },
  { raw: ['甲/乙', '第一章', '第一节'], norm: ['甲/乙', '第一章', '第一节'], id: 'tag/甲%2F乙/第一章/第一节' },
  { raw: ['甲\\乙', '第一章', '第一节'], norm: ['甲\\乙', '第一章', '第一节'], id: 'tag/甲%5C乙/第一章/第一节' },
  { raw: ['100%', '第一章', '第一节'], norm: ['100%', '第一章', '第一节'], id: 'tag/100%25/第一章/第一节' },
  { raw: ['  甲  ', ' 第一章 ', '第一节'], norm: ['甲', '第一章', '第一节'], id: 'tag/甲/第一章/第一节' },
];

function json(v: unknown) {
  return { status: 200, body: utf8(JSON.stringify(v)) };
}

function fixture() {
  const http = new FakeHttp();
  const repo = new MemoryRepo();
  const adapters = fakeAdapters(http, new MemoryFs(), new FakePackReader());
  const o: SubmitOptions = { adapters, repo, nodeBaseUrl: BASE };
  return { http, repo, o };
}

function item(itemId: string, type: string, title = itemId): ItemRow {
  return { itemId, source: 'importer', type, title, rev: '1', contentHash: 'h', state: 'active', updatedAt: '' };
}

function link(tagId: string, targetId: string, kind: string): TagLinkRow {
  return { tagId, targetId, kind };
}

describe('标签路径编码（与节点 protocol/tag.go 同口径）', () => {
  it('三段的编码/解码往返，且与 Go 侧期望值逐字一致', () => {
    for (const c of GO_CASES) {
      expect(encodeTagPath(c.raw[0], c.raw[1], c.raw[2])).toBe(c.id);
      expect(decodeTagPath(c.id)).toEqual({ name: c.norm[0], chapter: c.norm[1], section: c.norm[2] });
    }
  });

  it('斜杠、反斜杠、百分号与控制字符都被转义；中文与空格不转义', () => {
    expect(encodeTagPathSegment('a/b')).toBe('a%2Fb');
    expect(encodeTagPathSegment('a\\b')).toBe('a%5Cb');
    expect(encodeTagPathSegment('50%')).toBe('50%25');
    expect(encodeTagPathSegment('甲 乙')).toBe('甲 乙');
    expect(encodeTagPathSegment('a\nb')).toBe('a%0Ab'); // 控制字符用大写十六进制（与 Go 的 %02X 一致）
  });

  it('title = 三段以 ` · ` 连接', () => {
    expect(tagTitle('甲', '第一章', '第一节')).toBe('甲 · 第一章 · 第一节');
  });

  it('decodeTagPath 拒绝非 tag 前缀、段数不符、非十六进制转义，以及重建后不逐字相等的畸形 id', () => {
    expect(decodeTagPath('course/c1')).toBeNull();
    expect(decodeTagPath('tag')).toBeNull();
    expect(decodeTagPath('tag/甲/第一章')).toBeNull();
    expect(decodeTagPath('tag/甲/第一章/第一节/第二节')).toBeNull();
    expect(decodeTagPath('tag//第一章/第一节')).toBeNull();
    expect(decodeTagPath('tag/甲/第一章/%ZZ')).toBeNull();
    // 带空格：段能解出来，但重建值（已 trim）与入参不逐字相等 ⇒ 拒（与 Go 侧同一重建校验）
    expect(decodeTagPath('tag/ 甲 /第一章/第一节')).toBeNull();
  });
});

describe('目标形态判定', () => {
  it('六种合法形态各归其类，其余一律空串', () => {
    const hex32 = '0123456789abcdef0123456789abcdef';
    expect(tagKindOfTarget('course/c1')).toBe('course');
    expect(tagKindOfTarget('article/a1')).toBe('article');
    expect(tagKindOfTarget('course/c1/lesson/l1')).toBe('lesson');
    expect(tagKindOfTarget('course/c1/lesson/l1/article/a1')).toBe('article');
    expect(tagKindOfTarget(`comment/${hex32}`)).toBe('comment');
    expect(tagKindOfTarget('course/c1/lesson/l1/quiz/q1')).toBe('');
    expect(tagKindOfTarget(`dm/${hex32}`)).toBe('');
    expect(tagKindOfTarget('video/v1')).toBe('');
    expect(tagKindOfTarget('group/g1')).toBe('');
    expect(tagKindOfTarget('comment/0123')).toBe('');
    expect(tagKindOfTarget('course/c1/lesson/')).toBe('');
    expect(tagKindOfTarget('tag/甲/章/节')).toBe('');
    expect(tagKindOfTarget('course/')).toBe('');
  });
});

describe('本地反查与待补标签', () => {
  const rows = [
    link('tag/乙/一/一', 'course/c1', 'course'),
    link('tag/甲/一/一', 'course/c1', 'course'),
    link('tag/甲/一/一', 'course/c1/lesson/l1', 'lesson'),
    link('tag/甲/一/一', 'course/c9', 'course'), // 悬空：本地没有 course/c9
  ];

  it('tagsOf 按 target 过滤、按 tag_id 升序', () => {
    // 升序 = 字节序（与节点 `ORDER BY tag_id ASC` / `tag_test.go:TestListTagsOf` 同口径）：`乙`(U+4E59) < `甲`(U+7532)。
    expect(tagsOf(rows, 'course/c1').map((r) => r.tagId)).toEqual(['tag/乙/一/一', 'tag/甲/一/一']);
    expect(tagsOf(rows, 'course/c2')).toEqual([]);
  });

  it('linksOf 按 kind 固定序（course<lesson<article<comment）再按 target_id 升序，并跳过悬空目标', () => {
    const known = new Set(['course/c1', 'course/c1/lesson/l1']);
    const got = linksOf(rows, 'tag/甲/一/一', known);
    expect(got.map((r) => r.targetId)).toEqual(['course/c1', 'course/c1/lesson/l1']);
    expect(TAG_KIND_ORDER.course).toBeLessThan(TAG_KIND_ORDER.lesson);
    expect(TAG_KIND_ORDER.lesson).toBeLessThan(TAG_KIND_ORDER.article);
    expect(TAG_KIND_ORDER.article).toBeLessThan(TAG_KIND_ORDER.comment);
  });

  it('untaggedTargets 只认 ① 类三型（course / lesson / article），quiz 与评论永不进「待补」', () => {
    const items = [
      item('course/c1', 'course'),
      item('course/c1/lesson/l1', 'lesson'),
      item('course/c1/lesson/l1/article/a1', 'article'),
      item('quiz/q1', 'quiz'),
      item('article/a2', 'article'),
    ];
    const only = rows.filter((r) => r.targetId !== 'course/c9');
    // 计划原稿此处写作 ['course/…/a1', 'article/a2']，与计划正文的 `.sort()`（`item_id` 升序）自相矛盾；
    // 照 `canGovern` 用例的附注口径（以实现的解析结果为准），按升序取定。
    expect(untaggedTargets(items, only)).toEqual(['article/a2', 'course/c1/lesson/l1/article/a1']);
  });
});

describe('打标提交（复用 #29 台账）', () => {
  it('联网：直发 200 → 台账 sent，且请求体键序与节点同构', async () => {
    const { http, repo, o } = fixture();
    http.postRoutes.set(`${BASE}/v1/identity/register`, json({}));
    http.postRoutes.set(`${BASE}/v1/submit`, json({ item_id: 'tag/甲/第一章/第一节', created: false }));
    const out = await submitTag(o, { name: '甲', chapter: '第一章', section: '第一节', targetId: 'course/c1' });
    expect(out.ledgerState).toBe('sent');
    const wire = JSON.parse(new TextDecoder().decode(http.posted[1]!.body)) as Record<string, unknown>;
    expect(Object.keys(wire)).toEqual(['type', 'item_id', 'title', 'links', 'author_sig']);
    expect(wire.type).toBe('tag');
    expect(wire.title).toBe('甲 · 第一章 · 第一节');
    expect(wire.links).toEqual([{ target_id: 'course/c1', kind: 'course' }]);
    expect((await repo.getSubmission('tag/甲/第一章/第一节'))?.type).toBe('tag');
  });

  it('三段归一化后为空即拒绝，不发请求', async () => {
    const { http, o } = fixture();
    http.postRoutes.set(`${BASE}/v1/identity/register`, json({}));
    const err = await submitTag(o, { name: '甲', chapter: '', section: '第一节', targetId: 'course/c1' }).catch(
      (e: unknown) => e,
    );
    expect((err as Error).message).toBe('请填写章');
    expect(http.posted).toHaveLength(0);
  });

  it('断网：入队 pending（联网后由既有 flushSubmissions 补发）', async () => {
    const { http, repo, o } = fixture();
    http.postRoutes.set(`${BASE}/v1/identity/register`, json({}));
    const real = http.post.bind(http);
    http.post = async (url, body, headers) => {
      if (url.endsWith('/v1/submit')) throw new Error('断网');
      return real(url, body, headers);
    };
    const out = await submitTag(o, { name: '甲', chapter: '第一章', section: '第一节', targetId: 'course/c1' });
    expect(out.ledgerState).toBe('pending');
    expect((await repo.listSubmissions('pending')).map((r) => r.itemId)).toEqual(['tag/甲/第一章/第一节']);
  });
});

describe('治理人资格（名册 ∪ 各圈治者）', () => {
  it('离线（名册拉不到）⇒ false，按钮不显示', async () => {
    const { o } = fixture();
    expect(await canGovern(o)).toBe(false);
  });

  it('名册内 ⇒ true', async () => {
    const { http, o } = fixture();
    http.postRoutes.set(`${BASE}/v1/identity/register`, json({}));
    const ident = await ensureRegistered(o); // 落本地身份（与 core/submit.test.ts 同一套）
    http.routes.set(`${BASE}/v1/contributors`, json({ contributors: [{ id: ident.id, name: '甲', count: 3 }] }));
    expect(await canGovern(o)).toBe(true);
  });

  it('名册外 ⇒ false（圈拉不到时不影响结论）', async () => {
    const { http, o } = fixture();
    http.postRoutes.set(`${BASE}/v1/identity/register`, json({}));
    await ensureRegistered(o);
    http.routes.set(`${BASE}/v1/contributors`, json({ contributors: [{ id: 'b'.repeat(64), name: '乙', count: 9 }] }));
    expect(await canGovern(o)).toBe(false);
  });

  it('名册外但在某个圈的 governors 里 ⇒ true', async () => {
    const { http, repo, o } = fixture();
    http.postRoutes.set(`${BASE}/v1/identity/register`, json({}));
    const ident = await ensureRegistered(o);
    http.routes.set(`${BASE}/v1/contributors`, json({ contributors: [] }));
    await repo.saveGroup({
      groupId: 'c'.repeat(32), name: '圈', creatorId: ident.id, epoch: 1, encrypted: 0,
      rosterRev: 1, memberIdsJson: JSON.stringify([ident.id]), joinedAt: '2026-09-30T00:00:00Z',
    });
    // 圈页路由照 `core/group.test.ts` 里既有的 `GET /v1/group/{32hex}` fixture 造（字段含 `governors`）
    http.routes.set(`${BASE}/v1/group/${'c'.repeat(32)}`, json({
      group: {
        group_id: 'c'.repeat(32), creator_id: ident.id, epoch: 1, encrypted: 0, roster_rev: 1,
        name: '圈', member_ids: [ident.id], seat_count: 1, governors: [ident.id], envelopes: [],
      },
      events: [],
      next_cursor: null,
    }));
    expect(await canGovern(o)).toBe(true);
  });
});
