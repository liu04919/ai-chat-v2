"use client";

import type {
  ConversationModeDto,
  UserMessagePartsDto,
} from "@ai-chat/contracts";
import { useQueryClient } from "@tanstack/react-query";
import { ImageIcon, MessageSquareText } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useState, useTransition } from "react";

import {
  ChatComposer,
  type ChatComposerSubmission,
} from "./composer/chat-composer";
import { MessageParts } from "./messages/message-parts";
import { createConversationTitle } from "@/lib/conversation-title";
import {
  conversationListQueryKey,
  confirmConversation,
  prependConversation,
  removeConversation,
  type ClientConversationListResponse,
} from "@/lib/conversations-client";
import {
  createGeneration,
  getGenerationClientErrorMessage,
} from "@/lib/generations-client";

const modes: ReadonlyArray<{
  value: ConversationModeDto;
  label: string;
  icon: typeof MessageSquareText;
}> = [
  { value: "chat", label: "对话", icon: MessageSquareText },
  { value: "image", label: "图片", icon: ImageIcon },
];

type PendingConversation = {
  id: string;
  mode: ConversationModeDto;
  title: string;
  parts: UserMessagePartsDto;
};

function OptimisticUserMessage({
  parts,
}: Readonly<{ parts: UserMessagePartsDto }>) {
  return (
    <div className="ml-auto max-w-2xl rounded-3xl bg-muted px-5 py-3 text-sm shadow-sm">
      <MessageParts parts={parts} />
    </div>
  );
}

