<template>
  <view class="page">
    <view class="hero">
      <text class="hero-title">base 学习</text>
    </view>
    <!-- 公告条（#84 §4.4）：读本机生效公告 config，多条竖向轮播 3s/条，空隐藏 -->
    <view v-if="announcements.length > 0" class="notice-bar">
      <swiper
        class="notice-swiper"
        :vertical="announcements.length > 1"
        :circular="announcements.length > 1"
        :autoplay="announcements.length > 1"
        :interval="3000"
        :duration="500"
      >
        <swiper-item v-for="(a, i) in announcements" :key="i">
          <view class="notice-item">
            <text class="notice-tag">公告</text>
            <text class="notice-text">{{ a }}</text>
          </view>
        </swiper-item>
      </swiper>
    </view>
    <input class="search" placeholder="搜索课程与文章" :value="keyword" @input="onSearch" />
    <!-- 宫格区（#84 Task 3）：每行 3 大图标；必修/选修/精品→课程列表按类目过滤，文章→文章 tab（switchTab），评论→评论页（navigateTo），动态分类→分类过滤+滚动列表，更多分类→滚动课程列表 -->
    <view class="grid">
      <view class="cell" @click="applyFilter('required')"><text class="cell-ico">📕</text><text class="cell-tx">必修</text></view>
      <view class="cell" @click="applyFilter('elective')"><text class="cell-ico">📗</text><text class="cell-tx">选修</text></view>
      <view class="cell" @click="applyFilter('featured')"><text class="cell-ico">⭐</text><text class="cell-tx">精品</text></view>
      <view class="cell" @click="go('/pages/search/search')"><text class="cell-ico">📰</text><text class="cell-tx">文章</text></view>
      <view class="cell" @click="go('/pages/comment/comment')"><text class="cell-ico">💬</text><text class="cell-tx">评论</text></view>
      <view v-for="c in gridCategories" :key="c.slug" class="cell" @click="applyCategory(c.slug)">
        <text class="cell-ico">📚</text><text class="cell-tx">{{ c.label }}</text>
      </view>
      <view class="cell" @click="scrollToCourses"><text class="cell-ico">🗂️</text><text class="cell-tx">更多分类</text></view>
    </view>
    <!-- A 大卡瀑布区：最近更新（课程/文章混合） -->
    <view class="feed">
      <text class="feed-head">最近更新</text>
      <text v-if="rows.length === 0" class="feed-hint">{{ keyword.trim() === '' ? '还没有内容' : '没搜到' }}</text>
      <view class="card" v-for="row in rows" :key="row.itemId" @click="open(row)">
        <text class="card-title">{{ row.title }}</text>
        <text class="card-meta">{{ row.meta }}</text>
      </view>
      <text v-if="error" class="feed-error">{{ error }}</text>
    </view>
    <!-- 课程列表区（#84 Task 4）：Discuz 平铺，角标置顶/加精/推荐按权重排序截 20；区头 id 即宫格滚动锚点 -->
    <text id="course-list" class="list-head">{{ listHeadText }}</text>
    <text v-if="filterActive" class="filter-clear" @click="clearFilter">✕ 取消筛选</text>
    <text v-if="courseRows.length === 0" class="feed-hint">{{ filterActive ? '没有匹配的课程' : '下拉同步后可见' }}</text>
    <view v-for="row in courseRows" :key="row.itemId" class="flat-row" @click="openCourse(row.itemId)">
      <view class="flat-head">
        <text v-if="row.flagText !== ''" class="flag" :class="row.flagCls">{{ row.flagText }}</text>
        <text class="flat-title">{{ row.title }}</text>
      </view>
      <text v-if="row.meta !== ''" class="flat-meta">{{ row.meta }}</text>
    </view>
    <!-- 精选文章区（#84 Task 4）：本机文章 items，同一角标规则排序截 20 -->
    <text class="list-head">精选文章</text>
    <text v-if="articleRows.length === 0" class="feed-hint">下拉同步后可见</text>
    <view v-for="row in articleRows" :key="row.itemId" class="flat-row" @click="openArticle(row.itemId)">
      <view class="flat-head">
        <text v-if="row.flagText !== ''" class="flag" :class="row.flagCls">{{ row.flagText }}</text>
        <text class="flat-title">{{ row.title }}</text>
      </view>
      <text v-if="row.meta !== ''" class="flat-meta">{{ row.meta }}</text>
    </view>
    <!-- 公开圈子区（#84 Task 4）：本机 groups 形态公开（encrypted=0）的圈子，截 20 -->
    <text class="list-head">公开圈子</text>
    <text v-if="circleRows.length === 0" class="feed-hint">下拉同步后可见</text>
    <view v-for="row in circleRows" :key="row.groupId" class="flat-row" @click="openGroup(row.groupId)">
      <view class="flat-head">
        <text class="flat-title">{{ row.title }}</text>
      </view>
      <text class="flat-meta">{{ row.meta }}</text>
    </view>
  </view>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import { onShow } from '@dcloudio/uni-app';

