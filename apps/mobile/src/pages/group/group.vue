<template>
  <view class="wrap">
    <view class="bar">
      <text class="title">{{ groupName || '圈子会话' }}</text>
      <view class="bar-acts">
        <text class="act" @click="paste">粘贴续期码</text>
        <text class="act" @click="pasteReceipt">粘贴回执</text>
        <text class="act" @click="signRequest">代签请求码</text>
      </view>
    </view>

    <!-- feed.notice 原文：被移出 / 密钥已轮换，读不出新消息时必须原位告知，禁止静默跳过 -->
    <text v-if="notice" class="notice">{{ notice }}</text>
    <text v-if="error" class="error">{{ error }}</text>
    <text v-if="error" class="act" @click="retry">重试</text>

    <view v-if="group" class="sec">
      <text class="sec-title">圈子</text>
      <text class="li">形态：{{ group.encrypted === 1 ? '封闭圈子（内容加密）' : '开放圈子（内容公开）' }}</text>
      <text class="li">治理席位：{{ group.seatCount }} 席</text>
      <text class="li">当前治理者：{{ govText }}</text>
    </view>

    <view v-if="isGovernor" class="sec panel">
      <text class="sec-title">治理操作</text>
      <view class="acts">
        <text class="act" @click="onRename">改名</text>
        <text class="act" @click="onRemove">移出成员</text>
        <text class="act" @click="onRotate">轮换密钥</text>
        <text class="act" @click="onDissolve">发起解散</text>
      </view>
    </view>

    <view v-if="group" class="sec panel">
      <text class="act" @click="onLeave">退出圈子</text>
    </view>

    <view v-if="members.length > 0" class="sec">
      <text class="sec-title">成员 {{ members.length }}</text>
      <view v-for="m in members" :key="m" class="member">
        <text class="member-id">{{ short(m) }}{{ m === myId ? '（我）' : '' }}{{ isGovernorId(m) ? ' · 治者' : '' }}</text>
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

      <view v-for="(m, i) in feed" :key="m.eventId" class="cmt-floor">
        <view class="cmt-head">
          <text class="cmt-floor-no">{{ i + 1 }}楼</text>
          <view class="cmt-avatar" :style="{ background: avatarBg(m.actor) }"></view>
          <text class="cmt-author-name">{{ m.actor === myId ? '我' : authorName(m.actor) }}</text>
          <text class="cmt-meta">· {{ rel(m.createdAt) }}</text>
        </view>
        <text v-if="m.replyTo" class="cmt-reply">回复 {{ short(m.replyTo) }}</text>
        <text class="cmt-text">{{ m.text ?? '（无法解密）' }}</text>
      </view>
      <text v-if="loading" class="hint">加载中…</text>
      <text v-else-if="!error && feed.length > 0 && nextCursor === null" class="hint">没有更多了</text>
      <text v-if="moreHint" class="hint">{{ moreHint }}</text>
    </block>

    <text v-if="blocked" class="blocked">{{ blocked }}</text>
    <view class="composer">
      <!-- 输入框只按「结构性不可写」禁用：若用 canSend（含「草稿非空」），空草稿会锁死输入框，永远打不出字 -->
      <input v-model="draft" class="input" :disabled="!canInput" placeholder="说点什么…" />
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
  dissolveGroup,
  fetchGroupMessages,
  leaveGroup,
  postGroupMessage,
  removeMember,
  renameGroup,
  rotateGroup,
  signSigRequest,
  submitRoster,
  GroupError,
  type GroupEnvelope,
  type GroupFeed,
  type GroupInfo,
  type GroupMessage,
  type GroupOptions,
} from '../../core/group';
import { flushPending } from '../../core/comment';
import { peekLocalIdentity } from '../../core/identity';
import type { CommentOutRow } from '../../core/types';
import { avatarBg, useActorNames } from '../../core/useActorNames';
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
const group = ref<GroupInfo | null>(null);
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

/** 多签编排的待提交态：请求码 + 已收集回执 + 轮换产出的信封（信封不进签名域，但必须随提交带上）。 */
const pendingRequest = ref('');
const pendingReceipts = ref<string[]>([]);
const pendingEnvelopes = ref<GroupEnvelope[]>([]);

/** 待发区：只显示本组的行（评论页不过滤是因为评论只有一个 tab，小组页必须按组隔离）。 */
const pending = ref<CommentOutRow[]>([]);

/** 昵称三级降级（名册 → profile 补查 → id[:8] 回退），与私信会话页同一降级链 */
const { authorName, loadNames } = useActorNames();

