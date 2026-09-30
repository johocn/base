<template>
  <view class="wrap">
    <text v-if="error" class="error">{{ error }}</text>
    <block v-else>
      <text v-if="!loaded" class="hint">加载中…</text>
      <block v-else>
        <text class="title">{{ courseTitle }}</text>
        <view class="tags">
          <text v-for="t in courseTags" :key="t.tagId" class="tag" @click="openTag(t.tagId)">{{ tagLabel(t.tagId) }}</text>
          <text v-if="pendingOf(courseId)" class="tag-pending" @click="applyTag(courseId, 'course')">待补标签 · 补标签</text>
          <text v-else-if="courseTags.length > 0" class="tag-note" @click="proposeTag(courseTags[0]!.tagId)">已有标签，改动需提案</text>
        </view>
        <text v-if="lessons.length === 0" class="hint">这门课程还没有课时</text>
        <block v-for="ls in lessons" :key="ls.itemId">
          <view class="lesson" @click="onLesson(ls)">
            <text class="lesson-title">{{ lessonLabel(ls) }}</text>
          </view>
          <view class="tags">
            <text v-for="t in lessonTags[ls.itemId] ?? []" :key="t.tagId" class="tag" @click.stop="openTag(t.tagId)">{{ tagLabel(t.tagId) }}</text>
            <text v-if="pendingOf(ls.itemId)" class="tag-pending" @click.stop="applyTag(ls.itemId, 'lesson')">待补标签 · 补标签</text>
            <text v-else-if="(lessonTags[ls.itemId] ?? []).length > 0" class="tag-note" @click.stop="proposeTag(lessonTags[ls.itemId]![0]!.tagId)">已有标签，改动需提案</text>
          </view>
          <block v-if="expanded === ls.itemId">
            <view v-for="c in ls.carriers" :key="c.itemId" class="carrier" @click="openCarrier(c)">
              <text class="carrier-title">{{ c.title }}</text>
            </view>
          </block>
        </block>
        <block v-if="quizGroups.length > 0">
          <text class="group">本课程测验（{{ quizTotal }} 组）</text>
          <block v-for="qg in quizGroups" :key="qg.lessonId">
            <text class="quiz-lesson">{{ qg.lessonLabel }}</text>
            <view v-for="qz in qg.quizzes" :key="qz.itemId" class="carrier" @click="openQuiz(qz.itemId)">
              <text class="carrier-title">{{ qz.title }}</text>
            </view>
          </block>
        </block>
      </block>
    </block>
  </view>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import { onLoad } from '@dcloudio/uni-app';

import { childrenOf, lessonNo } from '../../core/course-tree';
import { canGovern, tagsOf, untaggedTargets } from '../../core/tags';
import type { TagLinkRow } from '../../core/types';
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
interface QuizVM {
  itemId: string;
  title: string;
}
interface QuizGroupVM {
  lessonId: string;
  lessonLabel: string;
  quizzes: QuizVM[];
}

const courseTitle = ref('');
const lessons = ref<LessonVM[]>([]);
const expanded = ref('');
const loaded = ref(false);
const error = ref('');
const quizGroups = ref<QuizGroupVM[]>([]);
const courseId = ref('');
const courseTags = ref<TagLinkRow[]>([]);
const lessonTags = ref<Record<string, TagLinkRow[]>>({});
const tagTitles = ref<Record<string, string>>({});
const untagged = ref<Set<string>>(new Set());
const governor = ref(false);
const quizTotal = computed(() => quizGroups.value.reduce((n, g) => n + g.quizzes.length, 0));

onLoad(async (query) => {
  const raw = String((query as Record<string, string> | undefined)?.courseId ?? '');
  try {
    const { opts, repo } = await bootstrap();
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
    const quizzesByLesson: QuizGroupVM[] = [];
    for (const lid of lessonIds) {
      const lrow = await repo.getItem(lid);
      const carrierIds = childrenOf(await repo.listSegments(lid));
      const carriers: CarrierVM[] = [];
      for (const cid of carrierIds) {
        const crow = await repo.getItem(cid);
        carriers.push({ itemId: cid, type: crow?.type ?? '', title: crow?.title || cid });
      }
      const no = lessonNo(segments, lid);
      const title = lrow?.title || lid;
      acc.push({ itemId: lid, no, title, carriers });
      // 课程页的答题入口：该课时内的 quiz，按课时顺序分组（册子 §4）
      const quizzes = carriers
        .filter((c) => c.type === 'quiz')
        .map((c) => ({ itemId: c.itemId, title: c.title }));
      if (quizzes.length > 0) {
        quizzesByLesson.push({ lessonId: lid, lessonLabel: no > 0 ? `第 ${no} 讲 · ${title}` : title, quizzes });
      }
    }
    lessons.value = acc;
    quizGroups.value = quizzesByLesson;
    courseId.value = course.itemId;
    const links = await repo.listTagLinks();
    const all = await repo.listItems();
    untagged.value = new Set(untaggedTargets(all, links));
    tagTitles.value = Object.fromEntries(all.filter((i) => i.type === 'tag').map((i) => [i.itemId, i.title || i.itemId]));
    courseTags.value = tagsOf(links, course.itemId);
    const byLesson: Record<string, TagLinkRow[]> = {};
    for (const ls of acc) byLesson[ls.itemId] = tagsOf(links, ls.itemId);
    lessonTags.value = byLesson;
    governor.value = await canGovern({ adapters: opts.adapters, repo, nodeBaseUrl: opts.nodeBaseUrl });
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

function openQuiz(itemId: string) {
  uni.navigateTo({ url: `/pages/quiz/quiz?itemId=${encodeURIComponent(itemId)}` });
}

/** 页面间传参在个别机型上会保留百分号编码，按原样查不到就按解码后再查 */
function decodedId(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

function tagLabel(tagId: string): string {
  return tagTitles.value[tagId] ?? tagId;
}

/** 「待补标签」只在治理人眼里出现；非治理人看不到任何提示（册子 §3.6） */
function pendingOf(id: string): boolean {
  return governor.value && untagged.value.has(id);
}

function openTag(tagId: string) {
  uni.navigateTo({ url: `/pages/tag/detail?tagId=${encodeURIComponent(tagId)}` });
}

function applyTag(targetId: string, kind: string) {
  uni.navigateTo({ url: `/pages/tag/apply?target=${encodeURIComponent(targetId)}&kind=${kind}` });
}

/** 已有标签的内容要改动 = 对该标签提 `edit` 提案（提案粒度是整个关联集，册子 §3.5） */
function proposeTag(tagId: string) {
  uni.navigateTo({ url: `/pages/governance/governance?itemId=${encodeURIComponent(tagId)}` });
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
.group { display: block; margin: 20px 0 6px; color: #888888; font-size: 13px; }
.quiz-lesson { display: block; margin: 10px 0 2px; color: #666666; font-size: 13px; }
.tags { display: flex; flex-wrap: wrap; align-items: center; margin: 0 0 10px; }
.tag { padding: 2px 8px; margin: 0 8px 6px 0; background: #ebf8ff; color: #2b6cb0; border-radius: 10px; font-size: 12px; }
.tag-pending { padding: 2px 8px; margin: 0 8px 6px 0; background: #fffaf0; color: #b7791f; border-radius: 10px; font-size: 12px; }
.tag-note { margin: 0 0 6px; color: #888888; font-size: 12px; }
</style>
