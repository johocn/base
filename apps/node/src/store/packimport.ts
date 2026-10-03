// 逐行移植 internal/store/packimport.go：包入库（墓碑 + 条目 upsert 同事务）。
// SQL 文本逐字照抄 Go（含换行与制表符）。加解密复用 host/aesgcm.ts；DB 参数用 HostDb。
// 同时移植 tag.go 的 backfillTagLinksTx / listSegmentsTx / replaceTagLinksTx / MaterializeTagSegments
// （ImportPack 对 `tag/` 前缀条目循环后要回填 tag_links，册子 §3.3）。
import { encText } from "../host/aesgcm";
import type { HostDb } from "../host/sqlite";
import { segmentsContentHash, type Tombstone, sha256Hex, utf8 } from "@base/protocol-ts";
import type { StoreSegment } from "@base/core-ts";

/** PackEntry 是已通过 manifest 与 pack 行级校验、待入库的条目行（对齐 Go store.PackEntry）。 */
export interface PackEntry {
  itemId: string;
  source: string;
  type: string;
  title: string;
  sourceRev: string;
  contentHash: string;
  sqliteTable: string;
  distClass: string;
  updatedAt: string;

  // 归属（治理册 §3.1）：由调用方（peersync）验签后填入；验不过则为空串。
  authorId: string;
  authorSig: string;

  // sqliteTable == "articles"
  digest: string;
  publishedAt: string;
  tagsJson: string;
  bodyMd: string;

  // sqliteTable == "media_meta"
  mime: string;
  size: number;
  duration: number;
  chunkSize: number;
  chunkHashes: string[];

  // sqliteTable == "segments"
  segments: StoreSegment[];

  // sqliteTable == "quizzes"
  questionJson: string;
}

/** 一次包入库的结果。 */
export interface ImportResult {
  version: number;
  entries: number; // 真正写入的条目数
  skipped: number; // dist_class != public，跳过入库
  rejected: string[]; // 防回卷拒绝的 item_id
  removedBlobs: string[]; // 墓碑连带清掉的 blob_id；调用方提交后负责删文件
}

