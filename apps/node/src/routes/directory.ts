// 逐行对齐 internal/httpapi/directory.go 的 handleDirectoryGet（:32-85）。
import type { ServerHandler, ServerRequest } from "@base/core-ts";
import type { Db } from "../db";
import {
  GOVERN_ACTION_DIRECTORY_ADD,
  GOVERN_STATUS_PENDING,
  type IpLimiter,
  directoryKindOfItemId,
  directoryVersion,
  governRoster,
  governThresholdForRoster,
  listApprovedDirectory,
  listProposalViews,
  parseGoInt64,
} from "./derived";
import { jsonResponse } from "./json";

export interface DirectoryDeps {
  db: Db;
  storeKey: Uint8Array | null;
  /** 治理面 IP 令牌桶（每 IP 每分钟 GOVERN_PER_MINUTE_PER_IP、突发 GOVERN_BURST_PER_IP）。 */
  limiter: IpLimiter;
}

/**
 * 对齐 Go `clientIP(r)`（取 r.RemoteAddr）。本 Node 壳的 ServerRequest 边界未暴露远端地址
 * （host/http.ts 已冻结，不可改），故退化为单一桶键：全节点共用同一治理读令牌桶。
 * 令牌桶算法本身与 Go ipLimiter 逐行一致。
 */
function clientKey(_req: ServerRequest): string {
  return "";
}

/** 匿名公开读 GET /v1/directory；version 未变则短路返回 unchanged。 */
export function directoryHandler(deps: DirectoryDeps): ServerHandler {
  return async (req) => {
    if (!deps.limiter.allow(clientKey(req))) {
      // writeAuthErr（authmw.go:83-89）：Go map 键按字典序 → code 在 error 之前。
      return jsonResponse(429, { code: "govern_rate_limited", error: "治理操作过于频繁" });
    }
    try {
      const version = directoryVersion(deps.db);
      // version 未变短路：Go map 键按字典序 → unchanged 在 version 之前。
      const versionRaw = req.query.version ?? "";
      if (versionRaw !== "") {
        const n = parseGoInt64(versionRaw);
        if (n !== null && n === version) {
          return jsonResponse(200, { unchanged: true, version });
        }
      }

      // approved 只取 ListDirectory 的第一个返回值；pending 由未定案提案派生。
      const approved = listApprovedDirectory(deps.db);
      const roster = governRoster(deps.db, deps.storeKey);
      const views = listProposalViews(deps.db, deps.storeKey, roster.set);
      const threshold = governThresholdForRoster(
        GOVERN_ACTION_DIRECTORY_ADD,
        roster.set.size,
        roster.ok,
      );

      const pending: {
        kind: string;
        term_key: string;
        display_name: string;
        votes: number;
        threshold: number;
      }[] = [];
      for (const v of views) {
        if (v.action !== GOVERN_ACTION_DIRECTORY_ADD || v.status !== GOVERN_STATUS_PENDING) continue;
        const kind = directoryKindOfItemId(v.itemId);
        if (kind === null) continue;
        pending.push({
          kind,
          term_key: v.bodyMd,
          display_name: v.title,
          votes: v.votes.length,
          threshold,
        });
      }

      return jsonResponse(200, { version, approved, pending });
    } catch (err) {
      return jsonResponse(500, { error: err instanceof Error ? err.message : String(err) });
    }
  };
}
