/**
 * 从 markdown 正文里提取所有被引用的 blobId（32+ hex 字符）。
 * 匹配两种格式：
 *   新：![alt](blob:abc123...) — 协议引用（内容寻址，跨节点）
 *   旧：![alt](https://base/v1/blob/abc123...) — 绝对 URL（历史数据）
 * 返回去重后的 blobId 列表。
 */
export function extractBlobRefs(bodyMd: string): string[] {
  const found = new Set<string>();
  // 新格式：blob:{hex}
  const reNew = /blob:([a-f0-9]{32,})/g;
  let m: RegExpExecArray | null;
  while ((m = reNew.exec(bodyMd)) !== null) found.add(m[1]!);
  // 旧格式：/v1/blob/{hex}（绝对 URL 的路径段）
  const reOld = /\/v1\/blob\/([a-f0-9]{32,})/g;
  while ((m = reOld.exec(bodyMd)) !== null) found.add(m[1]!);
  return [...found];
}
