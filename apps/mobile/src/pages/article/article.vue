<template>
  <view class="wrap" :class="theme">
    <view v-if="progress > 0" class="progress" :style="`width:${progress}%`"></view>
    <text v-if="error" class="error">{{ error }}</text>
    <block v-else>
      <image v-if="coverPath" :src="coverPath" mode="widthFix" class="cover" />
      <text class="title" :class="titleColor ? 'c-' + titleColor : ''">{{ article?.title }}</text>
      <view v-if="authorDisplay.name" class="author-bar">
        <view class="avatar" :style="`background:hsl(${authorDisplay.hue} 65% 55%)`">
          <text class="avatar-char">{{ authorDisplay.name.slice(0, 1).toUpperCase() }}</text>
        </view>
        <view class="author-info">
          <text class="author-name">{{ authorDisplay.name }}</text>
          <text v-if="authorDisplay.count > 0" class="author-count">· {{ authorDisplay.count }} 条贡献</text>
          <text class="author-dot">·</text>
          <text class="author-time">{{ article?.publishedAt }}</text>
        </view>
      </view>
      <view v-if="badge.length > 0" class="chips">
        <text v-for="b in badge" :key="b" class="badge">{{ b }}</text>
      </view>
      <text v-if="!authorDisplay.name" class="meta">{{ article?.publishedAt }}</text>
      <view class="tags">
        <text v-for="t in tagChips(articleTags).chips" :key="t.tagId" class="tag" @click="openTag(t.tagId)">{{ t.label }}<text v-if="t.pending" class="term-badge">待票选</text></text>
        <text v-if="tagChips(articleTags).overflow > 0" class="tag-more">+{{ tagChips(articleTags).overflow }}</text>
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
import { onHide, onLoad, onPageScroll, onUnload } from '@dcloudio/uni-app';

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
import { articleDone, articlePosition } from '../../core/progress';
import { reportProgress } from '../../core/progress-store';
import { displayOf, loadDirectory, normalizeTermKey, termState, type DirectorySnapshot } from '../../core/directory';
import { canGovern, decodeTagPath, tagTitle, tagsOf, untaggedTargets } from '../../core/tags';
import { renderMarkdown } from '../../core/markdown';
import { decodeUtf8 } from '../../core/sync';
import type { ArticleRow, TagLinkRow } from '../../core/types';
import { bootstrap } from '../../platform';
import { roster, type ContributorItem } from '../../core/contribution';

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
/** 目录快照（三态判定用）：进入页面时读本地缓存，模板只读 */
const directory = ref<DirectorySnapshot>({ version: 0, approved: new Map(), pending: new Map() });
const tagTitles = ref<Record<string, string>>({});
const untagged = ref<Set<string>>(new Set());
const governor = ref(false);
const pendingTag = computed(() => governor.value && untagged.value.has(itemId.value));
const itemId = ref('');
/** 条目作者归属缓存（节点验签写入，可能为空） */
const authorId = ref('');
/** 贡献前 10 名册，authorId → ContributorItem 映射；空 Map 表示 fetch 失败或未拉 */
const rosterMap = ref(new Map<string, ContributorItem>());
/** 单条 profile API 缓存，authorId → 昵称；miss 或失败就不写，computed 回退 id[:8] */
const profileNameCache = ref(new Map<string, string>());
/** 昵称三级降级链：名册命中 → profile API 命中 → id[:8] 回退 */
const authorDisplay = computed(() => {
  if (!authorId.value) return { name: '', count: 0, hue: 0 };
  const hit = rosterMap.value.get(authorId.value);
  if (hit) return { name: hit.name, count: hit.count, hue: avatarHue(authorId.value) };
  const pName = profileNameCache.value.get(authorId.value);
  if (pName) return { name: pName, count: 0, hue: avatarHue(authorId.value) };
  return { name: authorId.value.slice(0, 8), count: 0, hue: avatarHue(authorId.value) };
});
/** authorId → 稳定 HSL 色相（纯本地哈希，零网络） */
function avatarHue(hex: string): number {
  let h = 0;
  for (let i = 0; i < hex.length; i++) h = (h * 31 + hex.charCodeAt(i)) >>> 0;
  return h % 360;
}
/**
 * 第三级降级：roster miss → 单条 profile API 补查；失败静默不阻塞。
 * 只在当前 authorId 不在前 10 名册、且未缓存过时触发。
 */
