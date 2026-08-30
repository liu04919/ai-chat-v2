"use client";

import {
  ATTACHMENT_MAX_SIZE_BYTES,
  attachmentMediaTypeSchema,
  type AttachmentDto,
  type ConversationModeDto,
} from "@ai-chat/contracts";
import { useMutation } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";

import {
  AttachmentClientError,
  completeAttachmentUpload,
  createAttachmentUpload,
  deleteAttachment,
  getAttachmentClientErrorMessage,
  uploadAttachmentObject,
} from "@/lib/attachments-client";

export type DraftAttachmentStatus =
  | "uploading"
  | "ready"
  | "error"
  | "removing";

export type DraftAttachmentItem = {
  localId: string;
  file: File;
  previewUrl: string | null;
  attachment: AttachmentDto | null;
  status: DraftAttachmentStatus;
  error: string | null;
};

type UseDraftAttachmentsOptions = {
  mode: ConversationModeDto;
  onPresenceChange?: (hasAttachments: boolean) => void;
};

function validateFile(file: File, mode: ConversationModeDto): string | null {
  const mediaType = attachmentMediaTypeSchema.safeParse(file.type);

  if (!mediaType.success) {
    return "仅支持 PNG、JPEG、WebP 和 PDF";
  }

  if (mode === "image" && mediaType.data === "application/pdf") {
    return "图片模式只支持参考图片";
  }

  if (file.size === 0) {
    return "不能上传空文件";
  }

  if (file.size > ATTACHMENT_MAX_SIZE_BYTES) {
    return "单个文件不能超过 10 MiB";
  }

  return null;
}

export function useDraftAttachments({
  mode,
  onPresenceChange,
}: UseDraftAttachmentsOptions) {
  const [items, setItems] = useState<DraftAttachmentItem[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const itemCountRef = useRef(0);
  const previewUrlsRef = useRef(new Set<string>());
  const createMutation = useMutation({ mutationFn: createAttachmentUpload });
  const completeMutation = useMutation({
    mutationFn: completeAttachmentUpload,
  });
  const deleteMutation = useMutation({ mutationFn: deleteAttachment });

  useEffect(
    () => () => {
      for (const previewUrl of previewUrlsRef.current) {
        URL.revokeObjectURL(previewUrl);
      }
    },
    [],
  );

  const updateItem = useCallback(
    (localId: string, update: Partial<DraftAttachmentItem>) => {
      setItems((current) =>
        current.map((item) =>
          item.localId === localId ? { ...item, ...update } : item,
        ),
      );
    },
    [],
  );

  const uploadItem = useCallback(
    async (item: DraftAttachmentItem) => {
      updateItem(item.localId, {
        status: "uploading",
        error: null,
      });

      let attachment = item.attachment;

      try {
        if (attachment) {
          try {
            await deleteMutation.mutateAsync(attachment.id);
          } catch (error) {
            if (
              !(
                error instanceof AttachmentClientError &&
                error.code === "ATTACHMENT_NOT_FOUND"
              )
            ) {
              throw error;
            }
          }

          attachment = null;
          updateItem(item.localId, { attachment: null });
        }

        const created = await createMutation.mutateAsync(item.file);
        attachment = created.attachment;
        updateItem(item.localId, { attachment });

        await uploadAttachmentObject(item.file, created.upload);
        const completed = await completeMutation.mutateAsync(attachment.id);

        updateItem(item.localId, {
          attachment: completed.attachment,
          status: "ready",
          error: null,
        });
      } catch (error) {
        updateItem(item.localId, {
          attachment,
          status: "error",
          error: getAttachmentClientErrorMessage(error),
        });
      }
    },
    [completeMutation, createMutation, deleteMutation, updateItem],
  );

  const addFiles = useCallback(
    (fileList: FileList | null) => {
      if (!fileList || fileList.length === 0) {
        return;
      }

      if (mode === "image" && itemCountRef.current > 0) {
        setNotice("图片模式只允许一张参考图片");
        return;
      }

      const selectedFiles = Array.from(fileList).slice(
        0,
        mode === "image" ? 1 : undefined,
      );
      const acceptedItems: DraftAttachmentItem[] = [];
      let validationMessage: string | null = null;

      for (const file of selectedFiles) {
        const error = validateFile(file, mode);

        if (error) {
          validationMessage ??= `${file.name}：${error}`;
          continue;
        }

        const previewUrl = file.type.startsWith("image/")
          ? URL.createObjectURL(file)
          : null;

        if (previewUrl) {
          previewUrlsRef.current.add(previewUrl);
        }

        acceptedItems.push({
          localId: crypto.randomUUID(),
          file,
          previewUrl,
          attachment: null,
          status: "uploading",
          error: null,
        });
      }

      setNotice(validationMessage);

      if (acceptedItems.length === 0) {
        return;
      }

      itemCountRef.current += acceptedItems.length;
      onPresenceChange?.(true);
      setItems((current) => [...current, ...acceptedItems]);

      for (const item of acceptedItems) {
        void uploadItem(item);
      }
    },
    [mode, onPresenceChange, uploadItem],
  );

  const removeItem = useCallback(
    async (item: DraftAttachmentItem) => {
      if (item.status === "uploading" || item.status === "removing") {
        return;
      }

      updateItem(item.localId, { status: "removing", error: null });

      try {
        if (item.attachment) {
          try {
            await deleteMutation.mutateAsync(item.attachment.id);
          } catch (error) {
            if (
              !(
                error instanceof AttachmentClientError &&
                error.code === "ATTACHMENT_NOT_FOUND"
              )
            ) {
              throw error;
            }
          }
        }

        if (item.previewUrl) {
          URL.revokeObjectURL(item.previewUrl);
          previewUrlsRef.current.delete(item.previewUrl);
        }

        setItems((current) =>
          current.filter((candidate) => candidate.localId !== item.localId),
        );
        itemCountRef.current = Math.max(0, itemCountRef.current - 1);
        onPresenceChange?.(itemCountRef.current > 0);
      } catch (error) {
        updateItem(item.localId, {
          status: "error",
          error: getAttachmentClientErrorMessage(error),
        });
      }
    },
    [deleteMutation, onPresenceChange, updateItem],
  );

  const retryItem = useCallback(
    (item: DraftAttachmentItem) => {
      if (item.status === "error") {
        void uploadItem(item);
      }
    },
    [uploadItem],
  );

  const clearSubmitted = useCallback(() => {
    for (const previewUrl of previewUrlsRef.current) {
      URL.revokeObjectURL(previewUrl);
    }

    previewUrlsRef.current.clear();
    itemCountRef.current = 0;
    setItems([]);
    setNotice(null);
    onPresenceChange?.(false);
  }, [onPresenceChange]);

  return {
    items,
    notice,
    canAdd: mode === "chat" || items.length === 0,
    addFiles,
    removeItem,
    retryItem,
    clearSubmitted,
  };
}
