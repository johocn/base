import { blobId, sha256Hex, utf8, verifyManifest, type Manifest } from '@base/protocol-ts';

import type { Adapters, SqliteConnection } from '../platform/adapter';
import type { LocalRepo } from './repo';
import type { ArticleRow, ItemRow, TombstoneRow } from './types';

export interface CatalogItem {
  item_id: string;
  source: string;
  type: string;
  title: string;
  content_hash: string;
  source_rev: string;
}

export interface Catalog {
  pack_id: string;
  content_version: number;
  items: CatalogItem[];
  next_cursor: string | null;
}

export interface SyncOptions {
  adapters: Adapters;
  repo: LocalRepo;
  /** 节点根地址，如 https://node.example.com */
  nodeBaseUrl: string;
  /** 本地工作目录（pack 与块文件都放这里） */
  workDir: string;
}

export type SyncResult =
  | { status: 'noop'; contentVersion: number }
  | { status: 'updated'; contentVersion: number; items: number; blobs: number };

export function decodeUtf8(data: Uint8Array): string {
  return new TextDecoder('utf-8').decode(data);
}

/** 按 cursor 翻页拉目录（契约第 1 条：最后一页 next_cursor 为 null）。 */
export async function fetchCatalog(o: SyncOptions, since: number): Promise<Catalog> {
  const out: Catalog = { pack_id: '', content_version: 0, items: [], next_cursor: null };
  let cursor: string | null = null;
  for (;;) {
    const q = new URLSearchParams();
    if (since > 0) q.set('since', String(since));
    if (cursor !== null) q.set('cursor', cursor);
    const qs = q.toString();
    const res = await o.adapters.http.get(`${o.nodeBaseUrl}/v1/catalog${qs ? `?${qs}` : ''}`);
    if (res.status !== 200) throw new Error(`catalog 拉取失败: HTTP ${res.status}`);
    const page = JSON.parse(decodeUtf8(res.body)) as Catalog;
    out.pack_id = page.pack_id;
    out.content_version = page.content_version;
    out.items.push(...(page.items ?? []));
    const next = page.next_cursor ?? null;
    if (next === null) return out;
    if (next === cursor) throw new Error('catalog 分页未推进，拒绝死循环');
    cursor = next;
  }
}

async function readPackArticles(conn: SqliteConnection): Promise<ArticleRow[]> {
  const rows = await conn.select(
    `SELECT item_id,title,digest,published_at,tags_json,body_md,content_hash,source_rev FROM articles`,
  );
  return rows.map((r) => ({
    itemId: String(r.item_id),
    title: String(r.title ?? ''),
    digest: String(r.digest ?? ''),
    publishedAt: String(r.published_at ?? ''),
    tagsJson: String(r.tags_json ?? '[]'),
    bodyMd: String(r.body_md ?? ''),
    contentHash: String(r.content_hash),
    rev: String(r.source_rev ?? ''),
  }));
}

/**
 * 同步一轮。顺序即不变量：先验签 → 再校验 pack → 再拉块 → 最后一次性落库。
 * 任何一步失败都不会在本地留下半截数据。
 */
