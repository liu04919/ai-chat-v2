import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createDatabase } from "./client";
import { ensureRagExtensions } from "./rag-extensions";
import { loadIntegrationTestEnvironment } from "./test-environment";

const database = createDatabase(loadIntegrationTestEnvironment(), 1);
const sql = database.client;
const table = `rag_probe_${randomUUID().replaceAll("-", "")}`;
const index = `${table}_bm25`;
beforeAll(async () => {
  await ensureRagExtensions(sql);
  await ensureRagExtensions(sql);
  await sql`CREATE TABLE ${sql(table)} (id integer PRIMARY KEY, owner_id text NOT NULL, content text NOT NULL, embedding vector(3))`;
  await sql`INSERT INTO ${sql(table)} VALUES
    (1, 'a', '数据库支持向量检索和中文搜索', '[1,0,0]'),
    (2, 'a', '周末去公园散步', '[0,1,0]'),
    (3, 'b', '数据库支持向量检索和中文搜索', '[1,0,0]')`;
  await sql`CREATE INDEX ${sql(index)} ON ${sql(table)} USING bm25(content) WITH (text_config='public.rag_chinese')`;
  await sql`CREATE INDEX ${sql(`${table}_vector`)} ON ${sql(table)} USING hnsw(embedding vector_cosine_ops)`;
});
afterAll(async () => {
  await sql`DROP TABLE IF EXISTS ${sql(table)}`;
  await database.close();
});

describe("RAG 数据库底座", () => {
  it("三个扩展均启用，中文被切分为多个词", async () => {
    const extensions = await sql`SELECT extname FROM pg_extension WHERE extname IN ('vector','pg_textsearch','zhparser')`;
    expect(extensions).toHaveLength(3);
    const [result] = await sql`SELECT tsvector_to_array(to_tsvector('public.rag_chinese', '数据库支持向量检索和中文搜索')) AS terms`;
    expect(result!.terms.length).toBeGreaterThan(1);
    expect(result!.terms).toContain('数据库');
  });
  it("中文 BM25 召回相关行并保持用户过滤", async () => {
    const rows = await sql`SELECT id, content <@> to_bm25query('数据库', ${index}) AS score
      FROM ${sql(table)} WHERE owner_id = 'a' ORDER BY score LIMIT 1`;
    expect(rows[0]!.id).toBe(1);
    expect(Number(rows[0]!.score)).toBeLessThan(0);
  });
  it("同一行的向量可做余弦检索，删除后不再召回", async () => {
    const rows = await sql`SELECT id FROM ${sql(table)} WHERE owner_id = 'a' ORDER BY embedding <=> '[1,0,0]' LIMIT 1`;
    expect(rows[0]!.id).toBe(1);
    await sql`DELETE FROM ${sql(table)} WHERE id = 1`;
    const after = await sql`SELECT id FROM ${sql(table)} WHERE owner_id = 'a' ORDER BY content <@> to_bm25query('数据库', ${index}) LIMIT 3`;
    expect(after.map(row => row.id)).not.toContain(1);
    const vectors = await sql`SELECT id FROM ${sql(table)} WHERE owner_id = 'a' ORDER BY embedding <=> '[1,0,0]' LIMIT 3`;
    expect(vectors.map(row => row.id)).not.toContain(1);
  });
});
