/**
 * Interactions upstream -> OpenAI Responses client (response), including the `apply_patch` custom-tool identity bridge.
 *
 * Go source: internal/translator/openai/interactions/responses/interactions_openai_responses_response.go
 * (ConvertInteractionsResponseToOpenAIResponses and its non-stream variant).
 *
 * Differences from Go:
 *  - Errors are carried as messages (`string`); the retained tool-input failure is mirrored into the registry state.
 *  - `state.canFinalize` stays false (no synthetic completion on EOF); `state.finalizeToolInput` (Go `FinalizeToolInput`)
 *    turns a patch-enabled stream that ends without its source terminator into `response.failed`.
 *  - gjson's lazy reading of malformed event JSON is approximated by recovering the longest valid prefix of the
 *    object's top-level members (truncated payloads); other malformations are ignored.
 */
import {
  asInt,
  get,
  isJsonObject,
  type Json,
  type JsonObject,
  set,
  isValidJson,
} from "@commissary/json";
import { sseEvent } from "../../../../sse.ts";
import type { ResponseContext, ResponseTransform } from "../../../registry.ts";
import {
  antigravityToolNameToUpstream,
  antigravityUpstreamToolNameToClient,
} from "../../common/antigravity-tools.ts";
import {
  ApplyPatchCallState,
  applyPatchFailure,
  applyPatchInputDelta,
  applyPatchInputDone,
  isApplyPatchCustomTool,
} from "../../../common/apply-patch.ts";
import { requestModelNameOf } from "../../../common/request.ts";
import { eachEntry, getStr, isObj } from "../../common/read.ts";
import { interactionsUsage } from "../../../common/interactions-usage.ts";
import {
  type ResponsesToolIdentity,
  collectResponsesToolWinners,
  unwrapResponsesCustomToolInput,
} from "../../../common/responses-tools.ts";
import { setResponsesToolCallIdentity } from "../../../common/responses.ts";
import {
  firstExisting,
  firstNonEmpty,
  interactionsContentPartToResponses,
  interactionsContentTexts,
  interactionsFunctionCallToResponses,
  interactionsReasoningEncryptedContent,
  interactionsThoughtSignature,
  isAntigravityModel,
  jsonStringValue,
  parseJson,
  ssePayloadOf,
} from "./shared.ts";

interface CallState {
  id: string;
  callId: string;
  itemIdSeen: boolean;
  callIdSeen: boolean;
  initialArguments: string;
  rawName: string;
  added: boolean;
  patchCall?: ApplyPatchCallState;
  pendingError?: string;
  snapshotArguments: string;
  snapshotInput: string;
  hasSnapshot: boolean;
  name: string;
  namespace: string;
  isCustom: boolean;
  arguments: string;
  argumentFragments: string[];
  sourceStopped: boolean;
  stopPending: boolean;
  identityFinalized: boolean;
  argumentsDoneEmitted: boolean;
  itemDoneEmitted: boolean;
}

const newCall = (init: Partial<CallState> = {}): CallState => ({
  id: "",
  callId: "",
  itemIdSeen: false,
  callIdSeen: false,
  initialArguments: "",
  rawName: "",
  added: false,
  snapshotArguments: "",
  snapshotInput: "",
  hasSnapshot: false,
  name: "",
  namespace: "",
  isCustom: false,
  arguments: "",
  argumentFragments: [],
  sourceStopped: false,
  stopPending: false,
  identityFinalized: false,
  argumentsDoneEmitted: false,
  itemDoneEmitted: false,
  ...init,
});

interface State {
  id: string;
  /** Per-response prefix of the generated fallback item ids, so ids do not collide across responses (b0db5448). */
  itemIdPrefix: string;
  environmentId: string;
  functionCalls: Map<number, CallState>;
  itemIds: Map<number, string>;
  itemTypes: Map<number, string>;
  reasoningEncrypted: Map<number, string>;
  reasoningSummaries: Map<number, string[]>;
  textOutputs: Map<number, string>;
  seq: number;
  done: boolean;
  terminal: boolean;
  sourceFailed: boolean;
  toolIdentityMap: Map<string, ResponsesToolIdentity>;
  pendingEnvelopeError?: string;
  pendingIdentityErrors: Map<number, string>;
  itemIdentityIndexes: Map<string, number>;
  callIdentityIndexes: Map<string, number>;
  forAntigravity: boolean;
  toolInputError?: string;
  identityMapReady: boolean;
}

/** `interactionsFallbackItemID`. */
const fallbackItemId = (st: State, index: number): string => `item_${st.itemIdPrefix}_${index}`;

const newState = (): State => ({
  id: "",
  itemIdPrefix: crypto.randomUUID(),
  environmentId: "",
  functionCalls: new Map(),
  itemIds: new Map(),
  itemTypes: new Map(),
  reasoningEncrypted: new Map(),
  reasoningSummaries: new Map(),
  textOutputs: new Map(),
  seq: 0,
  done: false,
  terminal: false,
  sourceFailed: false,
  toolIdentityMap: new Map(),
  pendingIdentityErrors: new Map(),
  itemIdentityIndexes: new Map(),
  callIdentityIndexes: new Map(),
  forAntigravity: false,
  identityMapReady: false,
});

const nextSeq = (st: State): number => ++st.seq;

const emit = (event: string, payload: Json): string => sseEvent(event, JSON.stringify(payload));

const withSeq = (st: State, payload: JsonObject): JsonObject => {
  payload.sequence_number = nextSeq(st);

  return payload;
};

const isPatch = (st: State, name: string): boolean =>
  st.toolIdentityMap.get(name)?.applyPatch === true;

const hasPatchBridge = (st: State): boolean => {
  for (const identity of st.toolIdentityMap.values()) if (identity.applyPatch) return true;

  return false;
};

/** `interactionsToolIdentityMap`: Interactions uses qualified names directly. */
const toolIdentityMapOf = (
  requestBody: Json | undefined,
  forAntigravity: boolean,
): Map<string, ResponsesToolIdentity> => {
  let root = requestBody;
  const request = get(root, "request");

  if (request !== undefined) root = request;
  const identities = new Map<string, ResponsesToolIdentity>();

  for (const [rawName, descriptor] of collectResponsesToolWinners(root)) {
    const name = forAntigravity ? antigravityToolNameToUpstream(rawName) : rawName;
    identities.set(name, {
      name: descriptor.localName,
      namespace: descriptor.namespace,
      custom: descriptor.toolType === "custom",
      applyPatch: isApplyPatchCustomTool(descriptor.tool),
    });
  }

  return identities;
};

