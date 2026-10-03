<template>
  <view class="wrap">
    <text v-if="error" class="error">{{ error }}</text>
    <block v-else>
      <text v-if="!loaded" class="hint">加载中…</text>
      <block v-else>
        <image v-if="coverPath" :src="coverPath" mode="widthFix" class="cover" />
      <text class="title">{{ courseTitle }}</text>
      <text v-if="digest !== ''" class="digest">{{ digest }}</text>
      <!-- ① Discuz 仿效：作者栏 -->
      <view v-if="authorDisplay.name" class="author-bar">
        <view class="author-avatar" :style="`background:hsl(${authorDisplay.hue} 65% 55%)`">{{ authorDisplay.name.slice(0, 1) }}</view>
        <view class="author-info">
          <text class="author-name">{{ authorDisplay.name }}<text v-if="authorDisplay.count > 0" class="author-count">（贡献 {{ authorDisplay.count }} 条）</text></text>
          <text class="author-sub">发布人</text>
        </view>
      </view>
      <!-- ② Discuz 仿效：课程整体学习进度 -->
      <view v-if="completion" class="progress-bar">
        <view class="progress-head">
          <text class="progress-label">📈 学习进度</text>
          <text class="progress-pct" :class="{ done: completion.done === completion.total }">{{ completion.done }} / {{ completion.total }} 讲 · {{ Math.round((completion.done / completion.total) * 100) }}%</text>
        </view>
        <view class="progress-track">
          <view class="progress-fill" :class="{ done: completion.done === completion.total }" :style="`width:${Math.round((completion.done / completion.total) * 100)}%`"></view>
        </view>
      </view>
        <text v-if="instructor !== ''" class="meta">讲师 {{ instructorDisplay }}<text v-if="instructorPending" class="term-badge">待票选</text></text>
        <text v-if="metaLine !== ''" class="meta">{{ metaLine }}</text>
        <view class="tags">
          <text v-for="t in tagChips(courseTags).chips" :key="t.tagId" class="tag" @click="openTag(t.tagId)">{{ t.label }}<text v-if="t.pending" class="term-badge">待票选</text></text>
          <text v-if="tagChips(courseTags).overflow > 0" class="tag-more">+{{ tagChips(courseTags).overflow }}</text>
          <text v-if="pendingOf(courseId)" class="tag-pending" @click="applyTag(courseId, 'course')">待补标签 · 补标签</text>
          <text v-else-if="courseTags.length > 0" class="tag-note" @click="proposeTag(courseTags[0]!.tagId)">已有标签，改动需提案</text>
        </view>
        <text v-if="canEdit" class="act" @click="openEdit">编辑本课程</text>
        <text v-if="fromLedger && actions.retry" class="act" @click="retrySubmit">{{ busy ? '重试中…' : '重试提交' }}</text>
        <text v-if="fromLedger && actions.rebuild" class="act" @click="rebuildCourse">复建为新课程</text>
        <text v-if="fromLedger && actions.removeLocal" class="act danger" @click="removeLocal">{{ busy ? '删除中…' : '删除这条记录' }}</text>
        <text v-if="canProposeRemove" class="act danger" @click="removeCourse">{{ busy ? '删除中…' : '删除本课程' }}</text>

        <block v-if="attachments.length > 0">
          <text class="group">附件（{{ attachments.length }}）</text>
          <view v-for="a in attachments" :key="a.blobId" class="attach" @click="openAttachment(a)">
            <text class="attach-name">{{ a.name }}</text>
          </view>
        </block>

        <text class="group">课时（{{ lessons.length }}）</text>
        <text v-if="lessons.length === 0" class="hint">这门课程还没有课时</text>
        <view v-for="ls in lessons" :key="ls.itemId" class="lesson" :class="{ done: lessonDoneMap.get(ls.itemId) }" @click="openLesson(ls)">
          <view class="lesson-no" :class="{ done: lessonDoneMap.get(ls.itemId) }">
            {{ lessonDoneMap.get(ls.itemId) ? '✓' : ls.no }}
          </view>
          <view class="lesson-main">
            <text class="lesson-title">第 {{ ls.no }} 讲 · {{ ls.title }}</text>
            <text class="meta">{{ ls.sub }}</text>
            <view class="tags">
              <text v-for="t in tagChips(ls.tags).chips" :key="t.tagId" class="tag" @click.stop="openTag(t.tagId)">{{ t.label }}<text v-if="t.pending" class="term-badge">待票选</text></text>
              <text v-if="tagChips(ls.tags).overflow > 0" class="tag-more">+{{ tagChips(ls.tags).overflow }}</text>
              <text v-if="pendingOf(ls.itemId)" class="tag-pending" @click.stop="applyTag(ls.itemId, 'lesson')">待补标签 · 补标签</text>
            </view>
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
import { attrsOf, childrenRowsOf, digestOf, type AttachmentVM } from '../../core/container-view';
import { displayOf, loadDirectory, normalizeTermKey, termState, type DirectorySnapshot } from '../../core/directory';
import { canGovern, decodeTagPath, tagTitle, tagsOf, untaggedTargets } from '../../core/tags';
import { buildLessonList, type LessonVM } from '../../core/lesson-list';
import { containerFormFromLedger, ledgerActionsOf, type LedgerActions } from '../../core/my-created';
import type { TagLinkRow } from '../../core/types';
import type { ContributorItem } from '../../core/contribution';
import { roster } from '../../core/contribution';
import { decodeUtf8 } from '../../core/sync';
import { createProposal, GovernError, listProposals } from '../../core/govern';
import { bootstrap } from '../../platform';
import { retrySubmission, SubmitError } from '../../core/submit';

