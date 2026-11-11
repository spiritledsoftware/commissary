/**
 * Final payload barrier shared by executors.
 *
 * Go source: internal/runtime/executor/helps/payload_helpers.go (ApplyPayloadConfigWithTrackedPathsForExecutor: Codex
 * tool integer normalisation for Codex clients when the target executor is not Codex) and payload_finalizer.go.
 * Executors call {@link finalizePayload} as the very last business-payload mutation (AGENTS.md).
 */
import { applyPayloadRules, type PayloadRequest } from "../../config/payload/index.ts";
import type { Config } from "../../config/schema.ts";
import type { Json } from "@commissary/json";
import type { UsageReporter } from "../../usage/reporter.ts";
import { isCodexUserAgent, normalizeCodexToolIntegerTypes } from "./codex-tool-schema.ts";

const isCodexTargetExecutor = (executor: string): boolean => {
  const name = executor.trim().toLowerCase();

  return name === "codex" || name === "codex-websockets" || name === "codex_websockets";
};

/**
 * Applies the user payload rules to the final business payload (mutated in place). For requests from Codex clients
 * that target a non-Codex executor, tool parameters declared as `number` are first normalised to `integer`. The outbound
 * `service_tier` is handed to `usage` (the record reports it instead of the client's).
 */
export const finalizePayload = (
  config: Config,
  targetExecutor: string,
  request: PayloadRequest,
  payload: Json,
  usage: Pick<UsageReporter, "setServiceTierFromBody">,
): Json => {
  if (isCodexUserAgent(request.headers) && !isCodexTargetExecutor(targetExecutor)) {
    normalizeCodexToolIntegerTypes(payload, request.headers);
  }

  const final = applyPayloadRules(config, request, payload).payload;
  // The usage record reports the tier that went out, so every executor records it here, after the rules (CLIProxyAPI
  // 07b5a7a1) rather than each remembering to.
  usage.setServiceTierFromBody(final);

  return final;
};
