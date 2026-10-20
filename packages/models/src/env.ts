/**
 * What `@commissary/models` reads from a Worker's env (#134 "How packages get their bindings"). Each
 * Worker provides its own `env` as {@link ModelsEnv}. Models types `CONTROL_PLANE` as objects with its part
 * ({@link ModelsControlPlane}): callers write `stub.models().x(…)`.
 */
import { Context, Effect } from "effect";
import { type OrgId, type Reply, CurrentOrg } from "@commissary/core";
import { callControlPlane, controlPlaneOf, type SessionState } from "@commissary/state";
import type { ModelsPart } from "./control-plane-part.ts";

/** The methods of the Models part Models calls: config, credentials, selection, refresh, quota, grants, spend, OAuth. */
type ModelsPartMethod =
  | "getConfig"
  | "configEntries"
  | "priceOverrideEntries"
  | "writePriceOverride"
  | "writeSettings"
  | "writeChannelRule"
  | "writeKeyGroup"
  | "importConfig"
  | "grantEntries"
  | "writeGrant"
  | "grantTable"
  | "pick"
  | "report"
  | "listModelSources"
  | "planRetry"
  | "importAuthFile"
  | "removeCredentials"
  | "refreshNow"
  | "ensureFresh"
  | "sweepRefresh"
  | "refreshDevinStatus"
  | "patchCredentialMetadata"
  | "listCredentialEntries"
  | "isConfigKey"
  | "credentialAccess"
  | "getCredentialFile"
  | "patchCredentialFields"
  | "setCredentialDisabledByRef"
  | "providerKeysView"
  | "privateKeyConfig"
  | "writePrivateKeyGroup"
  | "credentialIdOfAuthIndex"
  | "providerKeyProbeTarget"
  | "resetCredentialCooldown"
  | "refreshCredential"
  | "refreshAllCredentials"
  | "batchCredentials"
  | "quotaProbeTarget"
  | "recordQuotaReport"
  | "resetGrantTarget"
  | "recordResetGrantStatus"
  | "beginResetGrantClaim"
  | "settleResetGrantClaim"
  | "quotaCheckTargets"
  | "takeQuotaSweepLease"
  | "renewQuotaSweepLease"
  | "releaseQuotaSweepLease"
  | "oauthStart"
  | "oauthStatus"
  | "oauthCallback"
  | "oauthCancel";

/** The Models part of an org's ControlPlane (`ModelsPart`) as Models sees it: the methods it calls. */
export type ModelsControlPlanePart = Pick<ModelsPart, ModelsPartMethod> & Rpc.RpcTargetBranded;

/** Models' view of an org's ControlPlane: its part, reached in one pipelined round trip (`stub.models().x(…)`). */
export interface ModelsControlPlane extends Rpc.DurableObjectBranded {
  models(): ModelsControlPlanePart;
}

export type ModelsControlPlaneStub = DurableObjectStub<ModelsControlPlane>;

export interface ModelsBindings {
  /** Model catalogs, signature cache, Antigravity state and client versions (Workers KV). */
  readonly CACHE: KVNamespace;
  /** Usage records (D1); schema in `migrations/`. */
  readonly USAGE: D1Database;
  /** Short-lived session state (Antigravity credit probes, `executor/antigravity/state.ts`). */
  readonly SESSION_STATE: DurableObjectNamespace<SessionState>;
  /** One ControlPlane per org, seen through {@link ModelsControlPlane}. */
  readonly CONTROL_PLANE: DurableObjectNamespace<ModelsControlPlane>;
  /** Secret HMAC key of `auth_index` (`management/auth-index.ts`). Empty fails closed. */
  readonly AUTH_INDEX_KEY: string;
  /** Overrides the Meta key-mint endpoint (empty: default); read by the ControlPlane's Models part (refresh, OAuth). */
  readonly META_MINT_URL: string;
}

/**
 * The Models bindings of the current Worker invocation. Provided per request through the `Context` handed to the web
 * handler (`requestContext`), never through a long-lived layer: bindings must not be captured across requests.
 */
export class ModelsEnv extends Context.Service<ModelsEnv, ModelsBindings>()(
  "commissary/models/ModelsEnv",
) {}

/** The Models part of `org`'s ControlPlane, reached in one pipelined round trip. */
export const modelsPartOf = (env: ModelsBindings, org: OrgId) => controlPlaneOf(env, org).models();

/** The ControlPlane of the current org, seen through {@link ModelsControlPlane}. */
export const currentModelsControlPlane: Effect.Effect<
  ModelsControlPlaneStub,
  never,
  ModelsEnv | CurrentOrg
> = Effect.gen(function* () {
  return controlPlaneOf(yield* ModelsEnv, yield* CurrentOrg);
});

/** Calls the current org's ControlPlane from a Models management route (`callControlPlane`). */
export const modelsControlPlane = <R>(
  label: string,
  call: (stub: ModelsControlPlaneStub) => R,
): Effect.Effect<Awaited<R>, Reply, ModelsEnv | CurrentOrg> =>
  Effect.flatMap(currentModelsControlPlane, (stub) => callControlPlane(label, stub, call));
