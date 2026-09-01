export type MarkdownCodePresentation = {
  isBlock: boolean;
  language?: string;
  text: string;
};

export type MarkdownCodeNode = {
  type?: string;
  value?: string;
  children?: readonly MarkdownCodeNode[];
};

function readMarkdownNodeText(node: MarkdownCodeNode): string | undefined {
  if (node.type === "text" && typeof node.value === "string") {
    return node.value;
  }
  if (node.children) {
    return node.children
      .map((child) => readMarkdownNodeText(child) ?? "")
      .join("");
  }
  return undefined;
}

export function getMarkdownCodePresentation(
  children: unknown,
  className: string | undefined,
  startLine: number | undefined,
  endLine: number | undefined,
  node?: MarkdownCodeNode,
): MarkdownCodePresentation {
  const text = (node ? readMarkdownNodeText(node) : undefined)
    ?.replace(/\n$/, "") ?? String(children).replace(/\n$/, "");
  const language = /(?:^|\s)language-([^\s]+)/.exec(className ?? "")?.[1];
  return {
    isBlock: text.includes("\n") || startLine !== endLine,
    language,
    text,
  };
}
