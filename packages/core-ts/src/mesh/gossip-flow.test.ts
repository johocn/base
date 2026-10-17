// gossip-flow 纯逻辑单测：wire→消息转换、ingest 编排、双向交换、回连代报两路。
// 文件写入用注入的 FsAdapter（MemoryFs / 抛错实现），HTTP 用 FakeHttp，与 core/sync.ts 同一测试约定。
import { describe, expect, it } from 'vitest';
import {
  blobId,
  canonicalize,
  deriveIdentityId,
  sign,
  utf8,
  type Json,
} from '@base/protocol-ts';
import { FakeHttp, FakePackReader, MemoryFs, MemoryRepo, MemoryStorage, fakeAdapters } from '../fakes';
import { identityFromSeed, type Identity } from '../identity';
import type { Adapters, FsAdapter } from '../platform/adapter';
import type { CommentOutRow } from '../types';
import { verifyGossipMessage, type GossipMessage } from './gossip';
import {
  commentOutToGossipMessage,
  exchangeGossipFlow,
  flushRelayFlow,
  ingestGossipFlow,
  outgoingGossipFlow,
  toBase64,
} from './gossip-flow';

const MY_SEED = '9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60';
const ME = identityFromSeed(MY_SEED);
const PEER_SEED = '4ccd089b28ff96da9db6c346ec114e0f5b8a319f35aba624da8cf6ed4fb8a6fb';
const PEER = identityFromSeed(PEER_SEED);
const NOW = 1760640000000;
const NODE = 'https://node.example.com';
const SRC = 'http://192.168.1.10:8712';
const TOKEN = 'tok';

/** 构造一条真签名的评论：comment_out 行（wire 冻结）+ 同源 gossip 消息。 */
function buildComment(
  ident: Identity,
  input: { targetId: string; text: string; replyTo?: string },
  eventId: string,
  createdAt = NOW,
): { wire: string; row: CommentOutRow; msg: GossipMessage } {
  const inner: Json = { target_id: input.targetId, text: input.text };
  if (input.replyTo) (inner as Record<string, Json>).reply_to = input.replyTo;
  const payload: Json = { event_id: eventId, type: 'comment.v1', created_at: createdAt, body: inner };
  const sig = sign(ident.seedHex, utf8(canonicalize(payload)));
  const wire = JSON.stringify({ ...(payload as Record<string, Json>), sig });
  const row: CommentOutRow = {
    eventId,
    targetId: input.targetId,
    text: input.text,
    replyTo: input.replyTo ?? null,
    wire,
    state: 'pending',
    reason: null,
    queuedAt: new Date(createdAt).toISOString(),
  };
  const msg: GossipMessage = {
    event: { event_id: eventId, type: 'comment.v1', created_at: createdAt, body: inner, sig },
    actor_pubkey: ident.pubHex,
    payload_b64: toBase64(utf8(input.text)),
  };
  return { wire, row, msg };
}

/** /v1/event 按脚本逐次应答；登记路由走 postRoutes。 */
class ScriptedHttp extends FakeHttp {
  eventStatuses: number[] = [];
  override async post(
    url: string,
    body: Uint8Array,
    headers?: Record<string, string>,
  ): Promise<{ status: number; body: Uint8Array }> {
    if (url === `${NODE}/v1/event`) {
      this.posted.push({ url, body, headers: headers ?? {} });
      return { status: this.eventStatuses.shift() ?? 403, body: utf8(JSON.stringify({ event_id: 'x', payload_cid: 'p' })) };
    }
    return super.post(url, body, headers);
  }
}

function nodeHttp(): { http: ScriptedHttp; adapters: Adapters; fs: MemoryFs } {
  const http = new ScriptedHttp();
  http.postRoutes.set(`${NODE}/v1/identity/register`, { status: 200, body: utf8('{}') });
  const fs = new MemoryFs();
  return { http, adapters: fakeAdapters(http, fs, new FakePackReader(), new MemoryStorage()), fs };
}

