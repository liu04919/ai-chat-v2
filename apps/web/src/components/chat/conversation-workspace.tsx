"use client";

import type {
  ConversationDetailResponse,
  GenerationEventDto,
} from "@ai-chat/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ImageIcon, MessageSquareText } from "lucide-react";
import { useCallback, useEffect, useRef } from "react";

import {
  ChatComposer,
  type ChatComposerSubmission,
} from "./composer/chat-composer";
import { GenerationResponse } from "./generation/generation-response";
import { ImageGenerationResponse } from "./generation/image-generation-response";
import { getImageGenerationStatus } from "./generation/image-generation-status";
import { useGenerationEventStream } from "./generation/use-generation-event-stream";
import { useGenerationProjectionStore } from "./generation/generation-projection-store";
import { useCreateGeneration } from "./generation/use-create-generation";
import { useCancelGeneration } from "./generation/use-cancel-generation";
import { MessageParts } from "./messages/message-parts";
import {
  conversationDetailQueryKey,
  conversationListQueryKey,
  fetchConversation,
} from "@/lib/conversations-client";
import {
  getGenerationCancellationClientErrorMessage,
  getGenerationClientErrorMessage,
} from "@/lib/generations-client";

type TerminalGenerationEvent = Extract<
  GenerationEventDto,
  {
    type: "generation.completed" | "generation.failed" | "generation.cancelled";
  }
>;

export function ConversationWorkspace({
  initialDetail,
}: Readonly<{ initialDetail: ConversationDetailResponse }>) {
  const conversationId = initialDetail.conversation.id;
  const queryClient = useQueryClient();
  const createMutation = useCreateGeneration();
  const cancelMutation = useCancelGeneration();
  const submitError = createMutation.error
    ? getGenerationClientErrorMessage(createMutation.error)
    : cancelMutation.error
      ? getGenerationCancellationClientErrorMessage(cancelMutation.error)
      : null;
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const shouldStickToBottomRef = useRef(true);
  const clearProjection = useGenerationProjectionStore((state) => state.clear);
  const storedProjection = useGenerationProjectionStore(
    (state) => state.projections[conversationId] ?? null,
  );
  const { data: detail } = useQuery({
    queryKey: conversationDetailQueryKey(conversationId),
    queryFn: () => fetchConversation(conversationId),
    initialData: initialDetail,
    staleTime: 30_000,
  });

  const activeGenerationId = detail.activeGeneration?.id ?? null;
  const projection =
    storedProjection &&
    (activeGenerationId
      ? activeGenerationId === storedProjection.generationId
      : detail.latestGeneration?.id === storedProjection.generationId &&
        (storedProjection.status === "failed" ||
          storedProjection.status === "cancelled" ||
          storedProjection.status === "connection-error"))
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
          (event.type === "generation.completed" ||
            (event.type === "generation.cancelled" &&
              detail.conversation.mode === "chat")) &&
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
    [clearProjection, conversationId, queryClient, detail.conversation.mode],
  );

  useGenerationEventStream({
    conversationId,
    generationId: activeGenerationId,
    onTerminal: handleTerminal,
  });

  async function submitMessage({
    parts,
    reasoningEffort,
  }: ChatComposerSubmission) {
    cancelMutation.reset();
    await createMutation.mutateAsync({
      target: { type: "existing", conversationId },
      userMessageId: crypto.randomUUID(),
      parts,
      reasoningEffort,
    });
  }

  async function stopGeneration() {
    if (!activeGenerationId) {
      return;
    }

    createMutation.reset();
    await cancelMutation.mutateAsync({
      conversationId,
      generationId: activeGenerationId,
    });
  }

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
  }, [detail.messages.length, projection, createMutation.isPending]);

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
              <MessageParts
                parts={message.parts}
                imageAttachments={conversation.mode === "image"}
              />
            </article>
          ))}

          {conversation.mode === "image" ? (
            <ImageGenerationResponse
              status={getImageGenerationStatus({
                activeGeneration: detail.activeGeneration,
                latestGeneration: detail.latestGeneration,
                projection,
                isSubmitting: createMutation.isPending,
                isStopping: cancelMutation.isPending,
              })}
            />
          ) : (
            <GenerationResponse projection={projection} />
          )}
        </div>
      </div>

      <div className="mx-auto w-full max-w-3xl shrink-0 px-5 pb-6">
        <ChatComposer
          disabled={isGenerating}
          isSubmitting={createMutation.isPending}
          isStopping={cancelMutation.isPending}
          mode={conversation.mode}
          onStopGeneration={activeGenerationId ? stopGeneration : undefined}
          onSubmit={submitMessage}
          stopRequested={Boolean(detail.activeGeneration?.cancelRequestedAt)}
          submitError={submitError}
        />
      </div>
    </section>
  );
}
