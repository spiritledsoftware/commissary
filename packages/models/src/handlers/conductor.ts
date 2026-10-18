/**
 * The execution conductor: retry rounds across credentials, alias-pool rotation, request-scoped error rules,
 * cooldown waits and attempt reporting.
 *
 * Go source: sdk/cliproxy/auth/conductor_execution.go (Execute/ExecuteStream, executeMixedOnce,
 * executeStreamMixedOnce, preferredExecutionAttemptError), conductor_stream.go (executeStreamWithModelPool,
 * readStreamBootstrap, wrapStreamResult), conductor_selection.go (shouldRetryAfterErrorWithAttempted, jitteredCooldownWait,
 * waitForCooldown), conductor_models.go (force-mapping rewrite). Docs: credentials.md §7.
 *
 * Shape: `conduct` runs rounds; a round picks credentials one after another (`tried` grows, no sleep) until one
 * succeeds, a stop condition hits or nothing is selectable; between rounds the ControlPlane decides (`planRetry`)
 * whether to go on and for how long to wait. The caller supplies `run`, the execution of one (credential, upstream
 * model) attempt; it owns what is specific to non-stream and stream execution.
 *
 * Workers limits (deviation from Go, which can wait and retry without bound): at most {@link MAX_UPSTREAM_ATTEMPTS}
 * upstream attempts per request (each costs subrequests: pick, fetch, report) and cooldown waits of at most
 * {@link MAX_COOLDOWN_WAIT_MS}; a longer recovery is answered with the last error plus `Retry-After`.
 */
import { Clock, Duration, Effect, Option, Random, Result, Scope } from "effect";
import type { Config } from "../config/schema.ts";
import type { RetryPlan } from "../credentials/selection/retry.ts";
import { ExecutionError, withErrorFields } from "../executor/errors.ts";
import {
  failureReport,
  isCompactRequestFault,
  isRequestInvalid,
  isRetryRoundError,
  isStopAction,
  matchRequestScopedAction,
  requestScopedRules,
  type RequestScopedAction,
  successReport,
} from "../executor/classify.ts";
import { withCredentialRefresh } from "../executor/helps/credential-refresh.ts";
import {
  CredentialPicker,
  type CredentialSnapshot,
  type PickResult,
  type PickSession,
} from "../executor/picker.ts";
import {
  creditsEnabled,
  creditsModel,
  shouldAttemptCreditsFallback,
} from "../executor/antigravity/credits.ts";
import { antigravityStateFor, creditsAvailable } from "../executor/antigravity/state.ts";
import { ExecutorRegistry } from "../executor/registry.ts";
import { parseSuffix } from "@commissary/translation/thinking";
import type {
  ExecutionContext,
  ExecutorOptions,
  ExecutorRequest,
  ProviderExecutor,
} from "../executor/types.ts";
import type { Json } from "@commissary/json";
import { holdInvocation, CurrentOrg, type OrgId } from "@commissary/core";
import { noteSelection, notePrincipal, RequestTrace } from "../observability/trace.ts";
import type { SessionRouting } from "../session-routing/routing.ts";
import { UsageReporter } from "../usage/reporter.ts";
import { priceForSpend, UsageSink } from "../usage/sink.ts";
import { ModelCapabilities } from "./model-capabilities.ts";
import { ModelsEnv } from "../env.ts";

/** Upstream attempts (executor calls) allowed for one request. */
export const MAX_UPSTREAM_ATTEMPTS = 16;

/** Longest cooldown the Worker waits for before answering with `Retry-After` instead. */
export const MAX_COOLDOWN_WAIT_MS = 30_000;

/** `cooldownWaitJitterCap`. */
const JITTER_CAP_MS = 2000;

export interface RetrySettings {
  readonly requestRetry: number;
  /** `max-retry-credentials`; 0 = unlimited. */
  readonly maxRetryCredentials: number;
  /** `max-retry-interval` in ms, clamped to the Workers wait cap; 0 = never wait. */
  readonly maxWaitMs: number;
}

/** `SetRetryConfig` (negative values clamp to 0) plus the Workers wait cap. */
export const retrySettings = (config: Config): RetrySettings => {
  const retry = config.routing.retry;
  const waitMs = Math.max(0, retry["max-retry-interval"]) * 1000;

  return {
    requestRetry: Math.max(0, retry["request-retry"]),
    maxRetryCredentials: Math.max(0, retry["max-retry-credentials"]),
    maxWaitMs: Math.min(waitMs, MAX_COOLDOWN_WAIT_MS),
  };
};