const responseModel = (modelName: string, root: Json | undefined): string =>
  firstNonEmpty(
    modelName,
    getStr(root, "model"),
    getStr(root, "response.model"),
    getStr(root, "interaction.model"),
  );

const firstUsageInt = (root: Json | undefined, ...paths: string[]): number | undefined => {
  for (const path of paths) {
    const value = get(root, path);

    if (value !== undefined) return asInt(value);
  }

  return undefined;
};

/** `setResponsesUsageFromInteractions`. */
const setUsageFromInteractions = (
  out: JsonObject,
  path: string,
  usage: Json | undefined,
): JsonObject => {
  let inputTokens = 0;
  let outputTokens = 0;
  let totalTokens = 0;

  if (usage !== undefined) {
    inputTokens = firstUsageInt(usage, "input_tokens", "total_input_tokens") ?? 0;
    outputTokens = firstUsageInt(usage, "output_tokens", "total_output_tokens") ?? 0;
    totalTokens = firstUsageInt(usage, "total_tokens") ?? inputTokens + outputTokens;
  }

  set(out, `${path}.input_tokens`, inputTokens);
  set(out, `${path}.output_tokens`, outputTokens);
  set(out, `${path}.total_tokens`, totalTokens);

  if (usage !== undefined) {
    const cached = firstUsageInt(usage, "cached_tokens", "total_cached_tokens");

    if (cached !== undefined) set(out, `${path}.input_tokens_details.cached_tokens`, cached);
    const reasoning = firstUsageInt(usage, "reasoning_tokens", "total_thought_tokens");

    if (reasoning !== undefined)
      set(out, `${path}.output_tokens_details.reasoning_tokens`, reasoning);
  }

  return out;
};

const callArguments = (call: CallState | undefined): string =>
  call === undefined || call.arguments === "" ? "{}" : call.arguments;

// ---------------------------------------------------------------------------------------------------------------------
// Failure and patch helpers
// ---------------------------------------------------------------------------------------------------------------------

const patchFailure = (st: State, error: string): string[] => {
  if (st.terminal) return [];
  st.toolInputError = error;
  st.terminal = true;

  return [emit("response.failed", applyPatchFailure(st.id, nextSeq(st)))];
};

const patchDelta = (st: State, call: CallState, delta: string): string[] => {
  if (delta === "" || call.patchCall === undefined) return [];

  return [
    emit(
      "response.custom_tool_call_input.delta",
      applyPatchInputDelta(call.patchCall, delta, nextSeq(st)),
    ),
  ];
};

/** A throwaway decoder that validates a complete `{"input":"..."}` argument text. */
const finishWhole = (
  argumentsText: string,
): { readonly input: string } | { readonly error: string } => {
  const finished = new ApplyPatchCallState("", "", "", "", 0).finishArguments(argumentsText);

  return "error" in finished ? finished : { input: finished.input };
};

// ---------------------------------------------------------------------------------------------------------------------
// Step identity
// ---------------------------------------------------------------------------------------------------------------------

interface ResolvedStepIndex {
  readonly index: number;
  readonly error?: string;
}

/** Reconciles every supplied index and ID before snapshot types are inspected (`interactionsResolveStepIndex`). */
const resolveStepIndex = (
  explicitIndex: Json | undefined,
  step: Json | undefined,
  fallback: number,
  st: State,
): ResolvedStepIndex => {
  const stepIndex = get(step, "index");
  let index = fallback;
  const indexed = explicitIndex !== undefined || stepIndex !== undefined;

  if (explicitIndex !== undefined) index = asInt(explicitIndex);
  else if (stepIndex !== undefined) index = asInt(stepIndex);
  const itemId = getStr(step, "id");
  const callId = getStr(step, "call_id");
  const matched = new Set<number>();

  if (itemId !== "") {
    const found = st.itemIdentityIndexes.get(itemId);

    if (found !== undefined) matched.add(found);
  }

  if (callId !== "") {
    const found = st.callIdentityIndexes.get(callId);

    if (found !== undefined) matched.add(found);
  }

  if (!indexed && matched.size > 0) {
    // The fallback array position is not evidence when a supplied alias matches.
    let first = true;

    for (const callIndex of matched) {
      if (first || callIndex < index) {
        index = callIndex;
        first = false;
      }
    }
  }

  for (const [callIndex, call] of st.functionCalls) {
    if (
      (itemId !== "" && (call.itemIdSeen || call.added) && itemId === call.id) ||
      (callId !== "" && (call.callIdSeen || call.added) && callId === call.callId)
    ) {
      if (!indexed && (matched.size === 0 || callIndex < index)) index = callIndex;
      matched.add(callIndex);
    }
  }

  if (!indexed && matched.size === 0) {
    let found = false;

    for (const [itemIndex, id] of st.itemIds) {
      if (itemId !== "" && itemId === id && (!found || itemIndex < index)) {
        index = itemIndex;
        found = true;
      }
    }

    // A final array position must not rebind an unrelated item with a different supplied ID.
    if (!found && (itemId !== "" || callId !== "")) {
      while (st.functionCalls.get(index) !== undefined || (st.itemTypes.get(index) ?? "") !== "")
        index++;
    }
  }

  const related = new Set<number>([index]);

  if (explicitIndex !== undefined) related.add(asInt(explicitIndex));

  if (stepIndex !== undefined) related.add(asInt(stepIndex));

  let conflict =
    matched.size > 1 ||
    (explicitIndex !== undefined &&
      stepIndex !== undefined &&
      asInt(explicitIndex) !== asInt(stepIndex));

  for (const callIndex of matched) {
    related.add(callIndex);

    if (
      (explicitIndex !== undefined && asInt(explicitIndex) !== callIndex) ||
      (stepIndex !== undefined && asInt(stepIndex) !== callIndex)
    ) {
      conflict = true;
    }
  }

  let patchRelated = isPatch(st, getStr(step, "name"));

  for (const callIndex of related) {
    const call = st.functionCalls.get(callIndex);

    if (call === undefined) continue;
    patchRelated = patchRelated || call.patchCall !== undefined || isPatch(st, call.rawName);

    if (
      (itemId !== "" && call.itemIdSeen && itemId !== call.id) ||
      (callId !== "" && call.callIdSeen && callId !== call.callId)
    ) {
      conflict = true;
    }
  }

  if (conflict) {
    const errIdentity = "conflicting Interactions apply_patch step identity";

    // Retain both sides even when an unnamed non-function snapshot is skipped.
    for (const callIndex of related) {
      if (!st.pendingIdentityErrors.has(callIndex))
        st.pendingIdentityErrors.set(callIndex, errIdentity);
      const call = st.functionCalls.get(callIndex);

      if (call !== undefined && call.pendingError === undefined) call.pendingError = errIdentity;
    }
  }

  // Keep unmatched aliases even on conflicts, so later provenance through any key cannot erase the contradiction.
  if (itemId !== "" && !st.itemIdentityIndexes.has(itemId))
    st.itemIdentityIndexes.set(itemId, index);

  if (callId !== "" && !st.callIdentityIndexes.has(callId))
    st.callIdentityIndexes.set(callId, index);

  if (patchRelated) {
    for (const callIndex of related) {
      const errIdentity = st.pendingIdentityErrors.get(callIndex);

      if (errIdentity !== undefined) return { index, error: errIdentity };
    }
  }

  // Ordinary functions retain their explicit-index behaviour; only patch identities fail closed.
  return { index };
};

