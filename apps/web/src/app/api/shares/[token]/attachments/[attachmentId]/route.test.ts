import { beforeEach, describe, expect, it, vi } from "vitest";

import { readPublicConversationShareAttachment } from "@/server/conversation-shares";
import { GET } from "./route";

vi.mock("@/server/conversation-shares", () => ({
  readPublicConversationShareAttachment: vi.fn(),
}));

const validToken = "0c056b9d-2c12-4ccb-a5f2-6d996eceef59";
const context = {
  params: Promise.resolve({ token: validToken, attachmentId: "attachment-1" }),
};

beforeEach(() => vi.clearAllMocks());

describe("公开分享附件 API", () => {
  it("拒绝非法 token，且不访问存储", async () => {
    const response = await GET(new Request("http://localhost"), {
      params: Promise.resolve({ token: "bad", attachmentId: "attachment-1" }),
    });

    expect(response.status).toBe(404);
    expect(readPublicConversationShareAttachment).not.toHaveBeenCalled();
  });

  it("附件不在有效快照中时返回 404", async () => {
    vi.mocked(readPublicConversationShareAttachment).mockResolvedValue(null);

    expect((await GET(new Request("http://localhost"), context)).status).toBe(404);
  });

  it("代理返回对象内容并禁止缓存", async () => {
    vi.mocked(readPublicConversationShareAttachment).mockResolvedValue({
      objectKey: "attachments/image-1",
      originalName: "测试 image.png",
      mediaType: "image/png",
      data: new Uint8Array([1, 2, 3]),
    });

    const response = await GET(new Request("http://localhost"), context);
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(response.headers.get("Content-Type")).toBe("image/png");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(
      new Uint8Array([1, 2, 3]),
    );
  });
});
