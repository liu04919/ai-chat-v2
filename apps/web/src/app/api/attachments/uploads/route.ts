import {
  attachmentErrorResponseSchema,
  createAttachmentUploadRequestSchema,
  createAttachmentUploadResponseSchema,
} from "@ai-chat/contracts";

import { getCurrentSession } from "@/lib/session";
import { createAttachmentUploadForOwner } from "@/server/attachments";

export async function POST(request: Request) {
  const session = await getCurrentSession();

  if (!session) {
    return Response.json(
      attachmentErrorResponseSchema.parse({ code: "UNAUTHORIZED" }),
      { status: 401 },
    );
  }

  const body = await request.json().catch(() => null);
  const input = createAttachmentUploadRequestSchema.safeParse(body);

  if (!input.success) {
    return Response.json(
      attachmentErrorResponseSchema.parse({ code: "INVALID_REQUEST" }),
      { status: 400 },
    );
  }

  const response = await createAttachmentUploadForOwner(
    session.user.id,
    input.data,
  );

  return Response.json(createAttachmentUploadResponseSchema.parse(response), {
    status: 201,
  });
}
