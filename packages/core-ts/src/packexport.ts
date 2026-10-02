/**
 * 内容包装配的**纯算法**（对齐 `internal/packexport/export.go:88-221`）：
 * 输入 = 已读好的纯数据，输出 = 装配结果（pack_id / merkle / manifest / 待写入 pack.sqlite 的行）。
 * **不引入任何端口/接口，不做文件 IO，不写 SQLite**——写出与落盘全在 `apps/node`。
 */
import {
  derivePackId,
  merkleRoot,
  signManifest,
  type Entry,
  type Manifest,
  type Tombstone,
} from "@base/protocol-ts";

import { declaredChunks } from "./store/chunks";
import type {
  MediaMeta,
  StoreArticle,
  StoreItem,
  StoreQuiz,
  StoreSegment,
} from "./store/types";

/** 可导出 sqlite_table 的**显式白名单**（对齐 export.go:59-64，集合式判断）。 */
const EXPORTABLE_TABLES: ReadonlySet<string> = new Set([
  "articles",
  "media_meta",
  "quizzes",
  "segments",
]);

/** media_meta 待写行（chunk_hashes_json 为已序列化文本）。 */
export interface MediaMetaRow {
  itemId: string;
  mime: string;
  size: number;
  duration: number;
  chunkSize: number;
  chunkHashesJson: string;
}

/** 待写入 pack.sqlite 的一行（按 entries 顺序排列，跨表保持 Go 的插入序）。 */
export type PackWrite =
  | { kind: "article"; row: StoreArticle }
  | { kind: "quiz"; row: StoreQuiz }
  | { kind: "mediaMeta"; row: MediaMetaRow }
  | { kind: "segment"; row: StoreSegment };

export interface PackRows {
  writes: PackWrite[];
  /** 四条 meta：schema_version / pack_id / content_version / merkle_root。 */
  meta: [string, string][];
}

export interface ExportInput {
  issuer: string;
  signKeyHex: string;
  /** 已解析的正版本号（0 自增在宿主层完成，纯层只收确定值）。 */
  version: number;
  /** 已格式化的 RFC3339 UTC 签发时间（"2006-01-02T15:04:05Z" 口径）。 */
  issuedAt: string;
  /** 已 `ListItems("active")`。 */
  items: readonly StoreItem[];
  /** item_id → 已解密文章行。 */
  articles: Record<string, StoreArticle>;
  quizzes: Record<string, StoreQuiz>;
  /** item_id → segments（仅 segments 表条目需要）。 */
  segments: Record<string, StoreSegment[]>;
  /** item_id → media_meta（仅 media_meta 表条目需要；缺失用 null）。 */
  mediaMeta: Record<string, MediaMeta | null>;
  identities: Record<string, string>;
  tombstones: readonly Tombstone[];
}

export interface ExportResult {
  packId: string;
  contentVersion: number;
  merkleRoot: string;
  entries: Entry[];
  manifest: Manifest;
  rows: PackRows;
}

/** 装配一个内容包（确定性：条目按 item_id 升序，块序列以 media_meta 声明为准）。 */
export function buildPack(input: ExportInput): ExportResult {
  if (input.issuer === "") throw new Error("packexport: issuer 不能为空");
  if (input.signKeyHex === "") {
    throw new Error("packexport: 缺少签名私钥（BASE_SIGN_KEY），无私钥不能签发内容包");
  }
  const items = [...input.items];
  for (const it of items) {
    if (it.distClass !== "public") {
      throw new Error(
        `packexport: 条目 ${it.itemId} dist_class=${it.distClass}，受控内容不得进入内容包`,
      );
    }
    if (!EXPORTABLE_TABLES.has(it.sqliteTable)) {
      throw new Error(
        `packexport: 条目 ${it.itemId} 的 sqlite_table=${it.sqliteTable} 不在可导出白名单内`,
      );
    }
  }
  items.sort((a, b) => (a.itemId < b.itemId ? -1 : a.itemId > b.itemId ? 1 : 0));

  const contributors: Record<string, string> = {};
  const entries: Entry[] = [];
  const blobIds: string[] = [];
  for (const it of items) {
    const e: Entry = {
      item_id: it.itemId,
      source: it.source,
      type: it.type,
      title: it.title,
      source_rev: it.sourceRev,
      content_hash: it.contentHash,
      sqlite_table: it.sqliteTable,
      dist_class: it.distClass,
    };
    const pub = input.identities[it.authorId];
    if (it.authorId !== "" && it.authorSig !== "" && pub !== undefined) {
      e.author_id = it.authorId;
      e.author_sig = it.authorSig;
      contributors[it.authorId] = pub;
    }
    if (it.sqliteTable === "media_meta") {
      const meta = input.mediaMeta[it.itemId];
      if (meta === undefined || meta === null) {
        throw new Error(`packexport: 条目 ${it.itemId} 在 media_meta 表缺失`);
      }
      const refs = declaredChunks(it.itemId, meta);
      if (refs.length === 0) {
        throw new Error(`packexport: 条目 ${it.itemId} 没有任何块文件`);
      }
      e.chunks = refs.map((r) => ({ blob_id: r.blobId, size: r.size, seq: r.seq }));
      for (const r of refs) blobIds.push(r.blobId);
    }
    entries.push(e);
  }

  const merkle = merkleRoot(blobIds);
  const packId = derivePackId(input.issuer, input.version, merkle);

  const writes: PackWrite[] = [];
  for (const e of entries) {
    switch (e.sqlite_table) {
      case "articles": {
        const a = input.articles[e.item_id];
        if (a === undefined) throw new Error(`packexport: 条目 ${e.item_id} 在 articles 表缺失`);
        writes.push({ kind: "article", row: a });
        break;
      }
      case "quizzes": {
        const q = input.quizzes[e.item_id];
        if (q === undefined) throw new Error(`packexport: 条目 ${e.item_id} 在 quizzes 表缺失`);
        writes.push({ kind: "quiz", row: q });
        break;
      }
      case "media_meta": {
        const m = input.mediaMeta[e.item_id];
        if (m === undefined || m === null) {
          throw new Error(`packexport: 条目 ${e.item_id} 在 media_meta 表缺失`);
        }
        writes.push({
          kind: "mediaMeta",
          row: {
            itemId: e.item_id,
            mime: m.mime,
            size: m.size,
            duration: m.duration,
            chunkSize: m.chunkSize,
            chunkHashesJson: JSON.stringify(m.chunkHashes),
          },
        });
        break;
      }
      case "segments": {
        const segs = input.segments[e.item_id];
        if (segs === undefined || segs.length === 0) {
          throw new Error(`packexport: 条目 ${e.item_id} 在 segments 表缺失`);
        }
        for (const s of segs) writes.push({ kind: "segment", row: s });
        break;
      }
    }
  }
  const meta: [string, string][] = [
    ["schema_version", "1"],
    ["pack_id", packId],
    ["content_version", String(input.version)],
    ["merkle_root", merkle],
  ];

  const manifest: Manifest = {
    pack_id: packId,
    schema_version: 1,
    issuer: input.issuer,
    issued_at: input.issuedAt,
    content_version: input.version,
    entries,
    tombstone: [...input.tombstones],
    merkle_root: merkle,
    signature: "",
  };
  // Go 的 contributors 带 omitempty：空 map 不落 JSON，故此处仅在非空时挂键。
  if (Object.keys(contributors).length > 0) manifest.contributors = contributors;

  const signed = signManifest(manifest, input.signKeyHex);
  return {
    packId,
    contentVersion: input.version,
    merkleRoot: merkle,
    entries,
    manifest: signed,
    rows: { writes, meta },
  };
}
