<template>
  <view class="wrap">
    <view class="bar">
      <text class="title">私信 · {{ short(peerId) }}</text>
    </view>

    <!-- notice 原文：无密钥 / 解不开时必须原位告知，禁止静默跳过、禁止把密文铺到界面上 -->
    <text v-if="notice" class="notice">{{ notice }}</text>
    <text v-if="error" class="error">{{ error }}</text>
    <text v-if="error" class="act" @click="retry">重试</text>

    <view v-if="pending.length > 0" class="pending">
      <view class="pending-bar">
        <text class="pending-title">待发送 {{ pending.length }} 条</text>
      </view>
      <view v-for="p in pending" :key="p.eventId" class="po">
        <view class="po-foot">
          <text :class="p.state === 'failed' ? 'po-reason' : 'po-state'">
            {{ p.state === 'failed' ? '发送失败：' + (p.reason || '未知原因') : '待发送' }}
          </text>
          <text class="act" @click="dropPending(p.eventId)">删除</text>
        </view>
      </view>
    </view>

    <text v-if="unconfigured" class="hint">未配置节点，暂时读不到消息</text>
    <block v-else>
      <text v-if="!error && !loading && feed.length === 0" class="hint">还没有消息</text>

      <view v-for="(m, i) in feed" :key="m.eventId" class="cmt-floor">
        <view class="cmt-head">
          <text class="cmt-floor-no">{{ i + 1 }}楼</text>
          <view class="cmt-avatar" :style="{ background: avatarBg(m.actor) }"></view>
          <text class="cmt-author-name">{{ m.mine ? '我' : authorName(m.actor) }}</text>
          <text class="cmt-meta">· {{ rel(m.createdAt) }}</text>
        </view>
        <text class="cmt-text">{{ m.text ?? '（无法解密）' }}</text>
      </view>
      <text v-if="loading" class="hint">加载中…</text>
      <text v-else-if="!error && feed.length > 0 && nextCursor === null" class="hint">没有更多了</text>
      <text v-if="moreHint" class="hint">{{ moreHint }}</text>
    </block>

    <text v-if="blocked" class="blocked">{{ blocked }}</text>
    <view class="composer">
      <!-- 输入框只按「结构性不可写」禁用（canInput）；若用 canSend（含「草稿非空」）空草稿会锁死输入框 -->
      <input v-model="draft" class="input" :disabled="!canInput" placeholder="说点什么…" />
      <button size="mini" :disabled="!canSend" @click="send">{{ sending ? '发送中…' : '发送' }}</button>
    </view>
    <text v-if="tip" class="hint">{{ tip }}</text>
  </view>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import { onLoad, onReachBottom, onShow } from '@dcloudio/uni-app';

import {
  fetchConversation,
  postDM,
  DmError,
  type DmConversation,
  type DmMessage,
  type DmOptions,
} from '../../core/dm';
import { flushPending } from '../../core/comment';
import type { CommentOutRow } from '../../core/types';
import { bootstrap } from '../../platform';
import {
  UNKNOWN_FLAGS,
  canPostComment,
  postBlockedReason,
  type CapabilityFlags,
} from '../../core/selfcheck';
import { avatarBg, useActorNames } from '../../core/useActorNames';

const opts = ref<DmOptions | null>(null);
const peerId = ref('');
const feed = ref<DmMessage[]>([]);
const nextCursor = ref<string | null>(null);
const notice = ref('');
const error = ref('');
const moreHint = ref('');
const tip = ref('');
const loading = ref(false);
const sending = ref(false);
const draft = ref('');
const unconfigured = ref(false);

/** 昵称三级降级（名册 → profile 补查 → id[:8] 回退）；只解析对方，自己恒定显示「我」 */
const { authorName, loadNames } = useActorNames();

/** 待发区：只显示本会话的行（按 target_id 隔离）。 */
const pending = ref<CommentOutRow[]>([]);

/** 写门控：与评论 / 小组同一条「能否写事件」的能力，不新增自检探测。 */
const caps = ref<CapabilityFlags>(UNKNOWN_FLAGS);
const blocked = computed(() => postBlockedReason(caps.value));
/** 输入框可写性：只按「结构性不可写」判断（草稿为空不禁用）。ref 在模板里自动解包，故模板只能写 `canInput`。 */
const canInput = computed(() => canPostComment(caps.value));
const canSend = computed(() => canPostComment(caps.value) && draft.value.trim() !== '' && !sending.value);

async function load() {
  try {
    const ctx = await bootstrap();
    opts.value = { adapters: ctx.opts.adapters, repo: ctx.repo, nodeBaseUrl: ctx.opts.nodeBaseUrl };
    caps.value = ctx.capabilities;
    unconfigured.value = ctx.opts.nodeBaseUrl === '';
  } catch (e) {
    error.value = (e as Error).message;
  }
}

