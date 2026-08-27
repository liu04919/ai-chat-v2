"use client";

import {
  conversationListResponseSchema,
  type ConversationSummaryDto,
} from "@ai-chat/contracts";
import { useQuery } from "@tanstack/react-query";
import {
  ChevronRight,
  ImageIcon,
  MessageSquareText,
  Plus,
  Sparkles,
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useMemo } from "react";

import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";

import {
  groupConversationsByRecency,
  type ConversationGroup,
} from "./conversation-groups";

const conversationListQueryKey = ["conversations"] as const;

async function fetchConversations() {
  const response = await fetch("/api/conversations");

  if (!response.ok) {
    throw new Error("无法加载对话");
  }

  return conversationListResponseSchema.parse(await response.json());
}

function ConversationGroupSection({
  group,
  pathname,
}: Readonly<{
  group: ConversationGroup;
  pathname: string;
}>) {
  return (
    <Collapsible defaultOpen>
      <CollapsibleTrigger className="group flex h-9 w-full items-center justify-between rounded-lg px-2 text-xs font-semibold text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
        {group.label}
        <ChevronRight
          className="size-3.5 transition-transform group-data-[state=open]:rotate-90"
          aria-hidden="true"
        />
      </CollapsibleTrigger>
      <CollapsibleContent className="space-y-1 pt-1">
        {group.conversations.map((conversation) => {
          const isActive = pathname === `/chat/${conversation.id}`;
          const Icon =
            conversation.mode === "image" ? ImageIcon : MessageSquareText;

          return (
            <Link
              aria-current={isActive ? "page" : undefined}
              className={
                isActive
                  ? "flex min-w-0 items-center gap-2.5 rounded-xl bg-background px-3 py-2.5 text-sm font-medium shadow-sm ring-1 ring-border"
                  : "flex min-w-0 items-center gap-2.5 rounded-xl px-3 py-2.5 text-sm text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
              }
              href={`/chat/${conversation.id}`}
              key={conversation.id}
              title={conversation.title}
            >
              <Icon className="size-4 shrink-0" aria-hidden="true" />
              <span className="truncate">{conversation.title}</span>
            </Link>
          );
        })}
      </CollapsibleContent>
    </Collapsible>
  );
}

export function ConversationSidebar({
  initialConversations,
}: Readonly<{ initialConversations: ConversationSummaryDto[] }>) {
  const pathname = usePathname();
  const { data, isError } = useQuery({
    queryKey: conversationListQueryKey,
    queryFn: fetchConversations,
    initialData: { conversations: initialConversations },
    staleTime: 30_000,
  });
  const conversationGroups = useMemo(
    () => groupConversationsByRecency(data.conversations),
    [data.conversations],
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="px-4 pb-3 pt-5">
        <Link
          className="flex w-fit items-center gap-2.5 rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-ring"
          href="/chat"
        >
          <span className="flex size-9 items-center justify-center rounded-xl bg-primary text-primary-foreground shadow-sm">
            <Sparkles className="size-4" aria-hidden="true" />
          </span>
          <span className="font-semibold tracking-tight">AI Chat</span>
        </Link>
      </header>

      <div className="px-3">
        <Link
          aria-current={pathname === "/chat" ? "page" : undefined}
          className="flex h-10 items-center gap-2.5 rounded-xl bg-primary px-3 text-sm font-medium text-primary-foreground shadow-sm outline-none transition-colors hover:bg-primary/90 focus-visible:ring-2 focus-visible:ring-ring"
          href="/chat"
        >
          <Plus className="size-4" aria-hidden="true" />
          新对话
        </Link>
      </div>

      <section
        aria-label="对话记录"
        className="mt-5 flex min-h-0 flex-1 flex-col"
      >
        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-2 pb-4">
          {isError && data.conversations.length === 0 ? (
            <p className="px-3 py-2 text-sm text-red-600" role="alert">
              对话加载失败，请刷新重试
            </p>
          ) : null}

          {!isError && data.conversations.length === 0 ? (
            <p className="px-3 py-2 text-sm text-muted-foreground">暂无对话</p>
          ) : null}

          {conversationGroups.map((group) => (
            <ConversationGroupSection
              group={group}
              key={group.id}
              pathname={pathname}
            />
          ))}
        </div>
      </section>
    </div>
  );
}
