<template>
  <view class="wrap">
    <input
      v-model="keyword"
      class="input"
      type="text"
      confirm-type="search"
      placeholder="搜索标题与正文"
      @input="onInput"
    />
    <text v-if="loaded && results.length === 0 && hasContent" class="hint">没搜到</text>
    <text v-if="loaded && !hasContent" class="hint">还没有内容，先去课程页同步。</text>
    <view v-for="r in results" :key="r.itemId" class="card" @click="open(r.itemId)">
      <text class="t">{{ r.title }}</text>
      <text class="meta">{{ r.digest }}</text>
    </view>
  </view>
</template>

<script setup lang="ts">
import { ref } from 'vue';

import type { ArticleRow } from '../../core/types';
import { bootstrap } from '../../platform';

const keyword = ref('');
const results = ref<ArticleRow[]>([]);
const loaded = ref(false);
const hasContent = ref(false);

// onInput 而不是 watch：老 WebView 下 input 事件最稳，且避免同一输入触发两次查询
async function onInput() {
  try {
    const { repo } = await bootstrap();
    if (!hasContent.value) {
      hasContent.value = (await repo.listItems()).some((i) => i.type === 'article');
    }
    results.value = await repo.searchArticles(keyword.value);
    loaded.value = true;
  } catch {
    results.value = [];
    loaded.value = true;
  }
}

function open(itemId: string) {
  uni.navigateTo({ url: `/pages/article/article?itemId=${encodeURIComponent(itemId)}` });
}
</script>

<style>
.wrap { padding: 16px; }
.input { border: 1px solid #dddddd; border-radius: 6px; padding: 10px; font-size: 15px; }
.card { border: 1px solid #eeeeee; border-radius: 8px; padding: 10px; margin-top: 10px; }
.t { display: block; font-size: 15px; }
.meta { display: block; color: #888888; font-size: 12px; }
.hint { display: block; margin-top: 16px; color: #888888; font-size: 13px; }
</style>