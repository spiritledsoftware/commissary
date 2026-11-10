/**
 * xAI Responses event post-processing (stream events and the completed response).
 *
 * Go source: internal/runtime/executor/xai_executor_response.go (xaiNormalizeReasoningSummary*, xaiNamespaceRestorer,
 * unwrapXAIDispatcherArguments, restoreXAIClientWebSearchName, xaiInternalXSearchResponseFilter, xaiPatchCompletedOutput).
 * Events are parsed JSON objects, mutated in place. The apply_patch response bridge runs after this pipeline
 * (`helps/apply-patch-responses.ts`), fed with the pre-restoration events for folded dispatchers.
 */
import {
  asInt,
  asString,
  cloneJson,
  get,
  isJsonArray,
  isJsonObject,
  type Json,
  type JsonObject,
  set,
  tryParseJson,
} from "@commissary/json";
import { ensureUsageDetailsInEvent, type OutputItemCollector } from "../codex/output.ts";
import { clientToolKey, type NamespaceRefs, qualifyNamespaceToolName } from "./tools.ts";

const trimmed = (value: Json | undefined, path: string): string =>
  asString(get(value, path)).trim();

// ---------------------------------------------------------------------------------------------------------------
// Reasoning summary normalisation
// ---------------------------------------------------------------------------------------------------------------

/** `xaiNormalizeReasoningSummaryEventName`. */
export const normalizeReasoningEventName = (name: string): string => {
  switch (name) {
    case "response.reasoning_text.delta":
      return "response.reasoning_summary_text.delta";
    case "response.reasoning_text.done":
      return "response.reasoning_summary_part.done";
    default:
      return name;
  }
};

const normalizeSummaryIndex = (event: JsonObject): void => {
  if (event["content_index"] !== undefined && event["summary_index"] === undefined) {
    event["summary_index"] = event["content_index"];
  }

  delete event["content_index"];
};

interface NormalizedSummaryItems {
  readonly items: Json[];
  readonly changed: boolean;
}

const normalizeSummaryItems = (items: ReadonlyArray<Json>): NormalizedSummaryItems => {
  let changed = false;

  const out = items.map((item) => {
    if (!isJsonObject(item) || asString(item["type"]) !== "reasoning_text") return item;
    changed = true;

    return { ...item, type: "summary_text" };
  });

  return { items: out, changed };
};

/** `xaiNormalizeReasoningOutputItem`: reasoning output items carry `summary_text` parts. */
const normalizeReasoningOutputItem = (item: Json): void => {
  if (!isJsonObject(item) || asString(item["type"]) !== "reasoning") return;

  if (isJsonArray(item["summary"])) {
    const normalized = normalizeSummaryItems(item["summary"]);

    if (normalized.changed) item["summary"] = normalized.items;
  }

  const content = item["content"];

  if (!isJsonArray(content)) return;
  const reasoning = content.filter((part) => asString(get(part, "type")) === "reasoning_text");

  if (reasoning.length === 0) return;
  item["summary"] = normalizeSummaryItems(reasoning).items;
  delete item["content"];
};

/** `xaiNormalizeReasoningSummaryData`: xAI reasoning text events become Responses reasoning summary events. */
export const normalizeReasoningSummaryEvent = (event: Json): Json => {
  if (!isJsonObject(event)) return event;

  switch (asString(event["type"])) {
    case "response.reasoning_text.delta":
      event["type"] = "response.reasoning_summary_text.delta";
      normalizeSummaryIndex(event);
      break;
    case "response.reasoning_text.done": {
      event["type"] = "response.reasoning_summary_part.done";
      set(event, "part.type", "summary_text");

      if (event["text"] !== undefined) set(event, "part.text", asString(event["text"]));
      delete event["text"];
      normalizeSummaryIndex(event);
      break;
    }

    case "response.content_part.added":
    case "response.content_part.done":
      if (asString(get(event, "part.type")) === "reasoning_text") {
        event["type"] =
          event["type"] === "response.content_part.added"
            ? "response.reasoning_summary_part.added"
            : "response.reasoning_summary_part.done";
        set(event, "part.type", "summary_text");
        normalizeSummaryIndex(event);
      }

      break;
  }

  if (isJsonObject(event["item"])) normalizeReasoningOutputItem(event["item"]);
  const output = get(event, "response.output");

  if (isJsonArray(output)) for (const item of output) normalizeReasoningOutputItem(item);

  return event;
};

/** `xaiNormalizeReasoningSummaryDataEvents`: `reasoning_text.done` yields a text-done and a part-done event. */
export const normalizeReasoningSummaryEvents = (event: Json): Json[] => {
  if (!isJsonObject(event) || asString(event["type"]) !== "response.reasoning_text.done") {
    return [normalizeReasoningSummaryEvent(event)];
  }

  const textDone = cloneJson(event);
  textDone["type"] = "response.reasoning_summary_text.done";
  normalizeSummaryIndex(textDone);

  return [textDone, normalizeReasoningSummaryEvent(event)];
};

