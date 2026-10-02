// 逐行对齐 internal/httpapi/content.go 的 handleBlob / handleBlobHead（:84-142）。
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { ServerHandler } from "@base/core-ts";
import { blobId, isBlobId } from "@base/protocol-ts";
import type { Db } from "../db";
import { decrypt } from "../host/aesgcm";
import { jsonResponse } from "./json";

/** 对齐 store.BlobPath：`<dataDir>/blobs/<前2>/<3-4>/<blob_id>`。 */
function blobPath(dataDir: string, blobID: string): string {
  return join(dataDir, "blobs", blobID.slice(0, 2), blobID.slice(2, 4), blobID);
}

export interface BlobDeps {
  dataDir?: string;
  /** 未提供 dataDir 时为 null，按「块不存在」404 处理。 */
  storeKey: Uint8Array | null;
}

/** handleBlob：读块文件 → AES-GCM 解密 → 重算哈希 → 返回明文。 */
export function blobGetHandler(deps: BlobDeps): ServerHandler {
  return async (req) => {
    const blobID = req.params.blob_id ?? "";
    if (!isBlobId(blobID)) {
      return jsonResponse(400, { error: "非法 blob_id" });
    }
    if (deps.dataDir === undefined || deps.storeKey === null) {
      return jsonResponse(404, { error: "块不存在" });
    }

    let raw: Buffer;
    try {
      raw = readFileSync(blobPath(deps.dataDir, blobID));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return jsonResponse(404, { error: "块不存在" });
      }
      return jsonResponse(500, { error: String(err) });
    }

    let data: Uint8Array;
    try {
      data = decrypt(deps.storeKey, new Uint8Array(raw));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return jsonResponse(500, { error: `store: decrypt blob ${blobID}: ${msg}` });
    }
    if (blobId(data) !== blobID) {
      return jsonResponse(500, { error: "块内容与哈希不符" });
    }

    const headers = {
      "Content-Type": "application/octet-stream",
      "Content-Length": String(data.byteLength),
      ETag: `"${blobID}"`,
      "Cache-Control": "public, max-age=31536000, immutable",
    };
    if ((req.headers["if-none-match"] ?? "") === `"${blobID}"`) {
      return { status: 304, headers, body: new Uint8Array(0) };
    }
    return { status: 200, headers, body: data };
  };
}

/**
 * handleBlobHead：只做存在性判定，不读文件内容。
 * size 取自 blobs 表（明文大小），**不是** os.stat 的密文大小（多 28 字节）。
 */
export function blobHeadHandler(db: Db, deps: { dataDir?: string }): ServerHandler {
  return async (req) => {
    const blobID = req.params.blob_id ?? "";
    if (!isBlobId(blobID)) {
      return jsonResponse(400, { error: "非法 blob_id" });
    }
    if (deps.dataDir === undefined) {
      return jsonResponse(404, { error: "块不存在" });
    }

    // HasBlob：先查 blobs 表拿明文 size，再确认文件存在。
    let size: unknown;
    try {
      const rows = db.select(`SELECT size FROM blobs WHERE blob_id=?`, [blobID]);
      if (rows.length === 0) {
        return jsonResponse(404, { error: "块不存在" });
      }
      size = rows[0].size;
    } catch (err) {
      return jsonResponse(500, { error: String(err) });
    }
    try {
      statSync(blobPath(deps.dataDir, blobID));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return jsonResponse(404, { error: "块不存在" });
      }
      return jsonResponse(500, { error: String(err) });
    }

    return {
      status: 200,
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Length": String(size),
        ETag: `"${blobID}"`,
        "Cache-Control": "public, max-age=31536000, immutable",
      },
    };
  };
}
