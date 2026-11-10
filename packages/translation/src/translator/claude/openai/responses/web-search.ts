/**
 * Claude server-side web search <-> Responses `web_search_call` items.
 *
 * Go source: internal/translator/claude/openai/responses/claude_openai-responses_web_search.go.
 *
 * Claude reports server-side search as a `server_tool_use` + `web_search_tool_result` pair; Responses models it as
 * one `web_search_call` item. The pair folds into one item on the way out and expands back on the way in.
 */
import { get, type Json, type JsonObject } from "@commissary/json";
import { isArr, isObj, str } from "../../../common/gjson.ts";

export const CLAUDE_WEB_SEARCH_TOOL_NAME = "web_search";

const RESPONSES_WEB_SEARCH_ID_PREFIX = "ws_";

const CLAUDE_SERVER_TOOL_ID_PREFIX = "srvtoolu_";

export const responsesWebSearchCallID = (claudeToolUseID: string): string =>
  RESPONSES_WEB_SEARCH_ID_PREFIX + claudeToolUseID;

/** Recovers (and normalises to Anthropic's `srvtoolu_…` shape) the server_tool_use id from a Responses item id. */
export const claudeWebSearchToolUseID = (responsesItemID: string): string => {
  let body = responsesItemID.trim();

  if (body.startsWith(RESPONSES_WEB_SEARCH_ID_PREFIX))
    body = body.slice(RESPONSES_WEB_SEARCH_ID_PREFIX.length);

  if (body.startsWith(CLAUDE_SERVER_TOOL_ID_PREFIX))
    body = body.slice(CLAUDE_SERVER_TOOL_ID_PREFIX.length);
  body = body.replace(/[^a-zA-Z0-9_]/gu, "_");

  return body === "" ? "" : CLAUDE_SERVER_TOOL_ID_PREFIX + body;
};

/** Query from a Claude server_tool_use input (accumulated streaming JSON text). */
export const claudeWebSearchQuery = (input: string): string => {
  if (input === "") return "";

  try {
    // SAFETY: JSON.parse can only produce JSON values, which is exactly what Json models.
    return str(get(JSON.parse(input) as Json, "query")).trim();
  } catch {
    return "";
  }
};

/** Content of a `web_search_tool_result` block -> Responses `results` (entries ride through verbatim). */
export const claudeWebSearchResultsToResponses = (content: Json | undefined): Json | undefined => {
  if (isObj(content)) return content;

  if (!isArr(content)) return undefined;

  const results = content.filter(
    (entry) =>
      str(get(entry, "type")) === "web_search_tool_result_error" ||
      str(get(entry, "url")).trim() !== "",
  );

  return results;
};

/** The Responses item standing for one Claude server-side search. */
export const buildResponsesWebSearchCallItem = (
  claudeToolUseID: string,
  query: string,
  results: Json | undefined,
): JsonObject => {
  const item: JsonObject = {
    id: responsesWebSearchCallID(claudeToolUseID),
    type: "web_search_call",
    status: "completed",
    action: { type: "search", query },
  };

  if (results !== undefined) item.results = results;

  return item;
};

/** Inverse of `buildResponsesWebSearchCallItem`: rebuilds the Claude block pair for a replayed turn. */
export const convertResponsesWebSearchCallToClaudeBlocks = (item: Json): JsonObject[] =>
  convertResponsesWebSearchCallToClaudeBlocksWithQuery(item, "", true);

/**
 * Rebuilds the `server_tool_use` block, using `fallbackQuery` when the item carries no query, and the result block
 * only when `withResult` is set.
 */
const convertResponsesWebSearchCallToClaudeBlocksWithQuery = (
  item: Json,
  fallbackQuery: string,
  withResult: boolean,
): JsonObject[] => {
  const toolUseID = claudeWebSearchToolUseID(str(get(item, "id")).trim());

  if (toolUseID === "") return [];
  const input: JsonObject = {};
  let query = responsesWebSearchCallQuery(item);

  if (query === "") query = fallbackQuery;

  if (query !== "") input.query = query;

  const use: JsonObject = {
    type: "server_tool_use",
    id: toolUseID,
    name: CLAUDE_WEB_SEARCH_TOOL_NAME,
    input,
  };

  if (!withResult) return [use];

  const result: JsonObject = {
    type: "web_search_tool_result",
    tool_use_id: toolUseID,
    content: [],
  };

  const content = responsesWebSearchResultsToClaude(get(item, "results"));

  if (content !== undefined) result.content = content;

  return [use, result];
};

const isPausedItem = (item: Json): boolean =>
  str(get(item, "type")) === "web_search_call" &&
  str(get(item, "status")).trim().toLowerCase() === "in_progress" &&
  get(item, "results") === undefined;

