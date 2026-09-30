/**
 * 块上传 / 取回（本册 §3 / §5.2）：封面与附件先 `POST /v1/blob` 拿 `blob_id`，
 * 再把 `attr.cover` / `attr.attachment` 行写进容器投稿。
 *
 * 只依赖注入的 `Adapters` / `LocalRepo` 与 `core/identity`，不 import 'uni'，
 * 因此可在 Node 下用 `core/fakes.ts` 完整测试（与 core/submit.ts 同一约定）。
 */
import { bytesToHex, randomBytes, utf8 } from '@base/protocol-ts';

import type { Adapters } from '../platform/adapter';
import { CommentError, ensureRegistered, type CommentOptions } from './comment';
import { errorCodeOf, errorText } from './errors';
import { signRequestHeaders } from './identity';
import { decodeUtf8 } from './sync';

/** 与 `core/comment.ts` 同一组依赖（同一套 `ensureRegistered`）。 */
export type BlobOptions = CommentOptions;

/** 单请求上限 8 MiB——与节点 `maxBlobBytes` 同值（本册 §3）。 */
export const MAX_BLOB_BYTES = 8 << 20;

/** 上传 / 取回失败的用户可读错误；`rejected` = 节点明确拒绝（4xx）。 */
export class BlobError extends Error {
  constructor(
    readonly code: 'client' | 'network' | 'rejected' | 'server',
    message: string,
  ) {
    super(message);
    this.name = 'BlobError';
  }
}

/** 造 `multipart/form-data` 单块体：字段名固定 `file`（与节点 `handleBlobPost` 同契约）。 */
export function buildMultipartBody(boundary: string, filename: string, data: Uint8Array): Uint8Array {
  const head = utf8(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
      'Content-Type: application/octet-stream\r\n\r\n',
  );
  const tail = utf8(`\r\n--${boundary}--\r\n`);
  const out = new Uint8Array(head.length + data.length + tail.length);
  out.set(head, 0);
  out.set(data, head.length);
  out.set(tail, head.length + data.length);
  return out;
}

/**
 * 上传一块，返回节点算出的 `blob_id`（内容寻址：同字节重复上传返回同一 id，块只落一份）。
 * 封面 / 附件的调用方随后把该 id 写进 `attr.cover` / `attr.attachment`。
 */
export async function uploadBlob(o: BlobOptions, data: Uint8Array, filename: string): Promise<string> {
  if (o.nodeBaseUrl === '') throw new BlobError('client', '未配置节点地址，无法上传');
  if (data.length === 0) throw new BlobError('client', '文件内容为空');
  if (data.length > MAX_BLOB_BYTES) throw new BlobError('client', '文件超过 8 MiB');

  let ident;
  try {
    ident = await ensureRegistered(o);
  } catch (e) {
    if (e instanceof CommentError) {
      throw new BlobError(e.code === 'network' ? 'network' : 'client', e.message);
    }
    throw new BlobError('client', `身份准备失败：${(e as Error).message ?? String(e)}`);
  }

  const boundary = `----base${bytesToHex(randomBytes(12))}`;
  const body = buildMultipartBody(boundary, filename, data);

  let headers;
  try {
    headers = signRequestHeaders(ident, { method: 'POST', path: '/v1/blob', body });
  } catch (e) {
    throw new BlobError('client', `签名请求失败：${(e as Error).message ?? String(e)}`);
  }

  let res;
  try {
    res = await o.adapters.http.post(`${o.nodeBaseUrl}/v1/blob`, body, {
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
      ...headers,
    });
  } catch {
    throw new BlobError('network', '无法连接节点，请稍后重试');
  }
  if (res.status !== 200) throw mapBlobFailure(res.status, decodeUtf8(res.body));

  const out = JSON.parse(decodeUtf8(res.body)) as { blob_id?: string };
  const blobId = String(out.blob_id ?? '');
  if (blobId === '') throw new BlobError('server', '节点未返回 blob_id');
  return blobId;
}

/** 取回一块的明文字节（课时页的「附件另存」用，本册 §5.2）。 */
export async function fetchBlob(o: BlobOptions, blobId: string): Promise<Uint8Array> {
  let res;
  try {
    res = await o.adapters.http.get(`${o.nodeBaseUrl}/v1/blob/${blobId}`);
  } catch {
    throw new BlobError('network', '无法连接节点，请稍后重试');
  }
  if (res.status !== 200) throw new BlobError('server', `读取附件失败（HTTP ${res.status}）`);
  return res.body;
}

/** 节点错误码 → 用户可读错误（码表在 `core/errors.ts`，本文件只补 blob 专有文案）。 */
function mapBlobFailure(status: number, raw: string): BlobError {
  const code = errorCodeOf(raw);
  if (code === 'blob_too_large') return new BlobError('rejected', '上传块超过 8 MiB');
  const message = errorText(code, `上传失败（HTTP ${status}）`);
  return new BlobError(status >= 400 && status < 500 ? 'rejected' : 'server', message);
}