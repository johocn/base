/**
 * 从 markdown 正文里提取所有被引用的 blobId（32+ hex 字符）。
 * 只认 `/v1/blob/{hash}` 路径段——不管 baseUrl 是什么，路径后缀一致：
 *   ![alt](https://base/v1/blob/abc123...)
 *   [链接也能引用](https://base/v1/blob/abc123...)
 * 正则不用硬编码 baseUrl，抓路径片段即可。
 * 返回去重后的 blobId 列表。
 */
export function extractBlobRefs(bodyMd: string): string[] {
  const found = new Set<string>();
  // /v1/blob/ 后面至少 32 个 hex（sha256 内容寻址）
  const re = /\/v1\/blob\/([a-f0-9]{32,})/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(bodyMd)) !== null) {
    found.add(m[1]!);
  }
  return [...found];
}
