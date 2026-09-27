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