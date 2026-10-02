// 答题的纯逻辑：question_json 解析、选项稳定打乱、判分。
// 打乱放在客户端（spec §6.4）：question_json 的选项顺序是显示顺序，不下发打乱指令。
import type { Question, QuestionDoc } from './types';

/** 解析 question_json；任何格式不符返回 null（页面据此提示「题目格式不支持」且不写记录）。 */
export function parseQuestionDoc(raw: string): Question[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const doc = parsed as Partial<QuestionDoc>;
  if (doc.schema_version !== 1) return null;
  if (!Array.isArray(doc.questions) || doc.questions.length === 0) return null;
  const out: Question[] = [];
  for (const q of doc.questions) {
    if (typeof q?.q !== 'string' || q.q === '') return null;
    if (!Array.isArray(q.options) || q.options.length < 2) return null;
    if (!q.options.every((o) => typeof o === 'string')) return null;
    if (typeof q.answer !== 'number' || !Number.isInteger(q.answer)) return null;
    if (q.answer < 0 || q.answer >= q.options.length) return null;
    out.push({
      q: q.q,
      options: q.options.map((o) => String(o)),
      answer: q.answer,
      explain: typeof q.explain === 'string' ? q.explain : '',
    });
  }
  return out;
}

/** FNV-1a：由 item_id 派生稳定种子，保证同一题库每次进入的选项顺序一致。 */
export function seedFrom(itemId: string): number {
  let h = 2166136261;
  for (let i = 0; i < itemId.length; i++) {
    h ^= itemId.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** mulberry32：小而确定的伪随机，不依赖 Math.random（否则顺序不可复现）。 */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface ShuffledQuestion {
  q: string;
  /** 显示顺序的选项文本 */
  options: string[];
  /** 正确项在 options 里的显示下标 */
  answerIndex: number;
  explain: string;
}

export function shuffleQuestion(question: Question, seed: number): ShuffledQuestion {
  const order = question.options.map((_, i) => i);
  const rand = rng(seed);
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const tmp = order[i]!;
    order[i] = order[j]!;
    order[j] = tmp;
  }
  return {
    q: question.q,
    options: order.map((i) => question.options[i]!),
    answerIndex: order.indexOf(question.answer),
    explain: question.explain,
  };
}

export function shuffleAll(questions: Question[], itemId: string): ShuffledQuestion[] {
  const base = seedFrom(itemId);
  return questions.map((q, i) => shuffleQuestion(q, base + i));
}

export function gradeAnswer(q: ShuffledQuestion, pickedIndex: number): boolean {
  return pickedIndex === q.answerIndex;
}