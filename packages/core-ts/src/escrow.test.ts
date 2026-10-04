import { describe, expect, it } from 'vitest';

import { utf8, bytesToHex } from '@base/protocol-ts';

import { FakeHttp, FakePackReader, MemoryFs, MemoryRepo, fakeAdapters } from './fakes';
import { IDENTITY_REGISTERED_KEY } from './comment';
import {
  EscrowError,
  fetchEscrow,
  restoreEscrow,
  restoreFromBackup,
  setupEscrow,
  type EscrowOptions,
} from './escrow';
import {
  buildEscrowPayload,
  createIdentity,
  openEscrowPayload,
  signRequestHeaders,
} from './identity';

const BASE = 'https://node.test';
const TEST_USER = 'alice_test_01';
const TEST_PASS = 'correcthorsebatterystaple';

function json(v: unknown) {
  return { status: 200, body: utf8(JSON.stringify(v)) };
}

function fixture() {
  const http = new FakeHttp();
  const repo = new MemoryRepo();
  const adapters = fakeAdapters(http, new MemoryFs(), new FakePackReader());
  const o: EscrowOptions = { adapters, repo, nodeBaseUrl: BASE };
  return { http, repo, adapters, o };
}

function nodeRegisterAccepts(http: FakeHttp) {
  http.postRoutes.set(`${BASE}/v1/identity/register`, json({ ok: true }));
}

function escrowAcceptPut(http: FakeHttp) {
  http.putRoutes.set(`${BASE}/v1/identity/escrow/${TEST_USER}`, json({ username: TEST_USER, updated_at: Date.now() }));
}

function escrowConflictOnPut(http: FakeHttp) {
  http.putRoutes.set(`${BASE}/v1/identity/escrow/${TEST_USER}`, {
    status: 409,
    body: utf8(JSON.stringify({ error: 'escrow_conflict', code: 'escrow_conflict' })),
  });
}

describe('setupEscrow', () => {
  it('成功绑定：本地身份 + 密码 → PUT escrow', async () => {
    const { http, repo, adapters, o } = fixture();
    escrowAcceptPut(http);

    await setupEscrow(o, TEST_USER, TEST_PASS);

    // PUT 调用被记录
    expect(http.putCalls.length).toBe(1);
    const call = http.putCalls[0]!;
    expect(call.url).toBe(`${BASE}/v1/identity/escrow/${TEST_USER}`);
    expect(call.headers['Content-Type']).toBe('application/json');
    // 有签名头
    expect(call.headers['X-Base-Id']).toBeTruthy();
    expect(call.headers['X-Base-Sig']).toBeTruthy();

    // 本地确实有身份了
    const kekHex = await adapters.storage.get('identity.device_kek');
    expect(kekHex).toBeTruthy();
    const metaRaw = await adapters.storage.get('identity.meta');
    expect(metaRaw).toBeTruthy();
  });

  it('用户名不合法（空格/太短/含大写+数字以外） → 客户端拒绝，不发请求', async () => {
    const { http, o } = fixture();
    await expect(setupEscrow(o, 'ab', TEST_PASS)).rejects.toMatchObject({ code: 'client' });
    await expect(setupEscrow(o, 'alice test', TEST_PASS)).rejects.toMatchObject({ code: 'client' });
    expect(http.putCalls.length).toBe(0);
  });

  it('密码太短 → 客户端拒绝', async () => {
    const { http, o } = fixture();
    await expect(setupEscrow(o, TEST_USER, '12')).rejects.toMatchObject({ code: 'client' });
    expect(http.putCalls.length).toBe(0);
  });

  it('节点返回 409 escrow_conflict → EscrowError.conflict', async () => {
    const { http, o } = fixture();
    escrowConflictOnPut(http);
    await expect(setupEscrow(o, TEST_USER, TEST_PASS)).rejects.toMatchObject({ code: 'conflict' });
  });

  it('网络不可达 → EscrowError.network', async () => {
    const { http, o } = fixture();
    // 不设 putRoutes，让 FakeHttp 在调用时抛错——FakeHttp 不会抛，只会返回 404
    // 所以这里我们手动 gate
    const real = http.put.bind(http);
    http.put = async () => { throw new Error('断网'); };
    await expect(setupEscrow(o, TEST_USER, TEST_PASS)).rejects.toMatchObject({ code: 'network' });
    http.put = real;
  });
});

