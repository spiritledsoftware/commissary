/**
 * Shared pieces of the Gemini -> OpenAI Responses response translators.
 *
 * Go source: internal/translator/gemini/openai/responses/gemini_openai-responses_response.go (usage, terminal state,
 * request echo, function-call evidence) and internal/translator/common/apply_patch_events.go /
 * apply_patch_input.go (the parts a non-incremental Gemini call needs).
 */
import {
  asBool,
  asFloat,
  asInt,
  asString,
  cloneJson,
  get,
  type Json,
  type JsonObject,
  set,
} from "@commissary/json";
import { unwrapApplyPatchInput } from "../../../common/apply-patch.ts";
import { isContentFilterFinishReason } from "../../../common/gemini-response.ts";
import type { ResponsesToolIdentity } from "../../../common/responses-tools.ts";

// --- identifiers -------------------------------------------------------------------------------------------------------

let responseIdCounter = 0;

let funcCallIdCounter = 0;

const unixNanoString = (): string => `${Date.now()}000000`;

const unixNanoHex = (): string => (BigInt(Date.now()) * 1_000_000n).toString(16);

/** `resp_%x_%d` (time based, process-unique). */
export const newResponseId = (): string => {
  responseIdCounter++;

  return `resp_${unixNanoHex()}_${responseIdCounter}`;
};

/** `call_%d_%d` (decimal nanoseconds, used by the streaming path). */
export const newStreamCallId = (): string => {
  funcCallIdCounter++;

  return `call_${unixNanoString()}_${funcCallIdCounter}`;
};

/** `call_%x_%d` (hex nanoseconds, used by the non-streaming path). */
export const newNonStreamCallId = (): string => {
  funcCallIdCounter++;

  return `call_${unixNanoHex()}_${funcCallIdCounter}`;
};

// --- request root helpers ----------------------------------------------------------------------------------------------

/** `pickRequestJSON`: the original request when present, else the translated one. */
export const pickRequestJson = (
  original: Json | undefined,
  translated: Json | undefined,
): Json | undefined => (original !== undefined ? original : translated);

/** `unwrapRequestRoot`: Cloud-Code style `{request: {...}}` envelopes. */
export const unwrapRequestRoot = (root: Json | undefined): Json | undefined => {
  const request = get(root, "request");

  if (request === undefined) return root;

  if (
    get(request, "model") !== undefined ||
    get(request, "input") !== undefined ||
    get(request, "instructions") !== undefined
  ) {
    return request;
  }

  return root;
};

/** `unwrapGeminiResponseRoot`: Vertex-style `{response: {...}}` envelopes. */
export const unwrapGeminiResponseRoot = (root: Json | undefined): Json | undefined => {
  const response = get(root, "response");

  if (response === undefined) return root;

  if (
    get(response, "candidates") !== undefined ||
    get(response, "responseId") !== undefined ||
    get(response, "usageMetadata") !== undefined ||
    get(response, "cpaUsageMetadata") !== undefined
  ) {
    return response;
  }

  return root;
};

/** RFC 3339 `createTime` -> unix seconds. */
export const parseCreateTime = (value: Json | undefined): number | undefined => {
  if (value === undefined) return undefined;
  const ms = Date.parse(asString(value));

  return Number.isNaN(ms) ? undefined : Math.floor(ms / 1000);
};

/** Request fields echoed on the terminal response object, in Go's order. */
export const echoRequestFields = (
  target: Json,
  prefix: string,
  request: Json | undefined,
  modelFallback?: Json,
): void => {
  const path = (field: string): string => (prefix === "" ? field : `${prefix}.${field}`);

  const copy = (field: string, convert: (value: Json | undefined) => Json): void => {
    const value = get(request, field);

    if (value !== undefined) set(target, path(field), convert(value));
  };

  const raw = (value: Json | undefined): Json => (value === undefined ? null : cloneJson(value));
  copy("instructions", asString);
  copy("max_output_tokens", asInt);
  copy("max_tool_calls", asInt);
  const model = get(request, "model");

  if (model !== undefined) set(target, path("model"), asString(model));
  else if (modelFallback !== undefined) set(target, path("model"), asString(modelFallback));
  copy("parallel_tool_calls", asBool);
  copy("previous_response_id", asString);
  copy("prompt_cache_key", asString);
  copy("reasoning", raw);
  copy("safety_identifier", asString);
  copy("service_tier", asString);
  copy("store", asBool);
  copy("temperature", asFloat);
  copy("text", raw);
  copy("tool_choice", raw);
  copy("tools", raw);
  copy("top_logprobs", asInt);
  copy("top_p", asFloat);
  copy("truncation", asString);
  copy("user", raw);
  copy("metadata", raw);
};