import { runCreatorVisibilityMigration, runLedgerHealMigration } from '../../core/creator-migrate';
import { groupCoursesByCategory, splitCourses } from '../../core/course-tree';
import { displayOf, loadDirectory, normalizeTermKey, type DirectorySnapshot } from '../../core/directory';
import type { GroupRow, ItemRow, SegmentRow } from '../../core/types';
import { bootstrap } from '../../platform';

interface CategoryGroupVM {
  slug: string;
  title: string;
  courses: ItemRow[];
}

const courses = ref<ItemRow[]>([]);
const articles = ref<ItemRow[]>([]);
const groups = ref<CategoryGroupVM[]>([]);
const standalone = ref<ItemRow[]>([]);
/** 公开圈子（#84 Task 4）：本机 groups 形态公开（encrypted=0）的圈子 */
const circles = ref<GroupRow[]>([]);
/** 目录快照：分类展示名判定（groupTitle）用；进入页面时读本地缓存，模板只读 */
const directory = ref<DirectorySnapshot>({ version: 0, approved: new Map(), pending: new Map() });
/** 生效公告（#84 §4.4）：config announcements_active（票选生效后由治理页写入），空数组 ⇒ 公告条隐藏 */
const announcements = ref<string[]>([]);
const error = ref('');

async function load() {
  try {
    const { repo, opts } = await bootstrap();
    directory.value = await loadDirectory(repo);
    // 生效公告（#84 §4.4）：读失败不阻断首页，按空处理
    try {
      const raw = await repo.getConfig('announcements_active');
      const parsed: unknown = raw === null ? [] : JSON.parse(raw);
      announcements.value = Array.isArray(parsed)
        ? parsed.filter((x): x is string => typeof x === 'string' && x.trim() !== '')
        : [];
    } catch {
      announcements.value = [];
    }
    // 一次性自愈迁移（册子 #56 §2.4）：幂等——标志位已存在即零动作；未配置节点则跳过。
    if (opts.nodeBaseUrl !== '') {
      await runCreatorVisibilityMigration(opts);
    }
    // 存量台账自愈（册子 #63 §2.2）：纯本地、不依赖节点地址 ⇒ 放在上面判据之外，串行执行。
    await runLedgerHealMigration({ repo });
    const all = await repo.listItems();
    const active = all.filter((i) => i.state !== 'removed');
    const tree = splitCourses(active);
    courses.value = tree.courses;
    articles.value = active.filter((i) => i.type === 'article');

    // 分类分组（册子 #49 §3）：双来源 + 优先级。分组树不再渲染（#84 Task 4），
    // 组数据仍供宫格动态分类与课程列表的必修/选修/精品类判定（角标/过滤）使用；
    // 需要课程自身的 attr.category（逐课程取 segments）与分类清单行（逐分类取 segments）；只读、零写入。
    const segsByItemId = new Map<string, SegmentRow[]>();
    for (const it of active) {
      if (it.type === 'course' || it.source === 'category') {
        segsByItemId.set(it.itemId, await repo.listSegments(it.itemId));
      }
    }
    groups.value = groupCoursesByCategory(active, segsByItemId).groups;

    // 独立内容 = 独立文章 article/<aid> ∪ 独立题库 quiz/<qid>（册子 §5.2）：「最近更新」大卡流数据源
    standalone.value = [
      ...tree.ungrouped,
      ...active.filter((i) => i.type === 'quiz' && i.itemId.startsWith('quiz/')),
    ].sort((a, b) => (a.itemId < b.itemId ? -1 : a.itemId > b.itemId ? 1 : 0));

    // 公开圈子（#84 Task 4）：只取形态公开（encrypted=0）的圈子，零网络
    circles.value = (await repo.listGroups()).filter((g) => g.encrypted === 0);

    error.value = '';
  } catch (e) {
    error.value = (e as Error).message;
  }
}

