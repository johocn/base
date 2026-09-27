<template>
  <view class="wrap">
    <text class="title">我的</text>
    <view class="card">
      <view class="row"><text class="k">已读</text><text class="v">{{ stats.readCount }} 篇</text></view>
      <view class="row"><text class="k">答题正确率</text><text class="v">{{ rateText }}</text></view>
      <view class="row"><text class="k">最近学习</text><text class="v">{{ lastText }}</text></view>
    </view>
    <navigator url="/pages/favorite/favorite" class="link">我的收藏</navigator>
    <navigator url="/pages/setting/setting" class="link">设置</navigator>
  </view>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import { onShow } from '@dcloudio/uni-app';

import type { LearningStats } from '../../core/types';
import { bootstrap } from '../../platform';

const stats = ref<LearningStats>({ readCount: 0, quizAttempts: 0, correctRate: null, lastAt: '' });

// 无作答时显示 `-`，不显示 0%（0% 会被误读为「全错」）
const rateText = computed(() =>
  stats.value.correctRate === null ? '-' : `${Math.round(stats.value.correctRate * 100)}%`,
);
const lastText = computed(() => stats.value.lastAt.slice(0, 10) || '-');

// onShow 而不是 onLoad：从阅读器或答题页返回后必须立刻反映
onShow(async () => {
  try {
    const { repo } = await bootstrap();
    stats.value = await repo.learningStats();
  } catch {
    // 「我的」不因读库失败而报错，保持上一次的值
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
</style>