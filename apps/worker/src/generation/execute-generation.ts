import { claimGenerationExecution } from "@ai-chat/db";

import {
  executeChatGeneration,
  type ExecuteChatGenerationDependencies,
} from "./execute-chat-generation";
import {
  executeImageGeneration,
  type ExecuteImageGenerationDependencies,
} from "./execute-image-generation";

export type ExecuteGenerationDependencies = ExecuteChatGenerationDependencies &
  ExecuteImageGenerationDependencies;

export async function executeGeneration(
  generationId: string,
  dependencies: ExecuteGenerationDependencies,
) {
  const claim = await claimGenerationExecution(
    generationId,
    (dependencies.now ?? (() => new Date()))(),
  );
  if (claim.kind === "not_queued") {
    return { kind: "skipped" } as const;
  }

  return claim.execution.mode === "chat"
    ? executeChatGeneration(claim.execution, dependencies)
    : executeImageGeneration(claim.execution, dependencies);
}
