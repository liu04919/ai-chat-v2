import { mcpToolPreferencesSchema } from "@ai-chat/contracts";
import {
  getMcpToolPreferencesForUser,
  saveMcpToolPreferencesForUser,
} from "@ai-chat/db";

import { getCurrentSession } from "@/lib/session";

export async function GET() {
  const session = await getCurrentSession();

  if (!session) {
    return Response.json({ code: "UNAUTHORIZED" }, { status: 401 });
  }

  const preferences = await getMcpToolPreferencesForUser(session.user.id);
  return Response.json(mcpToolPreferencesSchema.parse(preferences));
}

export async function PUT(request: Request) {
  const session = await getCurrentSession();

  if (!session) {
    return Response.json({ code: "UNAUTHORIZED" }, { status: 401 });
  }

  const body = await request.json().catch(() => null);
  const input = mcpToolPreferencesSchema.safeParse(body);

  if (!input.success) {
    return Response.json({ code: "INVALID_REQUEST" }, { status: 400 });
  }

  const mcpToolIds = [...input.data.mcpToolIds].sort();
  const preferences = await saveMcpToolPreferencesForUser(
    session.user.id,
    mcpToolIds,
  );

  return Response.json(mcpToolPreferencesSchema.parse(preferences));
}