/** 待发区只取本会话的行；密文（p.text）不渲染——对用户无意义。 */
async function loadPending() {
  if (!opts.value) return;
  const all = await opts.value.repo.listCommentOut();
  pending.value = all.filter((r) => r.targetId === `dm/${peerId.value}`);
}

/** 补发一轮并刷新：不 await 进页面（由 onShow 决定），与评论 / 小组页同一体例。 */
async function flush() {
  if (!opts.value) return;
  const r = await flushPending(opts.value);
  if (r.sent + r.failed > 0) await loadPending();
  if (r.sent > 0) await refresh();
}

async function dropPending(eventId: string) {
  if (!opts.value) return;
  await opts.value.repo.removeCommentOut(eventId);
  await loadPending();
}

function applyFeed(c: DmConversation) {
  feed.value = c.messages;
  nextCursor.value = c.nextCursor;
  notice.value = c.notice; // 非空即提示原文，原位显示
  moreHint.value = c.nextCursor === null ? '' : '更早的消息本版暂不支持翻页';
}

/** 楼层化：消息按时间升序（core 已排序），楼号即列表序；昵称/头像走同一降级链，失败静默。 */
async function refresh() {
  if (unconfigured.value || !opts.value || peerId.value === '') return;
  loading.value = true;
  error.value = '';
  try {
    applyFeed(await fetchConversation(opts.value, peerId.value));
    await loadNames(feed.value.filter((m) => !m.mine).map((m) => m.actor), opts.value);
  } catch (e) {
    error.value = e instanceof DmError ? e.message : (e as Error).message;
    feed.value = [];
    nextCursor.value = null;
    moreHint.value = '';
  } finally {
    loading.value = false;
  }
}

/**
 * core/dm.ts 的 fetchConversation 只导出「取首页并解密」，**不接受游标**；
 * 带解密的续页需要其内部未导出的 openText。故不伪造续页：游标非空时原位说明还有更早的消息。
 */
async function loadMore() {
  if (unconfigured.value || nextCursor.value === null) return;
  moreHint.value = '更早的消息本版暂不支持翻页';
}

async function retry() {
  await refresh();
}

/** 发送：断网入队（密文进队列）；节点给了响应则失败/成功，不入队。 */
async function send() {
  if (!canSend.value || !opts.value) return;
  const text = draft.value.trim();
  sending.value = true;
  tip.value = '';
  try {
    const r = await postDM(opts.value, peerId.value, text);
    draft.value = '';
    if (r.queued) {
      tip.value = '已保存，联网后自动补发';
      await loadPending();
    } else {
      tip.value = '已发送';
      await refresh();
    }
  } catch (e) {
    tip.value = e instanceof DmError ? e.message : `发送失败：${(e as Error).message ?? String(e)}`;
  } finally {
    sending.value = false;
  }
}

function short(hex: string): string {
  return hex.slice(0, 8);
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

onLoad((q) => {
  peerId.value = String(q?.peerId ?? '');
});

onShow(async () => {
  await load();
  await loadPending();
  await refresh();
  void flush(); // 不 await：补发不阻塞首屏
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
.pending { margin-bottom: 12px; padding: 10px; background: #fffaf0; border: 1px solid #f6e05e; border-radius: 6px; }
.pending-bar { display: flex; align-items: center; justify-content: space-between; }
.pending-title { font-size: 14px; font-weight: 600; }
.po { padding: 8px 0; border-top: 1px solid #f6e05e; }
.po-foot { display: flex; align-items: center; justify-content: space-between; }
.po-state { color: #888888; font-size: 12px; }
.po-reason { color: #c05621; font-size: 12px; }
.cmt-floor { padding: 10px 0; border-bottom: 1px solid #eeeeee; }
.cmt-head { display: flex; align-items: center; }
.cmt-floor-no { margin-right: 6px; color: #2b6cb0; font-size: 12px; }
.cmt-avatar { width: 20px; height: 20px; margin-right: 6px; border-radius: 50%; }
.cmt-author-name { margin-right: 4px; color: #2b6cb0; font-size: 13px; }
.cmt-meta { display: block; color: #888888; font-size: 12px; }
.cmt-text { display: block; margin-top: 4px; font-size: 15px; line-height: 1.6; }
.hint { display: block; margin-top: 8px; color: #888888; font-size: 13px; }
.error { display: block; color: #c53030; font-size: 13px; }
.notice { display: block; margin-bottom: 8px; color: #b7791f; font-size: 13px; }
.blocked { display: block; margin-bottom: 8px; color: #c05621; font-size: 13px; }
.composer { position: fixed; left: 0; right: 0; bottom: 0; display: flex; align-items: center; padding: 8px 12px; background: #ffffff; border-top: 1px solid #eeeeee; }
.input { flex: 1; height: 36px; margin-right: 8px; padding: 0 10px; background: #f5f5f5; border-radius: 6px; font-size: 14px; }
</style>