// ---------------------------------------------------------------------------------------------------------------
// Namespace restore
// ---------------------------------------------------------------------------------------------------------------

interface Unwrapped {
  readonly childName: string;
  readonly childArgs: string;
}

/** `unwrapXAIDispatcherArguments`. */
const unwrapDispatcherArguments = (
  rawArgs: string,
  namespaceName: string,
  refs: NamespaceRefs,
): Unwrapped | undefined => {
  const parsed = tryParseJson(rawArgs);

  if (parsed === undefined) return undefined;

  const nameField = get(parsed, "name");

  if (typeof nameField !== "string") return undefined;
  const childName = nameField.trim();

  if (childName === "") return undefined;
  const argsField = get(parsed, "arguments");

  if (namespaceName !== "") {
    const dispatcher = refs.get(namespaceName);

    if (
      dispatcher?.isDispatcher === true &&
      dispatcher.children !== undefined &&
      dispatcher.children.size > 0
    ) {
      // The winning declarations name the children; anything else is not a call through this dispatcher.
      if (!dispatcher.children.has(childName)) return undefined;
    } else {
      const ref = refs.get(qualifyNamespaceToolName(namespaceName, childName));

      if (ref !== undefined && ref.isDispatcher) return undefined;
    }
  } else {
    const isChild = [...refs.values()].some(
      (ref) => ref.isDispatcher && (ref.name === childName || ref.namespace === childName),
    );

    if (!isChild && argsField === undefined) return undefined;
  }

  let childArgs: string;

  if (argsField !== undefined) {
    childArgs = typeof argsField === "string" ? argsField : JSON.stringify(argsField);
  } else {
    const cleaned = isJsonObject(parsed) ? { ...parsed } : {};
    delete cleaned["name"];
    const text = JSON.stringify(cleaned);
    childArgs = text !== "" && text !== "{}" ? text : "{}";
  }

  return { childName, childArgs: childArgs === "" ? "{}" : childArgs };
};

/** `xaiNamespaceRestorer`: undoes the flattening/folding of namespace tools in upstream events. */
export class NamespaceRestorer {
  readonly #dispatcherItemIds = new Map<string, string>();

  constructor(readonly refs: NamespaceRefs) {}

  restore(data: Json): Json {
    if (this.refs.size === 0 || !isJsonObject(data)) return data;

    switch (asString(data["type"])) {
      case "response.output_item.added": {
        const item = data["item"];

        if (asString(get(item, "type")) === "function_call" && isJsonObject(item)) {
          const name = trimmed(item, "name");
          const itemId = trimmed(item, "id");
          const ref = this.refs.get(name);

          if (ref !== undefined && ref.isDispatcher) {
            if (itemId !== "") this.#dispatcherItemIds.set(itemId, ref.namespace);
            item["namespace"] = ref.namespace;
          }
        }

        return data;
      }

      case "response.function_call_arguments.done": {
        const namespaceName = this.#dispatcherItemIds.get(trimmed(data, "item_id"));

        if (namespaceName !== undefined) {
          const unwrapped = unwrapDispatcherArguments(
            asString(data["arguments"]),
            namespaceName,
            this.refs,
          );

          if (unwrapped !== undefined) data["arguments"] = unwrapped.childArgs;
        }

        return data;
      }

      default: {
        this.#restoreItem(data["item"]);
        const output = get(data, "response.output");

        if (isJsonArray(output)) for (const item of output) this.#restoreItem(item);

        return data;
      }
    }
  }

  #restoreItem(item: Json | undefined): void {
    if (!isJsonObject(item) || asString(item["type"]) !== "function_call") return;
    const ref = this.refs.get(trimmed(item, "name"));

    if (ref === undefined) return;

    if (!ref.isDispatcher) {
      item["name"] = ref.name;
      item["namespace"] = ref.namespace;

      return;
    }

    const unwrapped = unwrapDispatcherArguments(
      asString(item["arguments"]),
      ref.namespace,
      this.refs,
    );

    const childName = unwrapped?.childName ?? ref.name;
    item["namespace"] = ref.namespace;

    if (childName !== "") item["name"] = childName;

