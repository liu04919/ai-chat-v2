import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import { beforeAll, afterAll, expect, it } from "vitest";
import { createDatabase } from "./client";
import { migrateDatabase } from "./migration";
import { loadIntegrationTestEnvironment } from "./test-environment";
import { knowledgeSearchQueries } from "./knowledge-search";

const databaseUrl = loadIntegrationTestEnvironment();
const database = createDatabase(databaseUrl, 1);
const owner = randomUUID();
const otherOwner = randomUUID();
const base = randomUUID();
const otherBase = randomUUID();
const doc = randomUUID();
const otherDoc = randomUUID();
const queries = knowledgeSearchQueries(
  owner,
  base,
  "数据库",
  [1, ...Array(1023).fill(0)],
  "test",
);

beforeAll(async () => {
  await migrateDatabase({
    databaseUrl,
    migrationsFolder: fileURLToPath(new URL("../drizzle", import.meta.url)),
  });
  const s = database.client;
  await s`INSERT INTO "user" (id, name, email) VALUES (${owner}, 'plan test', ${owner + "@example.com"}), (${otherOwner}, 'other', ${otherOwner + "@example.com"})`;
  await s`INSERT INTO knowledge_bases (id, owner_id, name) VALUES (${base}, ${owner}, 'target'), (${otherBase}, ${otherOwner}, 'other')`;
  await s`INSERT INTO knowledge_documents (id, knowledge_base_id, object_key, original_name, media_type, size_bytes, status, embedding_model)
    VALUES (${doc}, ${base}, ${doc}, 'target.txt', 'text/plain', 1, 'ready', 'test'), (${otherDoc}, ${otherBase}, ${otherDoc}, 'other.txt', 'text/plain', 1, 'ready', 'test')`;
  await s`INSERT INTO knowledge_chunks (id, document_id, ordinal, content, page, start_offset, end_offset, embedding)
    SELECT ${owner} || '-' || n, CASE WHEN n % 10 = 0 THEN ${doc} ELSE ${otherDoc} END, n, '数据库支持向量检索', 1, 0, 10,
      (ARRAY[1::real, (n::real / 1000)] || array_fill(0::real, ARRAY[1022]))::vector
    FROM generate_series(1, 1000) AS n`;
  await s`ANALYZE knowledge_chunks`;
}, 30_000);

afterAll(async () => {
  await database.client`DELETE FROM "user" WHERE id IN (${owner}, ${otherOwner})`;
  await database.close();
});

it("同一条业务 SQL 可以走 HNSW，过滤 90% 候选后迭代补足 30 条", async () => {
  let approximateIds: string[] = [];
  await database.db.transaction(async (tx) => {
    // 仅测试强制候选计划，正式查询不关闭顺序扫描。
    await tx.execute(sql`SET LOCAL enable_seqscan = off`);
    await tx.execute(sql`SET LOCAL enable_bitmapscan = off`);
    await tx.execute(sql`SET LOCAL enable_sort = off`);
    await tx.execute(sql`SET LOCAL hnsw.iterative_scan = strict_order`);
    const plan = await tx.execute(
      sql`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${queries.semantic}`,
    );
    expect(JSON.stringify(plan)).toContain("knowledge_chunks_vector_idx");
    const rows = await tx.execute<{
      id: string;
      documentId: string;
      score: number;
    }>(queries.semantic);
    expect(rows).toHaveLength(30);
    expect(rows.every((r) => r.documentId === doc)).toBe(true);
    expect(rows.map((r) => r.score)).toEqual(
      rows.map((r) => r.score).sort((a, b) => a - b),
    );
    approximateIds = rows.map((r) => r.id);
  });
  await database.db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL enable_indexscan = off`);
    const exact = await tx.execute<{ id: string }>(queries.semantic);
    expect(exact).toHaveLength(30);
    expect(
      approximateIds.filter((id) => exact.some((r) => r.id === id)).length / 30,
    ).toBeGreaterThanOrEqual(0.9);
  });
  const settings = await database.client`SHOW hnsw.iterative_scan`;
  expect(
    settings[0]?.hnsw_iterative_scan ?? settings[0]?.["hnsw.iterative_scan"],
  ).not.toBe("strict_order");
});

it("BM25 候选可使用索引，并且不会返回其他账户的 chunk", async () => {
  await database.db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL enable_seqscan = off`);
    await tx.execute(sql`SET LOCAL enable_bitmapscan = off`);
    await tx.execute(sql`SET LOCAL enable_sort = off`);
    const plan = await tx.execute(
      sql`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${queries.lexical}`,
    );
    expect(JSON.stringify(plan)).toContain(
      '"Index Name":"knowledge_chunks_bm25_idx"',
    );
    const rows = await tx.execute<{ documentId: string }>(queries.lexical);
    expect(rows).toHaveLength(30);
    expect(rows.every((r) => r.documentId === doc)).toBe(true);
  });
});
