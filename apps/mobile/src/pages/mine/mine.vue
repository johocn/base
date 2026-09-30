<template>
  <view class="wrap">
    <text class="title">我的</text>
    <view class="card">
      <view class="row"><text class="k">已读</text><text class="v">{{ stats.readCount }} 篇</text></view>
      <view class="row"><text class="k">答题正确率</text><text class="v">{{ rateText }}</text></view>
      <view class="row"><text class="k">最近学习</text><text class="v">{{ lastText }}</text></view>
    </view>
    <text class="group">创作</text>
    <navigator url="/pages/submit/submit" class="link">新建投稿</navigator>
    <navigator url="/pages/myitems/myitems" class="link">我的条目<text class="tail">{{ pendingText }}</text></navigator>

    <text class="group">治理</text>
    <navigator url="/pages/governance/governance" class="link">提案与投票<text class="tail">{{ rosterText }}</text></navigator>
    <navigator url="/pages/contribution/contribution" class="link">我的贡献</navigator>

    <text class="group">私信</text>
    <navigator url="/pages/dm/list" class="link">好友与私信</navigator>

    <text class="group">标签</text>
    <navigator url="/pages/tag/list" class="link">全部标签</navigator>

    <navigator url="/pages/favorite/favorite" class="link">我的收藏</navigator>
    <navigator url="/pages/setting/setting" class="link">设置</navigator>
  </view>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import { onShow } from '@dcloudio/uni-app';

import type { LearningStats } from '../../core/types';
import { myIdentityId, roster } from '../../core/contribution';
import { bootstrap } from '../../platform';

const stats = ref<LearningStats>({ readCount: 0, quizAttempts: 0, correctRate: null, lastAt: '' });

const pendingCount = ref(0);
/** 名册状态只作提示文案，不是资格判定（本册 §2.3） */
const rosterState = ref<'in' | 'out' | 'unknown'>('unknown');

const pendingText = computed(() => (pendingCount.value > 0 ? `（${pendingCount.value} 条待发）` : ''));
const rosterText = computed(() =>
  rosterState.value === 'unknown' ? '' : rosterState.value === 'in' ? '（名册内）' : '（未入名册）',
);

// 无作答时显示 `-`，不显示 0%（0% 会被误读为「全错」）
const rateText = computed(() =>
  stats.value.correctRate === null ? '-' : `${Math.round(stats.value.correctRate * 100)}%`,
);
const lastText = computed(() => stats.value.lastAt.slice(0, 10) || '-');

// onShow 而不是 onLoad：从阅读器或答题页返回后必须立刻反映
onShow(async () => {
  try {
    const { opts, repo } = await bootstrap();
    stats.value = await repo.learningStats();
    pendingCount.value = (await repo.listSubmissions('pending')).length;
    const o = { adapters: opts.adapters, repo, nodeBaseUrl: opts.nodeBaseUrl };
    const myId = await myIdentityId(o);
    const list = await roster(o);
    rosterState.value = myId !== '' && list.some((c) => c.id === myId) ? 'in' : 'out';
  } catch {
    // 「我的」不因读库 / 拉名册失败而报错，保持上一次的值（含 rosterState 保持 unknown）
  }
});
</script>

<style>
.wrap { padding: 16px; }
.title { display: block; font-size: 20px; font-weight: 600; margin-bottom: 16px; }
.card { border: 1px solid #eeeeee; border-radius: 8px; padding: 4px 12px; margin-bottom: 20px; }
.row { display: flex; justify-content: space-between; padding: 10px 0; }
.k { color: #666666; font-size: 14px; }
.v { font-size: 14px; }
.link { display: block; padding: 14px 0; border-bottom: 1px solid #eeeeee; color: #2b6cb0; }
.group { display: block; font-size: 13px; color: #999999; margin: 8px 0 4px; }
.tail { color: #2b6cb0; font-size: 13px; }
</style>