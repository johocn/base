/**
 * 事件层共用件：`POST /v1/event` 的请求体构造与「发或入队」编排，以及事件正文用到的
 * 字节 / 密文原语（base64url、正文 AEAD、密钥列级密文）。
 *
 * 抽自 `core/group.ts`（私信册 §5.2）：小组（group.v1）与私信（dm.v1）共用同一套 wire 与
 * 密文形态，避免第二份复制粘贴。只依赖 `@base/protocol-ts` 与 `core/identity`，
 * 不 import 'uni' / 'plus'，因此可在 Node 下用 `core/fakes.ts` 完整测试。
 */
import {
  bytesToHex,
  canonicalize,
  hexToBytes,
  openWithNonce,
  randomBytes,
  sealWithNonce,
  sign,
  utf8,
  type Json,
} from '@base/protocol-ts';

import type { Adapters } from '../platform/adapter';
import type { LocalRepo } from './repo';
import { CommentError, sendComment } from './comment';
import { deviceKek, type Identity } from './identity';
import { decodeUtf8 } from './sync';

/** 与 `CommentOptions` **同形**：这样 `flushPending`（补发）可直接喂进来，无需转换。 */
export interface WireOptions {
  adapters: Adapters;
  repo: LocalRepo;
  nodeBaseUrl: string;
}

const GCM_NONCE_BYTES = 12;

const B64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/** base64url 手写：老 WebView 无 `btoa` 稳定实现，Node 测试里 `platform/uni.ts` 又不可用。 */
export function bytesToBase64Url(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i]!;
    const b1 = i + 1 < bytes.length ? bytes[i + 1]! : 0;
    const b2 = i + 2 < bytes.length ? bytes[i + 2]! : 0;
    out += B64URL.charAt(b0 >> 2);
    out += B64URL.charAt(((b0 & 0x03) << 4) | (b1 >> 4));
    if (i + 1 < bytes.length) out += B64URL.charAt(((b1 & 0x0f) << 2) | (b2 >> 6));
    if (i + 2 < bytes.length) out += B64URL.charAt(b2 & 0x3f);
  }
  return out;
}

export function base64UrlToBytes(s: string): Uint8Array {
  const out: number[] = [];
  let acc = 0;
  let bits = 0;
  for (let i = 0; i < s.length; i++) {
    const v = B64URL.indexOf(s.charAt(i));
    if (v < 0) throw new Error('base64url: 非法字符');
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((acc >> bits) & 0xff);
    }
  }
  return new Uint8Array(out);
}

/** 会话 / 组密钥落库：`nonceHex:ctHex`——与 `identity.ts` 的私钥密文**同一形态**。 */
export async function sealKeyCipher(storage: Adapters['storage'], keyBytes: Uint8Array): Promise<string> {
  const kek = await deviceKek(storage);
  const nonce = randomBytes(GCM_NONCE_BYTES);
  return `${bytesToHex(nonce)}:${bytesToHex(sealWithNonce(kek, nonce, keyBytes))}`;
}

export async function openKeyCipher(storage: Adapters['storage'], keyCipher: string): Promise<Uint8Array> {
  const kek = await deviceKek(storage);
  const [nonceHex, ctHex] = keyCipher.split(':');
  if (!nonceHex || !ctHex) throw new Error('group: 组密钥密文格式损坏');
  return openWithNonce(kek, hexToBytes(nonceHex), hexToBytes(ctHex));
}

/** 正文加密：`base64url(nonce12 || sealWithNonce(...))`。 */
export function sealText(key: Uint8Array, plain: string): string {
  const nonce = randomBytes(GCM_NONCE_BYTES);
  const ct = sealWithNonce(key, nonce, utf8(plain));
  const buf = new Uint8Array(nonce.length + ct.length);
  buf.set(nonce, 0);
  buf.set(ct, nonce.length);
  return bytesToBase64Url(buf);
}

/** 正文解密；密钥不对 / 密文损坏一律抛错，由调用方降级为「提示 + 占位」。 */
export function openText(key: Uint8Array, textCipher: string): string {
  const buf = base64UrlToBytes(textCipher);
  if (buf.length < GCM_NONCE_BYTES + 16) throw new Error('group: 密文过短');
  return decodeUtf8(openWithNonce(key, buf.subarray(0, GCM_NONCE_BYTES), buf.subarray(GCM_NONCE_BYTES)));
}

/** 构造一条已签名事件请求体：内容签名覆盖 canonical({event_id,type,created_at,body})。 */
export function buildEventWire(ident: Identity, type: string, body: Json): { eventId: string; wire: string } {
  const eventId = bytesToHex(randomBytes(16));
  const payload: Json = { event_id: eventId, type, created_at: Date.now(), body };
  const sig = sign(ident.seedHex, utf8(canonicalize(payload)));
  return { eventId, wire: JSON.stringify({ ...(payload as Record<string, Json>), sig }) };
}

/**
 * 发一条已签名事件；**只有网络不可达**才入 `comment_out`（节点给了任何 HTTP 响应都原样抛出、不入队）。
 * 复用 `sendComment` ⇒ 签名头、错误码映射、`wire` 重放全部零新代码。
 */
export async function submitWire(
  o: WireOptions,
  input: { eventId: string; wire: string; targetId: string; queueText: string },
): Promise<{ queued: boolean }> {
  try {
    await sendComment(o, { targetId: input.targetId, text: input.queueText, wire: input.wire, eventId: input.eventId });
    return { queued: false };
  } catch (e) {
    if (e instanceof CommentError && e.code === 'network') {
      await o.repo.enqueueComment({
        eventId: input.eventId,
        targetId: input.targetId,
        text: input.queueText,
        replyTo: null,
        wire: input.wire,
        state: 'pending',
        reason: null,
        queuedAt: new Date().toISOString(),
      });
      return { queued: true };
    }
    throw e;
  }
}
