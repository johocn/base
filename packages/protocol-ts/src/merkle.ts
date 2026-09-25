import { concatBytes, bytesToHex } from "@noble/hashes/utils";

import { isBlobId, sha256Sum, utf8 } from "./hash";

/** 校验并返回去重、按 ASCII 升序排序后的 blob_id 列表。 */
export function normalizeBlobIds(blobIds: readonly string[]): string[] {
  const set = new Set<string>();
  for (const id of blobIds) {
    if (!isBlobId(id)) throw new Error(`invalid blob id ${JSON.stringify(id)}`);
    set.add(id);
  }
  return [...set].sort();
}

/** Merkle 根（契约第 8 条）。 */
export function merkleRoot(blobIds: readonly string[]): string {
  const ids = normalizeBlobIds(blobIds);
  if (ids.length === 0) return bytesToHex(sha256Sum(utf8("merkle:empty")));
  let level = ids.map((id) => sha256Sum(utf8("leaf:" + id)));
  while (level.length > 1) {
    const next: Uint8Array[] = [];
    for (let i = 0; i < level.length; i += 2) {
      if (i + 1 === level.length) {
        next.push(level[i]); // 奇数末项直接提升
        continue;
      }
      next.push(sha256Sum(concatBytes(utf8("node:"), level[i], level[i + 1])));
    }
    level = next;
  }
  return bytesToHex(level[0]);
}