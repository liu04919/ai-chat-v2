import type { ComponentProps } from "react";
import Markdown, { type Components } from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";

import { cn } from "@/lib/utils";
import {
  getMarkdownCodePresentation,
  type MarkdownCodeNode,
} from "@/components/chat/messages/markdown-code";

function withoutMarkdownNode<T extends { node?: unknown }>(props: T): Omit<T, "node"> {
  const elementProps = { ...props };
  delete elementProps.node;
  return elementProps;
}

function withMarkdownClassName<
  T extends { className?: string; node?: unknown },
>(props: T, className: string): Omit<T, "node"> {
  return withoutMarkdownNode({
    ...props,
    className: cn(className, props.className),
  });
}

function ShareCode({
  children,
  className,
  node,
  ...props
}: ComponentProps<"code"> & {
  node?: MarkdownCodeNode & {
    position?: { start: { line: number }; end: { line: number } };
  };
}) {
  const { isBlock, language } = getMarkdownCodePresentation(
    children,
    className,
    node?.position?.start.line,
    node?.position?.end.line,
    node,
  );

  if (!isBlock) {
    return (
      <code className="rounded-md bg-muted px-1.5 py-0.5 font-mono text-[0.9em]" {...props}>
        {children}
      </code>
    );
  }

  return (
    <div className="my-3 overflow-hidden rounded-xl border border-zinc-800 bg-zinc-950 text-zinc-100">
      <div className="border-b border-zinc-800 px-3 py-2 text-xs text-zinc-400">
        {language ?? "代码"}
      </div>
      <pre className="overflow-x-auto p-4 text-[0.8125rem] leading-6">
        <code className={className} {...props}>{children}</code>
      </pre>
    </div>
  );
}

const components = {
  h1: (props) => <h1 className="mb-3 mt-5 text-xl font-semibold" {...withoutMarkdownNode(props)} />,
  h2: (props) => <h2 className="mb-2 mt-5 text-lg font-semibold" {...withoutMarkdownNode(props)} />,
  h3: (props) => <h3 className="mb-2 mt-4 font-semibold" {...withoutMarkdownNode(props)} />,
  p: (props) => <p className="my-2 whitespace-pre-wrap" {...withoutMarkdownNode(props)} />,
  ul: (props) => <ul {...withMarkdownClassName(props, "my-3 list-disc space-y-1 pl-6")} />,
  ol: (props) => <ol {...withMarkdownClassName(props, "my-3 list-decimal space-y-1 pl-6")} />,
  li: (props) => <li {...withMarkdownClassName(props, "pl-1")} />,
  input: (props) => <input className="mr-2 accent-foreground" {...withoutMarkdownNode(props)} />,
  del: (props) => <del className="text-muted-foreground" {...withoutMarkdownNode(props)} />,
  blockquote: (props) => <blockquote className="my-3 border-l-2 border-border pl-4 text-muted-foreground" {...withoutMarkdownNode(props)} />,
  a: (props) => (
    <a
      {...withoutMarkdownNode(props)}
      className="break-words font-medium text-blue-600 underline underline-offset-4 hover:text-blue-700"
      rel="noopener noreferrer"
      target="_blank"
    />
  ),
  hr: (props) => <hr className="my-5 border-border" {...withoutMarkdownNode(props)} />,
  table: (props) => (
    <div className="my-4 overflow-x-auto rounded-lg border">
      <table className="w-full border-collapse text-sm" {...withoutMarkdownNode(props)} />
    </div>
  ),
  th: (props) => <th className="border-b border-r bg-muted px-3 py-2 text-left font-medium last:border-r-0" {...withoutMarkdownNode(props)} />,
  td: (props) => <td className="border-b border-r px-3 py-2 align-top last:border-r-0" {...withoutMarkdownNode(props)} />,
  pre: ({ children }) => <>{children}</>,
  code: ShareCode,
} satisfies Components;

const remarkPlugins = [remarkGfm, remarkMath];
const rehypePlugins = [rehypeKatex, rehypeHighlight];
const disallowedElements = ["img"];

export function ShareMessageMarkdown({ text }: Readonly<{ text: string }>) {
  return (
    <div className="message-markdown min-w-0 break-words [&_.katex-display]:my-4 [&_.katex-display]:overflow-x-auto [&_.katex-display]:overflow-y-hidden [&>*:first-child]:mt-0 [&>*:last-child]:mb-0">
      <Markdown
        components={components}
        disallowedElements={disallowedElements}
        rehypePlugins={rehypePlugins}
        remarkPlugins={remarkPlugins}
        skipHtml
      >
        {text}
      </Markdown>
    </div>
  );
}
