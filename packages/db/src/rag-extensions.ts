import type { createDatabase } from "./client";

/** 镜像负责提供扩展文件；每个数据库仍需单独启用扩展。 */
export async function ensureRagExtensions(client: ReturnType<typeof createDatabase>["client"]) {
  await client`CREATE EXTENSION IF NOT EXISTS vector`;
  await client`CREATE EXTENSION IF NOT EXISTS pg_textsearch`;
  await client`CREATE EXTENSION IF NOT EXISTS zhparser`;
  await client`DO $$ BEGIN
    IF NOT EXISTS (
      SELECT 1 FROM pg_ts_config c JOIN pg_namespace n ON n.oid = c.cfgnamespace
      WHERE n.nspname = 'public' AND c.cfgname = 'rag_chinese'
    ) THEN
      CREATE TEXT SEARCH CONFIGURATION public.rag_chinese (PARSER = zhparser);
      ALTER TEXT SEARCH CONFIGURATION public.rag_chinese
        ADD MAPPING FOR n, v, a, i, e, l WITH simple;
    END IF;
  END $$`;
}