/** mesh 源端假服务：POST gossip 200；GET gossip 回给定消息页。 */
function meshHttp(incoming: unknown[]): FakeHttp {
  const http = new FakeHttp();
  http.postRoutes.set(`${SRC}/mesh/v1/gossip?token=${TOKEN}`, { status: 200, body: utf8('{}') });
  http.routes.set(`${SRC}/mesh/v1/gossip?token=${TOKEN}&since=0_`, {
    status: 200,
    body: utf8(JSON.stringify({ messages: incoming, next_cursor: '0_' })),
  });
  return http;
}

describe('toBase64', () => {
  it('RFC 4648 向量与 padding', () => {
    const enc = (s: string) => toBase64(utf8(s));
    expect(enc('')).toBe('');
    expect(enc('f')).toBe('Zg==');
    expect(enc('fo')).toBe('Zm8=');
    expect(enc('foo')).toBe('Zm9v');
    expect(enc('foob')).toBe('Zm9vYg==');
    expect(enc('fooba')).toBe('Zm9vYmE=');
    expect(enc('foobar')).toBe('Zm9vYmFy');
  });

  it('跨字节边界与 Buffer 实现逐字一致（+/= 字母表，atob 可解码）', () => {
    const bytes = new Uint8Array(257);
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 7 + 13) % 256;
    expect(toBase64(bytes)).toBe(Buffer.from(bytes).toString('base64'));
  });
});

describe('outgoingGossipFlow / commentOutToGossipMessage', () => {
  it('pending 行转消息：三元组与 sig 取 wire 字段，payload 可被 verifyGossipMessage 验过', async () => {
    const repo = new MemoryRepo();
    const { row } = buildComment(ME, { targetId: 'article/a', text: '评论正文' }, 'a1b2c3d4e5f60718');
    await repo.enqueueComment(row);
    const messages = await outgoingGossipFlow({ repo, myPubHex: ME.pubHex });
    expect(messages).toHaveLength(1);
    expect(messages[0]?.actor_pubkey).toBe(ME.pubHex);
    expect(messages[0]?.event.event_id).toBe('a1b2c3d4e5f60718');
    expect(messages[0]?.event.sig).toBe((JSON.parse(row.wire) as { sig: string }).sig);
    const v = verifyGossipMessage(messages[0]);
    expect(v).not.toBeNull();
    expect(v?.payloadText).toBe('评论正文');
    expect(v?.payloadCid).toBe(blobId(utf8('评论正文')));
  });

  it('failed 行不外传（节点明确拒绝过）；坏 wire 与白名单外类型跳过', async () => {
    const repo = new MemoryRepo();
    const good = buildComment(ME, { targetId: 'article/a', text: '好的' }, 'a1b2c3d4e5f60718');
    const failed = buildComment(ME, { targetId: 'article/a', text: '被拒的' }, 'a1b2c3d4e5f60719');
    failed.row.state = 'failed';
    const bad = buildComment(ME, { targetId: 'article/a', text: '坏 wire' }, 'a1b2c3d4e5f6071a');
    bad.row.wire = '{not json';
    const foreignType = buildComment(ME, { targetId: 'article/a', text: '类型外' }, 'a1b2c3d4e5f6071b');
    foreignType.row.wire = JSON.stringify({ ...JSON.parse(foreignType.row.wire), type: 'like.v1' });
    await repo.enqueueComment(good.row);
    await repo.enqueueComment(failed.row);
    await repo.enqueueComment(bad.row);
    await repo.enqueueComment(foreignType.row);
    const messages = await outgoingGossipFlow({ repo, myPubHex: ME.pubHex });
    expect(messages).toHaveLength(1);
    expect(messages[0]?.event.event_id).toBe('a1b2c3d4e5f60718');
    expect(commentOutToGossipMessage(bad.row, ME.pubHex)).toBeNull();
  });

  it('reply 行 body 键集保真（target_id/text/reply_to，与原签名 wire 一致）', () => {
    const { row } = buildComment(ME, { targetId: 'article/a', text: '回复', replyTo: 'b1b2c3d4e5f60718' }, 'a1b2c3d4e5f6071c');
    const m = commentOutToGossipMessage(row, ME.pubHex);
    expect(m?.event.body).toEqual({ target_id: 'article/a', text: '回复', reply_to: 'b1b2c3d4e5f60718' });
  });
});

