import type { McpToolPreferencesDto } from "@ai-chat/contracts";
import { eq } from "drizzle-orm";

import { getDatabase } from "./client";
import { userToolPreferences } from "./schema/tool-preference";

export async function getMcpToolPreferencesForUser(
  userId: string,
): Promise<McpToolPreferencesDto> {
  const preferences = await getDatabase().query.userToolPreferences.findFirst({
    columns: { mcpToolIds: true },
    where: eq(userToolPreferences.userId, userId),
  });

  return { mcpToolIds: preferences?.mcpToolIds ?? [] };
}

export async function saveMcpToolPreferencesForUser(
  userId: string,
  mcpToolIds: string[],
): Promise<McpToolPreferencesDto> {
  const [preferences] = await getDatabase()
    .insert(userToolPreferences)
    .values({ userId, mcpToolIds })
    .onConflictDoUpdate({
      target: userToolPreferences.userId,
      set: { mcpToolIds, updatedAt: new Date() },
    })
    .returning({ mcpToolIds: userToolPreferences.mcpToolIds });

  return { mcpToolIds: preferences?.mcpToolIds ?? [] };
}
