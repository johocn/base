import { describe, expect, it } from 'vitest';

import { keyPairFromSeed, signRelease, utf8, type ReleaseDoc } from '@base/protocol-ts';

import {
  UNKNOWN_FLAGS,
  canPickFile,
  canPostComment,
  canSync,
  pickBlockedReason,
  postBlockedReason,
  runSelfCheck,
  type CheckContext,
  type PlusHandle,
} from './selfcheck';
import { FakeHttp, FakePackReader, MemoryDb, MemoryFs, MemoryRepo, fakeAdapters } from './fakes';
import type { ArticleRow } from './types';

describe('能力标志与降级判定', () => {
  it('unknown 不降级：功能照常可用', () => {
    expect(canPostComment(UNKNOWN_FLAGS)).toBe(true);
    expect(canSync(UNKNOWN_FLAGS)).toBe(true);
    expect(postBlockedReason(UNKNOWN_FLAGS)).toBe('');
  });

  it('只有明确 fail 才降级，且各标志互不牵连', () => {
    expect(canPostComment({ ...UNKNOWN_FLAGS, cryptoOk: 'fail' })).toBe(false);
    expect(postBlockedReason({ ...UNKNOWN_FLAGS, cryptoOk: 'fail' })).toContain('随机源不可用');
    expect(canPostComment({ ...UNKNOWN_FLAGS, writeOk: 'fail' })).toBe(false);
    expect(postBlockedReason({ ...UNKNOWN_FLAGS, writeOk: 'fail' })).toContain('节点未接受写入');
    expect(canSync({ ...UNKNOWN_FLAGS, fsOk: 'fail' })).toBe(false);
    // 文件不可用不影响发表评论（两条链路互不依赖）
    expect(canPostComment({ ...UNKNOWN_FLAGS, fsOk: 'fail' })).toBe(true);
  });

  it('全 ok 不降级', () => {
    const all = { cryptoOk: 'ok', fsOk: 'ok', dbOk: 'ok', writeOk: 'ok', pickOk: 'ok' } as const;
    expect(canPostComment(all)).toBe(true);
    expect(canSync(all)).toBe(true);
    expect(postBlockedReason(all)).toBe('');
  });
});

const NODE = 'http://node.test';
const ISSUER_SEED = '11'.repeat(32);
const ISSUER_PUB = keyPairFromSeed(ISSUER_SEED).pubHex;
const FAKE_PLUS: PlusHandle = { runtime: { version: '0.5.0', openURL: () => undefined } };
/** 两条选择 API 都在的假句柄（App 端形态）；测试只用其「是不是函数」 */
const FAKE_PICK = { chooseFile: () => undefined, chooseImage: () => undefined };

const RELEASE: ReleaseDoc = signRelease(
  {
    schema_version: 1,
    issuer: 'base-node-test',
    issued_at: '2026-09-27T00:00:00Z',
    version_name: '9.9.9',
    min_version_name: '0.0.1',
    apk_url: `${NODE}/dl/x.apk`,
    apk_size: 1,
    apk_sha256: 'ab'.repeat(32),
    notes: 'test',
  },
  ISSUER_SEED,
);

const ARTICLE: ArticleRow = {
  itemId: 'a1',
  title: '自检用文章',
  digest: '',
  publishedAt: '2026-09-27',
  tagsJson: '[]',
  bodyMd: '# hi',
  contentHash: 'cd'.repeat(32),
  rev: '1',
};

/** 12 条探测的展示顺序（spec §3）。 */
const ALL_IDS = [
  'crypto.sqlite_random',
  'crypto.pool',
  'crypto.sign',
  'fs.bigfile',
  'fs.meta',
  'db.tx',
  'db.pack',
  'net.tls_get',
  'net.release_verify',
  'net.event_write',
  'net.open_url',
  'render.memory',
  'pick.choose_file',
  'pick.album',
];

