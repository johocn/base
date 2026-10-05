import { utf8 } from '@base/protocol-ts';
import { describe, expect, it } from 'vitest';

import { FakeHttp, FakePackReader, MemoryFs, MemoryRepo, fakeAdapters } from './fakes';
import { pullProgress, reportProgress, type ProgressOptions } from './progress-store';
import { decodeUtf8 } from './sync';

const BASE = 'https://node.test';

function json(v: unknown) {
  return { status: 200, body: utf8(JSON.stringify(v)) };
}

function fixture() {
  const http = new FakeHttp();
  const repo = new MemoryRepo();
  const adapters = fakeAdapters(http, new MemoryFs(), new FakePackReader());
  const o: ProgressOptions = { adapters, repo, nodeBaseUrl: BASE };
  return { http, repo, o };
}

/** 只让 `POST /v1/event` 断网，登记请求照常走路由。 */
function offlineEventPost(http: FakeHttp): void {
  const real = http.post.bind(http);
  http.post = async (url, body, headers) => {
    if (url.endsWith('/v1/event')) throw new Error('断网');
    return real(url, body, headers);
  };
}

function readyRoutes(http: FakeHttp): void {
  http.postRoutes.set(`${BASE}/v1/identity/register`, json({}));
  http.postRoutes.set(`${BASE}/v1/event`, json({ payload_cid: '' }));
}

describe('reportProgress（#8 册子 §5.2 / §5.3 / §5.4）', () => {
  it('上报：先本地双写，再带类型签名投递；updated_at = 胜者事件 created_at', async () => {
    const { http, repo, o } = fixture();
    readyRoutes(http);

    const res = await reportProgress(
      o,
      { itemId: 'article/a', position: 640, done: false, day: '2026-10-01' },
      1000,
    );

    expect(res).toEqual({ reported: true, queued: false });
    expect(http.posted.map((p) => p.url)).toEqual([`${BASE}/v1/identity/register`, `${BASE}/v1/event`]);
    const sent = JSON.parse(decodeUtf8(http.posted[1]!.body)) as {
      type: string;
      body: Record<string, unknown>;
      created_at: number;
    };
    expect(sent.type).toBe('progress.v1');
    expect(sent.body).toEqual({ item_id: 'article/a', position: 640, done: false, day: '2026-10-01' });

    const local = await repo.getProgress('article/a');
    expect(local).toMatchObject({ position: 640, done: false, day: '2026-10-01', dirty: true });
    expect(local!.updatedAt).toBe(sent.created_at);
    expect(local!.eventId).toHaveLength(32);
    expect((await repo.listCheckinDays()).map((d) => d.day)).toEqual(['2026-10-01']);
  });

  it('节流：同一 item_id 不足 5s 丢帧（不写本地也不发），满 5s 再发', async () => {
    const { http, repo, o } = fixture();
    readyRoutes(http);

    await reportProgress(o, { itemId: 'article/b', position: 1, done: false, day: '2026-10-01' }, 1000);
    expect(http.posted).toHaveLength(2);

    const dropped = await reportProgress(o, { itemId: 'article/b', position: 2, done: false, day: '2026-10-01' }, 2000);
    expect(dropped).toEqual({ reported: false, queued: false });
    expect(http.posted).toHaveLength(2);
    expect((await repo.getProgress('article/b'))!.position).toBe(1); // 丢帧不落库

    await reportProgress(o, { itemId: 'article/b', position: 3, done: false, day: '2026-10-01' }, 6000);
    // 身份已在首轮登记（`ensureRegistered` 缓存 `identity.registered`）⇒ 本轮只再发一次事件，共 3 次。
    expect(http.posted).toHaveLength(3);
  });

  it('参数非法：不写本地、不发请求', async () => {
    const { http, repo, o } = fixture();
    readyRoutes(http);

    expect(await reportProgress(o, { itemId: '', position: 1, done: false })).toEqual({ reported: false, queued: false });
    expect(await reportProgress(o, { itemId: 'article/x', position: -1, done: false })).toEqual({ reported: false, queued: false });
    expect(await reportProgress(o, { itemId: 'article/x', position: 1.5, done: false })).toEqual({ reported: false, queued: false });

    expect(http.posted).toHaveLength(0);
    expect(await repo.listProgress()).toEqual([]);
  });

  it('断网：本地已写 + wire 入 comment_out（目标 = item_id，正文留空）', async () => {
    const { http, repo, o } = fixture();
    http.postRoutes.set(`${BASE}/v1/identity/register`, json({}));
    offlineEventPost(http);

    const res = await reportProgress(o, { itemId: 'article/c', position: 30, done: false, day: '2026-10-01' }, 1000);

    expect(res).toEqual({ reported: true, queued: true });
    const q = await repo.listCommentOut();
    expect(q).toHaveLength(1);
    expect(q[0]!.targetId).toBe('article/c');
    expect(q[0]!.text).toBe('');
    expect(q[0]!.state).toBe('pending');
    expect((JSON.parse(q[0]!.wire) as { type: string }).type).toBe('progress.v1');
    expect((await repo.getProgress('article/c'))!.position).toBe(30);
  });

  it('未配置节点：只写本地，不发也不入队（同 postComment 口径）', async () => {
    const { http, repo, o } = fixture();
    o.nodeBaseUrl = '';

    const res = await reportProgress(o, { itemId: 'article/d', position: 5, done: false, day: '2026-10-01' }, 1000);

    expect(res).toEqual({ reported: true, queued: false });
    expect(http.posted).toHaveLength(0);
    expect(await repo.listCommentOut()).toHaveLength(0);
    expect((await repo.getProgress('article/d'))!.position).toBe(5);
  });

  it('节点拒绝（429）：本地已写，静默返回，不入队', async () => {
    const { http, repo, o } = fixture();
    http.postRoutes.set(`${BASE}/v1/identity/register`, json({}));
    http.postRoutes.set(`${BASE}/v1/event`, { status: 429, body: utf8(JSON.stringify({ code: 'event_rate_limited' })) });

    const res = await reportProgress(o, { itemId: 'article/e', position: 7, done: false, day: '2026-10-01' }, 1000);

    expect(res).toEqual({ reported: true, queued: false });
    expect(await repo.listCommentOut()).toHaveLength(0);
    expect((await repo.getProgress('article/e'))!.position).toBe(7);
  });
});

