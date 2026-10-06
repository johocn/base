import { ATTR_BODY_MD, blobId, sha256Hex, utf8, verifyManifest, type Manifest } from '@base/protocol-ts';

import { extractBlobRefs } from './blob-refs';
import type { Adapters, SqliteConnection } from './platform/adapter';
import { pullDirectory } from './directory';
import { migrateLegacyIds } from './id-migrate';
import type { LocalRepo } from './repo';
import type { ArticleRow, ItemRow, QuizRow, SegmentRow, TombstoneRow } from './types';

export interface CatalogItem {
  item_id: string;
  source: string;
  type: string;
  title: string;
  content_hash: string;
  source_rev: string;
  /** 条目点赞计数（#79 §5.2/§7.3）：老节点响应无此键，缺省 0 */
  like_count?: number;
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

/**
 * 手写 UTF-8 解码。
 * App 运行时跑在系统 WebView 里，老版本连 URLSearchParams 都没有（真机已实测报错），
 * TextDecoder 同样不保证存在，所以这两个 Web API 都不依赖。
 */
export function decodeUtf8(data: Uint8Array): string {
  let out = '';
  let i = 0;
  while (i < data.length) {
    const b0 = data[i]!;
    let cp: number;
    let extra: number;
    if (b0 < 0x80) {
      cp = b0;
      extra = 0;
    } else if (b0 < 0xe0) {
      cp = b0 & 0x1f;
      extra = 1;
    } else if (b0 < 0xf0) {
      cp = b0 & 0x0f;
      extra = 2;
    } else {
      cp = b0 & 0x07;
      extra = 3;
    }
    i++;
    for (let k = 0; k < extra && i < data.length; k++, i++) cp = (cp << 6) | (data[i]! & 0x3f);
    out +=
      cp > 0xffff
        ? String.fromCharCode(0xd800 + ((cp - 0x10000) >> 10), 0xdc00 + ((cp - 0x10000) & 0x3ff))
        : String.fromCharCode(cp);
  }
  return out;
}

/** 按 cursor 翻页拉目录（契约第 1 条：最后一页 next_cursor 为 null）。 */
export async function fetchCatalog(o: SyncOptions, since: number): Promise<Catalog> {
  const out: Catalog = { pack_id: '', content_version: 0, items: [], next_cursor: null };
  let cursor: string | null = null;
  for (;;) {
    // 手拼查询串：老 WebView 没有 URLSearchParams（真机报错点就在这）
    const q: string[] = [];
    if (since > 0) q.push(`since=${encodeURIComponent(String(since))}`);
    if (cursor !== null) q.push(`cursor=${encodeURIComponent(cursor)}`);
    const qs = q.join('&');
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

async function readPackQuizzes(conn: SqliteConnection): Promise<QuizRow[]> {
  const rows = await conn.select(`SELECT item_id,question_json,content_hash FROM quizzes`);
  return rows.map((r) => ({
    itemId: String(r.item_id),
    questionJson: String(r.question_json ?? ''),
    contentHash: String(r.content_hash),
  }));
}

async function readPackSegments(conn: SqliteConnection): Promise<SegmentRow[]> {
  const rows = await conn.select(`SELECT item_id,seq,kind,text,content_hash FROM segments ORDER BY item_id ASC, seq ASC`);
  return rows.map((r) => ({
    itemId: String(r.item_id),
    seq: Number(r.seq),
    kind: String(r.kind ?? ''),
    text: String(r.text ?? ''),
    contentHash: String(r.content_hash),
  }));
}

/**
 * 落盘自证：pack 是二进制 SQLite，真机上 plus.io 的 createWriter 一旦少写或写空，
 * 后面 plus.sqlite 打开它只会得到空库/空表而不会报错，症状就是「标题有、正文没有」。
 * 写完立刻回读比对字节数与摘要，把这种静默损坏挡在落库之前。
 */
async function assertPackOnDisk(o: SyncOptions, path: string, expected: Uint8Array): Promise<void> {
  const back = await o.adapters.fs.readFile(path);
  if (back.length !== expected.length) {
    throw new Error(`pack 落盘字节数不符：期望 ${expected.length}，实际 ${back.length}（${path}）`);
  }
  if (sha256Hex(back) !== sha256Hex(expected)) {
    throw new Error(`pack 落盘内容摘要不符（${path}）`);
  }
}

/**
 * 同步一轮。顺序即不变量：先验签 → 再校验 pack → 再拉块 → 最后一次性落库。
 * 任何一步失败都不会在本地留下半截数据。
 */
async function syncContentOnce(o: SyncOptions): Promise<SyncResult> {
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
  await assertPackOnDisk(o, packPath, packRes.body);

  const conn = await o.adapters.packReader.open(packPath);
  let articles: ArticleRow[];
  let quizzes: QuizRow[];
  let segments: SegmentRow[];
  try {
    articles = await readPackArticles(conn);
    quizzes = await readPackQuizzes(conn);
    segments = await readPackSegments(conn);
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
  for (const q of quizzes) {
    const signed = signedHashes.get(q.itemId);
    if (signed === undefined || q.contentHash !== signed || sha256Hex(utf8(q.questionJson)) !== signed) {
      throw new Error(`pack 行级 hash 不符: ${q.itemId}`);
    }
  }
  // 行数守卫：plus.sqlite 打开一个「不存在/空的」库时会新建空库，查询只会得到空数组，
  // 于是整轮同步会「成功」却一条正文都没有。拿已签名的 manifest 声明数对账，宁可报错也不静默丢正文。
  const declared = man.entries.filter((e) => e.sqlite_table === 'articles').length;
  if (articles.length < declared) {
    throw new Error(`pack 正文行数不符：manifest 声明 ${declared} 条，pack 读出 ${articles.length} 条（${packPath}）`);
  }
  const declaredQuizzes = man.entries.filter((e) => e.sqlite_table === 'quizzes').length;
  if (quizzes.length < declaredQuizzes) {
    throw new Error(`pack 题库行数不符：manifest 声明 ${declaredQuizzes} 条，pack 读出 ${quizzes.length} 条（${packPath}）`);
  }

  // segments：行级 hash 看 text，条目级 hash 看「按 seq 升序拼接的 <kind>\t<text>\n」
  const byItem = new Map<string, SegmentRow[]>();
  for (const s of segments) {
    if (sha256Hex(utf8(s.text)) !== s.contentHash) throw new Error(`pack segments 行级 hash 不符: ${s.itemId} seq=${s.seq}`);
    const list = byItem.get(s.itemId) ?? [];
    list.push(s);
    byItem.set(s.itemId, list);
  }
  for (const [itemId, list] of byItem) {
    const signed = signedHashes.get(itemId);
    if (signed === undefined) throw new Error(`pack segments 未被 manifest 声明: ${itemId}`);
    const concat = list.map((s) => `${s.kind}\t${s.text}\n`).join('');
    if (sha256Hex(utf8(concat)) !== signed) throw new Error(`pack segments 条目级 hash 不符: ${itemId}`);
  }
  // 按「条目数」对账，不是行数——一个容器有多行
  const declaredSegments = man.entries.filter((e) => e.sqlite_table === 'segments').length;
  if (byItem.size < declaredSegments) {
    throw new Error(`pack segments 条目数不符：manifest 声明 ${declaredSegments} 个，pack 读出 ${byItem.size} 个（${packPath}）`);
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
      await o.repo.addBlob(c.blob_id, '', path, res.body.length, now, undefined, undefined, e.item_id);
      // original_name / content_type：manifest.Chunk 不带元数据（内容寻址），回落空串；
      // 前端上传路径在 course-edit.ts 里自带 picked.name + ext 推断
      blobs++;
    }
  }

  // 数据源切到 manifest.entries：catalog handler 精简字段不含 author_id，
  // 而 manifest.entries（已拉取 + 验签 + hash 对账）带完整归属链。
  // 但 manifest 可能比 catalog 多 media_meta/segments 条目——按 catalog 的 item_id 集合过滤，
  // 保持 ItemRow 语义（article/quiz/course/lesson）与原逻辑一致。
  const catIds = new Set(cat.items.map((it) => it.item_id));
  // like_count 随 catalog 内联值写回 items（#79 §7.3）：manifest 不带计数，只认 catalog 行，缺省 0
  const likeByItem = new Map(cat.items.map((it) => [it.item_id, Number(it.like_count ?? 0)] as [string, number]));
  const items: ItemRow[] = man.entries
    .filter((e) => catIds.has(e.item_id))
    .map((e) => ({
      itemId: e.item_id,
      source: e.source,
      type: e.type,
      title: e.title,
      rev: e.source_rev,
      contentHash: e.content_hash,
      state: 'active',
      updatedAt: now,
      authorId: e.author_id ?? '',
      authorSig: e.author_sig ?? '',
      likeCount: likeByItem.get(e.item_id) ?? 0,
    }));
  const tombstones: TombstoneRow[] = man.tombstone.map((t) => ({ itemId: t.item_id, revokedRev: t.revoked_rev }));

  // 必须在 applyPack 之前取路径：applyPack 会删掉 blob_index 行，之后再也查不到块文件位置（契约 §9.3）
  const stalePaths: string[] = [];
  for (const t of tombstones) {
    stalePaths.push(...(await o.repo.listBlobPathsByItem(t.itemId)));
  }

  await o.repo.applyPack({ version: cat.content_version, packId: cat.pack_id, items, articles, quizzes, segments, tombstones, updatedAt: now });

  // 刷 blob_references：
  // 1) articles.body_md 里的 blob: 协议图片（最常见）
  // 2) segments 中 kind='attr.body_md' 的课时讲稿 markdown 正文
  // 3) tombstone 条目 → refreshBlobRefs(itemId, []) 清孤儿引用
  for (const art of articles) {
    await o.repo.refreshBlobRefs(art.itemId, extractBlobRefs(art.bodyMd));
  }
  const bodyMdSegByItem = new Map<string, string[]>();
  for (const s of segments) {
    if (s.kind !== ATTR_BODY_MD) continue;
    const prev = bodyMdSegByItem.get(s.itemId) ?? [];
    prev.push(s.text);
    bodyMdSegByItem.set(s.itemId, prev);
  }
  for (const [itemId, texts] of bodyMdSegByItem) {
    await o.repo.refreshBlobRefs(itemId, extractBlobRefs(texts.join('\n')));
  }
  for (const t of tombstones) {
    await o.repo.refreshBlobRefs(t.itemId, []);
  }

  // 行已删、文件后删：删文件失败不阻断本轮（本地视图已一致，下次同步会重跑同一流程）
  for (const path of stalePaths) {
    try {
      await o.adapters.fs.remove(path);
    } catch (err) {
      console.warn(`墓碑清理块文件失败（不阻断同步）: ${path}`, err);
    }
  }
  // 一次性幂等平移：把旧形态 id（<source>:<slug>）上的用户数据改指到新形态
  await migrateLegacyIds(o.repo);
  return { status: 'updated', contentVersion: cat.content_version, items: items.length, blobs };
}

/**
 * 同步一轮：内容同步 + **同轮**拉一次目录（册子 #58 §4.2）。
 * 目录是旁路：`noop` 与 `updated` 两条路径都拉，但拉取失败**不得**让整轮同步失败。
 */
export async function syncOnce(o: SyncOptions): Promise<SyncResult> {
  const result = await syncContentOnce(o);
  try {
    await pullDirectory(o);
  } catch {
    // 目录失败静默：内容同步结果已确定，旁路不该拖垮整轮
  }
  return result;
}
