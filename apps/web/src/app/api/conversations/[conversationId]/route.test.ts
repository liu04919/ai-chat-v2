import { beforeEach, describe, expect, it, vi } from "vitest";
import { getCurrentSession } from "@/lib/session";
import { getConversationForOwner } from "@/server/conversations";
import { GET } from "./route";

vi.mock("@/lib/session", () => ({ getCurrentSession: vi.fn() }));
vi.mock("@/server/conversations", () => ({ getConversationForOwner: vi.fn() }));
const context = { params: Promise.resolve({ conversationId: "c1" }) };
const getSession = vi.mocked(getCurrentSession);
const getConversation = vi.mocked(getConversationForOwner);

beforeEach(() => {
  vi.clearAllMocks();
  getSession.mockResolvedValue({ user: { id: "owner" } } as Awaited<ReturnType<typeof getCurrentSession>>);
  getConversation.mockResolvedValue(null);
});

describe("会话游标分页 API", () => {
  it("未登录不读取消息", async () => {
    getSession.mockResolvedValue(null);
    expect((await GET(new Request("http://localhost/api/conversations/c1"), context)).status).toBe(401);
    expect(getConversation).not.toHaveBeenCalled();
  });
  it.each(["-1", "1.5", "NaN", "", "2147483648", "1e2"])("拒绝非法游标 %s", async (cursor) => {
    expect((await GET(new Request(`http://localhost/api/conversations/c1?before=${cursor}`), context)).status).toBe(400);
    expect(getConversation).not.toHaveBeenCalled();
  });
  it("游标 0 有效，读取也必须限定登录用户", async () => {
    expect((await GET(new Request("http://localhost/api/conversations/c1?before=0"), context)).status).toBe(404);
    expect(getConversation).toHaveBeenCalledWith("owner", "c1", 0);
  });
  it("省略游标读取最新页", async () => {
    await GET(new Request("http://localhost/api/conversations/c1"), context);
    expect(getConversation).toHaveBeenCalledWith("owner", "c1", undefined);
  });
});
