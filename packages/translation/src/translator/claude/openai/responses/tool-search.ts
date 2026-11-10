/**
 * Codex client-executed `tool_search` on the Claude Messages API (native tool search).
 *
 * Go source: internal/translator/claude/openai/responses/claude_openai-responses_tool_search.go (58c0f6a2, a68ad134,
 * aeec5e97, 8eed08ef, 97ba1e89) and internal/runtime/executor/helps/responses_tool_search.go (StripResponsesToolSearch,
 * 48ad3487).
 *
 * Codex declares `{"type":"tool_search","execution":"client"}` and keeps deferred tools out of `tools[]`. The model
 * calls it through a `tool_search_call` item, Codex runs the search and replays a `tool_search_output` item whose
 * `tools[]` become callable from then on. Claude has no counterpart, so the declaration becomes an ordinary function
 * tool, the call and output become a `tool_use` / `tool_result` pair, and every tool discovered in history is declared
 * on later requests, with `defer_loading` and referenced through `tool_reference` blocks, which keeps the cached
 * prefix. Anthropic keeps the prompt cache when deferred tools are added, but not (Go's measured finding, not in
 * Anthropic's docs) when a request goes from no deferred tool to one, so a constant deferred anchor is declared from
 * the first request on and discoveries only append after it.
 *
 * Deliberate differences from Go (docs/ARCHITECTURE.md "Native tool search"): the decision is a request-scoped option
 * (`nativeToolSearch`) instead of a process-wide switch plus an executor strip pass. With the option off, the client
 * `tool_search` declarations (named ones too) and every `tool_search_call` / `tool_search_output` item are dropped,
 * which is exactly what Go's strip left for the translator.
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
import { normalizeClaudeToolInputSchema } from "../../../common/claude-util.ts";
import { str } from "../../../common/gjson.ts";
import { sanitizeClaudeToolId } from "../../../common/tool-names.ts";
import {
  appendToolDescriptors,
  type ClaudeToolNames,
  DISCOVERED_TOOL_PRIORITY,
  isClientToolSearchDeclaration,
  type ToolDescriptor,
} from "./tools.ts";

/** The name of the constant deferred tool declared with native tool search; nothing ever references it. */
export const DEFERRED_ANCHOR_NAME = "tool_search_deferred_anchor";

const DEFAULT_SCHEMA = (): JsonObject => ({
  type: "object",
  properties: {
    query: { type: "string", description: "Search query for deferred tools." },
    limit: { type: "number", description: "Maximum number of tools to return." },
  },
  required: ["query"],
  additionalProperties: false,
});

/**
 * The deferred anchor declaration, unless a converted tool already carries its Claude name (names are normalised during
 * conversion, so the check runs on the final `tools[]`). On a clash the request keeps the client's tool and has no
 * anchor.
 */
export const deferredAnchorTool = (toolItems: readonly JsonObject[]): JsonObject | undefined =>
  toolItems.some((tool) => str(tool["name"]) === DEFERRED_ANCHOR_NAME)
    ? undefined
    : {
        name: DEFERRED_ANCHOR_NAME,
        description: "Placeholder that is never loaded; tool search returns the real tools.",
        input_schema: { type: "object", properties: {} },
        defer_loading: true,
      };

/** `convertResponsesToolSearchToolToClaude`: the declared schema, with the `query` field Codex parses guaranteed. */
export const toolSearchToolToClaude = (tool: Json, claudeName: string): JsonObject => {
  const parameters = get(tool, "parameters");
  const schema = normalizeSchema(isJsonObject(parameters) ? parameters : DEFAULT_SCHEMA());
  const properties = isJsonObject(schema["properties"]) ? schema["properties"] : {};

  if (get(properties["query"], "type") !== "string") {
    schema["properties"] = {
      ...properties,
      query: { type: "string", description: "Search query for deferred tools." },
    };
  }

  const required = isJsonArray(schema["required"]) ? schema["required"] : [];

  if (!required.includes("query")) schema["required"] = [...required, "query"];

  const description = asString(get(tool, "description"));

  return {
    name: claudeName,
    description: description !== "" ? description : asString(get(tool, "function.description")),
    input_schema: schema,
  };
};

const normalizeSchema = (schema: Json): JsonObject => {
  const normalized = normalizeClaudeToolInputSchema(schema);

  return isJsonObject(normalized) ? normalized : DEFAULT_SCHEMA();
};

