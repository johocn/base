// 逐行对齐 internal/httpapi/contributor.go 的 handleProfilePut（:69-89，治理册 §5.2）。
import type { Db } from "../db";
import { type AuthedHandler, writeAuthErr } from "./authmw";
import { decodeStrict } from "./decode";
import { trimGoSpace } from "./derived";
import { jsonResponse } from "./json";

export interface ProfileDeps {
  db: Db;
}

/**
 * validProfileName（contributor.go:54-65）：去首尾空白后 rune 长度 1..32，且不含控制字符
 * （U+0000–U+001F 与 U+007F）。
 */
function validProfileName(s: string): boolean {
  const rs = [...s];
  if (rs.length < 1 || rs.length > 32) return false;
  for (const ch of rs) {
    const cp = ch.codePointAt(0) as number;
    if (cp <= 0x1f || cp === 0x7f) return false;
  }
  return true;
}

/**
 * POST /v1/profile：写入调用者自己的公开昵称（治理册 §5.2），与评论写路径同一条鉴权路。
 * 硬约束：id 只能取自鉴权中间件解析出的身份，请求体不得携带 id——否则等于伪造他人昵称。
 */
export function profilePutHandler(deps: ProfileDeps): AuthedHandler {
  return async (req, identityId) => {
    const dec = decodeStrict(req, { name: "string", id: "raw" });
    if (!dec.ok) return dec.resp;
    const body = dec.value;
    // profilePutReq.ID 是 json.RawMessage：Go 判 len(req.ID)>0，字段一旦出现（哪怕 null）即非空 → true。
    if (body.id === true) {
      return writeAuthErr(400, "profile_id_forbidden");
    }
    const name = trimGoSpace(body.name as string);
    if (!validProfileName(name)) {
      return writeAuthErr(400, "profile_name_invalid");
    }
    try {
      // PutProfile（store/contributor.go:194-198）：按 id upsert。
      deps.db.execute(
        `INSERT INTO profiles(id,name,updated_at) VALUES(?,?,?)
		ON CONFLICT(id) DO UPDATE SET name=excluded.name, updated_at=excluded.updated_at`,
        [identityId, name, Date.now()],
      );
    } catch (err) {
      return jsonResponse(500, { error: err instanceof Error ? err.message : String(err) });
    }
    // Go map 键按字典序：id, name。
    return jsonResponse(200, { id: identityId, name });
  };
}