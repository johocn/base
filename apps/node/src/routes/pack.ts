// 逐行对齐 internal/httpapi/content.go 的 handlePack（:57-82）。
import { join } from "node:path";
import type { ServerHandler } from "@base/core-ts";
import type { Db } from "../db";
import { fileResponse, jsonResponse } from "./json";

const PACK_ID_PATTERN = /^[0-9a-f]{32}$/;

function packFilePath(db: Db, packID: string, name: string): string | null {
  let rows: Record<string, unknown>[];
  try {
    rows = db.select(`SELECT dir FROM packs WHERE pack_id=?`, [packID]);
  } catch {
    return null;
  }
  if (rows.length === 0) return null;
  const dir = rows[0].dir == null ? "" : String(rows[0].dir);
  return join(dir, name);
}

export function packHandler(db: Db): ServerHandler {
  return async (req) => {
    const packID = req.params.pack_id ?? "";
    if (!PACK_ID_PATTERN.test(packID)) {
      return jsonResponse(400, { error: "非法 pack_id" });
    }
    const path = packFilePath(db, packID, "pack.sqlite");
    if (path === null) {
      return jsonResponse(404, { error: "包未登记" });
    }
    return fileResponse(path, "application/vnd.sqlite3", true, "pack 文件不存在");
  };
}