/** 分类展示名（#58 §5.2）：词条键走目录展示名，键非法则回落既有组标题。 */
function groupTitle(g: CategoryGroupVM): string {
  const key = normalizeTermKey(g.slug) ?? '';
  return key === '' ? g.title : displayOf(directory.value, 'category', key);
}

/** 首页搜索关键字：本地过滤「最近更新」大卡流（册子 §3.2 大搜索框） */
const keyword = ref('');

/** 大卡流行视图：大字标题 + 标注字 meta（类型 · 更新日期） */
interface FeedRow {
  itemId: string;
  title: string;
  meta: string;
  kind: string;
  updatedAt: string;
}

const FEED_LABEL: Record<string, string> = { course: '课程', article: '文章', quiz: '题库' };

/** 「最近更新」大卡流（册子 §3.2 A 瀑布区）：课程 ∪ 独立内容，updatedAt 倒序，关键字本地过滤。 */
const rows = computed<FeedRow[]>(() => {
  const kw = keyword.value.trim().toLowerCase();
  const all: FeedRow[] = [...courses.value, ...standalone.value].map((it) => ({
    itemId: it.itemId,
    title: it.title || it.itemId,
    kind: it.type,
    updatedAt: it.updatedAt || '',
    meta: `${FEED_LABEL[it.type] ?? it.type} · ${(it.updatedAt || '').slice(0, 10)}`,
  }));
  const filtered =
    kw === '' ? all : all.filter((r) => r.title.toLowerCase().includes(kw) || r.itemId.toLowerCase().includes(kw));
  return filtered.sort((a, b) =>
    a.updatedAt === b.updatedAt ? (a.itemId < b.itemId ? -1 : 1) : a.updatedAt < b.updatedAt ? 1 : -1,
  );
});

/** 宫格跳转：tabBar 页走 switchTab（tab 页不可 navigateTo），其余 navigateTo。 */
const TAB_PATHS = new Set(['/pages/course/course', '/pages/circle/circle', '/pages/search/search', '/pages/mine/mine']);

function go(url: string) {
  if (TAB_PATHS.has(url)) {
    uni.switchTab({ url });
    return;
  }
  uni.navigateTo({ url });
}

/** 课程列表过滤态（#84 Task 4）：宫格必修/选修/精品按分类类目过滤；动态分类格按分类词条过滤。 */
type ListFilter = 'required' | 'elective' | 'featured';
const listFilter = ref<ListFilter | ''>('');
const categoryFilter = ref('');
const FILTER_HEAD: Record<ListFilter, string> = { required: '必修课程', elective: '选修课程', featured: '精品课程' };

/** courseId → 所属分类组：分组树不再渲染，分组数据仍是分类判定数据源 */
const groupByCourse = computed<Map<string, CategoryGroupVM>>(() => {
  const m = new Map<string, CategoryGroupVM>();
  for (const g of groups.value) {
    for (const c of g.courses) m.set(c.itemId, g);
  }
  return m;
});

