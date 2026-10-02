import { describe, expect, it } from "vitest";

import { cleanDisplayName, normalizeTermKey } from "../directory";
import { deriveDirectorySeedTerms } from "./directory";

describe("cleanDisplayName", () => {
  it("TrimSpace + 空白折叠 + 剥离控制字符，但**不**折全角与大小写", () => {
    expect(cleanDisplayName("  A\u0001  b  Ｃ  ")).toBe("A b Ｃ");
  });

  it("空串与纯空白得到空串", () => {
    expect(cleanDisplayName("   ")).toBe("");
  });
});

describe("deriveDirectorySeedTerms", () => {
  it("三源齐全：attr.category / attr.instructor / 容器 slug / 标签段各出词条", () => {
    const out = deriveDirectorySeedTerms({
      attrs: [
        { kind: "attr.category", text: "手工" },
        { kind: "attr.instructor", text: "张三" },
        { kind: "attr.other", text: "忽略我" },
      ],
      categoryItemIds: ["category/工具"],
      tagItemIds: ["tag/x", "tag/x/more"],
    });
    expect(out).toEqual([
      { kind: "category", termKey: "工具", displayName: "工具" },
      { kind: "category", termKey: "手工", displayName: "手工" },
      { kind: "instructor", termKey: "张三", displayName: "张三" },
      { kind: "tag", termKey: "x", displayName: "x" },
    ]);
  });

  it("同 (kind, term_key) 去重且**先到先得**：display 取首个来源的原文", () => {
    const out = deriveDirectorySeedTerms({
      attrs: [{ kind: "attr.category", text: "  DIT  " }],
      categoryItemIds: ["category/dit"],
      tagItemIds: ["tag/Dit"],
    });
    expect(out).toEqual([
      { kind: "category", termKey: "dit", displayName: "DIT" },
      { kind: "tag", termKey: "dit", displayName: "Dit" },
    ]);
  });

  it("归一化非法（空 / 超 64 rune）与展示名清洗后为空的名称被丢弃", () => {
    expect(
      deriveDirectorySeedTerms({
        attrs: [
          { kind: "attr.category", text: "   " },
          { kind: "attr.instructor", text: "a".repeat(65) },
        ],
        categoryItemIds: ["category/", "category/ok"],
        tagItemIds: ["tag/", "tag"],
      }),
    ).toEqual([{ kind: "category", termKey: "ok", displayName: "ok" }]);
  });

  it("全角折半角 + ASCII 小写折叠后同名归并", () => {
    expect(normalizeTermKey("ＡＢＣ")).toBe("abc");
    const out = deriveDirectorySeedTerms({
      attrs: [{ kind: "attr.category", text: "ＡＢＣ" }],
      categoryItemIds: ["category/abc"],
      tagItemIds: [],
    });
    expect(out).toEqual([{ kind: "category", termKey: "abc", displayName: "ＡＢＣ" }]);
  });

  it("排序按 UTF-8 字节序（非 JS UTF-16 码元序）：U+E000 排在 U+1F600 之前", () => {
    const out = deriveDirectorySeedTerms({
      attrs: [],
      categoryItemIds: ["category/\uD83D\uDE00", "category/\uE000"],
      tagItemIds: [],
    });
    // Go 字节序：EE 80 80 < F0 9F 98 80；JS `<` 会因代理对 D83D < E000 给出相反顺序。
    expect(out.map((t) => t.termKey)).toEqual(["\uE000", "\uD83D\uDE00"]);
  });

  it("空输入返回空数组", () => {
    expect(deriveDirectorySeedTerms({ attrs: [], categoryItemIds: [], tagItemIds: [] })).toEqual([]);
  });
});