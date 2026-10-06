<template>
  <view class="wrap">
    <view class="bar">
      <text class="title">评论</text>
      <text class="act" @click="reload">刷新</text>
    </view>

    <scroll-view class="picker" scroll-x>
      <text class="chip" :class="target === '' ? 'chip-on' : ''" @click="pick('')">全部最新</text>
      <text
        v-for="it in items"
        :key="it.itemId"
        class="chip"
        :class="target === it.itemId ? 'chip-on' : ''"
        @click="pick(it.itemId)"
      >{{ it.title || it.itemId }}</text>
    </scroll-view>

    <view v-if="pending.length > 0" class="pending">
      <view class="pending-bar">
        <text class="pending-title">待发送 {{ pending.length }} 条</text>
        <text class="act" @click="retryPending">立即补发</text>
      </view>
      <view v-for="p in pending" :key="p.eventId" class="po">
        <text class="po-target">{{ targetTitle(p.targetId) }}</text>
        <text class="po-text">{{ p.text }}</text>
        <view class="po-foot">
          <text :class="p.state === 'failed' ? 'po-reason' : 'po-state'">{{ p.state === 'failed' ? '发送失败：' + p.reason : '待发送' }}</text>
          <text v-if="p.state === 'failed'" class="act" @click="dropPending(p.eventId)">删除</text>
        </view>
      </view>
    </view>

    <text v-if="unconfigured" class="hint">未配置节点，请先在「我的 → 设置」里填写节点地址</text>
    <block v-else>
      <text v-if="error" class="error">{{ error }}</text>
      <text v-if="error" class="act" @click="reload">重试</text>
      <text v-if="error && pending.length > 0" class="hint">离线，仅显示待发送</text>
      <text v-if="!error && !loading && list.length === 0" class="hint">还没有评论</text>

      <view v-for="floor in tree" :key="floor.item.eventId" class="cmt-floor">
        <view class="cmt-head">
          <text class="cmt-floor-no">{{ floor.floorNo }}楼</text>
          <view class="cmt-avatar" :style="{ background: avatarBg(floor.item.actor) }"></view>
          <text class="cmt-author-name">{{ authorName(floor.item.actor) }}</text>
          <text class="cmt-meta">· {{ rel(floor.item.createdAt) }}</text>
        </view>
        <text class="cmt-text">{{ floor.item.text }}</text>
        <view v-if="(tagsByEvent[floor.item.eventId] ?? []).length > 0" class="cmt-tags">
          <text v-for="(t, i) in tagsByEvent[floor.item.eventId] ?? []" :key="i" class="cmt-tag">{{ t }}</text>
        </view>
        <view class="row-acts">
          <text class="like-btn" :class="{ liked: likedSet.has(floor.item.eventId) }" @click="toggleLike(floor.item)">♥ {{ floor.item.likeCount > 0 ? floor.item.likeCount : '' }}</text>
          <text class="report-btn" @click="openReport(floor.item.eventId)">举报</text>
        </view>
        <!-- 子回复（depth=1）：缩进块 -->
        <view v-for="sub in floor.children" :key="sub.item.eventId" class="cmt-sub">
          <view class="cmt-sub-head">
            <view class="cmt-avatar cmt-avatar-sm" :style="{ background: avatarBg(sub.item.actor) }"></view>
            <text class="cmt-sub-author">{{ authorName(sub.item.actor) }}</text>
            <text v-if="sub.item.replyTo" class="cmt-sub-reply">回复 {{ floorName(sub.item.replyTo, sub.item.actor) }}</text>
            <text class="cmt-meta">· {{ rel(sub.item.createdAt) }}</text>
          </view>
          <text class="cmt-text">{{ sub.item.text }}</text>
          <view class="row-acts">
            <text class="like-btn" :class="{ liked: likedSet.has(sub.item.eventId) }" @click="toggleLike(sub.item)">♥ {{ sub.item.likeCount > 0 ? sub.item.likeCount : '' }}</text>
            <text class="report-btn" @click="openReport(sub.item.eventId)">举报</text>
          </view>
        </view>
      </view>
      <text v-if="loading" class="hint">加载中…</text>
      <text v-else-if="!error && list.length > 0 && nextCursor === null" class="hint">没有更多了</text>
    </block>

    <text v-if="blocked" class="blocked">{{ blocked }}</text>
    <view class="composer">
      <input
        v-model="draft"
        class="input"
        :disabled="unconfigured || target === ''"
        :placeholder="unconfigured ? '未配置节点，暂不能评论' : target === '' ? '选择一项内容后可以评论' : '说点什么…'"
      />
      <button size="mini" :disabled="!canSend" @click="send">{{ sending ? '发表中…' : '发表' }}</button>
    </view>
    <text v-if="notice" class="hint">{{ notice }}</text>

    <!-- 举报弹层：四原因单选（#79 §7.2） -->
    <view v-if="showReport" class="modal-mask" @click.self="showReport = false">
      <view class="modal">
        <text class="modal-title">举报这条评论</text>
        <view
          v-for="(label, key) in REPORT_LABEL"
          :key="key"
          class="report-opt"
          :class="{ 'report-opt-on': reportReason === key }"
          @click="pickReason(key)"
        >{{ label }}</view>
        <view class="modal-actions">
          <view class="modal-btn" @click="showReport = false">取消</view>
          <view class="modal-btn primary" @click="submitReport">提交</view>
        </view>
      </view>
    </view>
  </view>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import { onReachBottom, onShow } from '@dcloudio/uni-app';

