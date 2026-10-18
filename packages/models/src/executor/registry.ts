/**
 * Provider key -> executor lookup.
 *
 * Go source: sdk/cliproxy/service.go (executor registration per provider; one OpenAI-compatible executor per
 * `openai-compatibility` entry, keyed by `util.OpenAICompatibleProviderKey`). Provider slices register their
 * executors in {@link makeExecutorRegistry}.
 */
import { Context, Effect, Layer } from "effect";
import { makeAntigravityExecutor } from "./antigravity/executor.ts";
import { makeClaudeExecutor } from "./claude/executor.ts";
import { makeCodexExecutor } from "./codex/executor.ts";
import { makeDevinExecutor } from "./devin/executor.ts";
import {
  makeGeminiExecutor,
  makeGeminiInteractionsExecutor,
  makeVertexExecutor,
} from "./gemini/index.ts";
import { withProviderKeyScope } from "./helps/oauth-scope.ts";
import { makeKimiExecutor } from "./kimi/executor.ts";
import { makeMetaExecutor } from "./meta/executor.ts";
import { makeOpenAICompatExecutor } from "./openai-compat/executor.ts";
import { makeOpenCodeExecutor } from "./opencode/executor.ts";
import { OPENCODE_GO, OPENCODE_ZEN } from "./opencode/providers.ts";
import { makeSystemOneExecutor } from "./systemone/executor.ts";
import { SUBQ, TYPESAFE } from "./systemone/providers.ts";
import { SYSTEM_ONE_SPECS } from "./systemone/specs.ts";
import { makeXaiExecutor } from "./xai/executor.ts";
import { EntryOnlyFormats } from "@commissary/translation/formats";
import { type ExecutionError, notImplemented } from "./errors.ts";
import type { ExecutorOptions, ProviderExecutor } from "./types.ts";

export class ExecutorRegistry extends Context.Service<
  ExecutorRegistry,
  {
    /** The executor for a credential's provider key, if any. */
    readonly get: (provider: string) => ProviderExecutor | undefined;
  }
>()("commissary/executor/ExecutorRegistry") {
  static readonly layer = Layer.sync(ExecutorRegistry, () =>
    ExecutorRegistry.of(makeExecutorRegistry()),
  );
}

const isOpenAICompatProvider = (provider: string): boolean =>
  provider === "openai-compatibility" || provider.startsWith("openai-compatible-");

/** Fixed provider keys (one executor each). */
const FIXED_EXECUTORS = new Map<string, () => ProviderExecutor>([
  ["antigravity", makeAntigravityExecutor],
  ["codex", makeCodexExecutor],
  ["xai", makeXaiExecutor],
  ["claude", makeClaudeExecutor],
  ["gemini", makeGeminiExecutor],
  ["gemini-interactions", makeGeminiInteractionsExecutor],
  ["vertex", makeVertexExecutor],
  ["devin", makeDevinExecutor],
  ["meta", makeMetaExecutor],
  ["kimi", makeKimiExecutor],
  ["kimi-ai", makeKimiExecutor],
  [OPENCODE_ZEN, () => makeOpenCodeExecutor(OPENCODE_ZEN)],
  [OPENCODE_GO, () => makeOpenCodeExecutor(OPENCODE_GO)],
  [TYPESAFE, () => makeSystemOneExecutor(SYSTEM_ONE_SPECS[TYPESAFE])],
  [SUBQ, () => makeSystemOneExecutor(SYSTEM_ONE_SPECS[SUBQ])],
]);

/**
 * Provider keys whose executor serves System One requests (ADR 0032). Every other executor refuses the `systemone`
 * source format (501) before doing anything, whatever the model guard let through.
 */
export const SYSTEM_ONE_EXECUTORS: ReadonlySet<string> = new Set([TYPESAFE, SUBQ]);

/** `executor` with `systemone` requests refused (501, request-scoped). */
const withoutSystemOne = (executor: ProviderExecutor): ProviderExecutor => {
  const guarded = <A, E, R>(
    options: ExecutorOptions,
    run: () => Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E | ExecutionError, R> =>
    options.sourceFormat === EntryOnlyFormats.SystemOne
      ? Effect.fail(notImplemented(`${executor.identifier} does not serve System One requests`))
      : run();

  return {
    identifier: executor.identifier,
    execute: (context, request, options) =>
      guarded(options, () => executor.execute(context, request, options)),
    executeStream: (context, request, options) =>
      guarded(options, () => executor.executeStream(context, request, options)),
    countTokens: (context, request, options) =>
      guarded(options, () => executor.countTokens(context, request, options)),
  };
};

export const makeExecutorRegistry = () => {
  const cache = new Map<string, ProviderExecutor>();

  return {
    get: (provider: string): ProviderExecutor | undefined => {
      const key = provider.trim().toLowerCase();
      const cached = cache.get(key);

      if (cached !== undefined) return cached;
      const fixed = FIXED_EXECUTORS.get(key);

      if (fixed === undefined && !isOpenAICompatProvider(key)) return undefined;
      const base = fixed === undefined ? makeOpenAICompatExecutor(key) : fixed();
      const executor = SYSTEM_ONE_EXECUTORS.has(key) ? base : withoutSystemOne(base);
      // `ForAPIKey` (oauth_scope_executor.go): provider-key credentials see the config without OAuth-only settings.
      const scoped = withProviderKeyScope(key, executor);
      cache.set(key, scoped);

      return scoped;
    },
  };
};
