import { describe, expect, it } from "vitest";

import {
  confirmConversation,
  prependConversation,
  removeConversation,
  replaceConversation,
  updateConversationPinned,
} from "./conversations-client";

const optimisticConversation = {
  id: "conversation_new",
  mode: "chat" as const,
  title: "新的对话",
  pinnedAt: null,
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

  it("乐观置顶后移到置顶列表前方，取消后按活跃时间归位", () => {
    const newer = {
      ...optimisticConversation,
      id: "conversation_newer",
      updatedAt: "2026-08-29T00:00:00.000Z",
      isPending: false,
    };
    const current = {
      conversations: [newer, { ...optimisticConversation, isPending: false }],
    };
    const pinned = updateConversationPinned(
      current,
      optimisticConversation.id,
      "2026-08-30T00:00:00.000Z",
    );
    expect(pinned.conversations.map((conversation) => conversation.id)).toEqual([
      optimisticConversation.id,
      newer.id,
    ]);

    const unpinned = updateConversationPinned(
      pinned,
      optimisticConversation.id,
      null,
    );
    expect(unpinned.conversations.map((conversation) => conversation.id)).toEqual([
      newer.id,
      optimisticConversation.id,
    ]);
  });

  it("用服务端置顶时间替换乐观时间", () => {
    const confirmed = {
      ...optimisticConversation,
      pinnedAt: "2026-09-03T10:00:00.000Z",
      isPending: false,
    };
    expect(
      replaceConversation(
        {
          conversations: [
            {
              ...optimisticConversation,
              pinnedAt: "2026-09-03T09:59:59.000Z",
              isPending: false,
            },
          ],
        },
        confirmed,
      ).conversations,
    ).toEqual([confirmed]);
  });
});
