/**
 * Responses `tool_search` bridge for Chat Completions: the call item builders.
 *
 * Go source: internal/translator/openai/openai/responses/openai_openai-responses_tool_search.go (toolSearchCallItem,
 * toolSearchCallPlaceholder); upstream 8c9a7851. Chat Completions has no tool search, so a call to the bridged function
 * is restored as a client-executed `tool_search_call` item with object arguments.
 */
import { isJsonObject, type JsonObject, tryParseJson } from "@commissary/json";

const TOOL_SEARCH_ID_PREFIX = "tsc_";

/** `toolSearchCallItem`: a completed call whose arguments are not a JSON object is `incomplete`. */
export const toolSearchCallItem = (callId: string, args: string, status: string): JsonObject => {
  const parsed = tryParseJson(args.trim());
  const valid = isJsonObject(parsed);

  return {
    id: TOOL_SEARCH_ID_PREFIX + callId,
    type: "tool_search_call",
    status: status === "completed" && !valid ? "incomplete" : status,
    execution: "client",
    call_id: callId,
    arguments: valid ? parsed : {},
  };
};

/** `toolSearchCallPlaceholder`. */
export const toolSearchCallPlaceholder = (callId: string): JsonObject => ({
  id: TOOL_SEARCH_ID_PREFIX + callId,
  type: "tool_search_call",
  status: "in_progress",
  execution: "client",
  call_id: callId,
  arguments: {},
});
