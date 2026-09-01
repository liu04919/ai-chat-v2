import {
  regenerateGenerationRequestSchema,
  regenerateGenerationResponseSchema,
  regenerationErrorResponseSchema,
} from "@ai-chat/contracts";

import { getCurrentSession } from "@/lib/session";
import { getGenerationQueueProducer } from "@/server/generation-queue";
import {
  regenerateGenerationForOwner,
  RegenerationServiceError,
} from "@/server/generation-regeneration";

export async function POST(request: Request) {
  const session = await getCurrentSession();

  if (!session) {
    return Response.json(
      regenerationErrorResponseSchema.parse({ code: "UNAUTHORIZED" }),
      { status: 401 },
    );
  }

  const body = await request.json().catch(() => null);
  const input = regenerateGenerationRequestSchema.safeParse(body);

  if (!input.success) {
    return Response.json(
      regenerationErrorResponseSchema.parse({ code: "INVALID_REQUEST" }),
      { status: 400 },
    );
  }

  try {
    const response = await regenerateGenerationForOwner(
      session.user.id,
      input.data,
      { queue: getGenerationQueueProducer() },
    );

    return Response.json(regenerateGenerationResponseSchema.parse(response), {
      status: 201,
    });
  } catch (error) {
    if (error instanceof RegenerationServiceError) {
      return Response.json(
        regenerationErrorResponseSchema.parse(error.response),
        { status: error.status },
      );
    }

    throw error;
  }
}