/** 写门控：与评论同一条「能否写事件」的能力，不新增自检探测（补充 9）。 */
const caps = ref<CapabilityFlags>(UNKNOWN_FLAGS);
const blocked = computed(() => postBlockedReason(caps.value));
/** 输入框可写性：只按「结构性不可写」判断（草稿为空不禁用）。ref 在模板里自动解包，故模板只能写 `canInput`。 */
const canInput = computed(() => canPostComment(caps.value));
const canSend = computed(
  () => canPostComment(caps.value) && draft.value.trim() !== '' && !sending.value,
);
/** 治理者判定：节点下发的 `governors` 含我即视为治理者（客户端算不出贡献度排名，只读节点裁决）。 */
const isGovernor = computed(
  () => myId.value !== '' && (group.value?.governors ?? []).includes(myId.value),
);
const govText = computed(() => {
  const gs = group.value?.governors ?? [];
  return gs.length === 0 ? '（无）' : gs.map(short).join('、');
});

function isGovernorId(id: string): boolean {
  return (group.value?.governors ?? []).includes(id);
}

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
  group.value = f.group;
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
    // 楼层化：消息已按时间升序，楼号即列表序；昵称走同一降级链，失败静默
    await loadNames(feed.value.map((m) => m.actor), opts.value);
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

/** 从列表里单选一项；取消返回 null。 */
function pick(itemList: string[]): Promise<number | null> {
  return new Promise((resolve) => {
    uni.showActionSheet({
      itemList,
      success: (res) => resolve(res.tapIndex),
      fail: () => resolve(null),
    });
  });
}

/**
 * 多签编排：出草稿 → 自签 → 复制请求码 → 提交（信封必须一并交给 `submitRoster`）。
 * 门槛不足时 `submitRoster` 抛 `roster_quorum_missing`，此时请求码已复制、pending 已留存，
 * 用户可继续走「粘贴回执」——这就是期望行为（原地提示，不静默、不入队）。
 */
async function multsigSubmit(build: () => Promise<{ request: string; envelopes: GroupEnvelope[] }>) {
  if (!opts.value) return;
  error.value = '';
  notice.value = '';
  try {
    const { request, envelopes } = await build();
    const mine = await signSigRequest(opts.value, request);
    const receipts = [mine];
    pendingRequest.value = request;
    pendingReceipts.value = receipts;
    pendingEnvelopes.value = envelopes; // 必须留存，供「粘贴回执」二次提交
    uni.setClipboardData({ data: request });
    notice.value = '签名请求已复制，请发给其他治理者；收到回执后用「粘贴回执」提交';
    const r = await submitRoster(opts.value, request, receipts, envelopes);
    notice.value = r.queued ? '已提交，联网后自动发送' : '已提交';
    await load();
    await loadPending();
    await refresh();
  } catch (e) {
    error.value = e instanceof GroupError ? e.message : (e as Error).message;
  }
}

/** 改名（治者）：`sub='rename'`。 */
async function onRename() {
  if (!opts.value) return;
  const name = await ask('改名', '新的圈子名字');
  if (name === null || name.trim() === '') return;
  const n = name.trim();
  await multsigSubmit(async () => {
    const r = await renameGroup(opts.value!, groupId.value, n);
    return { request: r.requestCode, envelopes: r.envelopes };
  });
}

/** 轮换密钥（治者）：名单取当前快照，不作变更。 */
async function onRotate() {
  if (!opts.value || !group.value) return;
  const memberIds = [...group.value.memberIds];
  await multsigSubmit(async () => {
    const r = await rotateGroup(opts.value!, groupId.value, { memberIds });
    return { request: r.requestCode, envelopes: r.envelopes };
  });
}

/** 移出成员（治者）：列表排除自己，选中后走多签。 */
async function onRemove() {
  if (!opts.value || !group.value) return;
  const targets = group.value.memberIds.filter((id) => id !== myId.value);
  if (targets.length === 0) {
    error.value = '';
    notice.value = '没有可移出的成员';
    return;
  }
  const idx = await pick(targets.map(short));
  if (idx === null) return;
  const target = targets[idx]!;
  await multsigSubmit(async () => {
    const r = await removeMember(opts.value!, groupId.value, target);
    return { request: r.requestCode, envelopes: r.envelopes };
  });
}

/** 发起解散（治者）：名单清空。 */
async function onDissolve() {
  await multsigSubmit(async () => {
    const r = await dissolveGroup(opts.value!, groupId.value);
    return { request: r.requestCode, envelopes: r.envelopes };
  });
}

