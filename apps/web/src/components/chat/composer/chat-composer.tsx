"use client";

import type { ConversationModeDto } from "@ai-chat/contracts";
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

type ReasoningEffort = "low" | "medium" | "high";

const reasoningOptions: ReadonlyArray<{
  value: ReasoningEffort;
  label: string;
}> = [
  { value: "low", label: "快速" },
  { value: "medium", label: "标准" },
  { value: "high", label: "深入" },
];

export function ChatComposer({
  mode,
  onAttachmentPresenceChange,
}: Readonly<{
  mode: ConversationModeDto;
  onAttachmentPresenceChange?: (hasAttachments: boolean) => void;
}>) {
  const [input, setInput] = useState("");
  const [reasoningEffort, setReasoningEffort] =
    useState<ReasoningEffort>("medium");
  const fileInputRef = useRef<HTMLInputElement>(null);
  const attachments = useDraftAttachments({
    mode,
    onPresenceChange: onAttachmentPresenceChange,
  });

  const acceptedFileTypes =
    mode === "chat"
      ? "image/png,image/jpeg,image/webp,application/pdf"
      : "image/png,image/jpeg,image/webp";

  return (
    <form
      className="w-full rounded-[1.75rem] border bg-background p-2 shadow-[0_18px_55px_-28px_rgba(15,23,42,0.35)]"
      onSubmit={(event) => event.preventDefault()}
    >
      <DraftAttachmentList
        items={attachments.items}
        onRemove={(item) => void attachments.removeItem(item)}
        onRetry={attachments.retryItem}
      />

      <Textarea
        aria-label={mode === "chat" ? "消息内容" : "图片描述"}
        className="min-h-20 max-h-64"
        placeholder={mode === "chat" ? "输入消息" : "描述你想生成的图片"}
        value={input}
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
            disabled={!attachments.canAdd}
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
              disabled={mode !== "chat"}
              value={reasoningEffort}
              onValueChange={(value) =>
                setReasoningEffort(value as ReasoningEffort)
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
          disabled
          type="submit"
        >
          <ArrowUp className="size-5" aria-hidden="true" />
        </Button>
      </div>

      {attachments.notice ? (
        <p className="px-3 pb-1 text-xs text-destructive" role="alert">
          {attachments.notice}
        </p>
      ) : null}
    </form>
  );
}
