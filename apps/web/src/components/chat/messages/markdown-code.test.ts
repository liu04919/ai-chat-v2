import { describe, expect, it } from "vitest";

import { getMarkdownCodePresentation } from "./markdown-code";

describe("getMarkdownCodePresentation", () => {
  it("识别行内代码", () => {
    expect(getMarkdownCodePresentation("pnpm check", undefined, 1, 1))
      .toEqual({ isBlock: false, language: undefined, text: "pnpm check" });
  });

  it("识别带语言和不带语言的围栏代码块", () => {
    expect(getMarkdownCodePresentation("const n = 1;\n", "language-ts", 1, 3))
      .toEqual({ isBlock: true, language: "ts", text: "const n = 1;" });
    expect(getMarkdownCodePresentation("pnpm check\n", undefined, 1, 3))
      .toEqual({ isBlock: true, language: undefined, text: "pnpm check" });
  });

  it("保留代码内部换行，只移除解析器附加的末尾换行", () => {
    expect(getMarkdownCodePresentation("a\nb\n", "language-text", 2, 5).text)
      .toBe("a\nb");
  });

  it("从语法高亮后的节点中还原可复制的原始代码", () => {
    const node = {
      type: "element",
      children: [
        { type: "element", children: [{ type: "text", value: "const" }] },
        { type: "text", value: " answer = " },
        { type: "element", children: [{ type: "text", value: "42" }] },
        { type: "text", value: ";\n" },
      ],
    };

    expect(
      getMarkdownCodePresentation("高亮后的 React 节点", "hljs language-ts", 1, 3, node),
    ).toEqual({ isBlock: true, language: "ts", text: "const answer = 42;" });
  });
});
