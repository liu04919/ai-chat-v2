"use client";

import { BookOpen, Check, ChevronDown } from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useKnowledgeBases } from "./knowledge-provider";

export function KnowledgeSelector({
  value,
  onChange,
  disabled,
}: Readonly<{
  value: string | null;
  onChange: (id: string | null) => void;
  disabled: boolean;
}>) {
  const catalog = useKnowledgeBases();
  const selected = catalog.data.find((base) => base.id === value);
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          disabled={disabled}
          aria-label="选择本轮知识库"
          className={`h-9 max-w-44 gap-2 rounded-full px-3 ${value ? "bg-primary/12 text-primary" : ""}`}
        >
          <BookOpen className="size-4 shrink-0" aria-hidden="true" />
          <span className="truncate">
            {selected?.name ?? (value ? "知识库不可用" : "知识库")}
          </span>
          <ChevronDown className="size-3 shrink-0" aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-60">
        <DropdownMenuItem onSelect={() => onChange(null)}>
          <span className="flex-1">不使用知识库</span>
          {!value ? <Check /> : null}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <div className="max-h-64 overflow-y-auto">
          {catalog.data.map((base) => (
            <DropdownMenuItem key={base.id} onSelect={() => onChange(base.id)}>
              <span className="min-w-0 flex-1 truncate">{base.name}</span>
              {value === base.id ? <Check /> : null}
            </DropdownMenuItem>
          ))}
        </div>
        {catalog.isError ? (
          <DropdownMenuItem onSelect={() => void catalog.refetch()}>
            加载失败，点击重试
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link href="/knowledge">构建你的知识库</Link>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
