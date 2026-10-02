/**
 * 学习进度的编排层（#8 册子 §5.2 / §5.3 / §5.4 / §5.5）：
 * - `reportProgress`：本地双写（`progress` + `checkin_days`）→ 投递 `progress.v1`；**只有网络不可达**才入队。
 * - `pullProgress`：`GET /v1/me` 拉节点侧真实进度与打卡日，按 §3.4 同一比较函数合并进本地。
 *
 * 量纲与判定全在 `core/progress.ts`（纯函数）；本文件只做「写本地 / 发或入队 / 拉回合并」。
 * 离线队列复用 `comment_out`（**不加列**，类型由 `wire` 自带）；补发者是 `core/comment.ts` 的 `flushPending`。
 */
import type { Json } from '@base/protocol-ts';

import type { LocalRepo } from './repo';
import { ensureRegistered } from './comment';
import { ensureLocalIdentity, signRequestHeaders } from './identity';
import { localDay, shouldReport } from '@base/protocol-ts';
import { decodeUtf8 } from './sync';
import type { CheckinDayRow, ProgressRow } from './types';
import { buildEventWire, submitWire, type WireOptions } from './wire';

/** 与 `WireOptions` **同形**：`CommentOptions` / `SyncOptions` 可直接喂进来。 */
export type ProgressOptions = WireOptions;

/** `item_id` 的 ASCII 长度上限（#8 册子 §3.1，与 `validTargetID` 同口径）。 */
const ITEM_ID_MAX = 256;

/** 同一 `item_id` 的上次真实上报时刻（毫秒）；只在本进程内节流，不落盘（§5.3）。 */
const lastReportAt = new Map<string, number>();

export interface ProgressInput {
  itemId: string;
  /** 归一化位置，量纲按条目 type 分派（调用方负责，见 `core/progress.ts`） */
  position: number;
  done: boolean;
  /** 覆盖打卡日（测试用）；缺省取本机本地时区的今天 */
  day?: string;
}

export interface ReportResult {
  /** false = 被节流丢弃或参数非法：未写本地、未发请求 */
  reported: boolean;
  /** true = 网络不可达，已入 `comment_out` 待补发 */
  queued: boolean;
}

/**
 * 上报一次进度（§5.2 先写本地、再进队列）。
 *
 * 丢帧是安全的：上报内容一律是**当前位置的绝对值**（不是增量），故少发一次不造成累计误差（§5.3）。
 * 投递失败**不抛错**：上报是后台动作，节点拒绝（429 / 403 / 400）只静默返回——本地已经记住了。
 * 未配置节点时**不入队**（同 `postComment` 口径）：否则队列会变成永远发不出去的垃圾桶。
 */
export async function reportProgress(
  o: ProgressOptions,
  input: ProgressInput,
  now: number = Date.now(),
): Promise<ReportResult> {
  const itemId = input.itemId;
  if (itemId === '' || itemId.length > ITEM_ID_MAX) return { reported: false, queued: false };
  if (!Number.isInteger(input.position) || input.position < 0) return { reported: false, queued: false };
  if (!shouldReport(lastReportAt.get(itemId), now)) return { reported: false, queued: false };

  const day = input.day ?? localDay(new Date(now));
  const body: Json = { item_id: itemId, position: input.position, done: input.done, day };

  const ident = await ensureLocalIdentity(o.adapters.storage);
  const { eventId, wire } = buildEventWire(ident, 'progress.v1', body);
  // updated_at 存**胜者事件的 created_at**（§5.1 写计划时定死）：从 wire 反解，
  // 免去改动已上线的 `buildEventWire` 签名（它不返回 createdAt）。
  const createdAt = Number((JSON.parse(wire) as { created_at?: number }).created_at ?? 0);
  const row: ProgressRow = {
    itemId,
    position: input.position,
    done: input.done,
    day,
    updatedAt: createdAt,
    eventId,
    dirty: true,
  };
  await o.repo.saveProgressLocal(row);
  lastReportAt.set(itemId, now);

  if (o.nodeBaseUrl === '') return { reported: true, queued: false };
  try {
    const { queued } = await submitWire(o, { eventId, wire, targetId: itemId, queueText: '' });
    return { reported: true, queued };
  } catch {
    return { reported: true, queued: false };
  }
}

/**
 * 拉节点侧进度并合并进本地（§5.5）。**只在同步时调用**，不参与页面渲染路径。
 * 一律静默：未配置节点 / 身份未登记 / 网络失败 / 非 200 都不抛错——页面只读本地表。
 */
export async function pullProgress(o: ProgressOptions): Promise<void> {
  if (o.nodeBaseUrl === '') return;
  try {
    // 签名 GET 要求身份已在节点侧登记，否则 403（与评论读接口同一前置）。
    const ident = await ensureRegistered(o);
    const headers: Record<string, string> = { ...signRequestHeaders(ident, { method: 'GET', path: '/v1/me' }) };
    const res = await o.adapters.http.get(`${o.nodeBaseUrl}/v1/me`, headers);
    if (res.status !== 200) return;
    const page = JSON.parse(decodeUtf8(res.body)) as {
      progress?: Array<Record<string, unknown>>;
      checkin_days?: Array<Record<string, unknown>>;
    };
    const rows: ProgressRow[] = (page.progress ?? []).map((r) => ({
      itemId: String(r.item_id ?? ''),
      position: Number(r.position ?? 0),
      done: Boolean(r.done),
      day: String(r.day ?? ''),
      updatedAt: Number(r.updated_at ?? 0),
      eventId: String(r.event_id ?? ''),
      dirty: false,
    }));
    const days: CheckinDayRow[] = (page.checkin_days ?? []).map((r) => ({
      day: String(r.day ?? ''),
      firstEventId: String(r.first_event_id ?? ''),
      createdAt: Number(r.created_at ?? 0),
    }));
    await o.repo.mergeProgress(rows, days);
  } catch {
    // 静默：拉取失败不该打断 onShow（页面渲染只读本地表）
  }
}