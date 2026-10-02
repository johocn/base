// 逐行对齐 internal/httpapi/identity.go：
// 匿名只读 handleIdentityGet（:121-140）/ handleEscrowGet（:210-236）；
// 匿名写 handleIdentityRegister（:91-119，批 B1）；
// 签名写 handleEscrowPut（:161-208，身份由 requireAuth 的形参传入）。
// 读路径对齐 internal/store/identity.go 的 LookupIdentity（:66-78）/ GetEscrow（:167-180）；
// 写路径对齐 RegisterIdentity（:38-64）/ PutEscrow（:141-165）；
// 请求体严格解码见 ./decode.ts（对齐 Go 的 decodeJSON，:40-48）。
import type { ServerHandler, ServerRequest, ServerResponse } from "@base/core-ts";
import { ALG_ED25519, deriveIdentityId, isIdentityId } from "@base/protocol-ts";
import type { Db } from "../db";
import type { AuthedHandler } from "./authmw";
import { decodeStrict } from "./decode";
import { type IpLimiter, isHexN, isHexNonEmptyEven, toStr } from "./derived";
import { RawJSON, encodeJSON, jsonResponse } from "./json";

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

// —— 以下是批 B1 的身份写面 ——

function errResponse(err: unknown): ServerResponse {
  return jsonResponse(500, { error: err instanceof Error ? err.message : String(err) });
}

/**
 * RegisterIdentity（store/identity.go:38-64）的等价实现（幂等）。
 * registered=false 表示此前已登记同 id 同公钥；同 id 换公钥/换算法即冲突。
 * Go 走事务；本壳的 Db 未暴露事务，但同步单线程驱动下「先查后写」与之一致。
 */
function registerIdentity(
  db: Db,
  id: string,
  alg: string,
  pubKey: string,
  now: number,
): { registered: boolean; conflict: boolean } {
  const rows = db.select(`SELECT pubkey, alg FROM identities WHERE id=?`, [id]);
  if (rows.length > 0) {
    if (toStr(rows[0].pubkey) !== pubKey || toStr(rows[0].alg) !== alg) {
      return { registered: false, conflict: true };
    }
    db.execute(`UPDATE identities SET last_seen_at=? WHERE id=?`, [now, id]);
    return { registered: false, conflict: false };
  }
  db.execute(`INSERT INTO identities(id,alg,pubkey,created_at,last_seen_at) VALUES(?,?,?,?,?)`, [
    id,
    alg,
    pubKey,
    now,
    now,
  ]);
  return { registered: true, conflict: false };
}

/** handleIdentityRegister（identity.go:91-119）：匿名登记公钥（契约 5.1），请求自证无需签名。 */
export function identityRegisterHandler(deps: IdentityGetDeps): ServerHandler {
  return async (req) => {
    const dec = decodeStrict(req, { id: "string", alg: "string", pubkey: "string" });
    if (!dec.ok) return dec.resp;
    const body = dec.value;
    const alg = body.alg as string;
    if (alg !== ALG_ED25519) {
      return jsonResponse(400, { error: "identity_alg_unsupported" });
    }
    const pubKeyRaw = body.pubkey as string;
    let wantID: string;
    try {
      wantID = deriveIdentityId(pubKeyRaw);
    } catch {
      return jsonResponse(400, { error: "identity_pubkey_invalid" });
    }
    if (wantID.toLowerCase() !== (body.id as string).toLowerCase()) {
      return jsonResponse(400, { error: "identity_id_mismatch" });
    }
    try {
      const r = registerIdentity(deps.db, wantID, alg, pubKeyRaw.toLowerCase(), Date.now());
      if (r.conflict) {
        return jsonResponse(409, { error: "identity_pubkey_conflict" });
      }
      // Go map 键按字典序：alg, id, registered。
      return jsonResponse(200, { alg, id: wantID, registered: r.registered });
    } catch (err) {
      return errResponse(err);
    }
  };
}

