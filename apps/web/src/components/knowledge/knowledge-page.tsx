"use client";

import type { KnowledgeDocumentDto } from "@ai-chat/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  BookOpen,
  FileText,
  LoaderCircle,
  Plus,
  Trash2,
  Upload,
} from "lucide-react";
import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  createKnowledgeBase,
  fetchKnowledgeDocuments,
  removeKnowledgeFile,
  uploadKnowledgeFile,
} from "@/lib/knowledge-client";
import { useKnowledgeBases } from "./knowledge-provider";
import { DeleteKnowledgeBaseButton } from "./delete-knowledge-base-button";

const statusLabels = {
  uploading: "待上传",
  pending: "等待处理",
  processing: "处理中",
  ready: "已就绪",
  failed: "处理失败",
};

function KnowledgeDocuments({
  ownerId,
  baseId,
}: Readonly<{ ownerId: string; baseId: string }>) {
  const client = useQueryClient();
  const input = useRef<HTMLInputElement>(null);
  const [deleting, setDeleting] = useState<KnowledgeDocumentDto | null>(null);
  const queryKey = ["knowledge-documents", ownerId, baseId] as const;
  const documents = useQuery({
    queryKey,
    queryFn: ({ signal }) => fetchKnowledgeDocuments(baseId, signal),
    refetchInterval: (query) =>
      query.state.data?.some(
        (d) => d.status === "pending" || d.status === "processing",
      )
        ? 2000
        : false,
  });
  const upload = useMutation({
    mutationFn: (file: File) => uploadKnowledgeFile(baseId, file),
    onSettled: () => client.invalidateQueries({ queryKey }),
  });
  const remove = useMutation({
    mutationFn: (id: string) => removeKnowledgeFile(baseId, id),
    onSuccess: () => setDeleting(null),
    onSettled: () => client.invalidateQueries({ queryKey }),
  });
  return (
    <div>
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          TXT、Markdown、文本 PDF · 最大 10 MB
        </p>
        <input
          aria-label="上传知识库文件"
          ref={input}
          className="sr-only"
          type="file"
          accept=".txt,.md,.pdf"
          onChange={(e) => {
            const file = e.currentTarget.files?.[0];
            e.currentTarget.value = "";
            if (file) {
              remove.reset();
              upload.mutate(file);
            }
          }}
        />
        <Button
          disabled={upload.isPending}
          onClick={() => input.current?.click()}
        >
          <Upload className="size-4" />
          {upload.isPending ? "上传中…" : "上传文件"}
        </Button>
      </div>
      {upload.error || remove.error ? (
        <p role="alert" className="mb-4 text-sm text-destructive">
          {(upload.error ?? remove.error)?.message}
        </p>
      ) : null}
      {documents.isPending ? (
        <p role="status" className="text-sm text-muted-foreground">
          加载中…
        </p>
      ) : documents.isError ? (
        <Button variant="outline" onClick={() => void documents.refetch()}>
          加载失败，重试
        </Button>
      ) : !documents.data.length ? (
        <div className="rounded-2xl border border-dashed p-12 text-center text-muted-foreground">
          上传第一份资料
        </div>
      ) : (
        <ul className="divide-y rounded-2xl border">
          {documents.data.map((document) => (
            <li className="flex items-center gap-3 p-4" key={document.id}>
              {document.status === "processing" ||
              document.status === "pending" ? (
                <LoaderCircle
                  className="size-5 shrink-0 animate-spin text-muted-foreground"
                  aria-hidden="true"
                />
              ) : (
                <FileText
                  className="size-5 shrink-0 text-muted-foreground"
                  aria-hidden="true"
                />
              )}
              <div className="min-w-0 flex-1">
                <p
                  className="truncate text-sm font-medium"
                  title={document.originalName}
                >
                  {document.originalName}
                </p>
                <p
                  className={`mt-1 text-xs ${document.status === "failed" ? "text-destructive" : "text-muted-foreground"}`}
                >
                  {statusLabels[document.status]} ·{" "}
                  {Math.ceil(document.sizeBytes / 1024)} KB
                  {document.status === "ready"
                    ? ` · ${document.chunkCount} 个片段`
                    : ""}
                </p>
                {document.status === "failed" ? (
                  <p className="mt-1 text-xs text-muted-foreground">
                    请确认文件可提取文字，删除后重新上传。
                  </p>
                ) : null}
              </div>
              <Button
                variant="ghost"
                className="size-9 p-0"
                aria-label={`删除 ${document.originalName}`}
                disabled={remove.isPending}
                onClick={() => {
                  remove.reset();
                  setDeleting(document);
                }}
              >
                <Trash2 className="size-4" />
              </Button>
            </li>
          ))}
        </ul>
      )}
      <Dialog
        open={Boolean(deleting)}
        onOpenChange={(open) => {
          if (!open && !remove.isPending) setDeleting(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>删除文件？</DialogTitle>
            <DialogDescription>
              “{deleting?.originalName}
              ”将不再参与后续检索。已有回答中的引用快照会保留。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              disabled={remove.isPending}
              onClick={() => setDeleting(null)}
            >
              取消
            </Button>
            <Button
              variant="destructive"
              disabled={remove.isPending}
              onClick={() => deleting && remove.mutate(deleting.id)}
            >
              {remove.isPending ? "删除中…" : "删除"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

export function KnowledgePage() {
  const catalog = useKnowledgeBases();
  const client = useQueryClient();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [cleanupWarning, setCleanupWarning] = useState(false);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const create = useMutation({
    mutationFn: createKnowledgeBase,
    onSuccess: (base) => {
      client.setQueryData(catalog.queryKey, [base, ...catalog.data]);
      setSelectedId(base.id);
      setCreating(false);
      setName("");
      void client.invalidateQueries({ queryKey: catalog.queryKey });
    },
  });
  const selected =
    catalog.data.find((b) => b.id === selectedId) ?? catalog.data[0];
  return (
    <section className="h-full overflow-y-auto px-6 py-8 sm:px-10">
      <div className="mx-auto max-w-5xl">
        <header className="mb-8 flex items-center justify-between gap-4">
          <h1 className="flex items-center gap-3 text-2xl font-semibold">
            <BookOpen className="size-6" />
            知识库
          </h1>
          <Button
            onClick={() => {
              create.reset();
              setCreating(true);
            }}
          >
            <Plus className="size-4" />
            构建你的知识库
          </Button>
        </header>
        {cleanupWarning ? (
          <p role="alert" className="mb-5 text-sm text-destructive">
            知识库已删除，但部分原文件清理失败。
          </p>
        ) : null}
        {catalog.isError ? (
          <Button variant="outline" onClick={() => void catalog.refetch()}>
            加载失败，重试
          </Button>
        ) : null}
        {catalog.data.length ? (
          <div className="grid items-start gap-8 lg:grid-cols-[200px_1fr]">
            <nav
              aria-label="知识库列表"
              className="flex gap-2 overflow-x-auto lg:flex-col"
            >
              {catalog.data.map((base) => (
                <div
                  key={base.id}
                  className={`group/knowledge-base flex min-w-0 shrink-0 items-center gap-1 rounded-xl border pr-1 ${selected?.id === base.id ? "border-border" : "border-transparent"}`}
                >
                  <Button
                    variant="ghost"
                    className="min-w-0 flex-1 justify-start"
                    aria-pressed={selected?.id === base.id}
                    onClick={() => setSelectedId(base.id)}
                  >
                    <span className="truncate">{base.name}</span>
                  </Button>
                  <DeleteKnowledgeBaseButton
                    base={base}
                    onDeleted={(cleanupFailed) => {
                      setSelectedId((current) =>
                        current === base.id ? null : current,
                      );
                      setCleanupWarning(cleanupFailed);
                    }}
                  />
                </div>
              ))}
            </nav>
            <div className="min-w-0">
              <h2 className="mb-5 truncate text-lg font-semibold">
                {selected?.name}
              </h2>
              {selected ? (
                <KnowledgeDocuments
                  key={selected.id}
                  ownerId={catalog.ownerId}
                  baseId={selected.id}
                />
              ) : null}
            </div>
          </div>
        ) : (
          <div className="rounded-2xl border border-dashed p-16 text-center text-muted-foreground">
            还没有知识库
          </div>
        )}
      </div>
      <Dialog
        open={creating}
        onOpenChange={(open) => {
          if (!create.isPending) setCreating(open);
        }}
      >
        <DialogContent aria-describedby={undefined}>
          <DialogHeader>
            <DialogTitle>构建你的知识库</DialogTitle>
          </DialogHeader>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (name.trim() && !create.isPending) create.mutate(name.trim());
            }}
          >
            <label className="text-sm" htmlFor="knowledge-name">
              名称
            </label>
            <Input
              id="knowledge-name"
              className="my-3"
              maxLength={100}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="例如：学习资料"
              required
            />
            {create.error ? (
              <p role="alert" className="mb-3 text-sm text-destructive">
                {create.error.message}
              </p>
            ) : null}
            <DialogFooter>
              <Button type="submit" disabled={!name.trim() || create.isPending}>
                {create.isPending ? "创建中…" : "创建"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </section>
  );
}