/**
 * `convertResponsesToolSearchCallToClaude`: a client `tool_search_call` as an assistant `tool_use`, with its raw call
 * id. Hosted calls carry no call id and are not converted.
 */
export const toolSearchCallToClaude = (
  item: Json,
  claudeName: string,
): { readonly toolUse: JsonObject; readonly rawCallId: string } | undefined => {
  const rawCallId = asString(get(item, "call_id")).trim();

  if (rawCallId === "" || asString(get(item, "execution")).trim() !== "client") return undefined;
  let input: JsonObject = {};
  let args = get(item, "arguments");

  if (typeof args === "string") args = tryParseJson(args);

  if (isJsonObject(args)) input = args;

  return {
    toolUse: { type: "tool_use", id: sanitizeClaudeToolId(rawCallId), name: claudeName, input },
    rawCallId,
  };
};

const discoveredDescriptors = (item: Json): ToolDescriptor[] => {
  const descriptors: ToolDescriptor[] = [];
  const tools = get(item, "tools");

  if (isJsonArray(tools)) appendToolDescriptors(descriptors, tools, DISCOVERED_TOOL_PRIORITY, true);

  return descriptors;
};

/** `responsesToolSearchOutputText`: the discovered tool names for the model; their definitions are declared in `tools[]`. */
export const toolSearchOutputText = (item: Json, names: ClaudeToolNames): string => {
  const discovered = discoveredDescriptors(item).map((descriptor) =>
    names.claudeName(descriptor.name),
  );

  return discovered.length === 0
    ? "No matching tools were found."
    : `Tools now available to call: ${discovered.join(", ")}.`;
};

/**
 * `responsesToolSearchOutputContent`: the `tool_result` content of a paired `tool_search_output`. It lists a
 * `tool_reference` for each tool that only loads through search, so Claude expands the deferred definition at this
 * point in the conversation. Tools already declared directly need no reference; when none qualify the text summary
 * is used. It is never the server-side `tool_search_tool_result` format, which custom implementations must not use.
 */
export const toolSearchOutputContent = (
  item: Json,
  names: ClaudeToolNames,
  winners: ReadonlyMap<string, ToolDescriptor>,
): Json => {
  const references: JsonObject[] = [];
  const seen = new Set<string>();

  for (const descriptor of discoveredDescriptors(item)) {
    const winner = winners.get(descriptor.name);

    if (
      winner === undefined ||
      winner.sourcePriority !== DISCOVERED_TOOL_PRIORITY ||
      (winner.toolType !== "function" && winner.toolType !== "custom")
    )
      continue;
    const claudeName = names.claudeName(descriptor.name);

    if (seen.has(claudeName)) continue;
    seen.add(claudeName);
    references.push({ type: "tool_reference", tool_name: claudeName });
  }

  return references.length > 0 ? references : toolSearchOutputText(item, names);
};

/** The tools without client `tool_search` declarations, or undefined when there were none. */
const withoutDeclarations = (tools: Json | undefined): Json[] | undefined => {
  if (!isJsonArray(tools)) return undefined;
  const kept = tools.filter((tool) => !isClientToolSearchDeclaration(tool));

  return kept.length === tools.length ? undefined : kept;
};

/**
 * `StripResponsesToolSearch`: the request without client `tool_search` declarations (top level and inside
 * `additional_tools`) and without every `tool_search_call` / `tool_search_output` item. A request that has none is
 * returned as is; otherwise a copy shares its untouched parts.
 */
export const stripClientToolSearch = (root: Json): Json => {
  if (!isJsonObject(root)) return root;
  let changed = false;
  const copy: JsonObject = { ...root };

  const tools = withoutDeclarations(root["tools"]);

  if (tools !== undefined) {
    copy["tools"] = tools;
    changed = true;
  }

  const input = root["input"];

  if (isJsonArray(input)) {
    const items: Json[] = [];
    let inputChanged = false;

    for (const item of input) {
      const type = asString(get(item, "type")).trim();

      if (type === "tool_search_call" || type === "tool_search_output") {
        inputChanged = true;
        continue;
      }

      if (type === "additional_tools" && isJsonObject(item)) {
        const kept = withoutDeclarations(item["tools"]);

        if (kept !== undefined) {
          items.push({ ...item, tools: kept });
          inputChanged = true;
          continue;
        }
      }

      items.push(item);
    }

    if (inputChanged) {
      copy["input"] = items;
      changed = true;
    }
  }

  return changed ? copy : root;
};
