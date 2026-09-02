import { z } from "zod";

export const MCP_TOOL_ID_SEPARATOR = ".";

export const mcpToolIdSchema = z
  .string()
  .min(3)
  .max(160)
  .refine((value) => {
    const separatorIndex = value.indexOf(MCP_TOOL_ID_SEPARATOR);
    return separatorIndex > 0 && separatorIndex < value.length - 1;
  }, "MCP Tool ID 必须使用 serverId.toolName 格式");

export const generationToolSelectionSchema = z
  .object({
    webSearch: z.boolean(),
    mcpToolIds: z.array(mcpToolIdSchema).max(32),
  })
  .strict()
  .superRefine((selection, context) => {
    if (new Set(selection.mcpToolIds).size !== selection.mcpToolIds.length) {
      context.addIssue({
        code: "custom",
        path: ["mcpToolIds"],
        message: "同一个 MCP Tool 不能重复启用",
      });
    }
  });

export type GenerationToolSelectionDto = z.infer<
  typeof generationToolSelectionSchema
>;
