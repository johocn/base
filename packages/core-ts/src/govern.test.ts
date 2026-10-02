import { describe, expect, it } from 'vitest';

import { canonicalize, sha256Hex, utf8, verify, type Json } from '@base/protocol-ts';

import { normalizeTermKey } from './directory';
import { FakeHttp, FakePackReader, MemoryFs, MemoryRepo, fakeAdapters } from './fakes';
import { createProposal, listProposals, myIdentityId, vote, GovernError, type GovernOptions } from './govern';
import { decodeUtf8 } from './sync';
import type { ItemRow } from './types';

const BASE = 'https://node.test';
const HASH = 'aa'.repeat(32);
const ITEM = 'article/aaa';

function json(v: unknown) {
  return { status: 200, body: utf8(JSON.stringify(v)) };
}

function itemRow(itemId: string): ItemRow {
  return { itemId, source: 'import', type: 'article', title: 'T', rev: 'r1', contentHash: HASH, state: 'active', updatedAt: '2026-01-01T00:00:00Z' };
}

function fixture(http: FakeHttp = new FakeHttp()) {
  const repo = new MemoryRepo();
  repo.items.set(ITEM, itemRow(ITEM));
  const o: GovernOptions = { adapters: fakeAdapters(http, new MemoryFs(), new FakePackReader()), repo, nodeBaseUrl: BASE };
  return { http, repo, o };
}

function registeredPub(http: FakeHttp): string {
  const reg = http.posted.find((p) => p.url.endsWith('/v1/identity/register'));
  if (!reg) throw new Error('未发出登记请求');
  return (JSON.parse(decodeUtf8(reg.body)) as { pubkey: string }).pubkey;
}

/** 最后一条发往 `/v1/event` 的请求。 */
function lastEventPosted(http: FakeHttp) {
  const ev = [...http.posted].reverse().find((p) => p.url === `${BASE}/v1/event`);
  if (!ev) throw new Error('未发出治理事件');
  return ev;
}

type EventEnv = { event_id: string; type: string; created_at: number; body: Json; sig: string };

function parseEvent(http: FakeHttp): EventEnv {
  return JSON.parse(decodeUtf8(lastEventPosted(http).body)) as EventEnv;
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
  content_version: 4,
  revoked_rev: 2,
};

