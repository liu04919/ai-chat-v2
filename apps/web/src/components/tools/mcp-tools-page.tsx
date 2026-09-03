"use client";

import type {
  McpCatalogServerDto,
  McpServerSourceDto,
  McpToolPreferencesDto,
} from "@ai-chat/contracts";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  Check,
  ChevronDown,
  CircleAlert,
  Cloud,
  LoaderCircle,
  RefreshCw,
  Sparkles,
  Wrench,
} from "lucide-react";
import { useId, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  fetchMcpToolCatalog,
  mcpToolCatalogQueryKey,
} from "@/lib/mcp-tools-client";
import { updateMcpToolPreferences } from "@/lib/mcp-tool-preferences-client";
import { cn } from "@/lib/utils";

import {
  toggleMcpServerTools,
  toggleMcpTool,
} from "./mcp-tool-selection";
import { useMcpToolPreferences } from "./mcp-tool-preferences-provider";

const sourceSections: ReadonlyArray<{
  source: McpServerSourceDto;
  title: string;
}> = [
  {
    source: "owned",
    title: "个人工具",
  },
  {
    source: "third-party",
    title: "公开工具",
  },
];

function McpServerCard({
  disabled,
  onChange,
  selectedToolIds,
  server,
}: Readonly<{
  disabled: boolean;
  onChange: (toolIds: string[]) => void;
  selectedToolIds: readonly string[];
  server: McpCatalogServerDto;
}>) {
  const selected = new Set(selectedToolIds);
  const serverToolIds = server.tools.map((tool) => tool.id);
  const selectedCount = serverToolIds.filter((toolId) =>
    selected.has(toolId),
  ).length;
  const allSelected =
    serverToolIds.length > 0 && selectedCount === serverToolIds.length;
  const ServerIcon = server.source === "owned" ? Sparkles : Cloud;
  const [expanded, setExpanded] = useState(false);
  const toolsRegionId = useId();

  return (
    <article className="flex flex-col rounded-2xl border bg-card p-5 shadow-sm transition-shadow hover:shadow-md">
      <div className="flex items-start justify-between gap-4">
        <button
          aria-controls={toolsRegionId}
          aria-expanded={expanded}
          className="group flex min-w-0 flex-1 items-start gap-3.5 rounded-xl text-left outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-4"
          onClick={() => setExpanded((current) => !current)}
          type="button"
        >
          <span className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-primary/8 text-primary ring-1 ring-primary/10">
            <ServerIcon className="size-5" aria-hidden="true" />
          </span>
          <div className="min-w-0">
            <h2 className="truncate text-base font-semibold">{server.title}</h2>
            <p className="mt-1 line-clamp-2 text-sm leading-6 text-muted-foreground">
              {server.description}
            </p>
          </div>
        </button>

        <button
          aria-controls={toolsRegionId}
          aria-expanded={expanded}
          aria-label={`${expanded ? "收起" : "展开"}${server.title}工具`}
          className="group flex size-9 shrink-0 items-center justify-center rounded-full text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
          onClick={() => setExpanded((current) => !current)}
          type="button"
        >
          <ChevronDown
            className={cn(
              "size-4 transition-transform duration-200 motion-reduce:transition-none",
              expanded && "rotate-180",
            )}
            aria-hidden="true"
          />
        </button>
      </div>

      <div
        aria-hidden={!expanded}
        className={cn(
          "grid transition-[grid-template-rows,opacity] duration-200 ease-out motion-reduce:transition-none",
          expanded
            ? "grid-rows-[1fr] opacity-100"
            : "pointer-events-none grid-rows-[0fr] opacity-0",
        )}
        id={toolsRegionId}
        inert={!expanded}
      >
        <div className="min-h-0 overflow-hidden">
          {server.status === "unavailable" ? (
            <div className="mt-6 flex items-start gap-2.5 rounded-xl bg-destructive/8 px-3.5 py-3 text-sm text-destructive">
              <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
              <p>{server.message}</p>
            </div>
          ) : server.tools.length === 0 ? (
            <p className="mt-6 rounded-xl bg-muted/55 px-4 py-5 text-sm text-muted-foreground">
              此 Server 暂时没有可用工具。
            </p>
          ) : (
            <div className="mt-5 grid gap-2">
              {server.tools.map((tool) => {
                const checked = selected.has(tool.id);

                return (
                  <button
                    aria-pressed={checked}
                    className={cn(
                      "group flex w-full items-start gap-3 rounded-xl border border-transparent px-3 py-3 text-left outline-none transition-colors hover:border-border hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring",
                      checked && "border-primary/15 bg-primary/6",
                    )}
                    disabled={disabled}
                    key={tool.id}
                    onClick={() =>
                      onChange(
                        toggleMcpTool(selectedToolIds, tool.id, !checked),
                      )
                    }
                    type="button"
                  >
                    <span
                      className={cn(
                        "mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-md border text-transparent transition-colors group-hover:border-foreground/30",
                        checked &&
                          "border-primary bg-primary text-primary-foreground group-hover:border-primary",
                      )}
                    >
                      <Check className="size-3.5" aria-hidden="true" />
                    </span>
                    <span className="min-w-0">
                      <span className="block text-sm font-medium">
                        {tool.title ?? tool.name}
                      </span>
                      {tool.description ? (
                        <span className="mt-1 block text-xs leading-5 text-muted-foreground">
                          {tool.description}
                        </span>
                      ) : null}
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </div>

      <div className="mt-5 flex items-center justify-between gap-4 border-t pt-4">
        <div className="flex items-center gap-4 text-xs text-muted-foreground">
          <span>{server.tools.length} 个工具</span>
          <span>{selectedCount} 个已启用</span>
        </div>
        {server.status === "available" && serverToolIds.length > 0 ? (
          <Button
            aria-pressed={allSelected}
            className={cn(
              "h-8 shrink-0 rounded-full px-3 text-xs",
              allSelected &&
                "border-primary/20 bg-primary/8 text-primary hover:bg-primary/12",
            )}
            disabled={disabled}
            onClick={() =>
              onChange(
                toggleMcpServerTools(
                  selectedToolIds,
                  serverToolIds,
                  !allSelected,
                ),
              )
            }
            variant="outline"
          >
            {allSelected ? "已全部启用" : "启用全部"}
          </Button>
        ) : null}
      </div>
    </article>
  );
}

export function McpToolsPage() {
  const { mcpToolIds, replaceMcpToolIds } = useMcpToolPreferences();
  const catalog = useQuery({
    queryKey: mcpToolCatalogQueryKey,
    queryFn: ({ signal }) => fetchMcpToolCatalog(signal),
    staleTime: 5 * 60 * 1000,
    retry: false,
  });
  const updatePreferences = useMutation<
    McpToolPreferencesDto,
    Error,
    McpToolPreferencesDto,
    string[]
  >({
    mutationFn: updateMcpToolPreferences,
    onError: (_error, _preferences, context) => {
      if (context) {
        replaceMcpToolIds(context);
      }
    },
    onMutate: (preferences) => {
      const previous = [...mcpToolIds];
      replaceMcpToolIds(preferences.mcpToolIds);
      return previous;
    },
    onSuccess: (preferences) => {
      replaceMcpToolIds(preferences.mcpToolIds);
    },
  });

  function saveSelection(nextToolIds: string[]) {
    updatePreferences.mutate({ mcpToolIds: nextToolIds });
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto w-full max-w-6xl px-8 py-10">
        <header className="flex flex-wrap items-end justify-between gap-6 border-b pb-7">
          <div>
            <div className="flex items-center gap-2 text-sm font-medium text-primary">
              <Wrench className="size-4" aria-hidden="true" />
              MCP
            </div>
            <h1 className="mt-3 text-3xl font-semibold tracking-tight">
              工具与能力
            </h1>
          </div>
          <div className="flex items-center gap-3">
            <div className="rounded-full border bg-muted/40 px-4 py-2 text-sm text-muted-foreground">
              已启用 <span className="font-semibold text-foreground">{mcpToolIds.length}</span> 个工具
            </div>
            {mcpToolIds.length > 0 ? (
              <Button
                className="rounded-full"
                disabled={updatePreferences.isPending}
                onClick={() => saveSelection([])}
                variant="ghost"
              >
                全部关闭
              </Button>
            ) : null}
          </div>
        </header>

        {updatePreferences.isError ? (
          <div className="mt-6 flex items-center gap-2 rounded-xl border border-destructive/20 bg-destructive/6 px-4 py-3 text-sm text-destructive" role="alert">
            <CircleAlert className="size-4 shrink-0" aria-hidden="true" />
            保存失败，已恢复上一次配置，请重试。
          </div>
        ) : null}

        {catalog.isPending ? (
          <div className="flex min-h-96 items-center justify-center gap-3 text-sm text-muted-foreground" role="status">
            <LoaderCircle className="size-5 animate-spin" aria-hidden="true" />
            正在读取工具目录…
          </div>
        ) : catalog.isError ? (
          <div className="flex min-h-96 flex-col items-center justify-center gap-4 text-center">
            <CircleAlert className="size-8 text-destructive" aria-hidden="true" />
            <div>
              <p className="font-medium">工具目录加载失败</p>
              <p className="mt-1 text-sm text-muted-foreground">
                请检查 MCP Server 是否在线。
              </p>
            </div>
            <Button className="gap-2 rounded-full" onClick={() => void catalog.refetch()} variant="outline">
              <RefreshCw className="size-4" aria-hidden="true" />
              重新加载
            </Button>
          </div>
        ) : catalog.data.servers.length === 0 ? (
          <div className="flex min-h-96 items-center justify-center text-sm text-muted-foreground">
            尚未配置 MCP Server。
          </div>
        ) : (
          <div className="space-y-10 py-8">
            {sourceSections.map((section) => {
              const servers = catalog.data.servers.filter(
                (server) => server.source === section.source,
              );

              if (servers.length === 0) {
                return null;
              }

              return (
                <section key={section.source}>
                  <div className="mb-4 flex items-end justify-between gap-4">
                    <div>
                      <h2 className="text-lg font-semibold">{section.title}</h2>
                    </div>
                    <span className="text-xs text-muted-foreground">
                      {servers.length} 个 Server
                    </span>
                  </div>
                  <div className="grid grid-cols-1 gap-5 xl:grid-cols-2">
                    {servers.map((server) => (
                      <McpServerCard
                        disabled={updatePreferences.isPending}
                        key={server.id}
                        onChange={saveSelection}
                        selectedToolIds={mcpToolIds}
                        server={server}
                      />
                    ))}
                  </div>
                </section>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
