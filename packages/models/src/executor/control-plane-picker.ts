/**
 * {@link CredentialPicker} over the ControlPlane Durable Object RPC (`pick`, `report`, `planRetry`).
 *
 * Selection, cooldowns, quota and session affinity live in the DO (credentials.md §6, §8); this adapter only maps
 * between the DO wire types and the executor-facing contract. The DO stub is resolved from the per-request
 * `ModelsEnv` and `CurrentOrg` on every call, never captured in a layer.
 */
import { Effect, Layer } from "effect";
import type {
  Lease,
  PickFailure,
  PickRequest as WirePickRequest,
  PickResult as WirePickResult,
  ReportOutcome,
  ReportResult,
} from "../credentials/selection/types.ts";
import type { RetryPlan, RetryQuery } from "../credentials/selection/retry.ts";
import { CurrentOrg, type OrgId } from "@commissary/core";
import { ExecutionError } from "./errors.ts";
import {
  CredentialPicker,
  type CredentialSnapshot,
  type PickRequest,
  type PickResult,
} from "./picker.ts";
import { type ModelsBindings, ModelsEnv, modelsPartOf } from "../env.ts";

/** The slice of the ControlPlane RPC surface the picker needs (tests substitute an in-memory implementation). */
export interface ControlPlaneApi {
  readonly pick: (request: WirePickRequest) => PromiseLike<WirePickResult>;
  readonly report: (lease: Lease, result: ReportResult) => PromiseLike<ReportOutcome>;
  readonly planRetry: (query: RetryQuery) => PromiseLike<RetryPlan>;
}

type WireCredential = Extract<WirePickResult, { ok: true }>["credential"];

/** Maps the DO snapshot to the executor view: `kind`, Go-style `header:<Name>` attributes and `base_url`. */
export const toExecutorSnapshot = (credential: WireCredential): CredentialSnapshot => {
  const attributes = { ...credential.attributes };

  if (credential.baseUrl !== undefined && (attributes["base_url"] ?? "").trim() === "") {
    attributes["base_url"] = credential.baseUrl;
  }

  for (const [name, value] of Object.entries(credential.headers))
    attributes[`header:${name}`] = value;
  const hasKey = (attributes["api_key"] ?? "").trim() !== "";
  const kind = credential.authKind ?? (hasKey ? "apikey" : "oauth");

  return {
    id: credential.id,
    provider: credential.executor,
    kind,
    label: credential.label,
    credentialVersion: credential.credentialVersion,
    ...(credential.owner === undefined ? {} : { private: true }),
    ...(credential.prefix === undefined || credential.prefix === ""
      ? {}
      : { prefix: credential.prefix }),
    attributes,
    metadata: credential.metadata,
  };
};

/** `PickFailure` -> client-facing error (`model_cooldown` carries its JSON body and `Retry-After`). */
export const pickFailureError = (failure: PickFailure): ExecutionError => {
  const status = failure.httpStatus ?? 503;

  return new ExecutionError({
    status,
    code: failure.code,
    message: failure.body ?? failure.message,
    ...(failure.retryAfterSeconds === undefined
      ? {}
      : {
          retryAfterMs: failure.retryAfterSeconds * 1000,
          safeHeaders: { "retry-after": String(failure.retryAfterSeconds) },
        }),
  });
};

const unavailable = (cause: unknown) =>
  new ExecutionError({
    status: 503,
    code: "auth_unavailable",
    message: "credential store unavailable",
    cause,
  });

