/**
 * `internal/importer/quiz.go` 的**纯派生**：题库 markdown → question_json / content_hash。
 * 不读库、不写盘；question_json 用 Go-json 等价序列化器产出（`encoding/json` 语义）。
 */
import { sha256Hex, utf8 } from "@base/protocol-ts";

import { splitFrontMatter, stemOf } from "./frontmatter";
import { marshalGoJSON } from "./gojson";

/** 一道题（spec §6.2）。键名即契约，勿改。 */
export interface Question {
  q: string;
  options: string[];
  answer: number;
  explain: string;
}

/** 一个题组的完整 question_json（Go `QuestionDoc`）。 */
export interface QuestionDoc {
  schemaVersion: number;
  questions: Question[];
}

/** 一份待导入的题库（Go `Quiz`）。 */
export interface Quiz {
  slug: string;
  title: string;
  questions: Question[];
}

/** 题库写库行的派生（对齐 Go `importQuiz`，`md.go:393-410`）。 */
export interface QuizRow {
  itemId: string;
  title: string;
  questionJson: string;
  contentHash: string;
  sourceRev: string;
}

/**
 * 解析 front-matter 带 `type: quiz` 的 markdown（spec §6.1 固定语法）。
 * 语法：`### ` 题干 / `- ` 选项（`- [x] ` / `- [X] ` 为正确）/ `> ` 解析（多行 `\n` 拼接）。
 * 失败语义：整份文件拒绝，不做部分导入。
 */
export function parseQuiz(filename: string, raw: string): Quiz {
  const { meta, body: rawBody } = splitFrontMatter(raw);
  const body = rawBody.replace(/^\n+/, "").replace(/\n+$/, "");
  if (body === "") throw new Error(`importer: ${filename} 正文为空`);
  let slug = meta.slug ?? "";
  let title = meta.title ?? "";
  if (slug === "") slug = stemOf(filename);
  if (title === "") title = slug;
  return { slug, title, questions: parseQuestions(filename, body) };
}

function parseQuestions(filename: string, body: string): Question[] {
  const out: Question[] = [];
  let cur: Question | null = null;
  const flush = (): void => {
    if (cur === null) return;
    if (cur.options.length < 2) {
      throw new Error(
        `importer: ${filename} 题目「${cur.q}」至少两个选项，实际 ${cur.options.length} 个`,
      );
    }
    if (cur.answer < 0) {
      throw new Error(`importer: ${filename} 题目「${cur.q}」必须有恰好一个正确答案`);
    }
    out.push(cur);
    cur = null;
  };
  for (const rawLine of body.split("\n")) {
    const line = rawLine.trim();
    if (line.startsWith("### ")) {
      flush();
      cur = { q: line.slice(4).trim(), options: [], answer: -1, explain: "" };
    } else if (line.startsWith("> ")) {
      if (cur === null) {
        throw new Error(`importer: ${filename} 解析行出现在题目之前: ${line}`);
      }
      const ex = line.slice(2).trim();
      cur.explain = cur.explain === "" ? ex : cur.explain + "\n" + ex;
    } else if (line.startsWith("- ")) {
      if (cur === null) {
        throw new Error(`importer: ${filename} 选项出现在题目之前: ${line}`);
      }
      let item = line.slice(2).trim();
      if (item.startsWith("[x] ") || item.startsWith("[X] ")) {
        if (cur.answer >= 0) {
          throw new Error(`importer: ${filename} 题目「${cur.q}」有多个正确答案`);
        }
        cur.answer = cur.options.length;
        item = item.slice(4).trim();
      } else if (item.startsWith("[ ] ")) {
        item = item.slice(4).trim();
      }
      if (item === "") {
        throw new Error(`importer: ${filename} 题目「${cur.q}」有空选项`);
      }
      cur.options.push(item);
    } else if (line === "") {
      // 空行只作分隔
    } else if (cur !== null) {
      // 题目开始前的普通文本视作前言，忽略；题目块内无法识别的行才报错。
      throw new Error(`importer: ${filename} 无法识别的行: ${line}`);
    }
  }
  flush();
  if (out.length === 0) {
    throw new Error(`importer: ${filename} 没有解析到任何题目`);
  }
  return out;
}

/**
 * 由解析结果派生题库行：question_json = Go `json.Marshal(QuestionDoc{SchemaVersion:1, ...})`，
 * content_hash = hex(sha256(question_json 的 UTF-8 字节))，source_rev = hash 前 16 字符。
 */
export function quizRowFromQuiz(itemId: string, quiz: Quiz): QuizRow {
  const questionJson = marshalGoJSON({
    schema_version: 1,
    questions: quiz.questions.map((q) => ({
      q: q.q,
      options: q.options,
      answer: q.answer,
      explain: q.explain,
    })),
  });
  const hash = sha256Hex(utf8(questionJson));
  return {
    itemId,
    title: quiz.title,
    questionJson,
    contentHash: hash,
    sourceRev: hash.slice(0, 16),
  };
}