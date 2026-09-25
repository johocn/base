export interface ItemRow {
  itemId: string;
  source: string;
  type: string;
  title: string;
  rev: string;
  contentHash: string;
  /** active | removed */
  state: string;
  updatedAt: string;
}

export interface ArticleRow {
  itemId: string;
  title: string;
  digest: string;
  publishedAt: string;
  tagsJson: string;
  bodyMd: string;
  contentHash: string;
  rev: string;
}

export interface TombstoneRow {
  itemId: string;
  revokedRev: number;
}