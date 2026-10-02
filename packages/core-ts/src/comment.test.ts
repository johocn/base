import { describe, expect, it } from 'vitest';

import {
  canonicalize,
  deriveIdentityId,
  requestSignBytes,
  sha256Hex,
  utf8,
  verify,
  type Json,
  type RequestMeta,
} from '@base/protocol-ts';

import { FakeHttp, FakePackReader, MemoryFs, MemoryRepo, fakeAdapters } from './fakes';
import {
  IDENTITY_REGISTERED_KEY,
  CommentError,
  ensureRegistered,
  fetchCommentText,
  flushPending,
  listComments,
  postComment,
  sendComment,
  setPendingTarget,
  takePendingTarget,
  type CommentOptions,
} from './comment';
import { decodeUtf8 } from './sync';

const BASE = 'https://node.test';

function json(v: unknown) {
  return { status: 200, body: utf8(JSON.stringify(v)) };
}

function fixture() {
  const http = new FakeHttp();
  const repo = new MemoryRepo();
  const adapters = fakeAdapters(http, new MemoryFs(), new FakePackReader());
  const o: CommentOptions = { adapters, repo, nodeBaseUrl: BASE };
  return { http, repo, o };
}

/**
 * 可开关的「网络不可达」模拟：只让 `POST /v1/event` 抛错，其余请求照常走路由。
 * `offline=true` 时失败尝试也会记进 `posted`，便于断言「只试了一条」（用例 7）。
 */
function gatePost(http: FakeHttp): { offline: boolean } {
  const real = http.post.bind(http);
  const state = { offline: true };
  http.post = async (url, body, headers) => {
    if (state.offline && url.endsWith('/v1/event')) {
      http.posted.push({ url, body, headers: headers ?? {} });
      throw new Error('断网');
    }
    return real(url, body, headers);
  };
  return state;
}

/** 从登记请求体里取出节点侧记录的公钥（供本地验签断言）。 */
function registeredPub(http: FakeHttp): string {
  const reg = http.posted.find((p) => p.url.endsWith('/v1/identity/register'));
  if (!reg) throw new Error('未发出登记请求');
  return (JSON.parse(decodeUtf8(reg.body)) as { pubkey: string }).pubkey;
}

