// 逐行对齐 internal/httpapi/comment.go 的审核面：
// requireReviewKey（:87-99）/ handleReviewFetch（:101-125）/ handleReviewReject（:127-164）。
// 两条路由**只在配置了 reviewKey 的节点上存在**（server.go:145-149），密钥不符也回 404。
import { timingSafeEqual } from "node:crypto";
import type { ServerHandler, ServerResponse } from "@base/core-ts";
import { isBlobId } from "@base/protocol-ts";
import type { Db } from "../db";
import type { HostDb, SqlValue } from "../host/sqlite";
import { getEventById } from "../store/events";
import {
  deleteBlob,
  getBlobBytes,
  putCommentTombstone,
  type CommentTombstone,
} from "../store/peersync";
import { decodeStrict } from "./decode";
import { isHexN } from "./derived";
import { jsonResponse } from "./json";
import { listReportedComments } from "../store/like";

/** 审核面依赖：路由层的 Db + 块目录与 store 密钥（取正文需解密）。 */
export interface ReviewDeps {
  db: Db;
  dataDir: string;
  /** 未提供 dataDir 时为 null，取正文按「块不存在」404 处理（同 routes/blob.ts 口径）。 */
  storeKey: Uint8Array | null;
}

/** 把路由层 Db 视图适配成 store/peersync 的 HostDb 形状，以便逐字复用其块/墓碑读写。 */
function asHostDb(db: Db): HostDb {
  return {
    exec: (sql) => db.execute(sql),
    run: (sql, params = []) => db.execute(sql, params as SqlValue[]),
    get: (sql, params = []) => {
      const rows = db.select(sql, params);
      return rows.length === 0 ? undefined : (rows[0] as Record<string, SqlValue>);
    },
    all: (sql, params = []) => db.select(sql, params) as Record<string, SqlValue>[],
    close: () => {},
  };
}

function errResponse(err: unknown): ServerResponse {
  return jsonResponse(500, { error: err instanceof Error ? err.message : String(err) });
}

/**
 * requireReviewKey（comment.go:87-99）：读头 `X-Base-Review-Key`，与配置密钥做**定长时间**比较。
 * 不符回 404 `not_found`（与「路由未注册」同形，不暴露存在性——册子 §4.3、风险 9）。
 */
export function requireReviewKey(key: string, next: ServerHandler): ServerHandler {
  const want = Buffer.from(key, "utf8");
  return async (req) => {
    const got = Buffer.from(req.headers["x-base-review-key"] ?? "", "utf8");
    // subtle.ConstantTimeCompare：长度不等即 0，否则定长比较。
    if (got.length !== want.length || !timingSafeEqual(got, want)) {
      return jsonResponse(404, { error: "not_found" });
    }
    return next(req);
  };
}

/** handleReviewFetch（comment.go:105-125）：按 payload_cid 取评论正文明文。 */
export function reviewFetchHandler(deps: ReviewDeps): ServerHandler {
  return async (req) => {
    const dec = decodeStrict(req, { payload_cid: "string" });
    if (!dec.ok) return dec.resp;
    const cid = dec.value.payload_cid as string;
    if (!isBlobId(cid)) return jsonResponse(400, { error: "event_param_invalid" });
    if (deps.storeKey === null) return jsonResponse(404, { error: "blob_not_found" });

    let plain: Uint8Array;
    try {
      plain = getBlobBytes(asHostDb(deps.db), deps.dataDir, deps.storeKey, cid);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return jsonResponse(404, { error: "blob_not_found" });
      }
      return errResponse(err);
    }
    return jsonResponse(200, { payload_cid: cid, text: Buffer.from(plain).toString("utf8") });
  };
}

/**
 * handleReviewReported（comment.go:139-173）：被举报评论列表（#79 §5.3）。
 * 只聚合呈现，处置仍走既有 fetch→reject；无参数（空体 {}），列表短小不分页。
 */
export function reviewReportedHandler(deps: ReviewDeps): ServerHandler {
  return async () => {
    try {
      const rows = listReportedComments(deps.db);
      return jsonResponse(200, {
        reports: rows.map((c) => ({
          event_id: c.eventId,
          actor: c.actor,
          target_id: c.targetId,
          payload_cid: c.payloadCid,
          reply_to: c.replyTo === "" ? null : c.replyTo,
          created_at: c.createdAt,
          report_count: c.reportCount,
          reporters: c.reporters,
        })),
      });
    } catch (err) {
      return errResponse(err);
    }
  };
}

/** handleReviewReject（comment.go:132-164）：写墓碑 + 删本地块；墓碑随事件反熵传播。 */
export function reviewRejectHandler(deps: ReviewDeps): ServerHandler {
  return async (req) => {
    const dec = decodeStrict(req, { event_id: "string", reason: "string" });
    if (!dec.ok) return dec.resp;
    const eventId = dec.value.event_id as string;
    const reason = dec.value.reason as string;
    if (!isHexN(eventId, 16)) return jsonResponse(400, { error: "event_param_invalid" });

    let ev;
    try {
      ev = getEventById(deps.db, eventId);
    } catch (err) {
      return errResponse(err);
    }
    if (ev === null || ev.payloadCid === "") {
      return jsonResponse(404, { error: "event_not_found" });
    }

    const host = asHostDb(deps.db);
    const now = Date.now();
    const tomb: CommentTombstone = {
      eventId: ev.eventId,
      payloadCid: ev.payloadCid,
      reason,
      at: now,
      receivedAt: now,
    };
    try {
      putCommentTombstone(host, tomb);
    } catch (err) {
      return errResponse(err);
    }
    try {
      deleteBlob(host, deps.dataDir, ev.payloadCid);
    } catch (err) {
      return errResponse(err);
    }
    return jsonResponse(200, { event_id: ev.eventId, payload_cid: ev.payloadCid });
  };
}