// 逐行移植 internal/peersync/scrub.go（165 行）：本地校验修复（scrub）与其调度器。
//
// 与 Go 的**有意差异**（记录于文件头）：
//   1. 方法形态：Go 是 `func (c Config) ScrubOnce(...)` / `ScrubForever(...)`；
//      TS 无接收者，改为导出函数 `scrubOnce(c, ctx, st, peers, blobIds)` / `scrubForever(...)`。
//   2. `context.Context` 取消判定 `ctx.Err() != nil` 换成 `ctx !== undefined && ctx.aborted`，
//      取消原因用 `ctx.reason ?? new Error("aborted")`。
//   3. `time.NewTimer` / `timer.Reset` 的调度换成 `setTimeout(...).unref?.()` +
//      「可被 AbortSignal 打断的 sleepOrAbort」；日志单串：`logf: (msg: string) => void`
//      （Go 是 `func(string, ...any)`）。
//   4. `time.Duration.Round(time.Millisecond).String()` 自实现为 `formatGoDuration`（文件内私有）。
//   5. `fmt.Printf` 改为 `console.log`。
import type { SyncStore } from "../store/syncstore";
import type { Config, Peer, SyncContext } from "./peer";
import { fetchBlobs } from "./remote";
import { ownershipIndex } from "./sync";

/** scrubFirstDelay（scrub.go:13）：scrub 首轮延迟：启动即全量哈希会与冷启动抢 IO（契约 §8）。 */
export const SCRUB_FIRST_DELAY_MS = 10 * 60 * 1000;

/** ScrubResult（scrub.go:16-26）：一次 scrub 的结果（契约 §8）。 */
export class ScrubResult {
  checked = 0;
  /** 从邻居拉回并通过逐块哈希校验的块数。 */
  repaired = 0;
  /** 本地坏块被清掉的块数（= store.VerifyBlobs 的 bad 数）。 */
  dropped = 0;
  /** 所有已知 peer 都拿不到的块：保留告警，不静默、不删别的数据。 */
  unrepaired: string[] = [];

  String(): string {
    return `scrub checked=${this.checked} repaired=${this.repaired} dropped=${this.dropped} unrepaired=${this.unrepaired.length}`;
  }
}

/**
 * ScrubOnce（scrub.go:32-117）：对本地做一次校验修复，并按 blob_replicas 登记的邻居补齐（契约 §8）。
 * 只修本地：不做跨节点编排（每个节点各扫各的）。
 * peers 只用于给 blob_replicas 里的裸 url 补上 TLS 指纹；缺项按裸 url 试（局域网调试）。
 */
export async function scrubOnce(
  c: Config,
  ctx: SyncContext,
  st: SyncStore,
  peers: Peer[],
  blobIds: string[],
): Promise<ScrubResult> {
  const res = new ScrubResult();

  // 反熵护栏 3（册子 §4.5）：墓碑中的块**直接删本地副本**，绝不走「坏块 → 从邻居补齐」——
  // 否则删除会被补齐拉回，且每轮都白跑一次注定拿不到的 fetch。
  const revoked = st.listRevokedPayloads();
  for (const cid of revoked) {
    if (st.hasBlob(cid).exists) st.deleteBlob(cid);
  }

  const { checked, bad } = st.verifyBlobs(blobIds);
  res.checked = checked;
  res.dropped = bad.length;
  let badList = bad;
  if (revoked.size > 0) {
    badList = bad.filter((b) => !revoked.has(b.blobId));
  }
  if (badList.length === 0) return res;

  const byUrl = new Map<string, Peer>();
  for (const p of peers) byUrl.set(p.url, p);

  // 归属索引：坏块此刻已被清掉，blobs 表里没有它的归属，只有 media_meta 的声明块序列知道。
  const idx = ownershipIndex(st);

  for (const b of badList) {
    const urls = st.replicaPeers(b.blobId);
    let repaired = false;
    for (const url of urls) {
      if (ctx !== undefined && ctx.aborted) throw (ctx.reason ?? new Error("aborted"));
      const p = byUrl.get(url) ?? { url, tlsFingerprint: "" };
      let fr;
      try {
        fr = await fetchBlobs(c, ctx, p, [{ blobId: b.blobId, size: 0 }], (id, data) => {
          // Go 的 map 取缺失键返回零值 BlobRef{}（ItemID "" / Seq 0）；TS 的 idx[id] 是 undefined，须兜底。
          const ref = idx[id] ?? { blobId: id, seq: 0, size: 0, itemId: "" };
          st.putBlob(id, data, ref.itemId, ref.seq);
        });
      } catch (err) {
        console.log(`peersync: scrub 从 ${url} 取 ${b.blobId} 出错: ${String(err)}`);
        continue;
      }
      if (fr.fetched === 1) {
        res.repaired++;
        repaired = true;
        break;
      }
      console.log(`peersync: scrub 从 ${url} 未取到 ${b.blobId}（too_large=${JSON.stringify(fr.tooLarge)}）`);
    }
    if (!repaired) {
      res.unrepaired.push(b.blobId);
    }
  }
  return res;
}

