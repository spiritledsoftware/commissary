/**
 * Which models need their thought signatures put back by a reasoning-replay ledger.
 *
 * Go source: internal/runtime/executor/antigravity_reasoning_replay.go (`antigravityUsesReasoningReplayCache`), also the gate
 * of the Gemini API and Vertex ledgers (Go cc95661c). Checked on the upstream model after alias, prefix and suffix
 * resolution: Gemini 2.5 and 3 thinking models are in; Claude on Antigravity or Vertex and Imagen are out.
 */
export const usesReasoningReplay = (modelName: string): boolean => {
  const lower = modelName.toLowerCase();

  if (lower.includes("claude")) return false;

  return lower.includes("gemini") || lower.includes("flash") || lower.includes("agent");
};
