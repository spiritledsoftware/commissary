/**
 * Reasoning replay preparation of an Antigravity Gemini request (`prepareAntigravityGeminiReasoningReplayPayload`).
 *
 * Go source: internal/runtime/executor/antigravity_reasoning_replay.go. Order: ledger read -> replay items ->
 * function response role normalisation -> degrade unresolved reserved tool ids -> repair unsigned first function
 * calls -> pairing validation (a replay that breaks pairing is dropped and the ledger entry invalidated).
 * Replay state is an optimisation: backend failures degrade to "no replay this turn", never to a failed request.
 */
import { Effect } from "effect";
import type { Json } from "@commissary/json";
import { ExecutionError } from "../../errors.ts";
import type { ExecutorOptions, ExecutorRequest } from "../../types.ts";
import { normalizeFunctionResponseRoles, usesReasoningReplay } from "../content.ts";
import { ReplayAccumulator, type ReplayScope, replayScopeValid } from "./accumulator.ts";
import { applyReplayItems, replayToolSchemasFromRequests, type ToolSchemas } from "./apply.ts";
import { UNLOADED_SNAPSHOT, type ReplayLedger } from "./ledger.ts";
import {
  degradeToolProvenanceIds,
  payloadHasToolProvenanceId,
  repairUnsignedFirstFunctionCalls,
  validateFunctionCallPairing,
} from "./provenance.ts";
import { replaySessionKey } from "./scope.ts";

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
) {
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
    sessionKey,
    snapshot: UNLOADED_SNAPSHOT,
    openAIChat: options.sourceFormat === "openai",
  };

  let updated: Json = structuredClone(payload);
  let replayApplied = false;

  if (replayScopeValid(scope)) {
    const read = yield* ledger.get(scope.modelName, scope.sessionKey);
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

  updated = normalizeFunctionResponseRoles(updated);

  if (payloadHasToolProvenanceId(updated)) {
    // The ledger could not resolve every tool id (session lane changed, entry expired, a turn never committed):
    // degrade those calls to synthetic ids instead of killing the conversation.
    degradeToolProvenanceIds(updated);
    updated = normalizeFunctionResponseRoles(updated);
  }

  // An identity-only restore drops the cached signature, which can leave a model turn's first call unsigned.
  repairUnsignedFirstFunctionCalls(updated);
  const pairingError = validateFunctionCallPairing(updated);

  if (pairingError !== undefined) {
    const originalPairingValid = validateFunctionCallPairing(payload) === undefined;

    if (replayApplied && originalPairingValid && replayScopeValid(scope)) {
      // Replay broke the call/response pairing: invalidate the entry and degrade to the original payload.
      yield* ledger.deleteIfUnchanged(scope.modelName, scope.sessionKey, scope.snapshot);
      yield* Effect.logWarning(
        "antigravity executor: reasoning replay broke Gemini function call pairing; degrading",
      );

      return { payload, scope } satisfies PreparedReplay;
    }

    return yield* new ExecutionError({
      status: 400,
      message: `antigravity executor: invalid Gemini function call history: ${pairingError}`,
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
