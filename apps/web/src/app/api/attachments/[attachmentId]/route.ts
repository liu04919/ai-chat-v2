import {
  attachmentErrorResponseSchema,
  deleteAttachmentResponseSchema,
  readAttachmentResponseSchema,
} from "@ai-chat/contracts";

import { getCurrentSession } from "@/lib/session";
import {
  AttachmentServiceError,
  deleteAttachmentForOwner,
  readAttachmentForOwner,
} from "@/server/attachments";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ attachmentId: string }> },
) {
  const headers = { "Cache-Control": "private, no-store" };
  const session = await getCurrentSession();
  if (!session) {
    return Response.json({ code: "UNAUTHORIZED" }, { status: 401, headers });
  }
  const { attachmentId } = await params;
  try {
    const result = await readAttachmentForOwner(session.user.id, attachmentId);
    return Response.json(readAttachmentResponseSchema.parse(result), {
      headers,
    });
  } catch (error) {
    if (error instanceof AttachmentServiceError) {
      return Response.json(
        attachmentErrorResponseSchema.parse({ code: error.code }),
        { status: error.status, headers },
      );
    }
    throw error;
  }
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ attachmentId: string }> },
) {
  const session = await getCurrentSession();

  if (!session) {
    return Response.json(
      attachmentErrorResponseSchema.parse({ code: "UNAUTHORIZED" }),
      { status: 401 },
    );
  }

  const { attachmentId } = await params;

  try {
    await deleteAttachmentForOwner(session.user.id, attachmentId);

    return Response.json(
      deleteAttachmentResponseSchema.parse({ attachmentId }),
    );
  } catch (error) {
    if (error instanceof AttachmentServiceError) {
      return Response.json(
        attachmentErrorResponseSchema.parse({ code: error.code }),
        { status: error.status },
      );
    }

    throw error;
  }
}
