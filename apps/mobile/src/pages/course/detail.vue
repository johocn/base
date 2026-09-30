<template>
  <view class="wrap">
    <text v-if="error" class="error">{{ error }}</text>
    <block v-else>
      <text v-if="!loaded" class="hint">加载中…</text>
      <block v-else>
        <image v-if="coverPath" :src="coverPath" mode="widthFix" class="cover" />
        <text class="title">{{ courseTitle }}</text>
        <text v-if="digest !== ''" class="digest">{{ digest }}</text>
        <text v-if="metaLine !== ''" class="meta">{{ metaLine }}</text>
        <view class="tags">
          <text v-for="t in courseTags" :key="t.tagId" class="tag" @click="openTag(t.tagId)">{{ tagLabel(t.tagId) }}</text>
          <text v-if="pendingOf(courseId)" class="tag-pending" @click="applyTag(courseId, 'course')">待补标签 · 补标签</text>
          <text v-else-if="courseTags.length > 0" class="tag-note" @click="proposeTag(courseTags[0]!.tagId)">已有标签，改动需提案</text>
        </view>
        <text v-if="canEdit" class="act" @click="openEdit">编辑本课程</text>

        <block v-if="attachments.length > 0">
          <text class="group">附件（{{ attachments.length }}）</text>
          <view v-for="a in attachments" :key="a.blobId" class="attach" @click="openAttachment(a)">
            <text class="attach-name">{{ a.name }}</text>
          </view>
        </block>

        <text class="group">课时（{{ lessons.length }}）</text>
        <text v-if="lessons.length === 0" class="hint">这门课程还没有课时</text>
        <view v-for="ls in lessons" :key="ls.itemId" class="lesson" @click="openLesson(ls)">
          <text class="lesson-title">第 {{ ls.no }} 讲 · {{ ls.title }}</text>
          <text class="meta">{{ ls.sub }}</text>
          <view class="tags">
            <text v-for="t in ls.tags" :key="t.tagId" class="tag" @click.stop="openTag(t.tagId)">{{ tagLabel(t.tagId) }}</text>
            <text v-if="pendingOf(ls.itemId)" class="tag-pending" @click.stop="applyTag(ls.itemId, 'lesson')">待补标签 · 补标签</text>
          </view>
        </view>
      </block>
    </block>
  </view>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import { onLoad } from '@dcloudio/uni-app';

import { fetchBlob } from '../../core/blob';
import { attrsOf, childCounts, childrenRowsOf, digestOf, type AttachmentVM } from '../../core/container-view';
import { lessonNo } from '../../core/course-tree';
import { canGovern, tagsOf, untaggedTargets } from '../../core/tags';
import { containerFormFromLedger } from '../../core/my-created';
import type { TagLinkRow } from '../../core/types';
import { bootstrap } from '../../platform';

interface LessonVM {
  itemId: string;
  no: number;
  title: string;
  /** 徽标行：类型计数 / 附件 / 时长，或「空课时」「未同步」 */
  sub: string;
  tags: TagLinkRow[];
}

const courseId = ref('');
const courseTitle = ref('');
const digest = ref('');
const metaLine = ref('');
const coverPath = ref('');
const attachments = ref<AttachmentVM[]>([]);
const lessons = ref<LessonVM[]>([]);
const courseTags = ref<TagLinkRow[]>([]);
const tagTitles = ref<Record<string, string>>({});
const untagged = ref<Set<string>>(new Set());
const governor = ref(false);
const loaded = ref(false);
const canEdit = ref(false);
const error = ref('');

const KIND_LABEL: Record<string, string> = { article: '文章', quiz: '测验', video: '视频', audio: '音频' };