function makeEnv(o: { withPack?: boolean } = {}) {
  const http = new FakeHttp();
  const fs = new MemoryFs();
  const repo = new MemoryRepo();
  const db = new MemoryDb();
  const packReader = new FakePackReader();
  const adapters = fakeAdapters(http, fs, packReader);

  repo.config.set('pubkey_hex', ISSUER_PUB);
  http.routes.set(`${NODE}/v1/comment?limit=1`, {
    status: 200,
    body: utf8(JSON.stringify({ comments: [], next_cursor: null })),
  });
  http.routes.set(`${NODE}/v1/release`, { status: 200, body: utf8(JSON.stringify(RELEASE)) });
  http.postRoutes.set(`${NODE}/v1/identity/register`, { status: 200, body: utf8('{}') });
  http.postRoutes.set(`${NODE}/v1/event`, {
    status: 200,
    body: utf8(JSON.stringify({ event_id: 'ab'.repeat(16), payload_cid: 'cd'.repeat(16) })),
  });

  if (o.withPack) {
    const packPath = '/work/pack-p1.sqlite';
    fs.files.set(packPath, new Uint8Array([1]));
    packReader.set(packPath, [ARTICLE], []);
    repo.config.set('pack_id', 'p1');
  }

  const ctx: CheckContext = { adapters, repo, db, nodeBaseUrl: NODE, workDir: '/work' };
  return { http, fs, repo, db, ctx };
}

describe('runSelfCheck', () => {
  it('用例 1：全可用时 12 条为 ok，标志全 ok，且不留探测残留', async () => {
    const env = makeEnv({ withPack: true });
    const r = await runSelfCheck(env.ctx, { plus: FAKE_PLUS, pick: FAKE_PICK });

    expect(r.degraded).toBe(false);
    expect(r.items.map((i) => i.id)).toEqual(ALL_IDS);
    expect(r.items.map((i) => i.status)).toEqual(new Array(14).fill('ok'));
    expect(r.flags).toEqual({ cryptoOk: 'ok', fsOk: 'ok', dbOk: 'ok', writeOk: 'ok', pickOk: 'ok' });
    // 污染控制：probe.bin / meta.bin 已删，只剩 pack 文件；事务探测未留行
    expect([...env.fs.files.keys()]).toEqual(['/work/pack-p1.sqlite']);
    expect(await env.ctx.db.select('SELECT count(*) AS n FROM selfcheck_probe')).toEqual([{ n: 0 }]);
  });

  it('用例 2：网络不可达时第 10 条 skip，writeOk 保持 unknown（离线入队不被自检禁掉）', async () => {
    const env = makeEnv({ withPack: true });
    env.http.post = async () => {
      throw new Error('网络不可达');
    };
    const r = await runSelfCheck(env.ctx, { plus: FAKE_PLUS, pick: FAKE_PICK });

    const p10 = r.items.find((i) => i.id === 'net.event_write');
    expect(p10?.status).toBe('skip');
    expect(p10?.detail).toBe('节点不可达，未探测');
    expect(r.flags).toEqual({ cryptoOk: 'ok', fsOk: 'ok', dbOk: 'ok', writeOk: 'unknown', pickOk: 'ok' });
    // unknown 不降级 → 发表可用 → 离线入队可用（本册 §7）
    expect(canPostComment(r.flags)).toBe(true);
    // 探针不污染队列：sendComment 是纯发送，不入队
    expect(await env.repo.listCommentOut()).toEqual([]);
  });

  it('用例 11：节点明确拒绝时第 10 条 fail，writeOk 跟着降级', async () => {
    const env = makeEnv({ withPack: true });
    env.http.postRoutes.set(`${NODE}/v1/event`, {
      status: 403,
      body: utf8(JSON.stringify({ code: 'event_sig_invalid' })),
    });
    const r = await runSelfCheck(env.ctx, { plus: FAKE_PLUS });

    const p10 = r.items.find((i) => i.id === 'net.event_write');
    expect(p10?.status).toBe('fail');
    expect(p10?.detail).toBe('提交被拒绝');
    expect(r.flags.writeOk).toBe('fail');
  });

  it('用例 3：单条挂死只让该条超时，整页仍然出结果', async () => {
    const env = makeEnv({ withPack: true });
    env.http.get = () => new Promise<never>(() => undefined);
    const r = await runSelfCheck(env.ctx, { plus: FAKE_PLUS, timeoutMs: 10 });

    const timedOut = r.items.filter((i) => i.detail.includes('超时')).map((i) => i.id);
    expect(timedOut).toEqual(['net.tls_get', 'net.release_verify']);
    expect(r.items).toHaveLength(14);
    expect(r.flags.cryptoOk).toBe('ok');
  });

  it('用例 4：降级模式（无 ctx）只跑 3、11、12，其余原因写明', async () => {
    const r = await runSelfCheck(null, { plus: FAKE_PLUS });

    expect(r.degraded).toBe(true);
    expect(r.items.map((i) => i.id)).toEqual(ALL_IDS);
    expect(r.items.filter((i) => i.status === 'ok').map((i) => i.id)).toEqual([
      'crypto.sign',
      'net.open_url',
      'render.memory',
    ]);
    const skipped = r.items.find((i) => i.id === 'crypto.sqlite_random');
    expect(skipped?.status).toBe('fail');
    expect(skipped?.detail).toBe('本地库不可用，未探测');
    // 降级模式未传 pick，Node 下 pickHandle() 回空对象 → 两条 pick.* 探测 fail
    expect(r.flags).toEqual({ cryptoOk: 'fail', fsOk: 'fail', dbOk: 'fail', writeOk: 'fail', pickOk: 'fail' });
  });

  it('用例 6：本地无 pack 时第 7 条为 skip，dbOk 仍为 ok', async () => {
    const env = makeEnv();
    const r = await runSelfCheck(env.ctx, { plus: FAKE_PLUS });

    expect(r.items.find((i) => i.id === 'db.pack')?.status).toBe('skip');
    expect(r.flags.dbOk).toBe('ok');
  });
});

