import { queryOptions } from "@tanstack/react-query";

import { readAttachment } from "../../../lib/attachments-client";

export function attachmentQueryOptions(attachmentId: string) {
  return queryOptions({
    queryKey: ["attachment", attachmentId],
    queryFn: ({ signal }) => readAttachment(attachmentId, signal),
    // 签名有效期五分钟；只在内存中缓存，重新进入时可获取新签名。
    staleTime: 4 * 60 * 1000,
    gcTime: 5 * 60 * 1000,
    retry: false,
    refetchOnWindowFocus: false,
  });
}
