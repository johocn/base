import { describe, expect, it } from "vitest";

import { parseQuiz, quizRowFromQuiz } from "./quiz";

// 与 internal/importer/quiz_test.go 的 quizMD 夹具逐字一致。
const QUIZ_MD = `---
type: quiz
slug: what-is-cid
title: 内容寻址小测
---

### 内容寻址里，一份字节的标识是什么？
- 文件路径
- [x] 内容哈希
- 递增序号
> 标识即哈希，改一个 bit 哈希就变。

### 节点之间需要共识吗？
- [x] 不需要
- 需要
> 不需要：哈希即验真。
`;

// 逐字取自一次性 Go 探针（.tmp/e2probe）：json.Marshal(QuestionDoc{SchemaVersion:1, ...})。
const FIXTURE_JSON = `{"schema_version":1,"questions":[{"q":"内容寻址里，一份字节的标识是什么？","options":["文件路径","内容哈希","递增序号"],"answer":1,"explain":"标识即哈希，改一个 bit 哈希就变。"},{"q":"节点之间需要共识吗？","options":["不需要","需要"],"answer":0,"explain":"不需要：哈希即验真。"}]}`;
const FIXTURE_SHA = "258fe5914065ce06702757e72a46835256b7e3945e7bf54e379cc79d831cfa22";

describe("parseQuiz", () => {
  it("解析 front-matter 与题目块", () => {
    const q = parseQuiz("what-is-cid.md", QUIZ_MD);
    expect(q.slug).toBe("what-is-cid");
    expect(q.title).toBe("内容寻址小测");
    expect(q.questions).toHaveLength(2);
    const first = q.questions[0]!;
    expect(first.q).toBe("内容寻址里，一份字节的标识是什么？");
    expect(first.options).toEqual(["文件路径", "内容哈希", "递增序号"]);
    expect(first.answer).toBe(1);
    expect(first.explain).toBe("标识即哈希，改一个 bit 哈希就变。");
    const second = q.questions[1]!;
    expect(second.answer).toBe(0);
    expect(second.options).toEqual(["不需要", "需要"]);
  });

  it("缺 slug/title 时用文件名 stem 兜底", () => {
    const q = parseQuiz("x.md", "---\ntype: quiz\n---\n\n### 题\n- [x] 甲\n- 乙\n");
    expect(q.slug).toBe("x");
    expect(q.title).toBe("x");
  });

  it("多行解析用 \\n 拼接，前言被忽略", () => {
    const q = parseQuiz(
      "m.md",
      "---\ntype: quiz\nslug: m\n---\n\n前言\n\n### 题\n- [x] 甲\n- 乙\n> 第一行\n> 第二行\n",
    );
    expect(q.questions[0]!.explain).toBe("第一行\n第二行");
  });

  it("正文为空即抛错", () => {
    expect(() => parseQuiz("x.md", "---\ntype: quiz\n---\n\n")).toThrowError(
      "importer: x.md 正文为空",
    );
  });

  it("非法题库逐字报错", () => {
    const cases: Array<[string, string, string]> = [
      ["选项无正确答案", "### 题\n- 甲\n- 乙\n", "importer: x.md 题目「题」必须有恰好一个正确答案"],
      ["两个正确答案", "### 题\n- [x] 甲\n- [x] 乙\n", "importer: x.md 题目「题」有多个正确答案"],
      ["没有题目", "只有一段正文\n", "importer: x.md 没有解析到任何题目"],
      ["选项少于两个", "### 题\n- [x] 甲\n", "importer: x.md 题目「题」至少两个选项，实际 1 个"],
      ["选项出现在题目之前", "- [x] 甲\n", "importer: x.md 选项出现在题目之前: - [x] 甲"],
      ["解析行出现在题目之前", "> 解析\n", "importer: x.md 解析行出现在题目之前: > 解析"],
      [
        "题目块内无法识别的行",
        "### 题\n- [x] 甲\n- 乙\n乱七八糟\n",
        "importer: x.md 无法识别的行: 乱七八糟",
      ],
    ];
    for (const [name, body, want] of cases) {
      expect(() => parseQuiz("x.md", "---\ntype: quiz\nslug: x\n---\n\n" + body), name).toThrowError(
        want,
      );
    }
  });
});

describe("quizRowFromQuiz", () => {
  it("question_json 与 content_hash 逐字对齐 Go json.Marshal", () => {
    const q = parseQuiz("what-is-cid.md", QUIZ_MD);
    const row = quizRowFromQuiz("course/c1/lesson/l1/quiz/what-is-cid", q);
    expect(row.title).toBe("内容寻址小测");
    expect(row.questionJson).toBe(FIXTURE_JSON);
    expect(row.contentHash).toBe(FIXTURE_SHA);
    expect(row.sourceRev).toBe(FIXTURE_SHA.slice(0, 16));
  });
});