// ---------------------------------------------------------------------------------------------------------------------
// Function-call events
// ---------------------------------------------------------------------------------------------------------------------

const argumentsDeltaEvent = (index: number, itemId: string, args: string, st: State): string =>
  emit(
    "response.function_call_arguments.delta",
    withSeq(st, {
      type: "response.function_call_arguments.delta",
      output_index: index,
      item_id: itemId,
      delta: args,
    }),
  );

const argumentsDoneEvent = (index: number, itemId: string, args: string, st: State): string =>
  emit(
    "response.function_call_arguments.done",
    withSeq(st, {
      type: "response.function_call_arguments.done",
      output_index: index,
      item_id: itemId,
      arguments: args,
    }),
  );

const customInputDoneEvent = (index: number, itemId: string, input: string, st: State): string =>
  emit(
    "response.custom_tool_call_input.done",
    withSeq(st, {
      type: "response.custom_tool_call_input.done",
      output_index: index,
      item_id: itemId,
      input,
    }),
  );

/** Keeps evidence even before the upstream name identifies the winning declaration (`interactionsUpdateFunctionCall`). */
const updateFunctionCall = (
  index: number,
  step: Json | undefined,
  st: State,
  initial: boolean,
): string[] => {
  let call = st.functionCalls.get(index);

  if (call === undefined) {
    call = newCall();
    st.functionCalls.set(index, call);
  }

  const target = call;

  const recordError = (error: string): void => {
    if (target.pendingError === undefined) target.pendingError = error;
  };

  const stepType = get(step, "type");

  if (stepType !== undefined && getStr(step, "type") !== "function_call")
    recordError("conflicting apply_patch item type");

  const mergeId = (
    field: "id" | "callId",
    seenField: "itemIdSeen" | "callIdSeen",
    value: string,
  ): void => {
    if (value === "") return;

    if (
      (target[seenField] || (target.added && !isPatch(st, target.rawName))) &&
      target[field] !== value
    ) {
      recordError("conflicting apply_patch call identity");

      return;
    }

    target[field] = value;
    target[seenField] = true;
  };

  mergeId("id", "itemIdSeen", getStr(step, "id"));
  mergeId("callId", "callIdSeen", getStr(step, "call_id"));
  const stepName = getStr(step, "name");

  if (stepName !== "") {
    if (call.rawName !== "" && call.rawName !== stepName)
      recordError("conflicting apply_patch call name");
    else call.rawName = stepName;
  }

  if (call.pendingError !== undefined && isPatch(st, getStr(step, "name")))
    return patchFailure(st, call.pendingError);
  const args = get(step, "arguments");

  if (
    args !== undefined &&
    !(
      initial &&
      !call.hasSnapshot &&
      call.arguments === "" &&
      !call.itemDoneEmitted &&
      jsonStringValue(args, "").trim() === "{}"
    )
  ) {
    const argumentsText = jsonStringValue(args, "{}");

    // A later complete snapshot is not a new prefix for already buffered fragments.
    if (!call.added && call.initialArguments === "" && call.arguments === "")
      call.initialArguments = argumentsText;
    const snapshot = finishWhole(argumentsText);

    if ("error" in snapshot) {
      recordError(snapshot.error);
    } else {
      if (call.hasSnapshot && snapshot.input !== call.snapshotInput)
        recordError("conflicting apply_patch full snapshots");

      if (
        call.patchCall !== undefined &&
        call.itemDoneEmitted &&
        snapshot.input !== call.patchCall.decoder.input()
      ) {
        recordError("apply_patch snapshot conflicts with completed input");
      }

      call.hasSnapshot = true;
      call.snapshotInput = snapshot.input;
      call.snapshotArguments = argumentsText;
    }
  }

  st.itemIds.set(index, call.id);
  st.itemTypes.set(index, "function_call");

  if (call.rawName === "") return [];
  const identity = st.toolIdentityMap.get(call.rawName);

  if (identity !== undefined) {
    call.name = identity.name;
    call.namespace = identity.namespace;
    call.isCustom = identity.custom;
  } else {
    call.name = st.forAntigravity
      ? antigravityUpstreamToolNameToClient(call.rawName)
      : call.rawName;
  }

  const patch = identity?.applyPatch === true;

  if (patch) {
    if (st.pendingEnvelopeError !== undefined) return patchFailure(st, st.pendingEnvelopeError);

    if (call.pendingError !== undefined) return patchFailure(st, call.pendingError);

    // Upstream evidence and downstream readiness are independent. A first late ID may still be adopted; no
    // provisional patch identity has escaped.
    if (!(call.itemIdSeen && call.callIdSeen) && !call.identityFinalized) return [];
  } else {
    call.argumentFragments = [];

    if (!call.itemIdSeen && !call.added)
      call.id = firstNonEmpty(call.callId, fallbackItemId(st, index));

    if (!call.callIdSeen && !call.added) call.callId = call.id;
  }

  st.itemIds.set(index, call.id);
  const events: string[] = [];
  // Replay buffered ordinary arguments only when the item is first announced.
  const announced = !call.added;

  if (announced) {
    if (!patch && call.initialArguments !== "")
      call.arguments = call.initialArguments + call.arguments;
    const itemType = call.isCustom ? "custom_tool_call" : "function_call";
    const inputKey = call.isCustom ? "input" : "arguments";

    const item: JsonObject = {
      status: "in_progress",
      type: itemType,
      [inputKey]: "",
      id: call.id,
      call_id: call.callId,
    };

    const added: JsonObject = { type: "response.output_item.added", item };
    added.sequence_number = nextSeq(st);
    added.output_index = index;
    setResponsesToolCallIdentity(added, call.name, call.namespace, "item");
    events.push(emit("response.output_item.added", added));
    call.added = true;
  }

  if (patch && call.patchCall === undefined) {
    call.patchCall = new ApplyPatchCallState(
      call.id,
      call.callId,
      call.name,
      call.namespace,
      index,
    );

    for (const fragment of call.argumentFragments) {
      const pushed = call.patchCall.pushArguments(fragment);

      if ("error" in pushed) return [...events, ...patchFailure(st, pushed.error)];
      events.push(...patchDelta(st, call, pushed.text));
    }

    call.argumentFragments = [];
  } else if (!call.isCustom && announced && call.arguments !== "") {
    events.push(argumentsDeltaEvent(index, call.id, call.arguments, st));
  }

  if (call.stopPending && call.patchCall !== undefined) {
    call.stopPending = false;
    events.push(...stepStop({ index }, st));
  }

  return events;
};

