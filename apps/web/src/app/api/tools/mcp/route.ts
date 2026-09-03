import { mcpToolCatalogResponseSchema } from "@ai-chat/contracts";

import { getCurrentSession } from "@/lib/session";
import { listMcpTools } from "@/server/mcp-tools";

export async function GET() {
  const session = await getCurrentSession();

  if (!session) {
    return Response.json({ code: "UNAUTHORIZED" }, { status: 401 });
  }

  const response = mcpToolCatalogResponseSchema.parse(await listMcpTools());
  return Response.json(response);
}
