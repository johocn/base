<template>
  <view class="wrap">
    <text class="title">{{ isEdit ? '编辑课程' : '新建课程' }}</text>
    <text class="hint">条目 id：{{ form.itemId }}（不可改，它就是身份）</text>

    <view class="field">
      <text class="label">标题</text>
      <input v-model="form.title" class="input" placeholder="1–200 字" />
    </view>

    <view class="field">
      <text class="label">简介</text>
      <textarea v-model="form.digest" class="area-sm" placeholder="课程简介（可空）" />
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
      <text class="hint">单文件 ≤ 8 MiB；内容寻址，同字节重复上传只存一份</text>
    </view>

    <view class="section">
      <view class="shead">
        <text class="label">课时清单</text>
        <text class="add" @click="addLesson">+ 加一课</text>
      </view>
      <text v-if="form.children.length === 0" class="hint">还没有课时；保存后本课程为空课时列表</text>
      <view v-for="(c, i) in form.children" :key="c.itemId" class="row">
        <view class="row-main" @click="openLesson(c)">
          <text class="val">第 {{ i + 1 }} 讲 · {{ lessonTitle(c.itemId) }}</text>
          <text class="sub">{{ c.itemId }}</text>
        </view>
        <text class="act" @click="move(i, -1)">上移</text>
        <text class="act" @click="move(i, 1)">下移</text>
        <text class="del" @click="removeChild(i)">删除</text>
      </view>
      <text class="hint">顺序即「第 N 讲」；空课时也会占位，不要靠删行来隐藏</text>
    </view>

    <text v-if="error" class="error">{{ error }}</text>
    <text v-if="pickBlocked" class="hint">{{ pickBlocked }}</text>
    <text v-if="notice" class="notice">{{ notice }}</text>

    <button class="submit" :disabled="busy" @click="submit">{{ busy ? '提交中…' : '保存' }}</button>
  </view>
</template>

<script setup lang="ts">
import { onLoad } from '@dcloudio/uni-app';
import { computed, ref } from 'vue';

import { DIFFICULTY_BASIC, DIFFICULTY_CHOICES, DIFFICULTY_INTRO } from '../../core/attrs';
import { uploadBlob } from '../../core/blob';
import { loadContainerForm, saveContainer, startNewCourse, type ChildRow, type ContainerForm } from '../../core/course-edit';
import { recordEditFailure } from '../../core/editlog';
import { UNKNOWN_FLAGS, canPickFile, pickBlockedReason, type CapabilityFlags } from '../../core/selfcheck';
import { newLessonID } from '../../core/submit';
import { bootstrap, type AppContext } from '../../platform';
import { pickLocalFile, type PickedFile } from '../../platform/uni';

const form = ref<ContainerForm>(startNewCourse());
const durationMin = ref('');
const isEdit = ref(false);
const lessonTitles = ref<Record<string, string>>({});
const busy = ref(false);
const error = ref('');
const notice = ref('');

/** 能力标志：启动时只有 cryptoOk / pickOk 有值，其余 unknown（unknown 不降级，照常尝试） */
const caps = ref<CapabilityFlags>(UNKNOWN_FLAGS);
const pickBlocked = computed(() => pickBlockedReason(caps.value));
const canPick = computed(() => canPickFile(caps.value));

/** bootstrap 上下文：日志出口要拿 `adapters.fs` 与 `opts.workDir`，故在此持有 */
let ctx: AppContext | null = null;

onLoad(async (query) => {
  const courseId = String((query as Record<string, string> | undefined)?.courseId ?? '');
  try {
    ctx = await bootstrap();
    caps.value = ctx.capabilities;
    if (courseId !== '') {
      isEdit.value = true;
      form.value = await loadContainerForm(ctx.repo, courseId, 'course');
      durationMin.value = form.value.durationSec > 0 ? String(Math.round(form.value.durationSec / 60)) : '';
    }
    lessonTitles.value = Object.fromEntries((await ctx.repo.listItems()).map((i) => [i.itemId, i.title || i.itemId]));
  } catch (e) {
    error.value = (e as Error).message;
  }
});

function difficultyLabel(d: string): string {
  if (d === DIFFICULTY_INTRO) return '入门';
  if (d === DIFFICULTY_BASIC) return '基础';
  return '进阶';
}