onLoad(async (query) => {
  const q = (query as Record<string, string> | undefined) ?? {};
  const raw = String(q.courseId ?? '');
  try {
    const { opts, repo } = await bootstrap();
    // from=ledger：从「我创建的」区进入 → 只用台账行集渲染，不读包表（册子 #51 §3.3）。
    if (q.from === 'ledger') {
      const row = await repo.getSubmission(raw);
      if (!row) {
        error.value = '本地没有这门课程，请返回先同步';
        return;
      }
      const form = containerFormFromLedger(row);
      courseId.value = form.itemId;
      courseTitle.value = form.title || form.itemId;
      digest.value = form.digest;
      const meta: string[] = [];
      if (form.instructor !== '') meta.push(`讲师 ${form.instructor}`);
      if (form.difficulty !== '') meta.push(`难度 ${difficultyLabel(form.difficulty)}`);
      if (form.durationSec > 0) meta.push(`共约 ${Math.round(form.durationSec / 60)} 分钟`);
      metaLine.value = meta.join(' · ');
      attachments.value = form.attachments;
      // children 行标题回落 itemId（台账行集不含子项标题，与既有「本地未同步」回落同口径）
      lessons.value = form.children.map((c, i) => ({
        itemId: c.itemId,
        no: i + 1,
        title: c.itemId,
        sub: '本地未同步（点开按 id 直接查）',
        tags: [],
      }));
      canEdit.value = row.state === 'sent';
      loaded.value = true;
      return;
    }
    const cid = decodedId(raw);
    const course = (await repo.getItem(raw)) ?? (cid === raw ? null : await repo.getItem(cid));
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

    const meta: string[] = [];
    if (attrs.instructor !== '') meta.push(`讲师 ${attrs.instructor}`);
    if (attrs.difficulty !== '') meta.push(`难度 ${difficultyLabel(attrs.difficulty)}`);
    if (attrs.duration > 0) meta.push(`共约 ${Math.round(attrs.duration / 60)} 分钟`);
    metaLine.value = meta.join(' · ');

    const path = await repo.findBlobPathByItem(`${course.itemId}/cover`);
    coverPath.value = path ? (path.startsWith('file://') ? path : `file://${path}`) : '';

    const rows = childrenRowsOf(segs);
    const links = await repo.listTagLinks();
    const acc: LessonVM[] = [];
    for (let i = 0; i < rows.length; i++) {
      const lid = rows[i]!.text;
      const lrow = await repo.getItem(lid);
      const lsegs = await repo.listSegments(lid);
      const counts = childCounts(lsegs);
      const lattrs = attrsOf(lsegs);
      const parts: string[] = [];
      for (const k of ['article', 'quiz', 'video', 'audio']) {
        const n = counts[k] ?? 0;
        if (n > 0) parts.push(`${KIND_LABEL[k]} ${n}`);
      }
      if (lattrs.attachments.length > 0) parts.push(`附件 ${lattrs.attachments.length}`);
      if (lattrs.duration > 0) parts.push(`约 ${Math.round(lattrs.duration / 60)} 分钟`);
      // 位次由 seq 决定：空课时与未同步都照占一行，不吃掉后面课时的序号
      const sub = !lrow ? '本地未同步（点开按 id 直接查）' : parts.length === 0 ? '空课时' : parts.join(' · ');
      acc.push({
        itemId: lid,
        no: lessonNo(segs, lid) || i + 1,
        title: lrow?.title || lid,
        sub,
        tags: tagsOf(links, lid),
      });
    }
    lessons.value = acc;

    const all = await repo.listItems();
    untagged.value = new Set(untaggedTargets(all, links));
    tagTitles.value = Object.fromEntries(all.filter((i) => i.type === 'tag').map((i) => [i.itemId, i.title || i.itemId]));
    courseTags.value = tagsOf(links, course.itemId);
    governor.value = await canGovern({ adapters: opts.adapters, repo, nodeBaseUrl: opts.nodeBaseUrl });
    canEdit.value = (await repo.getSubmission(course.itemId))?.state === 'sent';
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

function difficultyLabel(d: string): string {
  return d === 'intro' ? '入门' : d === 'basic' ? '基础' : d === 'advanced' ? '进阶' : d;
}

function tagLabel(tagId: string): string {
  return tagTitles.value[tagId] ?? tagId;
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
.meta { display: block; color: #888888; font-size: 12px; }
.cover { width: 100%; margin-bottom: 12px; border-radius: 6px; }
.lesson { padding: 12px 0; border-bottom: 1px solid #eeeeee; }
.lesson-title { font-size: 17px; }
.attach { padding: 8px 0; }
.attach-name { color: #2b6cb0; font-size: 14px; }
.hint { color: #888888; }
.error { color: #c53030; font-size: 13px; }
.group { display: block; margin: 18px 0 6px; color: #888888; font-size: 13px; }
.act { display: block; color: #2b6cb0; font-size: 14px; padding: 4px 0 8px; }
.tags { display: flex; flex-wrap: wrap; align-items: center; margin: 4px 0 6px; }
.tag { padding: 2px 8px; margin: 0 8px 6px 0; background: #ebf8ff; color: #2b6cb0; border-radius: 10px; font-size: 12px; }
.tag-pending { padding: 2px 8px; margin: 0 8px 6px 0; background: #fffaf0; color: #b7791f; border-radius: 10px; font-size: 12px; }
.tag-note { margin: 0 0 6px; color: #888888; font-size: 12px; }
</style>