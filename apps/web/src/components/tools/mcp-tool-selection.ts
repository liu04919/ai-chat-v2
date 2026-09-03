export function normalizeMcpToolIds(toolIds: readonly string[]): string[] {
  return [...new Set(toolIds)].sort((left, right) =>
    left.localeCompare(right),
  );
}

export function toggleMcpTool(
  selectedToolIds: readonly string[],
  toolId: string,
  enabled: boolean,
): string[] {
  return normalizeMcpToolIds(
    enabled
      ? [...selectedToolIds, toolId]
      : selectedToolIds.filter((candidate) => candidate !== toolId),
  );
}

export function toggleMcpServerTools(
  selectedToolIds: readonly string[],
  serverToolIds: readonly string[],
  enabled: boolean,
): string[] {
  const serverTools = new Set(serverToolIds);

  return normalizeMcpToolIds(
    enabled
      ? [...selectedToolIds, ...serverToolIds]
      : selectedToolIds.filter((toolId) => !serverTools.has(toolId)),
  );
}