/** 课程分类类目判定（沿用本页既有分类逻辑）：按分类展示名含「必修/选修/精品」归类，无分类返回 ''。 */
function courseClassOf(itemId: string): ListFilter | '' {
  const g = groupByCourse.value.get(itemId);
  if (!g) return '';
  const label = groupTitle(g);
  if (label.includes('必修')) return 'required';
  if (label.includes('选修')) return 'elective';
  if (label.includes('精品')) return 'featured';
  return '';
}

function categoryLabel(slug: string): string {
  const g = groups.value.find((x) => x.slug === slug);
  return g ? groupTitle(g) : slug;
}

const listHeadText = computed(() => {
  if (categoryFilter.value !== '') return categoryLabel(categoryFilter.value);
  return listFilter.value === '' ? '全部课程' : FILTER_HEAD[listFilter.value];
});

const filterActive = computed(() => listFilter.value !== '' || categoryFilter.value !== '');

function applyFilter(f: ListFilter) {
  listFilter.value = f;
  categoryFilter.value = '';
  scrollToCourses();
}

/** 宫格动态分类格（#84 Task 4）：分组树已删，改为设置分类过滤并滚动到课程列表区头。 */
function applyCategory(slug: string) {
  categoryFilter.value = slug;
  listFilter.value = '';
  scrollToCourses();
}

function clearFilter() {
  listFilter.value = '';
  categoryFilter.value = '';
}

/** 宫格「必修/选修/精品/更多分类」：页内滚动定位到课程列表区头锚点（#84 Task 3）。 */
function scrollToCourses() {
  uni.pageScrollTo({ selector: '#course-list', duration: 300 });
}

/** 宫格动态分类格（#84 Task 3）：groupCoursesByCategory 分类展示名去重。 */
const gridCategories = computed<Array<{ slug: string; label: string }>>(() => {
  const seen = new Set<string>();
  const out: Array<{ slug: string; label: string }> = [];
  for (const g of groups.value) {
    const label = groupTitle(g);
    if (seen.has(label)) continue;
    seen.add(label);
    out.push({ slug: g.slug, label });
  }
  return out;
});

/** Discuz 平铺行（#84 Task 4）：标题 + 角标 + meta，课程/文章区共用。 */
interface FlatRow {
  itemId: string;
  title: string;
  meta: string;
  flagText: string;
  flagCls: string;
  /** 排序权重（#84 §4.3）：置顶1 > 加精2 > 推荐3 > 正常4 */
  weight: number;
  updatedAt: string;
}

/** 角标映射（#84 §4.3）：置顶（红）=必修类、加精（橙）=精品类、推荐（蓝）=7 天内有更新；正常无标。 */
type FlagKind = 'top' | 'feat' | 'rec' | '';
const FLAG_META: Record<Exclude<FlagKind, ''>, { text: string; cls: string; weight: number }> = {
  top: { text: '置顶', cls: 'flag-top', weight: 1 },
  feat: { text: '加精', cls: 'flag-feat', weight: 2 },
  rec: { text: '推荐', cls: 'flag-rec', weight: 3 },
};
const NORMAL_WEIGHT = 4;
const REC_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

function isRecent(updatedAt: string): boolean {
  const t = Date.parse(updatedAt);
  return Number.isFinite(t) && Date.now() - t <= REC_WINDOW_MS;
}

/** 角标判定：一条只取一个角标，按 置顶 > 加精 > 推荐 优先。 */
function flagOf(itemId: string, updatedAt: string): FlagKind {
  const cls = courseClassOf(itemId);
  if (cls === 'required') return 'top';
  if (cls === 'featured') return 'feat';
  if (isRecent(updatedAt)) return 'rec';
  return '';
}

/** 次要 meta：更新日期 + 点赞数，有啥显示啥。 */
function metaOf(it: ItemRow): string {
  const parts: string[] = [];
  if (it.updatedAt !== '') parts.push(it.updatedAt.slice(0, 10));
  const likes = it.likeCount ?? 0;
  if (likes > 0) parts.push(`赞 ${likes}`);
  return parts.join(' · ');
}

