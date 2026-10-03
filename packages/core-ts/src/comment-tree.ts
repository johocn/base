import type { CommentItem } from './comment';

export interface CommentTreeNode<T = CommentItem> {
  item: T;
  children: CommentTreeNode<T>[];
  depth: number;
  /** 仅楼层根有（1,2,3...），子回复 undefined */
  floorNo?: number;
}

function byCreated<T extends CommentItem>(a: T, b: T): number {
  return a.createdAt - b.createdAt;
}

/**
 * 扁平评论列表 → 楼中楼树
 *
 * 派生规则：
 *  1. replyTo === null → 楼层根（depth=0）
 *  2. replyTo !== null 但 eventId 不在列表里 → 降级为楼层根
 *  3. replyTo 指向的父节点未被挂到任何楼层根（环场景）→ 降级为楼层根
 *  4. 楼层根按 createdAt 升序排序（先发的在上）
 *  5. 同一父节点下 children 按 createdAt 升序（先回的在上）
 *  6. floorNo 仅楼层根有，按楼层根出现顺序从 1 起计
 */
export function buildCommentTree<T extends CommentItem>(list: T[]): CommentTreeNode<T>[] {
  if (list.length === 0) return [];

  // 建所有节点 Map
  const nodeMap = new Map<string, CommentTreeNode<T>>();
  for (const c of list) {
    nodeMap.set(c.eventId, { item: c, children: [], depth: 0 });
  }

  // 第一轮：筛楼层根（replyTo=null 或 replyTo 不在 map 里）
  const rootCandidates: CommentTreeNode<T>[] = [];
  const pendingChildren: CommentTreeNode<T>[] = [];
  for (const c of list) {
    const node = nodeMap.get(c.eventId)!;
    if (c.replyTo === null || c.replyTo === undefined || !nodeMap.has(c.replyTo)) {
      rootCandidates.push(node);
    } else {
      pendingChildren.push(node);
    }
  }

  // 第二轮：pendingChildren 挂到父节点
  // 用 attachedIds Set 追踪哪些节点已经安全挂到楼层根树下
  const attachedIds = new Set<string>();
  for (const root of rootCandidates) attachedIds.add(root.item.eventId);

  for (const child of pendingChildren) {
    const parent = nodeMap.get(child.item.replyTo!);
    if (!parent) {
      rootCandidates.push(child);
      attachedIds.add(child.item.eventId);
      continue;
    }
    // 父节点已挂到楼层根树下（是 root 或 root 的后代）→ 安全挂接
    if (attachedIds.has(parent.item.eventId)) {
      child.depth = parent.depth + 1;
      parent.children.push(child);
      attachedIds.add(child.item.eventId);
    } else {
      // 父节点没挂 → 环或悬空链 → 降级为楼层根
      rootCandidates.push(child);
      attachedIds.add(child.item.eventId);
    }
  }

  // 楼层根按 createdAt 升序
  rootCandidates.sort((a, b) => byCreated(a.item, b.item));

  // 同一父节点下 children 也按 createdAt 升序
  const sortChildren = (node: CommentTreeNode<T>) => {
    node.children.sort((a, b) => byCreated(a.item, b.item));
    for (const child of node.children) sortChildren(child);
  };
  for (const root of rootCandidates) sortChildren(root);

  // 分配 floorNo（仅楼层根）
  for (let i = 0; i < rootCandidates.length; i++) {
    rootCandidates[i]!.floorNo = i + 1;
  }

  return rootCandidates;
}