export async function syncOnce(o: SyncOptions): Promise<SyncResult> {
  const localVersion = Number((await o.repo.getConfig('content_version')) ?? '0');
  const pubHex = await o.repo.getConfig('pubkey_hex');
  if (!pubHex) throw new Error('未配置节点公钥（pubkey_hex），无法验签');

  const cat = await fetchCatalog(o, localVersion);
  if (cat.content_version <= localVersion) return { status: 'noop', contentVersion: localVersion };
  if (!cat.pack_id) throw new Error('catalog 未返回 pack_id');

  const manRes = await o.adapters.http.get(`${o.nodeBaseUrl}/v1/manifest/${cat.pack_id}`);
  if (manRes.status !== 200) throw new Error(`manifest 拉取失败: HTTP ${manRes.status}`);
  const man = JSON.parse(decodeUtf8(manRes.body)) as Manifest;
  if (man.pack_id !== cat.pack_id) throw new Error('manifest.pack_id 与目录不一致');
  if (man.content_version <= localVersion) throw new Error('manifest 版本未递增');
  if (!verifyManifest(man, pubHex)) throw new Error(`manifest 验签失败（pack=${cat.pack_id}）`);

  const packRes = await o.adapters.http.get(`${o.nodeBaseUrl}/v1/pack/${cat.pack_id}`);
  if (packRes.status !== 200) throw new Error(`pack 拉取失败: HTTP ${packRes.status}`);
  const packPath = `${o.workDir}/pack-${cat.pack_id}.sqlite`;
  await o.adapters.fs.writeFile(packPath, packRes.body);

  const conn = await o.adapters.packReader.open(packPath);
  let articles: ArticleRow[];
  try {
    articles = await readPackArticles(conn);
  } finally {
    await o.adapters.packReader.close(conn);
  }
  // 哈希即真：pack 行必须以「已签名的 manifest」声明的 content_hash 为准，
  // 行自带的 content_hash 与正文哈希都要与之一致，否则说明 pack 被换过。
  const signedHashes = new Map(man.entries.map((e) => [e.item_id, e.content_hash] as [string, string]));
  for (const a of articles) {
    const signed = signedHashes.get(a.itemId);
    if (signed === undefined || a.contentHash !== signed || sha256Hex(utf8(a.bodyMd)) !== signed) {
      throw new Error(`pack 行级 hash 不符: ${a.itemId}`);
    }
  }

  const now = new Date().toISOString();

  // 块先行：失败即整轮失败，且此时尚未写任何目录数据
  let blobs = 0;
  for (const e of man.entries) {
    for (const c of e.chunks ?? []) {
      if (await o.repo.hasBlob(c.blob_id)) continue;
      const res = await o.adapters.http.get(`${o.nodeBaseUrl}/v1/blob/${c.blob_id}`);
      if (res.status !== 200) throw new Error(`块拉取失败 ${c.blob_id}: HTTP ${res.status}`);
      if (blobId(res.body) !== c.blob_id) throw new Error(`块内容哈希不符 ${c.blob_id}`);
      if (res.body.length !== c.size) throw new Error(`块大小不符 ${c.blob_id}: ${res.body.length} != ${c.size}`);
      const path = `${o.workDir}/blobs/${c.blob_id}`;
      await o.adapters.fs.writeFile(path, res.body);
      await o.repo.addBlob(c.blob_id, e.item_id, path, res.body.length, now);
      blobs++;
    }
  }

  const items: ItemRow[] = cat.items.map((it) => ({
    itemId: it.item_id,
    source: it.source,
    type: it.type,
    title: it.title,
    rev: it.source_rev,
    contentHash: it.content_hash,
    state: 'active',
    updatedAt: now,
  }));
  const tombstones: TombstoneRow[] = man.tombstone.map((t) => ({ itemId: t.item_id, revokedRev: t.revoked_rev }));

  // 必须在 applyPack 之前取路径：applyPack 会删掉 blob_index 行，之后再也查不到块文件位置（契约 §9.3）
  const stalePaths: string[] = [];
  for (const t of tombstones) {
    stalePaths.push(...(await o.repo.listBlobPathsByItem(t.itemId)));
  }

  await o.repo.applyPack({ version: cat.content_version, packId: cat.pack_id, items, articles, tombstones, updatedAt: now });

  // 行已删、文件后删：删文件失败不阻断本轮（本地视图已一致，下次同步会重跑同一流程）
  for (const path of stalePaths) {
    try {
      await o.adapters.fs.remove(path);
    } catch (err) {
      console.warn(`墓碑清理块文件失败（不阻断同步）: ${path}`, err);
    }
  }
  return { status: 'updated', contentVersion: cat.content_version, items: items.length, blobs };
}