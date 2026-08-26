import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import * as schema from "./schema/index";

export function createDatabase(databaseUrl: string, maxConnections = 10) {
  const client = postgres(databaseUrl, { max: maxConnections });
  const db = drizzle(client, { schema });

  return {
    client,
    db,
    close: () => client.end(),
  };
}

let applicationDatabase: ReturnType<typeof createDatabase> | undefined;

export function getDatabase() {
  const databaseUrl = process.env.DATABASE_URL;

  if (!databaseUrl) {
    throw new Error("缺少 DATABASE_URL，无法连接 PostgreSQL");
  }

  applicationDatabase ??= createDatabase(databaseUrl);
  return applicationDatabase.db;
}

export async function closeApplicationDatabase() {
  await applicationDatabase?.close();
  applicationDatabase = undefined;
}