    if (unwrapped !== undefined && unwrapped.childArgs !== "")
      item["arguments"] = unwrapped.childArgs;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Client function alias
// ---------------------------------------------------------------------------------------------------------------

const restoreAliasIn = (item: Json | undefined, alias: string): void => {
  if (!isJsonObject(item) || trimmed(item, "namespace") !== "") return;

  if (trimmed(item, "name") === alias) item["name"] = "web_search";

  if (trimmed(item, "function.name") === alias) set(item, "function.name", "web_search");
};

/** `restoreXAIClientWebSearchName`: the alias goes back to `web_search` for un-namespaced calls. */
export const restoreClientWebSearchName = (data: Json, alias: string): Json => {
  if (alias === "" || !isJsonObject(data) || !JSON.stringify(data).includes(alias)) return data;
  restoreAliasIn(data["item"], alias);
  const nested = get(data, "response.output");

  if (isJsonArray(nested)) for (const item of nested) restoreAliasIn(item, alias);
  const top = data["output"];

  if (isJsonArray(top)) for (const item of top) restoreAliasIn(item, alias);
  restoreAliasIn(data, alias);

  return data;
};

// ---------------------------------------------------------------------------------------------------------------
// Hidden X Search traces
// ---------------------------------------------------------------------------------------------------------------

const INTERNAL_X_SEARCH_TOOLS = new Set([
  "x_user_search",
  "x_semantic_search",
  "x_keyword_search",
  "x_thread_fetch",
]);

const DECLARED_TOOL_TYPES = new Map([
  ["function_call", "function"],
  ["custom_tool_call", "custom"],
]);

/** `xaiIsInternalXSearchCall`: server-side X Search subtool traces that clients must not execute again. */
const isInternalXSearchCall = (
  item: Json | undefined,
  clientDeclared: ReadonlySet<string>,
): boolean => {
  const itemType = trimmed(item, "type");

  const declaredType = DECLARED_TOOL_TYPES.get(itemType) ?? "";

  if (declaredType === "") return false;
  const name = trimmed(item, "name");

  if (!INTERNAL_X_SEARCH_TOOLS.has(name)) return false;

  if (trimmed(item, "namespace") !== "") return false;

  if (trimmed(item, "call_id").startsWith("xs_call")) return true;

  return !clientDeclared.has(clientToolKey("", name, declaredType));
};

/** `xaiInternalXSearchResponseFilter`. */
export class InternalXSearchFilter {
  readonly #droppedIndexes = new Set<number>();
  readonly #droppedIds = new Set<string>();

  constructor(
    readonly enabled: boolean,
    readonly clientDeclared: ReadonlySet<string>,
  ) {}

  /** The event without internal traces, or `undefined` when the whole event must be dropped. */
  apply(event: Json): Json | undefined {
    if (!this.enabled || !isJsonObject(event)) return event;
    const item = event["item"];

    if (isInternalXSearchCall(item, this.clientDeclared)) {
      if (event["output_index"] !== undefined)
        this.#droppedIndexes.add(asInt(event["output_index"]));

      for (const path of ["id", "call_id"]) {
        const id = trimmed(item, path);

        if (id !== "") this.#droppedIds.add(id);
      }

      return undefined;
    }

    const output = get(event, "response.output");

    if (isJsonArray(output)) {
      const kept = output.filter((entry) => !isInternalXSearchCall(entry, this.clientDeclared));

      if (kept.length !== output.length) set(event, "response.output", kept);
    }

    if (
      event["output_index"] !== undefined &&
      this.#droppedIndexes.has(asInt(event["output_index"]))
    )
      return undefined;

    for (const path of ["item_id", "call_id"]) {
      const id = trimmed(event, path);

      if (id !== "" && this.#droppedIds.has(id)) return undefined;
    }

    if (event["output_index"] !== undefined) {
      const original = asInt(event["output_index"]);
      let removedBefore = 0;

      for (const dropped of this.#droppedIndexes) if (dropped < original) removedBefore++;

      if (removedBefore > 0) event["output_index"] = original - removedBefore;
    }

    return event;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Pipeline and completed-output patching
// ---------------------------------------------------------------------------------------------------------------

export interface EventPipelineInput {
  readonly namespaceTools: NamespaceRefs;
  readonly webSearchAlias: string;
  readonly filterInternalXSearch: boolean;
  readonly clientDeclaredTools: ReadonlySet<string>;
}

/** Namespace restore -> client function alias restore -> hidden X Search filter (per-attempt state). */
export class EventPipeline {
  readonly #restorer: NamespaceRestorer;
  readonly #filter: InternalXSearchFilter;

  constructor(readonly input: EventPipelineInput) {
    this.#restorer = new NamespaceRestorer(input.namespaceTools);
    this.#filter = new InternalXSearchFilter(
      input.filterInternalXSearch,
      input.clientDeclaredTools,
    );
  }

  /** `undefined` = the event was dropped. */
  process(event: Json): Json | undefined {
    let current = this.#restorer.restore(event);

    if (this.input.webSearchAlias !== "")
      current = restoreClientWebSearchName(current, this.input.webSearchAlias);

    return this.#filter.apply(current);
  }
}

/** `xaiPatchCompletedOutput`: usage details plus the output rebuilt from `output_item.done` when it is empty. */
export const patchCompletedOutput = (
  event: JsonObject,
  collector: OutputItemCollector,
): JsonObject => {
  ensureUsageDetailsInEvent(event);
  const output = get(event, "response.output");
  const empty = !isJsonArray(output) || output.length === 0;

  if (!empty || collector.count === 0) return event;
  const indexed = [...collector.byIndex.entries()].toSorted((a, b) => a[0] - b[0]);
  set(event, "response.output", [...indexed.map(([, item]) => item), ...collector.fallback]);

  return event;
};