import { sendLike, sendReport, type ReportReason } from '@base/core-ts/like';
import { buildCommentTree, type CommentTreeNode } from '../../core/comment-tree';
import {
  fetchCommentText,
  flushPending,
  listComments,
  postComment,
  takePendingTarget,
  CommentError,
  type CommentItem,
  type CommentOptions,
} from '../../core/comment';
import type { CommentOutRow, ItemRow } from '../../core/types';
import { bootstrap } from '../../platform';
import {
  UNKNOWN_FLAGS,
  canPostComment,
  postBlockedReason,
  SELFCHECK_TARGET,
  type CapabilityFlags,
} from '../../core/selfcheck';
import { avatarBg, useActorNames } from '../../core/useActorNames';

/** 列表项 = 节点返回的投影 + 按 payload_cid 取回的正文（取不到则为占位文案）。 */
interface Row extends CommentItem {
  text: string;
}

const opts = ref<CommentOptions | null>(null);
const unconfigured = ref(false);
const items = ref<ItemRow[]>([]);
const target = ref('');
const list = ref<Row[]>([]);
const nextCursor = ref<string | null>(null);
const error = ref('');
const notice = ref('');
const loading = ref(false);
const sending = ref(false);
const draft = ref('');
/** eventId → 该评论已有标签的标题列表（空数组/无键 = 不显示，不占位） */
const tagsByEvent = ref<Record<string, string[]>>({});

const likedSet = ref<Set<string>>(new Set()); // 本会话高亮态（进页时由 like_out 初始化）
const likeBusy = ref<Set<string>>(new Set()); // 防抖：发送中禁点
const showReport = ref(false);
const reportTarget = ref('');
const reportReason = ref<ReportReason>('spam');
const REPORT_LABEL: Record<ReportReason, string> = {
  spam: '垃圾广告', abuse: '辱骂攻击', illegal: '违法违规', other: '其他',
};

/** 楼中楼：扁平投影 → 楼层根（含子回复）纯本地派生，零网络 */
const tree = computed<CommentTreeNode<Row>[]>(() => buildCommentTree(list.value));
/** 昵称三级降级（名册 → profile 补查 → id[:8] 回退）；跨分页累积 */
const { authorName, loadNames } = useActorNames();

/** 能力标志：启动时只有 cryptoOk 有值，其余 unknown（unknown 不降级） */
const caps = ref<CapabilityFlags>(UNKNOWN_FLAGS);
const blocked = computed(() => postBlockedReason(caps.value));
const canSend = computed(
  () =>
    canPostComment(caps.value) &&
    !unconfigured.value &&
    target.value !== '' &&
    draft.value.trim() !== '' &&
    !sending.value,
);