/** `jitteredCooldownWait`: spreads concurrent waiters, never beyond `maxWait`. */
export const jitteredWait = (waitMs: number, maxWaitMs: number, unit: number): number => {
  if (waitMs <= 0) return waitMs;
  let range = Math.min(waitMs / 4, JITTER_CAP_MS);

  if (maxWaitMs > 0 && range > maxWaitMs - waitMs) range = maxWaitMs - waitMs;

  return range <= 0 ? waitMs : waitMs + unit * range;
};

/** Usage fields of the session and upstream base URL of an attempt (`syncMetadataSessionToContext`, `BaseURL`). */
const usageSession = (
  routing: SessionRouting | undefined,
  picked: PickResult,
  credential: CredentialSnapshot,
) => {
  const session = picked.session ?? routing?.usageSession;

  const baseUrl =
    (credential.attributes["base_url"] ?? "").trim() || stringOf(credential.metadata["base_url"]);

  return {
    ...(session === undefined ? {} : { sessionId: session.id }),
    ...(session?.parentId === undefined || session.parentId === session.id
      ? {}
      : { parentSessionId: session.parentId }),
    ...(baseUrl === "" ? {} : { baseUrl }),
  };
};

const stringOf = (value: Json | undefined): string =>
  typeof value === "string" ? value.trim() : "";

/** What the conductor needs to know about the request (built by `handlers/execute.ts`). */
export interface Prepared {
  readonly config: Config;
  readonly providers: ReadonlyArray<string>;
  readonly routeModel: string;
  readonly body: Json;
  /** The model string as the client sent it (usage alias). */
  readonly clientModel: string;
  readonly options: ExecutorOptions;
  readonly stream: boolean;
  readonly principalId: string;
  /** The request's org (usage `org_id`). */
  readonly orgId: OrgId;
  /** The caller's member id in the org (usage `member_id`), when they have one. */
  readonly memberId?: string;
  /** The API key the request came with (Spend limits of a key apply to everything it spends; issue #71). */
  readonly apiKeyId?: string;
  readonly callerScope: string;
  readonly endpoint: string;
  readonly session: PickSession | undefined;
  /** LCP fingerprints, derived identity and usage session (see `session-routing/routing.ts`). */
  readonly routing?: SessionRouting;
  readonly pinnedId?: string | undefined;
  /** Skip free-plan Codex credentials. */
  readonly disallowFreeAuth?: boolean;
  /** Select credentials as if for this model while executing `routeModel` (Go `auth_selection_model`). */
  readonly selectionModel?: string;
  /** Downstream WebSocket request: prefer Codex credentials with `websockets` enabled. */
  readonly preferWebsockets?: boolean;
  /** Observes the credential of each attempt (the Responses WebSocket handler pins/tracks it). */
  readonly onSelected?: (credential: CredentialSnapshot) => void;
  /** Token counting (Go `ExecuteCount`): no passive quota snapshot, generic endpoint 404s are availability-neutral. */
  readonly countTokens?: boolean;
}

/**
 * Executor options of an attempt: the request's own options, plus the credits flag during the Antigravity credits
 * fallback round (Go `cliproxyauth.WithAntigravityCredits`).
 */
export const attemptOptions = (prepared: Prepared, attempt: Attempt): ExecutorOptions =>
  attempt.credits
    ? { ...prepared.options, metadata: { ...prepared.options.metadata, antigravityCredits: true } }
    : prepared.options;

/** One credential/upstream-model attempt handed to `run`. */
export interface Attempt {
  readonly picked: PickResult;
  readonly executor: ProviderExecutor;
  readonly upstreamModel: string;
  readonly request: ExecutorRequest;
  /** Credential, config and usage of the running attempt; replaced when the credential is prepared or refreshed. */
  context: ExecutionContext;
  /** Client-facing alias for `force-mapping` (empty when the response must keep the upstream model). */
  readonly rewriteTo: string;
  /** Closes the usage record of an attempt rejected with 401 and returns the context of its repeat. */
  readonly restart: (
    error: ExecutionError,
    refreshed: CredentialSnapshot,
  ) => Effect.Effect<ExecutionContext>;
  /** Antigravity credits fallback round: the executor adds `enabledCreditTypes` (see {@link attemptOptions}). */
  readonly credits: boolean;
  /** Set by `run` when a stream failed before its first byte (handler-level bootstrap retries apply). */
  bootstrapFailed: boolean;
  /**
   * Reports the end of the attempt (once): picker bookkeeping plus the usage record. Returns the request-scoped
   * rule action that matched the error, if any.
   */
  readonly finish: (
    error: ExecutionError | undefined,
    headers?: Headers,
  ) => Effect.Effect<RequestScopedAction | undefined, never, ModelsEnv | CurrentOrg>;
}

