/** slug 段的最大长度（字节口径，即 `string.length`）。 */
export const SLUG_MAX_BYTES = 64;

/**
 * 校验 slug 形态（册子 #25 §2.4）：`[a-z0-9][a-z0-9-]{0,63}`，总长 1..64。
 * 这是契约级规则：投稿 item_id 的 slug 段、导入器产出的 category slug 都按它判定，
 * 故落在 protocol 而非任一调用方包内，避免两处口径漂移。
 */
export function isValidSlug(s: string): boolean {
  if (s.length === 0 || s.length > SLUG_MAX_BYTES) return false;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    const isAlnum = (c >= 0x61 && c <= 0x7a) || (c >= 0x30 && c <= 0x39);
    if (i === 0) {
      if (!isAlnum) return false;
      continue;
    }
    if (!isAlnum && c !== 0x2d) return false;
  }
  return true;
}
