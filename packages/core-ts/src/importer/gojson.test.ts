import { describe, expect, it } from "vitest";
import { sha256Hex, utf8 } from "@base/protocol-ts";

import { marshalGoJSON } from "./gojson";
import { articleRowFromDoc, parseMD } from "./md";

// 逐字取自一次性 Go 探针（.tmp/e2probe，json.Marshal + sha256）。
const HOSTILE = String.raw`{"schema_version":1,"questions":[{"q":"a\u003cb\u003e\u0026c \"d\" \\e /f","options":["\u003cx\u003e","\u0026y","中/Z","ls:\u2028 ps:\u2029","ctrl:\u0001\t"],"answer":2,"explain":"解释\u003c\u0026\u003e\n第二行"},{"q":"q2","options":["1","2"],"answer":0,"explain":""}]}`;
const HOSTILE_SHA = "e05876c9c9d31b630e6563ffcc6ed06206975a5d6af6e98962ed43a155692a0a";

const TAGS_HTML = String.raw`["a\u003cb\u003e","c\u0026d","e/f"]`;
const TAGS_HTML_SHA = "90e7fbe9aab3d4e34cc6260878bbbae13eeba201a16a866522f2950c9e38fba6";
const TAGS_U2028 = String.raw`["u\u2028v"]`;
const TAGS_U2028_SHA = "7d5551dd2d9a537f6a69c2e539202fdc9e72b4f7bf82096b1001f53bd0ce3241";
const TAGS_EMPTY = "[]";

const hostileValue = {
  schema_version: 1,
  questions: [
    {
      q: 'a<b>&c "d" \\e /f',
      options: ["<x>", "&y", "中/Z", "ls:\u2028 ps:\u2029", "ctrl:\u0001\t"],
      answer: 2,
      explain: "解释<&>\n第二行",
    },
    { q: "q2", options: ["1", "2"], answer: 0, explain: "" },
  ],
};

describe("marshalGoJSON", () => {
  it("HTML 转义 / U+2028 / U+2029 / 控制字符 / 斜杠不转义，逐字对齐 Go", () => {
    const got = marshalGoJSON(hostileValue);
    expect(got).toBe(HOSTILE);
    expect(sha256Hex(utf8(got))).toBe(HOSTILE_SHA);
  });

  it("对象键按插入序输出", () => {
    expect(marshalGoJSON({ b: 1, a: 2 })).toBe('{"b":1,"a":2}');
  });

  it("标量与空数组", () => {
    expect(marshalGoJSON(null)).toBe("null");
    expect(marshalGoJSON(true)).toBe("true");
    expect(marshalGoJSON("")).toBe('""');
    expect(marshalGoJSON([])).toBe("[]");
    expect(marshalGoJSON(0)).toBe("0");
  });

  it("非整数/非有限数字报错（本模块只用 Go int）", () => {
    expect(() => marshalGoJSON(1.5)).toThrowError(/仅支持整数/);
    expect(() => marshalGoJSON(Number.NaN)).toThrowError(/仅支持整数/);
    expect(() => marshalGoJSON(Number.POSITIVE_INFINITY)).toThrowError(/仅支持整数/);
  });
});

describe("articleRowFromDoc 的 tags_json（Go json.Marshal 等价）", () => {
  it("含 <>& 的标签被转义为 \\u003c 等，逐字对齐 Go", () => {
    const doc = parseMD("a.md", "---\nslug: a\ntitle: 甲\ntags: a<b>, c&d, e/f\n---\n\n正文");
    const row = articleRowFromDoc("article/a", doc);
    expect(doc.tags).toEqual(["a<b>", "c&d", "e/f"]);
    expect(row.tagsJson).toBe(TAGS_HTML);
    expect(sha256Hex(utf8(row.tagsJson))).toBe(TAGS_HTML_SHA);
  });

  it("含 U+2028 的标签被转义", () => {
    const doc = parseMD("b.md", "---\nslug: b\ntitle: 乙\ntags: u\u2028v\n---\n\n正文");
    const row = articleRowFromDoc("article/b", doc);
    expect(row.tagsJson).toBe(TAGS_U2028);
    expect(sha256Hex(utf8(row.tagsJson))).toBe(TAGS_U2028_SHA);
  });

  it("空标签仍为 []", () => {
    const doc = parseMD("c.md", "---\nslug: c\ntitle: 丙\n---\n\n正文");
    expect(articleRowFromDoc("article/c", doc).tagsJson).toBe(TAGS_EMPTY);
  });
});