<template>
  <view class="wrap" :class="theme">
    <view v-if="progress > 0" class="progress" :style="`width:${progress}%`"></view>
    <text v-if="error" class="error">{{ error }}</text>
    <block v-else>
      <image v-if="coverPath" :src="coverPath" mode="widthFix" class="cover" />
      <text class="title" :class="titleColor ? 'c-' + titleColor : ''">{{ article?.title }}</text>
      <view v-if="badge.length > 0" class="chips">
        <text v-for="b in badge" :key="b" class="badge">{{ b }}</text>
      </view>
      <text class="meta">{{ article?.publishedAt }}</text>
      <view class="tags">
        <text v-for="t in articleTags" :key="t.tagId" class="tag" @click="openTag(t.tagId)">{{ tagLabel(t.tagId) }}</text>
        <text v-if="pendingTag" class="tag-pending" @click="applyTag">待补标签 · 补标签</text>
        <text v-else-if="articleTags.length > 0" class="tag-note" @click="proposeTag">已有标签，改动需提案</text>
      </view>
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
      <rich-text
        :nodes="bodyHtml"
        class="body"
        :style="`font-size:${READER_FONT_SIZE[fontScale]}px`"
      />
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
import { attrsOf } from '../../core/container-view';
import { setPendingTarget } from '../../core/comment';
import { canGovern, tagsOf, untaggedTargets } from '../../core/tags';
import { renderMarkdown } from '../../core/markdown';
import type { ArticleRow, TagLinkRow } from '../../core/types';
import { bootstrap } from '../../platform';

const article = ref<ArticleRow | null>(null);
const bodyHtml = ref('');
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
const articleTags = ref<TagLinkRow[]>([]);
const tagTitles = ref<Record<string, string>>({});
const untagged = ref<Set<string>>(new Set());
const governor = ref(false);
const pendingTag = computed(() => governor.value && untagged.value.has(itemId.value));
const itemId = ref('');
// 图章与标题色（册子 #53 §2.5）：文章不产属性行，无载体行时自然为空（设计册登记的事实）
const badge = ref<string[]>([]);
const titleColor = ref('');
/** 可滚动高度 = 正文实际高度 − 视口高度；为 0 表示还没量到，此时不显示进度条 */
const scrollable = ref(0);
const scrolled = ref(0);

const themeLabel = computed(() => READER_THEME_LABEL[theme.value]);

