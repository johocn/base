import { describe, expect, it } from 'vitest';

import { deriveIdentityId, sha256Hex, utf8, verifyAuthorSig, type Json } from '@base/protocol-ts';

import { FakeHttp, FakePackReader, MemoryFs, MemoryRepo, fakeAdapters } from './fakes';
import { IDENTITY_REGISTERED_KEY } from './comment';
import { buildArticlePayload, buildContainerPayload, buildQuizPayload, buildTagPayload, contentHashOf, enqueueOrSend, flushSubmissions, newItemID, submitItem, type SubmitDraft, type SubmitOptions } from './submit';
import { buildQuestionJSON } from './quizdoc';
import { decodeUtf8 } from './sync';

const BASE = 'https://node.test';
const ID = 'a'.repeat(64);

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

/** 可开关的「网络不可达」：只让 `POST /v1/submit` 抛错，其余照常走路由。 */
function gateSubmit(http: FakeHttp): { offline: boolean } {
  const real = http.post.bind(http);
  const state = { offline: true };
  http.post = async (url, body, headers) => {
    if (state.offline && url.endsWith('/v1/submit')) {
      http.posted.push({ url, body, headers: headers ?? {} });
      throw new Error('断网');
    }
    return real(url, body, headers);
  };
  return state;
}

function registeredPub(http: FakeHttp): string {
  const reg = http.posted.find((p) => p.url.endsWith('/v1/identity/register'));
  if (!reg) throw new Error('未发出登记请求');
  return (JSON.parse(decodeUtf8(reg.body)) as { pubkey: string }).pubkey;
}

function articleDraft(over: Partial<SubmitDraft> = {}): SubmitDraft {
  return { itemId: 'article/abc123', type: 'article', title: '甲', bodyMd: '甲正文', questionJson: '', ...over };
}

describe('投稿载荷', () => {
  it('newItemID：<type>/<16 位 hex>，恒满足 [a-z0-9][a-z0-9-]{0,63}', () => {
    for (const type of ['article', 'quiz', 'course'] as const) {
      for (let i = 0; i < 20; i++) {
        const id = newItemID(type);
        expect(id.startsWith(`${type}/`)).toBe(true);
        expect(/^[a-z0-9][a-z0-9-]{0,63}$/.test(id.slice(type.length + 1))).toBe(true);
      }
    }
  });

  it('载荷字段正确、键序固定、且不含 author_id（携带即 author_id_forbidden）', () => {
    const article = decodeUtf8(buildArticlePayload('article/a1', '甲', '正文', 'ff'.repeat(64)));
    expect(article).toBe(
      '{"type":"article","item_id":"article/a1","title":"甲","body_md":"正文","question_json":"","author_sig":"' + 'ff'.repeat(64) + '"}',
    );
    const quiz = decodeUtf8(buildQuizPayload('quiz/q1', '乙', '{"schema_version":1,"questions":[]}', 'ee'.repeat(64)));
    expect(quiz).toBe(
      '{"type":"quiz","item_id":"quiz/q1","title":"乙","body_md":"","question_json":"{\\"schema_version\\":1,\\"questions\\":[]}","author_sig":"' + 'ee'.repeat(64) + '"}',
    );
    expect(article.includes('author_id')).toBe(false);
    expect(quiz.includes('author_id')).toBe(false);
  });

  it('content_hash 口径：article 取 body_md、quiz 取 question_json 的 UTF-8 字节 sha256', () => {
    expect(contentHashOf(articleDraft({ bodyMd: '甲正文' }))).toBe(sha256Hex(utf8('甲正文')));
    const qj = buildQuestionJSON([{ q: '题', options: ['A', 'B'], answer: 1, explain: '' }])!;
    expect(contentHashOf({ itemId: 'quiz/q1', type: 'quiz', title: '乙', bodyMd: '', questionJson: qj })).toBe(
      sha256Hex(utf8(qj)),
    );
  });

  it('首投：先补登记，再带 5 个签名头 POST；作者签名可被节点按同一字节重建验证', async () => {
    const { http, repo, o } = fixture();
    http.postRoutes.set(`${BASE}/v1/identity/register`, json({ id: 'ignored', alg: 'ed25519', registered: true }));
    http.postRoutes.set(`${BASE}/v1/submit`, json({ item_id: 'article/abc123', type: 'article', content_hash: 'x', created: true }));

    const res = await submitItem(o, articleDraft());
    expect(res.created).toBe(true);
    expect(http.posted.map((p) => p.url)).toEqual([`${BASE}/v1/identity/register`, `${BASE}/v1/submit`]);

    const wire = http.posted[1]!;
    const pub = registeredPub(http);
    const sent = JSON.parse(decodeUtf8(wire.body)) as Record<string, Json>;
    expect(wire.headers['X-Base-Alg']).toBe('ed25519');
    expect(wire.headers['X-Base-Method']).toBeUndefined();

    // 归属签名覆盖 canonical({alg,domain,item_id,content_hash,author_id})，与请求头无关（#23 §2.1）
    const hash = sha256Hex(utf8('甲正文'));
    const authorId = (JSON.parse(decodeUtf8(http.posted[0]!.body)) as { id: string }).id;
    expect(deriveIdentityId(pub)).toBe(authorId);
    expect(verifyAuthorSig(pub, 'article/abc123', hash, authorId, sent.author_sig as string)).toBe(true);
    // 请求体里的 content_hash 由客户端算，服务端会自己再算一遍（#25 §2.2）
    expect(sent.author_id).toBeUndefined();
    expect(await repo.getConfig(IDENTITY_REGISTERED_KEY)).toBe('1');
  });

  it('本地校验不过：不发任何请求', async () => {
    const { http, o } = fixture();
    http.postRoutes.set(`${BASE}/v1/identity/register`, json({}));
    const err = await enqueueOrSend(o, articleDraft({ title: '   ' })).catch((e: unknown) => e);
    expect((err as Error).message).toBe('请填写标题');
    expect(http.posted).toHaveLength(0);
  });
});

