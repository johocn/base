import { canonicalize } from "./canonical";
import { sha256Hex, utf8 } from "./hash";

/** 一次请求中参与签名的元数据（不含请求体本身）。 */
export interface RequestMeta {
  /** 大写，如 "POST" */
  method: string;
  /** 不含 query，如 "/v1/identity/escrow/alice" */
  path: string;
  /** 原始 query string，无则空串 */
  query: string;
  /** 请求体原始字节的 sha256 hex；无请求体时用 emptyBodySha256() */
  bodySha256: string;
  /** 客户端 Unix 毫秒。必须是安全整数，否则 canonicalize 会抛错 */
  ts: number;
  /** 每次请求唯一的随机值，16 字节 hex */
  nonce: string;
}

/** 无请求体请求的固定 body_sha256 取值。 */
export function emptyBodySha256(): string {
  return sha256Hex(new Uint8Array(0));
}

/**
 * 待签字节：canonical({method,path,query,body_sha256,ts,nonce})。
 *
 * 这是不可变契约（与 Go 侧 protocol.RequestSignBytes 必须逐字节一致），
 * 由 vectors/v1/reqsig.json 双侧消费锁死。字段增删即协议破坏。
 */
export function requestSignBytes(m: RequestMeta): Uint8Array {
  return utf8(
    canonicalize({
      method: m.method,
      path: m.path,
      query: m.query,
      body_sha256: m.bodySha256,
      ts: m.ts,
      nonce: m.nonce,
    }),
  );
}
