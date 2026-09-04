import { conversationShareTokenSchema } from "@ai-chat/contracts";

import { readPublicConversationShareAttachment } from "@/server/conversation-shares";

export async function GET(
  _request: Request,
  {
    params,
  }: { params: Promise<{ token: string; attachmentId: string }> },
) {
  const { token, attachmentId } = await params;
  if (!conversationShareTokenSchema.safeParse(token).success || !attachmentId) {
    return new Response(null, { status: 404 });
  }

  const attachment = await readPublicConversationShareAttachment(
    token,
    attachmentId,
  );
  if (!attachment) {
    return new Response(null, { status: 404 });
  }

  const encodedName = encodeURIComponent(attachment.originalName);
  return new Response(Uint8Array.from(attachment.data).buffer, {
    headers: {
      "Cache-Control": "private, no-store",
      "Content-Disposition": `inline; filename*=UTF-8''${encodedName}`,
      "Content-Type": attachment.mediaType,
      "X-Content-Type-Options": "nosniff",
    },
  });
}
