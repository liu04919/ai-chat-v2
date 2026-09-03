import type { ConversationSummaryDto } from "@ai-chat/contracts";

export type ConversationGroup<
  TConversation extends ConversationSummaryDto = ConversationSummaryDto,
> = {
  id: "pinned" | "today" | "yesterday" | "older";
  label: "置顶" | "今天" | "昨天" | "更久";
  conversations: TConversation[];
};

export function groupConversationsByRecency<
  TConversation extends ConversationSummaryDto,
>(
  conversations: TConversation[],
  now = new Date(),
): ConversationGroup<TConversation>[] {
  const todayStart = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
  ).getTime();
  const yesterdayStart = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate() - 1,
  ).getTime();
  const groups: ConversationGroup<TConversation>[] = [
    { id: "pinned", label: "置顶", conversations: [] },
    { id: "today", label: "今天", conversations: [] },
    { id: "yesterday", label: "昨天", conversations: [] },
    { id: "older", label: "更久", conversations: [] },
  ];

  for (const conversation of conversations) {
    if (conversation.pinnedAt) {
      groups[0].conversations.push(conversation);
      continue;
    }

    const updatedAt = new Date(conversation.updatedAt).getTime();

    if (updatedAt >= todayStart) {
      groups[1].conversations.push(conversation);
    } else if (updatedAt >= yesterdayStart) {
      groups[2].conversations.push(conversation);
    } else {
      groups[3].conversations.push(conversation);
    }
  }

  return groups.filter((group) => group.conversations.length > 0);
}