const finishPatchCalls = (st: State): string[] => {
  if (hasPatchBridge(st)) {
    for (const call of st.functionCalls.values()) {
      if (call.rawName === "")
        return patchFailure(st, "unresolved Interactions apply_patch call identity");
    }
  }

  const indexes: number[] = [];

  for (const [index, call] of st.functionCalls) {
    if (isPatch(st, call.rawName) && !call.itemDoneEmitted) indexes.push(index);
  }

  indexes.sort((a, b) => a - b);
  const events: string[] = [];

  for (const index of indexes) {
    // SAFETY: every index in `indexes` was taken from st.functionCalls keys.
    const call = st.functionCalls.get(index) as CallState;

    if (call.patchCall === undefined) {
      // Freeze the compatibility mapping of an absent id/call_id only at the response terminal.
      if (!call.itemIdSeen) call.id = firstNonEmpty(call.callId, fallbackItemId(st, index));

      if (!call.callIdSeen) call.callId = call.id;
      call.identityFinalized = true;
      events.push(...updateFunctionCall(index, undefined, st, false));

      if (st.terminal) break;
    }

    events.push(...stepStop({ index }, st));

    if (st.terminal) break;
  }

  return events;
};

// ---------------------------------------------------------------------------------------------------------------------
// Output items
// ---------------------------------------------------------------------------------------------------------------------

const reasoningItem = (index: number, st: State): JsonObject => {
  const item: JsonObject = {
    id: st.itemIds.get(index) ?? "",
    type: "reasoning",
    status: "completed",
    encrypted_content: "",
    summary: [],
  };

  const signature = interactionsReasoningEncryptedContent(st.reasoningEncrypted.get(index) ?? "");

  if (signature !== "") item.encrypted_content = signature;
  item.summary = [
    { type: "summary_text", text: (st.reasoningSummaries.get(index) ?? []).join("") },
  ];

  return item;
};

/** `responsesCompletedOutputItem`. */
const completedOutputItem = (
  index: number,
  itemType: string,
  st: State,
): JsonObject | undefined => {
  switch (itemType) {
    case "model_output": {
      const item: JsonObject = {
        id: st.itemIds.get(index) ?? "",
        type: "message",
        status: "completed",
        role: "assistant",
        content: [],
      };

      const text = st.textOutputs.get(index);

      if (text !== undefined && text !== "") item.content = [{ type: "output_text", text }];

      return item;
    }

    case "thought":
      return reasoningItem(index, st);
    case "function_call": {
      const call = st.functionCalls.get(index);
      const itemId = st.itemIds.get(index) ?? "";

      if (call !== undefined && call.isCustom) {
        const item: JsonObject = {
          id: itemId,
          type: "custom_tool_call",
          call_id: call.callId,
          name: "",
          input: "",
          status: "completed",
        };

        if (call.namespace !== "") item.namespace = call.namespace;
        item.name = call.name;
        let input = unwrapResponsesCustomToolInput(callArguments(call));

        if (call.patchCall !== undefined) input = call.patchCall.decoder.input();
        item.input = input;

        return item;
      }

      const item: JsonObject = {
        id: itemId,
        type: "function_call",
        call_id: itemId,
        name: "",
        arguments: "{}",
        status: "completed",
      };

      if (call !== undefined) {
        item.call_id = call.callId;

        if (call.namespace !== "") item.namespace = call.namespace;
        item.name = call.name;
        item.arguments = callArguments(call);
      }

      return item;
    }
  }

  return undefined;
};

const setCompletedOutput = (payload: JsonObject, st: State): void => {
  let maxIndex = -1;

  for (const index of st.itemTypes.keys()) if (index > maxIndex) maxIndex = index;
  const items: Json[] = [];

  for (let index = 0; index <= maxIndex; index++) {
    const itemType = st.itemTypes.get(index);

    if (itemType === undefined) continue;
    const item = completedOutputItem(index, itemType, st);

    if (item !== undefined) items.push(item);
  }

  if (items.length > 0) set(payload, "response.output", items);
};

// ---------------------------------------------------------------------------------------------------------------------
// Terminal events
// ---------------------------------------------------------------------------------------------------------------------

const createdEvent = (
  modelName: string,
  original: Json | undefined,
  translated: Json | undefined,
  root: Json,
  st: State,
): string => {
  const payload: JsonObject = {
    type: "response.created",
    response: { id: "", object: "response", status: "in_progress", model: "", output: [] },
  };

  payload.sequence_number = nextSeq(st);
  const id = firstNonEmpty(getStr(root, "interaction.id"), getStr(root, "id"));

  if (id !== "") st.id = id;
  set(payload, "response.id", id);
  set(payload, "response.model", modelName);

  const envId = firstNonEmpty(
    getStr(root, "interaction.environment_id"),
    getStr(root, "environment_id"),
    getStr(root, "environment.id"),
    getStr(root, "interaction.environment.id"),
  );

  if (envId !== "") {
    st.environmentId = envId;
    set(payload, "response.environment_id", envId);
  }

  let requestModel = requestModelNameOf(original, translated);

  if (requestModel === "") requestModel = modelName;

  if (requestModel !== "") set(payload, "response.model", requestModel);

  return emit("response.created", payload);
};

