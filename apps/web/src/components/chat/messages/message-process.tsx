import type { ReactNode } from "react";
import { Brain, Wrench } from "lucide-react";
import type { ProcessPart } from "./message-display";

export function MessageProcess({
  parts,
  renderReasoning,
  isStreaming = false,
  expandedReasoningIds,
  onReasoningToggle,
}: Readonly<{
  parts: readonly ProcessPart[];
  renderReasoning: (text: string) => ReactNode;
  isStreaming?: boolean;
  expandedReasoningIds?: ReadonlySet<string>;
  onReasoningToggle?: (id: string, open: boolean) => void;
}>) {
  // 以首个过程片段为稳定标识，后续工具/思考追加不会重建折叠栏。
  const id = parts[0]?.id;
  if (!id || !parts.some((part) => part.type !== "reasoning" || part.text.trim())) {
    return null;
  }

  return (
    <details
      className="mb-3 text-muted-foreground"
      open={isStreaming || expandedReasoningIds?.has(id) || undefined}
      onToggle={onReasoningToggle
        ? (event) => onReasoningToggle(id, event.currentTarget.open)
        : undefined}
    >
      <summary className="flex cursor-pointer list-none items-center gap-2 text-xs font-medium">
        <Brain className="size-4" aria-hidden="true" />
        思考过程
      </summary>
      <div className="mt-2 space-y-3 border-l pl-4 text-sm leading-6">
        {parts.map((part) => {
          switch (part.type) {
            case "reasoning":
              return part.text.trim()
                ? <div key={part.id}>{renderReasoning(part.text)}</div>
                : null;
            case "tool-call":
              return (
                <div className="flex w-fit items-center gap-2 rounded-xl border bg-muted/50 px-3 py-2 text-xs" key={part.id}>
                  <Wrench className="size-4" aria-hidden="true" />
                  <span>{part.toolName}</span>
                </div>
              );
            case "tool-result":
              return <p className="text-xs" key={part.id}>{part.isError ? "工具执行失败" : "工具执行完成"}</p>;
          }
        })}
      </div>
    </details>
  );
}
