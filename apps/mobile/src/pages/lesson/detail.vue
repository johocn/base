<template>
  <view class="wrap">
    <text v-if="error" class="error">{{ error }}</text>
    <block v-else>
      <text v-if="!loaded" class="hint">加载中…</text>
      <block v-else>
        <image v-if="coverPath" :src="coverPath" mode="widthFix" class="cover" />
        <text class="title">{{ lessonLabel }}</text>
        <text class="meta">{{ metaLine }}</text>
        <view class="tags">
          <text v-for="t in selfTags" :key="t.tagId" class="tag" @click="openTag(t.tagId)">{{ tagLabel(t.tagId) }}</text>
          <text v-if="pendingOf(lessonId)" class="tag-pending" @click="applyTag">待补标签 · 补标签</text>
          <text v-else-if="selfTags.length > 0" class="tag-note" @click="proposeTag">已有标签，改动需提案</text>
        </view>
        <text v-if="canEdit" class="act" @click="openEdit">编辑本课时</text>

        <!-- 正文：缺失整块不渲染（老包无 attr.body_md），不显示空块 -->
        <block v-if="paragraphs.length > 0">
          <text class="group">正文</text>
          <text v-for="(p, i) in paragraphs" :key="i" class="para">{{ p }}</text>
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
import { canGovern, tagsOf, untaggedTargets } from '../../core/tags';
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
const paragraphs = ref<string[]>([]);
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

onLoad(async (query) => {
  const q = (query as Record<string, string> | undefined) ?? {};
  const raw = String(q.lessonId ?? '');
  const cid = String(q.courseId ?? '');
  lessonId.value = raw;
  try {
    const { opts, repo } = await bootstrap();
    const lid = wait(raw);
    const row = await repo.getItem(lid);
    const segs = await repo.listSegments(lid);
    const attrs = attrsOf(segs);

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

    paragraphs.value = attrs.bodyMd
      .replace(/\r\n/g, '\n')
      .split('\n\n')
      .map((s) => s.trim())
      .filter((s) => s !== '');

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
.para { display: block; font-size: 15px; line-height: 1.7; margin-bottom: 10px; }
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
</style>