function toFlatRow(it: ItemRow): FlatRow {
  const kind = flagOf(it.itemId, it.updatedAt);
  const flag = kind === '' ? undefined : FLAG_META[kind];
  return {
    itemId: it.itemId,
    title: it.title || it.itemId,
    meta: metaOf(it),
    flagText: flag?.text ?? '',
    flagCls: flag?.cls ?? '',
    weight: flag?.weight ?? NORMAL_WEIGHT,
    updatedAt: it.updatedAt || '',
  };
}

/** 排序（#84 §4.3）：权重升序，同权重 updated_at 倒序，itemId 兜底稳定。 */
function byWeight(a: FlatRow, b: FlatRow): number {
  if (a.weight !== b.weight) return a.weight - b.weight;
  if (a.updatedAt !== b.updatedAt) return a.updatedAt < b.updatedAt ? 1 : -1;
  return a.itemId < b.itemId ? -1 : a.itemId > b.itemId ? 1 : 0;
}

/** 课程列表 20 条：按宫格过滤态过滤后角标排序截 20。 */
const courseRows = computed<FlatRow[]>(() => {
  let list = courses.value;
  if (listFilter.value !== '') {
    const f = listFilter.value;
    list = list.filter((it) => courseClassOf(it.itemId) === f);
  } else if (categoryFilter.value !== '') {
    const slug = categoryFilter.value;
    list = list.filter((it) => groupByCourse.value.get(it.itemId)?.slug === slug);
  }
  return list.map(toFlatRow).sort(byWeight).slice(0, 20);
});

/** 精选文章 20 条（#84 Task 4）：本机文章 items，同一角标规则排序截 20。 */
const articleRows = computed<FlatRow[]>(() => articles.value.map(toFlatRow).sort(byWeight).slice(0, 20));

/** 公开圈子行（#84 Task 4）：圈名 + 形态标注 + 成员数，截 20。 */
interface CircleRow {
  groupId: string;
  title: string;
  meta: string;
}

const circleRows = computed<CircleRow[]>(() =>
  circles.value.slice(0, 20).map((g) => ({
    groupId: g.groupId,
    title: g.name || '未命名圈子',
    meta: `公开 · 成员 ${groupMemberCount(g.memberIdsJson)}`,
  })),
);

/** 成员数取自名单快照；投影损坏按 0，不让一行坏数据打断整页（与圈子页同口径）。 */
function groupMemberCount(memberIdsJson: string): number {
  try {
    const ids = JSON.parse(memberIdsJson) as unknown;
    return Array.isArray(ids) ? ids.length : 0;
  } catch {
    return 0;
  }
}

function openGroup(groupId: string) {
  uni.navigateTo({ url: `/pages/group/group?groupId=${encodeURIComponent(groupId)}` });
}

function onSearch(e: Event) {
  const detail = (e as { detail?: { value?: string } }).detail;
  keyword.value = detail?.value ?? '';
}

/** 大卡点开：沿用既有详情跳转（课程→课程详情，题库→答题页，其余→文章页）。 */
function open(row: FeedRow) {
  if (row.kind === 'course') {
    openCourse(row.itemId);
    return;
  }
  if (row.kind === 'quiz') {
    uni.navigateTo({ url: `/pages/quiz/quiz?itemId=${encodeURIComponent(row.itemId)}` });
    return;
  }
  openArticle(row.itemId);
}

function openArticle(itemId: string) {
  uni.navigateTo({ url: `/pages/article/article?itemId=${encodeURIComponent(itemId)}` });
}

function openCourse(itemId: string) {
  uni.navigateTo({ url: `/pages/course/detail?courseId=${encodeURIComponent(itemId)}` });
}

/** 首启引导检查只做一次：guide_seen 未写则跳引导页；标志位防 onShow 反复跳（#84） */
let guideChecked = false;

async function checkGuide() {
  if (guideChecked) return;
  guideChecked = true;
  try {
    const { repo } = await bootstrap();
    const seen = await repo.getConfig('guide_seen');
    if (!seen) {
      uni.navigateTo({ url: '/pages/guide/guide' });
    }
  } catch {
    // 读取失败不阻断首页
  }
}