const completedEvent = (modelName: string, root: Json, st: State): string => {
  let eventType = "response.completed";
  let status = "completed";
  const interaction = get(root, "interaction");
  const interactionStatus = firstNonEmpty(getStr(interaction, "status"), getStr(root, "status"));

  const finishReason = firstNonEmpty(
    getStr(interaction, "finish_reason"),
    getStr(root, "finish_reason"),
  );

  let incompleteReason = "";

  if (finishReason === "content_filter") {
    eventType = "response.incomplete";
    status = "incomplete";
    incompleteReason = "content_filter";
  } else if (
    interactionStatus === "incomplete" ||
    finishReason === "length" ||
    finishReason === "max_tokens"
  ) {
    eventType = "response.incomplete";
    status = "incomplete";
    incompleteReason = "max_output_tokens";
  }

  const payload: JsonObject = {
    type: eventType,
    response: { id: "", object: "response", status, model: "", output: [], usage: {} },
  };

  if (incompleteReason !== "") set(payload, "response.incomplete_details.reason", incompleteReason);
  payload.sequence_number = nextSeq(st);
  set(payload, "response.id", firstNonEmpty(getStr(interaction, "id"), getStr(root, "id")));
  set(payload, "response.model", firstNonEmpty(getStr(interaction, "model"), modelName));

  let envId = firstNonEmpty(
    getStr(interaction, "environment_id"),
    getStr(root, "environment_id"),
    getStr(interaction, "environment.id"),
    getStr(root, "environment.id"),
  );

  if (envId === "") envId = st.environmentId;

  if (envId !== "") set(payload, "response.environment_id", envId);
  setCompletedOutput(payload, st);
  setUsageFromInteractions(payload, "response.usage", interactionsUsage(root));

  return emit(eventType, payload);
};

const failedEvent = (modelName: string, root: Json, st: State): string => {
  const interaction = get(root, "interaction");
  let id = firstNonEmpty(getStr(interaction, "id"), getStr(root, "id"));

  if (id === "") id = st.id;
  let errNode = get(root, "error");

  if (errNode === undefined && interaction !== undefined) errNode = get(interaction, "error");
  let message = getStr(errNode, "message");

  if (message === "") message = "upstream execution failed";
  const code = getStr(errNode, "code");
  const error: JsonObject = { message };

  if (code !== "") error.code = code;
  error.type = getStr(errNode, "type") || "server_error";

  const payload: JsonObject = {
    type: "response.failed",
    response: {
      id,
      object: "response",
      status: "failed",
      model: firstNonEmpty(getStr(interaction, "model"), modelName),
      output: [],
      error,
    },
  };

  payload.sequence_number = nextSeq(st);

  return emit("response.failed", payload);
};

// ---------------------------------------------------------------------------------------------------------------------
// Step events
// ---------------------------------------------------------------------------------------------------------------------

const stepStart = (root: Json, st: State): string[] => {
  const step = get(root, "step");
  const resolved = resolveStepIndex(get(root, "index"), step, 0, st);

  if (resolved.error !== undefined) return patchFailure(st, resolved.error);
  const index = resolved.index;
  const stepType = getStr(step, "type");
  // A repeated start must not overwrite a possible patch call's type evidence.
  const existing = st.functionCalls.get(index);

  if (
    existing !== undefined &&
    (existing.patchCall !== undefined ||
      isPatch(st, existing.rawName) ||
      (existing.rawName === "" && hasPatchBridge(st)))
  ) {
    return updateFunctionCall(index, step, st, true);
  }

  const itemId = firstNonEmpty(
    getStr(step, "id"),
    getStr(step, "call_id"),
    fallbackItemId(st, index),
  );

  if (stepType === "function_call") return updateFunctionCall(index, step, st, true);
  st.itemIds.set(index, itemId);
  st.itemTypes.set(index, stepType);

  switch (stepType) {
    case "model_output": {
      const added: JsonObject = {
        type: "response.output_item.added",
        output_index: index,
        item: {
          id: itemId,
          type: "message",
          status: "in_progress",
          role: "assistant",
          content: [],
        },
      };

      added.sequence_number = nextSeq(st);

      const part: JsonObject = {
        type: "response.content_part.added",
        output_index: index,
        content_index: 0,
        item_id: itemId,
        part: { type: "output_text", text: "" },
      };

      part.sequence_number = nextSeq(st);

      return [emit("response.output_item.added", added), emit("response.content_part.added", part)];
    }

    case "thought": {
      const signature = interactionsReasoningEncryptedContent(
        st.reasoningEncrypted.get(index) ?? "",
      );

      const added: JsonObject = {
        type: "response.output_item.added",
        output_index: index,
        item: {
          id: itemId,
          type: "reasoning",
          status: "in_progress",
          encrypted_content: signature,
          summary: [],
        },
      };

      added.sequence_number = nextSeq(st);

      const part: JsonObject = {
        type: "response.reasoning_summary_part.added",
        item_id: itemId,
        output_index: index,
        summary_index: 0,
        part: { type: "summary_text", text: "" },
      };

      part.sequence_number = nextSeq(st);

      return [
        emit("response.output_item.added", added),
        emit("response.reasoning_summary_part.added", part),
      ];
    }
  }

  return [];
};

const stepDelta = (root: Json, st: State): string[] => {
  const resolved = resolveStepIndex(get(root, "index"), get(root, "step"), 0, st);

  if (resolved.error !== undefined) return patchFailure(st, resolved.error);
  const index = resolved.index;
  const deltaType = getStr(root, "delta.type");
  // Check the source barrier before a same-event snapshot or identity update can replay fragments.
  const sourceCall = st.functionCalls.get(index);

  if (
    sourceCall !== undefined &&
    sourceCall.sourceStopped &&
    deltaType === "arguments_delta" &&
    getStr(root, "delta.arguments") !== ""
  ) {
    const errSourceStop = "apply_patch delta after source stop";

    if (
      sourceCall.patchCall !== undefined ||
      isPatch(st, sourceCall.rawName) ||
      isPatch(st, getStr(root, "step.name"))
    ) {
      return patchFailure(st, errSourceStop);
    }

    if (sourceCall.rawName === "" && hasPatchBridge(st) && sourceCall.pendingError === undefined) {
      sourceCall.pendingError = errSourceStop;
    }
  }

  const stepNode = get(root, "step");

  if (isObj(stepNode)) {
    const updates = updateFunctionCall(index, stepNode, st, false);

    if (st.terminal) return updates;
    // Process the same real delta after its late identity update, without replaying the update.
    const rest: JsonObject = {};

    for (const [key, value] of isJsonObject(root) ? Object.entries(root) : [])
      if (key !== "step") rest[key] = value;
    rest.index = index;

    return [...updates, ...stepDelta(rest, st)];
  }

  const delta = get(root, "delta");

  switch (deltaType) {
    case "thought_summary": {
      const text = firstNonEmpty(getStr(delta, "content.text"), getStr(delta, "text"));

      if (text !== "") {
        const list = st.reasoningSummaries.get(index) ?? [];
        list.push(text);
        st.reasoningSummaries.set(index, list);
      }

      return [
        emit(
          "response.reasoning_summary_text.delta",
          withSeq(st, {
            type: "response.reasoning_summary_text.delta",
            item_id: st.itemIds.get(index) ?? "",
            output_index: index,
            summary_index: 0,
            delta: text,
          }),
        ),
      ];
    }

    case "thought_signature": {
      const signature = interactionsReasoningEncryptedContent(getStr(delta, "signature"));

      if (signature !== "") st.reasoningEncrypted.set(index, signature);

      return [];
    }

    case "arguments_delta": {
      const args = getStr(delta, "arguments");
      let call = st.functionCalls.get(index);

      if (call === undefined) {
        call = newCall();
        st.functionCalls.set(index, call);
      }

      if (get(delta, "invalid_json_str") !== undefined) {
        call.pendingError = "legacy freeform arguments are invalid for apply_patch";

        if (call.patchCall !== undefined || isPatch(st, call.rawName))
          return patchFailure(st, call.pendingError);
      }

      if (call.patchCall !== undefined) {
        if (call.itemDoneEmitted && args !== "")
          return patchFailure(st, "apply_patch delta after item completion");
        call.arguments += args;
        const pushed = call.patchCall.pushArguments(args);

        if ("error" in pushed) return patchFailure(st, pushed.error);

        return patchDelta(st, call, pushed.text);
      }

      if (call.itemDoneEmitted) return [];
      call.arguments += args;

      if (!call.sourceStopped && (call.rawName === "" || isPatch(st, call.rawName)))
        call.argumentFragments.push(args);

      if (call.rawName === "") return [];

      if (call.isCustom) return [];

      return [argumentsDeltaEvent(index, st.itemIds.get(index) ?? "", args, st)];
    }

    default: {
      const text = getStr(delta, "text");

      const payload = withSeq(st, {
        type: "response.output_text.delta",
        output_index: index,
        content_index: 0,
        item_id: st.itemIds.get(index) ?? "",
        delta: text,
      });

      if (text !== "") st.textOutputs.set(index, (st.textOutputs.get(index) ?? "") + text);

      return [emit("response.output_text.delta", payload)];
    }
  }
};

