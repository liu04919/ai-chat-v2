import { existsSync } from "node:fs";
import { loadEnvFile } from "node:process";
import { fileURLToPath } from "node:url";

export function loadIntegrationTestEnvironment() {
  const localEnvironment = fileURLToPath(
    new URL("../../../apps/web/.env.local", import.meta.url),
  );

  if (existsSync(localEnvironment)) {
    loadEnvFile(localEnvironment);
  }

  const testDatabaseUrl = process.env.TEST_DATABASE_URL;

  if (!testDatabaseUrl) {
    throw new Error(
      "缺少 TEST_DATABASE_URL；请从 apps/web/.env.example 创建 .env.local",
    );
  }

  return testDatabaseUrl;
}