describe('台账状态机与补发', () => {
  it('200 → sent（created 回填）；429 → 保持 pending；4xx → failed 并记原因', async () => {
    const { http, repo, o } = fixture();
    http.postRoutes.set(`${BASE}/v1/identity/register`, json({}));
    http.postRoutes.set(`${BASE}/v1/submit`, json({ item_id: 'article/abc123', created: false }));

    const ok = await enqueueOrSend(o, articleDraft());
    expect(ok.ledgerState).toBe('sent');
    expect((await repo.getSubmission('article/abc123'))!.state).toBe('sent');
    expect((await repo.getSubmission('article/abc123'))!.created).toBe(0);
    expect((await repo.getSubmission('article/abc123'))!.sentAt).not.toBe('');

    http.postRoutes.set(`${BASE}/v1/submit`, { status: 429, body: utf8(JSON.stringify({ code: 'item_rate_limited' })) });
    const limited = await enqueueOrSend(o, articleDraft({ itemId: 'article/rate1' }));
    expect(limited.ledgerState).toBe('pending');
    expect(limited.message).toBe('操作过于频繁，请稍后再试');

    http.postRoutes.set(`${BASE}/v1/submit`, { status: 403, body: utf8(JSON.stringify({ code: 'item_id_taken' })) });
    const taken = await enqueueOrSend(o, articleDraft({ itemId: 'article/taken1' }));
    expect(taken.ledgerState).toBe('failed');
    expect((await repo.getSubmission('article/taken1'))!.reason).toBe('该条目已被他人创建');

    // 5xx 视为暂时（口径填空 4）
    http.postRoutes.set(`${BASE}/v1/submit`, { status: 500, body: utf8('boom') });
    const srv = await enqueueOrSend(o, articleDraft({ itemId: 'article/srv1' }));
    expect(srv.ledgerState).toBe('pending');
    expect(srv.message).toBe('提交失败（HTTP 500）');
  });

  describe('容器载体（course / lesson）', () => {
    const containerDraft = (over: Partial<SubmitDraft> = {}): SubmitDraft => ({
      itemId: 'course/c1',
      type: 'course',
      title: '甲课',
      bodyMd: '',
      questionJson: '',
      segments: [
        { seq: -1, kind: 'attr.cover', text: '00112233445566778899aabbccddeeff' },
        { seq: 0, kind: 'digest', text: '简介' },
        { seq: 1, kind: 'lesson', text: 'course/c1/lesson/l1' },
      ],
      ...over,
    });

    it('载荷键序固定为 type→item_id→title→segments→author_sig，且 segments 按 seq 升序', () => {
      const wire = decodeUtf8(
        buildContainerPayload(
          'course',
          'course/c1',
          '甲课',
          [
            { seq: 1, kind: 'lesson', text: 'course/c1/lesson/l1' },
            { seq: -1, kind: 'attr.cover', text: '00112233445566778899aabbccddeeff' },
          ],
          'ff'.repeat(64),
        ),
      );
      expect(wire).toBe(
        '{"type":"course","item_id":"course/c1","title":"甲课",' +
          '"segments":[{"seq":-1,"kind":"attr.cover","text":"00112233445566778899aabbccddeeff"},' +
          '{"seq":1,"kind":"lesson","text":"course/c1/lesson/l1"}],' +
          '"author_sig":"' +
          'ff'.repeat(64) +
          '"}',
      );
    });

    it('content_hash 走容器口径（与节点 store.SegmentsContentHash 同构）', () => {
      expect(contentHashOf(containerDraft())).toBe(
        sha256Hex(utf8('attr.cover\t00112233445566778899aabbccddeeff\ndigest\t简介\nlesson\tcourse/c1/lesson/l1\n')),
      );
    });

    it('首投：作者签名可被节点按同一字节重建验证', async () => {
      const { http, o } = fixture();
      http.postRoutes.set(`${BASE}/v1/identity/register`, json({}));
      http.postRoutes.set(`${BASE}/v1/submit`, json({ item_id: 'course/c1', created: true }));

      await submitItem(o, containerDraft());
      const sent = JSON.parse(decodeUtf8(http.posted[1]!.body)) as Record<string, Json>;
      const pub = registeredPub(http);
      const authorId = (JSON.parse(decodeUtf8(http.posted[0]!.body)) as { id: string }).id;
      expect(verifyAuthorSig(pub, 'course/c1', contentHashOf(containerDraft()), authorId, sent.author_sig as string)).toBe(true);
      expect((sent.segments as unknown[]).length).toBe(3);
    });

    it('断网入队 → 台账存下 segments_json → 补发时行集完整重建', async () => {
      const { http, repo, o } = fixture();
      http.postRoutes.set(`${BASE}/v1/identity/register`, json({}));
      const state = gateSubmit(http);

      const out = await enqueueOrSend(o, containerDraft());
      expect(out.ledgerState).toBe('pending');
      const row = await repo.getSubmission('course/c1');
      expect(row?.type).toBe('course');
      expect(row?.bodyMd).toBe('');
      expect(row?.segmentsJson).toBe(
        '[{"seq":-1,"kind":"attr.cover","text":"00112233445566778899aabbccddeeff"},' +
          '{"seq":0,"kind":"digest","text":"简介"},' +
          '{"seq":1,"kind":"lesson","text":"course/c1/lesson/l1"}]',
      );

      state.offline = false;
      http.postRoutes.set(`${BASE}/v1/submit`, json({ item_id: 'course/c1', created: false }));
      expect((await flushSubmissions(o)).sent).toBe(1);
      const wire = JSON.parse(decodeUtf8(http.posted.at(-1)!.body)) as { segments: unknown[] };
      expect(wire.segments).toHaveLength(3);
    });

    it('本地校验：容器只拦标题为空', async () => {
      const { http, o } = fixture();
      const err = await enqueueOrSend(o, containerDraft({ title: '  ' })).catch((e: unknown) => e);
      expect((err as Error).message).toBe('请填写标题');
      expect(http.posted).toHaveLength(0);
    });

    it('非容器形态回 item_id_invalid，且不再附加「不能指定课程」', async () => {
      const { http, repo, o } = fixture();
      http.postRoutes.set(`${BASE}/v1/identity/register`, json({}));
      http.postRoutes.set(`${BASE}/v1/submit`, { status: 400, body: utf8(JSON.stringify({ code: 'item_id_invalid' })) });

      const r = await enqueueOrSend(o, containerDraft({ itemId: 'course/c1/lesson/l1/quiz/q1' }));
      expect(r.ledgerState).toBe('failed');
      expect((await repo.getSubmission('course/c1/lesson/l1/quiz/q1'))!.reason).toBe('条目 id 不合法');
    });
  });

  it('断网 → 入队 pending；补发成功转 sent（单向，不留 pending）', async () => {
    const { http, repo, o } = fixture();
    http.postRoutes.set(`${BASE}/v1/identity/register`, json({}));
    const gate = gateSubmit(http);
    const offline = await enqueueOrSend(o, articleDraft());
    expect(offline.ledgerState).toBe('pending');
    expect(await repo.listSubmissions('pending')).toHaveLength(1);

    gate.offline = false;
    http.postRoutes.set(`${BASE}/v1/submit`, json({ item_id: 'article/abc123', created: true }));
    const res = await flushSubmissions(o);
    expect(res).toEqual({ sent: 1, failed: 0, remaining: 0, error: '' });
    expect((await repo.getSubmission('article/abc123'))!.state).toBe('sent');
    expect((await repo.getSubmission('article/abc123'))!.created).toBe(1);
  });

  it('补发：按 queued_at ASC 串行；暂时失败即中止本轮，不阻塞也不越过后续', async () => {
    const { http, repo, o } = fixture();
    http.postRoutes.set(`${BASE}/v1/identity/register`, json({}));
    for (const id of ['article/one', 'article/two', 'article/three']) {
      await repo.saveSubmission({
        itemId: id, type: 'article', title: id, bodyMd: '正文', questionJson: '', linksJson: '', segmentsJson: '',
        state: 'pending', reason: null, created: 0, queuedAt: `2026-09-28T00:00:0${id.slice(-1) === 'e' ? 1 : id.slice(-1) === 'o' ? 2 : 3}Z`, sentAt: '',
      });
    }
    http.postRoutes.set(`${BASE}/v1/identity/register`, json({}));
    http.postRoutes.set(`${BASE}/v1/submit`, { status: 500, body: utf8('boom') });

    const res = await flushSubmissions(o);
    expect(res).toEqual({ sent: 0, failed: 0, remaining: 3, error: '提交失败（HTTP 500）' });
    // 只试了第一条（串行 + 暂时失败即中止）
    expect(http.posted.filter((p) => p.url.endsWith('/v1/submit'))).toHaveLength(1);
    expect(await repo.listSubmissions('pending')).toHaveLength(3);
  });

  it('补发：单飞——并发调用复用同一轮', async () => {
    const { http, repo, o } = fixture();
    http.postRoutes.set(`${BASE}/v1/identity/register`, json({}));
    http.postRoutes.set(`${BASE}/v1/submit`, json({ created: true }));
    await repo.saveSubmission({
      itemId: 'article/one', type: 'article', title: '甲', bodyMd: '正文', questionJson: '', linksJson: '', segmentsJson: '',
      state: 'pending', reason: null, created: 0, queuedAt: '2026-09-28T00:00:01Z', sentAt: '',
    });
    const [a, b] = await Promise.all([flushSubmissions(o), flushSubmissions(o)]);
    expect(a).toEqual(b);
    expect(http.posted.filter((p) => p.url.endsWith('/v1/submit'))).toHaveLength(1);
  });

  it('未配置节点：投稿报错、补发直接返回空结果（不把队列变成发不出去的垃圾桶）', async () => {
    const { repo, o } = fixture();
    o.nodeBaseUrl = '';
    const err = await enqueueOrSend(o, articleDraft()).catch((e: unknown) => e);
    expect((err as Error).message).toBe('未配置节点地址，无法投稿');
    expect(await flushSubmissions(o)).toEqual({ sent: 0, failed: 0, remaining: 0, error: '' });
    expect(await repo.listSubmissions()).toHaveLength(0);
  });
});

