import { describe, expect, it } from 'vitest';

import { setPendingProposalPrefill, takePendingProposalPrefill, type ProposalPrefill } from './govern';

// 条目举报 → 治理页预填往返（#79 §7.4）：set 一次、take 消费即清空，无预填返回 null。
describe('govern proposal prefill', () => {
  it('set 后 take 返回同值并清空', () => {
    const p: ProposalPrefill = { itemId: 'article/aaa', action: 'remove', reason: '用户举报（垃圾广告）' };
    setPendingProposalPrefill(p);
    expect(takePendingProposalPrefill()).toEqual(p);
    expect(takePendingProposalPrefill()).toBeNull();
  });

  it('未设置时 take 返回 null', () => {
    expect(takePendingProposalPrefill()).toBeNull();
  });

  it('后写覆盖前写', () => {
    setPendingProposalPrefill({ itemId: 'course/bbb', action: 'remove', reason: 'r1' });
    setPendingProposalPrefill({ itemId: 'lesson/ccc', action: 'remove', reason: 'r2' });
    expect(takePendingProposalPrefill()).toEqual({ itemId: 'lesson/ccc', action: 'remove', reason: 'r2' });
    expect(takePendingProposalPrefill()).toBeNull();
  });
});
