/**
 * Commissary Cloud's managed OAuth apps (#207): an OAuth app Commissary Cloud registered with a service itself, which a
 * toolkit added from that service's catalog entry signs in with when the org gives it no OAuth app of its own. The
 * toolkit catalog additions name each app by catalog slug (`managed_apps`: its client id, endpoints and scopes) and the
 * Workers' binding that holds its client secret (`TOOLKIT_OAUTH_<NAME>`), which is never in the additions.
 *
 * An app is available only on Commissary Cloud (`COMMISSARY_MODE=cloud`) and only once its secret is bound: every
 * secret is optional, and a deployment without one (a self-hosted Commissary always) signs in as before, with the org's
 * OAuth app or as Commissary itself (CIMD, dynamic registration). Only the State Worker, where the Tools part signs in
 * and refreshes tokens, binds the secrets and reads them, by name from its `env`, which declares no binding for them
 * (the names come from the additions: the one exception to declaring each binding, docs/DEPLOY.md). The app Worker
 * learns whether a service has an app from the part (`hasManagedApp`), never from a secret.
 */
import { Option, Schema } from "effect";
import type { OAuthApp } from "../oauth/store.ts";
import { type Additions, bundledAdditions, CATALOG_AUTHOR } from "./additions.ts";

/** When a managed app was set, as an org's OAuth app records it: never (it ships with Commissary). */
const SHIPPED_AT = 0;

/** The managed OAuth apps available on a deployment. */
export interface ManagedApps {
  /** Whether catalog service `service` has a managed app available here. */
  readonly has: (service: string) => boolean;
  /** The managed app of catalog service `service`, as toolkit `toolkitId`'s OAuth app; undefined: none available. */
  readonly app: (service: string, toolkitId: string) => OAuthApp | undefined;
}

/** What of a Worker's `env` decides which managed apps it has: its mode; the secrets are read by the names the apps give. */
export interface ManagedAppEnv {
  readonly COMMISSARY_MODE?: string | undefined;
}

/** The secrets `env` binds of those `additions` name, each read on its own as the text it must be (not empty). */
const secretsOf = (additions: Additions, env: ManagedAppEnv): ReadonlyMap<string, string> =>
  new Map(
    Object.values(additions.managed_apps).flatMap((app) =>
      Option.match(
        Schema.decodeUnknownOption(Schema.Struct({ [app.secret]: Schema.NonEmptyString }))(env),
        {
          onNone: () => [],
          onSome: (bound) => {
            const secret = bound[app.secret];

            return secret === undefined ? [] : [[app.secret, secret] as const];
          },
        },
      ),
    ),
  );

/**
 * The managed apps of `additions` a Worker's `env` makes available: none unless `COMMISSARY_MODE` is `cloud`, and of
 * those, the ones whose secret `env` binds (read by the name the app gives).
 */
export const managedAppsOf = (
  env: ManagedAppEnv,
  additions: Additions = bundledAdditions(),
): ManagedApps => {
  const secrets = env.COMMISSARY_MODE === "cloud" ? secretsOf(additions, env) : new Map();

  const appOf = (service: string) =>
    Object.hasOwn(additions.managed_apps, service) ? additions.managed_apps[service] : undefined;

  return {
    has: (service) => {
      const app = appOf(service);

      return app !== undefined && secrets.has(app.secret);
    },
    app: (service, toolkitId) => {
      const app = appOf(service);
      const clientSecret = app === undefined ? undefined : secrets.get(app.secret);

      if (app === undefined || clientSecret === undefined) return undefined;

      return {
        toolkitId,
        clientId: app.client_id,
        clientSecret,
        authorizeUrl: app.authorize_url,
        tokenUrl: app.token_url,
        scopes: app.scopes ?? [],
        issuer: app.issuer,
        updatedAt: SHIPPED_AT,
        updatedBy: CATALOG_AUTHOR,
      };
    },
  };
};

/** No managed app: the default of a part built without them. */
export const NO_MANAGED_APPS: ManagedApps = { has: () => false, app: () => undefined };