export type ConductResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: ExecutionError; readonly bootstrap: boolean };

type RoundOutcome<T> =
  | { readonly ok: true; readonly value: T }
  | {
      readonly ok: false;
      readonly error: ExecutionError;
      /** Do not retry (request stop, request-invalid error, ...). */
      readonly stop: boolean;
      /** `error` came from an actual upstream attempt. */
      readonly upstream: boolean;
      readonly bootstrap: boolean;
      readonly attempted: ReadonlyArray<string>;
    };

/** The error of a client abort: reported as a connection-lifecycle failure (no cooldown). */
export const lifecycleError = (): ExecutionError =>
  new ExecutionError({
    status: 499,
    code: "connection_lifecycle",
    message: "client closed request",
  });

const authNotFound = (): ExecutionError =>
  new ExecutionError({ status: 503, code: "auth_not_found", message: "no auth available" });

/** Adds `Retry-After` to a final 429/503/529 (TypeSafe's overload) when a credential recovery time is known (seconds, rounded up). */
const withRetryAfter = (
  error: ExecutionError,
  retryAfterMs: number | undefined,
): ExecutionError => {
  if (retryAfterMs === undefined || retryAfterMs <= 0) return error;

  if (error.status !== 429 && error.status !== 503 && error.status !== 529) return error;
  const existing = error.safeHeaders ?? {};

  if (existing["retry-after"] !== undefined || existing["Retry-After"] !== undefined) return error;

  return withErrorFields(error, {
    safeHeaders: {
      ...existing,
      "retry-after": String(Math.max(1, Math.ceil(retryAfterMs / 1000))),
    },
  });
};

/**
 * Runs `run` over credentials until it succeeds. `run` must fail with an `ExecutionError` (never defects) and call
 * `attempt.finish` itself on success; the conductor calls it for failures.
 */