describe('ingestGossipFlow', () => {
  it('合法消息 → stored：payload 落盘、行字段齐全（actor=id 派生、body_json 存原签名 body）', async () => {
    const repo = new MemoryRepo();
    const fs = new MemoryFs();
    const { msg } = buildComment(PEER, { targetId: 'article/a', text: '对端评论', replyTo: 'b1b2c3d4e5f60718' }, 'c1b2c3d4e5f60718');
    expect(await ingestGossipFlow({ repo, fs, workDir: '_doc', msg, now: NOW })).toBe('stored');
    const path = `_doc/gossip/${blobId(utf8('对端评论'))}`;
    expect(fs.files.has(path)).toBe(true);
    const rows = await repo.listGossipSince(0, '', 10);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.actor).toBe(deriveIdentityId(PEER.pubHex));
    expect(rows[0]?.targetId).toBe('article/a');
    expect(JSON.parse(rows[0]?.bodyJson ?? 'null')).toEqual({ target_id: 'article/a', text: '对端评论', reply_to: 'b1b2c3d4e5f60718' });
  });

  it('同 event_id 重放 → duplicate，已存在文件不重写', async () => {
    const repo = new MemoryRepo();
    const fs = new MemoryFs();
    const { msg } = buildComment(PEER, { targetId: 'article/a', text: 'x' }, 'c1b2c3d4e5f60719');
    expect(await ingestGossipFlow({ repo, fs, workDir: '_doc', msg, now: NOW })).toBe('stored');
    const path = `_doc/gossip/${blobId(utf8('x'))}`;
    fs.files.set(path, utf8('tampered'));
    expect(await ingestGossipFlow({ repo, fs, workDir: '_doc', msg, now: NOW })).toBe('duplicate');
    expect(Buffer.from(fs.files.get(path) ?? new Uint8Array()).toString()).toBe('tampered');
  });

  it('篡改 body → rejected：不落盘不入库', async () => {
    const repo = new MemoryRepo();
    const fs = new MemoryFs();
    const { msg } = buildComment(PEER, { targetId: 'article/a', text: 'x' }, 'c1b2c3d4e5f6071a');
    msg.event.body = { target_id: 'article/a', text: 'y' };
    expect(await ingestGossipFlow({ repo, fs, workDir: '_doc', msg, now: NOW })).toBe('rejected');
    expect(await repo.countGossip()).toBe(0);
    expect([...fs.files.keys()]).toHaveLength(0);
  });

  it('payload 落盘失败 → rejected（不写半截行）', async () => {
    const repo = new MemoryRepo();
    const failFs: FsAdapter = Object.create(new MemoryFs()) as FsAdapter;
    failFs.writeFile = async () => {
      throw new Error('disk full');
    };
    const { msg } = buildComment(PEER, { targetId: 'article/a', text: 'x' }, 'c1b2c3d4e5f6071b');
    expect(await ingestGossipFlow({ repo, fs: failFs, workDir: '_doc', msg, now: NOW })).toBe('rejected');
    expect(await repo.countGossip()).toBe(0);
  });
});

