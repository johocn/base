// 逐行移植 internal/peersync/packimport.go：把一个 peer 的已签名内容包复制到本节点。
// 顺序即不变量：目录水位 → 验签 → pack meta → pack 行级 → 才落库；任一步失败都不落任何行。
//
// 与 Go 的**有意差异**：pack.sqlite 用 openHostDb(readOnly) 打开（pack 写出侧 journal_mode=OFF，
// 无需 normalizeJournalMode）；读出的 body_md 是**密文原文**，按 Go 口径直接 sha256 比对，**不解密**。
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  deriveIdentityId,
  sha256Hex,
  segmentsContentHash,
  utf8,
  verifyAuthorSig,
  verifyManifest,
  type Entry,
  type Manifest,
} from "@base/protocol-ts";
import type { StoreSegment } from "@base/core-ts";
import { openHostDb, type HostDb } from "../host/sqlite";
import type { PackEntry, ImportResult } from "../store/packimport";
import type { SyncStore } from "../store/syncstore";
import { fetchCatalog, fetchManifest, fetchPackTo } from "./remote";
import type { Config, Peer, SyncContext } from "./peer";

/** 一次包级复制的结果。 */
export interface ImportOutcome {
  status: string; // noop | imported
  contentVersion: number;
  packId: string;
  entries: number;
  skipped: number;
  rejected: string[];
  removedBlobs: number;
}

function toStr(v: unknown): string {
  return v === null || v === undefined ? "" : String(v);
}

function toNum(v: unknown): number {
  return v === null || v === undefined ? 0 : Number(v);
}

/** 空 PackEntry（承载四族共用字段）。 */
function baseEntry(e: Entry): PackEntry {
  return {
    itemId: e.item_id,
    source: e.source,
    type: e.type,
    title: e.title,
    sourceRev: e.source_rev,
    contentHash: e.content_hash,
    sqliteTable: e.sqlite_table,
    distClass: e.dist_class,
    updatedAt: "",
    authorId: "",
    authorSig: "",
    digest: "",
    publishedAt: "",
    tagsJson: "",
    bodyMd: "",
    mime: "",
    size: 0,
    duration: 0,
    chunkSize: 0,
    chunkHashes: [],
    segments: [],
    questionJson: "",
  };
}

/** json.Unmarshal 语义：非法 JSON / 非字符串数组一律抛错（null → 空数组）。 */
function parseChunkHashes(itemId: string, raw: string): string[] {
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch (err) {
    throw new Error(`pack media_meta ${itemId} 的 chunk_hashes_json 非法: ${String(err)}`);
  }
  if (v === null) return [];
  if (!Array.isArray(v)) {
    throw new Error(`pack media_meta ${itemId} 的 chunk_hashes_json 非法: 不是 JSON 数组`);
  }
  for (const x of v) {
    if (typeof x !== "string") {
      throw new Error(`pack media_meta ${itemId} 的 chunk_hashes_json 非法: 数组元素不是字符串`);
    }
  }
  return v as string[];
}

/**
 * ImportPack（packimport.go:31-119）：把一个 peer 的已签名内容包复制到本节点。
 */
