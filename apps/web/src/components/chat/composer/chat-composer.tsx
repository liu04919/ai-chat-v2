"use client";

import type {
  ConversationModeDto,
  ReasoningEffortDto,
  UserMessagePartsDto,
} from "@ai-chat/contracts";
import { ArrowUp, Brain, Paperclip } from "lucide-react";
import { useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";

import { DraftAttachmentList } from "./draft-attachment-list";
import { useDraftAttachments } from "./use-draft-attachments";

const reasoningOptions: ReadonlyArray<{
  value: ReasoningEffortDto;
  label: string;
}> = [
  { value: "low", label: "快速" },
  { value: "medium", label: "标准" },
  { value: "high", label: "深入" },
];

export type ChatComposerSubmission = {
  parts: UserMessagePartsDto;
  reasoningEffort: ReasoningEffortDto | null;
};

export function ChatComposer({
  disabled = false,
  mode,
  onAttachmentPresenceChange,
  onSubmit,
  submitError,
}: Readonly<{
  disabled?: boolean;
  mode: ConversationModeDto;
  onAttachmentPresenceChange?: (hasAttachments: boolean) => void;
  onSubmit?: (submission: ChatComposerSubmission) => Promise<void>;
  submitError?: string | null;
}>) {
  const [input, setInput] = useState("");
  const [reasoningEffort, setReasoningEffort] =
    useState<ReasoningEffortDto>("medium");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const attachments = useDraftAttachments({
    mode,
    onPresenceChange: onAttachmentPresenceChange,
  });

  const acceptedFileTypes =
    mode === "chat"
      ? "image/png,image/jpeg,image/webp,application/pdf"
      : "image/png,image/jpeg,image/webp";
  const attachmentsReady = attachments.items.every(
    (item) => item.status === "ready" && item.attachment !== null,
  );
  const hasContent =
    input.trim().length > 0 ||
    attachments.items.some(
      (item) => item.status === "ready" && item.attachment !== null,
    );
  const canSubmit =
    Boolean(onSubmit) &&
    !disabled &&
    attachmentsReady &&
    hasContent &&
    !isSubmitting;

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!canSubmit || !onSubmit) {
      return;
    }

    const text = input.trim();
    const parts: UserMessagePartsDto = [
      ...(text ? [{ type: "text" as const, text }] : []),
      ...attachments.items.flatMap((item) =>
        item.status === "ready" && item.attachment
          ? [
              {
                type: "attachment" as const,
                attachmentId: item.attachment.id,
              },
            ]
          : [],
      ),
    ];

    setIsSubmitting(true);

    try {
      await onSubmit({
        parts,
        reasoningEffort: mode === "chat" ? reasoningEffort : null,
      });
      setInput("");
      attachments.clearSubmitted();
    } catch {
      // 父组件保留并展示具体错误，Composer 只负责保留当前草稿。
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <form
      aria-busy={isSubmitting}
      className="w-full rounded-[1.75rem] border bg-background p-2 shadow-[0_18px_55px_-28px_rgba(15,23,42,0.35)]"
      onSubmit={handleSubmit}
    >
      <DraftAttachmentList
        disabled={disabled || isSubmitting}
        items={attachments.items}
        onRemove={(item) => void attachments.removeItem(item)}
        onRetry={attachments.retryItem}
      />

      <Textarea
        aria-label={mode === "chat" ? "消息内容" : "图片描述"}
        className="min-h-20 max-h-64"
        placeholder={mode === "chat" ? "输入消息" : "描述你想生成的图片"}
        value={input}
        disabled={disabled || isSubmitting}
        onChange={(event) => setInput(event.target.value)}
      />

      <div className="flex items-center justify-between gap-3 px-2 pb-1">
        <div className="flex min-w-0 items-center gap-1">
          <input
            accept={acceptedFileTypes}
            className="sr-only"
            multiple={mode === "chat"}
            ref={fileInputRef}
            type="file"
            onChange={(event) => {
              attachments.addFiles(event.currentTarget.files);
              event.currentTarget.value = "";
            }}
          />
          <Button
            aria-label={mode === "chat" ? "添加图片或 PDF" : "添加参考图片"}
            className="size-9 rounded-full p-0 hover:bg-foreground/10 active:bg-foreground/20"
            disabled={!attachments.canAdd || disabled || isSubmitting}
            onClick={() => fileInputRef.current?.click()}
            title={mode === "chat" ? "添加附件" : "添加一张参考图片"}
            variant="ghost"
          >
            <Paperclip className="size-4" aria-hidden="true" />
          </Button>

          <div
            aria-hidden={mode !== "chat"}
            className={
              mode === "chat"
                ? "translate-y-0 opacity-100 transition-all duration-200 ease-out motion-reduce:transition-none"
                : "pointer-events-none translate-y-1 opacity-0 transition-all duration-200 ease-out motion-reduce:transition-none"
            }
          >
            <Select
              disabled={mode !== "chat" || disabled || isSubmitting}
              value={reasoningEffort}
              onValueChange={(value) =>
                setReasoningEffort(value as ReasoningEffortDto)
              }
            >
              <SelectTrigger
                aria-label="思考等级"
                className="h-9 min-w-28 rounded-full bg-background px-3 font-medium shadow-none"
              >
                <Brain
                  className="size-4 text-muted-foreground"
                  aria-hidden="true"
                />
                <SelectValue />
              </SelectTrigger>
              <SelectContent
                align="start"
                className="min-w-36 rounded-xl p-1"
                position="popper"
                side="bottom"
                sideOffset={8}
              >
                {reasoningOptions.map((option) => (
                  <SelectItem
                    className="h-9 rounded-lg px-3 pr-8 font-medium"
                    key={option.value}
                    value={option.value}
                  >
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        <Button
          aria-label={mode === "chat" ? "发送消息" : "生成图片"}
          className="size-10 rounded-full p-0"
          disabled={!canSubmit}
          type="submit"
        >
          <ArrowUp className="size-5" aria-hidden="true" />
        </Button>
      </div>

      {submitError || attachments.notice ? (
        <p className="px-3 pb-1 text-xs text-destructive" role="alert">
          {submitError ?? attachments.notice}
        </p>
      ) : null}
    </form>
  );
}
