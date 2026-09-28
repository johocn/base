<template>
  <view class="wrap">
    <text class="title">{{ isUpdate ? '重投更新' : '新建投稿' }}</text>

    <view class="tabs">
      <text class="tab" :class="type === 'article' ? 'tab-on' : ''" @click="switchType('article')">文章</text>
      <text class="tab" :class="type === 'quiz' ? 'tab-on' : ''" @click="switchType('quiz')">题库</text>
    </view>
    <text v-if="isUpdate" class="hint">载体与条目 id 在更新模式下不可改（id 就是身份）</text>

    <view class="field">
      <text class="label">标题</text>
      <input v-model="title" class="input" placeholder="1–200 字" />
      <text v-if="isUpdate" class="hint">标题不参与作者签名，只有正文（题库为题组内容）受签名保护</text>
    </view>

    <view v-if="type === 'article'" class="field">
      <text class="label">正文（Markdown）</text>
      <textarea v-model="bodyMd" class="area" placeholder="正文内容" />
    </view>

    <block v-else>
      <view v-for="(q, i) in drafts" :key="i" class="qcard">
        <view class="qhead">
          <text class="label">第 {{ i + 1 }} 题</text>
          <text v-if="drafts.length > 1" class="del" @click="removeQuestion(i)">删除本题</text>
        </view>
        <input v-model="q.q" class="input" placeholder="题干" />
        <view v-for="(opt, j) in q.options" :key="j" class="opt">
          <text class="pick" :class="q.answer === j ? 'pick-on' : ''" @click="pick(i, j)">{{ q.answer === j ? '●' : '○' }}</text>
          <input v-model="q.options[j]" class="input opt-in" placeholder="选项" />
          <text v-if="q.options.length > 2" class="del" @click="removeOption(i, j)">✕</text>
        </view>
        <text class="add" @click="addOption(i)">+ 选项</text>
        <input v-model="q.explain" class="input" placeholder="解析（可空）" />
      </view>
      <text class="add" @click="addQuestion">+ 加一题</text>
    </block>

    <text v-if="error" class="error">{{ error }}</text>
    <text v-if="notice" class="notice">{{ notice }}</text>

    <button class="submit" :disabled="busy" @click="submit">{{ busy ? '提交中…' : '提交' }}</button>
  </view>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import { onLoad } from '@dcloudio/uni-app';

import { buildQuestionJSON, draftsFromQuestionJSON, emptyDraft, type QuestionDraft } from '../../core/quizdoc';
import { enqueueOrSend, newItemID, type SubmitDraft } from '../../core/submit';
import { bootstrap } from '../../platform';

const itemId = ref('');
const type = ref<'article' | 'quiz'>('article');
const title = ref('');
const bodyMd = ref('');
const drafts = ref<QuestionDraft[]>([emptyDraft()]);
const busy = ref(false);
const error = ref('');
const notice = ref('');

const isUpdate = computed(() => itemId.value !== '');

onLoad(async (query) => {
  const raw = String((query as Record<string, string> | undefined)?.itemId ?? '');
  if (raw === '') return;
  try {
    const { repo } = await bootstrap();
    const row = await repo.getSubmission(raw);
    if (!row) {
      error.value = '本地台账没有这条记录';
      return;
    }
    itemId.value = row.itemId;
    type.value = row.type;
    title.value = row.title;
    bodyMd.value = row.bodyMd;
    const loaded = row.type === 'quiz' ? draftsFromQuestionJSON(row.questionJson) : [];
    drafts.value = loaded.length > 0 ? loaded : [emptyDraft()];
  } catch (e) {
    error.value = (e as Error).message;
  }
});

/** 新建模式才允许切载体；更新模式的载体由 item_id 前缀固定（本册 §5.4） */
function switchType(next: 'article' | 'quiz') {
  if (!isUpdate.value) type.value = next;
}
function pick(i: number, j: number) {
  drafts.value[i]!.answer = j;
}
function addOption(i: number) {
  drafts.value[i]!.options.push('');
}
function removeOption(i: number, j: number) {
  const q = drafts.value[i]!;
  q.options.splice(j, 1);
  if (q.answer >= q.options.length) q.answer = -1;
}
function addQuestion() {
  drafts.value.push(emptyDraft());
}
function removeQuestion(i: number) {
  drafts.value.splice(i, 1);
}

async function submit() {
  error.value = '';
  notice.value = '';
  const draft: SubmitDraft = {
    itemId: itemId.value || newItemID(type.value),
    type: type.value,
    title: title.value,
    bodyMd: '',
    questionJson: '',
  };
  if (type.value === 'quiz') {
    const built = buildQuestionJSON(drafts.value);
    if (built === null) {
      error.value = '题组内容不合法：每题需题干、至少 2 个选项并选定正确项';
      return;
    }
    draft.questionJson = built;
  } else {
    draft.bodyMd = bodyMd.value;
  }

  busy.value = true;
  try {
    const { opts, repo } = await bootstrap();
    const out = await enqueueOrSend({ adapters: opts.adapters, repo, nodeBaseUrl: opts.nodeBaseUrl }, draft);
    itemId.value = out.itemId;
    if (out.ledgerState === 'sent') {
      uni.showToast({ title: out.created ? '已提交' : '已更新', icon: 'success' });
      setTimeout(() => uni.navigateBack(), 600);
      return;
    }
    // 未送达：pending 会自动补发，failed 需回「我的条目」删除后重投
    notice.value = out.message;
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    busy.value = false;
  }
}
</script>

<style>
.wrap { padding: 16px; }
.title { display: block; font-size: 20px; font-weight: 600; margin-bottom: 12px; }
.tabs { display: flex; margin-bottom: 8px; }
.tab { padding: 6px 16px; border: 1px solid #dddddd; border-radius: 16px; margin-right: 10px; color: #666666; font-size: 14px; }
.tab-on { border-color: #2b6cb0; color: #2b6cb0; }
.field { margin-bottom: 14px; }
.label { display: block; font-size: 14px; color: #666666; margin-bottom: 6px; }
.hint { display: block; font-size: 12px; color: #999999; margin-top: 4px; }
.input { border: 1px solid #eeeeee; border-radius: 6px; padding: 8px; font-size: 14px; }
.opt-in { flex: 1; }
.area { border: 1px solid #eeeeee; border-radius: 6px; padding: 8px; width: 100%; height: 220px; font-size: 14px; }
.qcard { border: 1px solid #eeeeee; border-radius: 8px; padding: 10px; margin-bottom: 12px; }
.qhead { display: flex; justify-content: space-between; }
.opt { display: flex; align-items: center; margin: 6px 0; }
.pick { width: 28px; color: #888888; }
.pick-on { color: #2b6cb0; }
.add { display: block; color: #2b6cb0; font-size: 14px; padding: 6px 0; }
.del { color: #c53030; font-size: 13px; }
.error { display: block; color: #c53030; font-size: 13px; margin: 8px 0; }
.notice { display: block; color: #b7791f; font-size: 13px; margin: 8px 0; }
.submit { margin-top: 16px; background: #2b6cb0; color: #ffffff; }
</style>