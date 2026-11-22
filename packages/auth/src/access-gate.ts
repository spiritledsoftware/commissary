// Authentication of one request on a self-hosted Commissary: API key, management key or Access JWT -> principal -> the
// org the request is for and the caller's role in it. New in the Workers port.
import { Effect } from "effect";
import { CurrentOrg, UnauthorizedError } from "@commissary/core";
import { devBypass, isAdmin, loadAccessConfig } from "./access/config.ts";
import type { AccessJwks } from "./access/jwks.ts";
import { verifyAccessJwt } from "./access/verify.ts";
import { presentedCredentials } from "./api-key.ts";
import { AuthConfig } from "./config.ts";
import type { AuthDirectory } from "./directory.ts";
import {
  type AccessError,
  admitted,
  keyIdentity,
  type ManagementRoute,
  targetOrg,
} from "./gate.ts";
import { managementKeyInStanding, presentedManagementKey } from "./management-key.ts";
import type { AccessIdentity, AdmissiblePrincipal } from "./principal.ts";

export const ACCESS_JWT_HEADER = "cf-access-jwt-assertion";

/** The header `cloudflared access` sends the Access token in; read only on the client API. */
export const ACCESS_TOKEN_HEADER = "cf-access-token";

let devBypassRefusalLogged = false;

/** Logs (once per isolate) that `ACCESS_DEV_BYPASS` is set on a Worker that has Access configured. */
const warnDevBypassRefused = Effect.suspend(() => {
  if (devBypassRefusalLogged) return Effect.void;
  devBypassRefusalLogged = true;

  return Effect.logWarning(
    "ACCESS_DEV_BYPASS is ignored because ACCESS_TEAM_DOMAIN/ACCESS_AUD are set; remove it from this environment",
  );
});

/**
 * Authenticates a request of a self-hosted Commissary: on the client API (`route` undefined) or the management API.
 *
 * `headers` must expose lowercased header names; `requestUrl` is the full URL as the client sent it (the dev bypass
 * reads its host). Failures use the Go auth middleware wording (`Missing API key`, `Invalid API key`).
 *
 * The identity carries the org of the request (the addressed org, the `CurrentOrg` otherwise) and the caller's role in
 * it. A platform admin is an owner of every org; anyone else needs a role in the org (`403` otherwise), except on a
 * platform-level route.
 *
 * On the client API an API key (`cms_…`, `api-key.ts`) wins: the request is for the key's org, as its member; a bad key
 * is refused even when the request also carries an Access sign-in. Without a key, the Access JWT comes from
 * `Cf-Access-Jwt-Assertion` or, since Access no longer sits in front of the client API, from the `cf-access-token`
 * header `cloudflared` sends; it is accepted only while the org's `access_clients` setting is on. Management routes
 * never take API keys: they stay behind Access, which sets `Cf-Access-Jwt-Assertion`. A management key
 * (`Authorization: Bearer cmsm_…`, `management-key.ts`) wins there the way an API key wins on the client API.
 */
export const accessGate = (
  headers: Readonly<Record<string, string | undefined>>,
  requestUrl: string,
  route: ManagementRoute | undefined,
): Effect.Effect<
  AccessIdentity,
  AccessError,
  AuthConfig | AuthDirectory | CurrentOrg | AccessJwks
> =>
  Effect.gen(function* () {
    const env = yield* AuthConfig;
    const slug = route?.slug;
    const needs = route?.needs ?? "member";
    const credentials = route === undefined ? presentedCredentials(headers, requestUrl) : undefined;

    if (credentials?.apiKey !== undefined) return yield* keyIdentity(credentials.apiKey);
    const managementKey = route === undefined ? undefined : presentedManagementKey(headers);

    if (managementKey !== undefined) {
      const { identity } = yield* managementKeyInStanding(managementKey, slug, needs);

      return identity;
    }

    const bypass = devBypass(env, requestUrl);

    if (bypass?._tag === "Active") {
      // Local `alchemy dev` only; the bypass principal is an administrator of everything and, like a platform admin
      // signed in through Access, a member of the orgs it joined (so it can issue itself API keys there).
      const org = yield* targetOrg(slug, true);

      return yield* admitted(
        { kind: "user", email: bypass.email, sub: "dev-bypass" },
        org,
        true,
        needs,
        undefined,
      );
    }

    if (bypass?._tag === "Refused") yield* warnDevBypassRefused;

    const config = yield* loadAccessConfig(env);

    const token =
      headers[ACCESS_JWT_HEADER]?.trim() ||
      (route === undefined ? headers[ACCESS_TOKEN_HEADER]?.trim() : undefined) ||
      "";

    if (token === "") return yield* new UnauthorizedError({ message: "Missing API key" });

    const principal: AdmissiblePrincipal = yield* verifyAccessJwt(token, config);
    const platformAdmin = isAdmin(config, principal);
    const org = route === undefined ? yield* CurrentOrg : yield* targetOrg(slug, platformAdmin);

    return yield* admitted(
      principal,
      org,
      platformAdmin,
      needs,
      credentials === undefined ? undefined : { credentialSent: credentials.any },
    );
  });
