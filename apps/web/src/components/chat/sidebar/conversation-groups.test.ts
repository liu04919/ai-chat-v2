import type { ConversationSummaryDto } from "@ai-chat/contracts";
import { describe, expect, it } from "vitest";

import { groupConversationsByRecency } from "./conversation-groups";

function conversation(
  id: string,
  updatedAt: Date,
): ConversationSummaryDto {
  return {
    id,
    mode: "chat",
    title: id,
    createdAt: updatedAt.toISOString(),
    updatedAt: updatedAt.toISOString(),
  };
}

describe("Conversation date groups", () => {
  it("按本地自然日分为今天、昨天和更久", () => {
    const now = new Date(2026, 7, 26, 12);
    const groups = groupConversationsByRecency(
      [
        conversation("today", new Date(2026, 7, 26, 1)),
        conversation("yesterday", new Date(2026, 7, 25, 23)),
        conversation("older", new Date(2026, 7, 24, 23)),
      ],
      now,
    );

    expect(groups.map((group) => group.label)).toEqual([
      "今天",
      "昨天",
      "更久",
    ]);
    expect(groups.map((group) => group.conversations[0]?.id)).toEqual([
      "today",
      "yesterday",
      "older",
    ]);
  });

  it("不返回没有 Conversation 的日期分组", () => {
    const now = new Date(2026, 7, 26, 12);
    const groups = groupConversationsByRecency(
      [conversation("older", new Date(2026, 7, 1, 12))],
      now,
    );

    expect(groups.map((group) => group.label)).toEqual(["更久"]);
  });
});
