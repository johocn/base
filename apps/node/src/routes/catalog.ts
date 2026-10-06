// 逐行对齐 internal/httpapi/public.go 的 handleCatalog（:41-110）。
import type { ServerHandler, ServerResponse } from "@base/core-ts";
import type { Db } from "../db";
import { likeCountsByTargets } from "../store/like";

const encoder = new TextEncoder();

interface CatalogItem {
  item_id: string;
  source: string;
  type: string;
  title: string;
  content_hash: string;
  source_rev: string;
  like_count: number;
}

interface CatalogResponse {
  pack_id: string;
  content_version: number;
  items: CatalogItem[];
  next_cursor: string | null;
}

function jsonResponse(status: number, payload: unknown): ServerResponse {
  return {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
    body: encoder.encode(`${JSON.stringify(payload)}\n`),
  };
}

function toStr(value: unknown): string {
  return value == null ? "" : String(value);
}

function toInt(value: unknown): number {
  return typeof value === "number" ? value : Number(value ?? 0);
}

/** 对齐 strconv.Atoi / ParseInt：整串必须是可选符号 + 十进制数字。 */
function parseDecimal(raw: string): number | null {
  if (!/^[+-]?[0-9]+$/.test(raw)) return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) ? n : null;
}

export function catalogHandler(db: Db): ServerHandler {
  return async (req) => {
    try {
      const limitRaw = req.query.limit ?? "";
      let limit = 200;
      if (limitRaw !== "") {
        const n = parseDecimal(limitRaw);
        if (n !== null && n > 0 && n <= 1000) limit = n;
      }

      let version = 0;
      let packID = "";
      const packRows = db.select(
        `SELECT pack_id,content_version,dir,merkle_root,signature,issued_at,item_count,created_at
			FROM packs ORDER BY content_version DESC, created_at DESC LIMIT 1`,
      );
      if (packRows.length > 0) {
        const rec = packRows[0] as Record<string, unknown>;
        version = toInt(rec.content_version);
        packID = toStr(rec.pack_id);
      }

      const resp: CatalogResponse = {
        pack_id: packID,
        content_version: version,
        items: [],
        next_cursor: null,
      };

      const sinceRaw = req.query.since ?? "";
      if (sinceRaw !== "") {
        const n = parseDecimal(sinceRaw);
        if (n !== null && n >= version) {
          // 客户端已是最新版本：空 items + null cursor，快速 no-op
          return jsonResponse(200, resp);
        }
      }

      // 多取一条用于判定「是否还有下一页」，保证最后一页 next_cursor 为 null
      const rows = db.select(
        `SELECT item_id,source,type,title,source_rev,content_hash,sqlite_table,dist_class,state,updated_at,author_id,author_sig
			FROM items WHERE item_id > ? ORDER BY item_id ASC LIMIT ?`,
        [req.query.cursor ?? "", limit + 1],
      );

      let next = "";
      let items = rows;
      if (items.length > limit) {
        items = items.slice(0, limit);
        next = toStr((items[limit - 1] as Record<string, unknown>).item_id);
      }

      // #79 §5.2：对已通过 active/public 过滤的条目 id 集合做一次聚合（禁 N+1），无赞缺键按 0 填。
      const visibleIDs: string[] = [];
      for (const it of items) {
        if (toStr(it.state) !== "active" || toStr(it.dist_class) !== "public") {
          continue;
        }
        visibleIDs.push(toStr(it.item_id));
      }
      const likeMap = likeCountsByTargets(db, visibleIDs);

      for (const it of items) {
        if (toStr(it.state) !== "active" || toStr(it.dist_class) !== "public") {
          continue;
        }
        resp.items.push({
          item_id: toStr(it.item_id),
          source: toStr(it.source),
          type: toStr(it.type),
          title: toStr(it.title),
          content_hash: toStr(it.content_hash),
          source_rev: toStr(it.source_rev),
          like_count: likeMap.get(toStr(it.item_id)) ?? 0,
        });
      }

      if (next !== "") {
        resp.next_cursor = next;
      }
      return jsonResponse(200, resp);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return jsonResponse(500, { error: msg });
    }
  };
}
