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

    <text v-if="unconfigured" class="hint">未配置节点，请先在「我的 → 设置」里填写节点地址</text>
    <block v-else>
      <text v-if="error" class="error">{{ error }}</text>
      <text v-if="error" class="act" @click="reload">重试</text>
      <text v-if="!error && !loading && list.length === 0" class="hint">还没有评论</text>

      <view v-for="c in list" :key="c.eventId" class="cmt">
        <text class="cmt-meta">{{ short(c.actor) }} · {{ rel(c.createdAt) }}</text>
        <text v-if="c.replyTo" class="cmt-reply">回复 {{ short(c.replyTo) }}</text>
        <text class="cmt-text">{{ c.text }}</text>
      </view>
      <text v-if="loading" class="hint">加载中…</text>
      <text v-else-if="!error && list.length > 0 && nextCursor === null" class="hint">没有更多了</text>
    </block>

    <view class="composer">
      <input
        v-model="draft"
        class="input"
        :disabled="target === ''"
        :placeholder="target === '' ? '选择一项内容后可以评论' : '说点什么…'"
      />
      <button size="mini" :disabled="!canSend" @click="send">{{ sending ? '发表中…' : '发表' }}</button>
    </view>
    <text v-if="notice" class="hint">{{ notice }}</text>
  </view>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import { onReachBottom, onShow } from '@dcloudio/uni-app';

import {
  fetchCommentText,
  listComments,
  postComment,
  takePendingTarget,
  CommentError,
  type CommentItem,
  type CommentOptions,
} from '../../core/comment';
import type { ItemRow } from '../../core/types';
import { bootstrap } from '../../platform';

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

const canSend = computed(() => target.value !== '' && draft.value.trim() !== '' && !sending.value);

async function load() {
  try {
    const ctx = await bootstrap();
    opts.value = { adapters: ctx.opts.adapters, repo: ctx.repo, nodeBaseUrl: ctx.opts.nodeBaseUrl };
    // 本地已下载内容列表：零网络，用 itemId 作 target_id，与文章页入口同口径
    items.value = await ctx.repo.listItems();
    unconfigured.value = ctx.opts.nodeBaseUrl === '';
  } catch (e) {
    error.value = (e as Error).message;
    return;
  }
}

async function refresh() {
  if (unconfigured.value || !opts.value) return;
  loading.value = true;
  error.value = '';
  try {
    const page = await listComments(opts.value, { targetId: target.value });
    nextCursor.value = page.nextCursor;
    list.value = await withText(page.items, opts.value);
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
    list.value = [...list.value, ...(await withText(page.items, opts.value))];
  } catch (e) {
    error.value = e instanceof CommentError ? e.message : (e as Error).message;
  } finally {
    loading.value = false;
  }
}

/** 逐条取正文：单条失败降级为占位，不让一条坏数据打断整页。 */
async function withText(rows: CommentItem[], o: CommentOptions): Promise<Row[]> {
  return Promise.all(
    rows.map(async (r) => ({ ...r, text: (await fetchCommentText(o, r.payloadCid)) ?? '正文暂不可用' })),
  );
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
    await postComment(opts.value, { targetId: target.value, text });
    draft.value = '';
    notice.value = '已发表';
    await refresh();
  } catch (e) {
    // 不用 instanceof 兜成通用文案：非 CommentError 的裸错误也要把原因显示出来，否则真机无从排查
    notice.value = e instanceof CommentError ? e.message : `提交失败：${(e as Error).message ?? String(e)}`;
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

onShow(async () => {
  // 文章页 → 评论 tab 的锚定态（tab 页不能带 query）
  const pending = takePendingTarget();
  await load();
  if (pending) target.value = pending;
  await refresh();
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
.cmt { padding: 10px 0; border-bottom: 1px solid #eeeeee; }
.cmt-meta { display: block; color: #888888; font-size: 12px; }
.cmt-reply { display: block; color: #888888; font-size: 12px; }
.cmt-text { display: block; margin-top: 4px; font-size: 15px; line-height: 1.6; }
.hint { display: block; margin-top: 8px; color: #888888; font-size: 13px; }
.error { display: block; color: #c53030; font-size: 13px; }
.composer { position: fixed; left: 0; right: 0; bottom: 0; display: flex; align-items: center; padding: 8px 12px; background: #ffffff; border-top: 1px solid #eeeeee; }
.input { flex: 1; height: 36px; margin-right: 8px; padding: 0 10px; background: #f5f5f5; border-radius: 6px; font-size: 14px; }
</style>