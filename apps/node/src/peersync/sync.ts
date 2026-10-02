// 逐行移植 internal/peersync/sync.go 的 RoundResult / ownershipIndex / SyncPeer（sync.go:14-158）
// 与 RunOnce / RunForever（sync.go:160-235）。
//
// 与 Go 的**有意差异**（记录于文件头）：
//   1. `logf` 签名：Go 是 `func(string, ...any)`；TS 改为 `(msg: string) => void`（调用方预格式化单串）。
//   2. `context.WithTimeout(ctx, 2*requestTimeout)` 换成「每次 peer 创建一个 AbortController +
//      setTimeout(ctrl.abort, 2*REQUEST_TIMEOUT_MS)，并与外层 ctx 用 AbortSignal.any 取并集」。
//   3. `rand.Int63n(60s)` 之首轮 jitter 换成 `Math.floor(Math.random() * 60_000)`（[0,60000)）。
//   4. `time.NewTicker` 调度换成「可被 AbortSignal 打断的 sleepOrAbort + 后台 async 循环」。
//   5. `time.Duration.Round(time.Millisecond).String()` 自实现为 `formatGoDuration`（文件内私有）。
import { merkleRoot } from "@base/protocol-ts";
import type { BlobRef } from "../store/peersync";
import type { SyncStore } from "../store/syncstore";
import { importPack } from "./packimport";
import { fetchBlobs, fetchInventory, postSync, type BlobSize } from "./remote";
import { REQUEST_TIMEOUT_MS, type Config, type Peer, type SyncContext } from "./peer";
import { syncEvents, type EventSyncResult } from "./eventsync";

/** 一个 peer 的一轮结果（册子 §7.2 步骤 7 的日志字段）。`String()` 为 Go 方法的等价实现。 */
export class RoundResult {
  peer = "";
  contentVersion = 0;
  packId = "";
  imported = false;
  equal = false;
  missing = 0;
  extra = 0;
  fetched = 0;
  badFrames = 0;
  noReplica = 0;

  constructor(peer = "") {
    this.peer = peer;
  }

  String(): string {
    return `peer=${this.peer} version=${this.contentVersion} pack=${this.packId} imported=${this.imported} equal=${this.equal} missing=${this.missing} extra=${this.extra} fetched=${this.fetched} bad_frames=${this.badFrames} no_replica=${this.noReplica}`;
  }
}

/**
 * ownershipIndex（sync.go:35-50）：汇总本地「声明持有」的块归属：
 * 内容包的 media_meta 声明块序列 + 事件（评论 / 小组）引用的正文块。同一块保留**先到者**归属。
 */
export function ownershipIndex(st: SyncStore): Record<string, BlobRef> {
  const idx = st.mediaChunkIndex();
  const comments = st.eventBlobIndex();
  for (const [id, ref] of Object.entries(comments)) {
    if (!Object.prototype.hasOwnProperty.call(idx, id)) idx[id] = ref;
  }
  return idx;
}

/**
 * SyncPeer（sync.go:54-158）：对一个 peer 跑完整一轮：包级复制 → 比对 → 补齐 → 副本登记。
 * 顺序不可换：条目视图与块视图必须同一轮内收敛，故先拉包再比块集合。
 */
export async function syncPeer(
  c: Config,
  ctx: SyncContext,
  st: SyncStore,
  p: Peer,
  now: number,
): Promise<RoundResult> {
  const res = new RoundResult(p.url);

  let version = st.contentVersion();
  const outcome = await importPack(c, ctx, st, p, version);
  res.imported = outcome.status === "imported";
  res.packId = outcome.packId;

  version = st.contentVersion();
  res.contentVersion = version;

  const localIDs = st.listAllBlobIDs();
  const localRoot = merkleRoot(localIDs);
  const equal = await postSync(c, ctx, p, version, localRoot);
  res.equal = equal;
  if (equal) {
    // 块集合相等即本 peer 结束（册子 §7.2 步骤 2），不拉 inventory、不登记副本
    res.noReplica = st.countBlobsWithoutReplica();
    return res;
  }

  const inv = await fetchInventory(c, ctx, p, 0);

  // 副本登记：拿到 inventory 后把 peer 声明的每个块 upsert（册子 §7.3）
  for (const b of inv.blobs) {
    st.upsertBlobReplica(b.blob_id, p.url, now);
  }

  // 归属来自 media_meta 的声明块序列：此刻这些块还没进 blobs 表，只有 media_meta 知道它们属于谁。
  const idx = ownershipIndex(st);
  const local = new Set(localIDs);
  const neighbor = new Set<string>();
  const missing: BlobSize[] = [];
  for (const b of inv.blobs) {
    neighbor.add(b.blob_id);
    if (local.has(b.blob_id)) continue;
    // 只补齐「本地仍声明归属」的块（册子 §7.2 步骤 5）。
    if (!Object.prototype.hasOwnProperty.call(idx, b.blob_id)) continue;
    missing.push({ blobId: b.blob_id, size: b.size });
  }
  for (const id of localIDs) {
    if (!neighbor.has(id)) {
      res.extra++; // 只记录不删（册子 §7.2 步骤 4、风险 5）
    }
  }
  res.missing = missing.length;

  if (missing.length > 0) {
    const fr = await fetchBlobs(c, ctx, p, missing, (blobId, data) => {
      // 反熵护栏 2（册子 §4.5）：落块前再查一次墓碑——对端可能是尚未收到墓碑的旧节点。
      if (st.isRevokedPayload(blobId)) return;
      const ref = idx[blobId];
      st.putBlob(blobId, data, ref.itemId, ref.seq);
    });
    res.fetched = fr.fetched;
    res.badFrames = fr.badFrames;
    for (const id of fr.tooLarge) {
      console.log(`peersync: 块 ${id} 超过单请求字节上限，无法走 fetch（本期不做分片传输）`);
    }
  }

  res.noReplica = st.countBlobsWithoutReplica();
  return res;
}

