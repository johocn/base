<template>
  <view class="wrap">
    <text v-if="error" class="error">{{ error }}</text>
    <block v-else>
      <text class="title">{{ article?.title }}</text>
      <text class="meta">{{ article?.publishedAt }}</text>
      <image v-if="coverPath" :src="coverPath" mode="widthFix" class="cover" />
      <text v-for="(p, i) in paragraphs" :key="i" class="para">{{ p }}</text>
    </block>
  </view>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import { onLoad } from '@dcloudio/uni-app';

import type { ArticleRow } from '../../core/types';
import { bootstrap } from '../../platform';

const article = ref<ArticleRow | null>(null);
const paragraphs = ref<string[]>([]);
const coverPath = ref('');
const error = ref('');

onLoad(async (query) => {
  const itemId = String((query as Record<string, string> | undefined)?.itemId ?? '');
  try {
    const { repo } = await bootstrap();
    const alt = decodedId(itemId);
    const row = (await repo.getArticle(itemId)) ?? (alt === itemId ? null : await repo.getArticle(alt));
    if (!row) {
      error.value = '本地没有这篇正文，请返回先同步';
      return;
    }
    article.value = row;
    paragraphs.value = row.bodyMd
      .replace(/\r\n/g, '\n')
      .split('\n\n')
      .map((s) => s.trim())
      .filter((s) => s !== '');

    const slug = row.itemId.replace(/^article:/, '');
    const path = await repo.findBlobPathByItem(`cover:${slug}`);
    coverPath.value = path ? (path.startsWith('file://') ? path : `file://${path}`) : '';
  } catch (e) {
    error.value = (e as Error).message;
  }
});

/** 页面间传参在个别机型上会保留百分号编码（itemId 含 `:` 会变成 %3A），按原样查不到就按解码后再查 */
function decodedId(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}
</script>

<style>
.wrap { padding: 16px; }
.title { font-size: 22px; font-weight: 600; }
.meta { display: block; color: #888888; font-size: 12px; margin-bottom: 12px; }
.cover { width: 100%; margin-bottom: 12px; }
.para { display: block; margin-bottom: 12px; line-height: 1.8; }
.error { color: #c53030; font-size: 13px; }
</style>