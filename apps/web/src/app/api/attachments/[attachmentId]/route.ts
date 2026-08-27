import {
  attachmentErrorResponseSchema,
  deleteAttachmentResponseSchema,
} from "@ai-chat/contracts";

import { getCurrentSession } from "@/lib/session";
import {
  AttachmentServiceError,
  deleteAttachmentForOwner,
} from "@/server/attachments";

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
