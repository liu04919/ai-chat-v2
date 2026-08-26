import type { ConversationSummaryDto } from "@ai-chat/contracts";

export type ConversationGroup = {
  id: "today" | "yesterday" | "older";
  label: "今天" | "昨天" | "更久";
  conversations: ConversationSummaryDto[];
};

export function groupConversationsByRecency(
  conversations: ConversationSummaryDto[],
  now = new Date(),
): ConversationGroup[] {
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
  const groups: ConversationGroup[] = [
    { id: "today", label: "今天", conversations: [] },
    { id: "yesterday", label: "昨天", conversations: [] },
    { id: "older", label: "更久", conversations: [] },
  ];

  for (const conversation of conversations) {
    const updatedAt = new Date(conversation.updatedAt).getTime();

    if (updatedAt >= todayStart) {
      groups[0].conversations.push(conversation);
    } else if (updatedAt >= yesterdayStart) {
      groups[1].conversations.push(conversation);
    } else {
      groups[2].conversations.push(conversation);
    }
  }

  return groups.filter((group) => group.conversations.length > 0);
}
