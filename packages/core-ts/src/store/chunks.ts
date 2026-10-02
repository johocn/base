/**
 * 声明块序列的**纯算法**（对齐 `internal/store/blobs.go:125-160`）：
 * `chunk_hashes_json` 下标即 seq，长度 = ceil(size / chunk_size)；末块按剩余字节截断。
 */
import { isBlobId } from "@base/protocol-ts";

import type { BlobRef, MediaMeta } from "./types";

/**
 * 把声明的块 id 归一为 32 字符 blob_id：存量封面路径写的是 sha256 的 64 字符全量，
 * 其前 32 字符就是真正的 blob_id；视频路径写的就是 blob_id 本身。只归一，不改存量数据。
 */
export function normalizeChunkID(s: string): string {
  return s.length === 64 ? s.slice(0, 32) : s;
}

/** `DeclaredChunks`：返回条目的声明块序列；块 id 非法或 media_meta 缺失即抛错。 */
export function declaredChunks(itemId: string, meta: MediaMeta): BlobRef[] {
  const out: BlobRef[] = [];
  meta.chunkHashes.forEach((raw, seq) => {
    const blobId = normalizeChunkID(raw);
    if (!isBlobId(blobId)) {
      throw new Error(
        `store: media_meta ${itemId} 第 ${seq} 块的 id ${JSON.stringify(raw)} 不是 blob_id`,
      );
    }
    let size = meta.chunkSize;
    const rest = meta.size - seq * meta.chunkSize;
    if (rest > 0 && rest < size) size = rest;
    out.push({ blobId, seq, size });
  });
  return out;
}
