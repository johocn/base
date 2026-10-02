// 逐行对齐 internal/httpapi/identity.go 的两条匿名只读路由：
// handleIdentityGet（:121-140）与 handleEscrowGet（:210-236）；
// 读路径对齐 internal/store/identity.go 的 LookupIdentity（:66-78）/ GetEscrow（:167-180）。
import type { ServerHandler, ServerRequest } from "@base/core-ts";
import { isIdentityId } from "@base/protocol-ts";
import type { Db } from "../db";
import { type IpLimiter, toStr } from "./derived";
import { RawJSON, jsonResponse } from "./json";

export interface IdentityGetDeps {
  db: Db;
}

export interface EscrowGetDeps {
  db: Db;
  /** escrow 读取的同 IP 令牌桶（identity.go:288-330 的 ipLimiter）。 */
  limiter: IpLimiter;
}

/**
 * validUsername（identity.go:66-81）：严格 `^[a-zA-Z0-9_]{3,32}$`，**不做大小写归一**。
 * 字符集为纯 ASCII，故 JS 的长度口径与 Go 的字节长度一致，判定等价。
 */
const USERNAME_RE = /^[a-zA-Z0-9_]{3,32}$/;
function validUsername(s: string): boolean {
  return USERNAME_RE.test(s);
}

/**
 * 对齐 Go `clientIP(r)`（identity.go:281-286，取 r.RemoteAddr）。
 * 本 Node 壳的 ServerRequest 边界未暴露远端地址（host/http.ts 已冻结，不可改），
 * 故与 directory.ts 同样退化为**单一桶键**：全节点共用同一把 escrow 读令牌桶。
 * 令牌桶算法本身与 Go ipLimiter 逐行一致（复用 derived.ts 的 IpLimiter）。
 */
function clientKey(_req: ServerRequest): string {
  return "";
}

/** 匿名公开读 GET /v1/identity/{id}（契约 5.2）。 */
export function identityGetHandler(deps: IdentityGetDeps): ServerHandler {
  return async (req) => {
    const id = req.params.id ?? "";
    if (!isIdentityId(id)) {
      return jsonResponse(400, { error: "identity_id_invalid" });
    }
    try {
      // LookupIdentity（identity.go:128 走 strings.ToLower(id)）。
      const rows = deps.db.select(
        `SELECT id,alg,pubkey,created_at,last_seen_at FROM identities WHERE id=?`,
        [id.toLowerCase()],
      );
      if (rows.length === 0) {
        return jsonResponse(404, { error: "identity_not_found" });
      }
      const it = rows[0];
      // Go map[string]any 键按字典序：alg, created_at, id, pubkey；created_at 为 int64 毫秒。
      return jsonResponse(200, {
        alg: toStr(it.alg),
        created_at: Number(it.created_at ?? 0),
        id: toStr(it.id),
        pubkey: toStr(it.pubkey),
      });
    } catch (err) {
      return jsonResponse(500, { error: err instanceof Error ? err.message : String(err) });
    }
  };
}

/** 匿名带限速公开读 GET /v1/identity/escrow/{username}（契约 5.4）。 */
export function escrowGetHandler(deps: EscrowGetDeps): ServerHandler {
  return async (req) => {
    const username = req.params.username ?? "";
    if (!validUsername(username)) {
      return jsonResponse(400, { error: "escrow_username_invalid" });
    }
    // 令牌桶先于查库消费令牌：未命中同样计数（identity.go:217-221）。
    if (!deps.limiter.allow(clientKey(req))) {
      const resp = jsonResponse(429, { error: "rate_limited" });
      return {
        status: resp.status,
        headers: { ...resp.headers, "Retry-After": "60" },
        body: resp.body,
      };
    }
    try {
      const rows = deps.db.select(
        `SELECT username,id,alg,salt,kdf_json,enc_nonce,priv_cipher,updated_at FROM escrow WHERE username=?`,
        [username],
      );
      if (rows.length === 0) {
        return jsonResponse(404, { error: "escrow_not_found" });
      }
      const rec = rows[0];
      // 键按字典序：alg, enc_nonce, id, kdf, priv_cipher, salt, updated_at, username。
      // kdf 是 Go 的 json.RawMessage(rec.KDFJSON)：DB 里存的 JSON 片段**原样嵌入**，
      // 不重新序列化（换实现时 kdf 内部键序可能不同，必须逐字节保留）。
      return jsonResponse(200, {
        alg: toStr(rec.alg),
        enc_nonce: toStr(rec.enc_nonce),
        id: toStr(rec.id),
        kdf: new RawJSON(toStr(rec.kdf_json)),
        priv_cipher: toStr(rec.priv_cipher),
        salt: toStr(rec.salt),
        updated_at: Number(rec.updated_at ?? 0),
        username: toStr(rec.username),
      });
    } catch (err) {
      return jsonResponse(500, { error: err instanceof Error ? err.message : String(err) });
    }
  };
}