const stepStop = (root: Json, st: State): string[] => {
  const resolved = resolveStepIndex(get(root, "index"), get(root, "step"), 0, st);

  if (resolved.error !== undefined) return patchFailure(st, resolved.error);
  const index = resolved.index;
  // Source completion is independent of downstream identity and publication.
  const stopped = st.functionCalls.get(index);

  if (stopped !== undefined) {
    stopped.sourceStopped = true;

    if (stopped.rawName === "") stopped.stopPending = true;
  }

  let updates: string[] = [];
  const stepNode = get(root, "step");

  if (st.itemTypes.get(index) === "function_call" && isObj(stepNode)) {
    updates = updateFunctionCall(index, stepNode, st, false);

    if (st.terminal) return updates;
  }

  const itemId = st.itemIds.get(index) ?? "";

  switch (st.itemTypes.get(index)) {
    case "model_output": {
      const text = st.textOutputs.get(index) ?? "";

      const textDone = withSeq(st, {
        type: "response.output_text.done",
        output_index: index,
        content_index: 0,
        item_id: itemId,
        text,
        logprobs: [],
      });

      const part = withSeq(st, {
        type: "response.content_part.done",
        output_index: index,
        content_index: 0,
        item_id: itemId,
        part: { type: "output_text", text },
      });

      const done = withSeq(st, {
        type: "response.output_item.done",
        output_index: index,
        item: {
          id: itemId,
          type: "message",
          status: "completed",
          role: "assistant",
          content: [{ type: "output_text", text }],
        },
      });

      return [
        emit("response.output_text.done", textDone),
        emit("response.content_part.done", part),
        emit("response.output_item.done", done),
      ];
    }

    case "function_call":
      return functionCallStop(index, itemId, updates, st);
    case "thought": {
      const text = (st.reasoningSummaries.get(index) ?? []).join("");

      const textDone = withSeq(st, {
        type: "response.reasoning_summary_text.done",
        item_id: itemId,
        output_index: index,
        summary_index: 0,
        text,
      });

      const partDone = withSeq(st, {
        type: "response.reasoning_summary_part.done",
        item_id: itemId,
        output_index: index,
        summary_index: 0,
        part: { type: "summary_text", text },
      });

      const done: JsonObject = {
        type: "response.output_item.done",
        output_index: index,
        item: reasoningItem(index, st),
      };

      done.sequence_number = nextSeq(st);

      return [
        emit("response.reasoning_summary_text.done", textDone),
        emit("response.reasoning_summary_part.done", partDone),
        emit("response.output_item.done", done),
      ];
    }

    default: {
      const done: JsonObject = {
        type: "response.output_item.done",
        output_index: index,
        item: reasoningItem(index, st),
      };

      done.sequence_number = nextSeq(st);

      return [emit("response.output_item.done", done)];
    }
  }
};

const functionCallStop = (
  index: number,
  itemId: string,
  updates: string[],
  st: State,
): string[] => {
  let call = st.functionCalls.get(index);

  if (call === undefined) {
    call = newCall({ id: itemId, sourceStopped: true });
    st.functionCalls.set(index, call);
  }

  if (call.rawName === "") {
    call.stopPending = true;

    return updates;
  }

  if (isPatch(st, call.rawName) && call.patchCall === undefined) {
    call.stopPending = true;

    return updates;
  }

  if (call.itemDoneEmitted) return updates;
  const events = [...updates];

  if (call.patchCall !== undefined) {
    const args = call.hasSnapshot ? call.snapshotArguments : call.arguments;

    if (call.hasSnapshot && isValidJson(call.arguments)) {
      const source = finishWhole(call.arguments);

      if ("error" in source) return patchFailure(st, source.error);

      if (source.input !== call.snapshotInput)
        return patchFailure(st, "apply_patch complete source conflicts with snapshot");
    }

    const finished = call.patchCall.finishArguments(args);

    if ("error" in finished) return patchFailure(st, finished.error);
    events.push(...patchDelta(st, call, finished.tail));
    events.push(
      emit(
        "response.custom_tool_call_input.done",
        applyPatchInputDone(call.patchCall, finished.input, nextSeq(st)),
      ),
    );
    const item = completedOutputItem(index, "function_call", st);
    const done: JsonObject = { type: "response.output_item.done" };
    done.sequence_number = nextSeq(st);
    done.output_index = index;

    if (item !== undefined) done.item = item;
    call.itemDoneEmitted = true;
    call.argumentsDoneEmitted = true;
    events.push(emit("response.output_item.done", done));

    return events;
  }

  if (call.isCustom) {
    const input = unwrapResponsesCustomToolInput(call.arguments);

    if (!call.argumentsDoneEmitted) {
      events.push(customInputDoneEvent(index, itemId, input, st));
      call.argumentsDoneEmitted = true;
    }

    const item: JsonObject = {
      id: itemId,
      type: "custom_tool_call",
      call_id: call.callId,
      name: "",
      input: "",
      status: "completed",
    };

    const done: JsonObject = { type: "response.output_item.done", output_index: index, item };
    done.sequence_number = nextSeq(st);

    if (call.namespace !== "") item.namespace = call.namespace;
    item.name = call.name;
    item.input = input;
    call.itemDoneEmitted = true;
    events.push(emit("response.output_item.done", done));

    return events;
  }

  const args = callArguments(call);

  if (!call.argumentsDoneEmitted) {
    events.push(argumentsDoneEvent(index, itemId, args, st));
    call.argumentsDoneEmitted = true;
  }

  const item: JsonObject = {
    id: itemId,
    type: "function_call",
    call_id: call.callId,
    name: "",
    arguments: "",
    status: "completed",
  };

  const done: JsonObject = { type: "response.output_item.done", output_index: index, item };
  done.sequence_number = nextSeq(st);

  if (call.namespace !== "") item.namespace = call.namespace;
  item.name = call.name;
  item.arguments = args;
  call.itemDoneEmitted = true;
  events.push(emit("response.output_item.done", done));

  return events;
};