// --- usage -------------------------------------------------------------------------------------------------------------

/** Gemini usage frames are cumulative snapshots, not additive deltas. */
export interface ResponsesUsage {
  present: boolean;
  prompt: number;
  candidates: number;
  thoughts: number;
  total: number;
  cached: number;
}

export const newUsage = (): ResponsesUsage => ({
  present: false,
  prompt: 0,
  candidates: 0,
  thoughts: 0,
  total: 0,
  cached: 0,
});

/** `geminiResponsesUsage.Merge`. */
export const mergeUsage = (usage: ResponsesUsage, root: Json | undefined): boolean => {
  const metadata = get(root, "usageMetadata") ?? get(root, "cpaUsageMetadata");

  if (metadata === undefined) return false;
  usage.present = true;

  const read = (name: string, assign: (value: number) => void): void => {
    const value = get(metadata, name);

    if (value !== undefined) assign(asInt(value));
  };

  read("promptTokenCount", (v) => (usage.prompt = v));
  read("candidatesTokenCount", (v) => (usage.candidates = v));
  read("thoughtsTokenCount", (v) => (usage.thoughts = v));
  read("totalTokenCount", (v) => (usage.total = v));
  read("cachedContentTokenCount", (v) => (usage.cached = v));

  return true;
};

export const usageJson = (usage: ResponsesUsage): JsonObject => ({
  input_tokens: usage.prompt,
  input_tokens_details: { cached_tokens: usage.cached },
  output_tokens: usage.candidates + usage.thoughts,
  output_tokens_details: { reasoning_tokens: usage.thoughts },
  total_tokens: usage.total,
});

interface TerminalState {
  readonly eventType: string;
  readonly status: string;
  readonly incompleteDetails: JsonObject | undefined;
}

export const terminalState = (finishReason: string): TerminalState => {
  const reason = finishReason.trim().toUpperCase();

  if (reason === "MAX_TOKENS")
    return {
      eventType: "response.incomplete",
      status: "incomplete",
      incompleteDetails: { reason: "max_output_tokens" },
    };

  // Safety, recitation and malformed finishReasons end the response incomplete (Go 3f5d3a16).
  if (isContentFilterFinishReason(reason))
    return {
      eventType: "response.incomplete",
      status: "incomplete",
      incompleteDetails: { reason: "content_filter" },
    };

  return { eventType: "response.completed", status: "completed", incompleteDetails: undefined };
};

// --- apply_patch -------------------------------------------------------------------------------------------------------

export interface ApplyPatchCall {
  readonly itemId: string;
  readonly callId: string;
  readonly name: string;
  readonly namespace: string;
  readonly outputIndex: number;
}

const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

/**
 * `ApplyPatchCallState.FinishArguments` for a complete (non-streamed) Gemini call: the strict `{"input": "..."}`
 * envelope, with the same character validation as streamed fragments (no unpaired surrogates).
 */
export const finishApplyPatchArguments = (
  argumentsText: string,
): { readonly input: string } | { readonly error: string } => {
  const unwrapped = unwrapApplyPatchInput(argumentsText);

  if ("error" in unwrapped) return { error: "invalid apply_patch arguments" };

  if (LONE_SURROGATE.test(unwrapped.input))
    return { error: "invalid character in apply_patch input" };

  return { input: unwrapped.input };
};

/** `SetResponsesToolCallIdentity`. */
export const setToolCallIdentity = (item: JsonObject, name: string, namespace: string): void => {
  item["name"] = name;

  if (namespace !== "") item["namespace"] = namespace;
  else delete item["namespace"];
};

// --- function call evidence -------------------------------------------------------------------------------------------

