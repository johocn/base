import { isBlobId } from "./hash";

/** POST /v1/fetch 的响应类型（契约 §5.2）。 */
export const BLOB_PACK_CONTENT_TYPE = "application/x-base-blobpack";

/** 帧头 = blob_id(32 字节 ASCII) + size(8 字节大端)。 */
export const BLOB_FRAME_HEADER_SIZE = 40;

/**
 * 单次 fetch 的**总字节**上限（契约 §5.3：64 块 × 1 MiB）。
 * 服务端超限回 413；调用方切批按「块数 ≤ BASE_FETCH_MAX_BLOBS 且累计 size ≤ 本值」。
 */
export const FETCH_MAX_BYTES = 64 << 20;

/**
 * 单帧 payload 上限，只用于拒绝畸形帧头。
 * 不取 1 MiB：封面等「整块」资源本身就可以大于一个视频分块。
 */
export const MAX_BLOB_FRAME_SIZE = 1 << 30;

/** 写一帧：blob_id(32 ASCII) || size(8 大端) || payload。非法 id 或 payload 超限抛 `Error`。 */
export function writeBlobFrame(blobId: string, payload: Uint8Array): Uint8Array {
  if (!isBlobId(blobId)) {
    throw new Error(`blobpack: invalid blob id ${JSON.stringify(blobId)}`);
  }
  if (payload.length > MAX_BLOB_FRAME_SIZE) {
    throw new Error(`blobpack: payload ${payload.length} 字节超过单帧上限`);
  }
  const out = new Uint8Array(BLOB_FRAME_HEADER_SIZE + payload.length);
  for (let i = 0; i < 32; i++) out[i] = blobId.charCodeAt(i);
  let size = payload.length;
  for (let i = 7; i >= 0; i--) {
    out[32 + i] = size & 0xff;
    size = Math.floor(size / 256);
  }
  out.set(payload, BLOB_FRAME_HEADER_SIZE);
  return out;
}

/**
 * 读一帧；缓冲读尽（`offset >= buf.length`）返回 `null`（等价 Go 的 io.EOF）。
 * 半截帧头 / 非法 `blob_id` / `size > MAX_BLOB_FRAME_SIZE` / 正文截断均抛 `Error`。
 * 帧缺失即「对端没有该块」，调用方以「缺哪些帧」为准，不做占位帧（契约 §5.2）。
 */
export function readBlobFrame(
  buf: Uint8Array,
  offset: number,
): { blobId: string; payload: Uint8Array; next: number } | null {
  if (offset >= buf.length) return null;
  if (offset + BLOB_FRAME_HEADER_SIZE > buf.length) {
    throw new Error("blobpack: 半截帧头（等价 io.ErrUnexpectedEOF）");
  }
  let blobId = "";
  for (let i = 0; i < 32; i++) blobId += String.fromCharCode(buf[offset + i]);
  if (!isBlobId(blobId)) {
    throw new Error(`blobpack: 帧头 blob_id 非法 ${JSON.stringify(blobId)}`);
  }
  let size = 0;
  for (let i = 0; i < 8; i++) {
    size = size * 256 + buf[offset + 32 + i];
    if (size > MAX_BLOB_FRAME_SIZE) break;
  }
  if (size > MAX_BLOB_FRAME_SIZE) {
    throw new Error(`blobpack: 帧声明 size=${size} 超过单帧上限`);
  }
  if (offset + BLOB_FRAME_HEADER_SIZE + size > buf.length) {
    throw new Error(`blobpack: 读帧体 ${blobId}(size=${size}) 正文截断`);
  }
  const start = offset + BLOB_FRAME_HEADER_SIZE;
  const next = start + size;
  return { blobId, payload: buf.slice(start, next), next };
}