onLoad(async (query) => {
  const q = (query as Record<string, string> | undefined) ?? {};
  const raw = String(q.itemId ?? '');
  itemId.value = raw;
  try {
    const { opts, repo } = await bootstrap();
    // from=ledger：从「我创建的」区进入 → 正文取台账行，不读包表（册子 #51 §3.3）。
    if (q.from === 'ledger') {
      const sub = await repo.getSubmission(raw);
      if (!sub) {
        error.value = '本地没有这篇正文，请返回先同步';
        return;
      }
      article.value = {
        itemId: sub.itemId,
        title: sub.title,
        digest: '',
        publishedAt: '',
        tagsJson: '',
        bodyMd: sub.bodyMd,
        contentHash: '',
        rev: '',
      };
      itemId.value = sub.itemId;
      bodyHtml.value = renderMarkdown(sub.bodyMd);
      theme.value = normalizeTheme(await repo.getConfig('reader_theme'));
      fontScale.value = normalizeFontScale(await repo.getConfig('reader_font_scale'));
      fav.value = await repo.isFavorite(sub.itemId);
      await nextTick();
      measure();
      return;
    }
    const alt = decodedId(raw);
    const row = (await repo.getArticle(raw)) ?? (alt === raw ? null : await repo.getArticle(alt));
    if (!row) {
      error.value = '本地没有这篇正文，请返回先同步';
      return;
    }
    article.value = row;
    itemId.value = row.itemId;
    bodyHtml.value = renderMarkdown(row.bodyMd);
    const a = attrsOf(await repo.listSegments(raw));
    badge.value = a.badge;
    titleColor.value = a.titleColor;

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
    const links = await repo.listTagLinks();
    const all = await repo.listItems();
    untagged.value = new Set(untaggedTargets(all, links));
    tagTitles.value = Object.fromEntries(all.filter((i) => i.type === 'tag').map((i) => [i.itemId, i.title || i.itemId]));
    articleTags.value = tagsOf(links, row.itemId);
    governor.value = await canGovern({ adapters: opts.adapters, repo, nodeBaseUrl: opts.nodeBaseUrl });
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

function openQuiz(itemId: string) {
  uni.navigateTo({ url: `/pages/quiz/quiz?itemId=${encodeURIComponent(itemId)}` });
}

/**
 * 「治理」恒显：本地 `items` 表没有 `author_id`，判不出「这条是不是我写的」，
 * 资格一律由服务端回 `item_self_owned` / `item_state_mismatch` 后提示（本册 §2.3）。
 */
function openGovernance() {
  uni.navigateTo({ url: `/pages/governance/governance?itemId=${encodeURIComponent(itemId.value)}` });
}

function tagLabel(tagId: string): string {
  return tagTitles.value[tagId] ?? tagId;
}

function openTag(tagId: string) {
  uni.navigateTo({ url: `/pages/tag/detail?tagId=${encodeURIComponent(tagId)}` });
}

function applyTag() {
  uni.navigateTo({ url: `/pages/tag/apply?target=${encodeURIComponent(itemId.value)}&kind=article` });
}

function proposeTag() {
  uni.navigateTo({ url: `/pages/governance/governance?itemId=${encodeURIComponent(articleTags.value[0]!.tagId)}` });
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
.body { display: block; margin-bottom: 12px; line-height: 1.8; }

/* 正文变色：7 个枚举类（#44 §6）。c-mark 只改背景、不覆盖字色 */
.c-red { color: #C53030; }
.c-orange { color: #B7791F; }
.c-green { color: #2F855A; }
.c-blue { color: #2B6CB0; }
.c-purple { color: #6B46C1; }
.c-gray { color: #718096; }
.c-mark { background: #FFF3BF; }
.error { color: #c53030; font-size: 13px; }
.group { display: block; margin: 16px 0 6px; color: #888888; font-size: 13px; }
.quiz-item { padding: 10px 0; border-bottom: 1px solid #f2f2f2; }
.quiz-title { color: #2b6cb0; font-size: 15px; }
.tags { display: flex; flex-wrap: wrap; align-items: center; margin: 0 0 10px; }
.tag { padding: 2px 8px; margin: 0 8px 6px 0; background: #ebf8ff; color: #2b6cb0; border-radius: 10px; font-size: 12px; }
.tag-pending { padding: 2px 8px; margin: 0 8px 6px 0; background: #fffaf0; color: #b7791f; border-radius: 10px; font-size: 12px; }
.tag-note { margin: 0 0 6px; color: #888888; font-size: 12px; }
.chips { display: flex; flex-wrap: wrap; margin-top: 4px; }
.badge { display: inline-block; font-size: 12px; color: #666666; border: 1px solid #dddddd; border-radius: 10px; padding: 0 8px; margin-right: 6px; }

/* 护眼：米黄纸底 + 暖褐字，介于浅色与深色之间 */
.wrap.sepia { background: #f4ecd8; color: #4a4034; }
.sepia .title { color: #3d3428; }
.sepia .meta { color: #8a7c66; }
.sepia .act { color: #8a6d3b; }
.sepia .body { color: #4a4034; }
.sepia .c-red { color: #B23A3A; }
.sepia .c-orange { color: #A0651A; }
.sepia .c-green { color: #3B7A57; }
.sepia .c-blue { color: #2E5E8C; }
.sepia .c-purple { color: #6B4A9E; }
.sepia .c-gray { color: #8A7C66; }
.sepia .c-mark { background: #EFD9A0; }

.wrap.dark { background: #1a1a1a; color: #e6e6e6; }
.dark .title { color: #f0f0f0; }
.dark .meta { color: #999999; }
.dark .body { color: #e6e6e6; }
.dark .act { color: #63b3ed; }
.dark .c-red { color: #FC8181; }
.dark .c-orange { color: #F6AD55; }
.dark .c-green { color: #68D391; }
.dark .c-blue { color: #63B3ED; }
.dark .c-purple { color: #B794F4; }
.dark .c-gray { color: #A0AEC0; }
.dark .c-mark { background: #5A4A1F; }
</style>