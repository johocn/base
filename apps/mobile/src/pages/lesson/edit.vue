<template>
  <view class="wrap">
    <text class="title">编辑课时</text>
    <text class="hint">条目 id：{{ form.itemId }}（不可改，它就是身份）</text>
    <text class="hint">所属课程：{{ courseId }}</text>

    <view class="field">
      <text class="label">标题</text>
      <input v-model="form.title" class="input" placeholder="1–200 字" />
    </view>

    <view class="field">
      <text class="label">正文（Markdown）</text>
      <textarea v-model="form.bodyMd" class="area" placeholder="课时正文；留空则不显示正文块" />
      <text class="hint">正文以 Markdown 源文本保存（槽位 attr.body_md），与文章同口径</text>
    </view>

    <view class="field">
      <text class="label">摘要 / 简介</text>
      <textarea v-model="form.digest" class="area-sm" placeholder="可空；只影响列表摘要，不影响正文" />
    </view>

    <view class="field">
      <text class="label">封面</text>
      <view class="row">
        <text class="val">{{ form.cover === '' ? '未设置' : form.cover }}</text>
        <text class="act" @click="pickCover">{{ form.cover === '' ? '选择图片' : '更换' }}</text>
      </view>
    </view>

    <view class="field">
      <text class="label">讲师</text>
      <input v-model="form.instructor" class="input" placeholder="可空" />
    </view>

    <view class="field">
      <text class="label">难度</text>
      <view class="chips">
        <text
          v-for="d in DIFFICULTY_CHOICES"
          :key="d"
          class="chip"
          :class="form.difficulty === d ? 'chip-on' : ''"
          @click="toggleDifficulty(d)"
        >{{ difficultyLabel(d) }}</text>
      </view>
    </view>

    <view class="field">
      <text class="label">时长（分钟）</text>
      <input v-model="durationMin" class="input" type="number" placeholder="可空；保存时换算成秒" />
    </view>

    <view class="field">
      <text class="label">附件</text>
      <view v-for="(a, i) in form.attachments" :key="a.blobId" class="row">
        <text class="val">{{ a.name }}</text>
        <text class="del" @click="removeAttachment(i)">删除</text>
      </view>
      <text class="add" @click="addAttachment">+ 添加附件</text>
    </view>

    <view class="section">
      <view class="shead">
        <text class="label">载体清单</text>
        <text class="add" @click="addCarrier">+ 添加载体</text>
      </view>
      <text v-if="form.children.length === 0" class="hint">还没有载体；空课时也会在课程页占一行的位次</text>
      <view v-for="(c, i) in form.children" :key="i" class="card">
        <view class="chead">
          <text class="label">第 {{ i + 1 }} 项</text>
          <view>
            <text class="act" @click="move(i, -1)">上移</text>
            <text class="act" @click="move(i, 1)">下移</text>
            <text class="del" @click="removeChild(i)">删除</text>
          </view>
        </view>
        <view class="chips">
          <text
            v-for="k in CARRIER_KINDS"
            :key="k"
            class="chip"
            :class="c.kind === k ? 'chip-on' : ''"
            @click="c.kind = k"
          >{{ k }}</text>
        </view>
        <input v-model="c.itemId" class="input" placeholder="载体的 item_id，如 article/xxxx" />
      </view>
      <text class="hint">顺序即课时页里的展示顺序；kind 必须是 article / quiz / video / audio 之一</text>
    </view>

    <text v-if="error" class="error">{{ error }}</text>
    <text v-if="notice" class="notice">{{ notice }}</text>

    <button class="submit" :disabled="busy" @click="submit">{{ busy ? '提交中…' : '保存' }}</button>
  </view>
</template>

<script setup lang="ts">
import { onLoad } from '@dcloudio/uni-app';
import { ref } from 'vue';

import { DIFFICULTY_BASIC, DIFFICULTY_CHOICES, DIFFICULTY_INTRO } from '../../core/attrs';
import { uploadBlob } from '../../core/blob';
import { loadContainerForm, saveContainer, startNewLesson, type ChildRow, type ContainerForm } from '../../core/course-edit';
import { bootstrap } from '../../platform';
import { pickLocalFile } from '../../platform/uni';

/** 课时可挂的载体类型（本册 §2.4；audio 登记在册但播放能力待后续版本） */
const CARRIER_KINDS = ['article', 'quiz', 'video', 'audio'];

const courseId = ref('');
const form = ref<ContainerForm>(startNewLesson(''));
const durationMin = ref('');
const busy = ref(false);
const error = ref('');
const notice = ref('');

onLoad(async (query) => {
  const q = (query as Record<string, string> | undefined) ?? {};
  courseId.value = String(q.courseId ?? '');
  const lessonId = String(q.lessonId ?? '');
  try {
    const { repo } = await bootstrap();
    if (lessonId !== '') {
      form.value = await loadContainerForm(repo, lessonId, 'lesson');
      durationMin.value = form.value.durationSec > 0 ? String(Math.round(form.value.durationSec / 60)) : '';
    } else if (courseId.value !== '') {
      form.value = startNewLesson(courseId.value);
    } else {
      error.value = '缺少课程 id，无法定位课时';
    }
  } catch (e) {
    error.value = (e as Error).message;
  }
});