describe('pullProgress（#8 册子 §5.5）', () => {
  it('200：progress 与 checkin_days 按同一比较函数并进本地，写回 dirty=false', async () => {
    const { http, repo, o } = fixture();
    http.postRoutes.set(`${BASE}/v1/identity/register`, json({}));
    http.routes.set(
      `${BASE}/v1/me`,
      json({
        events: [],
        progress: [
          {
            item_id: 'article/a',
            position: 900,
            done: true,
            day: '2026-10-01',
            updated_at: 5000,
            event_id: 'b'.repeat(32),
          },
        ],
        checkin_days: [{ day: '2026-09-30', first_event_id: 'c'.repeat(32), created_at: 4000 }],
      }),
    );

    await pullProgress(o);

    const local = await repo.getProgress('article/a');
    expect(local).toMatchObject({ position: 900, done: true, updatedAt: 5000, dirty: false });
    expect((await repo.listCheckinDays()).map((d) => d.day)).toEqual(['2026-09-30']);
  });

  it('非 200 / 网络抛错 / 未配置节点：一律静默，本地不变', async () => {
    const { http, repo, o } = fixture();
    http.postRoutes.set(`${BASE}/v1/identity/register`, json({}));
    http.routes.set(`${BASE}/v1/me`, { status: 403, body: utf8('{}') });

    await expect(pullProgress(o)).resolves.toBeUndefined();
    expect(await repo.listProgress()).toEqual([]);

    const broken = fixture();
    broken.http.postRoutes.set(`${BASE}/v1/identity/register`, json({}));
    broken.o.adapters.http = {
      get: () => Promise.reject(new Error('断网')),
      post: () => Promise.reject(new Error('断网')),
      put: () => Promise.reject(new Error('断网')),
    };
    await expect(pullProgress(broken.o)).resolves.toBeUndefined();

    const none = fixture();
    none.o.nodeBaseUrl = '';
    await expect(pullProgress(none.o)).resolves.toBeUndefined();
    expect(none.http.posted).toHaveLength(0);
  });
});