/** `time.Now().UTC().Format(time.RFC3339)`：无毫秒。 */
function nowUTC(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** tag_links 的一行（tag.go:17-21）。 */
interface TagLink {
  tagId: string;
  targetId: string;
  kind: string;
}

/** tagKindRank（tag.go:34-41）：物化 segments 行的 kind 固定序。 */
function tagKindRank(kind: string): number {
  const order = ["course", "lesson", "article", "comment"];
  const i = order.indexOf(kind);
  return i === -1 ? 4 : i;
}

/** TagKindAllowed（protocol/tag.go:139-146）：kind ∈ {course,lesson,article,comment}。 */
function tagKindAllowed(kind: string): boolean {
  return tagKindRank(kind) !== 4;
}

/** MaterializeTagSegments（tag.go:46-65）：seq 从 1 起，kind 固定序 + target_id 字典序，去重。 */
function materializeTagSegments(tagID: string, links: TagLink[]): StoreSegment[] {
  const ordered = [...links].sort((a, b) => {
    const ra = tagKindRank(a.kind);
    const rb = tagKindRank(b.kind);
    if (ra !== rb) return ra - rb;
    if (a.targetId < b.targetId) return -1;
    if (a.targetId > b.targetId) return 1;
    return 0;
  });
  const segs: StoreSegment[] = [];
  const seen = new Set<string>();
  for (const l of ordered) {
    if (seen.has(l.targetId)) continue;
    seen.add(l.targetId);
    segs.push({ itemId: tagID, seq: segs.length + 1, kind: l.kind, text: l.targetId, contentHash: "" });
  }
  return segs;
}

/** listSegmentsTx（tag.go:204-219）：按 seq 升序读某条目的 segments 行。 */
function listSegments(db: HostDb, itemID: string): StoreSegment[] {
  const rows = db.all(
    `SELECT item_id,seq,kind,text,content_hash FROM segments WHERE item_id=? ORDER BY seq ASC`,
    [itemID],
  );
  return rows.map((r) => ({
    itemId: String(r.item_id ?? ""),
    seq: Number(r.seq ?? 0),
    kind: String(r.kind ?? ""),
    text: String(r.text ?? ""),
    contentHash: String(r.content_hash ?? ""),
  }));
}

/** replaceTagLinksTx（tag.go:71-92）：全量替换关联集，重算物化 segments 行。 */
function replaceTagLinks(db: HostDb, tagID: string, links: TagLink[]): string {
  try {
    db.run(`DELETE FROM tag_links WHERE tag_id=?`, [tagID]);
  } catch (err) {
    throw new Error(`store: 清旧 tag_links ${tagID}: ${String(err)}`);
  }
  const segs = materializeTagSegments(tagID, links);
  for (const s of segs) {
    try {
      db.run(`INSERT INTO tag_links(tag_id,target_id,kind,created_at) VALUES(?,?,?,?)`, [
        tagID,
        s.text,
        s.kind,
        nowUTC(),
      ]);
    } catch (err) {
      throw new Error(`store: 写 tag_links ${tagID}→${s.text}: ${String(err)}`);
    }
  }
  try {
    db.run(`DELETE FROM segments WHERE item_id=? AND seq>=1`, [tagID]);
  } catch (err) {
    throw new Error(`store: 清旧 segments ${tagID}: ${String(err)}`);
  }
  for (const s of segs) {
    try {
      db.run(`INSERT INTO segments(item_id,seq,kind,text,content_hash) VALUES(?,?,?,?,?)`, [
        tagID,
        s.seq,
        s.kind,
        s.text,
        sha256Hex(utf8(s.text)),
      ]);
    } catch (err) {
      throw new Error(`store: 写 segments ${tagID} seq=${s.seq}: ${String(err)}`);
    }
  }
  return segmentsContentHash(segs);
}

/** backfillTagLinksTx（tag.go:224-238）：把已入库标签条目的 segments 行幂等回填进 tag_links。 */
function backfillTagLinks(db: HostDb, tagID: string): void {
  const segs = listSegments(db, tagID);
  const links: TagLink[] = [];
  for (const s of segs) {
    if (!tagKindAllowed(s.kind) || s.text.trim() === "") continue;
    links.push({ tagId: tagID, targetId: s.text, kind: s.kind });
  }
  replaceTagLinks(db, tagID, links);
}

/** blobIDsOfItemTx（packimport.go:205-220）：某条目当前关联的 blob_id 列表。 */
function blobIDsOfItem(db: HostDb, itemID: string): string[] {
  const rows = db.all(`SELECT blob_id FROM blobs WHERE item_id=?`, [itemID]);
  return rows.map((r) => String(r.blob_id ?? ""));
}

/** revokedRevOfTx（packimport.go:222-229）：某条目的墓碑 rev；无行返回 0。 */
function revokedRevOf(db: HostDb, itemID: string): number {
  const row = db.get(`SELECT revoked_rev FROM tombstones WHERE item_id=?`, [itemID]);
  if (row === undefined) return 0;
  return Number(row.revoked_rev ?? 0);
}

/**
 * ImportPack（packimport.go:68-203）：在一个事务内应用墓碑并 upsert 条目。
 * 调用方必须在事务外做完一切跨节点判断（manifest 验签、pack 行级比对）——本函数不做任何这类判断。
 */
export function importPack(
  db: HostDb,
  dataDir: string,
  storeKey: Uint8Array,
  version: number,
  entries: PackEntry[],
  tombstones: Tombstone[],
): ImportResult {
  void dataDir;
  const res: ImportResult = {
    version,
    entries: 0,
    skipped: 0,
    rejected: [],
    removedBlobs: [],
  };
  const tagIDs: string[] = [];
  db.exec("BEGIN");
  try {
    for (const t of tombstones) {
      try {
        db.run(
          `INSERT INTO tombstones(item_id,revoked_rev) VALUES(?,?)
\t\t\tON CONFLICT(item_id) DO UPDATE SET revoked_rev=MAX(revoked_rev,excluded.revoked_rev)`,
          [t.item_id, t.revoked_rev],
        );
      } catch (err) {
        throw new Error(`store: 应用墓碑 ${t.item_id}: ${String(err)}`);
      }
      const ids = blobIDsOfItem(db, t.item_id);
      res.removedBlobs.push(...ids);
      for (const q of [
        `DELETE FROM media_meta WHERE item_id=?`,
        `DELETE FROM articles WHERE item_id=?`,
        `DELETE FROM segments WHERE item_id=?`,
        `DELETE FROM items WHERE item_id=?`,
        `DELETE FROM blobs WHERE item_id=?`,
      ]) {
        try {
          db.run(q, [t.item_id]);
        } catch (err) {
          throw new Error(`store: 墓碑清理 ${t.item_id}: ${String(err)}`);
        }
      }
    }

    for (const e of entries) {
      if (e.distClass !== "" && e.distClass !== "public") {
        res.skipped++;
        continue;
      }
      const revoked = revokedRevOf(db, e.itemId);
      if (revoked > 0 && revoked >= version) {
        res.rejected.push(e.itemId);
        continue;
      }
      let updated = e.updatedAt;
      if (updated === "") updated = nowUTC();
      try {
        db.run(
          `INSERT INTO items(item_id,source,type,title,source_rev,content_hash,sqlite_table,dist_class,state,updated_at,author_id,author_sig)
\t\t\tVALUES(?,?,?,?,?,?,?,'public','active',?,?,?)
\t\t\tON CONFLICT(item_id) DO UPDATE SET
\t\t\t\tsource=excluded.source, type=excluded.type, title=excluded.title, source_rev=excluded.source_rev,
\t\t\t\tcontent_hash=excluded.content_hash, sqlite_table=excluded.sqlite_table,
\t\t\t\tdist_class=excluded.dist_class, state=excluded.state, updated_at=excluded.updated_at,
\t\t\t\tauthor_id=excluded.author_id, author_sig=excluded.author_sig`,
          [
            e.itemId,
            e.source,
            e.type,
            e.title,
            e.sourceRev,
            e.contentHash,
            e.sqliteTable,
            updated,
            e.authorId,
            e.authorSig,
          ],
        );
      } catch (err) {
        throw new Error(`store: 入库 items ${e.itemId}: ${String(err)}`);
      }
      switch (e.sqliteTable) {
        case "segments": {
          const ordered = [...e.segments].sort((a, b) => a.seq - b.seq);
          try {
            db.run(`DELETE FROM segments WHERE item_id=?`, [e.itemId]);
          } catch (err) {
            throw new Error(`store: 入库 segments 清旧行 ${e.itemId}: ${String(err)}`);
          }
          for (const seg of ordered) {
            try {
              db.run(`INSERT INTO segments(item_id,seq,kind,text,content_hash) VALUES(?,?,?,?,?)`, [
                e.itemId,
                seg.seq,
                seg.kind,
                seg.text,
                sha256Hex(utf8(seg.text)),
              ]);
            } catch (err) {
              throw new Error(`store: 入库 segments ${e.itemId} seq=${seg.seq}: ${String(err)}`);
            }
          }
          if (e.itemId.startsWith("tag/")) tagIDs.push(e.itemId);
          break;
        }
        case "articles": {
          let bodyEnc: string;
          try {
            bodyEnc = encText(storeKey, e.bodyMd);
          } catch (err) {
            throw new Error(`store: 加密 ${e.itemId} 正文: ${String(err)}`);
          }
          try {
            db.run(
              `INSERT INTO articles(item_id,title,digest,published_at,tags_json,body_md,content_hash,source_rev)
\t\t\t\tVALUES(?,?,?,?,?,?,?,?)
\t\t\t\tON CONFLICT(item_id) DO UPDATE SET
\t\t\t\t\ttitle=excluded.title, digest=excluded.digest, published_at=excluded.published_at,
\t\t\t\t\ttags_json=excluded.tags_json, body_md=excluded.body_md,
\t\t\t\t\tcontent_hash=excluded.content_hash, source_rev=excluded.source_rev`,
              [
                e.itemId,
                e.title,
                e.digest,
                e.publishedAt,
                e.tagsJson,
                bodyEnc,
                e.contentHash,
                e.sourceRev,
              ],
            );
          } catch (err) {
            throw new Error(`store: 入库 articles ${e.itemId}: ${String(err)}`);
          }
          break;
        }
        case "media_meta": {
          const hashes = e.chunkHashes ?? [];
          const chunkJSON = JSON.stringify(hashes);
          try {
            db.run(
              `INSERT INTO media_meta(item_id,mime,size,duration,chunk_size,chunk_hashes_json)
\t\t\t\tVALUES(?,?,?,?,?,?)
\t\t\t\tON CONFLICT(item_id) DO UPDATE SET
\t\t\t\t\tmime=excluded.mime, size=excluded.size, duration=excluded.duration,
\t\t\t\t\tchunk_size=excluded.chunk_size, chunk_hashes_json=excluded.chunk_hashes_json`,
              [e.itemId, e.mime, e.size, e.duration, e.chunkSize, chunkJSON],
            );
          } catch (err) {
            throw new Error(`store: 入库 media_meta ${e.itemId}: ${String(err)}`);
          }
          break;
        }
        case "quizzes": {
          try {
            db.run(
              `INSERT INTO quizzes(item_id,question_json,content_hash) VALUES(?,?,?)
\t\t\t\tON CONFLICT(item_id) DO UPDATE SET question_json=excluded.question_json, content_hash=excluded.content_hash`,
              [e.itemId, e.questionJson, e.contentHash],
            );
          } catch (err) {
            throw new Error(`store: 入库 quizzes ${e.itemId}: ${String(err)}`);
          }
          break;
        }
        default:
          throw new Error(`store: 条目 ${e.itemId} 的 sqlite_table=${e.sqliteTable} 不支持入库`);
      }

      // 融合治理册 §2.2 轨道 B：条目有 author_id 时，用稳定派生出的 circle_id
      // 内联 INSERT OR IGNORE 写 groups 与 circle_assignments。
      // 钩子永不返回 error：写失败只打 console.warn，不破坏导入事务。
      if (e.authorId !== "") {
        const nowMs = Date.now();
        const circleID = sha256Hex(utf8(e.itemId + ":circle")).slice(0, 16);
        try {
          db.run(
            `INSERT OR IGNORE INTO groups(group_id,creator_id,epoch,roster_rev,encrypted,member_ids_json,key_envelopes,event_id,updated_at,origin)
\t\t\t\tVALUES(?,?,?,?,?,?,?,?,?,?)`,
            [
              circleID,
              e.authorId,
              1,
              0,
              1,
              JSON.stringify([e.authorId]),
              "[]",
              circleID,
              nowMs,
              "fusion",
            ],
          );
        } catch (err) {
          console.warn(`store: 融合条目 ${e.itemId} 写 groups 失败: ${String(err)}`);
        }
        try {
          db.run(
            `INSERT OR IGNORE INTO circle_assignments(item_id,circle_id,origin,created_at) VALUES(?,?,?,?)`,
            [e.itemId, circleID, "fusion", nowMs],
          );
        } catch (err) {
          console.warn(`store: 融合条目 ${e.itemId} 写 circle_assignments 失败: ${String(err)}`);
        }
      }
      res.entries++;
    }

    for (const id of tagIDs) {
      try {
        backfillTagLinks(db, id);
      } catch (err) {
        throw new Error(`store: 回填 tag_links ${id}: ${String(err)}`);
      }
    }

    try {
      db.run(
        `INSERT INTO meta(key,value) VALUES('content_version',?)
\t\t\tON CONFLICT(key) DO UPDATE SET value=excluded.value`,
        [String(version)],
      );
    } catch (err) {
      throw new Error(`store: 写 content_version: ${String(err)}`);
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  return res;
}