describe('comment', () => {
  it('首次发表：先补登记，再带 5 个签名头与内容签名提交', async () => {
    const { http, repo, o } = fixture();
    http.postRoutes.set(`${BASE}/v1/identity/register`, json({ id: 'ignored', alg: 'ed25519', registered: true }));
    http.postRoutes.set(`${BASE}/v1/event`, json({ payload_cid: 'deadbeef' }));

    const res = await postComment(o, { targetId: 'article/hello', text: '中文正文' });

    expect(http.posted.map((p) => p.url)).toEqual([`${BASE}/v1/identity/register`, `${BASE}/v1/event`]);
    const pub = registeredPub(http);
    expect(deriveIdentityId(pub)).toBe(
      (JSON.parse(decodeUtf8(http.posted[0]!.body)) as { id: string }).id,
    );

    const wire = http.posted[1]!;
    const sent = JSON.parse(decodeUtf8(wire.body)) as Record<string, Json>;
    expect(res.payloadCid).toBe('deadbeef');
    // 节点没回 event_id 时用客户端自己生成的（客户端本就持有权威 event_id）
    expect(res.eventId).toBe(sent.event_id as string);
    expect(String(sent.event_id)).toHaveLength(32);

    // 准入：请求签名头可被节点按同一字节重建验证
    const h = wire.headers;
    const meta: RequestMeta = {
      method: 'POST',
      path: '/v1/event',
      query: '',
      bodySha256: sha256Hex(wire.body),
      ts: Number(h['X-Base-Ts']),
      nonce: h['X-Base-Nonce']!,
    };
    expect(h['X-Base-Alg']).toBe('ed25519');
    expect(h['X-Base-Method']).toBeUndefined();
    expect(verify(pub, requestSignBytes(meta), h['X-Base-Sig']!)).toBe(true);

    // 归属：内容签名覆盖 canonical({event_id,type,created_at,body})，与请求头无关
    const canon = canonicalize({
      event_id: sent.event_id!,
      type: sent.type!,
      created_at: sent.created_at!,
      body: sent.body!,
    });
    expect(verify(pub, utf8(canon), sent.sig as string)).toBe(true);

    expect(sent.type).toBe('comment.v1');
    expect((sent.body as Record<string, Json>).target_id).toBe('article/hello');
    expect(await repo.getConfig(IDENTITY_REGISTERED_KEY)).toBe('1');
  });

  it('reply_to 只在提供时入签：缺 reply_to 的事件体里没有该键', async () => {
    const { http, o } = fixture();
    http.postRoutes.set(`${BASE}/v1/identity/register`, json({}));
    http.postRoutes.set(`${BASE}/v1/event`, json({}));

    await postComment(o, { targetId: 'article/a', text: '甲' });
    let sent = JSON.parse(decodeUtf8(http.posted[1]!.body)) as Record<string, Json>;
    expect(sent.body).toEqual({ target_id: 'article/a', text: '甲' });

    await postComment(o, { targetId: 'article/a', text: '乙', replyTo: 'a'.repeat(32) });
    sent = JSON.parse(decodeUtf8(http.posted[2]!.body)) as Record<string, Json>;
    expect((sent.body as Record<string, Json>).reply_to).toBe('a'.repeat(32));
  });

  it('已登记标记存在时不再重复登记', async () => {
    const { http, o } = fixture();
    http.postRoutes.set(`${BASE}/v1/identity/register`, json({}));
    http.postRoutes.set(`${BASE}/v1/event`, json({}));

    await postComment(o, { targetId: 'article/a', text: '一条' });
    await postComment(o, { targetId: 'article/a', text: '两条' });
    await ensureRegistered(o);

    expect(http.posted.filter((p) => p.url.endsWith('/v1/identity/register'))).toHaveLength(1);
    expect(http.posted).toHaveLength(3);
  });

  it('列表：游标原样回传、中文正文正确解码、缺字段留空', async () => {
    const { http, o } = fixture();
    http.routes.set(
      `${BASE}/v1/comment?target_id=article/hello`,
      json({
        comments: [
          {
            event_id: 'e1'.repeat(16),
            actor: 'actor-1',
            target_id: 'article/hello',
            payload_cid: 'c1'.repeat(16),
            reply_to: 'e0'.repeat(16),
            created_at: 1790000000000,
          },
          { event_id: 'e2'.repeat(16) },
        ],
        next_cursor: '1790000000000_e1',
      }),
    );

    const page = await listComments(o, { targetId: 'article/hello' });
    expect(page.nextCursor).toBe('1790000000000_e1');
    expect(page.items).toHaveLength(2);
    expect(page.items[0]).toEqual({
      eventId: 'e1'.repeat(16),
      actor: 'actor-1',
      targetId: 'article/hello',
      payloadCid: 'c1'.repeat(16),
      replyTo: 'e0'.repeat(16),
      createdAt: 1790000000000,
    });
    expect(page.items[1]!.replyTo).toBeNull();
    expect(page.items[1]!.actor).toBe('');

    // 全站读：不带 target_id，next_cursor 为 null
    http.routes.set(`${BASE}/v1/comment`, json({ comments: [] }));
    expect(await listComments(o)).toEqual({ items: [], nextCursor: null });

    // 游标续取：查询串里带上 cursor
    http.routes.set(`${BASE}/v1/comment?cursor=1790000000000_e1`, json({ comments: [] }));
    expect(await listComments(o, { cursor: '1790000000000_e1' })).toEqual({ items: [], nextCursor: null });
  });

  it('取正文：成功解码中文；块不存在或网络失败一律降级为 null', async () => {
    const { http, o } = fixture();
    http.routes.set(`${BASE}/v1/blob/c1`, { status: 200, body: utf8('正文里的中文') });
    expect(await fetchCommentText(o, 'c1')).toBe('正文里的中文');

    expect(await fetchCommentText(o, 'missing')).toBeNull();

    const broken = fixture();
    broken.o.adapters.http = {
      get: () => Promise.reject(new Error('断网')),
      post: () => Promise.reject(new Error('断网')),
    };
    expect(await fetchCommentText(broken.o, 'c1')).toBeNull();
  });

  it('失败映射：节点错误码与网络异常都转成用户可读提示', async () => {
    const cases: Array<[number, string, string, string]> = [
      [403, 'identity_unregistered', 'unregistered', '身份未就绪，请重试'],
      [429, 'event_rate_limited', 'rate_limited', '发言过于频繁'],
      [400, 'event_revoked', 'revoked', '该评论已被处理'],
      [403, 'event_sig_invalid', 'rejected', '提交被拒绝'],
      [400, 'event_param_invalid', 'rejected', '提交被拒绝'],
    ];
    for (const [status, code, wantCode, wantMsg] of cases) {
      const { http, o } = fixture();
      http.postRoutes.set(`${BASE}/v1/identity/register`, json({}));
      http.postRoutes.set(`${BASE}/v1/event`, { status, body: utf8(JSON.stringify({ code })) });
      const err = await postComment(o, { targetId: 'article/a', text: 'x' }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(CommentError);
      expect((err as CommentError).code).toBe(wantCode);
      expect((err as CommentError).message).toBe(wantMsg);
    }

    // 无 code 的 5xx 归到 server
    const srv = fixture();
    srv.http.postRoutes.set(`${BASE}/v1/identity/register`, json({}));
    srv.http.postRoutes.set(`${BASE}/v1/event`, { status: 500, body: utf8('boom') });
    const err = (await postComment(srv.o, { targetId: 'article/a', text: 'x' }).catch((e: unknown) => e)) as CommentError;
    expect(err.code).toBe('server');
    expect(err.message).toBe('提交失败（HTTP 500）');

    // 登记时断网：不再抛错，改为离线入队（本册 §4.2）
    const off = fixture();
    off.o.adapters.http = {
      get: () => Promise.reject(new Error('断网')),
      post: () => Promise.reject(new Error('断网')),
    };
    const offRes = await postComment(off.o, { targetId: 'article/a', text: 'x' });
    expect(offRes.queued).toBe(true);
    expect(offRes.payloadCid).toBeNull();
    expect(await off.repo.listCommentOut()).toHaveLength(1);

    // 列表断网仍抛 CommentError（读取没有离线兜底）
    const listErr = (await listComments(off.o).catch((e: unknown) => e)) as CommentError;
    expect(listErr.code).toBe('network');
  });

  it('锚定态：set 后 take 拿到一次，随即清空', () => {
    expect(takePendingTarget()).toBeNull();
    setPendingTarget('article/hello');
    expect(takePendingTarget()).toBe('article/hello');
    expect(takePendingTarget()).toBeNull();
  });
});

describe('离线发表入队', () => {
  it('用例 1：离线发表入队，字段与入参一致', async () => {
    const { http, repo, o } = fixture();
    http.postRoutes.set(`${BASE}/v1/identity/register`, json({}));
    const gate = gatePost(http);
    gate.offline = true;

    const res = await postComment(o, { targetId: 'article/a', text: '离线写的', replyTo: 'a'.repeat(32) });

    expect(res.queued).toBe(true);
    expect(res.payloadCid).toBeNull();
    const rows = await repo.listCommentOut();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.targetId).toBe('article/a');
    expect(rows[0]!.text).toBe('离线写的');
    expect(rows[0]!.replyTo).toBe('a'.repeat(32));
    expect(rows[0]!.state).toBe('pending');
    expect(rows[0]!.reason).toBeNull();
    expect(rows[0]!.eventId).toHaveLength(32);
    // wire 是已签名的完整请求体：内容签名与 event_id 都在里面
    expect(rows[0]!.wire).toContain('"type":"comment.v1"');
    expect(rows[0]!.wire).toContain('"sig"');
    expect(JSON.parse(rows[0]!.wire).event_id).toBe(rows[0]!.eventId);
  });

  it('用例 2：在线发表不入队', async () => {
    const { http, repo, o } = fixture();
    http.postRoutes.set(`${BASE}/v1/identity/register`, json({}));
    http.postRoutes.set(`${BASE}/v1/event`, json({ payload_cid: 'cid1' }));
    const gate = gatePost(http);
    gate.offline = false;

    const res = await postComment(o, { targetId: 'article/a', text: '在线的' });

    expect(res.queued).toBe(false);
    expect(res.payloadCid).toBe('cid1');
    expect(await repo.listCommentOut()).toEqual([]);
  });

  it('用例 3：节点明确拒绝不入队（原文留给页面原地重试）', async () => {
    const { http, repo, o } = fixture();
    http.postRoutes.set(`${BASE}/v1/identity/register`, json({}));
    http.postRoutes.set(`${BASE}/v1/event`, { status: 500, body: utf8('boom') });
    const gate = gatePost(http);
    gate.offline = false;

    const err = (await postComment(o, { targetId: 'article/a', text: 'x' }).catch((e: unknown) => e)) as CommentError;

    expect(err).toBeInstanceOf(CommentError);
    expect(err.code).toBe('server');
    expect(await repo.listCommentOut()).toEqual([]);
  });

  it('用例 4：未配置节点不入队', async () => {
    const { repo, o } = fixture();
    const err = (await postComment({ ...o, nodeBaseUrl: '' }, { targetId: 'article/a', text: 'x' }).catch(
      (e: unknown) => e,
    )) as CommentError;

    expect(err).toBeInstanceOf(CommentError);
    expect(err.code).toBe('client');
    expect(await repo.listCommentOut()).toEqual([]);
  });

  it('sendComment 是纯发送：断网抛 network，绝不入队（探针与补发共用它）', async () => {
    const { http, repo, o } = fixture();
    http.postRoutes.set(`${BASE}/v1/identity/register`, json({}));
    const gate = gatePost(http);
    gate.offline = true;

    const err = (await sendComment(o, { targetId: 'article/a', text: 'x' }).catch((e: unknown) => e)) as CommentError;

    expect(err).toBeInstanceOf(CommentError);
    expect(err.code).toBe('network');
    expect(err.message).toBe('无法连接节点，请稍后重试');
    expect(await repo.listCommentOut()).toEqual([]);
  });
});

