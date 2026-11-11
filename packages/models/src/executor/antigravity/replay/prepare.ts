/**
 * Reasoning replay preparation of an Antigravity Gemini request (`prepareAntigravityGeminiReasoningReplayPayload`).
 *
 * Go source: internal/runtime/executor/antigravity_reasoning_replay.go. Order: ledger read -> replay items ->
 * function response role normalisation -> degrade unresolved reserved tool ids -> repair unsigned first function
 * calls -> pairing validation (a replay that breaks pairing is dropped and the ledger entry invalidated).
 * Replay state is an optimisation: backend failures degrade to "no replay this turn", never to a failed request.
 *
 * The Gemini API and Vertex executors use it on a top-level `contents` body wrapped in a `request` envelope
 * (`replayEnvelope`; Go cc95661c): they read their own store, skip native Gemini and Interactions clients (the signatures
 * of those travel with them, Go f36b195e) and, for token counting, only peek.
 */
import { Effect } from "effect";
import { get, type Json, type JsonObject } from "@commissary/json";
import { ExecutionError } from "../../errors.ts";
import { Formats } from "@commissary/translation/formats";
import { type ExecutorOptions, type ExecutorRequest, responseFormatOf } from "../../types.ts";
import { normalizeFunctionResponseRoles } from "../content.ts";
import { usesReasoningReplay } from "../../helps/reasoning-replay.ts";
import { ReplayAccumulator, type ReplayScope, replayScopeValid } from "./accumulator.ts";
import { applyReplayItems, replayToolSchemasFromRequests, type ToolSchemas } from "./apply.ts";
import { UNLOADED_SNAPSHOT, type ReplayLedger } from "../../helps/reasoning-replay-ledger.ts";
import {
  degradeToolProvenanceIds,
  payloadHasToolProvenanceId,
  repairUnsignedFirstFunctionCalls,
  validateFunctionCallPairing,
} from "./provenance.ts";
import { replaySessionKey } from "./scope.ts";

export interface ReplayPrepareMode {
  /** False for token counting: the ledger is peeked, and nothing is invalidated. Default true. */
  readonly reserve?: boolean;
  /** Whether model-role functionResponse turns are normalised (the Antigravity envelope does, top-level bodies do not). */
  readonly normalizeRoles?: boolean;
  /** Names the executor in the message of an invalid-history error. Default `antigravity executor`. */
  readonly executor?: string;
}

/** Formats whose clients keep their own thought signatures (`antigravityFormatCarriesNativeThoughtSignatures`). */
const carriesNativeSignatures = (format: string): boolean =>
  format === Formats.Gemini || format === Formats.Interactions;

/**
 * `antigravityRequestIsSymmetricForReasoningReplay` (Go f36b195e): a request that comes in and goes out as Gemini or
 * Interactions needs no ledger, unless its history holds Claude tool-provenance ids to resolve.
 */
const isSymmetric = (options: ExecutorOptions): boolean =>
  options.sourceFormat !== "" &&
  carriesNativeSignatures(options.sourceFormat) &&
  carriesNativeSignatures(responseFormatOf(options));

/**
 * `antigravityReplayRequestEnvelopeFromDoc`: the `request` envelope of a top-level Gemini body (system instruction,
 * tools, tool config and contents, plus its session ids), the shape every replay module reads.
 */
export const replayEnvelope = (body: Json): Json | undefined => {
  if (get(body, "request.contents") !== undefined) return body;
  const contents = get(body, "contents");

  if (contents === undefined) return undefined;
  const request: JsonObject = {};

  for (const key of ["systemInstruction", "tools", "toolConfig", "contents"]) {
    const value = get(body, key);

    if (value !== undefined) request[key] = value;
  }

  const envelope: JsonObject = { request };

  for (const key of ["sessionId", "session_id"]) {
    const value = get(body, key);

    if (value !== undefined) envelope[key] = value;
  }

  return envelope;
};

export interface PreparedReplay {
  /** The payload to send (a new value; the input is never mutated). */
  readonly payload: Json;
  readonly scope: ReplayScope;
}

const NO_SCOPE: ReplayScope = { modelName: "", sessionKey: "", snapshot: UNLOADED_SNAPSHOT };