/** 取错误文案（Go `%v` on error → 只打 `.Error()`，不含 JS 的 "Error: " 前缀）。 */
function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * RunOnce（sync.go:160-189）：逐 peer 串行跑一轮（册子 §7.1：不并发打满带宽）。
 * 单 peer 失败只记日志并继续下一个，不返回错误、不终止调度器。
 */
export async function runOnce(
  c: Config,
  ctx: SyncContext,
  st: SyncStore,
  peers: Peer[],
  logf: (msg: string) => void,
): Promise<RoundResult[]> {
  const now = Math.floor(Date.now() / 1000);
  const out: RoundResult[] = [];
  for (const p of peers) {
    if (ctx !== undefined && ctx.aborted) break;
    // context.WithTimeout(ctx, 2*requestTimeout)：本 peer 整轮的总超时。
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(new Error("peersync: 单 peer 整轮超时")), 2 * REQUEST_TIMEOUT_MS);
    timer.unref?.();
    const pctx: SyncContext = ctx === undefined ? ctrl.signal : AbortSignal.any([ctx, ctrl.signal]);
    // 事件先于块：事件带来评论正文块的归属，同一轮里块补齐才认得它可以拉；且墓碑先落地，
    // 随后 SyncPeer 落块时的护栏 2 立即生效。
    let ev: EventSyncResult | undefined;
    let evErr: unknown;
    try {
      ev = await syncEvents(c, pctx, st, p);
    } catch (err) {
      evErr = err;
    }
    let res: RoundResult | undefined;
    let err: unknown;
    try {
      res = await syncPeer(c, pctx, st, p, now);
    } catch (e) {
      err = e;
    }
    clearTimeout(timer);
    // 事件同步失败只记日志，不能让块反熵的结论丢失。
    if (evErr !== undefined) {
      logf(`peersync: ${p.url} 事件同步失败: ${errMsg(evErr)}`);
    } else if (ev !== undefined && (ev.events > 0 || ev.tombstones > 0)) {
      logf(`peersync: ${p.url} ${ev.String()}`);
    }
    if (err !== undefined) {
      logf(`peersync: ${p.url} 本轮失败: ${errMsg(err)}`);
      continue;
    }
    logf(`peersync: ${(res as RoundResult).String()}`);
    out.push(res as RoundResult);
  }
  return out;
}

/**
 * RunForever（sync.go:191-235）：启动反熵调度器：延迟随机 0–60 秒后首轮，此后每 interval 一轮；
 * 单轮不重入（风险 6）。
 */
export function runForever(
  c: Config,
  ctx: SyncContext,
  st: SyncStore,
  peers: Peer[],
  intervalMs: number,
  logf: (msg: string) => void,
): void {
  if (peers.length === 0 || intervalMs <= 0) return;
  let running = false;
  const run = async (): Promise<void> => {
    if (running) {
      logf("peersync: 上一轮尚未结束，跳过本轮");
      return;
    }
    running = true;
    try {
      const start = Date.now();
      await runOnce(c, ctx, st, peers, logf);
      logf(`peersync: 本轮耗时 ${formatGoDuration(Date.now() - start)}`);
    } finally {
      running = false;
    }
  };
  void (async () => {
    const jitter = Math.floor(Math.random() * 60_000);
    if (!(await sleepOrAbort(ctx, jitter))) return;
    await run();
    for (;;) {
      if (!(await sleepOrAbort(ctx, intervalMs))) return;
      await run();
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
export function formatGoDuration(ms: number): string {
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