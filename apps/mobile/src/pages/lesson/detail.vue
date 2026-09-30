<template>
  <view class="wrap">
    <text v-if="error" class="error">{{ error }}</text>
    <block v-else>
      <text v-if="!loaded" class="hint">加载中…</text>
      <block v-else>
        <image v-if="coverPath" :src="coverPath" mode="widthFix" class="cover" />
        <text class="title" :class="titleColor ? 'c-' + titleColor : ''">{{ lessonLabel }}</text>
        <view v-if="badge.length > 0" class="chips">
          <text v-for="b in badge" :key="b" class="badge">{{ b }}</text>
        </view>
        <text class="meta">{{ metaLine }}</text>
        <view class="tags">
          <text v-for="t in selfTags" :key="t.tagId" class="tag" @click="openTag(t.tagId)">{{ tagLabel(t.tagId) }}</text>
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
      </block>
    </block>
  </view>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import { onLoad } from '@dcloudio/uni-app';

import { fetchBlob } from '../../core/blob';
import { attrsOf, childrenRowsOf, type AttachmentVM } from '../../core/container-view';
import { lessonNo } from '../../core/course-tree';
import { renderMarkdown } from '../../core/markdown';
import { canGovern, tagsOf, untaggedTargets } from '../../core/tags';
import { containerFormFromLedger } from '../../core/my-created';
import type { TagLinkRow } from '../../core/types';
import { bootstrap } from '../../platform';

interface CarrierVM {
  itemId: string;
  type: string;
  title: string;
}

const lessonId = ref('');
const courseId = ref('');
const lessonLabel = ref('');
const metaLine = ref('');
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

onLoad(async (query) => {
  const q = (query as Record<string, string> | undefined) ?? {};
  const raw = String(q.lessonId ?? '');
  const cid = String(q.courseId ?? '');
  lessonId.value = raw;
  try {
    const { opts, repo } = await bootstrap();
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
      const meta: string[] = [];
      if (form.instructor !== '') meta.push(`讲师 ${form.instructor}`);
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
    if (courseId.value !== '') {
      try {
        no = lessonNo(await repo.listSegments(courseId.value), lid);
      } catch {
        no = 0;
      }
    }
    const title = row?.title || lid;
    lessonLabel.value = no > 0 ? `第 ${no} 讲 · ${title}` : title;

    const meta: string[] = [];
    if (attrs.instructor !== '') meta.push(`讲师 ${attrs.instructor}`);
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

function tagLabel(tagId: string): string {
  return tagTitles.value[tagId] ?? tagId;
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