/** 待发区：不随 target 过滤——它是「尚未生效的本地状态」，过滤会让人误以为没待发了（本册 §6）。 */
const pending = ref<CommentOutRow[]>([]);

async function load() {
  try {
    const ctx = await bootstrap();
    opts.value = { adapters: ctx.opts.adapters, repo: ctx.repo, nodeBaseUrl: ctx.opts.nodeBaseUrl };
    caps.value = ctx.capabilities;
    // 本地已下载内容列表：零网络，用 itemId 作 target_id，与文章页入口同口径
    items.value = await ctx.repo.listItems();
    unconfigured.value = ctx.opts.nodeBaseUrl === '';
  } catch (e) {
    error.value = (e as Error).message;
    return;
  }
}

async function loadPending() {
  if (!opts.value) return;
  pending.value = await opts.value.repo.listCommentOut();
}

/** 目标标题取自已下载内容列表（零网络）；找不到就退化成 target_id。 */
function targetTitle(itemId: string): string {
  return items.value.find((i) => i.itemId === itemId)?.title || itemId;
}

/** 补发一轮并刷新：不 await 进页面（由 onShow 决定），页面按钮会 await。 */
async function flush() {
  if (!opts.value) return;
  const r = await flushPending(opts.value);
  if (r.sent + r.failed > 0) await loadPending();
  if (r.sent > 0) await refresh();
}

async function retryPending() {
  await flush();
}

async function dropPending(eventId: string) {
  if (!opts.value) return;
  await opts.value.repo.removeCommentOut(eventId);
  await loadPending();
}

async function refresh() {
  if (unconfigured.value || !opts.value) return;
  loading.value = true;
  error.value = '';
  try {
    const page = await listComments(opts.value, { targetId: target.value });
    nextCursor.value = page.nextCursor;
    list.value = await withText(visible(page.items), opts.value);
    await initLikes();
    await attachTags(list.value);
    await loadNames(list.value.map((r) => r.actor), opts.value);
  } catch (e) {
    error.value = e instanceof CommentError ? e.message : (e as Error).message;
    list.value = [];
    nextCursor.value = null;
  } finally {
    loading.value = false;
  }
}

async function loadMore() {
  if (unconfigured.value || !opts.value || nextCursor.value === null || loading.value) return;
  loading.value = true;
  try {
    const page = await listComments(opts.value, { targetId: target.value, cursor: nextCursor.value });
    nextCursor.value = page.nextCursor;
    list.value = [...list.value, ...(await withText(visible(page.items), opts.value))];
    await initLikes();
    await attachTags(list.value);
    await loadNames(list.value.map((r) => r.actor), opts.value);
  } catch (e) {
    error.value = e instanceof CommentError ? e.message : (e as Error).message;
  } finally {
    loading.value = false;
  }
}

/** 自检事件是探测产物，不是用户内容：任何列表都不展示（selfcheck spec §7）。 */
function visible(rows: CommentItem[]): CommentItem[] {
  return rows.filter((r) => r.targetId !== SELFCHECK_TARGET);
}

/** 逐条取正文：单条失败降级为占位，不让一条坏数据打断整页。 */
async function withText(rows: CommentItem[], o: CommentOptions): Promise<Row[]> {
  return Promise.all(
    rows.map(async (r) => ({ ...r, text: (await fetchCommentText(o, r.payloadCid)) ?? '正文暂不可用' })),
  );
}

/** 逐条挂标签：只查当前可见这几条评论的关联行，不整表扫（仓储侧走 `idx_tag_links_target`） */
async function attachTags(rows: Row[]) {
  if (!opts.value) return;
  const links = await opts.value.repo.listTagLinksOfTargets(rows.map((r) => r.eventId));
  const map: Record<string, string[]> = {};
  for (const l of links) {
    const t = await opts.value.repo.getItem(l.tagId);
    (map[l.targetId] ??= []).push(t?.title || l.tagId);
  }
  tagsByEvent.value = map;
}

