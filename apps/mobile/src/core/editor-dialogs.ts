/**
 * 编辑器「链接 / 图片」对话框的共享工具。
 * 纯函数 + 类型；状态（对话框开关 / Tab / 输入框）留在页面内 inline 管理。
 */
import {
  buildBlobImage,
  buildExternalLink,
  buildItemLink,
  searchLocalBlobs,
  searchLocalItems,
  resolveBlobUrl,
  type BlobSearchRow,
  type ItemSearchRow,
} from '@base/core-ts/editor-links';

export { buildBlobImage, buildExternalLink, buildItemLink, searchLocalBlobs, searchLocalItems, resolveBlobUrl };
export type { BlobSearchRow, ItemSearchRow };

/** 外部链接 Tab 的产出：`[displayText](url)`，插入后光标落在 `]` 之后。 */
export function composeExternalLink(url: string, displayText: string): string {
  return buildExternalLink(url.trim(), displayText.trim() || url.trim());
}

/** 内部链接 Tab 的产出：按 itemId 前缀选路由，插入后光标落在 `]` 之后。 */
export function composeInternalLink(baseUrl: string, itemId: string, displayTitle: string): string {
  return buildItemLink(baseUrl, itemId, displayTitle.trim() || itemId);
}

/**
 * 图片产出：`![alt](blob:{blobId})` — blob: 协议引用，不硬编码节点 URL。
 * @deprecated 直接用 buildBlobImage(blobId, alt)；保留此函数是为了 lesson/edit.vue 兼容。
 */
export function composeBlobImg(_baseUrl: string, blobId: string, alt: string): string {
  return buildBlobImage(blobId, alt.trim() || 'image');
}

/** 字节 → 可读的 KB / MB 字符串。 */
export function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * 在光标位置插入一段 markdown，返回新文本和目标光标位置（光标落在插入串末尾）。
 * 纯函数，不依赖 uni / DOM，与 applyToolbar 同约定（clamp + 取选区）。
 */
export function insertMarkdown(
  text: string,
  start: number,
  end: number,
  markdown: string,
): { text: string; caret: number } {
  const s = Math.max(0, Math.min(start, text.length));
  const e = Math.max(s, Math.min(end, text.length));
  const next = text.slice(0, s) + markdown + text.slice(e);
  return { text: next, caret: s + markdown.length };
}
