"use client";

import type { McpToolPreferencesDto } from "@ai-chat/contracts";
import { createContext, use, useMemo, useState } from "react";

type McpToolPreferencesContextValue = {
  mcpToolIds: readonly string[];
  replaceMcpToolIds: (mcpToolIds: string[]) => void;
};

const McpToolPreferencesContext =
  createContext<McpToolPreferencesContextValue | null>(null);

export function McpToolPreferencesProvider({
  children,
  initialPreferences,
}: Readonly<{
  children: React.ReactNode;
  initialPreferences: McpToolPreferencesDto;
}>) {
  const [mcpToolIds, setMcpToolIds] = useState(
    () => initialPreferences.mcpToolIds,
  );
  const value = useMemo(
    () => ({ mcpToolIds, replaceMcpToolIds: setMcpToolIds }),
    [mcpToolIds],
  );

  return (
    <McpToolPreferencesContext value={value}>
      {children}
    </McpToolPreferencesContext>
  );
}

export function useMcpToolPreferences() {
  const context = use(McpToolPreferencesContext);

  if (!context) {
    throw new Error(
      "useMcpToolPreferences 必须在 McpToolPreferencesProvider 中使用",
    );
  }

  return context;
}