describe('选择文件能力（pickOk）', () => {
  it('unknown 不降级、ok 照常、仅 fail 拦下', () => {
    expect(canPickFile(UNKNOWN_FLAGS)).toBe(true);
    expect(canPickFile({ ...UNKNOWN_FLAGS, pickOk: 'ok' })).toBe(true);
    expect(canPickFile({ ...UNKNOWN_FLAGS, pickOk: 'fail' })).toBe(false);
  });

  it('pickBlockedReason 只在 fail 时给出含「选择」的原因', () => {
    expect(pickBlockedReason({ ...UNKNOWN_FLAGS, pickOk: 'fail' })).toContain('选择');
    expect(pickBlockedReason(UNKNOWN_FLAGS)).toBe('');
    expect(pickBlockedReason({ ...UNKNOWN_FLAGS, pickOk: 'ok' })).toBe('');
  });

  it('两条 pick.* 探测进场；按运行时探针分支断言（有 chooseFile 无相册 ⇒ 两项都 ok）', async () => {
    const r = await runSelfCheck(null, { plus: FAKE_PLUS, pick: { chooseFile: () => undefined } });
    const ids = r.items.map((i) => i.id);
    expect(ids).toContain('pick.choose_file');
    expect(ids).toContain('pick.album');
    expect(r.items.find((i) => i.id === 'pick.choose_file')?.status).toBe('ok');
    expect(r.items.find((i) => i.id === 'pick.album')?.status).toBe('ok');
    expect(r.flags.pickOk).toBe('ok');
  });

  it('两条选择 API 都缺 ⇒ fail；都在 ⇒ ok', async () => {
    const empty = await runSelfCheck(null, { plus: FAKE_PLUS, pick: {} });
    expect(empty.flags.pickOk).toBe('fail');
    const full = await runSelfCheck(null, { plus: FAKE_PLUS, pick: FAKE_PICK });
    expect(full.flags.pickOk).toBe('ok');
  });
});