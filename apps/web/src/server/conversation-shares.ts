import { randomUUID } from "node:crypto";
import { cache } from "react";

import type {
  ConversationShareDto,
  ConversationShareErrorCode,
  ConversationShareStatusResponse,
  DeleteConversationShareResponse,
} from "@ai-chat/contracts";
import {
  createConversationShareRecordForOwner,
  deleteConversationShareRecordForOwner,
  getConversationShareAttachmentRecord,
  getConversationShareRecordByToken,
  getConversationShareRecordForOwner,
  type ConversationShareRecord,
} from "@ai-chat/db";
import type { ObjectStorage } from "@ai-chat/storage";

import { getAttachmentObjectStorage } from "./attachment-storage";

export class ConversationShareServiceError extends Error {
  constructor(
    readonly code: ConversationShareErrorCode,
    readonly status: 404 | 409,
  ) {
    super(code);
  }
}

function toShareDto(
  share: ConversationShareRecord,
  origin: string,
): ConversationShareDto {
  return {
    conversationId: share.conversationId,
    url: new URL(`/share/${encodeURIComponent(share.token)}`, origin).toString(),
    createdAt: share.createdAt.toISOString(),
  };
}

export async function getConversationShareForOwner(
  ownerId: string,
  conversationId: string,
  origin: string,
): Promise<ConversationShareStatusResponse> {
  const result = await getConversationShareRecordForOwner(ownerId, conversationId);

  if (result.kind === "conversation_not_found") {
    throw new ConversationShareServiceError("CONVERSATION_NOT_FOUND", 404);
  }

  return { share: result.share ? toShareDto(result.share, origin) : null };
}

export async function createConversationShareForOwner(
  ownerId: string,
  conversationId: string,
  origin: string,
  dependencies: {
    createId?: () => string;
    createToken?: () => string;
    now?: () => Date;
  } = {},
): Promise<ConversationShareDto> {
  const result = await createConversationShareRecordForOwner({
    id: (dependencies.createId ?? randomUUID)(),
    token: (dependencies.createToken ?? randomUUID)(),
    ownerId,
    conversationId,
    now: (dependencies.now ?? (() => new Date()))(),
  });

  switch (result.kind) {
    case "created":
    case "existing":
      return toShareDto(result.share, origin);
    case "conversation_not_found":
      throw new ConversationShareServiceError("CONVERSATION_NOT_FOUND", 404);
    case "active_generation":
      throw new ConversationShareServiceError("ACTIVE_GENERATION", 409);
    case "empty_conversation":
      throw new ConversationShareServiceError("EMPTY_CONVERSATION", 409);
  }
}

export async function deleteConversationShareForOwner(
  ownerId: string,
  conversationId: string,
): Promise<DeleteConversationShareResponse> {
  const deleted = await deleteConversationShareRecordForOwner(
    ownerId,
    conversationId,
  );

  if (!deleted) {
    throw new ConversationShareServiceError("CONVERSATION_NOT_FOUND", 404);
  }

  return { conversationId };
}

export const getPublicConversationShare = cache(
  async (token: string): Promise<ConversationShareRecord | null> =>
    getConversationShareRecordByToken(token),
);

export async function readPublicConversationShareAttachment(
  token: string,
  attachmentId: string,
  dependencies: { storage?: Pick<ObjectStorage, "readObject"> } = {},
) {
  const attachment = await getConversationShareAttachmentRecord(
    token,
    attachmentId,
  );

  if (!attachment) {
    return null;
  }

  const storage = dependencies.storage ?? getAttachmentObjectStorage();
  return {
    ...attachment,
    data: await storage.readObject(attachment.objectKey),
  };
}
