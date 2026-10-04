/**
 * 从 markdown 正文里提取所有被引用的 blobId（32+ hex 字符）。
 * 匹配两种格式：
 *   新：![alt](blob:abc123...) — 协议引用（内容寻址，跨节点）
 *   旧：![alt](https://base/v1/blob/abc123...) — 绝对 URL（历史数据）
 * 返回去重后的 blobId 列表。
 */
export function extractBlobRefs(bodyMd: string): string[] {
  const found = new Set<string>();
  const reNew = /blob:([a-f0-9]{32,})/g;
  let m: RegExpExecArray | null;
  while ((m = reNew.exec(bodyMd)) !== null) found.add(m[1]!);
  const reOld = /\/v1\/blob\/([a-f0-9]{32,})/g;
  while ((m = reOld.exec(bodyMd)) !== null) found.add(m[1]!);
  return [...found];
}

/**
 * 渲染前预处理 markdown：把 `blob:{hash}` 协议引用替换成当前节点的绝对 URL。
 * 跨节点便携的关键——markdown 存内容寻址，渲染时才按当前节点解析。
 * 绝对 URL（历史数据）保持不变。
 */
export function resolveBlobRefsInMd(bodyMd: string, currentBaseUrl: string): string {
  const clean = currentBaseUrl.replace(/\/+$/, '');
  return bodyMd.replace(/blob:([a-f0-9]{32,})/g, `${clean}/v1/blob/$1`);
}