export const makeControlPlanePicker = (api: (env: ModelsBindings, org: OrgId) => ControlPlaneApi) =>
  CredentialPicker.of({
    pick: (request: PickRequest) =>
      Effect.gen(function* () {
        const env = yield* ModelsEnv;
        const org = yield* CurrentOrg;

        const wire: WirePickRequest = {
          providers: request.providers,
          model: request.selectionModel ?? request.model,
          ...(request.excludedIds === undefined || request.excludedIds.length === 0
            ? {}
            : { tried: request.excludedIds }),
          ...(request.retryRound === undefined ? {} : { retryRound: request.retryRound }),
          ...(request.requestRetry === undefined ? {} : { requestRetry: request.requestRetry }),
          ...(request.pinnedId === undefined ? {} : { pinnedAuthId: request.pinnedId }),
          ...(request.memberId === undefined ? {} : { memberId: request.memberId }),
          ...(request.apiKeyId === undefined ? {} : { apiKeyId: request.apiKeyId }),
          ...(request.agentId === undefined ? {} : { agentId: request.agentId }),
          ...(request.disallowFreeAuth === true ? { disallowFreeCodex: true } : {}),
          ...(request.preferWebsockets === true ? { preferWebsockets: true } : {}),
          ...(request.ignoreCooldown === true ? { ignoreCooldown: true } : {}),
          ...(request.session === undefined
            ? {}
            : {
                session: {
                  id: request.session.id,
                  callerScope: request.callerScope,
                  ...(request.session.parentId === undefined
                    ? {}
                    : { parentId: request.session.parentId }),
                  ...(request.session.isFork === true ? { isFork: true } : {}),
                },
              }),
          ...(request.lcp === undefined
            ? {}
            : {
                lcp: {
                  callerScope: request.callerScope,
                  fingerprints: request.lcp.fingerprints,
                  minPrefixLength: request.lcp.minPrefixLength,
                  tailFingerprints: request.lcp.tailFingerprints,
                  envDigest: request.lcp.envDigest,
                },
              }),
          ...(request.fallbackSession === undefined
            ? {}
            : {
                fallbackSession: {
                  id: request.fallbackSession.id,
                  callerScope: request.callerScope,
                  ...(request.fallbackSession.parentId === undefined
                    ? {}
                    : { parentId: request.fallbackSession.parentId }),
                },
              }),
        };

        const result = yield* Effect.tryPromise({
          try: async () => await api(env, org).pick(wire),
          catch: unavailable,
        });

        if (!result.ok) return yield* pickFailureError(result.failure);
        const route = result.route;

        // `selectionModel` selects credentials for another model than the one executed: only the prefix is stripped.
        const upstreamModels =
          request.selectionModel === undefined || request.selectionModel === request.model
            ? route.upstreamModels
            : [stripPrefix(request.model, result.credential.prefix)];

        return {
          credential: toExecutorSnapshot(result.credential),
          lease: result.lease,
          leaseId: result.lease.id,
          route: {
            requestedModel: request.model,
            routeModel: route.routeModel,
            upstreamModels: upstreamModels.length === 0 ? [route.upstreamModel] : upstreamModels,
            originalAlias: route.originalAlias,
            forceMapping: route.forceMapping,
            stateModel: route.stateModel,
            pooled: route.pooled && request.selectionModel === undefined,
          },
          ...(result.session === undefined ? {} : { session: result.session }),
        } satisfies PickResult;
      }),
    report: (lease, result) =>
      Effect.gen(function* () {
        const env = yield* ModelsEnv;
        const org = yield* CurrentOrg;
        yield* Effect.tryPromise({
          try: async () => await api(env, org).report(lease, result),
          catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
        }).pipe(
          Effect.catch(() => Effect.logWarning(`control plane report failed (lease ${lease.id})`)),
        );
      }),
    planRetry: (query) =>
      Effect.gen(function* () {
        const env = yield* ModelsEnv;
        const org = yield* CurrentOrg;

        return yield* Effect.tryPromise({
          try: async () => await api(env, org).planRetry(query),
          catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
        }).pipe(
          // Without cooldown knowledge a retry would be a guess: stop retrying.
          Effect.catch(() => Effect.succeed<RetryPlan>({ retry: false })),
        );
      }),
  });

const stripPrefix = (model: string, prefix: string | undefined): string => {
  const needle = prefix === undefined || prefix.trim() === "" ? "" : `${prefix.trim()}/`;

  return needle !== "" && model.startsWith(needle) ? model.slice(needle.length) : model;
};

/** Production picker: the ControlPlane Durable Object of the request's org. */
export const ControlPlanePickerLayer = Layer.succeed(
  CredentialPicker,
  makeControlPlanePicker(modelsPartOf),
);
