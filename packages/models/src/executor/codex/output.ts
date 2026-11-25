/**
 * Codex stream/response output helpers.
 *
 * Go source: internal/runtime/executor/codex_executor_terminal.go (collectCodexOutputItemDone,
 * patchCodexCompletedOutput, hydrateCodexCompletedOutputItemIDs), helps/codex_terminal_incomplete.go,
 * helps/usage_helpers.go (ParseCodexUsage, ParseCodexImageToolUsage), helps/responses_usage_helpers.go
 * (EnsureResponsesUsageDetails), codex_websockets_errors.go (normalizeCodexWebsocketCompletion).
 */
import {
  asInt,
  asString,
  get,
  isJsonArray,
  isJsonObject,
  type Json,
  type JsonObject,
  set,
  tryParseJson,
} from "@commissary/json";
import {
  emptyUsageDetail,
  hasUsageFields,
  parseOpenAIUsageNode,
  responseServiceTier,
  type UsageDetail,
} from "../../usage/record.ts";

/** Completed output items seen on `response.output_item.done`, by `output_index` or in arrival order. */
export class OutputItemCollector {
  readonly byIndex = new Map<number, Json>();
  readonly fallback: Json[] = [];

  /** `collectCodexOutputItemDone`. */
  collect(event: Json | undefined): void {
    const item = get(event, "item");

    if (!isJsonObject(item) && !isJsonArray(item)) return;
    const outputIndex = get(event, "output_index");

    if (outputIndex !== undefined) this.byIndex.set(asInt(outputIndex), item);
    else this.fallback.push(item);
  }

  get count(): number {
    return this.byIndex.size + this.fallback.length;
  }
}

const hasUsableId = (id: Json | undefined): boolean =>
  id !== undefined && id !== null && (typeof id !== "string" || id.trim() !== "");

/** `hydrateCodexCompletedOutputItemIDs`: fills empty output item ids from the completed items. */
const hydrateOutputItemIds = (
  event: JsonObject,
  outputItems: Json[],
  collector: OutputItemCollector,
): void => {
  outputItems.forEach((outputItem, index) => {
    if (hasUsableId(get(outputItem, "id"))) return;
    const completed = collector.byIndex.get(index);

    if (completed === undefined) return;
    const completedId = get(completed, "id");

    if (typeof completedId !== "string" || completedId.trim() === "") return;
    set(event, `response.output.${index}.id`, completedId);
  });
};

/** `patchCodexCompletedOutput`: rebuilds an empty `response.output` from the collected items (in place). */
export const patchCodexCompletedOutput = (
  event: JsonObject,
  collector: OutputItemCollector,
): void => {
  const output = get(event, "response.output");

  if (isJsonArray(output) && output.length > 0) {
    hydrateOutputItemIds(event, output, collector);

    return;
  }

  if (collector.count === 0) return;
  const indexed = [...collector.byIndex.entries()].toSorted((a, b) => a[0] - b[0]);

  const items = [...indexed.map(([, item]) => item), ...collector.fallback];

  set(event, "response.output", items);
};

/** `normalizeCodexWebsocketCompletion`: `response.done` is reported as `response.completed`. */
export const normalizeCodexCompletion = (event: JsonObject): JsonObject => {
  if (asString(event["type"]).trim() === "response.done") event["type"] = "response.completed";

  return event;
};

/** `HasMeaningfulCodexOutputDelta`. */
export const hasMeaningfulOutputDelta = (event: Json | undefined): boolean => {
  switch (asString(get(event, "type"))) {
    case "response.output_text.delta":
    case "response.refusal.delta":
    case "response.reasoning_text.delta":
    case "response.reasoning_summary_text.delta":
    case "response.function_call_arguments.delta": {
      const delta = get(event, "delta");

      return delta !== undefined && asString(delta).trim().length > 0;
    }

    default:
      return false;
  }
};

/** `IsCodexTerminalEmptyIncomplete`: a silent upstream abort with explicitly zero output tokens and no content. */
export const isTerminalEmptyIncomplete = (
  event: Json | undefined,
  outputItemsCount: number,
  sawOutputDelta: boolean,
): boolean => {
  if (asString(get(event, "type")) !== "response.incomplete") return false;

  if (sawOutputDelta || outputItemsCount > 0) return false;
  const output = get(event, "response.output");

  if (isJsonArray(output) && output.length > 0) return false;

  // Require an explicit numeric zero (reject floats like 0.5, non-numbers, missing or null).
  return get(event, "response.usage.output_tokens") === 0;
};