async function resolveAuthorName(aid: string, opts: { adapters: { http: { get: (u: string) => Promise<{ status: number; body: Uint8Array }> } }; nodeBaseUrl: string }) {
  if (!aid || rosterMap.value.has(aid) || profileNameCache.value.has(aid)) return;
  try {
    const res = await opts.adapters.http.get(`${opts.nodeBaseUrl}/v1/profile/${aid}`);
    if (res.status !== 200) return;
    const json = JSON.parse(decodeUtf8(res.body)) as { name?: string };
    if (json.name) profileNameCache.value.set(aid, json.name);
  } catch {
    // 静默：404 / 无网络 → 继续回退 id[:8]
  }
}
// 图章与标题色（册子 #53 §2.5）：文章不产属性行，无载体行时自然为空（设计册登记的事实）
const badge = ref<string[]>([]);
const titleColor = ref('');
/** 可滚动高度 = 正文实际高度 − 视口高度；为 0 表示还没量到，此时不显示进度条 */
const scrollable = ref(0);
const scrolled = ref(0);
/** 待续位的滚动比例 0..1（进入时从本地 progress 读出）；0 = 不续位 */
const pendingRestore = ref(0);
/** 是否已实测过可滚高度：未测量时禁止上报（否则会把没测到的文章当「读完」） */
let measured = false;

const themeLabel = computed(() => READER_THEME_LABEL[theme.value]);

