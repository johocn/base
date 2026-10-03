<template>
  <view class="wrap">
    <text v-if="error" class="error">{{ error }}</text>
    <block v-else>
      <text v-if="!loaded" class="hint">加载中…</text>
      <block v-else>
        <!-- Discuz 仿效方案 C：面包屑 -->
        <view v-if="courseTitle" class="breadcrumb">
          <text class="bc-item">{{ courseTitle }}</text>
          <text class="bc-sep">›</text>
          <text class="bc-cur">第 {{ lessonPosition?.cur ?? '?' }} 讲</text>
        </view>
        <image v-if="coverPath" :src="coverPath" mode="widthFix" class="cover" />
        <text class="title" :class="titleColor ? 'c-' + titleColor : ''">{{ lessonLabel }}</text>
        <!-- Discuz 仿效方案 C：课时位置序号点 -->
        <view v-if="lessonPosition && lessonPosition.total > 1" class="lesson-dots">
          <view
            v-for="i in lessonPosition.total"
            :key="i"
            class="lesson-dot"
            :class="{ done: i < lessonPosition.cur, cur: i === lessonPosition.cur }"
          ></view>
        </view>
        <!-- Discuz 仿效方案 C：课程进度条 -->
        <view v-if="lessonPosition" class="course-progress">
          <text class="cp-label">课程进度 {{ lessonPosition.cur }}/{{ lessonPosition.total }}</text>
          <view class="cp-track">
            <view class="cp-fill" :style="`width:${Math.round((lessonPosition.cur / lessonPosition.total) * 100)}%`"></view>
          </view>
        </view>
        <view v-if="badge.length > 0" class="chips">
          <text v-for="b in badge" :key="b" class="badge">{{ b }}</text>
        </view>
        <!-- Discuz 仿效方案 C：作者栏 -->
        <view v-if="authorDisplay.name" class="author-bar">
          <view class="author-avatar" :style="`background:hsl(${authorDisplay.hue} 65% 55%)`">{{ authorDisplay.name.slice(0, 1) }}</view>
          <view class="author-info">
            <text class="author-name">{{ authorDisplay.name }}<text v-if="authorDisplay.count > 0" class="author-count">（贡献 {{ authorDisplay.count }} 条）</text></text>
          </view>
        </view>
        <text v-if="instructor !== ''" class="meta">讲师 {{ instructorDisplay }}<text v-if="instructorPending" class="term-badge">待票选</text></text>
        <text v-if="metaLine !== ''" class="meta">{{ metaLine }}</text>
        <view class="tags">
          <text v-for="t in tagChips(selfTags).chips" :key="t.tagId" class="tag" @click="openTag(t.tagId)">{{ t.label }}<text v-if="t.pending" class="term-badge">待票选</text></text>
          <text v-if="tagChips(selfTags).overflow > 0" class="tag-more">+{{ tagChips(selfTags).overflow }}</text>
          <text v-if="pendingOf(lessonId)" class="tag-pending" @click="applyTag">待补标签 · 补标签</text>
          <text v-else-if="selfTags.length > 0" class="tag-note" @click="proposeTag">已有标签，改动需提案</text>
        </view>
        <text v-if="canEdit" class="act" @click="openEdit">编辑本课时</text>

        <!-- 正文：缺失整块不渲染（老包无 attr.body_md），不显示空块 -->
        <block v-if="bodyHtml !== ''">
          <text class="group">正文</text>
          <rich-text :nodes="bodyHtml" class="body" />
        </block>

        <text class="group">载体（{{ carriers.length }}）</text>
        <text v-if="carriers.length === 0" class="hint">这个课时还没有载体</text>
        <view v-for="c in carriers" :key="c.itemId" class="carrier" @click="openCarrier(c)">
          <text class="carrier-title">{{ c.title }}</text>
          <text class="meta">{{ c.type }} · {{ c.itemId }}</text>
        </view>

        <block v-if="attachments.length > 0">
          <text class="group">附件（{{ attachments.length }}）</text>
          <view v-for="a in attachments" :key="a.blobId" class="attach" @click="openAttachment(a)">
            <text class="carrier-title">{{ a.name }}</text>
          </view>
        </block>

        <!-- Discuz 仿效方案 C：讨论入口（跳 comment tabBar 页） -->
        <view class="discussion-entry" @click="openDiscussion">
          <text class="discussion-icon">💬</text>
          <view class="discussion-text">
            <text class="discussion-title">参与讨论</text>
            <text class="discussion-sub">在社区里和大家一起聊这讲的内容</text>
          </view>
          <text class="discussion-arrow">›</text>
        </view>

        <!-- Discuz 仿效方案 C：同课程其他讲（相关推荐） -->
        <block v-if="relatedLessons.length > 0">
          <text class="group">同课程其他讲</text>
          <view v-for="ls in relatedLessons" :key="ls.itemId" class="related-item" @click="openLesson(ls.itemId)">
            <text class="related-no">{{ ls.no > 0 ? `第 ${ls.no} 讲` : '讲' }}</text>
            <text class="related-title">{{ ls.title }}</text>
          </view>
        </block>

        <!-- Discuz 仿效方案 C：上下讲导航 -->
        <view v-if="prevLesson || nextLesson" class="nav-arrows">
          <view v-if="prevLesson" class="nav-arrow" @click="openLesson(prevLesson.itemId)">
            <text class="nav-label">← 上一讲</text>
            <text class="nav-sub">{{ prevLesson.no > 0 ? `第 ${prevLesson.no} 讲` : '' }} · {{ prevLesson.title }}</text>
          </view>
          <view v-if="nextLesson" class="nav-arrow" @click="openLesson(nextLesson.itemId)">
            <text class="nav-label">下一讲 →</text>
            <text class="nav-sub">{{ nextLesson.no > 0 ? `第 ${nextLesson.no} 讲` : '' }} · {{ nextLesson.title }}</text>
          </view>
        </view>
      </block>
    </block>
  </view>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import { onLoad } from '@dcloudio/uni-app';

