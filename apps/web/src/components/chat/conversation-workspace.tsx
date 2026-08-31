"use client";

import type {
  ConversationDetailResponse,
  GenerationEventDto,
} from "@ai-chat/contracts";
import { useQueryClient } from "@tanstack/react-query";
import { ImageIcon, MessageSquareText } from "lucide-react";
import { useCallback } from "react";

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
import { VirtualMessageList } from "./messages/virtual-message-list";
import { useConversationHistory } from "./messages/use-conversation-history";
import { refreshConversationHistory } from "./messages/conversation-history-query";
import { conversationListQueryKey } from "@/lib/conversations-client";
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
  const clearProjection = useGenerationProjectionStore((state) => state.clear);
  const storedProjection = useGenerationProjectionStore(
    (state) => state.projections[conversationId] ?? null,
  );
  const history = useConversationHistory(initialDetail);
  const { detail } = history;

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
        const refreshedDetail = await refreshConversationHistory(
          queryClient,
          conversationId,
        );

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

  const { conversation } = detail;
  const ModeIcon =
    conversation.mode === "image" ? ImageIcon : MessageSquareText;
  const isGenerating = detail.activeGeneration !== null;
  const imageStatus = conversation.mode === "image"
    ? getImageGenerationStatus({
        activeGeneration: detail.activeGeneration,
        latestGeneration: detail.latestGeneration,
        projection,
        isSubmitting: createMutation.isPending,
        isStopping: cancelMutation.isPending,
      })
    : null;
  const tail = conversation.mode === "image"
    ? imageStatus && <ImageGenerationResponse status={imageStatus} />
    : projection && <GenerationResponse projection={projection} />;

  return (
    <section className="flex h-full min-h-0 flex-col">
      <header className="flex h-16 shrink-0 items-center gap-3 border-b px-8">
        <ModeIcon className="size-4 text-muted-foreground" aria-hidden="true" />
        <h1 className="truncate font-medium">{conversation.title}</h1>
      </header>

      <VirtualMessageList
        messages={history.messages}
        mode={conversation.mode}
        tail={tail}
        tailKey={`generation:${activeGenerationId ?? detail.latestGeneration?.id ?? "pending"}`}
        hasOlder={history.hasOlder}
        isLoadingOlder={history.isLoadingOlder}
        olderError={history.olderError}
        loadOlder={history.loadOlder}
      />

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
