import { existsSync } from "node:fs";
import { loadEnvFile } from "node:process";

import { defineConfig } from "drizzle-kit";

const localEnvironment = "apps/web/.env.local";

if (existsSync(localEnvironment)) {
  loadEnvFile(localEnvironment);
}

if (!process.env.DATABASE_URL) {
  throw new Error("缺少 DATABASE_URL；请从 apps/web/.env.example 创建 .env.local");
}

export default defineConfig({
  dialect: "postgresql",
  schema: [
    "./packages/db/src/schema/knowledge.ts",
    "./packages/db/src/schema/auth.ts",
    "./packages/db/src/schema/attachment.ts",
    "./packages/db/src/schema/chat.ts",
    "./packages/db/src/schema/conversation-share.ts",
    "./packages/db/src/schema/tool-preference.ts",
  ],
  out: "./packages/db/drizzle",
  dbCredentials: {
    url: process.env.DATABASE_URL,
  },
  strict: true,
  verbose: true,
});