export const conduct = <T, R>(
  prepared: Prepared,
  run: (attempt: Attempt) => Effect.Effect<T, ExecutionError, R>,
) =>
  Effect.gen(function* () {
    const picker = yield* CredentialPicker;
    const executors = yield* ExecutorRegistry;
    const sink = yield* UsageSink;
    const capabilities = yield* ModelCapabilities;
    const trace = yield* RequestTrace;
    yield* notePrincipal(prepared.principalId);
    const settings = retrySettings(prepared.config);
    const compact = prepared.options.alt === "responses/compact";
    let upstreamAttempts = 0;

    const buildAttempt = (
      picked: PickResult,
      executor: ProviderExecutor,
      upstreamModel: string,
      credits = false,
    ) =>
      Effect.gen(function* () {
        const { credential, route, lease } = picked;

        const newUsage = (now: number) =>
          new UsageReporter({
            requestId: crypto.randomUUID(),
            ...(trace === undefined ? {} : { traceId: trace.requestId }),
            provider: credential.provider,
            executorType: executor.identifier,
            model: parseSuffix(upstreamModel).modelName,
            alias: prepared.clientModel,
            endpoint: prepared.endpoint,
            principalId: prepared.principalId,
            orgId: prepared.orgId,
            ...(prepared.memberId === undefined ? {} : { memberId: prepared.memberId }),
            ...(credential.private === true ? { private: true } : {}),
            authId: credential.id,
            authType: credential.kind,
            source: credential.label ?? credential.id,
            stream: prepared.stream,
            generate: prepared.options.metadata.generate,
            serviceTier: prepared.options.metadata.serviceTier,
            ...(prepared.options.metadata.reasoningEffort !== undefined
              ? { reasoningEffort: prepared.options.metadata.reasoningEffort }
              : {}),
            requestedAt: now,
            ...usageSession(prepared.routing, picked, credential),
          });

        yield* noteSelection(
          credential.id,
          credential.provider,
          parseSuffix(upstreamModel).modelName,
        );

        const { modelInfo, lookup } = yield* capabilities.thinking(
          parseSuffix(upstreamModel).modelName,
          credential,
        );

        const stateModel = route.pooled ? upstreamModel : undefined;
        // The report and the usage record of an attempt must survive a client disconnect (a cancelled streamed body
        // is finalised asynchronously, after the response): hold the invocation open until `finish` completed. A
        // safety net releases the hold when the request scope closes without `finish` ever starting.
        const release = yield* holdInvocation;
        let finished = false;
        const requestScope = yield* Effect.serviceOption(Scope.Scope);

        if (Option.isSome(requestScope)) {
          yield* Scope.addFinalizer(
            requestScope.value,
            Effect.sync(() => {
              if (!finished) release();
            }),
          );
        }

        const finish = (error: ExecutionError | undefined, headers?: Headers) =>
          Effect.gen(function* () {
            if (finished) return undefined;
            finished = true;

            const action =
              error === undefined
                ? undefined
                : matchRequestScopedAction(requestScopedRules(prepared.config, credential), error);

            const usage = attempt.context.usage;

            if (error !== undefined) usage.fail(error.status, error.message, error.code);

            const context = {
              provider: credential.provider,
              ...(stateModel === undefined ? {} : { stateModel }),
              ...(compact ? { compact: true } : {}),
              ...(prepared.countTokens === true ? { countTokens: true } : {}),
            };

            // A refresh replaces the token material: report against the credential version that was actually used.
            const version = attempt.context.credential.credentialVersion ?? lease.credentialVersion;

            // The records are built first: the Cost of the attempt is charged to the Spend limits by the report.
            const finishedAt = yield* Clock.currentTimeMillis;
            const record = usage.finish(finishedAt);
            const extras = record === undefined ? [] : usage.additionalRecords(finishedAt);
            const records = record === undefined ? [] : [record, ...extras];

            // Only an attempt under a Spend limit is priced here; the others are priced when they are stored.
            const priced =
              lease.spend === undefined || lease.spend.length === 0
                ? { records, costMicros: undefined }
                : yield* priceForSpend(sink, records);

            yield* picker.report(
              {
                ...lease,
                credentialVersion: version,
              },
              {
                ...(error === undefined
                  ? successReport({ ...context, headers })
                  : failureReport(error, { ...context, action })),
                ...(priced.costMicros === undefined ? {} : { costMicros: priced.costMicros }),
              },
            );

            for (const published of priced.records) yield* sink.publish(published);

            return action;
          }).pipe(Effect.ensuring(Effect.sync(release)));

        const attempt: Attempt = {
          picked,
          executor,
          upstreamModel,
          request: { model: upstreamModel, payload: prepared.body, modelInfo, modelLookup: lookup },
          context: {
            credential,
            config: prepared.config,
            usage: newUsage(yield* Clock.currentTimeMillis),
          },
          rewriteTo:
            route.forceMapping && route.originalAlias.trim() !== "" ? route.originalAlias : "",
          credits,
          bootstrapFailed: false,
          finish,
          restart: (error, refreshed) =>
            Effect.gen(function* () {
              // The rejected attempt keeps its own (failed) usage record; the repeat starts a fresh one.
              const rejected = attempt.context.usage;
              rejected.fail(error.status, error.message, error.code);
              const record = rejected.finish(yield* Clock.currentTimeMillis);

              if (record !== undefined) yield* sink.publish(record);
              attempt.bootstrapFailed = false;

              return {
                ...attempt.context,
                credential: refreshed,
                usage: newUsage(yield* Clock.currentTimeMillis),
              };
            }),
        };

        return attempt;
      });

    /** Stored balance of a credential: `undefined` = unknown, otherwise whether it can pay (`creditsAvailable`). */
    const creditsBalance = (credentialId: string) =>
      Effect.gen(function* () {
        const env = yield* ModelsEnv;
        const org = yield* CurrentOrg;

        const record = yield* Effect.promise(() =>
          antigravityStateFor(env, org).credits(credentialId),
        );

        return record === undefined ? undefined : creditsAvailable(record);
      });

    /** One retry round: pick credentials until success, a stop condition, or nothing left. */
    const runRound = (round: number, credits = false) =>
      Effect.gen(function* () {
        const tried: string[] = [];
        const attempted: string[] = [];
        let lastError: ExecutionError | undefined;
        let upstreamError: ExecutionError | undefined;
        let bootstrap = false;

        const failed = (error: ExecutionError, stop: boolean): RoundOutcome<T> => ({
          ok: false,
          error,
          stop,
          upstream: upstreamError !== undefined && upstreamError === error,
          bootstrap,
          attempted,
        });

        /** `preferredExecutionAttemptError`: the last error that actually reached an upstream wins. */
        const preferred = (fallback: ExecutionError): ExecutionError => upstreamError ?? fallback;

        const pickNext = (excludedIds: ReadonlyArray<string>) =>
          Effect.result(
            picker.pick({
              providers: credits ? ["antigravity"] : prepared.providers,
              model: prepared.routeModel,
              ...(credits ? { ignoreCooldown: true } : {}),
              callerScope: prepared.callerScope,
              ...(prepared.memberId === undefined ? {} : { memberId: prepared.memberId }),
              ...(prepared.apiKeyId === undefined ? {} : { apiKeyId: prepared.apiKeyId }),
              excludedIds,
              retryRound: round,
              requestRetry: settings.requestRetry,
              ...(prepared.session === undefined ? {} : { session: prepared.session }),
              ...(prepared.routing?.lcp === undefined ? {} : { lcp: prepared.routing.lcp }),
              ...(prepared.routing?.fallbackSession === undefined
                ? {}
                : { fallbackSession: prepared.routing.fallbackSession }),
              ...(prepared.pinnedId === undefined ? {} : { pinnedId: prepared.pinnedId }),
              ...(prepared.disallowFreeAuth === true ? { disallowFreeAuth: true } : {}),
              ...(prepared.preferWebsockets === true ? { preferWebsockets: true } : {}),
              ...(prepared.selectionModel === undefined
                ? {}
                : { selectionModel: prepared.selectionModel }),
            }),
          );

        /**
         * `findAllAntigravityCreditsCandidateAuths`: the credits round walks every Antigravity credential once, in a
         * fixed order: credentials whose stored balance can pay first, then those with an unknown balance (optimistic),
         * each group sorted by id. Credentials known to be out of credits are not attempts and are never penalised.
         */
        let creditsQueue: Array<PickResult> | undefined;
        let creditsFailure: ExecutionError | undefined;

        const nextCreditsPick = Effect.gen(function* () {
          if (creditsQueue === undefined) {
            const known: Array<PickResult> = [];
            const unknown: Array<PickResult> = [];
            const excluded: string[] = [];

            while (true) {
              const candidate = yield* pickNext(excluded);

              if (Result.isFailure(candidate)) {
                creditsFailure = candidate.failure;
                break;
              }

              excluded.push(candidate.success.credential.id);
              const available = yield* creditsBalance(candidate.success.credential.id);

              if (available === undefined) unknown.push(candidate.success);
              else if (available) known.push(candidate.success);
              else {
                yield* picker.report(
                  candidate.success.lease,
                  failureReport(lifecycleError(), {
                    provider: candidate.success.credential.provider,
                  }),
                );
              }
            }

            const byId = (a: PickResult, b: PickResult) =>
              a.credential.id < b.credential.id ? -1 : a.credential.id > b.credential.id ? 1 : 0;

            creditsQueue = [...known.sort(byId), ...unknown.sort(byId)];
          }

          const next = creditsQueue.shift();

          return next === undefined
            ? Result.fail(creditsFailure ?? authNotFound())
            : Result.succeed(next);
        });

        while (true) {
          if (
            settings.maxRetryCredentials > 0 &&
            attempted.length >= settings.maxRetryCredentials
          ) {
            return failed(lastError === undefined ? authNotFound() : preferred(lastError), false);
          }

          if (upstreamAttempts >= MAX_UPSTREAM_ATTEMPTS) {
            return failed(lastError === undefined ? authNotFound() : preferred(lastError), true);
          }

          const pick = yield* credits ? nextCreditsPick : pickNext(tried);

          if (Result.isFailure(pick)) {
            // Without an earlier upstream error the selection failure itself is the answer. A Spend limit is the
            // request's, not a credential's: no other round or credential changes it, so the request stops here.
            return failed(
              lastError === undefined ? pick.failure : preferred(lastError),
              pick.failure.code === "spend_limit_reached",
            );
          }

          const picked = pick.success;
          tried.push(picked.credential.id);
          const executor = executors.get(picked.credential.provider);

          if (executor === undefined) {
            const error = new ExecutionError({
              status: 500,
              code: "executor_not_found",
              message: "executor not registered",
            });

            yield* picker.report(
              picked.lease,
              failureReport(error, { provider: picked.credential.provider }),
            );

            return failed(error, false);
          }

          const models = picked.route.upstreamModels;

          if (models.length === 0) continue;
          attempted.push(picked.credential.id);

          let credentialError: ExecutionError | undefined;

          for (const upstreamModel of models) {
            upstreamAttempts += 1;
            const attempt = yield* buildAttempt(picked, executor, upstreamModel, credits);

            // Prepares the credential (`prepareRequestAuth`) and, after a 401, refreshes it and repeats the attempt once
            // (`tryRefreshAfterUnauthorized`) before the failure is reported.
            const result = yield* Effect.result(
              withCredentialRefresh(
                attempt.context,
                (context) => {
                  attempt.context = context;

                  return run(attempt);
                },
                { retry: attempt.restart },
              ).pipe(Effect.onInterrupt(() => attempt.finish(lifecycleError()))),
            );

            if (Result.isSuccess(result))
              return { ok: true, value: result.success } satisfies RoundOutcome<T>;

            const error = result.failure;
            upstreamError = error;
            bootstrap = attempt.bootstrapFailed;
            const action = yield* attempt.finish(error);

            if (isStopAction(action)) return failed(error, true);

            if (
              action === undefined &&
              (isCompactRequestFault(error, prepared.options.alt) || isRequestInvalid(error))
            ) {
              // A request fault: no rotation, no penalty.
              return failed(error, true);
            }

            credentialError = error;

            // Credential-wide failures (quota windows) skip the remaining models of the pool.
            if (error.credentialScoped === true) break;
          }

          if (credentialError !== undefined) lastError = credentialError;
        }
      });

    const NO_RETRY: RetryPlan = { retry: false };

    /** `shouldRetryAfterErrorWithAttempted`: class check here, cooldown knowledge in the ControlPlane. */
    const nextRound = (outcome: Extract<RoundOutcome<T>, { ok: false }>, round: number) =>
      Effect.gen(function* () {
        const error = outcome.error;

        if (outcome.stop || isRequestInvalid(error) || !isRetryRoundError(error)) return NO_RETRY;

        const plan = yield* picker.planRetry({
          providers: prepared.providers,
          model: prepared.routeModel,
          round,
          requestRetry: settings.requestRetry,
          status: error.code === "transient_transport" ? 0 : error.status,
          attempted: outcome.attempted,
          ...(error.retryAfterMs === undefined ? {} : { retryAfterMs: error.retryAfterMs }),
          maxWaitMs: settings.maxWaitMs,
          ...(prepared.pinnedId === undefined ? {} : { pinnedAuthId: prepared.pinnedId }),
          ...(prepared.memberId === undefined ? {} : { memberId: prepared.memberId }),
          ...(prepared.disallowFreeAuth === true ? { disallowFreeCodex: true } : {}),
        });

        return plan;
      });

    let preferredUpstream: ExecutionError | undefined;
    let lastFailure: Extract<RoundOutcome<T>, { ok: false }> | undefined;
    let recoveryHintMs: number | undefined;

    for (let round = 0; ; round += 1) {
      const outcome = yield* runRound(round);

      if (outcome.ok) return { ok: true, value: outcome.value } satisfies ConductResult<T>;

      if (outcome.upstream) preferredUpstream = outcome.error;
      lastFailure = outcome;

      if (outcome.stop) break;
      const plan = yield* nextRound(outcome, round);

      if (!plan.retry) {
        recoveryHintMs = plan.retryAfterMs;
        break;
      }

      if (upstreamAttempts >= MAX_UPSTREAM_ATTEMPTS) break;

      if (plan.waitMs > 0) {
        const unit = yield* Random.next;
        yield* Effect.sleep(Duration.millis(jitteredWait(plan.waitMs, settings.maxWaitMs, unit)));
      }
    }

    const last = lastFailure;
    // Stops return their own error; exhausted retries answer with the error of the last real upstream attempt.
    const error = last.stop ? last.error : (preferredUpstream ?? last.error);

    // Google One AI credits (`quota-exceeded.antigravity-credits`): after the normal rotation failed for capacity
    // reasons, Claude models get one more pass over the Antigravity credentials with credits enabled.
    if (
      !last.stop &&
      error.status !== 499 &&
      creditsEnabled(prepared.config) &&
      prepared.providers.some((provider) => provider.trim().toLowerCase() === "antigravity") &&
      creditsModel(parseSuffix(prepared.routeModel).modelName) &&
      shouldAttemptCreditsFallback(error)
    ) {
      const credited = yield* runRound(0, true);

      if (credited.ok) return { ok: true, value: credited.value } satisfies ConductResult<T>;
    }

    return {
      ok: false,
      error: withRetryAfter(error, recoveryHintMs),
      bootstrap: last.bootstrap,
    } satisfies ConductResult<T>;
  });