// ---------------------------------------------------------------------------------------------------------------------
// Stream entry
// ---------------------------------------------------------------------------------------------------------------------

/**
 * gjson reads fields lazily and tolerates truncated objects; this recovers the longest prefix of top-level members of
 * a malformed JSON object so that the same fields stay readable.
 */
const lenientParse = (payload: string): Json | undefined => {
  const text = payload.trim();

  if (!text.startsWith("{")) return undefined;
  const cuts: number[] = [];
  let depth = 0;
  let inString = false;

  for (let i = 0; i < text.length; i++) {
    // SAFETY: the loop condition keeps i < text.length.
    const c = text[i] as string;

    if (inString) {
      if (c === "\\") i++;
      else if (c === '"') inString = false;
      continue;
    }

    if (c === '"') inString = true;
    else if (c === "{" || c === "[") depth++;
    else if (c === "}" || c === "]") depth--;
    else if (c === "," && depth === 1) cuts.push(i);
  }

  for (let i = cuts.length - 1; i >= 0; i--) {
    const candidate = parseJson(`${text.slice(0, cuts[i])}}`);

    if (candidate !== undefined) return candidate;
  }

  return parseJson("{}");
};

const convertEvent = (
  modelName: string,
  original: Json | undefined,
  translated: Json | undefined,
  rawLine: string,
  st: State,
): string[] => {
  if (st.done || st.toolInputError !== undefined || st.sourceFailed) return [];
  const payload = ssePayloadOf(rawLine);

  if (payload === "") return [];
  const sentinel = payload.trim() === "[DONE]";
  const strict = sentinel ? undefined : parseJson(payload);
  const parsed = strict ?? (sentinel ? undefined : lenientParse(payload));
  // A source sentinel remains legal after response completion, but only once.
  const isDone = sentinel || (strict !== undefined && getStr(strict, "event_type") === "done");

  if (isDone) {
    const events = finishPatchCalls(st);

    if (st.toolInputError !== undefined) return events;
    st.done = true;
    st.terminal = true;

    return [...events, "data: [DONE]"];
  }

  if (st.terminal) return [];

  if (parsed === undefined) return [];

  if (strict === undefined) {
    const errJson = "invalid Interactions apply_patch event JSON";
    const resolved = resolveStepIndex(get(parsed, "index"), get(parsed, "step"), 0, st);

    if (resolved.error !== undefined) return patchFailure(st, resolved.error);

    if (getStr(parsed, "event_type").startsWith("step.")) {
      let call = st.functionCalls.get(resolved.index);

      if (call === undefined) {
        call = newCall({
          id: getStr(parsed, "step.id"),
          callId: getStr(parsed, "step.call_id"),
          itemIdSeen: getStr(parsed, "step.id") !== "",
          callIdSeen: getStr(parsed, "step.call_id") !== "",
        });
        st.functionCalls.set(resolved.index, call);
      }

      if (call.pendingError === undefined) call.pendingError = errJson;

      if (isPatch(st, call.rawName) || isPatch(st, getStr(parsed, "step.name")))
        return patchFailure(st, errJson);
    } else {
      st.pendingEnvelopeError ??= errJson;

      for (const call of st.functionCalls.values()) {
        if (call.patchCall !== undefined) return patchFailure(st, st.pendingEnvelopeError);
      }
    }
  }

  const root = parsed;

  switch (getStr(root, "event_type")) {
    case "interaction.created":
      return [createdEvent(modelName, original, translated, root, st)];
    case "step.start":
      return stepStart(root, st);
    case "step.delta":
      return stepDelta(root, st);
    case "step.stop":
      return stepStop(root, st);
    case "interaction.completed":
    case "finish": {
      const events: string[] = [];
      const steps = firstExisting(get(root, "interaction.steps"), get(root, "steps"));
      const patchEnabled = hasPatchBridge(st);

      for (const [key, step] of eachEntry(steps)) {
        const resolved = resolveStepIndex(get(step, "index"), step, asInt(key), st);

        if (resolved.error !== undefined) {
          events.push(...patchFailure(st, resolved.error));
          break;
        }

        const index = resolved.index;
        const call = st.functionCalls.get(index);

        // Patch-enabled unnamed functions retain evidence before final snapshot filtering.
        if (
          call === undefined ||
          (call.patchCall === undefined &&
            !isPatch(st, call.rawName) &&
            (!patchEnabled || call.rawName !== ""))
        ) {
          if (getStr(step, "type") !== "function_call") continue;

          const unresolved =
            patchEnabled &&
            (getStr(step, "name") === "" || (call !== undefined && call.rawName === ""));

          if (!isPatch(st, getStr(step, "name")) && !unresolved) continue;
        }

        events.push(...updateFunctionCall(index, step, st, false));

        if (st.terminal) break;
      }

      if (st.terminal) return events;
      events.push(...finishPatchCalls(st));

      if (st.terminal) return events;
      st.terminal = true;
      events.push(completedEvent(modelName, root, st));

      return events;
    }

    case "response.failed":
    case "interaction.failed":
      if (hasPatchBridge(st)) return patchFailure(st, "upstream apply_patch interaction failed");
      st.sourceFailed = true;
      st.terminal = true;

      return [failedEvent(modelName, root, st)];
  }

  return [];
};

