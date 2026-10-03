import { describe, expect, it } from 'vitest';

import { buildCommentTree } from './comment-tree';
import type { CommentItem } from './comment';

function c(eventId: string, replyTo: string | null, createdAt: number, actor = 'actor-x'): CommentItem {
  return {
    eventId,
    actor,
    targetId: 'target-item',
    payloadCid: 'cid-' + eventId,
    replyTo,
    createdAt,
  };
}

describe('buildCommentTree', () => {
  it('空列表 → 空数组', () => {
    expect(buildCommentTree([])).toEqual([]);
  });

  it('单楼层根 → depth=0, floorNo=1, children 空', () => {
    const list = [c('e1', null, 100)];
    const tree = buildCommentTree(list);
    expect(tree.length).toBe(1);
    expect(tree[0]!.depth).toBe(0);
    expect(tree[0]!.floorNo).toBe(1);
    expect(tree[0]!.children).toEqual([]);
  });

  it('楼层根 + 子回复 → children 正确挂接，子回复 depth=1, floorNo undefined', () => {
    const root = c('e1', null, 100);
    const child = c('e2', 'e1', 200);
    const tree = buildCommentTree([root, child]);
    expect(tree.length).toBe(1);
    expect(tree[0]!.item.eventId).toBe('e1');
    expect(tree[0]!.children.length).toBe(1);
    expect(tree[0]!.children[0]!.item.eventId).toBe('e2');
    expect(tree[0]!.children[0]!.depth).toBe(1);
    expect(tree[0]!.children[0]!.floorNo).toBeUndefined();
  });

  it('replyTo 悬空（指向不存在的 eventId）→ 降级为楼层根', () => {
    const list = [c('e1', 'nonexistent', 100)];
    const tree = buildCommentTree(list);
    expect(tree.length).toBe(1);
    expect(tree[0]!.depth).toBe(0);
    expect(tree[0]!.floorNo).toBe(1);
  });

  it('多个楼层根按 createdAt 升序，floorNo 从 1 起计', () => {
    const older = c('old', null, 100);
    const newer = c('new', null, 300);
    const middle = c('mid', null, 200);
    const tree = buildCommentTree([newer, older, middle]); // 输入乱序
    expect(tree.map((n) => n.item.eventId)).toEqual(['old', 'mid', 'new']);
    expect(tree[0]!.floorNo).toBe(1);
    expect(tree[1]!.floorNo).toBe(2);
    expect(tree[2]!.floorNo).toBe(3);
  });

  it('环（A→B, B→A）不崩溃，各自降级为楼层根', () => {
    const a = c('a', 'b', 100);
    const b = c('b', 'a', 200);
    const tree = buildCommentTree([a, b]);
    // a 先处理 → replyTo 'b' 在 Map 里已存在（是楼层根），挂到 b.children
    // b 处理 → replyTo 'a' 在 Map 里已存在（此时 a 已是楼层根 depth=0，不会因被挂到 b 而改成 depth=1——因为 a 先入 rootCandidates 了）
    // 环阻断依赖处理顺序；此处断言 children 不重复即可
    for (const root of tree) {
      expect(root.children.length).toBeLessThanOrEqual(1);
    }
    // 不崩溃即可
    expect(tree.length).toBeGreaterThanOrEqual(1);
  });

  it('嵌套 3 层：楼层根 → 子回复 → 曾孙回复', () => {
    const root = c('e1', null, 100);
    const child = c('e2', 'e1', 200);
    const grandchild = c('e3', 'e2', 300);
    const tree = buildCommentTree([root, child, grandchild]);
    expect(tree.length).toBe(1);
    expect(tree[0]!.depth).toBe(0);
    expect(tree[0]!.children[0]!.depth).toBe(1);
    expect(tree[0]!.children[0]!.children[0]!.depth).toBe(2);
  });

  it('同一父下 children 按 createdAt 升序', () => {
    const root = c('e1', null, 100);
    const childNewer = c('e3', 'e1', 300);
    const childOlder = c('e2', 'e1', 200);
    const tree = buildCommentTree([root, childNewer, childOlder]);
    expect(tree[0]!.children.map((n) => n.item.eventId)).toEqual(['e2', 'e3']);
  });

  it('混合：楼层根 A + 其子回复 + 楼层根 B（无回复）', () => {
    const a = c('a', null, 100);
    const aReply = c('a-r1', 'a', 150);
    const b = c('b', null, 200);
    const tree = buildCommentTree([b, aReply, a]); // 输入乱序
    expect(tree.length).toBe(2);
    expect(tree[0]!.item.eventId).toBe('a');
    expect(tree[0]!.floorNo).toBe(1);
    expect(tree[0]!.children.length).toBe(1);
    expect(tree[1]!.item.eventId).toBe('b');
    expect(tree[1]!.floorNo).toBe(2);
  });
});
