// Test helpers for the Codex provider: a fixed-credential picker, a codex-only model lookup and canned upstream streams.
import { Effect, Layer } from "effect";
import { ExecutionError } from "../../src/executor/errors.ts";
import {
  CredentialPicker,
  type AttemptResult,
  type CredentialSnapshot,
  type PickResult,
} from "../../src/executor/picker.ts";
import { ModelProviders } from "../../src/handlers/model-providers.ts";
import { ConfigReader } from "../../src/config/reader.ts";

export const oauthCredential = (
  overrides: Partial<CredentialSnapshot> = {},
): CredentialSnapshot => ({
  id: "codex-oauth-1",
  provider: "codex",
  kind: "oauth",
  label: "dev@example.com",
  attributes: { plan_type: "plus" },
  metadata: { access_token: "access-token-1", account_id: "acct_123" },
  ...overrides,
});

export const providerKeyCredential = (
  overrides: Partial<CredentialSnapshot> = {},
): CredentialSnapshot => ({
  id: "codex-key-1",
  provider: "codex",
  kind: "apikey",
  label: "key",
  attributes: { api_key: "sk-codex-1", base_url: "https://codex.example.test/v1" },
  metadata: {},
  ...overrides,
});

export interface PickerLog {
  readonly picks: Array<{
    readonly model: string;
    readonly excluded: ReadonlyArray<string>;
    readonly disallowFree: boolean;
  }>;
  readonly reports: Array<{ readonly leaseId: string; readonly result: AttemptResult }>;
}

/** Picker that serves `credentials` in order, honouring `excludedIds`. */
export const fixedPicker = (
  credentials: ReadonlyArray<CredentialSnapshot>,
  log: PickerLog = { picks: [], reports: [] },
): Layer.Layer<CredentialPicker, never, ConfigReader> =>
  Layer.succeed(
    CredentialPicker,
    CredentialPicker.of({
      pick: (request) =>
        Effect.suspend(() => {
          log.picks.push({
            model: request.model,
            excluded: [...(request.excludedIds ?? [])],
            disallowFree: request.disallowFreeAuth === true,
          });

          const credential = credentials.find(
            (candidate) =>
              !(request.excludedIds ?? []).includes(candidate.id) &&
              !(request.disallowFreeAuth === true && candidate.attributes["plan_type"] === "free"),
          );

          if (credential === undefined) {
            return Effect.fail(
              new ExecutionError({
                status: 503,
                code: "auth_not_found",
                message: "no auth available",
              }),
            );
          }

          const leaseId = `lease-${log.picks.length}`;

          return Effect.succeed({
            credential,
            leaseId,
            route: {
              requestedModel: request.model,
              routeModel: request.model,
              upstreamModels: [request.model],
              originalAlias: request.model,
              forceMapping: false,
              stateModel: request.model,
              pooled: false,
            },
            lease: {
              id: leaseId,
              credentialId: credential.id,
              credentialVersion: 1,
              provider: credential.provider,
              model: request.model,
              issuedAt: 0,
            },
          } satisfies PickResult);
        }),
      report: (lease, result) =>
        Effect.sync(() => void log.reports.push({ leaseId: lease.id, result })),
      planRetry: () => Effect.succeed({ retry: false }),
      hasAlternative: (request) =>
        Effect.succeed(
          credentials.some((candidate) => !(request.excludedIds ?? []).includes(candidate.id)),
        ),
    }),
  );

/** Every model belongs to the `codex` provider. */
export const codexModels: Layer.Layer<ModelProviders, never, ConfigReader> = Layer.succeed(
  ModelProviders,
  ModelProviders.of({
    providersFor: () => Effect.succeed(["codex"]),
    firstAvailableModel: Effect.succeed("gpt-5.4"),
  }),
);