async function initLikes() {
  const ids = list.value.map((r) => r.eventId);
  const s = new Set<string>();
  for (const id of ids) if (await opts.value!.repo.getLikeOut(id) === 'like') s.add(id);
  likedSet.value = s;
}

async function toggleLike(row: Row) {
  if (!opts.value || likeBusy.value.has(row.eventId)) return;
  const wasLiked = likedSet.value.has(row.eventId);
  const action = wasLiked ? 'unlike' : 'like';
  likeBusy.value.add(row.eventId);
  try {
    await sendLike(opts.value, row.eventId, action);
    await opts.value.repo.upsertLikeOut(row.eventId, action);
    // 本地计数 ±1（下次拉列表以服务端为准）
    row.likeCount = Math.max(0, row.likeCount + (action === 'like' ? 1 : -1));
    const s = new Set(likedSet.value);
    if (action === 'like') s.add(row.eventId); else s.delete(row.eventId);
    likedSet.value = s;
  } catch (e) {
    uni.showToast({ title: e instanceof Error ? e.message : '操作失败', icon: 'none' });
  } finally {
    likeBusy.value.delete(row.eventId);
  }
}

function openReport(eventId: string) {
  reportTarget.value = eventId;
  reportReason.value = 'spam';
  showReport.value = true;
}

function pickReason(key: string) {
  reportReason.value = key as ReportReason;
}

async function submitReport() {
  if (!opts.value || !reportTarget.value) return;
  try {
    await sendReport(opts.value, reportTarget.value, reportReason.value);
    showReport.value = false;
    uni.showToast({ title: '已提交，感谢反馈', icon: 'none' });
  } catch (e) {
    uni.showToast({ title: e instanceof Error ? e.message : '提交失败', icon: 'none' });
  }
}

function pick(itemId: string) {
  target.value = itemId;
  nextCursor.value = null;
  void refresh();
}

async function reload() {
  await load();
  await refresh();
}

async function send() {
  if (!canSend.value || !opts.value) return;
  const text = draft.value.trim();
  sending.value = true;
  notice.value = '';
  try {
    const r = await postComment(opts.value, { targetId: target.value, text });
    draft.value = '';
    if (r.queued) {
      notice.value = '已保存，联网后自动补发';
      await loadPending();
    } else {
      notice.value = '已发表';
      await refresh();
    }
  } catch (e) {
    // 不用 instanceof 兜成通用文案：非 CommentError 的裸错误也要把原因显示出来，否则真机无从排查
    notice.value = e instanceof CommentError ? e.message : `提交失败：${(e as Error).message ?? String(e)}`;
  } finally {
    sending.value = false;
  }
}

/** 回复指向：命中楼层根显示「N楼」，命中子回复显示其昵称，都落空则回退成自己。 */
function floorName(replyTo: string, actor: string): string {
  const floor = tree.value.find((f) => f.item.eventId === replyTo);
  if (floor) return `${floor.floorNo}楼`;
  for (const f of tree.value) {
    const sub = f.children.find((c) => c.item.eventId === replyTo);
    if (sub) return authorName(sub.item.actor);
  }
  return authorName(actor);
}

