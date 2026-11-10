/**
 * Request translation with the executor-level compatibility rewrites.
 *
 * Go source: internal/runtime/executor/helps/codex_multi_agent_v2.go (`TranslateRequestEnvelopeWithCodexMultiAgentV2`,
 * `translateRequestWithAPIKeyModelCompatibilityForExecutor`, `TranslateRequestWithAPIKeyModelCompatibilityAndUpdateIntent`)
 * and helps/model_capabilities.go (`APIKeyModelIsCompat`). Every executor that Go routes through those helpers calls
 * {@link translateRequestForExecutor} instead of `registry.translateRequest`:
 *  - Responses requests from official Codex clients get orphan delegations converted (config opt-in) and, when the
 *    target is neither Codex nor Responses, their multi-agent `agent_message` input converted to plain messages;
 *  - `is-compat` models use the registered `*WithCompat` request transforms (assistant thinking blocks survive).
 */
import type { HeaderInput } from "../../config/payload/index.ts";
import type { Config } from "../../config/schema.ts";
import { cloneJson } from "@commissary/json";
import { Formats } from "@commissary/translation/formats";
import type { RequestEnvelope, SummaryHooks, TranslatorRegistry } from "@commissary/translation";
import type { ExecutorRequest } from "../types.ts";
import {
  codexMultiAgentV2Enabled,
  rewriteCodexMultiAgentV2Input,
  rewriteCodexOrphanDelegationInputForConfig,
} from "./codex-multi-agent-v2.ts";

/** `APIKeyModelIsCompat`: the executed model was resolved with `is-compat`. */
export const modelIsCompat = (request: Pick<ExecutorRequest, "modelInfo">): boolean =>
  request.modelInfo?.isCompat === true;

export interface RequestRewriteContext {
  /** Inbound request headers (User-Agent and `X-Openai-Subagent` select the Codex rewrites). */
  readonly headers: HeaderInput;
  readonly config: Config;
  /** The executed model has `is-compat`. */
  readonly isCompat?: boolean;
  /**
   * Responses -> Claude only: whether every system-level input item stays a top-level system block (`true`) or
   * mid-session text-only items stay in place as `role: "system"` turns (`false`). Absent means top level. The Claude
   * executor decides it per attempt (`pipeline.ts`).
   */
  readonly topLevelSystemItems?: boolean;
}

/**
 * `translateRequestWithAPIKeyModelCompatibilityForExecutor` over the registry: rewrites a private copy of the body when
 * a Codex rewrite applies, then translates (compat variant when the pair has one). `from === to` pairs without a
 * transform still get the `model` forced by the registry.
 */
export const translateRequestForExecutor = (
  registry: TranslatorRegistry,
  from: string,
  to: string,
  envelope: RequestEnvelope,
  hooks: SummaryHooks,
  context: RequestRewriteContext,
): RequestEnvelope => {
  // Go: compat applies unless the target is Codex for a non-Claude client.
  const compat = context.isCompat === true && !(to === Formats.Codex && from !== Formats.Claude);
  let body = envelope.body;

  if (from === Formats.OpenAIResponse) {
    const rewriteInput =
      to !== Formats.Codex &&
      to !== Formats.OpenAIResponse &&
      (compat || codexMultiAgentV2Enabled(context.headers, context.config));

    if (context.config.upstream.codex["orphan-delegation-compatibility"] || rewriteInput) {
      body = cloneJson(body);
      rewriteCodexOrphanDelegationInputForConfig(context.headers, body, context.config);

      if (rewriteInput)
        rewriteCodexMultiAgentV2Input(context.headers, body, context.config, compat);
    }
  }

  return registry.translateRequest(from, to, { ...envelope, body }, hooks, {
    compat,
    ...(context.topLevelSystemItems === undefined
      ? {}
      : { topLevelSystemItems: context.topLevelSystemItems }),
  });
};
