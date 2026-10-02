// 逐行对齐 internal/httpapi/authmw.go 的认证地基：
// authErrText 全表（:20-79）/ writeAuthErr（:83-89）/ hasAnyAuthHeader（:131-138）/
// authenticate 七步（:144-236）/ requireAuth（:97-99）/ requireAuthLimit（:102-112）/ optionalAuth（:116-128）。
import type { ServerHandler, ServerRequest, ServerResponse, TlsAdapter } from "@base/core-ts";
import {
  ALG_ED25519,
  isIdentityId,
  requestSignBytes,
  sha256Hex,
  verify,
} from "@base/protocol-ts";
import type { Db } from "../db";
import { isHexN, isHexNonEmptyEven, parseGoInt64, toStr } from "./derived";
import { jsonResponse } from "./json";

// 契约 3.2：时间窗 300 秒；nonce 去重窗口 10 分钟（时间窗的两倍）。
export const AUTH_TS_WINDOW_MS = 300_000;
export const NONCE_WINDOW_MS = 600_000;

/**
 * maxJSONBody（identity.go:19-22）：签名/JSON 路由的默认体上限（64 KiB），
 * 由 requireAuth / optionalAuth 与 decode.ts 的 decodeStrict 使用。
 */
export const MAX_JSON_BODY = 64 << 10;

/** authErrText 只给人读；客户端必须只依赖 code（契约 3.3）。逐字取自 authmw.go:20-79。 */
export const authErrText: Record<string, string> = {
  auth_missing_header: "缺少签名头",
  auth_ts_invalid: "X-Base-Ts 不是十进制毫秒时间戳",
  auth_nonce_invalid: "X-Base-Nonce 必须是 16 字节 hex",
  auth_sig_invalid: "X-Base-Sig 必须是 hex",
  auth_ts_out_of_window: "时间戳超出 ±300 秒窗口",
  auth_nonce_replay: "nonce 在 10 分钟内已使用过",
  auth_bad_signature: "签名验证失败",
  auth_body_read_failed: "请求体读取失败",
  auth_body_too_large: "请求体超过本接口上限",
  blob_too_large: "上传块超过 8 MiB",
  bad_multipart: "请求必须是 multipart/form-data，且含字段 file",
  auth_sign_meta_invalid: "待签字节构造失败",
  identity_id_invalid: "身份 id 必须是 32 位 hex",
  identity_alg_unsupported: "算法不受支持",
  identity_unregistered: "身份未登记",
  node_key_mismatch: "节点间预共享密钥不匹配",
  event_sig_invalid: "事件内容签名验证失败",
  event_revoked: "该评论已被审核删除",
  event_rate_limited: "发言过于频繁",
  profile_name_invalid: "昵称必须是去首尾空白后 1..32 个字符，且不含控制字符",
  profile_id_forbidden: "请求体不得携带 id",
  item_id_invalid:
    "item_id 必须形如 article/<slug>、quiz/<slug>、course/<cid> 或 course/<cid>/lesson/<lid>",
  item_type_unsupported: "type 只能是 article、quiz、tag、course 或 lesson",
  item_segments_invalid:
    "segments 不合法：seq<0 只放 attr.* 属性行且须按确定性规则排布，seq=0 只放 digest，seq>=1 只放本容器允许的子项 kind",
  item_type_mismatch: "type 与 item_id 前缀不一致",
  item_title_invalid: "标题必须是去首尾空白后 1..200 个字符，且不含控制字符",
  item_body_too_large: "正文超过 32768 字节",
  item_question_invalid: "question_json 不是合法 JSON、schema_version 非 1，或 questions 缺失/为空",
  author_id_forbidden: "请求体不得携带身份字段（author_id / proposer_id / id 等）",
  author_sig_invalid: "作者归属签名验证失败",
  item_id_taken: "该 item_id 已被占用",
  item_rate_limited: "投稿过于频繁",

  proposal_action_unsupported: "action 只能是 remove / edit / revive / directory_add",
  proposal_reason_invalid: "reason 必须是去首尾空白后 1..200 个字符，且不含控制字符",
  proposal_edit_invalid:
    "edit 载荷不合法：title 须为去首尾空白后 1..200 个字符且不含控制字符，body_md 必填，且目标必须是 article 载体",
  proposal_directory_invalid:
    "directory 载荷不合法：kind 须为 category/instructor/tag，display_name 规范化后须与 term_key 一致",
  proposal_too_large: "title 与 body_md 的字节之和超过 32768",
  item_not_found: "目标 item_id 不存在",
  item_self_owned: "不能治理自己的条目，请改用 POST /v1/submit",
  item_state_mismatch: "动作与目标当前 state 不匹配",
  proposer_not_governor: "提案人不在本节点名册内",
  proposal_not_found: "提案不存在",
  voter_not_governor: "投票人不在本节点名册内",
  already_voted: "已对本提案投过票",
  govern_rate_limited: "治理操作过于频繁",

  group_read_denied: "圈子不存在或不可见",
  group_invite_required: "该圈子仅接受邀请码加入",
  group_roster_quorum_missing: "签名数不足门槛",
  group_proposal_proposer_missing: "解散圈子需治理者发起",
  group_roster_epoch_stale: "密钥已轮换，请先同步圈内状态",
  govern_event_conflict: "同一提案存在并发冲突，已按确定性规则收敛",

  tag_not_governor: "只有治理人（全站名册或圈子治者）能给无标签内容打标签",
  tag_target_tagged: "该内容已有标签，改动请走治理提案",
  tag_links_invalid: "links 不合法：kind 必须与 target_id 形态一致，且同一 target_id 不得重复",
  tag_target_not_found: "打标目标不存在或已下架",
};

