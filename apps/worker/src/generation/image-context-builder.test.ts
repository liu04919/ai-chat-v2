import type { ClaimedGenerationExecution } from "@ai-chat/db";
import { describe, expect, it, vi } from "vitest";

import { buildImageModelRequest } from "./image-context-builder";

function execution(): ClaimedGenerationExecution {
  return {
    id: "generation",
    conversationId: "conversation",
    ownerId: "owner",
    userMessageId: "current",
    mode: "image",
    reasoningEffort: null,
    tools: { webSearch: false, mcpToolIds: [] },
    messages: [
      {
        id: "first",
        role: "user",
        sequence: 0,
        parts: [{ type: "text", text: "画一只蓝色猫" }],
      },
      {
        id: "answer",
        role: "assistant",
        sequence: 1,
        parts: [
          { id: "thought", type: "reasoning", text: "使用蓝色" },
          { id: "caption", type: "text", text: "这是一只猫" },
          { id: "image-part", type: "attachment", attachmentId: "generated" },
        ],
      },
      {
        id: "current",
        role: "user",
        sequence: 2,
        parts: [{ type: "text", text: "把背景改成红色" }],
      },
    ],
    attachments: [
      {
        id: "generated",
        objectKey: "generated.png",
        originalName: "cat.png",
        mediaType: "image/png",
        status: "ready",
      },
    ],
  };
}

describe("Image Context Builder", () => {
  it("带上有序历史文字和最近一次生成图，重新构建本轮请求", async () => {
    const readObject = vi.fn().mockResolvedValue(new Uint8Array([1, 2]));
    const signal = new AbortController().signal;
    const request = await buildImageModelRequest(
      execution(),
      { readObject },
      signal,
    );
    expect(request.referenceImage).toEqual(new Uint8Array([1, 2]));
    expect(request.abortSignal).toBe(signal);
    expect(request.prompt).toContain("使用蓝色");
    expect(request.prompt).toContain("这是一只猫");
    expect(request.prompt.indexOf("画一只蓝色猫")).toBeLessThan(
      request.prompt.indexOf("这是一只猫"),
    );
    expect(request.prompt).toContain("参考图：最近一次生成的图片");
    expect(request.prompt).toMatch(/本轮指令：\n把背景改成红色$/);
    expect(readObject).toHaveBeenCalledExactlyOnceWith("generated.png", signal);
  });

  it("本轮上传图优先，且不会读取未选中的历史附件或未来消息", async () => {
    const input = execution();
    if (input.messages[2].role !== "user")
      throw new Error("fixture must end with user");
    input.messages[2].parts.push({
      type: "attachment",
      attachmentId: "upload",
    });
    input.attachments.push({
      ...input.attachments[0],
      id: "upload",
      objectKey: "upload.png",
    });
    input.messages.push({
      id: "future",
      role: "user",
      sequence: 3,
      parts: [{ type: "text", text: "未来指令" }],
    });
    const readObject = vi.fn().mockResolvedValue(new Uint8Array([3]));
    const request = await buildImageModelRequest(input, { readObject });
    expect(readObject).toHaveBeenCalledExactlyOnceWith("upload.png", undefined);
    expect(request.prompt).toContain("本轮用户提供的图片");
    expect(request.prompt).toContain("历史图片，本次未携带图像内容");
    expect(request.prompt).not.toContain("未来指令");
  });

  it("首轮纯文生图不读取对象，也不回退到历史用户上传图", async () => {
    const input = execution();
    input.messages = [input.messages[2]];
    const readObject = vi.fn();
    expect(
      (await buildImageModelRequest(input, { readObject })).referenceImage,
    ).toBeUndefined();
    input.messages.unshift({
      id: "previous-user",
      role: "user",
      sequence: 0,
      parts: [{ type: "attachment", attachmentId: "generated" }],
    });
    expect(
      (await buildImageModelRequest(input, { readObject })).referenceImage,
    ).toBeUndefined();
    expect(readObject).not.toHaveBeenCalled();
  });

  it.each(["missing", "pending", "pdf"])(
    "拒绝不可用参考图：%s",
    async (kind) => {
      const input = execution();
      if (kind === "missing") input.attachments = [];
      if (kind === "pending") input.attachments[0].status = "pending";
      if (kind === "pdf") input.attachments[0].mediaType = "application/pdf";
      const readObject = vi.fn();
      await expect(
        buildImageModelRequest(input, { readObject }),
      ).rejects.toThrow();
      expect(readObject).not.toHaveBeenCalled();
    },
  );

  it("拒绝多图、无本轮指令和错误会话模式", async () => {
    const input = execution();
    const storage = { readObject: vi.fn() };
    input.messages[2].parts = [
      { type: "text", text: "合并" },
      { type: "attachment", attachmentId: "a" },
      { type: "attachment", attachmentId: "b" },
    ];
    await expect(buildImageModelRequest(input, storage)).rejects.toThrow(
      "一张参考图",
    );
    input.messages[2].parts = [{ type: "text", text: " " }];
    await expect(buildImageModelRequest(input, storage)).rejects.toThrow(
      "本轮文字指令",
    );
    await expect(
      buildImageModelRequest({ ...input, mode: "chat" }, storage),
    ).rejects.toThrow("只接受图片会话");
    await expect(
      buildImageModelRequest(
        { ...execution(), userMessageId: "missing" },
        storage,
      ),
    ).rejects.toThrow("找不到本轮");
  });

  it("取消信号传递到参考图读取，不继续发起模型请求", async () => {
    const controller = new AbortController();
    const readObject = vi.fn(async () => {
      controller.abort();
      return new Uint8Array([1]);
    });
    await expect(
      buildImageModelRequest(execution(), { readObject }, controller.signal),
    ).rejects.toThrow();
    expect(readObject).toHaveBeenCalledWith("generated.png", controller.signal);
  });
});