import { fetchBlob } from '../../core/blob';
import { attrsOf, childrenRowsOf, type AttachmentVM } from '../../core/container-view';
import { childrenOf, lessonNo } from '../../core/course-tree';
import { displayOf, loadDirectory, normalizeTermKey, termState, type DirectorySnapshot } from '../../core/directory';
import { renderMarkdown } from '../../core/markdown';
import { canGovern, decodeTagPath, tagTitle, tagsOf, untaggedTargets } from '../../core/tags';
import { containerFormFromLedger } from '../../core/my-created';
import type { TagLinkRow } from '../../core/types';
import { useAuthorBar } from '../../core/useAuthorBar';
import { bootstrap } from '../../platform';

interface CarrierVM {
  itemId: string;
  type: string;
  title: string;
}

const lessonId = ref('');
const courseId = ref('');
const lessonLabel = ref('');
const instructor = ref('');
const metaLine = ref('');
/** 目录快照（三态判定用）：进入页面时读本地缓存，模板只读 */
const directory = ref<DirectorySnapshot>({ version: 0, approved: new Map(), pending: new Map() });
const bodyHtml = ref('');
const carriers = ref<CarrierVM[]>([]);
const attachments = ref<AttachmentVM[]>([]);
const coverPath = ref('');
const selfTags = ref<TagLinkRow[]>([]);
const tagTitles = ref<Record<string, string>>({});
const untagged = ref<Set<string>>(new Set());
const governor = ref(false);
const loaded = ref(false);
const canEdit = ref(false);
const error = ref('');
// 图章与标题色（册子 #53 §2.5）：仅正常（包表）分支派生；台账分支保持 F7 裁剪口径，不渲染
const badge = ref<string[]>([]);
const titleColor = ref('');

