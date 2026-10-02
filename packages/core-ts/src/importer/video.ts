/**
 * `internal/importer/video.go` 的**纯**部分：分块粒度 / item_id / content_hash / MIME / 标题。
 * 文件 IO、blob 写盘、并入课时清单属宿主层，不在本包。
 */
import { sha256Hex, utf8 } from "@base/protocol-ts";

import { stemOf } from "./frontmatter";

/** 视频分块的定长粒度（Go `ChunkSize`）：1 MiB，最后一块可短。 */
export const VIDEO_CHUNK_SIZE = 1 << 20;

/** `filepath.Ext`：从最后一个路径分隔符起向右找第一个 `.`（认 `/` 与 `\`）。 */
function extOf(path: string): string {
  for (let i = path.length - 1; i >= 0; i--) {
    const c = path[i];
    if (c === "/" || c === "\\") break;
    if (c === ".") return path.slice(i);
  }
  return "";
}

/** 按扩展名（小写）推断 MIME；未知一律 `application/octet-stream`。 */
export function guessVideoMime(path: string): string {
  switch (extOf(path).toLowerCase()) {
    case ".mp4":
    case ".m4v":
      return "video/mp4";
    case ".webm":
      return "video/webm";
    case ".mkv":
      return "video/x-matroska";
    case ".mov":
      return "video/quicktime";
    default:
      return "application/octet-stream";
  }
}

/** 视频 item_id：`course/<course>/lesson/<lesson>/video/<slug>`。 */
export function videoItemId(course: string, lesson: string, slug: string): string {
  return `course/${course}/lesson/${lesson}/video/${slug}`;
}

/** 条目级 content_hash = hex(sha256(按 seq 升序拼接的每个块 id 的 UTF-8 字节))。 */
export function videoContentHash(chunkHashes: string[]): string {
  return sha256Hex(utf8(chunkHashes.join("")));
}

/** 定长切分：满块 + 末块可短；0 字节返回空数组（对齐 Go `io.ReadFull` 循环）。 */
export function chunkSizes(totalBytes: number, size = VIDEO_CHUNK_SIZE): number[] {
  const out: number[] = [];
  for (let off = 0; off < totalBytes; off += size) {
    out.push(Math.min(size, totalBytes - off));
  }
  return out;
}

/** 标题缺省：`strings.TrimSuffix(filepath.Base(p), filepath.Ext(p))`。 */
export function videoTitleFromPath(path: string): string {
  return stemOf(path);
}