describe('fetchEscrow', () => {
  it('成功取回托管密文 → EscrowPayload 可用于 openEscrowPayload', async () => {
    const { http, o, adapters } = fixture();
    // 先在本地生成一个身份并构造 payload，作为节点返回值
    const ident = createIdentity();
    const payload = buildEscrowPayload(ident, TEST_PASS);
    http.routes.set(
      `${BASE}/v1/identity/escrow/${TEST_USER}`,
      json({
        username: TEST_USER, id: payload.id, alg: payload.alg, salt: payload.salt,
        kdf: payload.kdf, enc_nonce: payload.encNonce, priv_cipher: payload.privCipher,
        updated_at: Date.now(),
      }),
    );

    const got = await fetchEscrow(o, TEST_USER);
    expect(got.id).toBe(ident.id);
    expect(got.salt).toBe(payload.salt);

    // 解密出来 = 原身份
    const restored = openEscrowPayload(got, TEST_PASS);
    expect(restored.id).toBe(ident.id);
    expect(restored.pubHex).toBe(ident.pubHex);
  });

  it('用户名未托管 → EscrowError.not_found', async () => {
    const { http, o } = fixture();
    http.routes.set(`${BASE}/v1/identity/escrow/nobody`, { status: 404, body: utf8(JSON.stringify({ code: 'escrow_not_found' })) });
    await expect(fetchEscrow(o, 'nobody')).rejects.toMatchObject({ code: 'not_found' });
  });
});

describe('restoreEscrow（端到端）', () => {
  it('完整链路：fetch → 解密 → 落本地 → 登记公钥', async () => {
    const { http, o, adapters } = fixture();
    nodeRegisterAccepts(http);

    const ident = createIdentity();
    const payload = buildEscrowPayload(ident, TEST_PASS);
    http.routes.set(
      `${BASE}/v1/identity/escrow/${TEST_USER}`,
      json({
        username: TEST_USER, id: payload.id, alg: payload.alg, salt: payload.salt,
        kdf: payload.kdf, enc_nonce: payload.encNonce, priv_cipher: payload.privCipher,
        updated_at: Date.now(),
      }),
    );

    const restored = await restoreEscrow(o, TEST_USER, TEST_PASS);
    expect(restored.id).toBe(ident.id);

    // 本地确实落盘了
    const metaRaw = await adapters.storage.get('identity.meta');
    expect(metaRaw).toBeTruthy();
    const meta = JSON.parse(metaRaw!) as { id: string };
    expect(meta.id).toBe(ident.id);

    // 公钥登记被触发
    expect(http.posted.some((p) => p.url.endsWith('/v1/identity/register'))).toBe(true);
  });

  it('密码错误 → EscrowError.password', async () => {
    const { http, o } = fixture();

    const ident = createIdentity();
    const payload = buildEscrowPayload(ident, TEST_PASS);
    http.routes.set(
      `${BASE}/v1/identity/escrow/${TEST_USER}`,
      json({
        username: TEST_USER, id: payload.id, alg: payload.alg, salt: payload.salt,
        kdf: payload.kdf, enc_nonce: payload.encNonce, priv_cipher: payload.privCipher,
      }),
    );

    // wrongpass ≠ TEST_PASS → openEscrowPayload 应抛错
    await expect(restoreEscrow(o, TEST_USER, 'wrongpass')).rejects.toMatchObject({ code: 'password' });
  });
});

describe('restoreFromBackup', () => {
  it('粘贴 64 位 hex 备份串 → 直接恢复，不依赖节点', async () => {
    const { http, o, adapters } = fixture();
    nodeRegisterAccepts(http);

    const ident = createIdentity();
    const backup = ident.seedHex;

    const restored = await restoreFromBackup(o, backup);
    expect(restored.id).toBe(ident.id);
    expect(restored.pubHex).toBe(ident.pubHex);

    const metaRaw = await adapters.storage.get('identity.meta');
    const meta = JSON.parse(metaRaw!) as { id: string };
    expect(meta.id).toBe(ident.id);
  });

  it('备份串格式非法（长度不对） → EscrowError.client', async () => {
    const { o } = fixture();
    await expect(restoreFromBackup(o, 'abc123')).rejects.toMatchObject({ code: 'client' });
    await expect(restoreFromBackup(o, 'g'.repeat(64))).rejects.toMatchObject({ code: 'client' }); // 含非 hex
  });
});