// —— Discuz 仿效 方案 C ——
const { authorId, authorDisplay, avatarHue, fetchAuthorBar, setAuthorId } = useAuthorBar();
/** 面包屑：课程标题（courseId → repo.getItem）；空表示没拿到（courseId 缺失或课程不存在） */
const courseTitle = ref('');
/** 课时位置：{ cur, total }；courseId 空或算不出 → null（模板不渲染序号点+进度条） */
const lessonPosition = ref<{ cur: number; total: number } | null>(null);
/** 上下讲导航：null 表示没拿到 */
const prevLesson = ref<{ itemId: string; title: string; no: number } | null>(null);
const nextLesson = ref<{ itemId: string; title: string; no: number } | null>(null);
/** 同课程其他讲（排除当前）；空数组 → 相关推荐块不渲染 */
const relatedLessons = ref<{ itemId: string; title: string; no: number }[]>([]);

onLoad(async (query) => {
  const q = (query as Record<string, string> | undefined) ?? {};
  const raw = String(q.lessonId ?? '');
  const cid = String(q.courseId ?? '');
  lessonId.value = raw;
  try {
    const { opts, repo } = await bootstrap();
    directory.value = await loadDirectory(repo);
    // from=ledger：从「我创建的」区进入 → 只用台账行集渲染，不读包表（册子 #51 §3.3）。
    if (q.from === 'ledger') {
      const sub = await repo.getSubmission(wait(raw));
      if (!sub) {
        error.value = '本地没有这个课时，请返回先同步';
        return;
      }
      const form = containerFormFromLedger(sub);
      lessonId.value = form.itemId;
      const mid = form.itemId.indexOf('/lesson/');
      courseId.value = cid !== '' ? cid : mid > 0 ? form.itemId.slice(0, mid) : '';
      lessonLabel.value = form.title || form.itemId;
      instructor.value = form.instructor;
      const meta: string[] = [];
      if (form.difficulty !== '') meta.push(`难度 ${difficultyLabel(form.difficulty)}`);
      if (form.durationSec > 0) meta.push(`约 ${Math.round(form.durationSec / 60)} 分钟`);
      metaLine.value = meta.join(' · ');
      bodyHtml.value = renderMarkdown(form.bodyMd);
      // children 行标题回落 itemId（台账行集不含子项标题，与既有「本地未同步」回落同口径）
      carriers.value = form.children.map((c) => ({ itemId: c.itemId, type: c.kind, title: c.itemId }));
      attachments.value = form.attachments;
      canEdit.value = sub.state === 'sent';
      loaded.value = true;
      return;
    }
    const lid = wait(raw);
    const row = await repo.getItem(lid);
    const segs = await repo.listSegments(lid);
    const attrs = attrsOf(segs);
    badge.value = attrs.badge;
    titleColor.value = attrs.titleColor;

    // 课程 id：优先取传参；没有就从 `course/<cid>/lesson/<lid>` 剥出来（保证课时页条目自洽）
    const mid = lid.indexOf('/lesson/');
    courseId.value = cid !== '' ? cid : mid > 0 ? lid.slice(0, mid) : '';

    // 「第 N 讲」口径与课程页同源：拿课程清单算出位次（拿不到课程就不显示位次）
    let no = 0;
    let lessonIds: string[] = [];
    if (courseId.value !== '') {
      try {
        const courseSegs = await repo.listSegments(courseId.value);
        lessonIds = childrenOf(courseSegs);
        no = lessonNo(courseSegs, lid);
        // —— Discuz 仿效：复用同一次 courseSegs 派生所有位置/导航数据（Advisor 提醒避免不一致）——
        const courseItem = await repo.getItem(courseId.value);
        courseTitle.value = courseItem?.title ?? '';
        if (lessonIds.length > 0 && no > 0) {
          lessonPosition.value = { cur: no, total: lessonIds.length };
          const curIdx = lessonIds.indexOf(lid);
          if (curIdx > 0) {
            const prevId = lessonIds[curIdx - 1]!;
            const prevItem = await repo.getItem(prevId);
            prevLesson.value = { itemId: prevId, title: prevItem?.title ?? prevId, no: no - 1 };
          }
          if (curIdx >= 0 && curIdx < lessonIds.length - 1) {
            const nextId = lessonIds[curIdx + 1]!;
            const nextItem = await repo.getItem(nextId);
            nextLesson.value = { itemId: nextId, title: nextItem?.title ?? nextId, no: no + 1 };
          }
          // 同课程相关推荐：排除当前，取前 5（保持清单位次，不做排序）
          const others = lessonIds.filter((id) => id !== lid);
          const related: { itemId: string; title: string; no: number }[] = [];
          for (const id of others.slice(0, 5)) {
            const it = await repo.getItem(id);
            const pos = lessonNo(courseSegs, id);
            related.push({ itemId: id, title: it?.title ?? id, no: pos || 0 });
          }
          relatedLessons.value = related;
        }
      } catch {
        no = 0;
      }
    }

    // 作者栏：composable 内部处理全降级链
    if (row?.authorId && opts.nodeBaseUrl) {
      setAuthorId(row.authorId);
      void fetchAuthorBar({ adapters: opts.adapters, repo, nodeBaseUrl: opts.nodeBaseUrl });
    }
    const title = row?.title || lid;
    lessonLabel.value = no > 0 ? `第 ${no} 讲 · ${title}` : title;

    instructor.value = attrs.instructor;
    const meta: string[] = [];
    if (attrs.difficulty !== '') meta.push(`难度 ${difficultyLabel(attrs.difficulty)}`);
    if (attrs.duration > 0) meta.push(`约 ${Math.round(attrs.duration / 60)} 分钟`);
    metaLine.value = meta.join(' · ');

    bodyHtml.value = renderMarkdown(attrs.bodyMd);

    const rows = childrenRowsOf(segs);
    const built: CarrierVM[] = [];
    for (const r of rows) {
      const c = await repo.getItem(r.text);
      built.push({ itemId: r.text, type: c?.type || r.kind, title: c?.title || r.text });
    }
    carriers.value = built;
    attachments.value = attrs.attachments;

    const path = await repo.findBlobPathByItem(`${lid}/cover`);
    coverPath.value = path ? (path.startsWith('file://') ? path : `file://${path}`) : '';

    const links = await repo.listTagLinks();
    const all = await repo.listItems();
    untagged.value = new Set(untaggedTargets(all, links));
    tagTitles.value = Object.fromEntries(all.filter((i) => i.type === 'tag').map((i) => [i.itemId, i.title || i.itemId]));
    selfTags.value = tagsOf(links, lid);
    governor.value = await canGovern({ adapters: opts.adapters, repo, nodeBaseUrl: opts.nodeBaseUrl });
    // 编辑入口的可见性：包内 items 不含 author_id，用本地台账代理（state='sent' 才算「我建的」）
    canEdit.value = (await repo.getSubmission(lid))?.state === 'sent';
    loaded.value = true;
  } catch (e) {
    error.value = (e as Error).message;
  }
});

