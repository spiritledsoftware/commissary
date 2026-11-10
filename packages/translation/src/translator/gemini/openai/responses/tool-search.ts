/**
 * Client-executed Responses `tool_search` on Gemini (and Antigravity, which reuses this translator).
 *
 * Go source: internal/translator/gemini/openai/responses/gemini_openai-responses_tool_search.go (77fd91e8, 90c447d3).
 * Gemini has no native tool search, so the client's search is the function `tool_search`: a replayed
 * `tool_search_call` / `tool_search_output` pair becomes a `function_call` / `function_call_output` pair, and a model
 * call to the shim comes back as a `tool_search_call` item whose id carries the `tsc_` prefix (the one Codex accepts
 * when the conversation moves to a GPT model).
 */
import {
  asString,
  get,
  isJsonArray,
  isJsonObject,
  type Json,
  type JsonObject,
  tryParseJson,
} from "@commissary/json";
import { extractResponsesCallID } from "../../../common/responses.ts";
import {
  isResponsesClientToolSearchItem,
  qualifyResponsesNamespaceToolName,
  RESPONSES_TOOL_SEARCH_CALL_TYPE,
  RESPONSES_TOOL_SEARCH_OUTPUT_TYPE,
} from "../../../common/responses-tools.ts";
import { mapResponsesClientToolSearchName, mapResponsesToolName } from "./tools.ts";

const TOOL_SEARCH_ID_PREFIX = "tsc_";

/** `normalizeOpenAIResponsesToolSearchItems`: replayed client search history as function call items. */
export const normalizeToolSearchItems = (
  items: readonly Json[],
  forwardMap: ReadonlyMap<string, string>,
): Json[] => {
  const normalized: Json[] = [];

  for (const item of items) {
    switch (asString(get(item, "type"))) {
      case RESPONSES_TOOL_SEARCH_CALL_TYPE:
        if (isResponsesClientToolSearchItem(item))
          normalized.push(toolSearchCallAsFunctionCall(item, forwardMap));

        break;
      case RESPONSES_TOOL_SEARCH_OUTPUT_TYPE:
        if (isResponsesClientToolSearchItem(item))
          normalized.push(toolSearchOutputAsFunctionCallOutput(item, forwardMap));

        break;
      default:
        normalized.push(item);
    }
  }

  return normalized;
};

const toolSearchCallAsFunctionCall = (
  item: Json,
  forwardMap: ReadonlyMap<string, string>,
): JsonObject => {
  const call: JsonObject = {
    type: "function_call",
    name: mapResponsesClientToolSearchName(forwardMap),
    call_id: extractResponsesCallID(item),
    arguments: "{}",
  };

  const id = get(item, "id");

  if (id !== undefined) call["id"] = asString(id);
  const status = get(item, "status");

  if (status !== undefined) call["status"] = asString(status);
  const args = get(item, "arguments");

  if (typeof args === "string") call["arguments"] = args;
  else if (isJsonObject(args) || isJsonArray(args)) call["arguments"] = JSON.stringify(args);

  return call;
};

const toolSearchOutputAsFunctionCallOutput = (
  item: Json,
  forwardMap: ReadonlyMap<string, string>,
): JsonObject => {
  const output: JsonObject = {
    type: "function_call_output",
    name: mapResponsesClientToolSearchName(forwardMap),
    call_id: extractResponsesCallID(item),
    output: "",
  };

  const id = get(item, "id");

  if (id !== undefined) output["id"] = asString(id);
  const status = asString(get(item, "status")).trim();
  const summary: JsonObject = { status: status === "" ? "completed" : status };
  summary["tools"] = discoveredToolNames(get(item, "tools"), forwardMap);
  const error = get(item, "error");

  if (error !== undefined && error !== null) summary["error"] = error;
  output["output"] = JSON.stringify(summary);

  return output;
};

const childName = (tool: Json | undefined): string => {
  const name = asString(get(tool, "name")).trim();

  return name === "" ? asString(get(tool, "function.name")).trim() : name;
};

/** `openAIResponsesDiscoveredToolNames`: the Gemini-visible names of the tools a search loaded, deduplicated. */
const discoveredToolNames = (
  tools: Json | undefined,
  forwardMap: ReadonlyMap<string, string>,
): string[] => {
  const names: string[] = [];

  if (!isJsonArray(tools)) return names;
  const seen = new Set<string>();

  const append = (name: string): void => {
    const trimmed = name.trim();

    if (trimmed === "") return;
    const mapped = mapResponsesToolName(forwardMap, trimmed);

    if (seen.has(mapped)) return;
    seen.add(mapped);
    names.push(mapped);
  };

  for (const tool of tools) {
    switch (asString(get(tool, "type")).trim()) {
      case "":
      case "function":
      case "custom":
        append(childName(tool));
        break;
      case "namespace": {
        const namespaceName = asString(get(tool, "name")).trim();
        let children = get(tool, "tools");

        if (!isJsonArray(children)) children = get(tool, "children");

        if (!isJsonArray(children)) break;

        for (const child of children) {
          const name = childName(child);

          if (name !== "") append(qualifyResponsesNamespaceToolName(namespaceName, name));
        }

        break;
      }
    }
  }

  return names;
};

/** `openAIResponsesToolSearchCallStatus`: a completed call whose arguments are not an object is incomplete. */
const toolSearchCallStatus = (status: string, argsJson: string): string => {
  if (status !== "completed") return status;

  return isJsonObject(tryParseJson(argsJson.trim())) ? status : "incomplete";
};

/** `buildOpenAIResponsesToolSearchCallItem`. */
export const buildToolSearchCallItem = (
  id: string,
  callId: string,
  status: string,
  argsJson: string,
): JsonObject => {
  const parsed = tryParseJson(argsJson.trim());

  return {
    id,
    type: RESPONSES_TOOL_SEARCH_CALL_TYPE,
    status: toolSearchCallStatus(status, argsJson),
    execution: "client",
    call_id: callId,
    arguments: isJsonObject(parsed) ? parsed : {},
  };
};

/** `openAIResponsesToolSearchCallItemID`. */
export const toolSearchCallItemId = (callId: string): string => TOOL_SEARCH_ID_PREFIX + callId;
