"use client";

import type { ConversationSummaryDto } from "@ai-chat/contracts";
import { useQuery } from "@tanstack/react-query";
import {
  ChevronRight,
  Ellipsis,
  ImageIcon,
  MessageSquareText,
  Pin,
  PinOff,
  Plus,
  Share2,
  Sparkles,
  Trash2,
  Wrench,
} from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useMemo, useState } from "react";

import {
  conversationListQueryKey,
  fetchConversations,
  type ClientConversationSummary,
} from "@/lib/conversations-client";

import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

import {
  groupConversationsByRecency,
  type ConversationGroup,
} from "./conversation-groups";
import {
  useDeleteConversation,
  usePinConversation,
} from "./use-conversation-actions";
import { ShareConversationDialog } from "./share-conversation-dialog";

function ConversationItem({
  conversation,
  isActive,
  isBusy,
  onDelete,
  onPin,
  onShare,
}: Readonly<{
  conversation: ClientConversationSummary;
  isActive: boolean;
  isBusy: boolean;
  onDelete: () => void;
  onPin: () => void;
  onShare: () => void;
}>) {
  const Icon = conversation.mode === "image" ? ImageIcon : MessageSquareText;
  const className = isActive
    ? "flex min-w-0 flex-1 items-center gap-2.5 rounded-xl bg-background px-3 py-2.5 pr-10 text-sm font-medium shadow-sm ring-1 ring-border"
    : "flex min-w-0 flex-1 items-center gap-2.5 rounded-xl px-3 py-2.5 pr-10 text-sm text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring";
  const content = (
    <>
      <Icon className="size-4 shrink-0" aria-hidden="true" />
      <span className="min-w-0 flex-1 truncate">{conversation.title}</span>
      {conversation.pinnedAt ? (
        <Pin className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
      ) : null}
    </>
  );

  if (conversation.isPending) {
    return (
      <div
        aria-disabled="true"
        className={className}
        title="正在创建对话"
      >
        {content}
      </div>
    );
  }

  return (
    <div className="group relative flex min-w-0">
      <Link
        aria-current={isActive ? "page" : undefined}
        className={className}
        href={`/chat/${conversation.id}`}
        title={conversation.title}
      >
        {content}
      </Link>
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild>
          <Button
            aria-label={`打开「${conversation.title}」的更多操作`}
            className="absolute right-1 top-1/2 size-8 -translate-y-1/2 p-0 text-muted-foreground opacity-0 shadow-none hover:bg-foreground/10 group-focus-within:opacity-100 group-hover:opacity-100 data-[state=open]:bg-foreground/10 data-[state=open]:opacity-100"
            disabled={isBusy}
            variant="ghost"
          >
            <Ellipsis className="size-4" aria-hidden="true" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={onShare}>
            <Share2 />
            分享
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={onPin}>
            {conversation.pinnedAt ? <PinOff /> : <Pin />}
            {conversation.pinnedAt ? "取消置顶" : "置顶"}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={onDelete} variant="destructive">
            <Trash2 />
            删除
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

function ConversationGroupSection({
  group,
  pathname,
  busyConversationId,
  onDelete,
  onPin,
  onShare,
}: Readonly<{
  group: ConversationGroup<ClientConversationSummary>;
  pathname: string;
  busyConversationId: string | null;
  onDelete: (conversation: ClientConversationSummary) => void;
  onPin: (conversation: ClientConversationSummary) => void;
  onShare: (conversation: ClientConversationSummary) => void;
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
          return (
            <ConversationItem
              conversation={conversation}
              isActive={isActive}
              isBusy={busyConversationId === conversation.id}
              key={conversation.id}
              onDelete={() => onDelete(conversation)}
              onPin={() => onPin(conversation)}
              onShare={() => onShare(conversation)}
            />
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
  const router = useRouter();
  const [deleteTarget, setDeleteTarget] =
    useState<ClientConversationSummary | null>(null);
  const [shareTarget, setShareTarget] =
    useState<ClientConversationSummary | null>(null);
  const pinMutation = usePinConversation();
  const deleteMutation = useDeleteConversation();
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
  const busyConversationId = pinMutation.isPending
    ? pinMutation.variables.conversationId
    : deleteMutation.isPending
      ? deleteMutation.variables
      : null;

  function confirmDelete() {
    if (!deleteTarget) {
      return;
    }

    const conversationId = deleteTarget.id;
    deleteMutation.mutate(conversationId, {
      onSuccess: () => {
        setDeleteTarget(null);
        if (pathname === `/chat/${conversationId}`) {
          router.replace("/chat");
        }
      },
    });
  }

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

        <Link
          aria-current={pathname === "/tools" ? "page" : undefined}
          className={
            pathname === "/tools"
              ? "mt-2 flex h-10 items-center gap-2.5 rounded-xl bg-background px-3 text-sm font-medium shadow-sm ring-1 ring-border"
              : "mt-2 flex h-10 items-center gap-2.5 rounded-xl px-3 text-sm text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
          }
          href="/tools"
        >
          <Wrench className="size-4" aria-hidden="true" />
          MCP 工具
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

          {pinMutation.isError || deleteMutation.isError ? (
            <p className="px-3 py-2 text-sm text-destructive" role="alert">
              操作失败，请重试
            </p>
          ) : null}

          {!isError && data.conversations.length === 0 ? (
            <p className="px-3 py-2 text-sm text-muted-foreground">暂无对话</p>
          ) : null}

          {conversationGroups.map((group) => (
            <ConversationGroupSection
              group={group}
              key={group.id}
              pathname={pathname ?? ""}
              busyConversationId={busyConversationId}
              onDelete={setDeleteTarget}
              onShare={setShareTarget}
              onPin={(conversation) =>
                pinMutation.mutate({
                  conversationId: conversation.id,
                  pinned: !conversation.pinnedAt,
                })
              }
            />
          ))}
        </div>
      </section>

      <Dialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open && !deleteMutation.isPending) {
            setDeleteTarget(null);
          }
        }}
      >
        <DialogContent showCloseButton={!deleteMutation.isPending}>
          <DialogHeader>
            <DialogTitle>删除这个对话？</DialogTitle>
            <DialogDescription>
              “{deleteTarget?.title}”及其中的全部消息和附件将被永久删除。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              disabled={deleteMutation.isPending}
              onClick={() => setDeleteTarget(null)}
              variant="outline"
            >
              取消
            </Button>
            <Button
              disabled={deleteMutation.isPending}
              onClick={confirmDelete}
              variant="destructive"
            >
              {deleteMutation.isPending ? "正在删除…" : "删除"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ShareConversationDialog
        conversation={shareTarget}
        open={shareTarget !== null}
        onOpenChange={(open) => {
          if (!open) setShareTarget(null);
        }}
      />
    </div>
  );
}
