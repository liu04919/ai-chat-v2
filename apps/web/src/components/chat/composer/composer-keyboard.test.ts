import type { KeyboardEvent } from "react";
import { describe, expect, it, vi } from "vitest";

import { handleComposerKeyDown } from "./composer-keyboard";

function createEvent(overrides: Record<string, unknown> = {}) {
  const requestSubmit = vi.fn();
  const preventDefault = vi.fn();
  const event = {
    key: "Enter",
    shiftKey: false,
    ctrlKey: false,
    altKey: false,
    metaKey: false,
    repeat: false,
    nativeEvent: { isComposing: false, keyCode: 13 },
    currentTarget: { form: { requestSubmit } },
    preventDefault,
    ...overrides,
  } as unknown as KeyboardEvent<HTMLTextAreaElement>;
  return { event, requestSubmit, preventDefault };
}

describe("输入框键盘发送", () => {
  it("Enter 阻止换行并复用表单提交", () => {
    const { event, requestSubmit, preventDefault } = createEvent();
    handleComposerKeyDown(event, true);
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(requestSubmit).toHaveBeenCalledOnce();
  });

  it.each([
    { shiftKey: true },
    { ctrlKey: true },
    { altKey: true },
    { metaKey: true },
    { key: "a" },
    { nativeEvent: { isComposing: true, keyCode: 13 } },
    { nativeEvent: { isComposing: false, keyCode: 229 } },
  ])("换行、其他按键和输入法确认不发送：%j", (overrides) => {
    const { event, requestSubmit, preventDefault } = createEvent(overrides);
    handleComposerKeyDown(event, true);
    expect(preventDefault).not.toHaveBeenCalled();
    expect(requestSubmit).not.toHaveBeenCalled();
  });

  it("不可发送时 Enter 不提交，也不额外插入换行", () => {
    const { event, requestSubmit, preventDefault } = createEvent();
    handleComposerKeyDown(event, false);
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(requestSubmit).not.toHaveBeenCalled();
  });

  it("长按 Enter 不重复提交", () => {
    const { event, requestSubmit, preventDefault } = createEvent({ repeat: true });
    handleComposerKeyDown(event, true);
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(requestSubmit).not.toHaveBeenCalled();
  });
});
