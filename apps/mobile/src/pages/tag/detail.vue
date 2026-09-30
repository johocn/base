<template>
  <view class="wrap">
    <text v-if="error" class="error">{{ error }}</text>
    <block v-else>
      <text class="title">{{ title || tagId }}</text>
      <text class="meta">{{ tagId }}</text>
      <text v-if="groups.length === 0" class="hint">这个标签还没有关联内容</text>
      <block v-for="g in groups" :key="g.kind">
        <text class="group">{{ kindLabel(g.kind) }}（{{ g.rows.length }}）</text>
        <view v-for="r in g.rows" :key="r.targetId" class="row" @click="openTarget(r)">
          <text class="t">{{ r.title }}</text>
          <text class="meta">{{ r.targetId }}</text>
        </view>
      </block>
    </block>
  </view>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import { onLoad } from '@dcloudio/uni-app';

import { setPendingTarget } from '../../core/comment';
import { linksOf } from '../../core/tags';
import type { TagLinkRow } from '../../core/types';
import { bootstrap } from '../../platform';

interface TargetVM {
  targetId: string;
  kind: string;
  title: string;
}
interface GroupVM {
  kind: string;
  rows: TargetVM[];
}

const KIND_LABEL: Record<string, string> = { course: '课程', lesson: '课时', article: '文章', comment: '评论' };

const tagId = ref('');
const title = ref('');
const groups = ref<GroupVM[]>([]);
const error = ref('');

onLoad(async (query) => {
  const raw = String((query as Record<string, string> | undefined)?.tagId ?? '');
  tagId.value = raw;
  try {
    const { repo } = await bootstrap();
    const alt = decodedId(raw);
    const row = (await repo.getItem(raw)) ?? (alt === raw ? null : await repo.getItem(alt));
    if (row) {
      tagId.value = row.itemId;
      title.value = row.title || row.itemId;
    }
    // `known` = 本地能定位到标题的目标集合。条目走 `items`；**评论事件不在本地内容表里**
    // （评论页是实时从节点拉的），但既然关联行已同步下来，就一并放行、标题退化为事件号短码；
    // 其余查不到的目标按悬空引用静默跳过（册子 §3.2）。
    const links = await repo.listTagLinks();
    const known = new Set(await repo.listLocalItemIds());
    for (const l of links) if (l.kind === 'comment') known.add(l.targetId);
    const acc: GroupVM[] = [];
    for (const l of linksOf(links, tagId.value, known)) {
      const t = await repo.getItem(l.targetId);
      const vm: TargetVM = { targetId: l.targetId, kind: l.kind, title: t?.title || shortTarget(l) };
      const last = acc[acc.length - 1];
      if (last && last.kind === l.kind) last.rows.push(vm);
      else acc.push({ kind: l.kind, rows: [vm] });
    }
    groups.value = acc;
  } catch (e) {
    error.value = (e as Error).message;
  }
});

function kindLabel(kind: string): string {
  return KIND_LABEL[kind] ?? kind;
}

/** 评论事件不在本地内容表里，标题退化为事件号短码（`comment/<32hex>` → `评论 0123abcd`） */
function shortTarget(l: TagLinkRow): string {
  return l.kind === 'comment' ? `评论 ${(l.targetId.split('/')[1] ?? '').slice(0, 8)}` : l.targetId;
}

function openTarget(r: TargetVM): void {
  const parts = r.targetId.split('/');
  if (r.kind === 'article') {
    uni.navigateTo({ url: `/pages/article/article?itemId=${encodeURIComponent(r.targetId)}` });
    return;
  }
  if (r.kind === 'course') {
    uni.navigateTo({ url: `/pages/course/detail?courseId=${encodeURIComponent(r.targetId)}` });
    return;
  }
  if (r.kind === 'lesson') {
    // 课时没有独立页面：回到它所属课程（课时在课程页展开）
    uni.navigateTo({ url: `/pages/course/detail?courseId=${encodeURIComponent(`course/${parts[1] ?? ''}`)}` });
    return;
  }
  if (r.kind === 'comment') {
    setPendingTarget(r.targetId);
    uni.switchTab({ url: '/pages/comment/comment' });
    return;
  }
  uni.showToast({ title: '暂不支持的类型', icon: 'none' });
}

/** 页面间传参在个别机型上会保留百分号编码，按原样查不到就按解码后再查 */
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
.title { display: block; font-size: 20px; font-weight: 600; }
.meta { display: block; color: #888888; font-size: 12px; margin-bottom: 12px; }
.group { display: block; margin: 14px 0 6px; color: #888888; font-size: 13px; }
.row { padding: 10px 0; border-bottom: 1px solid #f2f2f2; }
.t { font-size: 15px; }
.hint { color: #888888; font-size: 13px; }
.error { display: block; color: #c53030; font-size: 13px; }
</style>