interface KdfParams {
  alg: string;
  m: number;
  t: number;
  p: number;
  len: number;
}

/**
 * 对齐 Go `json.Marshal(kdfParams)`：**结构体字段序** alg,m,t,p,len（不是字典序），且末尾无换行。
 * encodeJSON 镜像的是 json.Encoder（末尾带 \n），故此处去掉尾换行。
 */
function marshalKDF(k: KdfParams): string {
  const s = Buffer.from(encodeJSON({ alg: k.alg, m: k.m, t: k.t, p: k.p, len: k.len })).toString(
    "utf8",
  );
  return s.endsWith("\n") ? s.slice(0, -1) : s;
}

/**
 * handleEscrowPut（identity.go:161-208）：写入密码托管密文（契约 5.3，需签名头）。
 * 已验签身份 id 由 requireAuth 以**形参**传入——不写入 ServerRequest。
 */
export function escrowPutHandler(deps: IdentityGetDeps): AuthedHandler {
  return async (req, identityId) => {
    const username = req.params.username ?? "";
    if (!validUsername(username)) {
      return jsonResponse(400, { error: "escrow_username_invalid" });
    }
    const dec = decodeStrict(req, {
      id: "string",
      alg: "string",
      salt: "string",
      kdf: { alg: "string", m: "int64", t: "int64", p: "int64", len: "int64" },
      enc_nonce: "string",
      priv_cipher: "string",
    });
    if (!dec.ok) return dec.resp;
    const body = dec.value;
    const id = body.id as string;
    if (id.toLowerCase() !== identityId.toLowerCase()) {
      return jsonResponse(403, { error: "escrow_identity_mismatch" });
    }
    const alg = body.alg as string;
    if (alg !== ALG_ED25519) {
      return jsonResponse(400, { error: "identity_alg_unsupported" });
    }
    const salt = body.salt as string;
    const encNonce = body.enc_nonce as string;
    const privCipher = body.priv_cipher as string;
    if (!isHexN(salt, 16) || !isHexN(encNonce, 12) || !isHexNonEmptyEven(privCipher)) {
      return jsonResponse(400, { error: "escrow_param_invalid" });
    }
    const kdf = body.kdf as Record<string, unknown>;
    const kdfAlg = kdf.alg as string;
    const m = kdf.m as number;
    const t = kdf.t as number;
    const p = kdf.p as number;
    const len = kdf.len as number;
    if (kdfAlg !== "argon2id" || !(m > 0) || !(t > 0) || !(p > 0) || len !== 32) {
      return jsonResponse(400, { error: "escrow_kdf_invalid" });
    }
    const kdfJSON = marshalKDF({ alg: kdfAlg, m, t, p, len });
    const now = Date.now();
    try {
      // PutEscrow（store/identity.go:141-165）：同 username 只允许同一 id 覆盖，否则冲突。
      const owner = deps.db.select(`SELECT id FROM escrow WHERE username=?`, [username]);
      if (owner.length > 0 && toStr(owner[0].id) !== id.toLowerCase()) {
        return jsonResponse(409, { error: "escrow_conflict" });
      }
      deps.db.execute(
        `INSERT INTO escrow(username,id,alg,salt,kdf_json,enc_nonce,priv_cipher,updated_at)
			VALUES(?,?,?,?,?,?,?,?)
			ON CONFLICT(username) DO UPDATE SET
				id=excluded.id, alg=excluded.alg, salt=excluded.salt, kdf_json=excluded.kdf_json,
				enc_nonce=excluded.enc_nonce, priv_cipher=excluded.priv_cipher, updated_at=excluded.updated_at`,
        [username, id.toLowerCase(), alg, salt, kdfJSON, encNonce, privCipher, now],
      );
    } catch (err) {
      return errResponse(err);
    }
    // Go map 键按字典序：updated_at, username。
    return jsonResponse(200, { updated_at: now, username });
  };
}