onShow(() => {
  void load();
  void checkGuide();
});
</script>

<style>
/* 首页适老重排（册子 §3.2 A+B 融合）：字号全部引用全局字阶令牌（#84） */
.page { padding-bottom: 32px; }
.hero { padding: 16px 16px 0; }
.hero-title { font-size: var(--fs-title); font-weight: 600; }
/* 公告条（#84 §4.4）：标签 fs-annotate + 正文 fs-body，整条点击目标 ≥48px，空隐藏 */
.notice-bar { margin: 12px 16px 0; background: #fffbeb; border: 1px solid #f6e05e; border-radius: 12px; overflow: hidden; }
.notice-swiper { height: 48px; }
.notice-item { display: flex; align-items: center; gap: 8px; height: 48px; padding: 0 12px; box-sizing: border-box; }
.notice-tag { flex-shrink: 0; font-size: var(--fs-annotate); color: #b7791f; background: #fefcbf; border: 1px solid #f6e05e; border-radius: 8px; padding: 2px 8px; }
.notice-text { flex: 1; font-size: var(--fs-body); color: #744210; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.search { height: 48px; border-radius: 24px; background: #fff; border: 1px solid #d9e1ea; padding: 0 20px; font-size: var(--fs-body); margin: 12px 16px; }
/* 宫格区（#84 Task 3）：每行 3 大图标网格，格高 ≥96px（适老大点击区），字号全引令牌 */
.grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; padding: 0 12px; }
.cell { box-sizing: border-box; min-height: 96px; padding: 8px 4px; background: #fff; border: 1px solid #d9e1ea; border-radius: 12px; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px; }
.cell:active { background: #f7fafc; }
.cell-ico { font-size: var(--fs-title); }
.cell-tx { font-size: var(--fs-title); text-align: center; }
/* 过滤态清除行（#84 Task 3）：fs-annotate 小字，整行点击目标 ≥48px */
.filter-clear { display: block; font-size: var(--fs-annotate); color: #2b6cb0; padding: 0 16px; min-height: 48px; line-height: 48px; }
.feed-head { font-size: var(--fs-title); font-weight: 600; display: block; padding: 16px 16px 8px; }
.card { background: #fff; border: 1px solid #d9e1ea; border-radius: 12px; padding: 16px; margin: 8px 16px; min-height: 48px; display: flex; flex-direction: column; gap: 6px; }
.card:active { background: #f7fafc; }
.card-title { font-size: var(--fs-body); font-weight: 500; }
.card-meta { font-size: var(--fs-annotate); color: #64748b; }
.feed-hint { display: block; font-size: var(--fs-annotate); color: #64748b; padding: 8px 16px; }
.feed-error { display: block; font-size: var(--fs-annotate); color: #c53030; padding: 8px 16px; }
.list-head { display: block; font-size: var(--fs-title); font-weight: 600; padding: 16px 16px 8px; }
/* Discuz 平铺行（#84 Task 4）：课程/文章/圈子三区共用，标题 fs-body + 角标/meta fs-annotate，点击目标 ≥48px */
.flat-row { display: flex; flex-direction: column; gap: 4px; background: #fff; border-bottom: 1px solid #edf2f7; padding: 12px 16px; min-height: 48px; box-sizing: border-box; }
.flat-row:active { background: #f7fafc; }
.flat-head { display: flex; align-items: center; gap: 8px; min-width: 0; }
.flat-title { flex: 1; font-size: var(--fs-body); font-weight: 500; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.flag { flex-shrink: 0; font-size: var(--fs-annotate); line-height: 30px; padding: 0 8px; border-radius: 6px; }
.flag-top { color: #c53030; background: #fed7d7; }
.flag-feat { color: #b7791f; background: #feebc8; }
.flag-rec { color: #2b6cb0; background: #ebf8ff; }
.flat-meta { font-size: var(--fs-annotate); color: #64748b; }
</style>
