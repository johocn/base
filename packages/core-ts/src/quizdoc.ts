/**
 * 题库编辑器与 `question_json` 之间的转换（本册 §5.2）。
 *
 * 结构化表单是**唯一出口**，不提供 JSON 手写框。只依赖 `core/types` 与 `core/quiz`，不 import 'uni'。
 *
 * 键序固定**不是契约约束**——节点把整串原样存库、从不重新序列化，字节序由客户端自定。
 * 固定键序只为让「重投同一份内容」不产生无意义的字节抖动（否则每次重开编辑器都会得到不同的
 * `content_hash`）。故测试只验自家 build → parse 往返，不写「与 Go 输出逐字节一致」的断言。
 */
import { parseQuestionDoc } from './quiz';
import type { Question, QuestionDoc } from './types';

/** 编辑器里的一道题（草稿态）：`answer` 为正确项下标，`-1` 表示未选。 */
export interface QuestionDraft {
  q: string;
  options: string[];
  answer: number;
  explain: string;
}

/** 新建题目的默认草稿：2 个空选项、未选答案（服务端要求 `options ≥ 2`）。 */
export function emptyDraft(): QuestionDraft {
  return { q: '', options: ['', ''], answer: -1, explain: '' };
}

/**
 * 生成 `question_json`。任一题不合法即返回 null（页面据此禁用提交）。
 *
 * 生成前的本地约束（比解析器严，因为编辑器不该产出解析器勉强容忍的东西）：
 * 题干去空白后非空、选项去空白后全部非空且 ≥ 2 个、`answer` 为合法下标。
 */
export function buildQuestionJSON(drafts: QuestionDraft[]): string | null {
  if (drafts.length === 0) return null;
  const questions: Question[] = [];
  for (const d of drafts) {
    const q = d.q.trim();
    const options = d.options.map((o) => o.trim());
    if (q === '') return null;
    if (options.length < 2) return null;
    if (options.some((o) => o === '')) return null;
    if (!Number.isInteger(d.answer) || d.answer < 0 || d.answer >= options.length) return null;
    questions.push({ q, options, answer: d.answer, explain: d.explain.trim() });
  }
  // 键序由对象字面量的书写顺序决定（JS 保证字符串键的插入序）：
  // 顶层 schema_version → questions；每题 q → options → answer → explain（explain 必出，空串也输出）。
  const doc: QuestionDoc = { schema_version: 1, questions };
  const raw = JSON.stringify(doc as unknown as Record<string, unknown>);
  // 往返自检：直接复用 core/quiz.ts 的解析口径，不另写一套规则（本册 §5.2）
  return parseQuestionDoc(raw) === null ? null : raw;
}

/** 台账里存的 `question_json` → 编辑器草稿（更新模式回填）。解析失败返回空数组。 */
export function draftsFromQuestionJSON(raw: string): QuestionDraft[] {
  const qs = parseQuestionDoc(raw);
  if (qs === null) return [];
  return qs.map((q) => ({ q: q.q, options: [...q.options], answer: q.answer, explain: q.explain }));
}