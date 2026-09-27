<template>
  <view class="wrap">
    <text v-if="error" class="error">{{ error }}</text>
    <block v-else-if="current">
      <text class="progress">{{ index + 1 }} / {{ questions.length }}</text>
      <text class="q">{{ current.q }}</text>
      <view
        v-for="(opt, i) in current.options"
        :key="i"
        class="opt"
        :class="optClass(i)"
        @click="pick(i)"
      >
        <text class="opt-text">{{ opt }}</text>
      </view>
      <text v-if="picked !== null && current.explain" class="explain">解析：{{ current.explain }}</text>
      <button v-if="picked !== null && index + 1 < questions.length" size="mini" class="next" @click="next">下一题</button>
      <button v-if="picked !== null && index + 1 === questions.length" size="mini" class="next" @click="next">看结果</button>
    </block>
    <block v-else-if="finished">
      <text class="score">答对 {{ correct }} / {{ questions.length }}</text>
      <button size="mini" class="next" @click="restart">重做</button>
    </block>
  </view>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import { onLoad } from '@dcloudio/uni-app';

import { gradeAnswer, parseQuestionDoc, shuffleAll, type ShuffledQuestion } from '../../core/quiz';
import { bootstrap } from '../../platform';

const questions = ref<ShuffledQuestion[]>([]);
const index = ref(0);
const picked = ref<number | null>(null);
const correct = ref(0);
const finished = ref(false);
const error = ref('');
const itemId = ref('');

const current = computed<ShuffledQuestion | null>(() => questions.value[index.value] ?? null);

onLoad(async (query) => {
  const raw = String((query as Record<string, string> | undefined)?.itemId ?? '');
  try {
    const { repo } = await bootstrap();
    const alt = decodedId(raw);
    const row = (await repo.getQuiz(raw)) ?? (alt === raw ? null : await repo.getQuiz(alt));
    if (!row) {
      error.value = '本地没有这套题目，请返回先同步';
      return;
    }
    itemId.value = row.itemId;
    const parsed = parseQuestionDoc(row.questionJson);
    if (parsed === null) {
      error.value = '题目格式不支持，请升级节点内容';
      return;
    }
    questions.value = shuffleAll(parsed, row.itemId);
  } catch (e) {
    error.value = (e as Error).message;
  }
});

function pick(i: number) {
  if (picked.value !== null) return; // 每题只判一次
  picked.value = i;
  if (current.value && gradeAnswer(current.value, i)) correct.value++;
}

function optClass(i: number): string {
  if (picked.value === null) return '';
  if (i === current.value?.answerIndex) return 'opt-right';
  return i === picked.value ? 'opt-wrong' : '';
}

async function next() {
  if (index.value + 1 < questions.value.length) {
    index.value++;
    picked.value = null;
    return;
  }
  // 结算：只在这里写一行 quiz_attempt（不在每题判分时写，避免半途退出产生半截记录）
  try {
    const { repo } = await bootstrap();
    await repo.addAttempt(itemId.value, correct.value, questions.value.length, new Date().toISOString());
  } catch (e) {
    error.value = (e as Error).message;
    return;
  }
  finished.value = true;
}

function restart() {
  finished.value = false;
  index.value = 0;
  picked.value = null;
  correct.value = 0;
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
.progress { display: block; color: #888888; font-size: 13px; margin-bottom: 8px; }
.q { display: block; font-size: 18px; font-weight: 600; margin-bottom: 16px; line-height: 1.6; }
.opt { padding: 12px; border: 1px solid #dddddd; border-radius: 6px; margin-bottom: 10px; }
.opt-text { font-size: 15px; }
.opt-right { border-color: #2f855a; background: #f0fff4; }
.opt-wrong { border-color: #c53030; background: #fff5f5; }
.explain { display: block; color: #666666; font-size: 14px; line-height: 1.7; margin: 12px 0; }
.score { display: block; font-size: 20px; font-weight: 600; margin-bottom: 20px; }
.next { margin-top: 8px; }
.error { color: #c53030; font-size: 13px; }
</style>