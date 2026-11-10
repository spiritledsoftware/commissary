// Test helpers for the xAI provider: credentials, a fixed picker that honours `pinnedId` and an xai-only model lookup.
import { Effect, Layer } from "effect";
import { ConfigReader } from "../../src/config/reader.ts";
import { ExecutionError } from "../../src/executor/errors.ts";
import {
  type AttemptResult,
  CredentialPicker,
  type CredentialSnapshot,
  type PickResult,
} from "../../src/executor/picker.ts";
import { ModelProviders } from "../../src/handlers/model-providers.ts";

/** OAuth (Grok CLI login) credential: talks to the CLI chat proxy by default. */
export const xaiOauth = (overrides: Partial<CredentialSnapshot> = {}): CredentialSnapshot => ({
  id: "xai-oauth-1",
  provider: "xai",
  kind: "oauth",
  label: "dev@example.com",
  attributes: { auth_kind: "oauth" },
  metadata: { access_token: "xai-access-1" },
  ...overrides,
});

/** Provider-key credential: official API. */
export const xaiKey = (overrides: Partial<CredentialSnapshot> = {}): CredentialSnapshot => ({
  id: "xai-key-1",
  provider: "xai",
  kind: "apikey",
  label: "key",
  attributes: { api_key: "xai-key-secret-1" },
  metadata: {},
  ...overrides,
});

export interface XaiPickerLog {
  readonly picks: Array<{
    readonly model: string;
    readonly pinnedId: string | undefined;
    readonly excluded: ReadonlyArray<string>;
  }>;
  readonly reports: Array<{
    readonly leaseId: string;
    readonly credentialId: string;
    readonly result: AttemptResult;
  }>;
}

/** Serves `credentials` in order, honouring `excludedIds` and `pinnedId`. */
export const xaiPicker = (
  credentials: ReadonlyArray<CredentialSnapshot>,
  log: XaiPickerLog = { picks: [], reports: [] },
): Layer.Layer<CredentialPicker, never, ConfigReader> =>
  Layer.succeed(
    CredentialPicker,
    CredentialPicker.of({
      pick: (request) =>
        Effect.suspend(() => {
          log.picks.push({
            model: request.model,
            pinnedId: request.pinnedId,
            excluded: [...(request.excludedIds ?? [])],
          });

          const credential = credentials.find(
            (candidate) =>
              !(request.excludedIds ?? []).includes(candidate.id) &&
              (request.pinnedId === undefined || candidate.id === request.pinnedId),
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
        Effect.sync(
          () =>
            void log.reports.push({ leaseId: lease.id, credentialId: lease.credentialId, result }),
        ),
      planRetry: () => Effect.succeed({ retry: false }),
      hasAlternative: (request) =>
        Effect.succeed(
          credentials.some((candidate) => !(request.excludedIds ?? []).includes(candidate.id)),
        ),
    }),
  );

/** Every model belongs to the `xai` provider. */
export const xaiModels: Layer.Layer<ModelProviders, never, ConfigReader> = Layer.succeed(
  ModelProviders,
  ModelProviders.of({
    providersFor: () => Effect.succeed(["xai"]),
    firstAvailableModel: Effect.succeed("grok-4.3"),
  }),
);

/** Deterministic high-entropy unpadded base64 (passes the Grok encrypted_content replay-safety checks). */
export const grokCiphertext = (seed: number, bytes = 96): string => {
  let state = seed >>> 0 || 1;
  const out = new Uint8Array(bytes);

  for (let index = 0; index < bytes; index++) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    out[index] = state >>> 24;
  }

  let binary = "";

  for (const byte of out) binary += String.fromCharCode(byte);

  return btoa(binary).replaceAll("=", "");
};
