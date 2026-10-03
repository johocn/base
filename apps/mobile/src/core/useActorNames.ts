import { ref } from 'vue';
import type { Adapters } from '@base/core-ts/platform/adapter';

import { roster } from './contribution';
import { decodeUtf8 } from './sync';

/**
 * 多作者昵称/头像解析（评论页、私信会话页共用）。
 * 消费方：const { authorName, loadNames } = useActorNames()，头像底色直接用 avatarBg()。
 */
export interface UseActorNamesOpts {
  adapters: Adapters;
  repo: unknown;
  nodeBaseUrl: string;
}

/** 稳定 HSL 色相（纯本地哈希，零网络）。 */
export function avatarHue(seed: string): number {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return h % 360;
}

/** 头像底色：同 seed 恒同色。 */
export function avatarBg(seed: string): string {
  return `hsl(${avatarHue(seed)}, 65%, 60%)`;
}

export function useActorNames() {
  /** actor → 昵称；跨分页累积 */
  const names = ref<Record<string, string>>({});

  /** 昵称：未解析到就退化成 id 前 8 位（不显示空、不显示完整 hex）。 */
  function authorName(actor: string): string {
    return names.value[actor] || actor.slice(0, 8);
  }

  /** 昵称三级降级：名册命中 → profile 补查 → id[:8]。任一级失败都静默，不挡列表。 */
  async function loadNames(actors: string[], opts: UseActorNamesOpts) {
    const ids = [...new Set(actors)].filter((id) => id && !names.value[id]);
    if (ids.length === 0) return;
    const map: Record<string, string> = {};
    try {
      const list = await roster({ adapters: opts.adapters, repo: opts.repo as never, nodeBaseUrl: opts.nodeBaseUrl });
      for (const c of list) if (c.name) map[c.id] = c.name;
    } catch {
      /* 静默：无网络 / 节点未配置 → 继续走 profile 与 id[:8] */
    }
    await Promise.all(
      ids.map(async (id) => {
        if (map[id]) return;
        try {
          const res = await opts.adapters.http.get(`${opts.nodeBaseUrl}/v1/profile/${id}`);
          if (res.status !== 200) return;
          const json = JSON.parse(decodeUtf8(res.body)) as { name?: string };
          if (json.name) map[id] = json.name;
        } catch {
          /* 静默：404 / 无网络 → 继续回退 id[:8] */
        }
      }),
    );
    names.value = { ...names.value, ...map };
  }

  return { names, authorName, loadNames };
}