/** `ParseCodexUsage`: the usage of a terminal event (`undefined` without tokens or service tier). */
export const parseCodexUsage = (event: Json | undefined): UsageDetail | undefined => {
  const tier = responseServiceTier(event);
  const node = get(event, "response.usage");

  if (!hasUsageFields(node))
    return tier === undefined ? undefined : { ...emptyUsageDetail, responseServiceTier: tier };
  const detail = parseOpenAIUsageNode(node);

  return tier === undefined ? detail : { ...detail, responseServiceTier: tier };
};

/** `ParseCodexImageToolUsage`. */
export const parseCodexImageToolUsage = (event: Json | undefined): UsageDetail | undefined => {
  const node = get(event, "response.tool_usage.image_gen");

  return hasUsageFields(node) ? parseOpenAIUsageNode(node) : undefined;
};

/** `codexImageGenerationToolModel`: the model of the request's `image_generation` tool (default `gpt-image-2`). */
export const codexImageGenerationToolModel = (body: Json | undefined): string => {
  const tools = get(body, "tools");

  if (isJsonArray(tools)) {
    for (const tool of tools) {
      if (asString(get(tool, "type")) !== "image_generation") continue;
      const model = asString(get(tool, "model")).trim();

      if (model !== "") return model;
      break;
    }
  }

  return "gpt-image-2";
};

/** `publishCodexImageToolUsage`: the image tool's own token usage becomes an additional usage record. */
export const publishCodexImageToolUsage = (
  usage: { readonly publishAdditionalModel: (model: string, detail: UsageDetail) => void },
  body: Json | undefined,
  completed: Json | undefined,
): void => {
  const detail = parseCodexImageToolUsage(completed);

  if (detail !== undefined)
    usage.publishAdditionalModel(codexImageGenerationToolModel(body), detail);
};

// ---------------------------------------------------------------------------------------------------------------
// Responses usage details
// ---------------------------------------------------------------------------------------------------------------

const ensureUsageDetailsAt = (root: JsonObject, path: string): boolean => {
  const usage = get(root, path);

  if (!isJsonObject(usage)) return false;
  let changed = false;
  const outputDetails = get(usage, "output_tokens_details");

  if (outputDetails === undefined) {
    set(root, `${path}.output_tokens_details.reasoning_tokens`, 0);
    changed = true;
  } else if (!isJsonObject(outputDetails)) {
    set(root, `${path}.output_tokens_details`, { reasoning_tokens: 0 });
    changed = true;
  } else if (
    outputDetails["reasoning_tokens"] === undefined ||
    outputDetails["reasoning_tokens"] === null
  ) {
    outputDetails["reasoning_tokens"] = 0;
    changed = true;
  }

  const inputDetails = get(usage, "input_tokens_details");

  if (inputDetails === undefined) {
    set(root, `${path}.input_tokens_details.cached_tokens`, 0);
    changed = true;
  } else if (!isJsonObject(inputDetails)) {
    set(root, `${path}.input_tokens_details`, { cached_tokens: 0 });
    changed = true;
  } else if (
    inputDetails["cached_tokens"] === undefined ||
    inputDetails["cached_tokens"] === null
  ) {
    inputDetails["cached_tokens"] = 0;
    changed = true;
  }

  return changed;
};

/** Fills the token detail objects of the Responses usage in a terminal event (in place). */
export const ensureUsageDetailsInEvent = (event: JsonObject): void => {
  ensureUsageDetailsAt(event, "response.usage");
  ensureUsageDetailsAt(event, "usage");
};

const ensureDetailsInJson = (text: string): string | undefined => {
  const parsed = tryParseJson(text);

  if (!isJsonObject(parsed) || asString(parsed["object"]) === "response.compaction")
    return undefined;
  const a = ensureUsageDetailsAt(parsed, "response.usage");
  const b = ensureUsageDetailsAt(parsed, "usage");

  return a || b ? JSON.stringify(parsed) : undefined;
};

/** `EnsureResponsesUsageDetails`: Responses usage objects always carry the token detail objects. */
export const ensureResponsesUsageDetails = (payload: string): string => {
  const trimmed = payload.trim();

  if (trimmed === "") return payload;

  if (trimmed.startsWith("{")) return ensureDetailsInJson(trimmed) ?? payload;

  if (!payload.includes("data:")) return payload;
  let modified = false;

  const lines = payload.split("\n").map((line) => {
    if (!line.trim().startsWith("data:")) return line;
    const prefixLength = line.startsWith("data: ") ? "data: ".length : "data:".length;
    const data = line.slice(prefixLength).trim();

    if (!data.startsWith("{")) return line;
    const updated = ensureDetailsInJson(data);

    if (updated === undefined) return line;
    modified = true;

    return line.slice(0, prefixLength) + updated;
  });

  return modified ? lines.join("\n") : payload;
};
