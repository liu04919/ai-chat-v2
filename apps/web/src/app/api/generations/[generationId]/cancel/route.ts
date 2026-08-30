import {
  cancelGenerationErrorResponseSchema,
  cancelGenerationResponseSchema,
} from "@ai-chat/contracts";

import { getCurrentSession } from "@/lib/session";
import {
  cancelGenerationForOwner,
  GenerationCancellationServiceError,
} from "@/server/generation-cancellation";
import { getGenerationCancellationInfrastructure } from "@/server/generation-cancellation-infrastructure";

export const runtime = "nodejs";

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ generationId: string }> },
) {
  const session = await getCurrentSession();

  if (!session) {
    return Response.json(
      cancelGenerationErrorResponseSchema.parse({ code: "UNAUTHORIZED" }),
      { status: 401 },
    );
  }

  const { generationId } = await params;

  try {
    const response = await cancelGenerationForOwner(
      session.user.id,
      generationId,
      getGenerationCancellationInfrastructure(),
    );

    return Response.json(cancelGenerationResponseSchema.parse(response));
  } catch (error) {
    if (error instanceof GenerationCancellationServiceError) {
      return Response.json(
        cancelGenerationErrorResponseSchema.parse(error.response),
        { status: error.status },
      );
    }

    throw error;
  }
}