/** `prepareAntigravityGeminiReasoningReplayPayload`. */
export const prepareReplayPayload = Effect.fnUntraced(function* (
  ledger: ReplayLedger,
  modelName: string,
  request: ExecutorRequest,
  options: ExecutorOptions,
  payload: Json,
  mode: ReplayPrepareMode = {},
) {
  const reserve = mode.reserve !== false;
  const normalizeRoles = mode.normalizeRoles !== false;

  if (!usesReasoningReplay(modelName)) return { payload, scope: NO_SCOPE } satisfies PreparedReplay;

  // `applyAntigravityReasoningReplayCache`
  const sessionKey = replaySessionKey(
    {
      modelName,
      originalRequest: options.originalRequest,
      requestPayload: request.payload,
      headers: options.headers,
      derivedSessionId: options.metadata.derivedSessionId ?? "",
      callerScope: options.metadata.callerScope,
    },
    payload,
  );

  let scope: ReplayScope = {
    modelName: modelName.trim(),
    sessionKey: isSymmetric(options) && !payloadHasToolProvenanceId(payload) ? "" : sessionKey,
    snapshot: UNLOADED_SNAPSHOT,
    openAIChat: options.sourceFormat === "openai",
  };

  let updated: Json = structuredClone(payload);
  let replayApplied = false;

  if (replayScopeValid(scope)) {
    const read = yield* reserve
      ? ledger.get(scope.modelName, scope.sessionKey)
      : ledger.peek(scope.modelName, scope.sessionKey);

    scope = { ...scope, snapshot: read.snapshot };

    if (read.items !== undefined && read.items.length > 0) {
      const schemas: ToolSchemas =
        options.sourceFormat === "claude"
          ? replayToolSchemasFromRequests(options.originalRequest, request.payload)
          : new Map();

      replayApplied = applyReplayItems(updated, read.items, schemas);

      if (!replayApplied) updated = structuredClone(payload);
    }
  }

  if (normalizeRoles) updated = normalizeFunctionResponseRoles(updated);

  if (payloadHasToolProvenanceId(updated)) {
    // The ledger could not resolve every tool id (session lane changed, entry expired, a turn never committed):
    // degrade those calls to synthetic ids instead of killing the conversation.
    degradeToolProvenanceIds(updated);

    if (normalizeRoles) updated = normalizeFunctionResponseRoles(updated);
  }

  // An identity-only restore drops the cached signature, which can leave a model turn's first call unsigned.
  repairUnsignedFirstFunctionCalls(updated);
  const pairingError = validateFunctionCallPairing(updated);

  if (pairingError !== undefined) {
    const originalPairingValid = validateFunctionCallPairing(payload) === undefined;

    if (replayApplied && originalPairingValid && replayScopeValid(scope)) {
      // Replay broke the call/response pairing: invalidate the entry (not while only counting) and degrade to the
      // original payload.
      if (reserve)
        yield* ledger.deleteIfUnchanged(scope.modelName, scope.sessionKey, scope.snapshot);
      yield* Effect.logWarning(
        `${mode.executor ?? "antigravity executor"}: reasoning replay broke Gemini function call pairing; degrading`,
      );

      return { payload, scope } satisfies PreparedReplay;
    }

    return yield* new ExecutionError({
      status: 400,
      message: `${mode.executor ?? "antigravity executor"}: invalid Gemini function call history: ${pairingError}`,
      requestScoped: true,
    });
  }

  return { payload: updated, scope } satisfies PreparedReplay;
});

/** `clearAntigravityReasoningReplayOnInvalidSignature`: an upstream 400 about signatures drops the entry. */
export const clearReplayOnInvalidSignature = (
  ledger: ReplayLedger,
  scope: ReplayScope,
  status: number,
  body: string,
): Effect.Effect<void> => {
  if (!replayScopeValid(scope) || status !== 400 || !body.toLowerCase().includes("signature"))
    return Effect.void;

  return ledger
    .deleteIfUnchanged(scope.modelName, scope.sessionKey, scope.snapshot)
    .pipe(Effect.asVoid);
};

/** A fresh accumulator for the request (undefined without a replay scope). */
export const makeAccumulator = (
  scope: ReplayScope,
  requestPayload: Json,
): ReplayAccumulator | undefined =>
  replayScopeValid(scope) ? new ReplayAccumulator(scope, requestPayload) : undefined;
