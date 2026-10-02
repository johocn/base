import { utf8 } from '@base/protocol-ts';
import { describe, expect, it } from 'vitest';

import { MAX_BLOB_BYTES, buildMultipartBody, fetchBlob, uploadBlob, type BlobOptions } from './blob';
import { FakeHttp, FakePackReader, MemoryFs, MemoryRepo, fakeAdapters } from './fakes';
import { decodeUtf8 } from './sync';

const BASE = 'https://node.test';

function json(v: unknown) {
  return { status: 200, body: utf8(JSON.stringify(v)) };
}

function fixture() {
  const http = new FakeHttp();
  const repo = new MemoryRepo();
  const adapters = fakeAdapters(http, new MemoryFs(), new FakePackReader());
  const o: BlobOptions = { adapters, repo, nodeBaseUrl: BASE };
  http.postRoutes.set(`${BASE}/v1/identity/register`, json({}));
  return { http, repo, o };
}

describe('blob 上传', () => {
  it('multipart 体：字段名 file、边界闭合、字节可逐段还原', () => {
    const body = buildMultipartBody('BOUND', 'a.txt', utf8('hi'));
    expect(decodeUtf8(body)).toBe(
      '--BOUND\r\nContent-Disposition: form-data; name="file"; filename="a.txt"\r\n' +
        'Content-Type: application/octet-stream\r\n\r\nhi\r\n--BOUND--\r\n',
    );
  });

  it('上传：先补登记，再带签名头 POST；Content-Type 带同一 boundary，返回节点算的 blob_id', async () => {
    const { http, o } = fixture();
    const want = 'a'.repeat(32);
    http.postRoutes.set(`${BASE}/v1/blob`, json({ blob_id: want, size: 2 }));

    expect(await uploadBlob(o, utf8('hi'), 'a.txt')).toBe(want);
    expect(http.posted.map((p) => p.url)).toEqual([`${BASE}/v1/identity/register`, `${BASE}/v1/blob`]);

    const wire = http.posted[1]!;
    const ct = wire.headers['Content-Type'] ?? '';
    expect(ct.startsWith('multipart/form-data; boundary=')).toBe(true);
    const boundary = ct.slice('multipart/form-data; boundary='.length);
    expect(decodeUtf8(wire.body).startsWith(`--${boundary}\r\n`)).toBe(true);
    expect(wire.headers['X-Base-Sig']).toBeTruthy();
  });

  it('本地拦截：空文件与超限不发请求', async () => {
    const { http, o } = fixture();
    await expect(uploadBlob(o, new Uint8Array(0), 'a.txt')).rejects.toThrow('文件内容为空');
    await expect(uploadBlob(o, new Uint8Array(MAX_BLOB_BYTES + 1), 'a.bin')).rejects.toThrow('文件超过 8 MiB');
    expect(http.posted).toHaveLength(0);
  });

  it('节点 413 blob_too_large → 可读错误', async () => {
    const { http, o } = fixture();
    http.postRoutes.set(`${BASE}/v1/blob`, { status: 413, body: utf8(JSON.stringify({ code: 'blob_too_large' })) });
    await expect(uploadBlob(o, utf8('x'), 'a.txt')).rejects.toThrow('上传块超过 8 MiB');
  });

  it('未配置节点：不发请求', async () => {
    const { http, o } = fixture();
    o.nodeBaseUrl = '';
    await expect(uploadBlob(o, utf8('x'), 'a.txt')).rejects.toThrow('未配置节点地址，无法上传');
    expect(http.posted).toHaveLength(0);
  });
});

describe('blob 取回', () => {
  it('GET /v1/blob/{id} 原样返回字节', async () => {
    const { http, o } = fixture();
    const id = 'b'.repeat(32);
    http.routes.set(`${BASE}/v1/blob/${id}`, { status: 200, body: utf8('附件正文') });
    expect(decodeUtf8(await fetchBlob(o, id))).toBe('附件正文');
  });

  it('非 2xx → 可读错误', async () => {
    const { http, o } = fixture();
    await expect(fetchBlob(o, 'c'.repeat(32))).rejects.toThrow('读取附件失败（HTTP 404）');
  });
});