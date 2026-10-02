import { describe, expect, it } from 'vitest';

import { gradeAnswer, parseQuestionDoc, shuffleAll, shuffleQuestion } from './quiz';
import type { Question } from './types';

const GOOD =
  '{"schema_version":1,"questions":[{"q":"标识是什么？","options":["路径","内容哈希","序号"],"answer":1,"explain":"哈希即标识"}]}';

const one: Question = { q: '标识是什么？', options: ['路径', '内容哈希', '序号'], answer: 1, explain: '哈希即标识' };

describe('parseQuestionDoc', () => {
  it('合法文档返回题目数组', () => {
    const got = parseQuestionDoc(GOOD);
    expect(got).toHaveLength(1);
    expect(got?.[0]).toEqual(one);
  });

  it('非法文档一律返回 null（调用方据此提示不支持且不写记录）', () => {
    expect(parseQuestionDoc('不是 JSON')).toBeNull();
    expect(parseQuestionDoc('{"schema_version":2,"questions":[]}')).toBeNull();
    expect(parseQuestionDoc('{"schema_version":1,"questions":[]}')).toBeNull();
    expect(parseQuestionDoc('{"schema_version":1,"questions":[{"q":"甲","options":["只有一个"],"answer":0}]}')).toBeNull();
    expect(parseQuestionDoc('{"schema_version":1,"questions":[{"q":"甲","options":["a","b"],"answer":5}]}')).toBeNull();
    expect(parseQuestionDoc('{"schema_version":1,"questions":[{"q":"甲","options":["a","b"],"answer":-1}]}')).toBeNull();
  });

  it('缺 explain 时补空串，不判为非法', () => {
    const got = parseQuestionDoc('{"schema_version":1,"questions":[{"q":"甲","options":["a","b"],"answer":0}]}');
    expect(got?.[0].explain).toBe('');
  });
});

describe('shuffleQuestion', () => {
  it('同一 seed 结果稳定（同题顺序不会来回变）', () => {
    expect(shuffleQuestion(one, 42)).toEqual(shuffleQuestion(one, 42));
  });

  it('选项集合不变，且 answerIndex 指向正确文本', () => {
    const s = shuffleQuestion(one, 7);
    expect([...s.options].sort()).toEqual([...one.options].sort());
    expect(s.options[s.answerIndex]).toBe('内容哈希');
  });

  it('shuffleAll 按 item_id 派生种子，同一题库两次结果一致', () => {
    const a = shuffleAll([one, one], 'lesson:cid');
    const b = shuffleAll([one, one], 'lesson:cid');
    expect(a).toEqual(b);
  });
});

describe('gradeAnswer', () => {
  it('选中下标即判定', () => {
    const s = shuffleQuestion(one, 7);
    expect(gradeAnswer(s, s.answerIndex)).toBe(true);
    expect(gradeAnswer(s, (s.answerIndex + 1) % s.options.length)).toBe(false);
  });
});