/** A user turn or a tool output ends the assistant run a paused search can continue in. */
const isTurnBoundary = (item: Json): boolean => {
  let type = str(get(item, "type"));
  const role = str(get(item, "role"));

  if (type === "" && role !== "") type = "message";

  switch (type) {
    case "message":
      return role !== "assistant";
    case "function_call_output":
    case "custom_tool_call_output":
    case "tool_search_output":
      return true;
    default:
      return false;
  }
};

/**
 * Indexes the `web_search_call` items of one request so a search paused by `pause_turn` replays faithfully
 * (Go `responsesWebSearchHistory`, `aadb34f9`):
 *
 * - while the paused turn is the tail of the history, the search goes back as a `server_tool_use` without a result,
 *   unchanged, as Anthropic requires;
 * - when the continuation delivered the result under the same id within the same assistant run (no user turn or tool
 *   output in between), the paused item is skipped and the continuation item emits the full pair, keeping the query
 *   the paused item recorded.
 *
 * Every other `web_search_call`, repeated ids across separate turns included, keeps its one-pair-per-item replay.
 */
export class ResponsesWebSearchHistory {
  /** `boundaryAfter[i]`: a user turn or a tool output follows index i. */
  private readonly boundaryAfter: boolean[];
  /** Paused items a later continuation item replaces. */
  private readonly skip = new Set<number>();
  /** The paused item's query, carried to its continuation item. */
  private readonly pausedQuery = new Map<number, string>();

  constructor(items: ReadonlyArray<Json>) {
    this.boundaryAfter = items.map(() => false);
    let boundary = false;

    for (let index = items.length - 1; index >= 0; index--) {
      this.boundaryAfter[index] = boundary;

      // SAFETY: `index` is in bounds (loop bound); the cast only drops the `undefined` added by noUncheckedIndexedAccess.
      if (isTurnBoundary(items[index] as Json)) boundary = true;
    }

    items.forEach((item, index) => {
      if (!isPausedItem(item)) return;
      const id = str(get(item, "id")).trim();

      if (id === "") return;

      for (let next = index + 1; next < items.length; next++) {
        // SAFETY: `next < items.length` (loop bound); the cast only drops the `undefined` added by noUncheckedIndexedAccess.
        const candidate = items[next] as Json;

        if (isTurnBoundary(candidate)) break;

        if (
          str(get(candidate, "type")) === "web_search_call" &&
          str(get(candidate, "id")).trim() === id
        ) {
          this.skip.add(index);
          let query = responsesWebSearchCallQuery(item);
          const previous = this.pausedQuery.get(index);

          if (previous !== undefined && query === "") query = previous;
          this.pausedQuery.set(next, query);
          break;
        }
      }
    });
  }

  /** The Claude blocks for the `web_search_call` at `index`. */
  claudeBlocks(index: number, item: Json): JsonObject[] {
    if (this.skip.has(index)) return [];
    const query = this.pausedQuery.get(index) ?? "";
    const tail = index >= this.boundaryAfter.length || this.boundaryAfter[index] !== true;

    return convertResponsesWebSearchCallToClaudeBlocksWithQuery(
      item,
      query,
      !(isPausedItem(item) && tail),
    );
  }
}

const responsesWebSearchCallQuery = (item: Json): string => {
  const query = str(get(item, "action.query")).trim();

  if (query !== "") return query;
  const first = str(get(item, "action.queries.0")).trim();

  if (first !== "") return first;

  return str(get(item, "action.url")).trim();
};

const responsesWebSearchResultsToClaude = (results: Json | undefined): Json | undefined => {
  if (isObj(results)) return results;

  if (!isArr(results)) return undefined;
  const blocks: Json[] = [];

  for (const entry of results) {
    if (str(get(entry, "type")) === "web_search_tool_result_error") {
      blocks.push(entry);
      continue;
    }

    // Anthropic rejects a result without its genuine encrypted_content, so such an entry is unusable.
    if (str(get(entry, "encrypted_content")).trim() === "") continue;
    blocks.push(isObj(entry) ? { ...entry, type: "web_search_result" } : entry);
  }

  return blocks.length === 0 ? undefined : blocks;
};

/** Mirrors Responses `annotations` back onto a Claude text block as `citations` (entries need `encrypted_index`). */
export const attachClaudeCitations = (
  textBlock: JsonObject,
  annotations: Json | undefined,
): JsonObject => {
  if (!isArr(annotations)) return textBlock;

  const citations = annotations.filter(
    (annotation) => str(get(annotation, "encrypted_index")).trim() !== "",
  );

  if (citations.length === 0) return textBlock;
  textBlock.citations = citations;

  return textBlock;
};