/**
 * writeAuthErr（authmw.go:83-89）：输出 {"code":...,"error":...}。
 * Go map 键按字典序 → code 在 error 之前；既有 writeError 的 {"error":"..."} 形状保持不变。
 */
export function writeAuthErr(status: number, code: string): ServerResponse {
  const text = authErrText[code] ?? "";
  return jsonResponse(status, { code, error: text === "" ? code : text });
}

/** requireAuth / optionalAuth 需要的依赖：只取库里那点身份数据。 */
export interface AuthDeps {
  db: Db;
}

/**
 * 已验签身份由**形参**交给业务 handler（如 `handleEscrowPut(deps, req, identityId)`），
 * 不往 ServerRequest 加字段（core-ts 的 ServerRequest 已冻结）。
 */
export type AuthedHandler = (req: ServerRequest, identityId: string) => Promise<ServerResponse>;

/** authenticate 的判定结果：失败时响应已构造好；成功时给出已验签身份 id。 */
export type AuthOutcome = { ok: true; id: string } | { ok: false; resp: ServerResponse };

const AUTH_HEADERS = ["x-base-id", "x-base-alg", "x-base-ts", "x-base-nonce", "x-base-sig"];

/** hasAnyAuthHeader（authmw.go:131-138）：判 5 个头是否至少出现了一个。 */
export function hasAnyAuthHeader(req: ServerRequest): boolean {
  for (const k of AUTH_HEADERS) {
    if ((req.headers[k] ?? "") !== "") return true;
  }
  return false;
}

/**
 * 各签名头按小写名取值：Go 的 r.Header.Get 大小写不敏感，本壳 host/http.ts 已把键统一小写。
 */
function authHeader(req: ServerRequest, canonical: string): string {
  return req.headers[canonical.toLowerCase()] ?? "";
}

/**
 * 对齐 Go r.URL.RawQuery 口径：本壳 ServerRequest 未暴露原串（host/http.ts 已冻结），
 * 只能由解析后的 query 记录回构。B1 的 4 条路由均无 query，故回构串恒为 ""，
 * 与客户端 `signRequestHeaders({query: ''})` 一致。B4 若接带 query 的签名读路由需复核此点。
 */
