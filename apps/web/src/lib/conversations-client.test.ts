import { describe, expect, it } from "vitest";

import {
  confirmConversation,
  prependConversation,
  removeConversation,
} from "./conversations-client";

const optimisticConversation = {
  id: "conversation_new",
  mode: "chat" as const,
  title: "新的对话",
  createdAt: "2026-08-28T00:00:00.000Z",
  updatedAt: "2026-08-28T00:00:00.000Z",
  isPending: true,
};

describe("prependConversation", () => {
  it("把乐观 Conversation 放到列表首位", () => {
    expect(
      prependConversation(
        {
          conversations: [
            {
              ...optimisticConversation,
              id: "conversation_old",
              title: "旧对话",
            },
          ],
        },
        optimisticConversation,
      ).conversations.map((conversation) => conversation.id),
    ).toEqual(["conversation_new", "conversation_old"]);
  });

  it("重试时替换同 ID 项而不是重复插入", () => {
    expect(
      prependConversation(
        {
          conversations: [
            { ...optimisticConversation, title: "旧标题" },
          ],
        },
        optimisticConversation,
      ).conversations,
    ).toEqual([optimisticConversation]);
  });

  it("失败回滚只移除当前乐观 Conversation", () => {
    expect(
      removeConversation(
        {
          conversations: [
            optimisticConversation,
            {
              ...optimisticConversation,
              id: "conversation_other",
              title: "其他对话",
            },
          ],
        },
        optimisticConversation.id,
      ).conversations.map((conversation) => conversation.id),
    ).toEqual(["conversation_other"]);
  });

  it("服务端确认后解除乐观项的不可点击状态", () => {
    expect(
      confirmConversation(
        { conversations: [optimisticConversation] },
        optimisticConversation.id,
      ).conversations,
    ).toEqual([{ ...optimisticConversation, isPending: false }]);
  });
});
