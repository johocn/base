<template>
  <view class="wrap">
    <view class="topbar">
      <text class="title">我的笔记</text>
      <view class="new-btn" @click="create">新建笔记</view>
    </view>

    <scroll-view v-if="allTags.length > 0" scroll-x class="tagbar">
      <view class="tags">
        <text :class="activeTag === '' ? 'chip chip-on' : 'chip'" @click="filterTag('')">全部</text>
        <text v-for="t in allTags" :key="t" :class="activeTag === t ? 'chip chip-on' : 'chip'" @click="filterTag(t)">{{ t }}</text>
      </view>
    </scroll-view>

    <text v-if="rows.length === 0" class="empty">还没有笔记，点上方新建</text>

    <view v-for="r in rows" :key="r.noteId" class="card" @click="open(r.noteId)" @longpress="remove(r)">
      <text class="t">{{ r.title }}</text>
      <text class="meta">{{ r.updatedAt.slice(0, 10) }}</text>
    </view>
  </view>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import { onShow } from '@dcloudio/uni-app';

import { deleteNote, listNotes, type NoteRow } from '@base/core-ts/notes';
import { bootstrap } from '../../platform';

const rows = ref<NoteRow[]>([]);
const allTags = ref<string[]>([]);
const activeTag = ref('');

// onShow：从编辑/详情页返回后立刻刷新列表
onShow(async () => {
  try {
    await refresh();
  } catch {
    rows.value = [];
    allTags.value = [];
  }
});

async function refresh(): Promise<void> {
  const { repo } = await bootstrap();
  const all = await listNotes(repo);
  allTags.value = [...new Set(all.flatMap((r) => r.tags))];
  rows.value = activeTag.value === '' ? all : all.filter((r) => r.tags.includes(activeTag.value));
}

function filterTag(tag: string): void {
  activeTag.value = tag;
  void refresh();
}

function create(): void {
  uni.navigateTo({ url: '/pages/note/edit' });
}

function open(noteId: string): void {
  uni.navigateTo({ url: `/pages/note/detail?noteId=${encodeURIComponent(noteId)}` });
}

// 长按删除：确认后仅删本机（私有笔记绝不上传）
function remove(r: NoteRow): void {
  uni.showModal({
    title: '删除笔记',
    content: `确定删除「${r.title}」吗？`,
    confirmText: '删除',
    cancelText: '取消',
    success: (res) => {
      if (res.confirm) void doDelete(r.noteId);
    },
  });
}

async function doDelete(noteId: string): Promise<void> {
  const { repo } = await bootstrap();
  await deleteNote(repo, noteId);
  await refresh();
}
</script>

<style>
.wrap { padding: 16px; }
.topbar { display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px; }
.title { font-size: var(--fs-title); font-weight: 600; }
.new-btn { display: flex; align-items: center; min-height: 48px; padding: 0 16px; background: #2b6cb0; color: #ffffff; border-radius: 8px; font-size: var(--fs-body); }
.tagbar { white-space: nowrap; margin-bottom: 12px; }
.tags { display: flex; flex-direction: row; }
.chip { display: inline-flex; align-items: center; min-height: 48px; padding: 0 16px; margin-right: 8px; border: 1px solid #eeeeee; border-radius: 8px; color: #666666; font-size: var(--fs-annotate); }
.chip-on { border-color: #2b6cb0; color: #2b6cb0; }
.card { border: 1px solid #eeeeee; border-radius: 8px; padding: 10px; margin-bottom: 10px; min-height: 48px; }
.t { display: block; font-size: var(--fs-body); }
.meta { display: block; color: #888888; font-size: var(--fs-annotate); }
.empty { display: block; color: #888888; font-size: var(--fs-body); margin-top: 32px; text-align: center; }
</style>
