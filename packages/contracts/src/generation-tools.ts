import { z } from "zod";

export const MCP_TOOL_ID_SEPARATOR = ".";

export const mcpServerSourceSchema = z.enum(["owned", "third-party"]);

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

export const mcpCatalogToolSchema = z
  .object({
    id: mcpToolIdSchema,
    name: z.string().min(1),
    title: z.string().min(1).optional(),
    description: z.string().min(1).optional(),
  })
  .strict();

const mcpCatalogServerBase = {
  id: z.string().min(1),
  title: z.string().min(1),
  description: z.string().min(1),
  source: mcpServerSourceSchema,
};

export const availableMcpCatalogServerSchema = z
  .object({
    ...mcpCatalogServerBase,
    status: z.literal("available"),
    tools: z.array(mcpCatalogToolSchema),
  })
  .strict();

export const unavailableMcpCatalogServerSchema = z
  .object({
    ...mcpCatalogServerBase,
    status: z.literal("unavailable"),
    tools: z.array(mcpCatalogToolSchema).max(0),
    message: z.string().min(1),
  })
  .strict();

export const mcpCatalogServerSchema = z.discriminatedUnion("status", [
  availableMcpCatalogServerSchema,
  unavailableMcpCatalogServerSchema,
]);

export const mcpToolCatalogResponseSchema = z
  .object({
    servers: z.array(mcpCatalogServerSchema),
  })
  .strict();

export const mcpToolPreferencesSchema = z
  .object({
    mcpToolIds: z.array(mcpToolIdSchema).max(32),
  })
  .strict()
  .superRefine((preferences, context) => {
    if (new Set(preferences.mcpToolIds).size !== preferences.mcpToolIds.length) {
      context.addIssue({
        code: "custom",
        path: ["mcpToolIds"],
        message: "同一个 MCP Tool 不能重复启用",
      });
    }
  });

export type McpServerSourceDto = z.infer<typeof mcpServerSourceSchema>;
export type McpCatalogToolDto = z.infer<typeof mcpCatalogToolSchema>;
export type McpCatalogServerDto = z.infer<typeof mcpCatalogServerSchema>;
export type McpToolCatalogResponse = z.infer<
  typeof mcpToolCatalogResponseSchema
>;
export type McpToolPreferencesDto = z.infer<
  typeof mcpToolPreferencesSchema
>;