/** 再点一次取消选择（空串 = 不产该属性行） */
function toggleDifficulty(d: string) {
  form.value.difficulty = form.value.difficulty === d ? '' : d;
}

/** 失败落本地日志（`workDir/edit-surface.log`）；取消不落，日志写失败静默不影响主流程。 */
async function logFail(stage: 'pick' | 'upload', e: unknown) {
  if (!ctx) return;
  await recordEditFailure(ctx.adapters.fs, ctx.opts.workDir, stage, String((e as Error)?.message ?? e));
}

/** 选文件 → 上传拿 blob_id；取消返回 null。封面与附件共用一条上传路径。 */
async function uploadOne(): Promise<{ blobId: string; name: string } | null> {
  let picked: PickedFile | null;
  try {
    picked = await pickLocalFile();
  } catch (e) {
    await logFail('pick', e);
    throw e;
  }
  if (!picked) return null;
  const { opts, repo } = await bootstrap();
  let blobId: string;
  try {
    blobId = await uploadBlob(
      { adapters: opts.adapters, repo, nodeBaseUrl: opts.nodeBaseUrl },
      picked.bytes,
      picked.name,
    );
  } catch (e) {
    await logFail('upload', e);
    throw e;
  }
  return { blobId, name: picked.name };
}

async function pickCover() {
  if (!canPick.value) {
    error.value = pickBlocked.value;
    return;
  }
  error.value = '';
  try {
    const up = await uploadOne();
    if (up) form.value.cover = up.blobId;
  } catch (e) {
    error.value = (e as Error).message;
    await logFail('pick', e);
  }
}

async function addAttachment() {
  if (!canPick.value) {
    error.value = pickBlocked.value;
    return;
  }
  error.value = '';
  try {
    const up = await uploadOne();
    // 内容寻址：同 blob 只留一行（重复上传同一文件不该出现两条附件行）
    if (up && !form.value.attachments.some((a) => a.blobId === up.blobId)) form.value.attachments.push(up);
  } catch (e) {
    error.value = (e as Error).message;
    await logFail('pick', e);
  }
}

function removeAttachment(i: number) {
  form.value.attachments.splice(i, 1);
}

/** 加一课：id 用当前课程 id 立刻拼出（课程 id 在页面打开时就固定了），随后跳课时编辑页 */
function addLesson() {
  const id = newLessonID(form.value.itemId);
  const row: ChildRow = { kind: 'lesson', itemId: id };
  form.value.children.push(row);
  openLesson(row);
}

function openLesson(c: ChildRow) {
  uni.navigateTo({
    url: `/pages/lesson/edit?courseId=${encodeURIComponent(form.value.itemId)}&lessonId=${encodeURIComponent(c.itemId)}`,
  });
}

function lessonTitle(itemId: string): string {
  return lessonTitles.value[itemId] ?? '（新课时，未保存）';
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

/** 分钟输入 → 秒（槽位收秒数字符串，本册 §2.1）；非法一律归 0（= 不产该行） */
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
    // pending 会自动补发；failed 需回「我的条目」删除后重投
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
.sub { display: block; font-size: 11px; color: #aaaaaa; }
.input { border: 1px solid #eeeeee; border-radius: 6px; padding: 8px; font-size: 14px; }
.area-sm { border: 1px solid #eeeeee; border-radius: 6px; padding: 8px; width: 100%; height: 90px; font-size: 14px; }
.chips { display: flex; flex-wrap: wrap; }
.chip { padding: 4px 14px; border: 1px solid #dddddd; border-radius: 14px; margin: 0 10px 6px 0; color: #666666; font-size: 13px; }
.chip-on { border-color: #2b6cb0; color: #2b6cb0; }
.row { display: flex; align-items: center; justify-content: space-between; padding: 8px 0; border-bottom: 1px solid #f5f5f5; }
.row-main { flex: 1; }
.val { flex: 1; font-size: 14px; color: #333333; }
.act { color: #2b6cb0; font-size: 13px; padding: 0 6px; }
.del { color: #c53030; font-size: 13px; padding: 0 6px; }
.add { display: block; color: #2b6cb0; font-size: 14px; padding: 6px 0; }
.error { display: block; color: #c53030; font-size: 13px; margin: 8px 0; }
.notice { display: block; color: #b7791f; font-size: 13px; margin: 8px 0; }
.submit { margin-top: 16px; background: #2b6cb0; color: #ffffff; }
</style>