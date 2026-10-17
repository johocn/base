// 近场分享配对：token 生成/续签 + 配对码构建（spec §3.3，enroll 文档体例 + 近场地址扩展）。
import { bytesToHex, randomBytes } from '@base/protocol-ts';

export const SHARE_TOKEN_TTL_MS = 30 * 60 * 1000;

/** 32 字节随机 hex token（每次开始分享/续签时新生成）。 */
export function newShareToken(): string {
  return bytesToHex(randomBytes(32));
}

/** 无毫秒 ISO（parseNodeEnroll 的 ISO_RE 要求 Z 结尾、不带小数秒）。 */
export function shareExpiresAt(ttlMs: number = SHARE_TOKEN_TTL_MS): string {
  return new Date(Date.now() + ttlMs).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** 配对码（计划 Task 5 逐字）：enroll JSON + token + mesh_ip/mesh_port，接收端同一 JSON 解析。 */
export function buildShareCode(input: {
  nodeId: string;
  url: string;
  signPubkey: string;
  tlsFingerprint: string;
  token: string;
  ip: string;
  port: number;
  expiresAt: string;
}): string {
  return JSON.stringify({
    v: 1,
    kind: 'base-node-enroll',
    node_id: input.nodeId,
    url: input.url,
    sign_pubkey: input.signPubkey,
    tls_fingerprint: input.tlsFingerprint,
    expires_at: input.expiresAt,
    token: input.token,
    mesh_ip: input.ip,
    mesh_port: input.port,
  });
}

export interface ShareTokenBox {
  /** 当前有效 token（每 30min 自动续签）。 */
  token(): string;
  start(): void;
  stop(): void;
}

/** token 30min 到期续签 helper：源端页持有一个 box，nio-server 用 token() 动态取值，无需重启。 */
export function createShareTokenBox(opts: {
  ttlMs?: number;
  onRenew?: (token: string) => void;
}): ShareTokenBox {
  const ttl = opts.ttlMs ?? SHARE_TOKEN_TTL_MS;
  let current = newShareToken();
  let timer: ReturnType<typeof setInterval> | null = null;
  return {
    token: () => current,
    start(): void {
      this.stop();
      timer = setInterval(() => {
        current = newShareToken();
        opts.onRenew?.(current);
      }, ttl);
    },
    stop(): void {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    },
  };
}
