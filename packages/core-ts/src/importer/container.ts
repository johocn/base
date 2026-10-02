/**
 * `internal/importer/course.go` 的**纯**部分：容器清单合并 / 排序 / segments 切分。
 * 不做库访问；`rebuildContainer` / `rebuildCategories` / `ensureLessonChild` 属宿主层，不在本包。
 */
import { utf8 } from "@base/protocol-ts";

import type { StoreSegment } from "../store/types";
import type { Placement } from "./md";

/**
 * 按 UTF-8 **字节序**比较两个字符串，返回 -1 / 0 / 1（对齐 Go `sort.Strings` 与字符串 `<`）。
 *
 * 为什么不能直接用 JS 的 `<`：它是 UTF-16 码元序，非 BMP 字符（如 emoji，代理对
 * 0xD83D 0xDE00）会与 Go 的 UTF-8 字节序分歧，进而改掉容器清单顺序、改 `pack_id`。
 * 核包内不得依赖 `Buffer`，故用 `utf8()` 逐字节比较。
 */
export function compareGoString(a: string, b: string): number {
  const ab = utf8(a);
  const bb = utf8(b);
  const n = Math.min(ab.length, bb.length);
  for (let i = 0; i < n; i++) {
    if (ab[i] !== bb[i]) return ab[i] < bb[i] ? -1 : 1;
  }
  return ab.length - bb.length;
}

/**
 * 容器清单的合并式重算（册子 §4.2 规则 6）：
 * 「本次 Run 声明的子项」+「既有但本次未声明的子项（保持原相对顺序）」，去重。
 */
export function mergeChildren(existing: string[], declared: string[]): string[] {
  const seen: Record<string, boolean> = {};
  const out: string[] = [];
  for (const id of declared) {
    if (seen[id]) continue;
    seen[id] = true;
    out.push(id);
  }
  for (const id of existing) {
    if (seen[id]) continue;
    seen[id] = true;
    out.push(id);
  }
  return out;
}

/** 按 (有 order 在前, order 升序, 文件名升序) 稳定排序（对齐 Go `sort.SliceStable`）。 */
export function sortDeclared(items: Placement[]): Placement[] {
  const out = items.slice();
  out.sort((a, b) => {
    const ao = a.order === "";
    const bo = b.order === "";
    if (ao !== bo) return ao ? 1 : -1; // 有 order 的在前
    if (a.order !== b.order) return compareGoString(a.order, b.order);
    return compareGoString(a.filename, b.filename);
  });
  return out;
}

/** 取既有 segments 里的子项 id（seq>=1），保持原序。 */
export function childIdsOf(segs: StoreSegment[]): string[] {
  const out: string[] = [];
  for (const s of segs) {
    if (s.seq >= 1) out.push(s.text);
  }
  return out;
}

/** 取既有 seq=0 行的 text（缺省返回空串）。 */
export function digestTextOf(segs: StoreSegment[]): string {
  for (const s of segs) {
    if (s.seq === 0) return s.text;
  }
  return "";
}

/** 取既有 segments 里的属性行（seq<0），按原序返回（册子 §2.1 铁律 1）。 */
export function attrSegsOf(segs: StoreSegment[]): StoreSegment[] {
  const out: StoreSegment[] = [];
  for (const s of segs) {
    if (s.seq < 0) out.push(s);
  }
  return out;
}

/** 从子项 item_id 的倒数第二段取 kind（course/c1/lesson/l1/video/v1 → video）。 */
export function kindOf(itemId: string): string {
  const parts = itemId.split("/");
  if (parts.length < 2) return "";
  return parts[parts.length - 2] ?? "";
}