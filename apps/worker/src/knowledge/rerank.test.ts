import { afterEach, describe, expect, it, vi } from "vitest";
import type { KnowledgeHit } from "@ai-chat/db";
import { createKnowledgeReranker } from "./rerank";
import { retrieveKnowledge, reciprocalRankFusion } from "./retrieve";

const hit = (id: string): KnowledgeHit => ({
  id,
  documentId: `doc-${id}`,
  originalName: `${id}.md`,
  content: `正文 ${id}`,
  page: 2,
  start: 10,
  end: 20,
  score: 0.02,
});
const env = {
  RERANK_BASE_URL: "https://example.test/api/v1/",
  DASHSCOPE_API_KEY: "test-secret",
  RERANK_MODEL: "qwen3.7-text-rerank",
};
const response = (results: unknown, usage: unknown = { total_tokens: 42 }) => ({
  output: { results },
  usage,
  request_id: "request-test",
});
const makeDependencies = () => ({
  repository: {
    requireOwner: vi.fn(async () => ({
      id: "base",
      name: "test",
      ownerId: "owner",
      createdAt: new Date(),
    })),
    retrieve: vi.fn(async () => ({
      semantic: Array.from({ length: 10 }, (_, i) => hit(String(i))),
      lexical: [] as KnowledgeHit[],
    })),
  },
  embedder: { model: "embedding-test", embed: vi.fn(async () => [[1]]) },
  reranker: {
    model: "rerank-test",
    rerank: vi.fn(async (_query: string, candidates: KnowledgeHit[]) => ({
      hits: candidates
        .slice(-6)
        .reverse()
        .map((h) => ({ ...h, rerankScore: 0.8 })),
      totalTokens: 42,
      requestId: "test",
    })),
  },
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("百炼精排适配", () => {
  it("默认仍选 6 条，离线评测可以显式请求完整 50 条", async () => {
    const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(init!.body as string);
      return Response.json(
        response(
          Array.from({ length: body.parameters.top_n }, (_, index) => ({
            index,
            relevance_score: 1 - index / 100,
          })),
        ),
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    const candidates = Array.from({ length: 50 }, (_, i) => hit(String(i)));
    const reranker = createKnowledgeReranker(env);
    expect((await reranker.rerank("问题", candidates)).hits).toHaveLength(6);
    expect(
      (await reranker.rerank("问题", candidates, { topN: 50 })).hits,
    ).toHaveLength(50);
    for (const topN of [0, 61, 0.5, NaN])
      await expect(
        reranker.rerank("问题", candidates, { topN }),
      ).rejects.toThrow("INVALID_RERANK_TOP_N");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
  it("遵循原生接口，按索引映射并保留来源与 RRF 分数", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json(
        response([
          { index: 0, relevance_score: 0.1 },
          { index: 1, relevance_score: 0.9 },
        ]),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const result = await createKnowledgeReranker(env).rerank("问题", [
      hit("a"),
      hit("b"),
    ]);
    expect(result.hits.map((h) => h.id)).toEqual(["b", "a"]);
    expect(result.hits[0]).toEqual({ ...hit("b"), rerankScore: 0.9 });
    expect(result.totalTokens).toBe(42);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe(
      "https://example.test/api/v1/services/rerank/text-rerank/text-rerank",
    );
    expect(JSON.parse(init.body as string)).toEqual({
      model: env.RERANK_MODEL,
      input: { query: "问题", documents: ["正文 a", "正文 b"] },
      parameters: { top_n: 2 },
    });
    expect(init.redirect).toBe("error");
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });
  it.each(
    [
      [
        { index: 2, relevance_score: 0.9 },
        { index: 1, relevance_score: 0.5 },
      ],
      [
        { index: 0, relevance_score: 0.9 },
        { index: 0, relevance_score: 0.8 },
      ],
      [
        { index: -1, relevance_score: 0.9 },
        { index: 1, relevance_score: 0.5 },
      ],
      [
        { index: 0.5, relevance_score: 0.9 },
        { index: 1, relevance_score: 0.5 },
      ],
      [
        { index: 0, relevance_score: 1.5 },
        { index: 1, relevance_score: 0.5 },
      ],
      [],
    ].map((results) => ({ results })),
  )("拒绝索引、数量或分数异常：$results", async ({ results }) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json(response(results))),
    );
    await expect(
      createKnowledgeReranker(env).rerank("问题", [hit("a"), hit("b")]),
    ).rejects.toThrow("RERANK_FAILED");
  });
  it("空候选不调用上游；缺失用量不伪装成零", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({
        output: { results: [{ index: 0, relevance_score: 0.8 }] },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const reranker = createKnowledgeReranker(env);
    expect(await reranker.rerank("问题", [])).toEqual({
      hits: [],
      totalTokens: 0,
      requestId: null,
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect((await reranker.rerank("问题", [hit("a")])).totalTokens).toBeNull();
    expect(() => createKnowledgeReranker({})).toThrow("RERANK_NOT_CONFIGURED");
  });
  it.each([401, 429, 500])(
    "HTTP %s 不重试、不输出上游敏感信息",
    async (status) => {
      const fetchMock = vi.fn(
        async () => new Response("test-secret upstream request", { status }),
      );
      vi.stubGlobal("fetch", fetchMock);
      await expect(
        createKnowledgeReranker(env).rerank("问题", [hit("a")]),
      ).rejects.toThrow(/^RERANK_FAILED$/);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    },
  );
  it("网络超时明确失败", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new DOMException("secret", "TimeoutError");
      }),
    );
    await expect(
      createKnowledgeReranker(env).rerank("问题", [hit("a")]),
    ).rejects.toThrow(/^RERANK_FAILED$/);
  });
});

describe("RRF 与精排流程", () => {
  it("RRF 不先截成 6 条，第十名仍有机会被精排选中", async () => {
    const dependencies = makeDependencies();
    const result = await retrieveKnowledge(
      "owner",
      "base",
      "问题",
      dependencies,
    );
    expect(dependencies.reranker.rerank.mock.calls[0]?.[1]).toHaveLength(10);
    expect(result[0]?.id).toBe("9");
    expect(result).toHaveLength(6);
    const fused = reciprocalRankFusion([
      Array.from({ length: 30 }, (_, i) => hit(String(i))),
      Array.from({ length: 30 }, (_, i) => hit(String(i + 20))),
    ]);
    expect(fused).toHaveLength(50);
  });
  it("权限失败时不调用任何模型", async () => {
    const dependencies = makeDependencies();
    dependencies.repository.requireOwner.mockRejectedValue(
      new Error("KNOWLEDGE_NOT_FOUND"),
    );
    await expect(
      retrieveKnowledge("other", "base", "问题", dependencies),
    ).rejects.toThrow("KNOWLEDGE_NOT_FOUND");
    expect(dependencies.embedder.embed).not.toHaveBeenCalled();
    expect(dependencies.reranker.rerank).not.toHaveBeenCalled();
  });
  it("精排失败不静默返回 RRF", async () => {
    const dependencies = makeDependencies();
    dependencies.reranker.rerank.mockRejectedValue(new Error("RERANK_FAILED"));
    await expect(
      retrieveKnowledge("owner", "base", "问题", dependencies),
    ).rejects.toThrow("RERANK_FAILED");
  });
});