describe('标签载体', () => {
  it('键序固定为 type→item_id→title→links→author_sig，且 content_hash 走物化文本', () => {
    const draft: SubmitDraft = {
      itemId: 'tag/甲/第一章/第一节', type: 'tag', title: '甲 · 第一章 · 第一节', bodyMd: '', questionJson: '',
      links: [
        { tagId: 'tag/甲/第一章/第一节', targetId: 'course/c1/lesson/l1', kind: 'lesson' },
        { tagId: 'tag/甲/第一章/第一节', targetId: 'course/c1', kind: 'course' },
      ],
    };
    // 物化序 = kind 固定序（course < lesson）→ target 升序，与节点 store.MaterializeTagSegments 同构
    expect(contentHashOf(draft)).toBe(sha256Hex(utf8('course\tcourse/c1\nlesson\tcourse/c1/lesson/l1\n')));
    const wire = decodeUtf8(buildTagPayload(draft.itemId, draft.title, draft.links!, 'ff'.repeat(64)));
    expect(wire).toBe(
      '{"type":"tag","item_id":"tag/甲/第一章/第一节","title":"甲 · 第一章 · 第一节",' +
        '"links":[{"target_id":"course/c1","kind":"course"},{"target_id":"course/c1/lesson/l1","kind":"lesson"}],' +
        '"author_sig":"' + 'ff'.repeat(64) + '"}',
    );
  });

  it('断网入队 → 台账存下 links_json → 补发时草稿可完整重建', async () => {
    const { http, repo, o } = fixture();
    http.postRoutes.set(`${BASE}/v1/identity/register`, json({}));
    const state = gateSubmit(http); // 与既有用例同一开关
    await enqueueOrSend(o, {
      itemId: 'tag/甲/第一章/第一节', type: 'tag', title: '甲 · 第一章 · 第一节', bodyMd: '', questionJson: '',
      links: [{ tagId: 'tag/甲/第一章/第一节', targetId: 'course/c1', kind: 'course' }],
    });
    const row = await repo.getSubmission('tag/甲/第一章/第一节');
    expect(row?.type).toBe('tag');
    expect(row?.linksJson).toBe('[{"target_id":"course/c1","kind":"course"}]');

    state.offline = false;
    http.postRoutes.set(`${BASE}/v1/submit`, json({ item_id: 'tag/甲/第一章/第一节', created: false }));
    const res = await flushSubmissions(o);
    expect(res.sent).toBe(1);
    const wire = JSON.parse(decodeUtf8(http.posted.at(-1)!.body)) as { links: unknown };
    expect(wire.links).toEqual([{ target_id: 'course/c1', kind: 'course' }]);
  });
});