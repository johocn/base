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

export interface FavoriteRow {
  itemId: string;
  title: string;
  favoritedAt: string;
}

export interface LearningStats {
  readCount: number;
  quizAttempts: number;
  /** null = 还没有任何作答（界面显示 `-`） */
  correctRate: number | null;
  /** 阅读与作答时间的较大者；从未学习则为空串 */
  lastAt: string;
}

/** 题库条目（与节点侧 quizzes 表同形的三列） */
export interface QuizRow {
  itemId: string;
  questionJson: string;
  contentHash: string;
}

/** 容器条目的一行 segments（与节点侧 segments 表同形；seq=0 为简介，seq>=1 为子项 item_id） */
export interface SegmentRow {
  itemId: string;
  seq: number;
  kind: string;
  text: string;
  contentHash: string;
}

/** question_json 里的一道题（spec §6.2） */
export interface Question {
  q: string;
  options: string[];
  /** 正确选项下标 */
  answer: number;
  explain: string;
}

export interface QuestionDoc {
  schema_version: number;
  questions: Question[];
}

/**
 * 待发评论（本地 `comment_out` 表，本册 §3.1）。
 * `wire` 是**已签名的完整请求体文本**：`event_id` / `created_at` / `sig` 全部冻结在内，
 * 补发时逐字节重放（`sig` 覆盖的是 canonical 出来的确定字节序，重排即失效）。
 */
export interface CommentOutRow {
  eventId: string;
  targetId: string;
  text: string;
  replyTo: string | null;
  wire: string;
  state: 'pending' | 'failed';
  /** state='failed' 时的用户可读原因 */
  reason: string | null;
  /** 入队时刻 ISO8601，排序用 */
  queuedAt: string;
}