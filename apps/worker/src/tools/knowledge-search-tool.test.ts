import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { knowledgeSourcesPartSchema } from "@ai-chat/contracts";
import { createKnowledgeSearchTool } from "./knowledge-search-tool";
import type { ChatKnowledgeRetriever } from "../knowledge/chat-knowledge-retriever";

const source = (chunkId: string) => ({ number: 1, chunkId, documentId: "doc", originalName: "资料.md", page: 1, content: `原文 ${chunkId}` });
function setup(retrieve: ChatKnowledgeRetriever = async () => [source("c")]) {
  const controller = new AbortController();
  const search = createKnowledgeSearchTool({ ownerId: "owner", baseId: "base", signal: controller.signal, retrieve });
  const call = (query: string, id = query, abortSignal?: AbortSignal) => search.tool.execute!({ query }, { toolCallId: id, messages: [], abortSignal, context: {} });
  return { search, call, controller };
}

describe("知识库搜索工具", () => {
  it("输入 schema 拒绝越权字段、空白及超长查询", () => {
    const { search } = setup();
    const schema = search.tool.inputSchema as z.ZodType;
    for (const input of [{ query: "问题", baseId: "foreign" }, { query: "问题", ownerId: "foreign" }, { query: " " }, { query: "x".repeat(2001) }]) {
      expect(schema.safeParse(input).success).toBe(false);
    }
    expect(schema.parse({ query: " 合理查询 " })).toEqual({ query: "合理查询" });
  });
  it("注册不检索，只接受 query；调用使用服务端归属与信号", async () => {
    const retrieve = vi.fn(async () => [source("c")]);
    const { call, search, controller } = setup(retrieve);
    expect(retrieve).not.toHaveBeenCalled();
    const result = await call("改写后的问题");
    expect(retrieve).toHaveBeenCalledWith({ ownerId: "owner", baseId: "base", query: "改写后的问题", signal: controller.signal });
    expect(result).toEqual({ status: "found", sources: [{ number: 1, originalName: "资料.md", page: 1, content: "原文 c" }], remainingSearches: 2 });
    expect(search.takeSources("改写后的问题")).toEqual([source("c")]);
    expect(search.takeSources("改写后的问题")).toEqual([]);
  });

  it("跨检索去重且编号稳定，本轮最多十八条；实例之间不共享状态", async () => {
    const retrieve = vi.fn<ChatKnowledgeRetriever>()
      .mockResolvedValueOnce(Array.from({ length: 6 }, (_, i) => source(`c${i}`)))
      .mockResolvedValueOnce([source("c0"), source("c6"), source("c6")]);
    const { call, search } = setup(retrieve);
    await call("第一次");
    expect(await call("第二次")).toMatchObject({ sources: [{ number: 1 }, { number: 7 }] });
    expect(search.takeSources("第二次")).toEqual([{ ...source("c6"), number: 7 }]);
    const another = setup(async ({ query }) => Array.from({ length: 6 }, (_, i) => source(`${query}${i}`)));
    for (const q of ["a", "b", "c"]) await another.call(q);
    const all = ["a", "b", "c"].flatMap((id) => another.search.takeSources(id));
    expect(all.map((s) => s.number)).toEqual(Array.from({ length: 18 }, (_, i) => i + 1));
    expect(knowledgeSourcesPartSchema.safeParse({ id: "s", type: "knowledge-sources", sources: all }).success).toBe(true);
    expect(await setup().call("fresh")).toMatchObject({ sources: [{ number: 1 }] });
  });

  it("并行调用也最多检索三次，第四次只返回额度耗尽", async () => {
    const retrieve = vi.fn(async () => [source("c")]);
    const { call, search } = setup(retrieve);
    const result = await Promise.all(["a", "b", "c", "d"].map((q) => call(q)));
    expect(retrieve).toHaveBeenCalledTimes(3);
    expect(result[3]).toMatchObject({ status: "limit_reached", sources: [] });
    expect(search.canSearch()).toBe(false);
  });

  it("无匹配和失败分开；异常去敏且失败仍计入调用上限", async () => {
    const retrieve = vi.fn<ChatKnowledgeRetriever>().mockRejectedValueOnce(new Error("private provider credential")).mockResolvedValue([]);
    const { call, search } = setup(retrieve);
    await expect(call("a")).rejects.toThrow("KNOWLEDGE_SEARCH_FAILED");
    expect(search.takeSources("a")).toEqual([]);
    expect(await call("b")).toMatchObject({ status: "no_matches", sources: [], remainingSearches: 1 });
    await call("c");
    expect(search.canSearch()).toBe(false);
  });

  it.each(["before", "during", "sdk"])("%s 取消不发布新来源", async (when) => {
    const retrieve = vi.fn<ChatKnowledgeRetriever>(async () => {
      if (when === "during") controller.abort(new Error("cancelled"));
      return [source("c")];
    });
    const { call, search, controller } = setup(retrieve);
    const sdk = new AbortController();
    if (when === "before") controller.abort(new Error("cancelled"));
    if (when === "sdk") sdk.abort(new Error("cancelled"));
    await expect(call("a", "a", sdk.signal)).rejects.toThrow("cancelled");
    expect(search.takeSources("a")).toEqual([]);
    if (when !== "during") expect(retrieve).not.toHaveBeenCalled();
  });
});
