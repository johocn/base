import { describe, expect, it } from 'vitest';

import { canonicalize, utf8, verify, type Json } from '@base/protocol-ts';

import { FakeHttp, FakePackReader, MemoryFs, MemoryRepo, fakeAdapters } from './fakes';
import { LikeError, myLike, sendLike, sendReport, type LikeOptions } from './like';
import { decodeUtf8 } from './sync';

const BASE = 'https://node.test';

function json(v: unknown) {
  return { status: 200, body: utf8(JSON.stringify(v)) };
}

function fixture() {
  const http = new FakeHttp();
  const repo = new MemoryRepo();
  const adapters = fakeAdapters(http, new MemoryFs(), new FakePackReader());
  const o: LikeOptions = { adapters, repo, nodeBaseUrl: BASE };
  return { http, repo, o };
}

/** 从登记请求体里取出节点侧记录的公钥（供内容签名回验）。 */
function registeredPub(http: FakeHttp): string {
  const reg = http.posted.find((p) => p.url.endsWith('/v1/identity/register'));
  if (!reg) throw new Error('未发出登记请求');
  return (JSON.parse(decodeUtf8(reg.body)) as { pubkey: string }).pubkey;
}

describe('sendLike / sendReport（wire 构造）', () => {
  it('sendLike：type=like.v1、body 严格两键、内容签名可被节点侧回验', async () => {
    const { http, o } = fixture();
    http.postRoutes.set(`${BASE}/v1/identity/register`, json({}));
    http.postRoutes.set(`${BASE}/v1/event`, json({ event_id: 'srv-e1' }));

    const res = await sendLike(o, 'a'.repeat(16), 'like');

    expect(http.posted.map((p) => p.url)).toEqual([`${BASE}/v1/identity/register`, `${BASE}/v1/event`]);
    const sent = JSON.parse(decodeUtf8(http.posted[1]!.body)) as Record<string, Json>;
    expect(sent.type).toBe('like.v1');
    expect(String(sent.event_id)).toHaveLength(32);
    // body 严格两键：target_id + action，无任何多余键
    expect(Object.keys(sent.body as Record<string, Json>).sort()).toEqual(['action', 'target_id']);
    expect(sent.body).toEqual({ target_id: 'a'.repeat(16), action: 'like' });
    // 内容签名覆盖 canonical({event_id,type,created_at,body})，与请求头无关
    const pub = registeredPub(http);
    const canon = canonicalize({
      event_id: sent.event_id!,
      type: sent.type!,
      created_at: sent.created_at!,
      body: sent.body!,
    });
    expect(verify(pub, utf8(canon), sent.sig as string)).toBe(true);
    // 节点回了 event_id 就用服务端的
    expect(res.eventId).toBe('srv-e1');
  });

  it('sendReport：type=report.v1、body 严格两键（target_id + reason）', async () => {
    const { http, o } = fixture();
    http.postRoutes.set(`${BASE}/v1/identity/register`, json({}));
    http.postRoutes.set(`${BASE}/v1/event`, json({}));

    const res = await sendReport(o, 'b'.repeat(16), 'spam');

    const sent = JSON.parse(decodeUtf8(http.posted[1]!.body)) as Record<string, Json>;
    expect(sent.type).toBe('report.v1');
    expect(sent.body).toEqual({ target_id: 'b'.repeat(16), reason: 'spam' });
    expect(res.eventId).toBe(String(sent.event_id));
  });
});

describe('LikeError 码映射', () => {
  it('节点错误码 → 用户可读提示', async () => {
    const cases: Array<[number, string, string, string]> = [
      [404, 'target_not_found', 'target_missing', '目标不存在或已下架'],
      [410, 'target_gone', 'target_gone', '该内容已被处理'],
      [429, 'event_rate_limited', 'rate_limited', '操作过于频繁，请稍后再试'],
    ];
    for (const [status, code, wantCode, wantMsg] of cases) {
      const { http, o } = fixture();
      http.postRoutes.set(`${BASE}/v1/identity/register`, json({}));
      http.postRoutes.set(`${BASE}/v1/event`, { status, body: utf8(JSON.stringify({ error: code })) });
      const err = await sendLike(o, 'a'.repeat(16), 'like').catch((e: unknown) => e);
      expect(err).toBeInstanceOf(LikeError);
      expect((err as LikeError).code).toBe(wantCode);
      expect((err as LikeError).message).toBe(wantMsg);
    }

    // 无 error 键的 5xx 归到 server
    const srv = fixture();
    srv.http.postRoutes.set(`${BASE}/v1/identity/register`, json({}));
    srv.http.postRoutes.set(`${BASE}/v1/event`, { status: 500, body: utf8('boom') });
    const err = (await sendLike(srv.o, 'a'.repeat(16), 'like').catch((e: unknown) => e)) as LikeError;
    expect(err.code).toBe('server');
    expect(err.message).toBe('提交失败（HTTP 500）');

    // 断网 → network
    const off = fixture();
    off.o.adapters.http = {
      get: () => Promise.reject(new Error('断网')),
      post: () => Promise.reject(new Error('断网')),
      put: () => Promise.reject(new Error('断网')),
    };
    const netErr = (await sendReport(off.o, 'b'.repeat(16), 'other').catch((e: unknown) => e)) as LikeError;
    expect(netErr.code).toBe('network');
    expect(netErr.message).toBe('无法连接节点，请稍后重试');

    // 未配置节点 → client（不发任何请求）
    const cfg = fixture();
    const cliErr = (await sendLike({ ...cfg.o, nodeBaseUrl: '' }, 'a'.repeat(16), 'like').catch((e: unknown) => e)) as LikeError;
    expect(cliErr.code).toBe('client');
    expect(cfg.http.posted).toHaveLength(0);
  });
});

describe('like_out 台账 + 条目计数', () => {
  it('upsertLikeOut 覆盖为最新动作；myLike 跟随台账', async () => {
    const { repo, o } = fixture();
    expect(await repo.getLikeOut('t1')).toBeNull();
    expect(await myLike(o, 't1')).toBe(false);

    await repo.upsertLikeOut('t1', 'like');
    expect(await repo.getLikeOut('t1')).toBe('like');
    expect(await myLike(o, 't1')).toBe(true);

    // 再点一次即取消：同 target 覆盖
    await repo.upsertLikeOut('t1', 'unlike');
    expect(await repo.getLikeOut('t1')).toBe('unlike');
    expect(await myLike(o, 't1')).toBe(false);

    // 各 target 互不干扰
    await repo.upsertLikeOut('t2', 'like');
    expect(await repo.getLikeOut('t1')).toBe('unlike');
    expect(await repo.getLikeOut('t2')).toBe('like');
  });

  it('adjustItemLikeCount：0 再 -1 不越负，正向正常累加', async () => {
    const { repo } = fixture();
    expect(await repo.getItemLikeCount('i1')).toBe(0);

    await repo.adjustItemLikeCount('i1', -1);
    expect(await repo.getItemLikeCount('i1')).toBe(0);

    await repo.adjustItemLikeCount('i1', 3);
    expect(await repo.getItemLikeCount('i1')).toBe(3);

    await repo.adjustItemLikeCount('i1', -1);
    expect(await repo.getItemLikeCount('i1')).toBe(2);
  });
});
