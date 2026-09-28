import { describe, expect, it } from 'vitest';

import { requestSignBytes, sha256Hex, utf8, verify, type RequestMeta } from '@base/protocol-ts';

import { FakeHttp, FakePackReader, MemoryFs, MemoryRepo, fakeAdapters } from './fakes';
import { createProposal, listProposals, myIdentityId, vote, GovernError, type GovernOptions } from './govern';
import { decodeUtf8 } from './sync';

const BASE = 'https://node.test';

function json(v: unknown) {
  return { status: 200, body: utf8(JSON.stringify(v)) };
}

function fixture() {
  const http = new FakeHttp();
  const repo = new MemoryRepo();
  const o: GovernOptions = { adapters: fakeAdapters(http, new MemoryFs(), new FakePackReader()), repo, nodeBaseUrl: BASE };
  return { http, repo, o };
}

function registeredPub(http: FakeHttp): string {
  const reg = http.posted.find((p) => p.url.endsWith('/v1/identity/register'));
  if (!reg) throw new Error('未发出登记请求');
  return (JSON.parse(decodeUtf8(reg.body)) as { pubkey: string }).pubkey;
}

const ROW = {
  proposal_id: '7',
  action: 'remove',
  item_id: 'article/aaa',
  proposer_id: 'p1',
  reason: '内容不准确',
  title: '',
  body_md: '',
  status: 'pending',
  votes: ['p1'],
  vote_count: 1,
  threshold: 3,
  created_at: 1790000000000,
  executed_at: 0,
  voided_at: 0,
};

describe('govern', () => {
  it('列表：字段逐个映射、votes 数组原样、按 proposal_id 升序返回后做纯展示反转', async () => {
    const { http, o } = fixture();
    http.routes.set(`${BASE}/v1/proposal`, json({ proposals: [{ ...ROW, proposal_id: '1' }, { ...ROW, proposal_id: '2', status: 'void' }] }));
    const items = await listProposals(o);
    expect(items.map((p) => p.proposalId)).toEqual(['2', '1']);
    expect(items[1]).toEqual({
      proposalId: '1', action: 'remove', itemId: 'article/aaa', proposerId: 'p1', reason: '内容不准确',
      title: '', bodyMd: '', status: 'pending', votes: ['p1'], voteCount: 1, threshold: 3,
      createdAt: 1790000000000, executedAt: 0, voidedAt: 0,
    });
    // 空列表返回 []
    http.routes.set(`${BASE}/v1/proposal`, json({ proposals: [] }));
    expect(await listProposals(o)).toEqual([]);
  });

  it('列表：断网 → GovernError(network)，不做离线兜底（本册 §9.1）', async () => {
    const { o } = fixture();
    o.adapters.http = { get: () => Promise.reject(new Error('断网')), post: () => Promise.reject(new Error('断网')) };
    const err = (await listProposals(o).catch((e: unknown) => e)) as GovernError;
    expect(err).toBeInstanceOf(GovernError);
    expect(err.code).toBe('network');
    expect(err.message).toBe('需要联网才能查看提案');
  });

  it('发起：请求体只含 action/item_id/reason，签名头可被节点按同一字节重建', async () => {
    const { http, o } = fixture();
    http.postRoutes.set(`${BASE}/v1/identity/register`, json({}));
    http.postRoutes.set(`${BASE}/v1/proposal`, { status: 201, body: utf8(JSON.stringify({ proposal_id: '9' })) });
    const res = await createProposal(o, { action: 'remove', itemId: 'article/aaa', reason: '内容不准确' });
    expect(res.proposalId).toBe('9');

    const wire = http.posted[1]!;
    expect(JSON.parse(decodeUtf8(wire.body))).toEqual({ action: 'remove', item_id: 'article/aaa', reason: '内容不准确' });
    const h = wire.headers;
    const meta: RequestMeta = {
      method: 'POST', path: '/v1/proposal', query: '', bodySha256: sha256Hex(wire.body),
      ts: Number(h['X-Base-Ts']), nonce: h['X-Base-Nonce']!,
    };
    expect(verify(registeredPub(http), requestSignBytes(meta), h['X-Base-Sig']!)).toBe(true);
  });

  it('发起：edit 才带 edit 块；remove / revive 不带', async () => {
    const { http, o } = fixture();
    http.postRoutes.set(`${BASE}/v1/identity/register`, json({}));
    http.postRoutes.set(`${BASE}/v1/proposal`, { status: 201, body: utf8(JSON.stringify({ proposal_id: '1' })) });
    await createProposal(o, { action: 'edit', itemId: 'article/aaa', reason: '改写', edit: { title: '新题', bodyMd: '新正文' } });
    expect(JSON.parse(decodeUtf8(http.posted[1]!.body))).toEqual({
      action: 'edit', item_id: 'article/aaa', reason: '改写', edit: { title: '新题', body_md: '新正文' },
    });
    await createProposal(o, { action: 'revive', itemId: 'article/aaa', reason: '复活' });
    expect(JSON.parse(decodeUtf8(http.posted[2]!.body))).toEqual({ action: 'revive', item_id: 'article/aaa', reason: '复活' });
  });

  it('失败映射：错误码转中文；429 与 5xx 各归其类', async () => {
    const cases: Array<[number, string, string, string]> = [
      [403, 'proposer_not_governor', 'rejected', '不在本节点治理者名册内'],
      [400, 'item_self_owned', 'rejected', '这是你自己的条目，请直接改用投稿'],
      [404, 'item_not_found', 'rejected', '目标条目不存在'],
      [429, 'govern_rate_limited', 'rate_limited', '操作过于频繁，请稍后再试'],
    ];
    for (const [status, code, wantCode, wantMsg] of cases) {
      const { http, o } = fixture();
      http.postRoutes.set(`${BASE}/v1/identity/register`, json({}));
      http.postRoutes.set(`${BASE}/v1/proposal`, { status, body: utf8(JSON.stringify({ code })) });
      const err = (await createProposal(o, { action: 'remove', itemId: 'article/a', reason: 'x' }).catch((e: unknown) => e)) as GovernError;
      expect(err.code).toBe(wantCode);
      expect(err.message).toBe(wantMsg);
    }
  });

  it('投票：POST 到 /v1/proposal/{id}/vote、体为 {}、响应解析；重复投票 409 → 你已投过票', async () => {
    const { http, o } = fixture();
    http.postRoutes.set(`${BASE}/v1/identity/register`, json({}));
    http.postRoutes.set(`${BASE}/v1/proposal/7/vote`, json({ proposal_id: '7', vote_count: 3, threshold: 3, status: 'effective' }));
    const res = await vote(o, '7');
    expect(res).toEqual({ proposalId: '7', voteCount: 3, threshold: 3, status: 'effective' });
    expect(http.posted[1]!.url).toBe(`${BASE}/v1/proposal/7/vote`);
    expect(decodeUtf8(http.posted[1]!.body)).toBe('{}');

    http.postRoutes.set(`${BASE}/v1/proposal/7/vote`, { status: 409, body: utf8(JSON.stringify({ code: 'already_voted' })) });
    const err = (await vote(o, '7').catch((e: unknown) => e)) as GovernError;
    expect(err.code).toBe('rejected');
    expect(err.message).toBe('你已投过票');
  });

  it('myIdentityId：本机无身份返回空串（不生成身份）', async () => {
    const { o } = fixture();
    expect(await myIdentityId(o)).toBe('');
  });
});