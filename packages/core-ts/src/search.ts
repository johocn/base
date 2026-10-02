// 本地搜索的纯部分：转义与查询串。查询走 LIKE 全表扫描（内容量几十至几百篇足够，spec §11 风险 6）。

/** 转义 LIKE 里的特殊字符：反斜杠要先处理，否则会把后面新加的转义再转一次。 */
export function escapeLike(q: string): string {
  return q.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}

/** 空输入返回 null（调用方据此不发查询，spec §5.2）。 */
export function searchPattern(q: string): string | null {
  const t = q.trim();
  if (t === '') return null;
  return `%${escapeLike(t)}%`;
}

/**
 * 占位符只用匿名 `?`：sqlWithParams 是单遍替换，不支持 `?1` 编号形式。
 * 同一模式串出现三次（两次筛选 + 一次排序），故调用方要传三个参数。
 */
export const SEARCH_SQL =
  `SELECT item_id,title,digest,published_at,tags_json,body_md,content_hash,source_rev FROM articles` +
  ` WHERE title LIKE ? ESCAPE '\\' OR body_md LIKE ? ESCAPE '\\'` +
  ` ORDER BY (title LIKE ? ESCAPE '\\') DESC, published_at DESC LIMIT 50`;