/**
 * 退出圈子：节点 `rosterQuorumError` 要求签名者集合**是治者名单的子集**，故非治者自签必被 403。
 * 非治者只出草稿码（含换钥信封）并复制，交给治者去凑签名；治者才自签提交。
 */
async function onLeave() {
  if (!opts.value || !group.value) return;
  error.value = '';
  notice.value = '';
  try {
    if (!isGovernor.value) {
      const r = await leaveGroup(opts.value, groupId.value);
      pendingRequest.value = r.requestCode;
      pendingReceipts.value = [];
      pendingEnvelopes.value = r.envelopes;
      uni.setClipboardData({ data: r.requestCode });
      notice.value = '退出圈子需要一名治理者确认：请求码已复制，请发给治理者，收到回执后用「粘贴回执」提交';
      return; // 不走 multsigSubmit ⇒ 不会自签、不会提交
    }
    await multsigSubmit(async () => {
      const r = await leaveGroup(opts.value!, groupId.value);
      return { request: r.requestCode, envelopes: r.envelopes };
    });
  } catch (e) {
    error.value = e instanceof GroupError ? e.message : (e as Error).message;
  }
}

/** 粘贴签名回执：把新回执并入待提交集合，连同留存信封一起提交（门槛不足的提示显示在原位 error）。 */
async function pasteReceipt() {
  if (!opts.value) return;
  error.value = '';
  notice.value = '';
  const code = await ask('粘贴签名回执', '粘贴 base3: 开头的回执码');
  if (code === null || code === '') return;
  if (pendingRequest.value === '') {
    notice.value = '还没有待提交的签名请求';
    return;
  }
  const merged = [...pendingReceipts.value, code.trim()];
  try {
    const r = await submitRoster(opts.value, pendingRequest.value, merged, pendingEnvelopes.value);
    pendingReceipts.value = merged;
    notice.value = r.queued ? '已提交，联网后自动发送' : '已提交';
    await load();
    await loadPending();
    await refresh();
  } catch (e) {
    error.value = e instanceof GroupError ? e.message : (e as Error).message;
  }
}

/**
 * 代签：同伴拿到发起者的 `base2:` 签名请求码后，在**本机**对这份草稿签名，回出 `base3:` 回执码。
 * 这是多签收集通道的另一半（补充 15）：没有它，M4 / M5 在真机上凑不够签名。
 */
async function signRequest() {
  if (!opts.value) return;
  error.value = '';
  notice.value = '';
  const code = await ask('代签请求码', '粘贴 base2: 开头的签名请求码');
  if (code === null || code.trim() === '') return;
  try {
    const receipt = await signSigRequest(opts.value, code.trim());
    uni.setClipboardData({ data: receipt });
    notice.value = '回执已复制，请发回给发起者（由发起者「粘贴回执」提交）';
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
.bar-acts { display: flex; }
.bar-acts .act { margin-left: 14px; }
.sec { margin-bottom: 12px; }
.sec-title { display: block; font-size: 14px; font-weight: 600; margin-bottom: 6px; }
.li { display: block; color: #555555; font-size: 13px; margin: 3px 0; }
.acts { display: flex; flex-wrap: wrap; }
.acts .act { margin-right: 18px; }
.panel { padding: 8px 10px; background: #f7fafc; border: 1px solid #e2e8f0; border-radius: 6px; }
.member { display: flex; align-items: center; justify-content: space-between; padding: 6px 0; border-bottom: 1px solid #f0f0f0; }
.member-id { color: #555555; font-size: 13px; }
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
.cmt-reply { display: block; color: #888888; font-size: 12px; }
.cmt-text { display: block; margin-top: 4px; font-size: 15px; line-height: 1.6; }
.hint { display: block; margin-top: 8px; color: #888888; font-size: 13px; }
.error { display: block; color: #c53030; font-size: 13px; }
.notice { display: block; margin-bottom: 8px; color: #b7791f; font-size: 13px; }
.blocked { display: block; margin-bottom: 8px; color: #c05621; font-size: 13px; }
.composer { position: fixed; left: 0; right: 0; bottom: 0; display: flex; align-items: center; padding: 8px 12px; background: #ffffff; border-top: 1px solid #eeeeee; }
.input { flex: 1; height: 36px; margin-right: 8px; padding: 0 10px; background: #f5f5f5; border-radius: 6px; font-size: 14px; }
</style>