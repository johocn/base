// 逐行对齐 internal/httpapi/public.go 的 handlePubkey（:30-39）。
import type { ServerHandler } from "@base/core-ts";
import { jsonResponse } from "./json";

export interface PubkeyOptions {
  /** 已推导出的公钥 hex；空串 = 只读分发节点（未配置签名密钥）。 */
  pubHex: string;
  issuer: string;
}

export function pubkeyHandler(opts: PubkeyOptions): ServerHandler {
  return async () => {
    if (opts.pubHex === "") {
      return jsonResponse(404, { error: "本节点未配置签名密钥（只读分发节点）" });
    }
    // Go map 键按字典序：issuer 在 public_key_hex 之前。
    return jsonResponse(200, { issuer: opts.issuer, public_key_hex: opts.pubHex });
  };
}