export function DraftWorkspace() {
  const [mode, setMode] = useState<ConversationModeDto>("chat");
  const [hasAttachments, setHasAttachments] = useState(false);
  const [pendingConversation, setPendingConversation] =
    useState<PendingConversation | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [, startNavigation] = useTransition();
  const queryClient = useQueryClient();
  const router = useRouter();

  const submitDraft = useCallback(
    async ({ parts, reasoningEffort }: ChatComposerSubmission) => {
      const conversationId = crypto.randomUUID();
      const userMessageId = crypto.randomUUID();
      const now = new Date().toISOString();
      const title = createConversationTitle(parts);
      const optimisticConversation = {
        id: conversationId,
        mode,
        title,
        createdAt: now,
        updatedAt: now,
        isPending: true,
      };

      setSubmitError(null);
      setPendingConversation({ id: conversationId, mode, title, parts });
      queryClient.setQueryData<ClientConversationListResponse>(
        conversationListQueryKey,
        (current) => prependConversation(current, optimisticConversation),
      );

      try {
        const response = await createGeneration({
          target: { type: "new", conversationId, mode },
          userMessageId,
          parts,
          reasoningEffort,
        });

        if (response.conversationId !== conversationId) {
          throw new Error("服务端返回了不一致的 Conversation ID");
        }

        queryClient.setQueryData<ClientConversationListResponse>(
          conversationListQueryKey,
          (current) => confirmConversation(current, conversationId),
        );

        void queryClient.invalidateQueries({
          queryKey: conversationListQueryKey,
        });
        startNavigation(() => {
          router.replace(`/chat/${conversationId}`);
        });
      } catch (error) {
        queryClient.setQueryData<ClientConversationListResponse>(
          conversationListQueryKey,
          (current) => removeConversation(current, conversationId),
        );
        setPendingConversation(null);
        setSubmitError(getGenerationClientErrorMessage(error));
        throw error;
      }
    },
    [mode, queryClient, router, startNavigation],
  );

  const pendingModeIcon =
    pendingConversation?.mode === "image" ? ImageIcon : MessageSquareText;
  const PendingModeIcon = pendingModeIcon;

  return (
    <section className="relative flex h-full min-h-0 flex-col overflow-hidden">
      <div
        className={
          pendingConversation
            ? "pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_center,oklch(0.94_0.025_250),transparent_48%)] opacity-0 transition-opacity duration-200"
            : "pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_center,oklch(0.94_0.025_250),transparent_48%)] opacity-70 transition-opacity duration-200"
        }
        aria-hidden="true"
      />

      <header
        className={
          pendingConversation
            ? "relative z-10 flex h-16 shrink-0 items-center gap-3 border-b px-8 opacity-100 transition-all duration-200"
            : "relative z-10 flex h-0 shrink-0 items-center gap-3 overflow-hidden border-b border-transparent px-8 opacity-0 transition-all duration-200"
        }
      >
        <PendingModeIcon
          className="size-4 text-muted-foreground"
          aria-hidden="true"
        />
        <h1 className="truncate font-medium">{pendingConversation?.title}</h1>
      </header>

      <div
        className={
          pendingConversation
            ? "relative z-10 flex min-h-0 flex-1 flex-col px-5"
            : "relative z-10 flex min-h-0 flex-1 items-center justify-center px-5 py-10"
        }
      >
        <div
          className={
            pendingConversation
              ? "flex min-h-0 w-full flex-1 flex-col"
              : "flex w-full max-w-3xl flex-col items-center"
          }
        >
          {pendingConversation ? (
            <div className="mx-auto flex min-h-0 w-full max-w-3xl flex-1 flex-col overflow-y-auto py-8">
              <OptimisticUserMessage parts={pendingConversation.parts} />
              <p className="mt-6 text-sm text-muted-foreground">
                正在准备回复…
              </p>
            </div>
          ) : (
            <div className="flex flex-col items-center">
              <div className="grid text-center">
                <h1
                  aria-hidden={mode !== "chat"}
                  className={
                    mode === "chat"
                      ? "col-start-1 row-start-1 text-4xl font-semibold tracking-tight opacity-100 transition-all duration-300 ease-out motion-reduce:transition-none"
                      : "col-start-1 row-start-1 -translate-y-1 text-4xl font-semibold tracking-tight opacity-0 transition-all duration-300 ease-out motion-reduce:transition-none"
                  }
                >
                  今天想聊些什么？
                </h1>
                <h1
                  aria-hidden={mode !== "image"}
                  className={
                    mode === "image"
                      ? "col-start-1 row-start-1 text-4xl font-semibold tracking-tight opacity-100 transition-all duration-300 ease-out motion-reduce:transition-none"
                      : "col-start-1 row-start-1 translate-y-1 text-4xl font-semibold tracking-tight opacity-0 transition-all duration-300 ease-out motion-reduce:transition-none"
                  }
                >
                  想把什么变成画面？
                </h1>
              </div>

              <div
                aria-label="对话模式"
                className="relative mt-7 grid grid-cols-2 rounded-full border bg-background/85 p-1 shadow-sm backdrop-blur"
                role="group"
              >
                <span
                  className={
                    mode === "chat"
                      ? "pointer-events-none absolute inset-y-1 left-1 w-[calc(50%-0.25rem)] rounded-full bg-primary shadow-sm transition-transform duration-300 ease-out motion-reduce:transition-none"
                      : "pointer-events-none absolute inset-y-1 left-1 w-[calc(50%-0.25rem)] translate-x-full rounded-full bg-primary shadow-sm transition-transform duration-300 ease-out motion-reduce:transition-none"
                  }
                  aria-hidden="true"
                />
                {modes.map((item) => {
                  const Icon = item.icon;
                  const isSelected = item.value === mode;

                  return (
                    <button
                      aria-pressed={isSelected}
                      className={
                        isSelected
                          ? "relative z-10 flex h-10 min-w-28 items-center justify-center gap-2 rounded-full px-5 text-sm font-medium text-primary-foreground transition-colors duration-200"
                          : "relative z-10 flex h-10 min-w-28 items-center justify-center gap-2 rounded-full px-5 text-sm font-medium text-muted-foreground transition-colors duration-200 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:text-muted-foreground"
                      }
                      disabled={hasAttachments && !isSelected}
                      key={item.value}
                      title={
                        hasAttachments && !isSelected
                          ? "请先移除已添加的附件"
                          : undefined
                      }
                      type="button"
                      onClick={() => setMode(item.value)}
                    >
                      <Icon className="size-4" aria-hidden="true" />
                      {item.label}
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          <div
            className={
              pendingConversation
                ? "mx-auto w-full max-w-3xl shrink-0 pb-6"
                : "mt-8 w-full"
            }
          >
            <ChatComposer
              mode={mode}
              onAttachmentPresenceChange={setHasAttachments}
              onSubmit={submitDraft}
              submitError={submitError}
            />
          </div>
        </div>
      </div>
    </section>
  );
}