onLoad(async (query) => {
  const q = (query as Record<string, string> | undefined) ?? {};
  const raw = String(q.itemId ?? '');
  itemId.value = raw;
  try {
    const { opts, repo } = await bootstrap();
    directory.value = await loadDirectory(repo);
    // 贡献前 10 名册：独立 try-catch，失败静默（不阻塞正文渲染、不影响任何路径）
    if (opts.nodeBaseUrl) {
      try {
        const list = await roster({ adapters: opts.adapters, repo, nodeBaseUrl: opts.nodeBaseUrl });
        rosterMap.value = new Map(list.map((c) => [c.id, c]));
      } catch {
        // 静默：无网络 / 节点未配置时 author-bar 自然降级为 id[:8]
      }
    }
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
      await restoreProgress(sub.itemId);
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
    // 拿归属缓存：节点验签写入的 authorId（可能为空 → author-bar 自然降级不渲染）
    const item = await repo.getItem(row.itemId);
    authorId.value = item?.authorId ?? '';
    // 第三级降级：roster miss → 单条 profile API 补查（只对当前 authorId 懒加载一次）
    if (authorId.value && opts.nodeBaseUrl) void resolveAuthorName(authorId.value, opts);
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
    await restoreProgress(row.itemId);
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
 * 进度 = 已滚 / 可滚。可滚高度必须实测：正文长短与字号都影响它。
 * 未量到 / 无需滚动（短文全可见）时**保留本地续位画出的初值**，不归零——
 * 否则推进去的一瞬间会把「上次读到哪」洗掉。
 */
function paintProgress() {
  if (scrollable.value <= 0) return;
  progress.value = Math.min(100, Math.max(0, Math.round((scrolled.value / scrollable.value) * 100)));
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
      measured = true;
      // 续位只能在量到可滚高度之后做：`Math.round(scrollable * fraction)` 才是千分比对应的像素位
      if (pendingRestore.value > 0 && scrollable.value > 0) {
        const top = Math.round(scrollable.value * pendingRestore.value);
        pendingRestore.value = 0;
        uni.pageScrollTo({ scrollTop: top, duration: 0 });
      }
      paintProgress();
    });
}

/** 进入时按本地 progress 续位：细进度条先画到上次位置，正文渲染完（`measure`）后再滚过去（#8 册子 §6）。 */
async function restoreProgress(id: string) {
  try {
    const { repo } = await bootstrap();
    const p = await repo.getProgress(id);
    if (!p) return;
    progress.value = Math.round(Math.min(1000, Math.max(0, p.position)) / 10);
    if (p.position > 0 && p.position < 1000) pendingRestore.value = p.position / 1000;
  } catch {
    // 读本地失败不影响阅读
  }
}

/** 当前位置的归一化千分比：无需滚动（短文全可见）即视为读完。 */
function currentPosition(): number {
  return articlePosition(scrollable.value > 0 ? scrolled.value / scrollable.value : 1);
}

/**
 * 离开页面 / 切前后台时上报一次（§5.3 触发点；不做「滚动即写」——队列会被滚动淹没并撞节点限速）。
 * 失败静默：本地已由 `reportProgress` 写入，离开动作不该弹错。
 */
async function reportNow() {
  // 只在文章成功载入且已实测过时上报：否则会把未载入/未测量的文章当「读完」落库
  if (itemId.value === '' || error.value !== '' || article.value === null || !measured) return;
  try {
    const { opts, repo } = await bootstrap();
    const position = currentPosition();
    await reportProgress(
      { adapters: opts.adapters, repo, nodeBaseUrl: opts.nodeBaseUrl },
      { itemId: itemId.value, position, done: articleDone(position) },
    );
  } catch {
    // 静默
  }
}

onHide(() => {
  void reportNow();
});
onUnload(() => {
  void reportNow();
});

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

/** 原文 → 词条键；非法/空归空串（按 empty 态处理） */
function termKeyOf(raw: string): string {
  return normalizeTermKey(raw) ?? '';
}

interface TagChip {
  tagId: string;
  label: string;
  pending: boolean;
}

/** 标签 chip 视图（#58 §5.1/§5.3）：名称段走目录展示名，pending 加角标；待票选最多 3 个，超出「+n」。 */
function tagChips(tags: TagLinkRow[]): { chips: TagChip[]; overflow: number } {
  const chips: TagChip[] = [];
  let pendingTotal = 0;
  let pendingShown = 0;
  for (const t of tags) {
    const p = decodeTagPath(t.tagId);
    const key = p ? termKeyOf(p.name) : '';
    if (p === null || key === '') {
      chips.push({ tagId: t.tagId, label: tagTitles.value[t.tagId] ?? t.tagId, pending: false });
      continue;
    }
    const pending = termState(directory.value, 'tag', key) === 'pending';
    if (pending) {
      pendingTotal++;
      if (pendingShown >= 3) continue;
      pendingShown++;
    }
    chips.push({ tagId: t.tagId, label: tagTitle(displayOf(directory.value, 'tag', key), p.chapter, p.section), pending });
  }
  return { chips, overflow: Math.max(0, pendingTotal - 3) };
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
/* 作者栏：仿 Discuz 经典帖首行 */
.author-bar { display: flex; align-items: center; gap: 10px; margin: 8px 0 6px; }
.avatar { width: 32px; height: 32px; border-radius: 50%; display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
.avatar-char { color: #fff; font-size: 14px; font-weight: 600; }
.author-info { display: flex; align-items: center; gap: 4px; flex-wrap: wrap; }
.author-name { font-size: 14px; font-weight: 600; color: #2b6cb0; }
.author-count { font-size: 12px; color: #718096; }
.author-dot { font-size: 12px; color: #cbd5e0; margin: 0 2px; }
.author-time { font-size: 12px; color: #a0aec0; }
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
.tag-more { margin: 0 8px 6px 0; color: #888888; font-size: 12px; }
.term-badge { display: inline-block; margin-left: 4px; padding: 0 4px; border-radius: 6px; background: #edf2f7; color: #718096; font-size: 11px; }
.chips { display: flex; flex-wrap: wrap; margin-top: 4px; }
.badge { display: inline-block; font-size: 12px; color: #666666; border: 1px solid #dddddd; border-radius: 10px; padding: 0 8px; margin-right: 6px; }

/* 护眼：米黄纸底 + 暖褐字，介于浅色与深色之间 */
.wrap.sepia { background: #f4ecd8; color: #4a4034; }
.sepia .title { color: #3d3428; }
.sepia .meta { color: #8a7c66; }
.sepia .author-name { color: #8a6d3b; }
.sepia .author-count, .sepia .author-dot, .sepia .author-time { color: #8a7c66; }
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
.dark .author-name { color: #63b3ed; }
.dark .author-count, .dark .author-dot, .dark .author-time { color: #a0aec0; }
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