describe('exchangeGossipFlow', () => {
  it('双向一轮：本机所发推给对端；对端所发 stored/duplicate/rejected 逐条计数', async () => {
    const repo = new MemoryRepo();
    await repo.enqueueComment(buildComment(ME, { targetId: 'article/a', text: '我的' }, 'a1b2c3d4e5f6071d').row);
    const theirs = buildComment(PEER, { targetId: 'article/a', text: '对端的' }, 'c1b2c3d4e5f6071c').msg;
    const stats = await exchangeGossipFlow({
      repo,
      fs: new MemoryFs(),
      http: meshHttp([theirs, theirs, { garbage: true }]),
      workDir: '_doc',
      myPubHex: ME.pubHex,
      baseUrl: SRC,
      token: TOKEN,
      since: '0_',
      now: NOW,
    });
    expect(stats).toEqual({ sent: 1, stored: 1, duplicate: 1, rejected: 1, cursor: '0_' });
  });

  it('推送体里 actor_pubkey 是本机公钥，整条消息可被接收端验过', async () => {
    const repo = new MemoryRepo();
    await repo.enqueueComment(buildComment(ME, { targetId: 'article/a', text: '正文' }, 'a1b2c3d4e5f6071e').row);
    const http = meshHttp([]);
    await exchangeGossipFlow({
      repo, fs: new MemoryFs(), http, workDir: '_doc',
      myPubHex: ME.pubHex, baseUrl: SRC, token: TOKEN, since: '0_', now: NOW,
    });
    const posts = http.posted.filter((p) => p.url.startsWith(`${SRC}/mesh/v1/gossip`));
    expect(posts).toHaveLength(1);
    const body = JSON.parse(Buffer.from(posts[0]!.body).toString()) as { messages: unknown[] };
    expect(body.messages).toHaveLength(1);
    expect((body.messages[0] as GossipMessage).actor_pubkey).toBe(ME.pubHex);
    expect(verifyGossipMessage(body.messages[0])).not.toBeNull();
  });

  it('本机没有待发 → 不发 POST，只拉取', async () => {
    const repo = new MemoryRepo();
    const http = meshHttp([]);
    const stats = await exchangeGossipFlow({
      repo, fs: new MemoryFs(), http, workDir: '_doc',
      myPubHex: ME.pubHex, baseUrl: SRC, token: TOKEN, since: '0_', now: NOW,
    });
    expect(stats.sent).toBe(0);
    expect(http.posted).toHaveLength(0);
  });
});

