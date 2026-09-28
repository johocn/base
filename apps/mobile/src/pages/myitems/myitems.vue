<template>
  <view class="wrap">
    <text class="title">我的条目</text>
    <text v-if="error" class="error">{{ error }}</text>
    <text v-if="notice" class="notice">{{ notice }}</text>

    <view class="sec">
      <text class="sec-title">待发（{{ pending.length }}）</text>
      <text v-if="pending.length === 0" class="empty">没有待发条目</text>
      <view v-for="row in pending" :key="row.itemId" class="card">
        <text class="t">{{ row.title }}</text>
        <text class="meta">{{ row.itemId }}</text>
        <text v-if="row.reason" class="meta">{{ row.reason }}</text>
        <view class="acts">
          <text class="act" @click="edit(row)">修改</text>
          <text class="act" @click="remove(row)">删除</text>
        </view>
      </view>
    </view>

    <view class="sec">
      <text class="sec-title">已提交（{{ sent.length }}）</text>
      <text class="note">重投不会恢复已被治理下架的条目；如需恢复请到「提案与投票」发起复活提案。</text>
      <text v-if="sent.length === 0" class="empty">还没有提交过条目</text>
      <view v-for="row in sent" :key="row.itemId" class="card">
        <text class="t">{{ row.title }}</text>
        <text class="meta">{{ row.itemId }} · {{ row.created === 1 ? '首投' : '更新' }} · {{ row.sentAt.slice(0, 10) }}</text>
        <view class="acts">
          <text class="act" @click="open(row)">查看</text>
          <text class="act" @click="edit(row)">重投更新</text>
        </view>
      </view>
    </view>

    <view class="sec">
      <text class="sec-title">失败（{{ failed.length }}）</text>
      <text class="note">失败项的 item_id 就是身份，改字段救不回；只能删除后以新 id 重投。</text>
      <text v-if="failed.length === 0" class="empty">没有失败条目</text>
      <view v-for="row in failed" :key="row.itemId" class="card">
        <text class="t">{{ row.title }}</text>
        <text class="meta">{{ row.itemId }}</text>
        <text class="reason">{{ row.reason }}</text>
        <view class="acts">
          <text class="act" @click="remove(row)">删除</text>
        </view>
      </view>
    </view>
  </view>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import { onShow } from '@dcloudio/uni-app';

import { flushSubmissions } from '../../core/submit';
import type { MySubmissionRow } from '../../core/types';
import { bootstrap } from '../../platform';

const pending = ref<MySubmissionRow[]>([]);
const sent = ref<MySubmissionRow[]>([]);
const failed = ref<MySubmissionRow[]>([]);
const error = ref('');
const notice = ref('');

// onShow 而不是 onLoad：从编辑器返回后必须立刻反映；同一轮补发由模块级单飞标志兜住
onShow(async () => {
  error.value = '';
  notice.value = '';
  try {
    const { opts, repo } = await bootstrap();
    const res = await flushSubmissions({ adapters: opts.adapters, repo, nodeBaseUrl: opts.nodeBaseUrl });
    if (res.sent > 0) notice.value = `已补发 ${res.sent} 条`;
    else if (res.error) notice.value = res.error;
    pending.value = await repo.listSubmissions('pending');
    sent.value = (await repo.listSubmissions('sent')).reverse();
    failed.value = await repo.listSubmissions('failed');
  } catch (e) {
    error.value = (e as Error).message;
  }
});

function edit(row: MySubmissionRow) {
  uni.navigateTo({ url: `/pages/submit/submit?itemId=${encodeURIComponent(row.itemId)}` });
}

function open(row: MySubmissionRow) {
  const page = row.type === 'quiz' ? 'quiz/quiz' : 'article/article';
  uni.navigateTo({ url: `/pages/${page}?itemId=${encodeURIComponent(row.itemId)}` });
}

async function remove(row: MySubmissionRow) {
  const { repo } = await bootstrap();
  await repo.removeSubmission(row.itemId);
  pending.value = await repo.listSubmissions('pending');
  failed.value = await repo.listSubmissions('failed');
}
</script>

<style>
.wrap { padding: 16px; }
.title { display: block; font-size: 20px; font-weight: 600; margin-bottom: 12px; }
.sec { margin-bottom: 22px; }
.sec-title { display: block; font-size: 15px; font-weight: 600; margin-bottom: 8px; }
.note { display: block; font-size: 12px; color: #999999; margin-bottom: 8px; }
.empty { display: block; color: #999999; font-size: 13px; padding: 6px 0; }
.card { border: 1px solid #eeeeee; border-radius: 8px; padding: 10px; margin-bottom: 10px; }
.t { display: block; font-size: 15px; }
.meta { display: block; color: #888888; font-size: 12px; }
.reason { display: block; color: #c53030; font-size: 13px; margin-top: 4px; }
.acts { display: flex; margin-top: 8px; }
.act { margin-right: 18px; color: #2b6cb0; font-size: 14px; }
.error { display: block; color: #c53030; font-size: 13px; margin-bottom: 8px; }
.notice { display: block; color: #b7791f; font-size: 13px; margin-bottom: 8px; }
</style>