function difficultyLabel(d: string): string {
  if (d === DIFFICULTY_INTRO) return '入门';
  if (d === DIFFICULTY_BASIC) return '基础';
  return '进阶';
}

function toggleDifficulty(d: string) {
  form.value.difficulty = form.value.difficulty === d ? '' : d;
}

async function uploadOne(): Promise<{ blobId: string; name: string } | null> {
  const picked = await pickLocalFile();
  if (!picked) return null;
  const { opts, repo } = await bootstrap();
  const blobId = await uploadBlob(
    { adapters: opts.adapters, repo, nodeBaseUrl: opts.nodeBaseUrl },
    picked.bytes,
    picked.name,
  );
  return { blobId, name: picked.name };
}

async function pickCover() {
  error.value = '';
  try {
    const up = await uploadOne();
    if (up) form.value.cover = up.blobId;
  } catch (e) {
    error.value = (e as Error).message;
  }
}

async function addAttachment() {
  error.value = '';
  try {
    const up = await uploadOne();
    if (up && !form.value.attachments.some((a) => a.blobId === up.blobId)) form.value.attachments.push(up);
  } catch (e) {
    error.value = (e as Error).message;
  }
}

function removeAttachment(i: number) {
  form.value.attachments.splice(i, 1);
}

/** 新载体行的 item_id 允许先留空再填；空 id 在提交时会被拦下（不当成「静默丢弃」）。 */
function addCarrier() {
  const row: ChildRow = { kind: 'article', itemId: '' };
  form.value.children.push(row);
}

function move(i: number, d: number) {
  const j = i + d;
  const arr = form.value.children;
  if (j < 0 || j >= arr.length) return;
  const t = arr[i]!;
  arr[i] = arr[j]!;
  arr[j] = t;
}

function removeChild(i: number) {
  form.value.children.splice(i, 1);
}

function durationSecOf(): number {
  const raw = durationMin.value.trim();
  if (raw === '') return 0;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.round(n * 60);
}

async function submit() {
  error.value = '';
  notice.value = '';
  const f = form.value;
  const blank = f.children.findIndex((c) => c.itemId.trim() === '');
  if (blank >= 0) {
    error.value = `第 ${blank + 1} 个载体的 item_id 不能为空（不需要就删掉这行）`;
    return;
  }
  f.durationSec = durationSecOf();
  busy.value = true;
  try {
    const { opts, repo } = await bootstrap();
    const out = await saveContainer({ adapters: opts.adapters, repo, nodeBaseUrl: opts.nodeBaseUrl }, f);
    if (out.ledgerState === 'sent') {
      uni.showToast({ title: out.created ? '已创建' : '已更新', icon: 'success' });
      setTimeout(() => uni.navigateBack(), 600);
      return;
    }
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
.title { display: block; font-size: 20px; font-weight: 600; margin-bottom: 6px; }
.field { margin-bottom: 14px; }
.section { margin-top: 18px; padding-top: 12px; border-top: 1px solid #eeeeee; }
.shead { display: flex; justify-content: space-between; align-items: center; }
.label { display: block; font-size: 14px; color: #666666; margin-bottom: 6px; }
.hint { display: block; font-size: 12px; color: #999999; margin-top: 4px; }
.input { border: 1px solid #eeeeee; border-radius: 6px; padding: 8px; font-size: 14px; }
.area { border: 1px solid #eeeeee; border-radius: 6px; padding: 8px; width: 100%; height: 220px; font-size: 14px; }
.area-sm { border: 1px solid #eeeeee; border-radius: 6px; padding: 8px; width: 100%; height: 80px; font-size: 14px; }
.chips { display: flex; flex-wrap: wrap; }
.chip { padding: 4px 14px; border: 1px solid #dddddd; border-radius: 14px; margin: 0 10px 6px 0; color: #666666; font-size: 13px; }
.chip-on { border-color: #2b6cb0; color: #2b6cb0; }
.card { border: 1px solid #eeeeee; border-radius: 8px; padding: 10px; margin-bottom: 12px; }
.chead { display: flex; justify-content: space-between; align-items: center; }
.row { display: flex; align-items: center; justify-content: space-between; padding: 8px 0; border-bottom: 1px solid #f5f5f5; }
.val { flex: 1; font-size: 14px; color: #333333; }
.act { color: #2b6cb0; font-size: 13px; padding: 0 6px; }
.del { color: #c53030; font-size: 13px; padding: 0 6px; }
.add { display: block; color: #2b6cb0; font-size: 14px; padding: 6px 0; }
.error { display: block; color: #c53030; font-size: 13px; margin: 8px 0; }
.notice { display: block; color: #b7791f; font-size: 13px; margin: 8px 0; }
.submit { margin-top: 16px; background: #2b6cb0; color: #ffffff; }
</style>