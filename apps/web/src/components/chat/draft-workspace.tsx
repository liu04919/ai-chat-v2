"use client";

import type { ConversationModeDto } from "@ai-chat/contracts";
import { ImageIcon, MessageSquareText } from "lucide-react";
import { useState } from "react";

import { ChatComposer } from "./composer/chat-composer";

const modes: ReadonlyArray<{
  value: ConversationModeDto;
  label: string;
  icon: typeof MessageSquareText;
}> = [
  { value: "chat", label: "对话", icon: MessageSquareText },
  { value: "image", label: "图片", icon: ImageIcon },
];

export function DraftWorkspace() {
  const [mode, setMode] = useState<ConversationModeDto>("chat");
  const [hasAttachments, setHasAttachments] = useState(false);

  return (
    <section className="relative flex h-full min-h-0 items-center justify-center overflow-hidden px-5 py-10">
      <div
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_center,oklch(0.94_0.025_250),transparent_48%)] opacity-70"
        aria-hidden="true"
      />

      <div className="relative z-10 flex w-full max-w-3xl flex-col items-center">
        <div className="grid text-center">
          <h1
            aria-hidden={mode !== "chat"}
            className={
              mode === "chat"
                ? "col-start-1 row-start-1 text-4xl font-semibold tracking-tight opacity-100 transition-all duration-300 ease-out motion-reduce:transition-none"
                : "col-start-1 row-start-1 -translate-y-1 text-4xl font-semibold tracking-tight opacity-0 transition-all duration-300 ease-out motion-reduce:transition-none"
            }
          >
            今天想聊些什么？
          </h1>
          <h1
            aria-hidden={mode !== "image"}
            className={
              mode === "image"
                ? "col-start-1 row-start-1 text-4xl font-semibold tracking-tight opacity-100 transition-all duration-300 ease-out motion-reduce:transition-none"
                : "col-start-1 row-start-1 translate-y-1 text-4xl font-semibold tracking-tight opacity-0 transition-all duration-300 ease-out motion-reduce:transition-none"
            }
          >
            想把什么变成画面？
          </h1>
        </div>

        <div
          aria-label="对话模式"
          className="relative mt-7 grid grid-cols-2 rounded-full border bg-background/85 p-1 shadow-sm backdrop-blur"
          role="group"
        >
          <span
            className={
              mode === "chat"
                ? "pointer-events-none absolute inset-y-1 left-1 w-[calc(50%-0.25rem)] rounded-full bg-primary shadow-sm transition-transform duration-300 ease-out motion-reduce:transition-none"
                : "pointer-events-none absolute inset-y-1 left-1 w-[calc(50%-0.25rem)] translate-x-full rounded-full bg-primary shadow-sm transition-transform duration-300 ease-out motion-reduce:transition-none"
            }
            aria-hidden="true"
          />
          {modes.map((item) => {
            const Icon = item.icon;
            const isSelected = item.value === mode;

            return (
              <button
                aria-pressed={isSelected}
                className={
                  isSelected
                    ? "relative z-10 flex h-10 min-w-28 items-center justify-center gap-2 rounded-full px-5 text-sm font-medium text-primary-foreground transition-colors duration-200"
                    : "relative z-10 flex h-10 min-w-28 items-center justify-center gap-2 rounded-full px-5 text-sm font-medium text-muted-foreground transition-colors duration-200 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:text-muted-foreground"
                }
                disabled={hasAttachments && !isSelected}
                key={item.value}
                title={
                  hasAttachments && !isSelected
                    ? "请先移除已添加的附件"
                    : undefined
                }
                type="button"
                onClick={() => setMode(item.value)}
              >
                <Icon className="size-4" aria-hidden="true" />
                {item.label}
              </button>
            );
          })}
        </div>

        <div className="mt-8 w-full">
          <ChatComposer
            mode={mode}
            onAttachmentPresenceChange={setHasAttachments}
          />
        </div>
      </div>
    </section>
  );
}
