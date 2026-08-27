import {
  attachmentErrorResponseSchema,
  completeAttachmentUploadResponseSchema,
} from "@ai-chat/contracts";

import { getCurrentSession } from "@/lib/session";
import {
  AttachmentServiceError,
  completeAttachmentUploadForOwner,
} from "@/server/attachments";

export async function POST(
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
    const attachment = await completeAttachmentUploadForOwner(
      session.user.id,
      attachmentId,
    );

    return Response.json(
      completeAttachmentUploadResponseSchema.parse({ attachment }),
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