describe('govern', () => {
  it('列表：字段逐个映射（含水位）、votes 数组原样、按 proposal_id 升序返回后做纯展示反转', async () => {
    const { http, o } = fixture();
    http.routes.set(`${BASE}/v1/proposal`, json({ proposals: [{ ...ROW, proposal_id: '1' }, { ...ROW, proposal_id: '2', status: 'void' }] }));
    const items = await listProposals(o);
    expect(items.map((p) => p.proposalId)).toEqual(['2', '1']);
    expect(items[1]).toEqual({
      proposalId: '1', action: 'remove', itemId: 'article/aaa', proposerId: 'p1', reason: '内容不准确',
      title: '', bodyMd: '', status: 'pending', votes: ['p1'], voteCount: 1, threshold: 3,
      createdAt: 1790000000000, executedAt: 0, voidedAt: 0,
      // 服务端 DTO 补了 content_version / revoked_rev 后，水位字段**真实可见**（不再恒 0）。
      contentVersion: 4, revokedRev: 2,
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

  it('发起：走 POST /v1/event 的 govern.v1 事件，id 取当前最大 + 1，内容签名可被节点按同一字节重建', async () => {
    const { http, o } = fixture();
    http.routes.set(`${BASE}/v1/proposal`, json({ proposals: [{ ...ROW }] })); // 最大 id = 7
    http.postRoutes.set(`${BASE}/v1/identity/register`, json({}));
    http.postRoutes.set(`${BASE}/v1/event`, json({ event_id: 'e', received_at: 1 }));

    const res = await createProposal(o, { action: 'remove', itemId: ITEM, reason: '内容不准确' });
    expect(res.proposalId).toBe('8');

    const wire = lastEventPosted(http);
    // 事件路径 = 内容签名 + 5 个请求签名头（本册 §1）：与 core/comment.ts 的 /v1/event 同口径，
    // 否则节点 authenticate 步骤 1 直接回 400 auth_missing_header。
    expect(wire.headers['Content-Type']).toBe('application/json');
    for (const k of ['X-Base-Id', 'X-Base-Alg', 'X-Base-Ts', 'X-Base-Nonce', 'X-Base-Sig']) {
      expect(wire.headers[k]).toBeTruthy();
    }
    const env = parseEvent(http);
    expect(env.type).toBe('govern.v1');
    expect(env.body).toEqual({
      action: 'proposal', proposal_id: 8, target_item_id: ITEM, verb: 'remove',
      content_hash: HASH, content_version: 0, revoked_rev: 0, reason: '内容不准确',
    });
    const pub = registeredPub(http);
    expect(verify(pub, utf8(canonicalize({ event_id: env.event_id, type: env.type, created_at: env.created_at, body: env.body })), env.sig)).toBe(true);
  });

  it('发起：edit 才带 title/body_md；空 reason 不下发（节点对已给定的 reason 走 1..200 校验）', async () => {
    const { http, o } = fixture();
    http.routes.set(`${BASE}/v1/proposal`, json({ proposals: [] }));
    http.postRoutes.set(`${BASE}/v1/identity/register`, json({}));
    http.postRoutes.set(`${BASE}/v1/event`, json({ event_id: 'e', received_at: 1 }));

    await createProposal(o, { action: 'edit', itemId: ITEM, reason: '改写', edit: { title: '新题', bodyMd: '新正文' } });
    expect(parseEvent(http).body).toEqual({
      action: 'proposal', proposal_id: 1, target_item_id: ITEM, verb: 'edit',
      content_hash: HASH, content_version: 0, revoked_rev: 0,
      reason: '改写', title: '新题', body_md: '新正文',
    });

    await createProposal(o, { action: 'revive', itemId: ITEM, reason: '' });
    const body = parseEvent(http).body as Record<string, unknown>;
    expect(body).toEqual({
      action: 'proposal', proposal_id: 1, target_item_id: ITEM, verb: 'revive',
      content_hash: HASH, content_version: 0, revoked_rev: 0,
    });
    expect('reason' in body).toBe(false);
    expect('title' in body).toBe(false);
  });

  it('发起：本地无该条目内容哈希即拒绝（事件体必须自带 content_hash）', async () => {
    const { http, o } = fixture();
    http.postRoutes.set(`${BASE}/v1/identity/register`, json({}));
    const err = (await createProposal(o, { action: 'remove', itemId: 'article/zzz', reason: 'x' }).catch((e: unknown) => e)) as GovernError;
    expect(err).toBeInstanceOf(GovernError);
    expect(err.code).toBe('client');
  });

  it('发起 directory_add：事件体只带三键 + 派生 id/hash，不带 title/body_md，且不依赖本地条目', async () => {
    const http = new FakeHttp();
    http.routes.set(`${BASE}/v1/proposal`, json({ proposals: [] }));
    http.postRoutes.set(`${BASE}/v1/identity/register`, json({}));
    http.postRoutes.set(`${BASE}/v1/event`, json({ event_id: 'e', received_at: 1 }));
    const repo = new MemoryRepo(); // 空仓库：无任何条目，验证跳过了 getItem 前置
    const o: GovernOptions = { adapters: fakeAdapters(http, new MemoryFs(), new FakePackReader()), repo, nodeBaseUrl: BASE };

    const kind = 'category';
    const displayName = '数学';
    const termKey = normalizeTermKey(displayName)!;
    const res = await createProposal(o, { action: 'directory_add', itemId: '', reason: '', directory: { kind, termKey, displayName } });
    expect(res.proposalId).toBe('1');

    // 独立重算（不抄实现里的中间变量）
    const digest = sha256Hex(utf8('dir\x00' + kind + '\x00' + termKey));
    const env = parseEvent(http);
    expect(env.body).toEqual({
      action: 'proposal',
      proposal_id: 1,
      target_item_id: `dir/${kind}/${digest.slice(0, 16)}`,
      verb: 'directory_add',
      content_hash: digest,
      content_version: 0,
      revoked_rev: 0,
      directory_kind: kind,
      directory_term_key: termKey,
      directory_display_name: displayName,
    });
    const body = env.body as Record<string, unknown>;
    expect('title' in body).toBe(false);
    expect('body_md' in body).toBe(false);
    expect('reason' in body).toBe(false);
    const pub = registeredPub(http);
    expect(verify(pub, utf8(canonicalize({ event_id: env.event_id, type: env.type, created_at: env.created_at, body: env.body })), env.sig)).toBe(true);
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
      http.routes.set(`${BASE}/v1/proposal`, json({ proposals: [] }));
      http.postRoutes.set(`${BASE}/v1/identity/register`, json({}));
      http.postRoutes.set(`${BASE}/v1/event`, { status, body: utf8(JSON.stringify({ code })) });
      const err = (await createProposal(o, { action: 'remove', itemId: ITEM, reason: 'x' }).catch((e: unknown) => e)) as GovernError;
      expect(err.code).toBe(wantCode);
      expect(err.message).toBe(wantMsg);
    }
  });

  it('发起：命中撞号（conflict）→ 重取最大 id 再发', async () => {
    class SeqHttp extends FakeHttp {
      getCalls = 0;
      eventCalls = 0;
      override async get(url: string) {
        if (url.endsWith('/v1/proposal')) {
          this.getCalls++;
          // 第一次：空列表 ⇒ 取 id=1；第二次：已存在 id=5 ⇒ 取 id=6
          return json({ proposals: this.getCalls === 1 ? [] : [{ ...ROW, proposal_id: '5' }] });
        }
        return super.get(url);
      }
      override async post(url: string, body: Uint8Array, headers?: Record<string, string>) {
        if (url === `${BASE}/v1/event`) {
          this.eventCalls++;
          this.posted.push({ url, body, headers: headers ?? {} });
          return this.eventCalls === 1 ? json({ event_id: 'e1', received_at: 1, conflict: true }) : json({ event_id: 'e2', received_at: 2 });
        }
        return super.post(url, body, headers);
      }
    }
    const http = new SeqHttp();
    http.postRoutes.set(`${BASE}/v1/identity/register`, json({}));
    const { o } = fixture(http);
    const res = await createProposal(o, { action: 'remove', itemId: ITEM, reason: 'x' });
    expect(res.proposalId).toBe('6');
    expect(http.eventCalls).toBe(2);
    expect((parseEvent(http).body as Record<string, unknown>).proposal_id).toBe(6);
  });

  it('投票：POST /v1/event（body = {action:vote,proposal_id,choice:yes}），结果由重拉结果构造', async () => {
    const { http, o } = fixture();
    http.routes.set(`${BASE}/v1/proposal`, json({ proposals: [{ ...ROW, vote_count: 3, threshold: 3, status: 'effective' }] }));
    http.postRoutes.set(`${BASE}/v1/identity/register`, json({}));
    http.postRoutes.set(`${BASE}/v1/event`, json({ event_id: 'e', received_at: 1 }));

    const res = await vote(o, '7');
    expect(res).toEqual({ proposalId: '7', voteCount: 3, threshold: 3, status: 'effective' });
    expect(parseEvent(http).body).toEqual({ action: 'vote', proposal_id: 7, choice: 'yes' });
  });

  it('myIdentityId：本机无身份返回空串（不生成身份）', async () => {
    const { o } = fixture();
    expect(await myIdentityId(o)).toBe('');
  });
});