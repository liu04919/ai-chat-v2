import {
  createGenerationRequestSchema,
  createGenerationResponseSchema,
  generationErrorResponseSchema,
} from "@ai-chat/contracts";

import { getCurrentSession } from "@/lib/session";
import { getGenerationQueueProducer } from "@/server/generation-queue";
import {
  createGenerationForOwner,
  GenerationServiceError,
} from "@/server/generations";

export async function POST(request: Request) {
  const session = await getCurrentSession();

  if (!session) {
    return Response.json(
      generationErrorResponseSchema.parse({ code: "UNAUTHORIZED" }),
      { status: 401 },
    );
  }

  const body = await request.json().catch(() => null);
  const input = createGenerationRequestSchema.safeParse(body);

  if (!input.success) {
    return Response.json(
      generationErrorResponseSchema.parse({ code: "INVALID_REQUEST" }),
      { status: 400 },
    );
  }

  try {
    const response = await createGenerationForOwner(
      session.user.id,
      input.data,
      { queue: getGenerationQueueProducer() },
    );

    return Response.json(createGenerationResponseSchema.parse(response), {
      status: 201,
    });
  } catch (error) {
    if (error instanceof GenerationServiceError) {
      return Response.json(
        generationErrorResponseSchema.parse(error.response),
        { status: error.status },
      );
    }

    throw error;
  }
}
