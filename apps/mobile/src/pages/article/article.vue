<template>
  <view class="wrap" :class="theme">
    <view v-if="progress > 0" class="progress" :style="`width:${progress}%`"></view>
    <text v-if="error" class="error">{{ error }}</text>
    <block v-else>
      <image v-if="coverPath" :src="coverPath" mode="widthFix" class="cover" />
      <text class="title">{{ article?.title }}</text>
      <text class="meta">{{ article?.publishedAt }}</text>
      <view class="actions">
        <text class="act" :class="fav ? 'act-on' : ''" @click="toggleFav">{{ fav ? '已收藏' : '收藏' }}</text>
        <text class="act" @click="cycleFont">A {{ fontScale }}</text>
        <text class="act" @click="cycleTheme">{{ themeLabel }}</text>
        <text class="act" @click="openComments">评论</text>
        <text class="act" @click="openGovernance">治理</text>
      </view>
      <block v-if="siblingQuizzes.length > 0">
        <text class="group">本课测验</text>
        <view v-for="qz in siblingQuizzes" :key="qz.itemId" class="quiz-item" @click="openQuiz(qz.itemId)">
          <text class="quiz-title">{{ qz.title }}</text>
        </view>
      </block>
      <text
        v-for="(p, i) in paragraphs"
        :key="i"
        class="para"
        :style="`font-size:${READER_FONT_SIZE[fontScale]}px`"
      >{{ p }}</text>
    </block>
  </view>
</template>

<script setup lang="ts">
import { computed, nextTick, ref } from 'vue';
import { onLoad, onPageScroll } from '@dcloudio/uni-app';

import {
  READER_FONT_SIZE,
  READER_THEME_LABEL,
  nextFontScale,
  nextTheme,
  normalizeFontScale,
  normalizeTheme,
  type ReaderFontScale,
  type ReaderTheme,
} from '../../core/state';
import { childrenOf, lessonOfCarrier } from '../../core/course-tree';
import { setPendingTarget } from '../../core/comment';
import type { ArticleRow } from '../../core/types';
import { bootstrap } from '../../platform';

const article = ref<ArticleRow | null>(null);
const paragraphs = ref<string[]>([]);
const coverPath = ref('');
const error = ref('');
const fav = ref(false);
const theme = ref<ReaderTheme>('light');
const fontScale = ref<ReaderFontScale>(2);
const progress = ref(0);
interface SiblingQuiz {
  itemId: string;
  title: string;
}
const siblingQuizzes = ref<SiblingQuiz[]>([]);
const itemId = ref('');
/** 可滚动高度 = 正文实际高度 − 视口高度；为 0 表示还没量到，此时不显示进度条 */
const scrollable = ref(0);
const scrolled = ref(0);

const themeLabel = computed(() => READER_THEME_LABEL[theme.value]);

onLoad(async (query) => {
  const raw = String((query as Record<string, string> | undefined)?.itemId ?? '');
  itemId.value = raw;
  try {
    const { repo } = await bootstrap();
    const alt = decodedId(raw);
    const row = (await repo.getArticle(raw)) ?? (alt === raw ? null : await repo.getArticle(alt));
    if (!row) {
      error.value = '本地没有这篇正文，请返回先同步';
      return;
    }
    article.value = row;
    itemId.value = row.itemId;
    paragraphs.value = row.bodyMd
      .replace(/\r\n/g, '\n')
      .split('\n\n')
      .map((s) => s.trim())
      .filter((s) => s !== '');

    const path = await repo.findBlobPathByItem(`${row.itemId}/cover`);
    coverPath.value = path ? (path.startsWith('file://') ? path : `file://${path}`) : '';

    theme.value = normalizeTheme(await repo.getConfig('reader_theme'));
    fontScale.value = normalizeFontScale(await repo.getConfig('reader_font_scale'));
    fav.value = await repo.isFavorite(row.itemId);
    // 文章页的答题入口：文章所属课时内的姊妹 quiz；文章无课程归属时无此入口（册子 §4）
    const lessonId = lessonOfCarrier(row.itemId);
    if (lessonId) {
      const acc: SiblingQuiz[] = [];
      for (const id of childrenOf(await repo.listSegments(lessonId))) {
        const sib = await repo.getItem(id);
        if (sib?.type === 'quiz') acc.push({ itemId: id, title: sib.title || id });
      }
      siblingQuizzes.value = acc;
    }
    // 进入即标记已读；readAtNext 保证只写首次
    await repo.markRead(row.itemId, new Date().toISOString());
    await nextTick();
    measure();
  } catch (e) {
    error.value = (e as Error).message;
  }
});

