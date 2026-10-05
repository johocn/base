import { describe, expect, it } from 'vitest';

import { requestSignBytes, sha256Hex, utf8, verify, type RequestMeta } from '@base/protocol-ts';

import { FakeHttp, FakePackReader, MemoryFs, MemoryRepo, fakeAdapters } from './fakes';
import { myIdentityId, putName, roster, ContributionError, type ContributionOptions } from './contribution';
import { decodeUtf8 } from './sync';

const BASE = 'https://node.test';

function json(v: unknown) {
  return { status: 200, body: utf8(JSON.stringify(v)) };
}

function fixture() {
  const http = new FakeHttp();
  const repo = new MemoryRepo();
  const o: ContributionOptions = { adapters: fakeAdapters(http, new MemoryFs(), new FakePackReader()), repo, nodeBaseUrl: BASE };
  return { http, repo, o };
}

describe('contribution', () => {
  it('名册：字段映射；空名册返回 []', async () => {
    const { http, o } = fixture();
    http.routes.set(`${BASE}/v1/contributors`, json({ contributors: [{ id: 'a'.repeat(64), name: '甲', count: 3 }] }));
    expect(await roster(o)).toEqual([{ id: 'a'.repeat(64), name: '甲', count: 3 }]);
    http.routes.set(`${BASE}/v1/contributors`, json({ contributors: [] }));
    expect(await roster(o)).toEqual([]);
  });

  it('名册：断网 → ContributionError(network)', async () => {
    const { o } = fixture();
    o.adapters.http = { get: () => Promise.reject(new Error('断网')), post: () => Promise.reject(new Error('断网')), put: () => Promise.reject(new Error('断网')) };
    const err = (await roster(o).catch((e: unknown) => e)) as ContributionError;
    expect(err.code).toBe('network');
    expect(err.message).toBe('需要联网才能查看名册');
  });

  it('写昵称：请求体只有 name、不带 id；签名头可被节点按同一字节重建', async () => {
    const { http, o } = fixture();
    http.postRoutes.set(`${BASE}/v1/identity/register`, json({}));
    http.postRoutes.set(`${BASE}/v1/profile`, json({ id: 'x', name: '甲' }));
    await putName(o, '甲');

    const wire = http.posted[1]!;
    expect(decodeUtf8(wire.body)).toBe('{"name":"甲"}');
    expect(decodeUtf8(wire.body).includes('"id"')).toBe(false);

    const h = wire.headers;
    const meta: RequestMeta = {
      method: 'POST', path: '/v1/profile', query: '', bodySha256: sha256Hex(wire.body),
      ts: Number(h['X-Base-Ts']), nonce: h['X-Base-Nonce']!,
    };
    const reg = http.posted[0]!;
    const pub = (JSON.parse(decodeUtf8(reg.body)) as { pubkey: string }).pubkey;
    expect(verify(pub, requestSignBytes(meta), h['X-Base-Sig']!)).toBe(true);
  });

  it('写昵称失败：profile_name_invalid → 中文提示', async () => {
    const { http, o } = fixture();
    http.postRoutes.set(`${BASE}/v1/identity/register`, json({}));
    http.postRoutes.set(`${BASE}/v1/profile`, { status: 400, body: utf8(JSON.stringify({ code: 'profile_name_invalid' })) });
    const err = (await putName(o, '').catch((e: unknown) => e)) as ContributionError;
    expect(err.code).toBe('rejected');
    expect(err.message).toBe('昵称需 1–32 字且不含控制字符');
  });

  it('myIdentityId：本机无身份返回空串', async () => {
    const { o } = fixture();
    expect(await myIdentityId(o)).toBe('');
  });
});