describe('flushPending', () => {
  it('用例 5：补发成功且逐字节重放入队时的 wire（sig 未被重算）', async () => {
    const { http, repo, o } = fixture();
    http.postRoutes.set(`${BASE}/v1/identity/register`, json({}));
    http.postRoutes.set(`${BASE}/v1/event`, json({ payload_cid: 'cid' }));
    const gate = gatePost(http);
    gate.offline = true;
    await postComment(o, { targetId: 'article/a', text: '甲' });
    await postComment(o, { targetId: 'article/a', text: '乙', replyTo: 'b'.repeat(32) });
    const rows = await repo.listCommentOut();
    expect(rows).toHaveLength(2);

    gate.offline = false;
    http.posted.length = 0;
    const r = await flushPending(o);

    expect(r).toEqual({ sent: 2, failed: 0, remaining: 0, error: '' });
    expect(await repo.listCommentOut()).toEqual([]);
    const bodies = http.posted.filter((p) => p.url.endsWith('/v1/event')).map((p) => decodeUtf8(p.body));
    expect(bodies).toEqual(rows.map((x) => x.wire));
  });

  it('用例 6：补发永久失败标 failed、原文仍在、且不抛错', async () => {
    const { http, repo, o } = fixture();
    http.postRoutes.set(`${BASE}/v1/identity/register`, json({}));
    http.postRoutes.set(`${BASE}/v1/event`, json({}));
    const gate = gatePost(http);
    gate.offline = true;
    await postComment(o, { targetId: 'article/a', text: '会被拒的' });

    gate.offline = false;
    http.postRoutes.set(`${BASE}/v1/event`, { status: 403, body: utf8(JSON.stringify({ code: 'event_sig_invalid' })) });
    const r = await flushPending(o);

    expect(r).toEqual({ sent: 0, failed: 1, remaining: 0, error: '' });
    const rows = await repo.listCommentOut();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.state).toBe('failed');
    expect(rows[0]!.reason).toContain('提交被拒绝');
    expect(rows[0]!.text).toBe('会被拒的');
  });

  it('用例 7：补发暂时失败即中止本轮（不空跑后续条目）', async () => {
    const { http, repo, o } = fixture();
    http.postRoutes.set(`${BASE}/v1/identity/register`, json({}));
    http.postRoutes.set(`${BASE}/v1/event`, json({}));
    const gate = gatePost(http);
    gate.offline = true;
    await postComment(o, { targetId: 'article/a', text: '一' });
    await postComment(o, { targetId: 'article/a', text: '二' });
    await postComment(o, { targetId: 'article/a', text: '三' });

    http.posted.length = 0; // gate.offline 仍为 true
    const r = await flushPending(o);

    expect(r.sent).toBe(0);
    expect(r.error).toBe('无法连接节点，请稍后重试');
    const rows = await repo.listCommentOut();
    expect(rows).toHaveLength(3);
    expect(rows.every((x) => x.state === 'pending')).toBe(true);
    expect(http.posted.filter((p) => p.url.endsWith('/v1/event'))).toHaveLength(1);
  });

  it('用例 8：并发调用只跑一轮（不重复发送）', async () => {
    const { http, repo, o } = fixture();
    http.postRoutes.set(`${BASE}/v1/identity/register`, json({}));
    http.postRoutes.set(`${BASE}/v1/event`, json({}));
    const gate = gatePost(http);
    gate.offline = true;
    await postComment(o, { targetId: 'article/a', text: '一' });
    await postComment(o, { targetId: 'article/a', text: '二' });

    gate.offline = false;
    http.posted.length = 0;
    await Promise.all([flushPending(o), flushPending(o)]);

    expect(http.posted.filter((p) => p.url.endsWith('/v1/event'))).toHaveLength(2);
    expect(await repo.listCommentOut()).toEqual([]);
  });

  it('用例 9：listCommentOut 按入队时刻升序；删除一条即少一条', async () => {
    const { repo } = fixture();
    const row = (id: string, at: string) => ({
      eventId: id,
      targetId: 'article/a',
      text: id,
      replyTo: null,
      wire: '{}',
      state: 'pending' as const,
      reason: null,
      queuedAt: at,
    });
    await repo.enqueueComment(row('e2', '2026-09-28T00:00:02.000Z'));
    await repo.enqueueComment(row('e1', '2026-09-28T00:00:01.000Z'));

    expect((await repo.listCommentOut()).map((r) => r.eventId)).toEqual(['e1', 'e2']);
    await repo.removeCommentOut('e1');
    expect((await repo.listCommentOut()).map((r) => r.eventId)).toEqual(['e2']);
  });
});