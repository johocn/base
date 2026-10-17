import { describe, expect, it } from 'vitest';
import {
  blobId,
  deriveIdentityId,
  keyPairFromSeed,
  signMeshCatalog,
  utf8,
  type MeshCatalogEntry,
} from '@base/protocol-ts';

import { FakeHttp } from '../fakes';
import type { HttpAdapter, HttpResponse } from '../platform/adapter';
import { MeshClient } from './client';

const BASE = 'https://node.test';
const SEED = '9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60';
const PUB = keyPairFromSeed(SEED).pubHex;
const OTHER_PUB = keyPairFromSeed('4ccd089b28ff96da9db6c346ec114e0f5b8a319f35aba624da8cf6ed4fb8a6fb').pubHex;
const NODE_ID = deriveIdentityId(PUB);

function json(v: unknown): HttpResponse {
  return { status: 200, body: utf8(JSON.stringify(v)) };
}

describe('MeshClient.hello', () => {
  it('403 → mesh_token_rejected', async () => {
    const http = new FakeHttp();
    http.routes.set(`${BASE}/mesh/v1/hello?token=t`, { status: 403, body: new Uint8Array() });
    await expect(new MeshClient(http).hello(BASE, 't')).rejects.toThrow('mesh_token_rejected');
  });
});

describe('MeshClient.pullCatalog', () => {
  const ALL: MeshCatalogEntry[] = [
    { item_id: 'article/a', rev: 1, content_hash: 'aa'.repeat(32), size: 10 },
    { item_id: 'article/b', rev: 2, content_hash: 'bb'.repeat(32), size: 20 },
    { item_id: 'article/c', rev: 3, content_hash: 'cc'.repeat(32), size: 30 },
  ];
  // 签名对象恒为全量 entries（执行期定案 3）：每页只带分片 + 同一签名，客户端拼完再验
  const doc = signMeshCatalog({
    type: 'mesh-catalog', v: 1, node_id: NODE_ID, catalog_version: 7,
    entries: ALL, signed_at: '2026-10-17T00:00:00Z',
  }, SEED);

  function threePages(tamper?: (e: MeshCatalogEntry) => MeshCatalogEntry): FakeHttp {
    const page = (entries: MeshCatalogEntry[], next: string | null) => ({
      node_id: doc.node_id, catalog_version: doc.catalog_version,
      signed_at: doc.signed_at, signature: doc.signature, entries, next_cursor: next,
    });
    const http = new FakeHttp();
    http.routes.set(`${BASE}/mesh/v1/catalog?token=t`, json(page([ALL[0]], 'article/a')));
    http.routes.set(
      `${BASE}/mesh/v1/catalog?token=t&cursor=article/a`,
      json(page([tamper ? tamper(ALL[1]) : ALL[1]], 'article/b')),
    );
    http.routes.set(
      `${BASE}/mesh/v1/catalog?token=t&cursor=article/b`,
      json(page([tamper ? tamper(ALL[2]) : ALL[2]], null)),
    );
    return http;
  }

  it('三页拼接后全量验签成功', async () => {
    const got = await new MeshClient(threePages()).pullCatalog(BASE, 't', [PUB]);
    expect(got.entries).toEqual(ALL);
    expect(got.node_id).toBe(NODE_ID);
    expect(got.catalog_version).toBe(7);
  });

  it('篡改任一页 entries → 拼接后验签失败', async () => {
    const http = threePages((e) => ({ ...e, size: e.size + 1 }));
    await expect(new MeshClient(http).pullCatalog(BASE, 't', [PUB])).rejects.toThrow('mesh_catalog_sig_invalid');
  });

  it('验签集合内公钥不匹配 → 拒绝', async () => {
    await expect(new MeshClient(threePages()).pullCatalog(BASE, 't', [OTHER_PUB])).rejects.toThrow(
      'mesh_catalog_sig_invalid',
    );
  });
});

describe('MeshClient.fetchBlob', () => {
  const bytes = utf8('块内容-近场分享');
  const id = blobId(bytes);
  const bad = utf8('坏块内容');

  /** 应答出队式 fake：第 n 次 get 弹出第 n 个应答，记录调用数验证「只重拉一次」。 */
  class QueueHttp implements HttpAdapter {
    calls = 0;
    private queue: HttpResponse[] = [];
    push(...res: HttpResponse[]): void {
      this.queue.push(...res);
    }
    async get(_url: string, _headers?: Record<string, string>): Promise<HttpResponse> {
      this.calls++;
      const r = this.queue.shift();
      if (!r) throw new Error('测试应答队列已空');
      return r;
    }
    async post(): Promise<HttpResponse> {
      throw new Error('未使用');
    }
    async put(): Promise<HttpResponse> {
      throw new Error('未使用');
    }
  }

  it('首拉坏块，重拉一次后成功', async () => {
    const http = new QueueHttp();
    http.push({ status: 200, body: bad }, { status: 200, body: bytes });
    const got = await new MeshClient(http).fetchBlob(BASE, 't', id);
    expect(got).toEqual(bytes);
    expect(http.calls).toBe(2);
  });

  it('两次都坏 → 抛 mesh_blob_invalid（调用方标记坏块跳过）', async () => {
    const http = new QueueHttp();
    http.push({ status: 200, body: bad }, { status: 200, body: bad });
    await expect(new MeshClient(http).fetchBlob(BASE, 't', id)).rejects.toThrow('mesh_blob_invalid');
    expect(http.calls).toBe(2);
  });

  it('非 200 同样算失败，只重拉一次', async () => {
    const http = new QueueHttp();
    http.push({ status: 404, body: new Uint8Array() }, { status: 404, body: new Uint8Array() });
    await expect(new MeshClient(http).fetchBlob(BASE, 't', id)).rejects.toThrow('mesh_blob_invalid');
    expect(http.calls).toBe(2);
  });
});
