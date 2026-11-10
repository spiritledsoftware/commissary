/**
 * `chunkHasFinishReason` (Go sdk/api/handlers/openai/openai_handlers.go, openAICompatChunkHasFinishReason in
 * internal/runtime/executor/openai_compat_executor.go): some choice of an OpenAI-style chunk carries a non-empty,
 * non-null `finish_reason`. Shared by the OpenAI framer and the OpenAI-compatible reader.
 */
import { get, isJsonArray, tryParseJson } from "@commissary/json";

export const chunkHasFinishReason = (chunk: string): boolean => {
  let text = chunk.trim();

  if (text.startsWith("data:")) text = text.slice(5).trim();
  const choices = get(tryParseJson(text), "choices");

  if (!isJsonArray(choices)) return false;

  return choices.some((choice) => {
    const reason = get(choice, "finish_reason");

    return reason !== undefined && reason !== null && reason !== "";
  });
};