export interface FunctionEvidence {
  partIndex: number;
  hasPartIndex: boolean;
  applyPatch: boolean;
  rawName: string;
  upstreamId: string;
  input: string;
  hasInput: boolean;
  err: string | undefined;
  patchCall: ApplyPatchCall | undefined;
}

export interface EvidenceState {
  toolIdentityMap: ReadonlyMap<string, ResponsesToolIdentity>;
  functionEvidence: Map<string, FunctionEvidence> | undefined;
}

const newEvidence = (): FunctionEvidence => ({
  partIndex: 0,
  hasPartIndex: false,
  applyPatch: false,
  rawName: "",
  upstreamId: "",
  input: "",
  hasInput: false,
  err: undefined,
  patchCall: undefined,
});

/**
 * `geminiRecordFunctionEvidence`: full snapshots are evidence, never source prefixes. Stable IDs and explicit part
 * indexes identify repeated snapshots without merging distinct unkeyed calls.
 */
export const recordFunctionEvidence = (
  st: EvidenceState,
  functionCall: Json,
  partIndex: number,
  validJson: boolean,
): FunctionEvidence => {
  if (st.functionEvidence === undefined) st.functionEvidence = new Map();
  const store = st.functionEvidence;
  const keys: string[] = [];

  if (partIndex >= 0) keys.push(`part:${partIndex}`);
  const id = asString(get(functionCall, "id"));

  if (id !== "") keys.push(`id:${id}`);
  const callName = asString(get(functionCall, "name"));

  // Never guess which later named call owns an unkeyed nameless snapshot.
  if (keys.length === 0 && callName === "") keys.push(`unknown:${store.size}`);
  let evidence: FunctionEvidence | undefined;
  let conflict = false;
  let patchRelated = st.toolIdentityMap.get(callName)?.applyPatch === true;

  for (const key of keys) {
    const prior = store.get(key);

    if (prior === undefined) continue;
    patchRelated = patchRelated || prior.applyPatch;

    if (evidence === undefined) evidence = prior;
    else if (evidence !== prior) conflict = true;
  }

  if (conflict) {
    const error = "conflicting apply_patch call indexes";

    if (patchRelated) {
      // Reject before rebinding either established call's aliases or provenance.
      return { ...newEvidence(), applyPatch: true, err: error };
    }

    // Ordinary-only cross-key reuse keeps the legacy first-match behavior.
    if (evidence !== undefined) evidence.err = error;
  }

  const target = evidence ?? newEvidence();

  const recordError = (error: string): void => {
    if (target.err === undefined) target.err = error;
  };

  if (partIndex >= 0) {
    if (target.hasPartIndex && target.partIndex !== partIndex)
      recordError("conflicting apply_patch part index");
    else {
      target.partIndex = partIndex;
      target.hasPartIndex = true;
    }
  }

  if (st.toolIdentityMap.get(callName)?.applyPatch === true) target.applyPatch = true;

  for (const key of keys) store.set(key, target);

  if (callName !== "") {
    if (target.rawName !== "" && target.rawName !== callName)
      recordError("conflicting apply_patch call name");
    else target.rawName = callName;
  }

  if (id !== "") {
    if (target.upstreamId !== "" && target.upstreamId !== id)
      recordError("conflicting apply_patch call ID");
    else target.upstreamId = id;
  }

  const args = get(functionCall, "args");
  const finished = finishApplyPatchArguments(args === undefined ? "" : JSON.stringify(args));

  if (!validJson) recordError("invalid Gemini apply_patch response JSON");

  if ("error" in finished) {
    recordError(finished.error);
  } else {
    if (target.hasInput && target.input !== finished.input)
      recordError("conflicting apply_patch complete snapshots");
    target.hasInput = true;
    target.input = finished.input;
  }

  return target;
};

/** `geminiPendingIdentityError`. */
export const pendingIdentityError = (st: EvidenceState): string | undefined => {
  let patchEnabled = false;

  for (const identity of st.toolIdentityMap.values()) {
    if (identity.applyPatch) {
      patchEnabled = true;
      break;
    }
  }

  if (!patchEnabled || st.functionEvidence === undefined) return undefined;

  for (const evidence of st.functionEvidence.values()) {
    if (evidence.rawName === "")
      return evidence.err ?? "unresolved Gemini apply_patch call identity";
  }

  return undefined;
};