onPageScroll((e) => {
  scrolled.value = e.scrollTop;
  paintProgress();
});

/**
 * 进度 = 已滚 / 可滚。可滚高度必须实测：正文长短与字号都影响它，
 * 用固定除数（如 scrollTop/6）会让长文滚一小段就顶到 100%，是误导。
 */
function paintProgress() {
  progress.value =
    scrollable.value > 0 ? Math.min(100, Math.max(0, Math.round((scrolled.value / scrollable.value) * 100))) : 0;
}

/** 正文渲染完、以及每次改字号之后都要重新量（字号变则总高变） */
function measure() {
  const winH = uni.getSystemInfoSync().windowHeight;
  uni
    .createSelectorQuery()
    .select('.wrap')
    .boundingClientRect()
    .exec((res) => {
      const rect = res && res[0] ? (res[0] as { height?: number }) : undefined;
      scrollable.value = Math.max(0, (rect?.height ?? 0) - winH);
      paintProgress();
    });
}

async function toggleFav() {
  const { repo } = await bootstrap();
  fav.value = await repo.toggleFavorite(itemId.value, new Date().toISOString());
}

async function cycleFont() {
  fontScale.value = nextFontScale(fontScale.value);
  const { repo } = await bootstrap();
  await repo.setConfig('reader_font_scale', String(fontScale.value));
  await nextTick();
  measure();
}

async function cycleTheme() {
  theme.value = nextTheme(theme.value);
  const { repo } = await bootstrap();
  await repo.setConfig('reader_theme', theme.value);
}

/** 评论 tab 不能带 query，target_id 走模块级锚定态（册子 §6.3） */
function openComments() {
  setPendingTarget(itemId.value);
  uni.switchTab({ url: '/pages/comment/comment' });
}

/**
 * 「治理」恒显：本地 `items` 表没有 `author_id`，判不出「这条是不是我写的」，
 * 资格一律由服务端回 `item_self_owned` / `item_state_mismatch` 后提示（本册 §2.3）。
 */
function openQuiz(itemId: string) {
  uni.navigateTo({ url: `/pages/quiz/quiz?itemId=${encodeURIComponent(itemId)}` });
}

function openGovernance() {
  uni.navigateTo({ url: `/pages/governance/governance?itemId=${encodeURIComponent(itemId.value)}` });
}

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
.wrap { padding: 16px; min-height: 100vh; }
.progress { position: fixed; top: 0; left: 0; height: 2px; background: #2b6cb0; z-index: 10; }
.title { font-size: 22px; font-weight: 600; }
.meta { display: block; color: #888888; font-size: 12px; margin-bottom: 12px; }
.cover { width: 100%; margin-bottom: 12px; }
.actions { display: flex; margin-bottom: 16px; }
.act { margin-right: 18px; color: #2b6cb0; font-size: 14px; }
.act-on { color: #b7791f; }
.para { display: block; margin-bottom: 12px; line-height: 1.8; }
.error { color: #c53030; font-size: 13px; }
.group { display: block; margin: 16px 0 6px; color: #888888; font-size: 13px; }
.quiz-item { padding: 10px 0; border-bottom: 1px solid #f2f2f2; }
.quiz-title { color: #2b6cb0; font-size: 15px; }

/* 护眼：米黄纸底 + 暖褐字，介于浅色与深色之间 */
.wrap.sepia { background: #f4ecd8; color: #4a4034; }
.sepia .title { color: #3d3428; }
.sepia .meta { color: #8a7c66; }
.sepia .act { color: #8a6d3b; }
.sepia .para { color: #4a4034; }

.wrap.dark { background: #1a1a1a; color: #e6e6e6; }
.dark .title { color: #f0f0f0; }
.dark .meta { color: #999999; }
.dark .para { color: #e6e6e6; }
.dark .act { color: #63b3ed; }
</style>