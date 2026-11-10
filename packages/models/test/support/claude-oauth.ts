// Shared harness of the Claude pipeline tests: an OAuth credential served by a fixed picker, on top of `makePipeline`.
import { Effect, Layer } from "effect";
import type { Config } from "../../src/config/schema.ts";
import { canonicalModelKey } from "../../src/credentials/selection/model-name.ts";
import { ExecutionError } from "../../src/executor/errors.ts";
import { ModelCapabilities } from "../../src/handlers/model-capabilities.ts";
import { ModelProviders } from "../../src/handlers/model-providers.ts";
import { embeddedCatalogs, lookupStaticModelInfo } from "../../src/registry/catalog.ts";
import {
  CredentialPicker,
  type AttemptResult,
  type CredentialSnapshot,
} from "../../src/executor/picker.ts";
import { makePipeline, type UpstreamResponder } from "./pipeline.ts";

export const oauthCredential = (
  overrides: Partial<CredentialSnapshot> = {},
): CredentialSnapshot => ({
  id: "claude-oauth-1",
  provider: "claude",
  kind: "oauth",
  label: "dev@example.com",
  attributes: {},
  metadata: {
    access_token: "sk-ant-oat01-secret",
    account_uuid: "11111111-2222-4333-8444-555555555555",
  },
  ...overrides,
});

export interface Harness {
  readonly pipeline: ReturnType<typeof makePipeline>;
  readonly reports: Array<AttemptResult>;
}

/** The bundled catalog's capabilities for every model (the registry snapshot of production). */
export const catalogCapabilities = Layer.succeed(
  ModelCapabilities,
  ModelCapabilities.of({
    thinking: (model) =>
      Effect.succeed({
        modelInfo: lookupStaticModelInfo(embeddedCatalogs(), model),
        lookup: (id) => lookupStaticModelInfo(embeddedCatalogs(), id),
      }),
  }),
);

export const oauthPipeline = (
  respond: UpstreamResponder,
  config: Config,
  credential: CredentialSnapshot = oauthCredential(),
  modelCapabilities?: typeof catalogCapabilities,
): Harness => {
  const reports: Array<AttemptResult> = [];

  const picker = Layer.succeed(
    CredentialPicker,
    CredentialPicker.of({
      pick: (request) => {
        if ((request.excludedIds ?? []).includes(credential.id)) {
          return Effect.fail(
            new ExecutionError({
              status: 503,
              code: "auth_not_found",
              message: "no auth available",
            }),
          );
        }

        const lease = {
          id: "lease-1",
          credentialId: credential.id,
          credentialVersion: 1,
          provider: credential.provider,
          model: canonicalModelKey(request.model),
          issuedAt: 0,
        };

        return Effect.succeed({
          credential,
          leaseId: lease.id,
          lease,
          route: {
            requestedModel: request.model,
            routeModel: request.model,
            upstreamModels: [request.model],
            originalAlias: request.model,
            forceMapping: false,
            stateModel: canonicalModelKey(request.model),
            pooled: false,
          },
        });
      },
      report: (_lease, result) => Effect.sync(() => void reports.push(result)),
      planRetry: () => Effect.succeed({ retry: false }),
    }),
  );

  const providers = Layer.succeed(
    ModelProviders,
    ModelProviders.of({
      providersFor: (model) => Effect.succeed(model.startsWith("claude-") ? ["claude"] : []),
      firstAvailableModel: Effect.succeed("claude-sonnet-4-5"),
    }),
  );

  const pipeline = makePipeline({
    config,
    respond,
    credentialPicker: picker,
    modelProviders: providers,
    ...(modelCapabilities === undefined ? {} : { modelCapabilities }),
  });

  return { pipeline, reports };
};
