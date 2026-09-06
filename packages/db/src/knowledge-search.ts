import { sql } from "drizzle-orm";

// 单独导出 SQL，集成测试用同一条查询检查 EXPLAIN，避免测试另一套示例 SQL。
export function knowledgeSearchQueries(
  ownerId: string,
  baseId: string,
  query: string,
  vector: number[],
  model: string,
) {
  // 先计算允许访问的文档 ID，使权限条件留在 chunk 索引扫描的 Filter 上。
  // 不物化全部 chunk，也不在全局 Top K 之后才做账户过滤。
  const allowedDocuments = sql`ARRAY(
    SELECT d.id FROM knowledge_documents d
    JOIN knowledge_bases b ON b.id = d.knowledge_base_id
    WHERE b.owner_id = ${ownerId} AND b.id = ${baseId}
      AND d.status = 'ready' AND d.embedding_model = ${model}
  )`;
  const fields = sql`c.id, c.document_id AS "documentId", c.content, c.page,
    c.start_offset AS start, c.end_offset AS end`;
  return {
    semantic: sql`WITH candidates AS MATERIALIZED (
      SELECT ${fields}, c.embedding <=> ${JSON.stringify(vector)}::vector AS score
      FROM knowledge_chunks c WHERE c.document_id = ANY(${allowedDocuments})
      ORDER BY c.embedding <=> ${JSON.stringify(vector)}::vector LIMIT 30
    ) SELECT candidates.*, d.original_name AS "originalName"
      FROM candidates JOIN knowledge_documents d ON d.id = candidates."documentId"
      ORDER BY score, candidates.id`,
    lexical: sql`WITH candidates AS MATERIALIZED (
      SELECT ${fields}, c.content <@> to_bm25query(${query}, 'knowledge_chunks_bm25_idx') AS score
      FROM knowledge_chunks c WHERE c.document_id = ANY(${allowedDocuments})
      ORDER BY c.content <@> to_bm25query(${query}, 'knowledge_chunks_bm25_idx') LIMIT 30
    ) SELECT candidates.*, d.original_name AS "originalName"
      FROM candidates JOIN knowledge_documents d ON d.id = candidates."documentId"
      WHERE score < 0 ORDER BY score, candidates.id`,
  };
}
