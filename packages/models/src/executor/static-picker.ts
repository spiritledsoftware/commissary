/**
 * Config-only {@link CredentialPicker}: round-robin over the provider keys configured in `api-keys.openai-compatibility`.
 *
 * Test stand-in for the ControlPlane picker (no cooldowns, quota, affinity or weights). Cursors live per isolate;
 * `report` only logs failures. Only the highest-priority available credentials are used, as in Go.
 */
import { Effect, Layer } from "effect";
import { ConfigReader } from "../config/reader.ts";
import type { Config } from "../config/schema.ts";
import { canonicalModelKey } from "../credentials/selection/model-name.ts";
import { configCredentials } from "./config-credentials.ts";
import { ExecutionError } from "./errors.ts";
import { executionModelCandidates } from "./models.ts";
import { CredentialPicker, type PickRequest, type PickResult } from "./picker.ts";
import { parseSuffix } from "@commissary/translation/thinking";

const servesModel = (models: ReadonlySet<string>, model: string): boolean => {
  if (models.has(model)) return true;
  const base = parseSuffix(model).modelName;

  return models.has(base) || models.has(base.toLowerCase());
};

const candidatesOf = (config: Config, request: PickRequest) => {
  const providers = new Set(request.providers.map((provider) => provider.toLowerCase()));
  const excluded = new Set(request.excludedIds ?? []);
  const model = request.selectionModel ?? request.model;

  return configCredentials(config).filter(
    (entry) =>
      providers.has(entry.credential.provider) &&
      !excluded.has(entry.credential.id) &&
      (request.pinnedId === undefined || entry.credential.id === request.pinnedId) &&
      servesModel(entry.models, model),
  );
};

export const makeStaticCredentialPicker = Effect.fnUntraced(function* () {
  const reader = yield* ConfigReader;
  const cursors = new Map<string, number>();
  let leases = 0;

  const pick = (request: PickRequest) =>
    Effect.gen(function* () {
      if (request.providers.length === 0) {
        return yield* new ExecutionError({
          status: 500,
          code: "provider_not_found",
          message: "no provider supplied",
        });
      }

      const { config } = yield* reader.get.pipe(
        Effect.mapError(
          (cause) => new ExecutionError({ status: 503, message: "config unavailable", cause }),
        ),
      );

      const providers = new Set(request.providers.map((provider) => provider.toLowerCase()));
      const model = request.selectionModel ?? request.model;
      const candidates = candidatesOf(config, request);

      if (candidates.length === 0) {
        return yield* new ExecutionError({
          status: 503,
          code: "auth_not_found",
          message: "no auth available",
        });
      }

      const top = Math.max(...candidates.map((entry) => entry.priority));
      const pool = candidates.filter((entry) => entry.priority === top);
      const cursorKey = `${[...providers].toSorted().join(",")}\u0000${model}`;
      const cursor = cursors.get(cursorKey) ?? 0;
      cursors.set(cursorKey, (cursor + 1) % 2_147_483_647);
      const chosen = pool[cursor % pool.length];

      if (chosen === undefined) {
        return yield* new ExecutionError({
          status: 503,
          code: "auth_not_found",
          message: "no auth available",
        });
      }

      leases += 1;
      const upstreamModels = executionModelCandidates(config, chosen.credential, request.model);
      const leaseId = `static:${chosen.credential.id}:${leases}`;

      return {
        credential: chosen.credential,
        leaseId,
        route: {
          requestedModel: request.model,
          routeModel: upstreamModels[0] ?? request.model,
          upstreamModels,
          originalAlias: request.model,
          forceMapping: false,
          stateModel: canonicalModelKey(request.model),
          pooled: upstreamModels.length > 1,
        },
        lease: {
          id: leaseId,
          credentialId: chosen.credential.id,
          credentialVersion: 1,
          provider: chosen.credential.provider,
          model: canonicalModelKey(request.model),
          issuedAt: 0,
        },
      } satisfies PickResult;
    });

  return CredentialPicker.of({
    pick,
    report: (lease, result) =>
      result.success
        ? Effect.void
        : Effect.logDebug(
            `static credential picker: attempt failed (lease ${lease.id}, status ${result.httpStatus})`,
          ),
    hasAlternative: (request) =>
      reader.get.pipe(
        Effect.map(({ config }) => candidatesOf(config, request).length > 0),
        Effect.orElseSucceed(() => false),
      ),
    // No cooldown state: a retry round is allowed while the request-retry budget lasts.
    planRetry: (query) =>
      Effect.succeed(
        query.round < query.requestRetry ? { retry: true, waitMs: 0 } : { retry: false },
      ),
  });
});

/** Requires `ConfigReader`. */
export const StaticCredentialPickerLayer = Layer.effect(
  CredentialPicker,
  makeStaticCredentialPicker(),
);
