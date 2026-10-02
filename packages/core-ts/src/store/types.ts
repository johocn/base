/**
 * 节点内容库（store）的行类型：字段与 `internal/store/store.go:45-107` 一一对应。
 * 纯数据形状，不含宿主依赖；命名字段用 camelCase，SQL 列名见 `queries.ts`。
 */

/** 目录条目（`items` 表）。author_* 是入库时已验签通过的本地归属缓存。 */
export interface StoreItem {
  itemId: string;
  source: string;
  type: string;
  title: string;
  sourceRev: string;
  contentHash: string;
  sqliteTable: string;
  distClass: string;
  state: string;
  updatedAt: string;
  authorId: string;
  authorSig: string;
}

/** 文章条目（`articles` 表）。`bodyMd` 出 store 边界前已解密。 */
export interface StoreArticle {
  itemId: string;
  title: string;
  digest: string;
  publishedAt: string;
  tagsJson: string;
  bodyMd: string;
  contentHash: string;
  sourceRev: string;
  /** 仅写路径使用；读路径（ListArticles）不取该列，映射时为空串。 */
  updatedAt: string;
}

/** 题组条目（`quizzes` 表，明文存储）。 */
export interface StoreQuiz {
  itemId: string;
  questionJson: string;
  contentHash: string;
}

/** 容器条目的一行 segments（`segments` 表）。 */
export interface StoreSegment {
  itemId: string;
  seq: number;
  kind: string;
  text: string;
  contentHash: string;
}

/** `media_meta` 表的读形（Go `GetMediaMeta` 的具名返回）。 */
export interface MediaMeta {
  mime: string;
  size: number;
  duration: number;
  chunkSize: number;
  chunkHashes: string[];
}

/** 块引用（契约第 10 条）。 */
export interface BlobRef {
  blobId: string;
  seq: number;
  size: number;
}

/** 已发布包的登记（`packs` 表）。 */
export interface PackRecord {
  packId: string;
  contentVersion: number;
  dir: string;
  merkleRoot: string;
  signature: string;
  issuedAt: string;
  itemCount: number;
  createdAt: string;
}