const courseId = ref('');
const courseTitle = ref('');
const digest = ref('');
const instructor = ref('');
const metaLine = ref('');
/** 目录快照（三态判定用）：进入页面时读本地缓存，模板只读 */
const directory = ref<DirectorySnapshot>({ version: 0, approved: new Map(), pending: new Map() });
const coverPath = ref('');
const attachments = ref<AttachmentVM[]>([]);
const lessons = ref<LessonVM[]>([]);
const courseTags = ref<TagLinkRow[]>([]);
const tagTitles = ref<Record<string, string>>({});
const untagged = ref<Set<string>>(new Set());
const governor = ref(false);
const loaded = ref(false);
const busy = ref(false);
const canEdit = ref(false);
/** 「删除本课程」（既有 `remove` 提案）是否出现；台账分支按矩阵、普通入口随 `canEdit` */
const canProposeRemove = ref(false);
/** 台账入口标记：仅该分支启用出路矩阵动作 */
const fromLedger = ref(false);
/** 台账行出路矩阵（册子 #61 §4.2）：纯函数算，模板只消费 */
const actions = ref<LedgerActions>({ edit: false, retry: false, removeLocal: false, rebuild: false, proposeRemove: false });
const error = ref('');

// —— Discuz 仿效：作者栏 + 课程进度 + 课时完成度 ——
const authorId = ref('');
/** 贡献前 10 名册，authorId → ContributorItem 映射；空 Map 表示 fetch 失败或未拉 */
const rosterMap = ref(new Map<string, ContributorItem>());
/** 单条 profile API 缓存，authorId → 昵称；miss 或失败就不写 */
const profileNameCache = ref(new Map<string, string>());
/** 课程整体完成度：{done, total}；total=0 不入 Map → 模板不渲染进度条 */
const completion = ref<{ done: number; total: number } | null>(null);
/** 每个课时是否完成：lessonId → true；未完成或无数据不入 Map */
const lessonDoneMap = ref(new Map<string, boolean>());