// ---------------------------------------------------------------------------------------------------------------------
// Non-stream
// ---------------------------------------------------------------------------------------------------------------------

/** `interactionsStepToResponsesOutput`. */
const stepToOutput = (
  step: Json,
  forAntigravity: boolean,
  identities: ReadonlyMap<string, ResponsesToolIdentity>,
): JsonObject | undefined => {
  switch (getStr(step, "type")) {
    case "model_output": {
      const item: JsonObject = { type: "message", role: "assistant", content: [] };
      const id = firstNonEmpty(getStr(step, "id"), getStr(step, "step_id"));

      if (id !== "") item.id = id;
      const content = get(step, "content");
      const parts: Json[] = [];

      if (typeof content === "string") parts.push({ type: "output_text", text: content });
      else {
        for (const [, part] of eachEntry(content)) {
          const converted = interactionsContentPartToResponses(part, "assistant");

          if (converted !== undefined) parts.push(converted);
        }
      }

      if (parts.length > 0) item.content = parts;

      return item;
    }

    case "thought": {
      const item: JsonObject = { type: "reasoning", summary: [] };
      const signature = interactionsThoughtSignature(step);

      if (signature !== "") item.encrypted_content = signature;
      const texts = interactionsContentTexts(get(step, "content"));

      if (texts.length > 0) item.summary = texts.map((text) => ({ type: "summary_text", text }));

      return item;
    }

    case "function_call": {
      const item = interactionsFunctionCallToResponses(step, forAntigravity, identities);
      item.status = "completed";

      return item;
    }
  }

  return undefined;
};

const convertNonStream = (context: ResponseContext, body: string): string | undefined => {
  const root = parseJson(body);

  const out: JsonObject = {
    id: "",
    object: "response",
    status: "completed",
    model: "",
    output: [],
  };

  out.id = firstNonEmpty(getStr(root, "id"), getStr(root, "interaction.id"));
  const modelName = context.model;
  out.model = responseModel(modelName, root);
  const steps = get(root, "steps") ?? get(root, "interaction.steps");
  const forAntigravity = isAntigravityModel(responseModel(modelName, root));
  const requestBody = context.originalRequest ?? context.translatedRequest;

  const identities =
    requestBody !== undefined
      ? toolIdentityMapOf(requestBody, forAntigravity)
      : new Map<string, ResponsesToolIdentity>();

  let patchEnabled = false;

  for (const identity of identities.values()) if (identity.applyPatch) patchEnabled = true;
  let toolInputError: string | undefined;
  const status = firstNonEmpty(getStr(root, "status"), getStr(root, "interaction.status"));
  const sourceError = firstExisting(get(root, "error"), get(root, "interaction.error"));

  if (
    patchEnabled &&
    (status === "failed" || (sourceError !== undefined && sourceError !== null))
  ) {
    toolInputError = "upstream apply_patch interaction failed";
  }

  const outputs: Json[] = [];

  for (const [, step] of eachEntry(steps)) {
    if (toolInputError !== undefined) break;

    if (patchEnabled && getStr(step, "type") === "function_call" && getStr(step, "name") === "") {
      toolInputError = "unresolved Interactions apply_patch call identity";
      break;
    }

    if (
      getStr(step, "type") === "function_call" &&
      identities.get(getStr(step, "name"))?.applyPatch === true
    ) {
      if (root === undefined) {
        toolInputError = "invalid Interactions apply_patch response JSON";
        break;
      }

      const finished = finishWhole(jsonStringValue(get(step, "arguments"), "{}"));

      if ("error" in finished) {
        toolInputError = finished.error;
        break;
      }
    }

    const item = stepToOutput(step, forAntigravity, identities);

    if (item !== undefined) outputs.push(item);
  }

  if (toolInputError !== undefined) {
    context.state.toolInputError = toolInputError;

    return undefined;
  }

  if (outputs.length > 0) out.output = outputs;

  const interactionStatus = firstNonEmpty(
    getStr(root, "status"),
    getStr(root, "interaction.status"),
  );

  const finishReason = firstNonEmpty(
    getStr(root, "finish_reason"),
    getStr(root, "interaction.finish_reason"),
  );

  if (finishReason === "content_filter") {
    out.status = "incomplete";
    set(out, "incomplete_details.reason", "content_filter");
  } else if (
    interactionStatus === "incomplete" ||
    finishReason === "length" ||
    finishReason === "max_tokens"
  ) {
    out.status = "incomplete";
    set(out, "incomplete_details.reason", "max_output_tokens");
  }

  const envId = firstNonEmpty(
    getStr(root, "environment_id"),
    getStr(root, "interaction.environment_id"),
    getStr(root, "environment.id"),
    getStr(root, "interaction.environment.id"),
  );

  if (envId !== "") out.environment_id = envId;
  setUsageFromInteractions(out, "usage", interactionsUsage(root));

  return JSON.stringify(out);
};

const stateOf = (context: ResponseContext): State => {
  // SAFETY: only this translator writes `state.value`, always with a State.
  let st = context.state.value as State | undefined;

  if (st === undefined) {
    st = newState();
    context.state.value = st;
  }

  st.forAntigravity = isAntigravityModel(context.model);

  if (!st.identityMapReady) {
    const requestBody = context.originalRequest ?? context.translatedRequest;

    if (requestBody !== undefined) {
      st.toolIdentityMap = toolIdentityMapOf(requestBody, st.forAntigravity);
      st.identityMapReady = true;
    }
  }

  return st;
};

/** `FinalizeToolInput`: rejects a patch-enabled stream lacking its source terminator (never fabricates success). */
const finalizeToolInput = (context: ResponseContext, st: State): string[] => {
  if (st.toolInputError !== undefined || st.terminal) return [];

  if (!hasPatchBridge(st)) return [];
  st.toolInputError = "upstream apply_patch stream ended before protocol completion";
  context.state.toolInputError = st.toolInputError;
  st.terminal = true;

  return [emit("response.failed", applyPatchFailure(st.id, nextSeq(st)))];
};

/** Interactions upstream -> Responses client (registered for `(OpenAIResponse, Interactions)`). */
export const interactionsToOpenAIResponsesResponse: ResponseTransform = {
  stream: (context, line) => {
    const st = stateOf(context);
    context.state.finalizeToolInput ??= () => finalizeToolInput(context, st);

    const events = convertEvent(
      context.model,
      context.originalRequest,
      context.translatedRequest,
      line,
      st,
    );

    if (st.toolInputError !== undefined) context.state.toolInputError = st.toolInputError;

    return events;
  },
  nonStream: convertNonStream,
};
