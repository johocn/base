import { computed, ref } from 'vue';
import type { ContributorItem } from './contribution';
import { roster } from './contribution';
import { decodeUtf8 } from './sync';

/**
 * 三页复用的作者栏逻辑（article / course-detail / lesson-detail）。
 * 消费方只需要：const { authorDisplay, fetchAuthorBar, avatarHue } = useAuthorBar(authorId)
 * 然后在合适的时机调 fetchAuthorBar({ adapters, repo, nodeBaseUrl })——内部处理所有降级链。
 */
export interface UseAuthorBarOpts {
  adapters: { http: { get: (u: string) => Promise<{ status: number; body: Uint8Array }> } };
  repo: unknown;
  nodeBaseUrl: string;
}

export function useAuthorBar(initialAuthorId?: string) {
  const authorId = ref(initialAuthorId ?? '');
  const rosterMap = ref(new Map<string, ContributorItem>());
  const profileNameCache = ref(new Map<string, string>());

  /** 稳定 HSL 色相（纯本地哈希，零网络）——也 export 供模板直接用 */
  function avatarHue(hex: string): number {
    let h = 0;
    for (let i = 0; i < hex.length; i++) h = (h * 31 + hex.charCodeAt(i)) >>> 0;
    return h % 360;
  }

  /** 昵称三级降级：名册命中 → profile API 命中 → id[:8] 回退 */
  const authorDisplay = computed(() => {
    if (!authorId.value) return { name: '', count: 0, hue: 0 };
    const hit = rosterMap.value.get(authorId.value);
    if (hit) return { name: hit.name, count: hit.count, hue: avatarHue(authorId.value) };
    const pName = profileNameCache.value.get(authorId.value);
    if (pName) return { name: pName, count: 0, hue: avatarHue(authorId.value) };
    return { name: authorId.value.slice(0, 8), count: 0, hue: avatarHue(authorId.value) };
  });

  /** 第三级降级：roster miss → 单条 profile API 补查；失败静默 */
  async function resolveAuthorName(aid: string, opts: UseAuthorBarOpts) {
    if (!aid || rosterMap.value.has(aid) || profileNameCache.value.has(aid)) return;
    try {
      const res = await opts.adapters.http.get(`${opts.nodeBaseUrl}/v1/profile/${aid}`);
      if (res.status !== 200) return;
      const json = JSON.parse(decodeUtf8(res.body)) as { name?: string };
      if (json.name) profileNameCache.value.set(aid, json.name);
    } catch { /* 静默：404 / 无网络 → 继续回退 id[:8] */ }
  }

  /** 拉贡献名册 → 缓存 profile 回退 → 触发 computed 更新；全失败静默 */
  async function fetchAuthorBar(opts: UseAuthorBarOpts) {
    if (!authorId.value) return;
    try {
      const list = await roster({ adapters: opts.adapters, repo: opts.repo as never, nodeBaseUrl: opts.nodeBaseUrl });
      rosterMap.value = new Map(list.map((c) => [c.id, c]));
    } catch { /* 静默：无网络 / 节点未配置 → author-bar 自然降级 */ }
    void resolveAuthorName(authorId.value, opts);
  }

  function setAuthorId(id: string) {
    authorId.value = id;
  }

  return { authorId, authorDisplay, avatarHue, fetchAuthorBar, setAuthorId };
}
