/**
 * Responses API boundary preparation for official Codex clients.
 *
 * Go source: sdk/api/handlers/openai/openai_responses_handlers.go (`prepareCodexMultiAgentV2Tools`,
 * `prepareCodexOrphanDelegation`; called by Responses, Compact and the WebSocket frames). The collaboration tools are
 * prepared once here (available models listed in `spawn_agent`, message encryption removed) so every provider the request
 * is routed to sees readable definitions; executors repeat the idempotent parts they need.
 */
import { Effect } from "effect";
import type { HeaderInput } from "../../config/payload/index.ts";
import {
  codexMultiAgentV2Enabled,
  prepareCodexMultiAgentV2Tools,
  rewriteCodexOrphanDelegationInputForConfig,
} from "../../executor/helps/codex-multi-agent-v2.ts";
import type { Config } from "../../config/schema.ts";
import { get, type Json } from "@commissary/json";
import { sanitizeOrphanResponsesToolOutputs } from "@commissary/translation";
import { currentConfig } from "../request.ts";
import { ModelProviders } from "../model-providers.ts";

/**
 * Mutates the parsed Responses `body` in place: orphan delegations (config opt-in), tool outputs without a call_id
 * (always) and the multi-agent v2 tool preparation only when `tools` (Responses and WebSocket frames, not
 * `/responses/compact`). Never fails: a missing registry only skips the model list.
 */
export const prepareCodexResponsesRequest = (body: Json, headers: HeaderInput, tools: boolean) =>
  Effect.gen(function* () {
    const config = yield* Effect.orElseSucceed(currentConfig, () => undefined);

    if (config !== undefined) yield* prepareConfigured(body, headers, tools, config);

    // After the orphan delegation rewrite, which owns the `codex_app` outputs this leaves alone (05e668cf).
    sanitizeOrphanResponsesToolOutputs(get(body, "input"));
  });

const prepareConfigured = (body: Json, headers: HeaderInput, tools: boolean, config: Config) =>
  Effect.gen(function* () {
    if (tools && codexMultiAgentV2Enabled(headers, config)) {
      const providers = yield* ModelProviders;

      const source =
        providers.spawnAgentSource === undefined
          ? undefined
          : yield* Effect.orElseSucceed(providers.spawnAgentSource, () => undefined);

      prepareCodexMultiAgentV2Tools(headers, body, true, source);
    }

    rewriteCodexOrphanDelegationInputForConfig(headers, body, config);
  });
