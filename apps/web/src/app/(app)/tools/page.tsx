import type { Metadata } from "next";

import { McpToolsPage } from "@/components/tools/mcp-tools-page";

export const metadata: Metadata = {
  title: "MCP 工具",
};

export default function ToolsPage() {
  return <McpToolsPage />;
}
