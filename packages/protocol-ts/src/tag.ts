/**
 * 统一标签（#37 册子 §5.2）的**纯编解码段**：三元组的编码/解码与目标形态判定。
 *
 * 本文件是 `internal/protocol/tag.go` 的客户端镜像（编码与形态判定必须逐字符同口径）；
 * **纯函数、零依赖**（不 import 'uni' / 'plus'），可在 Node 下完整测试。
 * 适配器侧（按目标反查、待补标签、治理人资格、打标提交）仍在 `apps/mobile/src/core/tags.ts`。
 */

/** 三元组单段的 rune 上限（与节点 `protocol.TagSegmentMaxRunes` 同值）。 */
export const TAG_SEGMENT_MAX_RUNES = 64;

/**
 * 单段归一化 = 去首尾空白（与节点 `protocol.normalizeTagSegment` 同口径）。
 * **本册不做 NFC/NFD**（2026-09-30 用户定案）：Go 侧无 NFC、仓库不含 `golang.org/x/text`，客户端同步只 trim。
 */
function normalizeTagSegment(s: string): string {
  return s.trim();
}

const TAG_ESCAPE: Record<string, string> = { '/': '%2F', '\\': '%5C', '%': '%25' };

/** 单段转义：`/` `\` `%` 与 C0 控制字符 + DEL 转成 `%XX`（大写十六进制，与 Go 的 `%02X` 一致）。 */
export function encodeTagPathSegment(s: string): string {
  let out = '';
  for (const ch of s) {
    const esc = TAG_ESCAPE[ch];
    if (esc !== undefined) {
      out += esc;
      continue;
    }
    const code = ch.codePointAt(0) ?? 0;
    if (code <= 0x1f || code === 0x7f) {
      out += `%${code.toString(16).toUpperCase().padStart(2, '0')}`;
      continue;
    }
    out += ch;
  }
  return out;
}

/** 单段还原；遇到不完整或非十六进制的 `%xx` 即 `null`（与 Go 侧同样严格，不放宽容忍）。 */
export function decodeTagPathSegment(s: string): string | null {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== '%') {
      out += s[i];
      continue;
    }
    if (i + 3 > s.length) return null;
    const hex = s.slice(i + 1, i + 3);
    if (!/^[0-9a-fA-F]{2}$/.test(hex)) return null;
    out += String.fromCharCode(parseInt(hex, 16)); // 转义只可能产出 < 0x80 的字节
    i += 2;
  }
  return out;
}

/** `tag/<名称>/<章>/<节>`；三段各自**归一化**后转义（与 `TagItemID` 同序同口径）。 */
export function encodeTagPath(name: string, chapter: string, section: string): string {
  return [
    'tag',
    encodeTagPathSegment(normalizeTagSegment(name)),
    encodeTagPathSegment(normalizeTagSegment(chapter)),
    encodeTagPathSegment(normalizeTagSegment(section)),
  ].join('/');
}

/** 三段**归一化后**以 ` · ` 连接（`title` 不是自由字段，由 `item_id` 重建）。 */
export function tagTitle(name: string, chapter: string, section: string): string {
  return `${normalizeTagSegment(name)} · ${normalizeTagSegment(chapter)} · ${normalizeTagSegment(section)}`;
}

/** 解码并**重建校验**：段为空、转义非法、或重建后与入参不逐字相等 ⇒ `null`（册子 §3.1）。 */
export function decodeTagPath(itemId: string): { name: string; chapter: string; section: string } | null {
  if (!itemId.startsWith('tag/')) return null;
  const parts = itemId.slice(4).split('/');
  if (parts.length !== 3) return null;
  const segs: string[] = [];
  for (const p of parts) {
    if (p === '') return null;
    const d = decodeTagPathSegment(p);
    if (d === null) return null;
    segs.push(d);
  }
  if (encodeTagPath(segs[0]!, segs[1]!, segs[2]!) !== itemId) return null;
  return { name: segs[0]!, chapter: segs[1]!, section: segs[2]! };
}

/** 与 `protocol.isHex32` 同一形态：**只认小写** 32 hex（节点侧即如此，`group.v1`/`dm.v1` 的 id 由此被拒）。 */
function isHex32(s: string): boolean {
  return /^[0-9a-f]{32}$/.test(s);
}

/** 由 `target_id` 形态判定 `kind`（与节点 `protocol.TagKindOfTarget` 一一对应）；非法形态返回空串。 */
export function tagKindOfTarget(targetId: string): string {
  const parts = targetId.split('/');
  if (parts.some((p) => p === '')) return '';
  if (parts.length === 2) {
    if (parts[0] === 'comment') return isHex32(parts[1]!) ? 'comment' : '';
    if (parts[0] === 'course') return 'course';
    if (parts[0] === 'article') return 'article';
    return '';
  }
  if (parts.length === 4 && parts[0] === 'course' && parts[2] === 'lesson') return 'lesson';
  if (parts.length === 6 && parts[0] === 'course' && parts[2] === 'lesson' && parts[4] === 'article') return 'article';
  return '';
}
