<template>
  <view class="wrap">
    <text v-if="error" class="error">{{ error }}</text>
    <block v-else>
      <text v-if="!loaded" class="hint">加载中…</text>
      <block v-else>
        <text class="title">{{ courseTitle }}</text>
        <text v-if="lessons.length === 0" class="hint">这门课程还没有课时</text>
        <block v-for="ls in lessons" :key="ls.itemId">
          <view class="lesson" @click="onLesson(ls)">
            <text class="lesson-title">{{ lessonLabel(ls) }}</text>
          </view>
          <block v-if="expanded === ls.itemId">
            <view v-for="c in ls.carriers" :key="c.itemId" class="carrier" @click="openCarrier(c)">
              <text class="carrier-title">{{ c.title }}</text>
            </view>
          </block>
        </block>
      </block>
    </block>
  </view>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import { onLoad } from '@dcloudio/uni-app';

import { childrenOf, lessonNo } from '../../core/course-tree';
import { bootstrap } from '../../platform';

interface CarrierVM {
  itemId: string;
  type: string;
  title: string;
}
interface LessonVM {
  itemId: string;
  no: number;
  title: string;
  carriers: CarrierVM[];
}

const courseTitle = ref('');
const lessons = ref<LessonVM[]>([]);
const expanded = ref('');
const loaded = ref(false);
const error = ref('');

onLoad(async (query) => {
  const raw = String((query as Record<string, string> | undefined)?.courseId ?? '');
  try {
    const { repo } = await bootstrap();
    const alt = decodedId(raw);
    const course = (await repo.getItem(raw)) ?? (alt === raw ? null : await repo.getItem(alt));
    if (!course) {
      error.value = '本地没有这门课程，请返回先同步';
      return;
    }
    courseTitle.value = course.title || course.itemId;
    const segments = await repo.listSegments(course.itemId);
    const lessonIds = childrenOf(segments);
    const acc: LessonVM[] = [];
    for (const lid of lessonIds) {
      const lrow = await repo.getItem(lid);
      const carrierIds = childrenOf(await repo.listSegments(lid));
      const carriers: CarrierVM[] = [];
      for (const cid of carrierIds) {
        const crow = await repo.getItem(cid);
        carriers.push({ itemId: cid, type: crow?.type ?? '', title: crow?.title || cid });
      }
      acc.push({ itemId: lid, no: lessonNo(segments, lid), title: lrow?.title || lid, carriers });
    }
    lessons.value = acc;
    loaded.value = true;
  } catch (e) {
    error.value = (e as Error).message;
  }
});

function lessonLabel(ls: LessonVM): string {
  return ls.no > 0 ? `第 ${ls.no} 讲 · ${ls.title}` : ls.title;
}

function onLesson(ls: LessonVM) {
  if (ls.carriers.length === 0) {
    uni.showToast({ title: '该课时还没有内容', icon: 'none' });
    return;
  }
  if (ls.carriers.length === 1) {
    openCarrier(ls.carriers[0]);
    return;
  }
  expanded.value = expanded.value === ls.itemId ? '' : ls.itemId;
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
  if (c.type === 'video') {
    uni.showToast({ title: '视频播放待后续版本', icon: 'none' });
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
.title { display: block; font-size: 20px; font-weight: 600; margin-bottom: 12px; }
.lesson { padding: 12px 0; border-bottom: 1px solid #eeeeee; }
.lesson-title { font-size: 17px; }
.carrier { padding: 10px 0 10px 16px; border-bottom: 1px solid #f2f2f2; }
.carrier-title { color: #2b6cb0; font-size: 15px; }
.hint { color: #888888; }
.error { color: #c53030; font-size: 13px; }
</style>
