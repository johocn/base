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
  listComments,
  postComment,
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

    // 登记时断网
    const off = fixture();
    off.o.adapters.http = {
      get: () => Promise.reject(new Error('断网')),
      post: () => Promise.reject(new Error('断网')),
    };
    const netErr = (await postComment(off.o, { targetId: 'article/a', text: 'x' }).catch((e: unknown) => e)) as CommentError;
    expect(netErr.code).toBe('network');
    expect(netErr.message).toBe('无法连接节点，请稍后重试');

    // 列表断网
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