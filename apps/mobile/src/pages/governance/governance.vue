<template>
  <view class="wrap">
    <text class="title">提案与投票</text>
    <text class="note">下架 3 票、改写与复活各 2 票；票数按名册实时复判。名册人数不足门槛时提案挂起。</text>
    <text v-if="error" class="error">{{ error }}</text>
    <text v-if="notice" class="notice">{{ notice }}</text>

    <view class="card">
      <text class="sec-title">{{ formOpen ? '发起提案' : '发起提案' }}</text>
      <text v-if="!formOpen" class="act" @click="formOpen = true">＋ 发起</text>
      <block v-else>
        <input v-model="form.itemId" class="input" placeholder="目标条目 id（如 article/abc）" />
        <view class="actions">
          <text v-for="a in ACTIONS" :key="a.key" class="act" :class="form.action === a.key ? 'act-on' : ''" @click="form.action = a.key">{{ a.label }}</text>
        </view>
        <input v-model="form.reason" class="input" placeholder="理由（1–200 字）" />
        <block v-if="form.action === 'edit'">
          <input v-model="form.editTitle" class="input" placeholder="拟改标题（仅改写需要）" />
          <textarea v-model="form.editBody" class="area" placeholder="拟改正文（仅改写需要）" />
        </block>
        <text class="act" @click="submitProposal">提交提案</text>
      </block>
    </view>

    <text v-if="loading" class="empty">加载中…</text>
    <text v-else-if="items.length === 0" class="empty">本节点暂无提案</text>
    <view v-for="p in items" :key="p.proposalId" class="card">
      <view class="row">
        <text class="badge">{{ ACTION_LABEL[p.action] }}</text>
        <text class="t">{{ p.itemId }}</text>
      </view>
      <text class="meta">#{{ p.proposalId }} · {{ STATUS_LABEL[p.status] }} · {{ createdText(p.createdAt) }}</text>
      <text v-if="p.contentVersion > 0 || p.revokedRev > 0" class="meta">水位 v{{ p.contentVersion }} / rev{{ p.revokedRev }}</text>
      <text class="meta">{{ p.reason }}</text>
      <text class="meta">{{ p.voteCount }} / {{ p.threshold }} 票</text>
      <text v-if="p.status === 'pending' && p.threshold > p.voteCount" class="meta">挂起中：达到 {{ p.threshold }} 票才生效</text>
      <view v-if="p.action === 'edit'" class="diff">
        <text class="meta">拟改标题：{{ p.title }}</text>
        <text class="meta">拟改正文：{{ p.bodyMd }}</text>
      </view>
      <text
        v-if="p.status === 'pending' && !hasVoted(p)"
        class="act"
        @click="castVote(p)"
      >投票</text>
      <text v-else-if="p.status === 'pending'" class="meta">你已投票</text>
    </view>
  </view>
</template>

<script setup lang="ts">
import { reactive, ref } from 'vue';
import { onLoad, onShow } from '@dcloudio/uni-app';

import { createProposal, listProposals, myIdentityId, vote, type GovernAction, type ProposalItem } from '../../core/govern';
import { bootstrap } from '../../platform';

const ACTION_LABEL: Record<GovernAction, string> = { remove: '下架', edit: '改写', revive: '复活' };
const STATUS_LABEL: Record<ProposalItem['status'], string> = { pending: '待决', effective: '已生效', void: '已作废' };
const ACTIONS: Array<{ key: GovernAction; label: string }> = [
  { key: 'remove', label: '下架' },
  { key: 'edit', label: '改写' },
  { key: 'revive', label: '复活' },
];

const items = ref<ProposalItem[]>([]);
const myId = ref('');
const loading = ref(false);
const error = ref('');
const notice = ref('');
const formOpen = ref(false);
const form = reactive({ action: 'remove' as GovernAction, itemId: '', reason: '', editTitle: '', editBody: '' });

onLoad((query) => {
  const q = query as Record<string, string> | undefined;
  const itemId = String(q?.itemId ?? '');
  const action = String(q?.action ?? '');
  if (itemId !== '') {
    formOpen.value = true;
    form.itemId = itemId;
  }
  if (action === 'remove' || action === 'edit' || action === 'revive') form.action = action;
});

// 每次 onShow 实时拉取：票数、门槛、状态全部来自这一次拉取，本地不缓存、不推算（本册 §5.6）
onShow(async () => {
  await refresh();
});

async function opts() {
  const { opts: o, repo } = await bootstrap();
  return { adapters: o.adapters, repo, nodeBaseUrl: o.nodeBaseUrl };
}

async function refresh() {
  loading.value = true;
  error.value = '';
  try {
    const o = await opts();
    myId.value = await myIdentityId(o);
    items.value = await listProposals(o);
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    loading.value = false;
  }
}

function hasVoted(p: ProposalItem): boolean {
  return myId.value !== '' && p.votes.includes(myId.value);
}

function createdText(ms: number): string {
  return ms > 0 ? new Date(ms).toLocaleString() : '';
}

async function submitProposal() {
  error.value = '';
  notice.value = '';
  try {
    const o = await opts();
    await createProposal(o, {
      action: form.action,
      itemId: form.itemId.trim(),
      reason: form.reason.trim(),
      edit: form.action === 'edit' ? { title: form.editTitle.trim(), bodyMd: form.editBody } : undefined,
    });
    formOpen.value = false;
    form.reason = '';
    form.editTitle = '';
    form.editBody = '';
    notice.value = '提案已发起（签名即第 1 票）';
    items.value = await listProposals(o);
  } catch (e) {
    error.value = (e as Error).message;
  }
}

async function castVote(p: ProposalItem) {
  error.value = '';
  try {
    const o = await opts();
    const res = await vote(o, p.proposalId);
    notice.value = `${res.voteCount} / ${res.threshold} 票（${STATUS_LABEL[res.status]}）`;
    // 紧接着重拉一次对齐：可能同时存在他人投票（本册 §5.6）
    items.value = await listProposals(o);
  } catch (e) {
    error.value = (e as Error).message;
  }
}
</script>

<style>
.wrap { padding: 16px; }
.title { display: block; font-size: 20px; font-weight: 600; margin-bottom: 6px; }
.note { display: block; font-size: 12px; color: #999999; margin-bottom: 12px; }
.card { border: 1px solid #eeeeee; border-radius: 8px; padding: 10px; margin-bottom: 10px; }
.row { display: flex; align-items: center; }
.sec-title { display: block; font-size: 15px; font-weight: 600; margin-bottom: 6px; }
.badge { font-size: 12px; color: #2b6cb0; border: 1px solid #2b6cb0; border-radius: 10px; padding: 0 8px; margin-right: 8px; }
.t { font-size: 15px; }
.meta { display: block; color: #888888; font-size: 12px; margin-top: 2px; }
.diff { margin-top: 6px; padding-top: 6px; border-top: 1px dashed #eeeeee; }
.input { border: 1px solid #eeeeee; border-radius: 6px; padding: 8px; font-size: 14px; margin-top: 8px; }
.area { border: 1px solid #eeeeee; border-radius: 6px; padding: 8px; width: 100%; height: 140px; font-size: 14px; margin-top: 8px; }
.actions { display: flex; margin-top: 8px; }
.act { display: block; color: #2b6cb0; font-size: 14px; margin-top: 10px; }
.act-on { color: #b7791f; }
.empty { display: block; color: #999999; font-size: 13px; padding: 8px 0; }
.error { display: block; color: #c53030; font-size: 13px; margin: 6px 0; }
.notice { display: block; color: #b7791f; font-size: 13px; margin: 6px 0; }
</style>