<template>
  <view class="wrap">
    <view class="bar">
      <text class="title">{{ groupName || '小组会话' }}</text>
      <text class="act" @click="paste">粘贴续期码</text>
    </view>

    <!-- feed.notice 原文：被移出 / 密钥已轮换，读不出新消息时必须原位告知，禁止静默跳过 -->
    <text v-if="notice" class="notice">{{ notice }}</text>
    <text v-if="error" class="error">{{ error }}</text>
    <text v-if="error" class="act" @click="retry">重试</text>

    <view v-if="members.length > 0" class="sec">
      <text class="sec-title">成员 {{ members.length }}</text>
      <view v-for="m in members" :key="m" class="member">
        <text class="member-id">{{ short(m) }}{{ m === myId ? '（我）' : '' }}</text>
        <text v-if="isCreator && m !== groupCreatorId" class="act" @click="remove(m)">移出</text>
      </view>
    </view>

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

      <view v-for="m in feed" :key="m.eventId" class="msg">
        <text class="msg-meta">{{ short(m.actor) }} · {{ rel(m.createdAt) }}</text>
        <text v-if="m.replyTo" class="msg-reply">回复 {{ short(m.replyTo) }}</text>
        <text class="msg-text">{{ m.text ?? '（无法解密）' }}</text>
      </view>
      <text v-if="loading" class="hint">加载中…</text>
      <text v-else-if="!error && feed.length > 0 && nextCursor === null" class="hint">没有更多了</text>
      <text v-if="moreHint" class="hint">{{ moreHint }}</text>
    </block>

    <text v-if="blocked" class="blocked">{{ blocked }}</text>
    <view class="composer">
      <!-- 输入框只按「结构性不可写」禁用：若用 canSend（含「草稿非空」），空草稿会锁死输入框，永远打不出字 -->
      <input v-model="draft" class="input" :disabled="!canPostComment(caps.value)" placeholder="说点什么…" />
      <button size="mini" :disabled="!canSend" @click="send">{{ sending ? '发表中…' : '发表' }}</button>
    </view>
    <text v-if="tip" class="hint">{{ tip }}</text>
  </view>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import { onLoad, onReachBottom, onShow } from '@dcloudio/uni-app';

import {
  acceptInvite,
  fetchGroupMessages,
  postGroupMessage,
  rotateGroup,
  GroupError,
  type GroupFeed,
  type GroupMessage,
  type GroupOptions,
} from '../../core/group';
import { flushPending } from '../../core/comment';
import { peekLocalIdentity } from '../../core/identity';
import type { CommentOutRow } from '../../core/types';
import { bootstrap } from '../../platform';
import {
  UNKNOWN_FLAGS,
  canPostComment,
  postBlockedReason,
  type CapabilityFlags,
} from '../../core/selfcheck';

const opts = ref<GroupOptions | null>(null);
const groupId = ref('');
const groupName = ref('');
const groupCreatorId = ref('');
const myId = ref('');
const members = ref<string[]>([]);
const feed = ref<GroupMessage[]>([]);
const nextCursor = ref<string | null>(null);
const notice = ref('');
const error = ref('');
const moreHint = ref('');
const tip = ref('');
const loading = ref(false);
const sending = ref(false);
const draft = ref('');
const unconfigured = ref(false);

/** 待发区：只显示本组的行（评论页不过滤是因为评论只有一个 tab，小组页必须按组隔离）。 */
const pending = ref<CommentOutRow[]>([]);

/** 写门控：与评论同一条「能否写事件」的能力，不新增自检探测（补充 9）。 */
const caps = ref<CapabilityFlags>(UNKNOWN_FLAGS);
const blocked = computed(() => postBlockedReason(caps.value));
const canSend = computed(
  () => canPostComment(caps.value) && draft.value.trim() !== '' && !sending.value,
);
const isCreator = computed(
  () => myId.value !== '' && groupCreatorId.value !== '' && myId.value === groupCreatorId.value,
);

async function load() {
  try {
    const ctx = await bootstrap();
    opts.value = { adapters: ctx.opts.adapters, repo: ctx.repo, nodeBaseUrl: ctx.opts.nodeBaseUrl };
    caps.value = ctx.capabilities;
    unconfigured.value = ctx.opts.nodeBaseUrl === '';
    // 本机身份（零网络）：用于创建者判定与「（我）」标注
    const ident = await peekLocalIdentity(opts.value.adapters.storage);
    myId.value = ident?.id ?? '';
  } catch (e) {
    error.value = (e as Error).message;
  }
}

/** 待发区只取本组的行；密文（p.text）不渲染——对用户无意义。 */
async function loadPending() {
  if (!opts.value) return;
  const all = await opts.value.repo.listCommentOut();
  pending.value = all.filter((r) => r.targetId === `group/${groupId.value}`);
}

/** 补发一轮并刷新：不 await 进页面（由 onShow 决定），与评论页同一体例。 */
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

function applyFeed(f: GroupFeed) {
  groupName.value = f.group.name;
  groupCreatorId.value = f.group.creatorId;
  members.value = f.group.memberIds;
  feed.value = f.events;
  nextCursor.value = f.nextCursor;
  notice.value = f.notice; // 非空即 GROUP_KEY_STALE_NOTICE 原文，原位显示
  moreHint.value = f.nextCursor === null ? '' : '更早的消息本版暂不支持翻页';
}

