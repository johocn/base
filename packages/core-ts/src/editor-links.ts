/**
 * 编辑器工具栏的内部链接 / 外部链接 / 图片 Markdown 构造，以及本地 SQLite 搜索入口。
 * 纯字符串变换 + 简单 SQL 模板拼接，不 import 'uni' / 'plus'，Node 下可单测。
 */

/** itemId 形态前缀 → SPA hash 路由的页面名。 */
const KIND_ROUTES: Record<string, string> = {
  article: 'article',
  course: 'course',
  group: 'group',
  comment: 'comment',
};
const DEFAULT_ROUTE = 'item';

function routePageOf(itemId: string): string {
  // 先匹配最具体的：course/*/lesson/*
  if (itemId.startsWith('course/') && itemId.includes('/lesson/')) return 'lesson';
  const slash = itemId.indexOf('/');
  const prefix = slash >= 0 ? itemId.slice(0, slash) : itemId;
  return KIND_ROUTES[prefix] ?? DEFAULT_ROUTE;
}

/**
 * 内部链接：按 itemId 前缀选 SPA hash 路由，产出 `[title](baseUrl/#/pages/xxx/detail?itemId=xxx)`。
 * baseUrl 可以带也可以不带尾斜杠，内部统一处理。
 */
export function buildItemLink(baseUrl: string, itemId: string, displayTitle: string): string {
  const cleanBase = baseUrl.replace(/\/+$/, '');
  const page = routePageOf(itemId);
  const url = `${cleanBase}/#/pages/${page}/detail?itemId=${encodeURIComponent(itemId)}`;
  return `[${displayTitle}](${url})`;
}

/** 外部链接：`[text](url)`。 */
export function buildExternalLink(url: string, displayText: string): string {
  return `[${displayText}](${url})`;
}

/** 图片：`![alt](baseUrl/v1/blob/blobId)`；baseUrl 尾斜杠自动去掉。 */
export function buildBlobImage(baseUrl: string, blobId: string, alt: string): string {
  const cleanBase = baseUrl.replace(/\/+$/, '');
  return `![${alt}](${cleanBase}/v1/blob/${blobId})`;
}

/** 内部条目搜索的返回行（对应客户端 items 表）。 */
export interface ItemSearchRow {
  itemId: string;
  title: string;
  /** items.type（article / course / lesson / ...） */
  kind: string;
  /** items.author_id */
  ownerId: string;
}

/**
 * 本地条目搜索（查客户端 items 表）。
 * db 是前端 sqlite 连接对象，支持 `await db.select(sql, params?)`。
 * items 表的列名以 `packages/core-ts/src/repo.ts` SCHEMA_SQL 为准：
 *   item_id, title, type, author_id, ...
 */
export async function searchLocalItems(opts: {
  db: { select: (sql: string, params?: unknown[]) => Promise<any[]> };
  query: string;
  limit?: number;
}): Promise<ItemSearchRow[]> {
  const limit = opts.limit ?? 20;
  let rows: any[];
  if (!opts.query.trim()) {
    // 空关键词 → 返回最近条目（updated_at 是 ISO 时间串，字典序即时间序）
    rows = await opts.db.select(
      `SELECT item_id, title, type, author_id FROM items ORDER BY updated_at DESC LIMIT ?`,
      [limit],
    );
  } else {
    const like = `%${opts.query}%`;
    rows = await opts.db.select(
      `SELECT item_id, title, type, author_id FROM items WHERE title LIKE ? LIMIT ?`,
      [like, limit],
    );
  }
  return rows.map((r) => ({
    itemId: String(r.item_id ?? ''),
    title: String(r.title ?? ''),
    kind: String(r.type ?? ''),
    ownerId: String(r.author_id ?? ''),
  }));
}

/** 图片库搜索的返回行（对应客户端 blob_index 表）。 */
export interface BlobSearchRow {
  blobId: string;
  /** 客户端 blob_index 未存 original_name，回落为 '' */
  name: string;
  /** 客户端 blob_index 未存 content_type，回落为 '' */
  contentType: string;
  size: number;
  /** 客户端 blob_index 用 verified_at 存 ISO 时间串；此处回落 0 */
  createdAt: number;
}

/**
 * 本地图片库搜索（查客户端 blob_index 表）。
 *
 * 注意：当前客户端 blob_index 只登记 (blob_id, item_id, path, size, verified_at)，
 * 不存 original_name / content_type / owner_identity_id，因此本函数在现阶段做**最小实现**：
 *   - 忽略 ownerIdentityId 参数（无对应列）
 *   - 不做 content_type LIKE 'image/%' 过滤（无对应列）
 *   - query 关键字只对 item_id 做模糊匹配
 *   - 按 verified_at DESC 排序
 * 后续扩展 blob_index 列后可无缝补齐。
 */
export async function searchLocalBlobs(opts: {
  db: { select: (sql: string, params?: unknown[]) => Promise<any[]> };
  ownerIdentityId: string;
  query?: string;
  limit?: number;
}): Promise<BlobSearchRow[]> {
  const limit = opts.limit ?? 30;
  let rows: any[];
  if (opts.query && opts.query.trim() !== '') {
    const like = `%${opts.query}%`;
    rows = await opts.db.select(
      `SELECT blob_id, item_id, size, verified_at FROM blob_index WHERE item_id LIKE ? ORDER BY verified_at DESC LIMIT ?`,
      [like, limit],
    );
  } else {
    rows = await opts.db.select(
      `SELECT blob_id, item_id, size, verified_at FROM blob_index ORDER BY verified_at DESC LIMIT ?`,
      [limit],
    );
  }
  return rows.map((r) => ({
    blobId: String(r.blob_id ?? ''),
    name: '',
    contentType: '',
    size: Number(r.size ?? 0),
    createdAt: 0,
  }));
}