export async function importPack(
  c: Config,
  ctx: SyncContext,
  st: SyncStore,
  p: Peer,
  localVersion: number,
): Promise<ImportOutcome> {
  const out: ImportOutcome = {
    status: "noop",
    contentVersion: localVersion,
    packId: "",
    entries: 0,
    skipped: 0,
    rejected: [],
    removedBlobs: 0,
  };

  const page = await fetchCatalog(c, ctx, p, localVersion);
  if (page.pack_id === "" || page.content_version <= localVersion) {
    return out; // 对端还不是源节点，或没有更新
  }
  out.packId = page.pack_id;

  const { manifest: man, raw: manifestBytes } = await fetchManifest(c, ctx, p, page.pack_id);
  if (man.pack_id !== page.pack_id) {
    throw new Error(`manifest.pack_id=${man.pack_id} 与目录 ${page.pack_id} 不一致`);
  }
  const pub = (c.issuerPubKeys ?? {})[man.issuer];
  if (pub === undefined) {
    throw new Error(`issuer ${JSON.stringify(man.issuer)} 未在 BASE_ISSUER_PUBKEYS 中，拒绝整包（不做 TOFU）`);
  }
  let verified: boolean;
  try {
    verified = verifyManifest(man, pub);
  } catch (err) {
    throw new Error(`验签 ${page.pack_id} 出错: ${String(err)}`);
  }
  if (!verified) {
    throw new Error(`manifest 验签失败（pack=${page.pack_id} issuer=${man.issuer}）`);
  }
  if (man.content_version < localVersion) {
    throw new Error(`对端版本 ${man.content_version} 低于本地 ${localVersion}，拒绝回卷`);
  }

  const tmpDir = mkdtempSync(join(st.dataDir, "packimport-"));
  try {
    const packPath = await fetchPackTo(c, ctx, p, man.pack_id, tmpDir);
    const entries = readAndVerifyPack(packPath, man); // 整包拒绝：临时目录由 finally 清理，本地视图不变

    const res: ImportResult = st.importPack(man.content_version, entries, man.tombstone);

    // 落位：packs/<pack_id>/pack.sqlite + manifest.json
    const finalDir = join(st.packsDir(), man.pack_id);
    mkdirSync(finalDir, { recursive: true, mode: 0o755 });
    const finalPack = join(finalDir, "pack.sqlite");
    renameSync(packPath, finalPack);
    writeFileSync(join(finalDir, "manifest.json"), manifestBytes, { mode: 0o644 });
    st.insertPack({
      packId: man.pack_id,
      contentVersion: man.content_version,
      dir: finalDir,
      merkleRoot: man.merkle_root,
      signature: man.signature,
      issuedAt: man.issued_at,
      itemCount: man.entries.length,
      createdAt: "",
    });

    // 墓碑连带删块文件：行已删，路径从 removedBlobs 来（修正 5：失败只记日志，不阻断）
    for (const id of res.removedBlobs) {
      try {
        st.deleteBlobFile(id);
      } catch {
        out.rejected.push("delete_failed:" + id);
      }
    }

    out.status = "imported";
    out.contentVersion = man.content_version;
    out.entries = res.entries;
    out.skipped = res.skipped;
    out.rejected.push(...res.rejected);
    out.removedBlobs = res.removedBlobs.length;
    return out;
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

/**
 * readAndVerifyPack（packimport.go:135-334）：打开 pack.sqlite 并逐条比对已验签的 manifest；
 * 任一不符即抛错（调用方拒绝整包）。
 */
export function readAndVerifyPack(packPath: string, man: Manifest): PackEntry[] {
  const db: HostDb = openHostDb(packPath, { readOnly: true });
  try {
    const meta: Record<string, string> = {};
    for (const row of db.all(`SELECT key,value FROM meta`)) {
      meta[toStr(row.key)] = toStr(row.value);
    }
    if (meta["pack_id"] !== man.pack_id) {
      throw new Error(`pack meta pack_id=${JSON.stringify(meta["pack_id"] ?? "")} 与 manifest ${JSON.stringify(man.pack_id)} 不一致`);
    }
    if (meta["content_version"] !== String(man.content_version)) {
      throw new Error(`pack meta content_version=${JSON.stringify(meta["content_version"] ?? "")} 与 manifest ${man.content_version} 不一致`);
    }
    if (meta["merkle_root"] !== man.merkle_root) {
      throw new Error(`pack meta merkle_root=${JSON.stringify(meta["merkle_root"] ?? "")} 与 manifest ${JSON.stringify(man.merkle_root)} 不一致`);
    }

    interface ArticleRow {
      title: string;
      digest: string;
      publishedAt: string;
      tagsJSON: string;
      bodyMD: string;
      contentHash: string;
      sourceRev: string;
    }
    const articles: Record<string, ArticleRow> = {};
    for (const r of db.all(
      `SELECT item_id,title,digest,published_at,tags_json,body_md,content_hash,source_rev FROM articles`,
    )) {
      articles[toStr(r.item_id)] = {
        title: toStr(r.title),
        digest: toStr(r.digest),
        publishedAt: toStr(r.published_at),
        tagsJSON: toStr(r.tags_json),
        bodyMD: toStr(r.body_md),
        contentHash: toStr(r.content_hash),
        sourceRev: toStr(r.source_rev),
      };
    }

    interface MediaRow {
      mime: string;
      chunkJSON: string;
      size: number;
      duration: number;
      chunkSize: number;
    }
    const media: Record<string, MediaRow> = {};
    for (const r of db.all(
      `SELECT item_id,mime,size,duration,chunk_size,chunk_hashes_json FROM media_meta`,
    )) {
      media[toStr(r.item_id)] = {
        mime: toStr(r.mime),
        chunkJSON: toStr(r.chunk_hashes_json),
        size: toNum(r.size),
        duration: toNum(r.duration),
        chunkSize: toNum(r.chunk_size),
      };
    }

    interface QuizRow {
      questionJSON: string;
      contentHash: string;
    }
    const quizzes: Record<string, QuizRow> = {};
    for (const r of db.all(`SELECT item_id,question_json,content_hash FROM quizzes`)) {
      quizzes[toStr(r.item_id)] = {
        questionJSON: toStr(r.question_json),
        contentHash: toStr(r.content_hash),
      };
    }

    const segs: Record<string, StoreSegment[]> = {};
    for (const r of db.all(
      `SELECT item_id,seq,kind,text,content_hash FROM segments ORDER BY item_id ASC, seq ASC`,
    )) {
      const id = toStr(r.item_id);
      const seg: StoreSegment = {
        itemId: id,
        seq: toNum(r.seq),
        kind: toStr(r.kind),
        text: toStr(r.text),
        contentHash: toStr(r.content_hash),
      };
      (segs[id] ??= []).push(seg);
    }

    const out: PackEntry[] = [];
    for (const e of man.entries) {
      const base = baseEntry(e);
      switch (e.sqlite_table) {
        case "articles": {
          const r = articles[e.item_id];
          if (r === undefined) {
            throw new Error(`pack 缺少 manifest 声明的文章行 ${e.item_id}`);
          }
          if (r.contentHash !== e.content_hash) {
            throw new Error(
              `pack 行级 hash 不符 ${e.item_id}: ${JSON.stringify(r.contentHash)} != ${JSON.stringify(e.content_hash)}`,
            );
          }
          if (sha256Hex(utf8(r.bodyMD)) !== e.content_hash) {
            throw new Error(`pack 正文哈希与 manifest 不符 ${e.item_id}`);
          }
          base.title = r.title;
          base.digest = r.digest;
          base.publishedAt = r.publishedAt;
          base.tagsJson = r.tagsJSON;
          base.bodyMd = r.bodyMD;
          break;
        }
        case "media_meta": {
          const r = media[e.item_id];
          if (r === undefined) {
            throw new Error(`pack 缺少 manifest 声明的媒体行 ${e.item_id}`);
          }
          const hashes = parseChunkHashes(e.item_id, r.chunkJSON);
          const chunks = e.chunks ?? [];
          if (hashes.length !== chunks.length) {
            throw new Error(
              `pack 块数不符 ${e.item_id}: ${hashes.length} != ${chunks.length}`,
            );
          }
          let sum = 0;
          for (const c of chunks) sum += c.size;
          if (r.size !== sum) {
            throw new Error(`pack 媒体大小不符 ${e.item_id}: ${r.size} != ${sum}`);
          }
          base.mime = r.mime;
          base.size = r.size;
          base.duration = r.duration;
          base.chunkSize = r.chunkSize;
          base.chunkHashes = hashes;
          break;
        }
        case "quizzes": {
          const r = quizzes[e.item_id];
          if (r === undefined) {
            throw new Error(`pack 缺少 manifest 声明的题库行 ${e.item_id}`);
          }
          if (r.contentHash !== e.content_hash || sha256Hex(utf8(r.questionJSON)) !== e.content_hash) {
            throw new Error(`pack 行级 hash 不符 ${e.item_id}`);
          }
          base.questionJson = r.questionJSON;
          break;
        }
        case "segments": {
          const rowsList = segs[e.item_id];
          if (rowsList === undefined || rowsList.length === 0) {
            throw new Error(`pack 缺少 manifest 声明的 segments 行 ${e.item_id}`);
          }
          const ordered: StoreSegment[] = [];
          for (const r of rowsList) {
            if (r.contentHash !== sha256Hex(utf8(r.text))) {
              throw new Error(`pack segments 行级 hash 不符 ${e.item_id} seq=${r.seq}`);
            }
            ordered.push({ itemId: e.item_id, seq: r.seq, kind: r.kind, text: r.text, contentHash: r.contentHash });
          }
          // 条目级口径必须等于 manifest 的 content_hash
          if (segmentsContentHash(ordered) !== e.content_hash) {
            throw new Error(`pack segments 条目级 hash 与 manifest 不符 ${e.item_id}`);
          }
          base.segments = ordered;
          break;
        }
        default:
          throw new Error(`manifest 条目 ${e.item_id} 的 sqlite_table=${JSON.stringify(e.sqlite_table)} 不支持入库`);
      }
      const [authorId, authorSig] = resolveAuthor(man, e);
      base.authorId = authorId;
      base.authorSig = authorSig;
      out.push(base);
    }
    return out;
  } finally {
    db.close();
  }
}

/**
 * resolveAuthor（packimport.go:339-359）：用该包内嵌的 contributors 公钥验证条目归属。
 * 任一步不成立即**降级为无归属**，绝不影响该包的其余条目、也不拒绝整包。
 */
export function resolveAuthor(man: Manifest, e: Entry): [string, string] {
  const authorId = e.author_id ?? "";
  const authorSig = e.author_sig ?? "";
  if (authorId === "" || authorSig === "") return ["", ""];
  const pub = man.contributors?.[authorId] ?? "";
  if (pub === "") {
    console.warn(`peersync: 条目 ${e.item_id} 的归属公钥未随包提供（author_id=${authorId}），降级为无归属`);
    return ["", ""];
  }
  let derived = "";
  try {
    derived = deriveIdentityId(pub);
  } catch {
    derived = "";
  }
  if (derived !== authorId) {
    console.warn(`peersync: 条目 ${e.item_id} 的归属公钥与 author_id 失配，降级为无归属`);
    return ["", ""];
  }
  let ok = false;
  try {
    ok = verifyAuthorSig(pub, e.item_id, e.content_hash, authorId, authorSig);
  } catch {
    ok = false;
  }
  if (!ok) {
    console.warn(`peersync: 条目 ${e.item_id} 的归属验签失败，降级为无归属`);
    return ["", ""];
  }
  return [authorId, authorSig];
}