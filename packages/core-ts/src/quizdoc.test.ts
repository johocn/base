import { describe, expect, it } from 'vitest';

import { buildQuestionJSON, draftsFromQuestionJSON, emptyDraft, type QuestionDraft } from './quizdoc';
import { parseQuestionDoc } from './quiz';

function draft(over: Partial<QuestionDraft> = {}): QuestionDraft {
  return { q: '甲题', options: ['A', 'B'], answer: 1, explain: '因为 B', ...over };
}

describe('quizdoc', () => {
  it('键序固定：顶层 schema_version→questions，每题 q→options→answer→explain', () => {
    const raw = buildQuestionJSON([draft()]);
    expect(raw).toBe('{"schema_version":1,"questions":[{"q":"甲题","options":["A","B"],"answer":1,"explain":"因为 B"}]}');
  });

  it('explain 缺省也照样输出空串；无解析不影响解析回来', () => {
    const raw = buildQuestionJSON([draft({ explain: '' })])!;
    expect(raw).toContain('"explain":""');
    expect(parseQuestionDoc(raw)).toEqual([{ q: '甲题', options: ['A', 'B'], answer: 1, explain: '' }]);
  });

  it('往返一致：build → parse 得到与草稿同构的题组（含中文与多题）', () => {
    const drafts: QuestionDraft[] = [
      draft({ q: '甲', options: ['甲一', '甲二', '甲三'], answer: 2, explain: '' }),
      draft({ q: '乙', options: ['乙一', '乙二'], answer: 0, explain: '乙的解析' }),
    ];
    expect(parseQuestionDoc(buildQuestionJSON(drafts)!)).toEqual([
      { q: '甲', options: ['甲一', '甲二', '甲三'], answer: 2, explain: '' },
      { q: '乙', options: ['乙一', '乙二'], answer: 0, explain: '乙的解析' },
    ]);
  });

  it('本地拦下非法输入：题数 0 / 题干空 / 选项 < 2 / 选项空串 / answer 越界或未选', () => {
    expect(buildQuestionJSON([])).toBeNull();
    expect(buildQuestionJSON([draft({ q: '   ' })])).toBeNull();
    expect(buildQuestionJSON([draft({ options: ['A'] })])).toBeNull();
    expect(buildQuestionJSON([draft({ options: ['A', '  '] })])).toBeNull();
    expect(buildQuestionJSON([draft({ options: ['A', 'B'], answer: -1 })])).toBeNull();
    expect(buildQuestionJSON([draft({ options: ['A', 'B'], answer: 2 })])).toBeNull();
    // 多题里只要有一题不合法，整组不产出
    expect(buildQuestionJSON([draft(), draft({ q: '' })])).toBeNull();
  });

  it('去首尾空白：题干与选项入库即 trim 后形态', () => {
    const raw = buildQuestionJSON([draft({ q: ' 甲题 ', options: [' A ', ' B '] })])!;
    expect(parseQuestionDoc(raw)![0]).toEqual({ q: '甲题', options: ['A', 'B'], answer: 1, explain: '因为 B' });
  });

  it('回填：draftsFromQuestionJSON 是 build 的逆；坏串返回空数组', () => {
    const drafts = [draft({ explain: '' })];
    expect(draftsFromQuestionJSON(buildQuestionJSON(drafts)!)).toEqual(drafts);
    expect(draftsFromQuestionJSON('不是 JSON')).toEqual([]);
    expect(draftsFromQuestionJSON('{"schema_version":2,"questions":[]}')).toEqual([]);
  });

  it('emptyDraft 满足编辑器初始态：2 个空选项、未选答案', () => {
    expect(emptyDraft()).toEqual({ q: '', options: ['', ''], answer: -1, explain: '' });
  });
});