describe('flushRelayFlow', () => {
  it('空节点地址 → 全零且无请求', async () => {
    const { http, adapters } = nodeHttp();
    const stats = await flushRelayFlow({ adapters, repo: new MemoryRepo(), nodeBaseUrl: '' });
    expect(stats).toEqual({ ownSent: 0, relaySent: 0, failed: 0 });
    expect(http.posted).toHaveLength(0);
  });

  it('路 1：pending 的本机评论经既有补发队列（flushPending）直达节点后出队', async () => {
    const { http, adapters } = nodeHttp();
    http.eventStatuses.push(200);
    const repo = new MemoryRepo();
    await repo.enqueueComment(buildComment(ME, { targetId: 'article/a', text: '我的' }, 'a1b2c3d4e5f6071f').row);
    const stats = await flushRelayFlow({ adapters, repo, nodeBaseUrl: NODE });
    expect(stats.ownSent).toBe(1);
    expect(await repo.listCommentOut()).toHaveLength(0);
  });

  it('路 2：代报事件 body 取原签名全文（reply_to 保真），Relay 头与签名头齐备，200 即标 relayed', async () => {
    const { http, adapters } = nodeHttp();
    http.eventStatuses.push(200);
    const repo = new MemoryRepo();
    const peerMsg = buildComment(PEER, { targetId: 'article/a', text: '对端评论', replyTo: 'b1b2c3d4e5f60718' }, 'c1b2c3d4e5f6071c').msg;
    expect(await ingestGossipFlow({ repo, fs: new MemoryFs(), workDir: '_doc', msg: peerMsg, now: NOW })).toBe('stored');
    const stats = await flushRelayFlow({ adapters, repo, nodeBaseUrl: NODE });
    expect(stats).toEqual({ ownSent: 0, relaySent: 1, failed: 0 });
    const relayPost = http.posted.find((p) => p.url === `${NODE}/v1/event`);
    expect(relayPost).toBeDefined();
    const sent = JSON.parse(Buffer.from(relayPost!.body).toString()) as Record<string, unknown>;
    expect(Object.keys(sent).sort()).toEqual(['body', 'created_at', 'event_id', 'sig', 'type']);
    expect(sent.event_id).toBe('c1b2c3d4e5f6071c');
    expect(sent.body).toEqual({ target_id: 'article/a', text: '对端评论', reply_to: 'b1b2c3d4e5f60718' });
    expect(relayPost!.headers['X-Base-Relay-For']).toBe(deriveIdentityId(PEER.pubHex));
    expect(relayPost!.headers['X-Base-Relay-Device']).toBe(relayPost!.headers['X-Base-Id']);
    expect(relayPost!.headers['X-Base-Sig']).toBeTruthy();
    expect((await repo.listGossipSince(0, '', 10))[0]?.relayed).toBe(1);
  });

  it('路 2：节点拒绝记 failed 不中止后续行；被拒行保持 relayed=0', async () => {
    const { http, adapters } = nodeHttp();
    http.eventStatuses.push(403, 200);
    const repo = new MemoryRepo();
    const fs = new MemoryFs();
    await ingestGossipFlow({ repo, fs, workDir: '_doc', msg: buildComment(PEER, { targetId: 'article/a', text: '一' }, 'c1b2c3d4e5f60720').msg, now: NOW });
    await ingestGossipFlow({ repo, fs, workDir: '_doc', msg: buildComment(PEER, { targetId: 'article/a', text: '二' }, 'c1b2c3d4e5f60721').msg, now: NOW });
    const stats = await flushRelayFlow({ adapters, repo, nodeBaseUrl: NODE });
    expect(stats).toEqual({ ownSent: 0, relaySent: 1, failed: 1 });
    const rows = await repo.listGossipSince(0, '', 10);
    expect(rows.find((r) => r.eventId === 'c1b2c3d4e5f60720')?.relayed).toBe(0);
    expect(rows.find((r) => r.eventId === 'c1b2c3d4e5f60721')?.relayed).toBe(1);
  });

  it('路 2：无 body_json 的旧行从 payload 文件重建 {target_id,text}，键集不补 reply_to', async () => {
    const { http, adapters, fs } = nodeHttp();
    http.eventStatuses.push(200);
    const repo = new MemoryRepo();
    const built = buildComment(PEER, { targetId: 'article/a', text: '旧行' }, 'c1b2c3d4e5f60722');
    const payloadPath = '_doc/gossip/legacy';
    await fs.writeFile(payloadPath, utf8('旧行'));
    // 旧版本入库行：不带 body_json（GossipRow 该字段可选）
    await repo.insertGossipEvent({
      eventId: 'c1b2c3d4e5f60722', type: 'comment.v1', targetId: 'article/a',
      actor: deriveIdentityId(PEER.pubHex), createdAt: NOW, receivedAt: NOW,
      payloadCid: 'legacy', payloadPath, sig: built.msg.event.sig, relayed: 0,
    });
    const stats = await flushRelayFlow({ adapters, repo, nodeBaseUrl: NODE });
    expect(stats).toEqual({ ownSent: 0, relaySent: 1, failed: 0 });
    const relayPost = http.posted.filter((p) => p.url === `${NODE}/v1/event`).at(-1);
    const sent = JSON.parse(Buffer.from(relayPost!.body).toString()) as { body: Record<string, unknown> };
    expect(sent.body).toEqual({ target_id: 'article/a', text: '旧行' });
    expect(Object.keys(sent.body).sort()).toEqual(['target_id', 'text']);
  });

  it('登记不了（节点 5xx）→ 代报整轮跳过，不发 /v1/event，行保持 relayed=0', async () => {
    const { http, adapters } = nodeHttp();
    http.postRoutes.set(`${NODE}/v1/identity/register`, { status: 500, body: utf8('{}') });
    const repo = new MemoryRepo();
    await ingestGossipFlow({
      repo, fs: new MemoryFs(), workDir: '_doc',
      msg: buildComment(PEER, { targetId: 'article/a', text: 'x' }, 'c1b2c3d4e5f60723').msg, now: NOW,
    });
    const stats = await flushRelayFlow({ adapters, repo, nodeBaseUrl: NODE });
    expect(stats).toEqual({ ownSent: 0, relaySent: 0, failed: 0 });
    expect(http.posted.filter((p) => p.url === `${NODE}/v1/event`)).toHaveLength(0);
    expect((await repo.listGossipSince(0, '', 10))[0]?.relayed).toBe(0);
  });
});