function rel(ms: number): string {
  const d = Date.now() - ms;
  if (!ms || d < 0) return '';
  if (d < 60_000) return '刚刚';
  if (d < 3_600_000) return `${Math.floor(d / 60_000)} 分钟前`;
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)} 小时前`;
  if (d < 30 * 86_400_000) return `${Math.floor(d / 86_400_000)} 天前`;
  return new Date(ms).toISOString().slice(0, 10);
}

onShow(async () => {
  // 文章页 → 评论 tab 的锚定态（tab 页不能带 query）
  const anchor = takePendingTarget();
  await load();
  if (anchor) target.value = anchor;
  await loadPending();
  await refresh();
  void flush(); // 不 await：补发不阻塞首屏（本册 §6）
});

onReachBottom(() => {
  void loadMore();
});
</script>

<style>
.wrap { padding: 16px; padding-bottom: 80px; }
.bar { display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; }
.title { font-size: 20px; font-weight: 600; }
.act { color: #2b6cb0; font-size: 14px; }
.picker { white-space: nowrap; margin-bottom: 12px; }
.chip { display: inline-block; padding: 4px 10px; margin-right: 8px; border-radius: 12px; background: #f0f0f0; color: #555555; font-size: 13px; }
.chip-on { background: #2b6cb0; color: #ffffff; }
.cmt-floor { padding: 10px 0; border-bottom: 1px solid #eeeeee; }
.cmt-head { display: flex; align-items: center; }
.cmt-floor-no { margin-right: 6px; color: #2b6cb0; font-size: 12px; }
.cmt-avatar { width: 20px; height: 20px; margin-right: 6px; border-radius: 50%; }
.cmt-avatar-sm { width: 16px; height: 16px; }
.cmt-author-name { margin-right: 4px; color: #2b6cb0; font-size: 13px; }
.cmt-meta { display: block; color: #888888; font-size: 12px; }
.cmt-text { display: block; margin-top: 4px; font-size: 15px; line-height: 1.6; }
.cmt-sub { margin-top: 6px; margin-left: 26px; padding: 6px 8px; background: #fafafa; border-radius: 6px; }
.cmt-sub-head { display: flex; align-items: center; }
.cmt-sub-author { margin-right: 4px; color: #2b6cb0; font-size: 13px; }
.cmt-sub-reply { margin-right: 4px; color: #888888; font-size: 12px; }
.cmt-tags { display: flex; flex-wrap: wrap; margin-top: 4px; }
.cmt-tag { padding: 1px 8px; margin: 0 8px 4px 0; background: #ebf8ff; color: #2b6cb0; border-radius: 10px; font-size: 12px; }
.hint { display: block; margin-top: 8px; color: #888888; font-size: 13px; }
.error { display: block; color: #c53030; font-size: 13px; }
.pending { margin-bottom: 12px; padding: 10px; background: #fffaf0; border: 1px solid #f6e05e; border-radius: 6px; }
.pending-bar { display: flex; align-items: center; justify-content: space-between; }
.pending-title { font-size: 14px; font-weight: 600; }
.po { padding: 8px 0; border-top: 1px solid #f6e05e; }
.po-target { display: block; color: #888888; font-size: 12px; }
.po-text { display: block; margin-top: 2px; font-size: 15px; }
.po-foot { display: flex; align-items: center; justify-content: space-between; margin-top: 4px; }
.po-state { color: #888888; font-size: 12px; }
.po-reason { color: #c05621; font-size: 12px; }
.blocked { display: block; margin-bottom: 8px; color: #c05621; font-size: 13px; }
.composer { position: fixed; left: 0; right: 0; bottom: 0; display: flex; align-items: center; padding: 8px 12px; background: #ffffff; border-top: 1px solid #eeeeee; }
.input { flex: 1; height: 36px; margin-right: 8px; padding: 0 10px; background: #f5f5f5; border-radius: 6px; font-size: 14px; }
.row-acts { display: flex; align-items: center; margin-top: 6px; }
.like-btn { margin-right: 16px; color: #888888; font-size: 13px; }
.like-btn.liked { color: #e53e3e; }
.report-btn { color: #888888; font-size: 13px; }
.modal-mask { position: fixed; inset: 0; z-index: 100; background: rgba(0, 0, 0, 0.5); display: flex; align-items: flex-end; }
.modal { width: 100%; max-height: 80vh; overflow-y: auto; padding: 16px; background: #ffffff; border-radius: 12px 12px 0 0; }
.modal-title { display: block; margin-bottom: 12px; font-size: 16px; font-weight: 600; }
.report-opt { margin-bottom: 8px; padding: 10px 12px; border: 1px solid #eeeeee; border-radius: 6px; font-size: 14px; color: #555555; }
.report-opt-on { border-color: #2b6cb0; background: #ebf8ff; color: #2b6cb0; }
.modal-actions { display: flex; margin-top: 12px; }
.modal-btn { flex: 1; padding: 10px; text-align: center; background: #f0f0f0; border-radius: 6px; font-size: 14px; color: #555555; }
.modal-btn.primary { margin-left: 12px; background: #2b6cb0; color: #ffffff; }
</style>