function rawQueryOf(req: ServerRequest): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(req.query)) {
    parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(v)}`);
  }
  return parts.join("&");
}

/**
 * UseNonce（store/identity.go:117-129）的等价实现。
 * Go 用 `INSERT ... ON CONFLICT DO NOTHING` + RowsAffected==0 判重放；
 * 本壳的 Db 未暴露 RowsAffected，但在同步单线程的 sqlite 驱动下「先查后插」与之一致。
 */
function useNonce(db: Db, id: string, nonce: string, now: number): boolean {
  const rows = db.select(`SELECT 1 FROM auth_nonces WHERE id=? AND nonce=?`, [id, nonce]);
  if (rows.length > 0) return true;
  db.execute(
    `INSERT INTO auth_nonces(id,nonce,seen_at) VALUES(?,?,?) ON CONFLICT(id,nonce) DO NOTHING`,
    [id, nonce, now],
  );
  return false;
}

/**
 * authenticate（authmw.go:144-236）执行契约 3.2 的 1..7 步；maxBody 是体上限（超出回 413）。
 * 返回已验签身份 id 与是否放行（失败时响应已构造好）。
 */
export function authenticate(deps: AuthDeps, req: ServerRequest, maxBody: number): AuthOutcome {
  // 1. 缺任一头
  const id = authHeader(req, "X-Base-Id");
  const alg = authHeader(req, "X-Base-Alg");
  const tsRaw = authHeader(req, "X-Base-Ts");
  const nonce = authHeader(req, "X-Base-Nonce");
  const sig = authHeader(req, "X-Base-Sig");
  if (id === "" || alg === "" || tsRaw === "" || nonce === "" || sig === "") {
    return { ok: false, resp: writeAuthErr(400, "auth_missing_header") };
  }
  // 2. 算法与格式（全部在查库之前，避免用坏输入打库）
  if (alg !== ALG_ED25519) {
    return { ok: false, resp: writeAuthErr(400, "identity_alg_unsupported") };
  }
  if (!isIdentityId(id)) {
    return { ok: false, resp: writeAuthErr(400, "identity_id_invalid") };
  }
  const ts = parseGoInt64(tsRaw);
  if (ts === null) {
    return { ok: false, resp: writeAuthErr(400, "auth_ts_invalid") };
  }
  if (!isHexN(nonce, 16)) {
    return { ok: false, resp: writeAuthErr(400, "auth_nonce_invalid") };
  }
  if (!isHexNonEmptyEven(sig)) {
    return { ok: false, resp: writeAuthErr(400, "auth_sig_invalid") };
  }
  // 3. 取公钥
  let pubKey: string;
  try {
    const rows = deps.db.select(
      `SELECT id,alg,pubkey,created_at,last_seen_at FROM identities WHERE id=?`,
      [id],
    );
    if (rows.length === 0) {
      return { ok: false, resp: writeAuthErr(403, "identity_unregistered") };
    }
    pubKey = toStr(rows[0].pubkey);
  } catch (err) {
    return { ok: false, resp: errResponse(err) };
  }
  // 4. 时间窗
  const now = Date.now();
  if (now - ts > AUTH_TS_WINDOW_MS || now - ts < -AUTH_TS_WINDOW_MS) {
    return { ok: false, resp: writeAuthErr(401, "auth_ts_out_of_window") };
  }
  // 5. nonce 去重（键含 id，否则可被抢注导致合法请求被误判重放）
  let used: boolean;
  try {
    used = useNonce(deps.db, id, nonce, now);
  } catch (err) {
    return { ok: false, resp: errResponse(err) };
  }
  if (used) {
    return { ok: false, resp: writeAuthErr(401, "auth_nonce_replay") };
  }
  // 6. 体上限 → 算 body_sha256 → 组待签字节 → 验签
  // 本壳的请求体已被 host 层整体读完，故等效于 Go 的 io.ReadAll(io.LimitReader(maxBody+1)) 上限判定。
  if (req.body.byteLength > maxBody) {
    return { ok: false, resp: writeAuthErr(413, "auth_body_too_large") };
  }
  let signBytes: Uint8Array;
  try {
    signBytes = requestSignBytes({
      method: req.method,
      path: req.path,
      query: rawQueryOf(req),
      bodySha256: sha256Hex(req.body),
      ts,
      nonce,
    });
  } catch {
    return { ok: false, resp: writeAuthErr(400, "auth_sign_meta_invalid") };
  }
  if (!verify(pubKey, signBytes, sig)) {
    return { ok: false, resp: writeAuthErr(401, "auth_bad_signature") };
  }
  // 7. 通过：TouchIdentity 的返回值 Go 侧被丢弃（`_ =`），此处同样忽略其失败。
  try {
    deps.db.execute(`UPDATE identities SET last_seen_at=? WHERE id=?`, [now, id]);
  } catch {
    // 忽略：Go `_ = s.st.TouchIdentity(...)`。
  }
  return { ok: true, id };
}

function errResponse(err: unknown): ServerResponse {
  return jsonResponse(500, { error: err instanceof Error ? err.message : String(err) });
}

/** requireAuth（authmw.go:97-99）：体上限取默认的 maxJSONBody（64 KiB）。 */
export function requireAuth(deps: AuthDeps, next: AuthedHandler): ServerHandler {
  return requireAuthLimit(deps, MAX_JSON_BODY, next);
}

/** requireAuthLimit（authmw.go:102-112）：显式指定体上限。 */
export function requireAuthLimit(
  deps: AuthDeps,
  maxBody: number,
  next: AuthedHandler,
): ServerHandler {
  return async (req) => {
    const res = authenticate(deps, req, maxBody);
    if (!res.ok) return res.resp;
    return next(req, res.id);
  };
}

/**
 * optionalAuth（authmw.go:116-128）：5 个签名头**全缺**即按匿名放行（identityId=""）；
 * 缺一半仍按 auth_missing_header 拒（避免「半带头的请求」被静默降级为匿名）。
 */
export function optionalAuth(deps: AuthDeps, next: AuthedHandler): ServerHandler {
  return async (req) => {
    if (!hasAnyAuthHeader(req)) return next(req, "");
    const res = authenticate(deps, req, MAX_JSON_BODY);
    if (!res.ok) return res.resp;
    return next(req, res.id);
  };
}

/**
 * requireNodeKey（tlscfg.go:202-212）：校验节点间预共享密钥头（契约 6.3：与 TLS 指纹是两层）。
 * 返回一个「包装器」：把任意 handler 包成先验 `X-Base-Node-Key` 再放行的 handler。
 * 长度不等或值不等 → 401 node_key_mismatch。
 */
export function requireNodeKey(
  tls: TlsAdapter,
  key: string,
): (next: ServerHandler) => ServerHandler {
  return (next: ServerHandler): ServerHandler =>
    async (req: ServerRequest): Promise<ServerResponse> => {
      const got = req.headers["x-base-node-key"] ?? "";
      if (!tls.nodeKeyMatches(key, got)) {
        return writeAuthErr(401, "node_key_mismatch");
      }
      return next(req);
    };
}
