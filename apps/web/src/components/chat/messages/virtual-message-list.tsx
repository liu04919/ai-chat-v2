"use client";

import type { ConversationModeDto, MessageDto } from "@ai-chat/contracts";
import { elementScroll, useVirtualizer } from "@tanstack/react-virtual";
import {
  memo,
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { RotateCcw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { MessageParts } from "./message-parts";

const MessageRow = memo(function MessageRow({
  message,
  mode,
  expanded,
  onToggle,
  canRegenerate,
  onRegenerate,
}: {
  message: MessageDto;
  mode: ConversationModeDto;
  expanded: ReadonlySet<string>;
  onToggle: (id: string, open: boolean) => void;
  canRegenerate: boolean;
  onRegenerate?: (assistantMessageId: string) => void;
}) {
  return (
    <article
      data-message-id={message.id}
      className={
        message.role === "user"
          ? "ml-auto w-fit max-w-2xl rounded-3xl bg-muted px-5 py-3 text-sm shadow-sm"
          : "max-w-2xl text-sm leading-7"
      }
    >
      <MessageParts
        parts={message.parts}
        imageAttachments={mode === "image"}
        expandedReasoningIds={expanded}
        onReasoningToggle={onToggle}
      />
      {message.role === "assistant" && canRegenerate && onRegenerate ? (
        <Button
          className="mt-2 -ml-2 gap-1.5 text-muted-foreground hover:text-foreground"
          variant="ghost"
          size="sm"
          onClick={() => onRegenerate(message.id)}
        >
          <RotateCcw className="size-3.5" aria-hidden="true" />
          重新生成
        </Button>
      ) : null}
    </article>
  );
});

export function VirtualMessageList({
  messages,
  mode,
  tail,
  tailKey,
  hasOlder,
  isLoadingOlder,
  olderError,
  loadOlder,
  regeneratableAssistantMessageId,
  onRegenerate,
}: {
  messages: MessageDto[];
  mode: ConversationModeDto;
  tail: ReactNode;
  tailKey: string;
  hasOlder: boolean;
  isLoadingOlder: boolean;
  olderError: boolean;
  loadOlder: () => Promise<void>;
  regeneratableAssistantMessageId: string | null;
  onRegenerate?: (assistantMessageId: string) => void;
}) {
  "use no memo";
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const initializedRef = useRef(false);
  const previousScrollTopRef = useRef(0);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const onToggle = useCallback((id: string, open: boolean) => {
    setExpanded((current) => {
      if (current.has(id) === open) return current;
      const next = new Set(current);
      if (open) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);
  const getItemKey = useCallback(
    (index: number) => messages[index]?.id ?? tailKey,
    [messages, tailKey],
  );
  // Virtualizer 是有状态实例，保持手动调用，不交给 React Compiler 缓存。
  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({
    count: messages.length + (tail ? 1 : 0),
    getScrollElement: () => scrollRef.current,
    getItemKey,
    estimateSize: () => 160,
    overscan: 5,
    paddingStart: 64,
    paddingEnd: 32,
    gap: 24,
    anchorTo: "end",
    followOnAppend: true,
    scrollEndThreshold: 96,
    directDomUpdates: true,
    // ref 挂载时会同步测量；React 19 不允许此时由 Virtualizer 调用 flushSync。
    // DOM 位置与容器尺寸已经由 directDomUpdates 同步维护，React 更新可以异步提交。
    useFlushSync: false,
    scrollToFn: (offset, options, instance) => {
      // 先扩展滚动空间，避免图片长高时浏览器把补偿位置截断到旧的底部。
      if (contentRef.current) {
        contentRef.current.style.height = `${instance.getTotalSize()}px`;
      }
      elementScroll(offset, options, instance);
    },
  });

  useLayoutEffect(() => {
    if (!initializedRef.current) {
      initializedRef.current = true;
      virtualizer.scrollToEnd();
    }
  }, [virtualizer]);

  function maybeLoadOlder() {
    if (
      initializedRef.current &&
      hasOlder &&
      !isLoadingOlder &&
      !olderError &&
      scrollRef.current &&
      scrollRef.current.scrollTop < 160
    ) {
      void loadOlder();
    }
  }

  return (
    <div
      className="min-h-0 flex-1 overflow-y-auto px-5 [overflow-anchor:none]"
      ref={scrollRef}
      data-message-scroll
      onScroll={(event) => {
        // 底部初始定位、追加和尺寸补偿也会产生 scroll；只在向上滚动时加载。
        const scrollTop = event.currentTarget.scrollTop;
        const movedUp = scrollTop < previousScrollTopRef.current;
        previousScrollTopRef.current = scrollTop;
        if (movedUp && scrollTop < 160) {
          maybeLoadOlder();
        }
      }}
      onWheel={(event) => {
        if (event.deltaY < 0) maybeLoadOlder();
      }}
    >
      <div
        className="relative mx-auto w-full max-w-3xl"
        ref={(node) => {
          contentRef.current = node;
          virtualizer.containerRef(node);
        }}
      >
        <div className="absolute inset-x-0 top-3 flex h-9 justify-center">
          {hasOlder ? (
            <Button
              variant="ghost"
              size="sm"
              disabled={isLoadingOlder}
              onClick={() => void loadOlder()}
            >
              {isLoadingOlder
                ? "正在加载…"
                : olderError
                  ? "加载失败，点击重试"
                  : "加载更早的消息"}
            </Button>
          ) : null}
        </div>
        {virtualizer.getVirtualItems().map((item) => (
          <div
            key={item.key}
            ref={virtualizer.measureElement}
            data-index={item.index}
            className="absolute left-0 top-0 w-full"
          >
            {messages[item.index] ? (
              <MessageRow
                message={messages[item.index]!}
                mode={mode}
                expanded={expanded}
                onToggle={onToggle}
                canRegenerate={
                  messages[item.index]!.id ===
                  regeneratableAssistantMessageId
                }
                onRegenerate={onRegenerate}
              />
            ) : (
              tail
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
