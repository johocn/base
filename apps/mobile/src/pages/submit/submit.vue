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
      <view class="toolbar">
        <view
          v-for="b in PARAGRAPH_BUTTONS"
          :key="b.key"
          class="tool"
          @click="applyTool(b.action)"
        >{{ b.label }}</view>
        <view class="tool-divider" />
        <view
          v-for="b in INLINE_BUTTONS"
          :key="b.key"
          class="tool"
          @click="applyTool(b.action)"
        >{{ b.label }}</view>
        <view class="tool-divider" />
        <view
          v-for="b in COLOR_BUTTONS"
          :key="b.key"
          class="tool tool-color"
          :title="b.hint"
          @click="applyTool(b.action)"
        >{{ b.label }}<text class="tool-note">{{ b.hint }}</text></view>
      </view>
      <view :prop="caretCmd" :change:prop="caretBridge.setCaret">
        <textarea
          id="body-caret-anchor"
          ref="bodyRef"
          v-model="bodyMd"
          class="area"
          placeholder="正文内容"
          :focus="bodyFocus"
        />
      </view>
      <text class="hint">正文以 Markdown 源文本保存，与课时同口径；支持 [文字]{.c-red} 变色</text>
      <text class="preview-label">预览</text>
      <rich-text :nodes="previewHtml" class="preview" />
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
import { computed, nextTick, ref } from 'vue';
import { onLoad } from '@dcloudio/uni-app';

import { renderMarkdown } from '../../core/markdown';
import { resolveCaret } from '../../core/editor-caret';
import {
  COLOR_BUTTONS,
  INLINE_BUTTONS,
  PARAGRAPH_BUTTONS,
  applyToolbar,
  type ToolbarAction,
} from '../../core/markdown-toolbar';
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

/** 正文编辑：工具栏产出源文本标记；预览是只读派生，不落库（保存口径零改动） */
const bodyRef = ref<{ $el?: Element } | null>(null);
const bodyFocus = ref(false);
/** renderjs 台账：App 视图层上报的真实光标；H5 不用（走原生 DOM 选区） */
const caretLedger = ref<{ start: number; end: number } | null>(null);
/** 逻辑层 → 视图层的写光标指令；每次换新对象以触发 `:change:prop` */
const caretCmd = ref<{ start: number; end: number; text: string } | null>(null);
/**
 * renderjs 桥在 App 视图层执行，不进入逻辑层组件实例；这里给模板一个同形空实现占位：
 * H5 无 renderjs、该占位会被真调用（no-op），App 上 uni 模板编译器按模块名解析、此值不参与运行。
 */
const caretBridge = {
  setCaret: (_value: { start: number; end: number; text: string }): void => undefined,
};
const previewHtml = computed(() => renderMarkdown(bodyMd.value));

/** H5：组件根节点下即原生 textarea，用 ref 拿真实选区；其它端无 DOM，恒返回 null */
function bodyTextarea(): HTMLTextAreaElement | null {
  const root = bodyRef.value?.$el;
  if (!root || typeof root.querySelector !== 'function') return null;
  return root.querySelector('textarea') as HTMLTextAreaElement | null;
}

/** renderjs 上报入口（App）：真实光标存台账 */
function onCaret(c: { start: number; end: number }) {
  caretLedger.value = { start: c.start, end: c.end };
}
defineExpose({ onCaret });

/** 工具栏动作：把变换结果写回源文本，并把光标/选区落到新位置。 */
function applyTool(action: ToolbarAction) {
  const src = bodyMd.value;
  const field = bodyTextarea();
  const live = field ? { start: field.selectionStart, end: field.selectionEnd } : null;
  const pick = resolveCaret(live, caretLedger.value, src.length);
  const r = applyToolbar(src, pick.caret.start, pick.caret.end, action);
  bodyMd.value = r.text;
  // 台账就地前移：setCaret 之后真机上的上报是异步的，不能等它
  caretLedger.value = { start: r.start, end: r.end };
  // 视图层写回（App 走 renderjs；H5 由下面的原生直写生效）
  caretCmd.value = { start: r.start, end: r.end, text: r.text };
  if (pick.source === 'fallback') {
    uni.showToast({ title: '未取到光标，已插入到正文末尾', icon: 'none' });
  }
  bodyFocus.value = false;
  nextTick(() => {
    bodyFocus.value = true;
    const el = bodyTextarea();
    if (el) {
      // H5 直写原生节点：绕开组件 model→DOM 的 100ms 防抖，避免光标被重置到末尾
      el.value = r.text;
      el.focus();
      el.setSelectionRange(r.start, r.end);
    }
  });
}

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

<!-- renderjs 桥：App 视图层声明 `caretBridge`（uni 编译器改写为 <renderjs name=…>，vue-tsc 不参与运行） -->
<script module="caretBridge" lang="renderjs" src="src/core/caret-bridge.renderjs.js"></script>

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
.toolbar { display: flex; flex-wrap: wrap; margin-bottom: 6px; }
.tool { padding: 4px 10px; margin: 0 6px 6px 0; border: 1px solid #dddddd; border-radius: 6px; color: #444444; font-size: 13px; }
.tool-divider { width: 1px; margin: 0 4px 6px; background: #eeeeee; }
.tool-color { display: flex; align-items: baseline; }
.tool-note { margin-left: 3px; color: #999999; font-size: 10px; }
.preview-label { display: block; margin: 10px 0 4px; color: #666666; font-size: 14px; }
.preview { display: block; padding: 8px; border: 1px solid #f0f0f0; border-radius: 6px; font-size: 14px; line-height: 1.8; color: #333333; }

/* 正文预览变色：7 个枚举类（#44 §6）。c-mark 只改背景、不覆盖字色 */
.c-red { color: #C53030; }
.c-orange { color: #B7791F; }
.c-green { color: #2F855A; }
.c-blue { color: #2B6CB0; }
.c-purple { color: #6B46C1; }
.c-gray { color: #718096; }
.c-mark { background: #FFF3BF; }
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