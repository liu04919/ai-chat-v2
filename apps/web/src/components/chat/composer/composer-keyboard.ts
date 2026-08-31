import type { KeyboardEvent } from "react";

export function handleComposerKeyDown(
  event: KeyboardEvent<HTMLTextAreaElement>,
  canSubmit: boolean,
) {
  if (
    event.key !== "Enter" ||
    event.shiftKey ||
    event.ctrlKey ||
    event.altKey ||
    event.metaKey ||
    event.nativeEvent.isComposing ||
    // 部分输入法在确认候选词时已结束 composing，但仍发送 229。
    event.nativeEvent.keyCode === 229
  ) {
    return;
  }

  event.preventDefault();
  if (canSubmit && !event.repeat) {
    event.currentTarget.form?.requestSubmit();
  }
}
