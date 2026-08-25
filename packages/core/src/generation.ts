export type GenerationStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export function isActiveGenerationStatus(status: GenerationStatus): boolean {
  return status === "queued" || status === "running";
}
