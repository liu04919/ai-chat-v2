import { existsSync } from "node:fs";
import { loadEnvFile } from "node:process";
import { fileURLToPath } from "node:url";

import { migrateDatabase } from "./migration";

const localEnvironment = fileURLToPath(
  new URL("../../../apps/web/.env.local", import.meta.url),
);

if (existsSync(localEnvironment)) {
  loadEnvFile(localEnvironment);
}

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error("缺少 DATABASE_URL；请从 apps/web/.env.example 创建 .env.local");
}

await migrateDatabase({
  databaseUrl,
  migrationsFolder: fileURLToPath(new URL("../drizzle", import.meta.url)),
});

console.log("PostgreSQL migration 已执行完成");