/**
 * ScrubForever（scrub.go:121-165）：启动 scrub 调度：延迟 10 分钟首轮，此后每 interval 一轮（契约 §8）。
 * 与反熵同一套「不重入」语义：上一轮未结束则跳过下一拍。
 */
export function scrubForever(
  c: Config,
  ctx: SyncContext,
  st: SyncStore,
  peers: Peer[],
  intervalMs: number,
  logf: (msg: string) => void,
): void {
  if (intervalMs <= 0) return;
  let running = false;
  const run = async (): Promise<void> => {
    if (running) {
      logf("peersync: 上一轮 scrub 尚未结束，跳过本轮");
      return;
    }
    running = true;
    try {
      const start = Date.now();
      try {
        const res = await scrubOnce(c, ctx, st, peers, []);
        logf(`peersync: ${res.String()}（耗时 ${formatGoDuration(Date.now() - start)}）`);
        for (const id of res.unrepaired) {
          logf(`peersync: **告警** 块 ${id} 所有已知 peer 都拿不到，保留在未修复列表（不删任何其他数据）`);
        }
      } catch (err) {
        logf(`peersync: scrub 失败: ${String(err)}`);
      }
    } finally {
      running = false;
    }
  };
  void (async () => {
    if (!(await sleepOrAbort(ctx, SCRUB_FIRST_DELAY_MS))) return;
    for (;;) {
      await run();
      if (!(await sleepOrAbort(ctx, intervalMs))) return;
    }
  })();
}

/** 可被 AbortSignal 打断的 sleep：睡满且未取消返回 true，否则返回 false。 */
function sleepOrAbort(ctx: SyncContext, ms: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    if (ctx !== undefined && ctx.aborted) {
      resolve(false);
      return;
    }
    let timer: ReturnType<typeof setTimeout>;
    const onAbort = (): void => {
      clearTimeout(timer);
      if (ctx !== undefined) ctx.removeEventListener("abort", onAbort);
      resolve(false);
    };
    timer = setTimeout(() => {
      if (ctx !== undefined) ctx.removeEventListener("abort", onAbort);
      resolve(ctx === undefined || !ctx.aborted);
    }, ms);
    timer.unref?.();
    if (ctx !== undefined) ctx.addEventListener("abort", onAbort);
  });
}

/** 近似 Go `time.Duration.Round(time.Millisecond).String()` 的格式（不覆盖负数与纳秒精度）。 */
function formatGoDuration(ms: number): string {
  if (ms === 0) return "0s";
  let n = Math.round(ms);
  const neg = n < 0;
  if (neg) n = -n;
  if (n < 1000) return (neg ? "-" : "") + `${n}ms`;
  const totalSec = Math.floor(n / 1000);
  const frac = n % 1000;
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  let secStr = String(s);
  if (frac !== 0) {
    const f = String(frac).padStart(3, "0").replace(/0+$/, "");
    secStr = `${s}.${f}`;
  }
  let out: string;
  if (h > 0) out = `${h}h${m}m${secStr}s`;
  else if (m > 0) out = `${m}m${secStr}s`;
  else out = `${secStr}s`;
  return (neg ? "-" : "") + out;
}