/** 个别机型会把 id 的百分号编码原样带过来 */
function wait(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

function difficultyLabel(d: string): string {
  return d === 'intro' ? '入门' : d === 'basic' ? '基础' : d === 'advanced' ? '进阶' : d;
}

/** 原文 → 词条键；非法/空归空串（按 empty 态处理） */
function termKeyOf(raw: string): string {
  return normalizeTermKey(raw) ?? '';
}

const instructorDisplay = computed(() => {
  const key = termKeyOf(instructor.value);
  return key === '' ? instructor.value : displayOf(directory.value, 'instructor', key);
});
const instructorPending = computed(() => {
  const key = termKeyOf(instructor.value);
  return key !== '' && termState(directory.value, 'instructor', key) === 'pending';
});

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

function pendingOf(id: string): boolean {
  return governor.value && untagged.value.has(id);
}

function openTag(tagId: string) {
  uni.navigateTo({ url: `/pages/tag/detail?tagId=${encodeURIComponent(tagId)}` });
}

function applyTag() {
  uni.navigateTo({ url: `/pages/tag/apply?target=${encodeURIComponent(lessonId.value)}&kind=lesson` });
}

function proposeTag() {
  uni.navigateTo({ url: `/pages/governance/governance?itemId=${encodeURIComponent(selfTags.value[0]!.tagId)}` });
}

function openEdit() {
  uni.navigateTo({
    url: `/pages/lesson/edit?courseId=${encodeURIComponent(courseId.value)}&lessonId=${encodeURIComponent(lessonId.value)}`,
  });
}

function openCarrier(c: CarrierVM) {
  if (c.type === 'article') {
    uni.navigateTo({ url: `/pages/article/article?itemId=${encodeURIComponent(c.itemId)}` });
    return;
  }
  if (c.type === 'quiz') {
    uni.navigateTo({ url: `/pages/quiz/quiz?itemId=${encodeURIComponent(c.itemId)}` });
    return;
  }
  if (c.type === 'video' || c.type === 'audio') {
    uni.showToast({ title: `${c.type} 播放待后续版本`, icon: 'none' });
    return;
  }
  uni.showToast({ title: '暂不支持的类型', icon: 'none' });
}

/** Discuz 仿效：上下讲/相关推荐点击 → 跳课时详情 */
function openLesson(itemId: string) {
  uni.navigateTo({ url: `/pages/lesson/detail?lessonId=${encodeURIComponent(itemId)}&courseId=${encodeURIComponent(courseId.value)}` });
}

/** Discuz 仿效：讨论入口 → 跳 comment tabBar 页 */
function openDiscussion() {
  uni.switchTab({ url: '/pages/comment/comment' });
}

/** 附件按需取回：下载字节 → 落本地文件 → 交给系统打开 */
async function openAttachment(a: AttachmentVM) {
  error.value = '';
  try {
    const { opts, repo } = await bootstrap();
    const bytes = await fetchBlob({ adapters: opts.adapters, repo, nodeBaseUrl: opts.nodeBaseUrl }, a.blobId);
    const root = await opts.adapters.fs.rootDir();
    const path = `${root}/${a.blobId}-${a.name}`;
    await opts.adapters.fs.writeFile(path, bytes);
    uni.openDocument({
      filePath: path,
      showMenu: true,
      fail: () => uni.showToast({ title: '系统不支持打开该类型', icon: 'none' }),
    });
  } catch (e) {
    error.value = (e as Error).message;
  }
}
</script>

<style>
.wrap { padding: 16px; }
.title { display: block; font-size: 20px; font-weight: 600; margin-bottom: 4px; }
.meta { display: block; color: #888888; font-size: 12px; }
.cover { width: 100%; margin-bottom: 12px; border-radius: 6px; }
.body { display: block; font-size: 15px; line-height: 1.7; margin-bottom: 10px; }

/* 正文变色：7 个枚举类（#44 §6）。c-mark 只改背景、不覆盖字色 */
.c-red { color: #C53030; }
.c-orange { color: #B7791F; }
.c-green { color: #2F855A; }
.c-blue { color: #2B6CB0; }
.c-purple { color: #6B46C1; }
.c-gray { color: #718096; }
.c-mark { background: #FFF3BF; }
.carrier { padding: 10px 0; border-bottom: 1px solid #f2f2f2; }
.carrier-title { color: #2b6cb0; font-size: 15px; }
.attach { padding: 8px 0; }
.hint { color: #888888; }
.error { color: #c53030; font-size: 13px; }
.group { display: block; margin: 18px 0 6px; color: #888888; font-size: 13px; }
.act { display: block; color: #2b6cb0; font-size: 14px; padding: 6px 0; }
.tags { display: flex; flex-wrap: wrap; align-items: center; margin: 6px 0 10px; }
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

/* —— Discuz 仿效方案 C 样式 —— */
.breadcrumb {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 16px 4px;
  font-size: 12px;
  color: #718096;
}
.breadcrumb .bc-item { color: #2b6cb0; }
.breadcrumb .bc-sep { color: #a0aec0; }
.breadcrumb .bc-cur { color: #2d3748; font-weight: 500; }
.dark .breadcrumb { color: #a0aec0; }
.dark .breadcrumb .bc-item { color: #63b3ed; }
.dark .breadcrumb .bc-cur { color: #e2e8f0; }

/* 课时位置序号点 */
.lesson-dots {
  display: flex;
  justify-content: center;
  gap: 5px;
  padding: 6px 24px 4px;
}
.lesson-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #e2e8f0;
  transition: all .2s;
}
.lesson-dot.done { background: #48bb78; }
.lesson-dot.cur { background: #2b6cb0; width: 16px; border-radius: 3px; }
.dark .lesson-dot { background: #4a5568; }
.dark .lesson-dot.done { background: #38a169; }
.dark .lesson-dot.cur { background: #63b3ed; }

/* 课程进度条 */
.course-progress {
  padding: 0 16px 10px;
}
.cp-label {
  font-size: 11px;
  color: #718096;
  margin-bottom: 4px;
  display: block;
}
.cp-track {
  height: 4px;
  background: #edf2f7;
  border-radius: 2px;
  overflow: hidden;
}
.cp-fill {
  height: 100%;
  background: linear-gradient(90deg, #63b3ed, #2b6cb0);
  border-radius: 2px;
  transition: width .3s;
}
.dark .cp-label { color: #a0aec0; }
.dark .cp-track { background: #2d3748; }
.dark .cp-fill { background: linear-gradient(90deg, #4299e1, #3182ce); }

/* 作者栏 */
.author-bar {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 16px;
  margin: 6px 16px 0;
  background: #f7fafc;
  border-radius: 8px;
}
.author-avatar {
  width: 28px;
  height: 28px;
  border-radius: 50%;
  color: #fff;
  font-size: 13px;
  font-weight: 600;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}
.author-info { flex: 1; min-width: 0; }
.author-name {
  font-size: 13px;
  font-weight: 500;
  color: #2d3748;
}
.author-count { font-size: 11px; color: #718096; font-weight: 400; }
.dark .author-bar { background: #1a202c; }
.dark .author-name { color: #e2e8f0; }
.dark .author-count { color: #a0aec0; }

/* 讨论入口 */
.discussion-entry {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 16px;
  margin: 14px 16px 0;
  background: #fffaf0;
  border-radius: 8px;
}
.discussion-icon {
  font-size: 18px;
  width: 32px;
  height: 32px;
  background: #fbd38d;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}
.discussion-text { flex: 1; min-width: 0; }
.discussion-title {
  font-size: 13px;
  font-weight: 500;
  color: #b7791f;
  display: block;
}
.discussion-sub {
  font-size: 11px;
  color: #975a16;
  margin-top: 2px;
  display: block;
}
.discussion-arrow {
  color: #b7791f;
  font-size: 18px;
  flex-shrink: 0;
}
.dark .discussion-entry { background: #2d2518; }
.dark .discussion-icon { background: #7b5818; }
.dark .discussion-title { color: #f6ad55; }
.dark .discussion-sub { color: #e9a94b; }
.dark .discussion-arrow { color: #f6ad55; }

/* 同课程相关推荐 */
.related-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 16px;
  border-bottom: 1px solid #edf2f7;
}
.related-no {
  font-size: 11px;
  color: #718096;
  background: #edf2f7;
  padding: 2px 6px;
  border-radius: 4px;
  flex-shrink: 0;
}
.related-title {
  font-size: 13px;
  color: #2b6cb0;
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dark .related-item { border-bottom-color: #2d3748; }
.dark .related-no { background: #2d3748; color: #a0aec0; }
.dark .related-title { color: #63b3ed; }

/* 上下讲导航 */
.nav-arrows {
  display: flex;
  padding: 14px 16px 20px;
  gap: 10px;
}
.nav-arrow {
  flex: 1;
  padding: 12px;
  border: 1px solid #e2e8f0;
  border-radius: 8px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.nav-label {
  font-size: 11px;
  color: #a0aec0;
}
.nav-sub {
  font-size: 12px;
  color: #2d3748;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dark .nav-arrow { border-color: #4a5568; }
.dark .nav-label { color: #718096; }
.dark .nav-sub { color: #e2e8f0; }
</style>