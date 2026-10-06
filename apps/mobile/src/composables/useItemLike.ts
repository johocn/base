/**
 * 阅读页条目点赞（#79 §7.3）：计数读本地 items.like_count（离线可见），高亮读 like_out 台账；
 * 点击在线发 like.v1，成功后乐观 ±1 写回本地；离线/失败由 LikeError toast，不入待发队列。
 * article 与 lesson 页共用。
 */
import { ref, type Ref } from 'vue';

import { sendLike, type LikeOptions } from '@base/core-ts/like';

export function useItemLike(opts: Ref<LikeOptions | null>, itemId: Ref<string>) {
  const likeCount = ref(0);
  const liked = ref(false);
  const busy = ref(false); // 防抖：发送中禁点

  /** 进页读本地（catalog 同步落库后下次进页自动校正） */
  async function loadLocal() {
    if (!opts.value || itemId.value === '') return;
    likeCount.value = await opts.value.repo.getItemLikeCount(itemId.value);
    liked.value = (await opts.value.repo.getLikeOut(itemId.value)) === 'like';
  }

  /** 在线拉 catalog 回来后校正（catalog 内联 like_count 到达时调用） */
  async function refreshFromCatalog(count: number) {
    likeCount.value = count;
  }

  async function toggle() {
    if (!opts.value || busy.value || itemId.value === '') return;
    const action = liked.value ? 'unlike' : 'like';
    busy.value = true;
    try {
      await sendLike(opts.value, itemId.value, action);
      await opts.value.repo.upsertLikeOut(itemId.value, action);
      await opts.value.repo.adjustItemLikeCount(itemId.value, action === 'like' ? 1 : -1);
      likeCount.value = Math.max(0, likeCount.value + (action === 'like' ? 1 : -1));
      liked.value = action === 'like';
    } catch (e) {
      uni.showToast({ title: e instanceof Error ? e.message : '点赞需联网', icon: 'none' });
    } finally {
      busy.value = false;
    }
  }

  return { likeCount, liked, busy, loadLocal, refreshFromCatalog, toggle };
}
