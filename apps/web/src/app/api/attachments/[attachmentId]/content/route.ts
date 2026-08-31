import { getCurrentSession } from "@/lib/session";
import {
  AttachmentServiceError,
  readAttachmentForOwner,
} from "@/server/attachments";

// 点击文件时重新签名，避免页面久置后打开一个已过期的 PDF 链接。
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ attachmentId: string }> },
) {
  const headers = { "Cache-Control": "private, no-store" };
  const session = await getCurrentSession();
  if (!session)
    return Response.json({ code: "UNAUTHORIZED" }, { status: 401, headers });
  const { attachmentId } = await params;
  try {
    const { download } = await readAttachmentForOwner(
      session.user.id,
      attachmentId,
    );
    return new Response(null, {
      status: 307,
      headers: { ...headers, Location: download.url },
    });
  } catch (error) {
    if (error instanceof AttachmentServiceError) {
      return Response.json(
        { code: error.code },
        { status: error.status, headers },
      );
    }
    throw error;
  }
}
