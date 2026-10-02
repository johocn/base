/**
 * 随机数兜底池。
 *
 * uni-app 的 App 逻辑层跑在 V8 / jscore（不是 WebView），没有 `crypto.getRandomValues`；
 * 而 `protocol-ts` 的 `randomBytes` 是同步接口（AEAD nonce、事件 id、请求签名头都在同步代码里用），
 * 所以只能先用异步来源预填一个池，再同步消费。取不到随机数时显式抛错，绝不降级成 Math.random。
 */
import { setRandomBytesFallback } from '@base/protocol-ts';

/** 每次填充的字节数（调用方的取数 SQL 要按这个长度取）。 */
export const ENTROPY_FILL_BYTES = 256;

/** 低于此水位就异步补池，避免下一次取数时池空。 */
const LOW_WATER = 128;

export class EntropyPool {
  private buf = new Uint8Array(0);
  private filling: Promise<void> | null = null;

  constructor(private readonly fill: () => Promise<Uint8Array>) {}

  /** 同步取 n 字节；池不足即抛错（启动已预填，正常路径取不到才会发生）。 */
  take(n: number): Uint8Array {
    if (this.buf.length < n) {
      throw new Error(`随机池不足（余 ${this.buf.length} 字节，需 ${n} 字节，请重启应用重试）`);
    }
    const out = this.buf.slice(0, n);
    this.buf = this.buf.slice(n);
    if (this.buf.length < LOW_WATER) {
      // 补池失败不在此处抛：下一次 take 会给出可读错误，不打断当前流程
      void this.refill().catch(() => undefined);
    }
    return out;
  }

  /** 填充一次；并发调用复用同一个 Promise。 */
  refill(): Promise<void> {
    if (this.filling) return this.filling;
    this.filling = this.fill()
      .then((chunk) => {
        if (chunk.length === 0) throw new Error('随机源返回空字节');
        const merged = new Uint8Array(this.buf.length + chunk.length);
        merged.set(this.buf, 0);
        merged.set(chunk, this.buf.length);
        this.buf = merged;
      })
      .finally(() => {
        this.filling = null;
      });
    return this.filling;
  }
}

/** 预填一次并注入为 `randomBytes` 的兜底源。 */
export async function installRandomFallback(fill: () => Promise<Uint8Array>): Promise<EntropyPool> {
  const pool = new EntropyPool(fill);
  await pool.refill();
  setRandomBytesFallback((n) => pool.take(n));
  return pool;
}