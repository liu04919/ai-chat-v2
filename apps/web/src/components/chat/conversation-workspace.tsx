"use client";

import type {
  ConversationDetailResponse,
  GenerationEventDto,
  MessageDto,
} from "@ai-chat/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ImageIcon, MessageSquareText } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import {
  ChatComposer,
  type ChatComposerSubmission,
} from "./composer/chat-composer";
import { GenerationResponse } from "./generation/generation-response";
import { useGenerationEventStream } from "./generation/use-generation-event-stream";
import { useGenerationProjectionStore } from "./generation/generation-projection-store";
import { MessageParts } from "./messages/message-parts";
import {
  conversationDetailQueryKey,
  conversationListQueryKey,
  fetchConversation,
} from "@/lib/conversations-client";
import {
  createGeneration,
  getGenerationClientErrorMessage,
} from "@/lib/generations-client";

type TerminalGenerationEvent = Extract<
  GenerationEventDto,
  { type: "generation.completed" | "generation.failed" }
>;

function nextMessageSequence(messages: readonly MessageDto[]): number {
  return messages.reduce(
    (largest, message) => Math.max(largest, message.sequence),
    -1,
  ) + 1;
}

export function ConversationWorkspace({
  initialDetail,
}: Readonly<{ initialDetail: ConversationDetailResponse }>) {
  const conversationId = initialDetail.conversation.id;
  const queryClient = useQueryClient();
  const [submitError, setSubmitError] = useState<string | null>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const shouldStickToBottomRef = useRef(true);
  const clearProjection = useGenerationProjectionStore(
    (state) => state.clear,
  );
  const storedProjection = useGenerationProjectionStore(
    (state) => state.projections[conversationId] ?? null,
  );
  const { data: detail } = useQuery({
    queryKey: conversationDetailQueryKey(conversationId),
    queryFn: () => fetchConversation(conversationId),
    initialData: initialDetail,
    staleTime: 30_000,
  });

  const activeGenerationId =
    detail.conversation.mode === "chat"
      ? (detail.activeGeneration?.id ?? null)
      : null;
  const projection =
    storedProjection &&
    (detail.activeGeneration?.id === storedProjection.generationId ||
      storedProjection.status === "failed" ||
      storedProjection.status === "connection-error")
      ? storedProjection
      : null;

  const handleTerminal = useCallback(
    async (event: TerminalGenerationEvent) => {
      try {
        const refreshedDetail = await queryClient.fetchQuery({
          queryKey: conversationDetailQueryKey(conversationId),
          queryFn: () => fetchConversation(conversationId),
          staleTime: 0,
        });

        if (
          event.type === "generation.completed" &&
          refreshedDetail.activeGeneration === null
        ) {
          clearProjection(conversationId);
        }

        void queryClient.invalidateQueries({
          queryKey: conversationListQueryKey,
        });
      } catch {
        // 保留当前投影；用户刷新后仍以 PostgreSQL 中的详情为准。
      }
    },
    [clearProjection, conversationId, queryClient],
  );

  useGenerationEventStream({
    conversationId,
    generationId: activeGenerationId,
    onTerminal: handleTerminal,
  });

  const submitMessage = useCallback(
    async ({ parts, reasoningEffort }: ChatComposerSubmission) => {
      const queryKey = conversationDetailQueryKey(conversationId);
      const userMessageId = crypto.randomUUID();

      setSubmitError(null);
      clearProjection(conversationId);
      await queryClient.cancelQueries({ queryKey });

      const previousDetail =
        queryClient.getQueryData<ConversationDetailResponse>(queryKey);

      if (!previousDetail) {
        const error = new Error("对话详情尚未加载完成");
        setSubmitError("对话详情尚未加载完成，请稍后重试");
        throw error;
      }

      const optimisticMessage: MessageDto = {
        id: userMessageId,
        role: "user",
        sequence: nextMessageSequence(previousDetail.messages),
        parts,
        createdAt: new Date().toISOString(),
      };

      queryClient.setQueryData<ConversationDetailResponse>(queryKey, {
        ...previousDetail,
        messages: [...previousDetail.messages, optimisticMessage],
      });

      try {
        const response = await createGeneration({
          target: { type: "existing", conversationId },
          userMessageId,
          parts,
          reasoningEffort,
        });

        if (response.conversationId !== conversationId) {
          throw new Error("服务端返回了不一致的 Conversation ID");
        }

        queryClient.setQueryData<ConversationDetailResponse>(
          queryKey,
          (current) => {
            if (!current) {
              return current;
            }

            const status = response.generation.status;
            const activeGeneration =
              status === "queued" || status === "running"
                ? { id: response.generation.id, status }
                : null;

            return { ...current, activeGeneration };
          },
        );

        void queryClient.invalidateQueries({ queryKey });
        void queryClient.invalidateQueries({
          queryKey: conversationListQueryKey,
        });
      } catch (error) {
        queryClient.setQueryData(queryKey, previousDetail);
        setSubmitError(getGenerationClientErrorMessage(error));
        throw error;
      }
    },
    [clearProjection, conversationId, queryClient],
  );

  const handleScroll = useCallback(() => {
    const container = scrollContainerRef.current;

    if (!container) {
      return;
    }

    const distanceFromBottom =
      container.scrollHeight - container.scrollTop - container.clientHeight;
    shouldStickToBottomRef.current = distanceFromBottom < 96;
  }, []);

  useEffect(() => {
    const container = scrollContainerRef.current;

    if (container && shouldStickToBottomRef.current) {
      container.scrollTop = container.scrollHeight;
    }
  }, [detail.messages.length, projection]);

  const { conversation } = detail;
  const ModeIcon =
    conversation.mode === "image" ? ImageIcon : MessageSquareText;
  const isGenerating = detail.activeGeneration !== null;

  return (
    <section className="flex h-full min-h-0 flex-col">
      <header className="flex h-16 shrink-0 items-center gap-3 border-b px-8">
        <ModeIcon className="size-4 text-muted-foreground" aria-hidden="true" />
        <h1 className="truncate font-medium">{conversation.title}</h1>
      </header>

      <div
        className="min-h-0 flex-1 overflow-y-auto px-5"
        ref={scrollContainerRef}
        onScroll={handleScroll}
      >
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 py-8">
          {detail.messages.map((message) => (
            <article
              className={
                message.role === "user"
                  ? "ml-auto max-w-2xl rounded-3xl bg-muted px-5 py-3 text-sm shadow-sm"
                  : "max-w-2xl text-sm leading-7"
              }
              key={message.id}
            >
              <MessageParts parts={message.parts} />
            </article>
          ))}

          <GenerationResponse projection={projection} />
        </div>
      </div>

      <div className="mx-auto w-full max-w-3xl shrink-0 px-5 pb-6">
        <ChatComposer
          disabled={isGenerating}
          mode={conversation.mode}
          onSubmit={conversation.mode === "chat" ? submitMessage : undefined}
          submitError={submitError}
        />
      </div>
    </section>
  );
}