onLoad(async (query) => {
  const q = (query as Record<string, string> | undefined) ?? {};
  const raw = String(q.courseId ?? '');
  try {
    const { opts, repo } = await bootstrap();
    directory.value = await loadDirectory(repo);
    // from=ledger：从「我创建的」区进入 → 只用台账行集渲染，不读包表（册子 #51 §3.3）。
    if (q.from === 'ledger') {
      const row = await resolveBy(raw, (id) => repo.getSubmission(id));
      if (!row) {
        error.value = '本地没有这门课程，请返回先同步';
        return;
      }
      const form = containerFormFromLedger(row);
      courseId.value = form.itemId;
      courseTitle.value = form.title || form.itemId;
      digest.value = form.digest;
      instructor.value = form.instructor;
      const meta: string[] = [];
      if (form.difficulty !== '') meta.push(`难度 ${difficultyLabel(form.difficulty)}`);
      if (form.durationSec > 0) meta.push(`共约 ${Math.round(form.durationSec / 60)} 分钟`);
      metaLine.value = meta.join(' · ');
      attachments.value = form.attachments;
      // 台账行集不含子项标题，但本地 items 表里有（#56 乐观落库 / #63 存量自愈都会写）⇒ 按 id 补取。
      // 序号取入参次序（台账入口没有课程行集）；tags 恒空（该入口不加载 tag_links）。
      lessons.value = await buildLessonList(
        repo,
        form.children.map((c) => c.itemId),
        { courseSegs: null, links: [] },
      );
      // 台账入口：author 信息在 ledger row 里没有完整映射，先跳过 author-bar（v-if 挡掉）
      // 但进度统计能算——lessons itemIds + repo.listSegments 拿叶子载体 + progress 表
      if (form.children.length > 0) {
        const all = await repo.listItems();
        const allMap = new Map(all.map((i) => [i.itemId, i]));
        const progressRows = await repo.listProgress();
        const progressMap = new Map(progressRows.map((r) => [r.itemId, r.done === true]));
        let doneTotal = 0; let totalLessons = 0;
        const lessonDone = new Map<string, boolean>();
        for (const ls of lessons.value) {
          const leafDone: boolean[] = [];
          for (const leafSeg of await repo.listSegments(ls.itemId)) {
            if (leafSeg.kind !== 'lesson-link') continue;
            const leafId = leafSeg.text;
            const leaf = allMap.get(leafId);
            if (!leaf) continue;
            if (leaf.type !== 'article' && leaf.type !== 'video' && leaf.type !== 'quiz') continue;
            leafDone.push(progressMap.get(leafId) === true);
          }
          if (leafDone.length === 0) continue;
          totalLessons += 1;
          const isDone = lessonCompleted(leafDone);
          if (isDone) { doneTotal += 1; lessonDone.set(ls.itemId, true); }
        }
        if (totalLessons > 0) completion.value = { done: doneTotal, total: totalLessons };
        lessonDoneMap.value = lessonDone;
      }
      fromLedger.value = true;
      actions.value = ledgerActionsOf(form.type, row.itemId, row.state, row.localOnly);
      canEdit.value = actions.value.edit;
      canProposeRemove.value = actions.value.proposeRemove;
      loaded.value = true;
      return;
    }
    const course = await resolveBy(raw, (id) => repo.getItem(id));
    if (!course) {
      error.value = '本地没有这门课程，请返回先同步';
      return;
    }
    courseId.value = course.itemId;
    courseTitle.value = course.title || course.itemId;

    const segs = await repo.listSegments(course.itemId);
    const attrs = attrsOf(segs);
    digest.value = digestOf(segs);
    attachments.value = attrs.attachments;

    instructor.value = attrs.instructor;
    const meta: string[] = [];
    if (attrs.difficulty !== '') meta.push(`难度 ${difficultyLabel(attrs.difficulty)}`);
    if (attrs.duration > 0) meta.push(`共约 ${Math.round(attrs.duration / 60)} 分钟`);
    metaLine.value = meta.join(' · ');

    const path = await repo.findBlobPathByItem(`${course.itemId}/cover`);
    coverPath.value = path ? (path.startsWith('file://') ? path : `file://${path}`) : '';

    // 作者栏：归属缓存 + 贡献名册 + profile API 三级降级（复用 article.vue 逻辑）
    authorId.value = course.authorId ?? '';
    if (authorId.value && opts.nodeBaseUrl) {
      try {
        const list = await roster({ adapters: opts.adapters, repo, nodeBaseUrl: opts.nodeBaseUrl });
        rosterMap.value = new Map(list.map((c) => [c.id, c]));
      } catch { /* 静默 */ }
      void resolveAuthorName(authorId.value, opts);
    }

    const rows = childrenRowsOf(segs);
    const links = await repo.listTagLinks();
    lessons.value = await buildLessonList(repo, rows.map((r) => r.text), { courseSegs: segs, links });

    // 课程整体完成度 + 每个课时的完成标记（与 course.vue 同口径：叶子载体多数决）
    const all = await repo.listItems();
    const allMap = new Map(all.map((i) => [i.itemId, i]));
    const progressRows = await repo.listProgress();
    const progressMap = new Map(progressRows.map((r) => [r.itemId, r.done === true]));
    let doneTotal = 0;
    let totalLessons = 0;
    const lessonDone = new Map<string, boolean>();
    for (const ls of lessons.value) {
      const leafDone: boolean[] = [];
      for (const leafSeg of await repo.listSegments(ls.itemId)) {
        if (leafSeg.kind !== 'lesson-link') continue;
        const leafId = leafSeg.text;
        const leaf = allMap.get(leafId);
        if (!leaf) continue;
        if (leaf.type !== 'article' && leaf.type !== 'video' && leaf.type !== 'quiz') continue;
        leafDone.push(progressMap.get(leafId) === true);
      }
      if (leafDone.length === 0) continue;
      totalLessons += 1;
      const isDone = lessonCompleted(leafDone);
      if (isDone) { doneTotal += 1; lessonDone.set(ls.itemId, true); }
    }
    if (totalLessons > 0) completion.value = { done: doneTotal, total: totalLessons };
    lessonDoneMap.value = lessonDone;

    untagged.value = new Set(untaggedTargets(all, links));
    tagTitles.value = Object.fromEntries(all.filter((i) => i.type === 'tag').map((i) => [i.itemId, i.title || i.itemId]));
    courseTags.value = tagsOf(links, course.itemId);
    governor.value = await canGovern({ adapters: opts.adapters, repo, nodeBaseUrl: opts.nodeBaseUrl });
    canEdit.value = (await repo.getSubmission(course.itemId))?.state === 'sent';
    canProposeRemove.value = canEdit.value;
    loaded.value = true;
  } catch (e) {
    error.value = (e as Error).message;
  }
});

