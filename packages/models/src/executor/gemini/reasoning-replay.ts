/**
 * The reasoning-replay step of a Gemini API or Vertex generate, stream or token-count request.
 *
 * Go source: internal/runtime/executor/gemini_executor.go and gemini_vertex_executor.go (the `prepareGeminiTopLevelReasoningReplayPayloadDoc`
 * call and the sanitising around it), Go cc95661c. The ledger machinery is the Antigravity one (`antigravity/replay/`) over a
 * top-level `contents` body wrapped in a `request` envelope.
 */
import { Effect } from "effect";
import { get, type Json, set } from "@commissary/json";
import { sanitizeNonVertexGeminiRequestThoughtSignatures } from "@commissary/translation";
import {
  NO_REPLAY_SCOPE,
  type ReplayAccumulator,
  type ReplayScope,
} from "../antigravity/replay/accumulator.ts";
import {
  makeAccumulator,
  prepareReplayPayload,
  replayEnvelope,
} from "../antigravity/replay/prepare.ts";
import type { ExecutorOptions, ExecutorRequest } from "../types.ts";
import type { GoogleVariant } from "./google.ts";
import { stripVertexOpenAIResponsesToolCallIds } from "./shaping.ts";

export interface AppliedReplay {
  readonly body: Json;
  /** The ledger scope of a generate or stream request (with the snapshot read); none for token counting. */
  readonly scope: ReplayScope;
  /** Turns the response into the ledger entry the next turn reads; absent without a scope. */
  readonly accumulator: ReplayAccumulator | undefined;
}

/**
 * The signatures and native calls of earlier turns, read from this target's ledger (peeked while counting tokens, nothing
 * reserved or invalidated), put back into `body`; then, on Vertex, the OpenAI Responses tool-call ids are stripped, which needs
 * the reserved ids to have been resolved first. Imagen and a variant without a ledger skip the replay.
 */
export const applyReasoningReplay = Effect.fnUntraced(function* (
  variant: GoogleVariant,
  request: ExecutorRequest,
  options: ExecutorOptions,
  baseModel: string,
  body: Json,
  mode: "generate" | "stream" | "count",
) {
  let replayed = body;
  let scope: ReplayScope = NO_REPLAY_SCOPE;
  let accumulator: ReplayAccumulator | undefined;
  const envelope = variant.replayLedger === undefined ? undefined : replayEnvelope(replayed);

  if (variant.replayLedger !== undefined && envelope !== undefined) {
    const reserve = mode !== "count";

    const prepared = yield* prepareReplayPayload(
      variant.replayLedger,
      baseModel,
      request,
      options,
      envelope,
      { reserve, normalizeRoles: false, executor: `${variant.identifier} executor` },
    );

    const contents = get(prepared.payload, "request.contents");

    if (
      contents !== undefined &&
      JSON.stringify(contents) !== JSON.stringify(get(replayed, "contents"))
    ) {
      replayed = set(replayed, "contents", contents);

      // A replayed signature is a Vertex one on the Gemini API only if another target issued it.
      if (!variant.vertex) sanitizeNonVertexGeminiRequestThoughtSignatures(replayed, "contents");
    }

    if (reserve) {
      scope = prepared.scope;
      accumulator = makeAccumulator(prepared.scope, replayEnvelope(replayed) ?? envelope);
    }
  }

  if (variant.vertex) {
    replayed = stripVertexOpenAIResponsesToolCallIds(replayed, options.sourceFormat);
  }

  return { body: replayed, scope, accumulator } satisfies AppliedReplay;
});