async function refresh() {
  if (unconfigured.value || !opts.value || groupId.value === '') return;
  loading.value = true;
  error.value = '';
  try {
    applyFeed(await fetchGroupMessages(opts.value, groupId.value));
  } catch (e) {
    error.value = e instanceof GroupError ? e.message : (e as Error).message;
    feed.value = [];
    nextCursor.value = null;
    moreHint.value = '';
  } finally {
    loading.value = false;
  }
}

/**
 * 续页：core/group.ts 只导出「取首页并解密」的 fetchGroupMessages(o, groupId)，**不接受游标**；
 * 带解密的续页需要其内部未导出的 openText（core 不可改）。故不伪造续页：
 * 游标非空时原位说明还有更早的消息，而不是静默当成「没有更多了」。
 */
async function loadMore() {
  if (unconfigured.value || nextCursor.value === null) return;
  moreHint.value = '更早的消息本版暂不支持翻页';
}

async function retry() {
  await refresh();
}

/** 可编辑弹窗；取消返回 null。 */
function ask(title: string, placeholderText: string): Promise<string | null> {
  return new Promise((resolve) => {
    uni.showModal({
      title,
      editable: true,
      placeholderText,
      success: (res) => resolve(res.confirm ? String(res.content ?? '') : null),
      fail: () => resolve(null),
    });
  });
}

/** 发言：断网入队（密文进队列）；节点给了响应则拒绝/成功，不入队。 */
async function send() {
  if (!canSend.value || !opts.value) return;
  const text = draft.value.trim();
  sending.value = true;
  tip.value = '';
  try {
    const r = await postGroupMessage(opts.value, { groupId: groupId.value, text });
    draft.value = '';
    if (r.queued) {
      tip.value = '已保存，联网后自动补发';
      await loadPending();
    } else {
      tip.value = '已发表';
      await refresh();
    }
  } catch (e) {
    tip.value = e instanceof GroupError ? e.message : `提交失败：${(e as Error).message ?? String(e)}`;
  } finally {
    sending.value = false;
  }
}

/** 移出成员（仅创建者）：轮换新密钥 → 出新续期码 → 复制，让剩余成员粘入后读到新消息。 */
async function remove(target: string) {
  if (!opts.value) return;
  error.value = '';
  tip.value = '';
  try {
    const remaining = members.value.filter((id) => id !== target);
    const r = await rotateGroup(opts.value, groupId.value, remaining);
    members.value = remaining;
    uni.setClipboardData({ data: r.inviteCode });
    tip.value = '已生成续期码，请发给剩余成员（他们粘入后才能读新消息）';
  } catch (e) {
    error.value = e instanceof GroupError ? e.message : (e as Error).message;
  }
}

/** 粘贴续期码（所有人可见）：本地解码入组，只接受更大的 epoch。 */
async function paste() {
  if (!opts.value) return;
  error.value = '';
  tip.value = '';
  const code = await ask('粘贴续期码', '粘贴邀请码或续期码');
  if (code === null || code === '') return;
  try {
    const r = await acceptInvite(opts.value, code);
    tip.value = r.renewed ? '已更新小组密钥' : '已加入小组';
    await load();
    await refresh();
  } catch (e) {
    error.value = e instanceof GroupError ? e.message : (e as Error).message;
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
  groupId.value = String(q?.groupId ?? '');
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
.sec { margin-bottom: 12px; }
.sec-title { display: block; font-size: 14px; font-weight: 600; margin-bottom: 6px; }
.member { display: flex; align-items: center; justify-content: space-between; padding: 6px 0; border-bottom: 1px solid #f0f0f0; }
.member-id { color: #555555; font-size: 13px; }
.pending { margin-bottom: 12px; padding: 10px; background: #fffaf0; border: 1px solid #f6e05e; border-radius: 6px; }
.pending-bar { display: flex; align-items: center; justify-content: space-between; }
.pending-title { font-size: 14px; font-weight: 600; }
.po { padding: 8px 0; border-top: 1px solid #f6e05e; }
.po-foot { display: flex; align-items: center; justify-content: space-between; }
.po-state { color: #888888; font-size: 12px; }
.po-reason { color: #c05621; font-size: 12px; }
.msg { padding: 10px 0; border-bottom: 1px solid #eeeeee; }
.msg-meta { display: block; color: #888888; font-size: 12px; }
.msg-reply { display: block; color: #888888; font-size: 12px; }
.msg-text { display: block; margin-top: 4px; font-size: 15px; line-height: 1.6; }
.hint { display: block; margin-top: 8px; color: #888888; font-size: 13px; }
.error { display: block; color: #c53030; font-size: 13px; }
.notice { display: block; margin-bottom: 8px; color: #b7791f; font-size: 13px; }
.blocked { display: block; margin-bottom: 8px; color: #c05621; font-size: 13px; }
.composer { position: fixed; left: 0; right: 0; bottom: 0; display: flex; align-items: center; padding: 8px 12px; background: #ffffff; border-top: 1px solid #eeeeee; }
.input { flex: 1; height: 36px; margin-right: 8px; padding: 0 10px; background: #f5f5f5; border-radius: 6px; font-size: 14px; }
</style>