function decodedId(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/**
 * 全页唯一的取键规则（册子 #56 §2.5）：先试原样 `raw`，再试解码态 `decodedId(raw)`。
 * 台账入口（`from=ledger`）与普通入口共用它，避免两处再分叉。
 */
async function resolveBy<T>(raw: string, get: (id: string) => Promise<T | null>): Promise<T | null> {
  const first = await get(raw);
  if (first !== null) return first;
  const cid = decodedId(raw);
  return cid === raw ? null : await get(cid);
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

/** 昵称三级降级链：名册命中 → profile API 命中 → id[:8] 回退（复用 article.vue 逻辑） */
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
/** 第三级降级：roster miss → 单条 profile API 补查；失败静默不阻塞 */
async function resolveAuthorName(aid: string, opts: { adapters: { http: { get: (u: string) => Promise<{ status: number; body: Uint8Array }> } }; nodeBaseUrl: string }) {
  if (!aid || rosterMap.value.has(aid) || profileNameCache.value.has(aid)) return;
  try {
    const res = await opts.adapters.http.get(`${opts.nodeBaseUrl}/v1/profile/${aid}`);
    if (res.status !== 200) return;
    const json = JSON.parse(decodeUtf8(res.body)) as { name?: string };
    if (json.name) profileNameCache.value.set(aid, json.name);
  } catch { /* 静默 */ }
}

/** 单个课时是否完成（课程整体进度的构成单元：叶子载体多数决） */
function lessonCompleted(leafDone: boolean[]): boolean {
  if (leafDone.length === 0) return false;
  return leafDone.filter(Boolean).length >= leafDone.length;
}

interface TagChip {
  tagId: string;
  label: string;
  pending: boolean;
}

/**
 * 标签 chip 视图（#58 §5.1/§5.3）：名称段走目录展示名，pending 加灰角标；
 * **单条目待票选词最多显示 3 个**，超出折叠为「+n」（只数待票选，已通过不受限）。
 */
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

function openLesson(ls: LessonVM) {
  uni.navigateTo({
    url: `/pages/lesson/detail?courseId=${encodeURIComponent(courseId.value)}&lessonId=${encodeURIComponent(ls.itemId)}`,
  });
}

function openEdit() {
  uni.navigateTo({ url: `/pages/course/edit?courseId=${encodeURIComponent(courseId.value)}` });
}

/**
 * 创建者删除本课程（本册 §5）：复用既有 `remove` 提案通道。
 * 节点侧若判为「无课时 / 无他人学习」，门槛降 0、立即 effective；否则回落到 3 票。
 */
async function removeCourse() {
  if (busy.value) return;
  busy.value = true;
  error.value = '';
  try {
    const { opts, repo } = await bootstrap();
    const { proposalId } = await createProposal(
      { adapters: opts.adapters, repo, nodeBaseUrl: opts.nodeBaseUrl },
      { action: 'remove', itemId: courseId.value, reason: '创建者删除' },
    );
    const fresh = (await listProposals({ adapters: opts.adapters, repo, nodeBaseUrl: opts.nodeBaseUrl })).find(
      (p) => p.proposalId === proposalId,
    );
    uni.showToast({ title: fresh?.status === 'effective' ? '已删除' : '已提交，需 3 票', icon: 'none' });
    setTimeout(() => uni.navigateBack(), 600);
  } catch (e) {
    error.value = e instanceof GovernError ? e.message : (e as Error).message;
  } finally {
    busy.value = false;
  }
}

/** 重投这一条（册子 #61 §4.3）：成功即离开本页（台账行已转 `sent`，列表会自动去重）。 */
async function retrySubmit() {
  if (busy.value) return;
  busy.value = true;
  error.value = '';
  try {
    const { opts } = await bootstrap();
    const out = await retrySubmission(opts, courseId.value);
    uni.showToast({ title: out.ledgerState === 'sent' ? '已提交' : out.message || '仍未成功', icon: 'none' });
    setTimeout(() => uni.navigateBack(), 600);
  } catch (e) {
    error.value = e instanceof SubmitError ? e.message : (e as Error).message;
  } finally {
    busy.value = false;
  }
}

/** 本地删除这一条（册子 #61 §4.3）：台账行 + 本机乐观条目一起清，否则课程列表里仍留着它。 */
async function removeLocal() {
  if (busy.value) return;
  busy.value = true;
  error.value = '';
  try {
    const { repo } = await bootstrap();
    await repo.removeSubmission(courseId.value);
    await repo.removeLocalContainer(courseId.value);
    uni.showToast({ title: '已删除', icon: 'success' });
    setTimeout(() => uni.navigateBack(), 600);
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    busy.value = false;
  }
}

/** 复建为新课程（册子 #61 §4.3）：内容照搬台账行、身份在编辑页重生成。 */
function rebuildCourse() {
  uni.navigateTo({ url: `/pages/course/edit?rebuildFrom=${encodeURIComponent(courseId.value)}` });
}

function openTag(tagId: string) {
  uni.navigateTo({ url: `/pages/tag/detail?tagId=${encodeURIComponent(tagId)}` });
}

function applyTag(targetId: string, kind: string) {
  uni.navigateTo({ url: `/pages/tag/apply?target=${encodeURIComponent(targetId)}&kind=${kind}` });
}

function proposeTag(tagId: string) {
  uni.navigateTo({ url: `/pages/governance/governance?itemId=${encodeURIComponent(tagId)}` });
}

/** 附件按需取回：下载字节 → 落本地文件 → 交给系统打开（附件块不在 blob_index，不能按 item 查路径） */
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
.title { display: block; font-size: 20px; font-weight: 600; margin-bottom: 6px; }
.digest { display: block; color: #555555; font-size: 14px; line-height: 1.6; margin-bottom: 8px; }
/* Discuz 仿效：作者栏 */
.author-bar { display: flex; align-items: center; gap: 10px; padding: 10px 12px; background: #f7fafc; border-radius: 8px; margin: 8px 0 12px; }
.author-avatar { width: 32px; height: 32px; border-radius: 50%; color: #fff; font-size: 13px; font-weight: 500; display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
.author-info { flex: 1; min-width: 0; }
.author-name { font-size: 13px; font-weight: 500; color: #2d3748; }
.author-count { font-size: 11px; color: #718096; font-weight: 400; }
.author-sub { display: block; font-size: 11px; color: #a0aec0; margin-top: 1px; }
/* Discuz 仿效：课程整体学习进度顶栏 */
.progress-bar { padding: 12px; background: #f0fff4; border-radius: 8px; margin-bottom: 12px; }
.progress-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px; }
.progress-label { font-size: 12px; color: #276749; font-weight: 500; }
.progress-pct { font-size: 12px; color: #38a169; font-weight: 600; }
.progress-pct.done { color: #2f855a; }
.progress-track { height: 6px; background: #c6f6d5; border-radius: 3px; overflow: hidden; }
.progress-fill { height: 100%; background: linear-gradient(90deg, #68d391, #38a169); border-radius: 3px; transition: width 0.3s ease; }
.progress-fill.done { background: #2f855a; }
.meta { display: block; color: #888888; font-size: 12px; }
.cover { width: 100%; margin-bottom: 12px; border-radius: 6px; }
.lesson { padding: 12px 0; border-bottom: 1px solid #eeeeee; display: flex; align-items: flex-start; gap: 12px; }
.lesson.done .lesson-title { color: #276749; }
.lesson-no { width: 28px; height: 28px; border-radius: 50%; background: #edf2f7; color: #4a5568; display: flex; align-items: center; justify-content: center; font-size: 13px; font-weight: 600; flex-shrink: 0; margin-top: 2px; }
.lesson-no.done { background: #48bb78; color: #fff; }
.lesson-main { flex: 1; min-width: 0; }
.lesson-title { font-size: 17px; }
.attach { padding: 8px 0; }
.attach-name { color: #2b6cb0; font-size: 14px; }
.hint { color: #888888; }
.error { color: #c53030; font-size: 13px; }
.group { display: block; margin: 18px 0 6px; color: #888888; font-size: 13px; }
.act { display: block; color: #2b6cb0; font-size: 14px; padding: 4px 0 8px; }
.act.danger { color: #c53030; }
.tags { display: flex; flex-wrap: wrap; align-items: center; margin: 4px 0 6px; }
.tag { padding: 2px 8px; margin: 0 8px 6px 0; background: #ebf8ff; color: #2b6cb0; border-radius: 10px; font-size: 12px; }
.tag-pending { padding: 2px 8px; margin: 0 8px 6px 0; background: #fffaf0; color: #b7791f; border-radius: 10px; font-size: 12px; }
.tag-note { margin: 0 0 6px; color: #888888; font-size: 12px; }
.tag-more { margin: 0 8px 6px 0; color: #888888; font-size: 12px; }
.term-badge { display: inline-block; margin-left: 4px; padding: 0 4px; border-radius: 6px; background: #edf2f7; color: #718096; font-size: 11px; }
</style>