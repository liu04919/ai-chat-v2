import { migrate } from "drizzle-orm/postgres-js/migrator";

import { createDatabase } from "./client";

export async function migrateDatabase(input: {
  databaseUrl: string;
  migrationsFolder: string;
}) {
  const database = createDatabase(input.databaseUrl, 1);

  try {
    await migrate(database.db, { migrationsFolder: input.migrationsFolder });
  } finally {
    await database.close();
  }
}
