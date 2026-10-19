/**
 * Management keys on the management API (ADR 0026), on every deployment: `Authorization: Bearer cmsm_…`. New in the Workers
 * port, no Go counterpart.
 *
 * A key names its org (`keys.ts`), so verification asks that org's ControlPlane only, after the Platform registry
 * confirmed the org exists (`orgExists`, shared with API keys). A request with a key is for the key's org:
 * an unscoped management URL means it, an org-scoped one must name it (403 otherwise). The key holds a role in its org
 * and is never a platform admin. Verified keys are cached per isolate for {@link VERIFIED_KEY_TTL_MS}, so a revocation
 * applies within that time everywhere, and at once in the isolate that revoked it.
 */
import { Clock, Effect } from "effect";
import type { OrgRole } from "@commissary/contract/members";
import {
  ForbiddenError,
  InternalError,
  NotFoundError,
  UnauthorizedError,
  type OrgId,
  makeOrgCache,
} from "@commissary/core";
import { orgExists, VERIFIED_KEY_TTL_MS } from "./api-key.ts";
import { AuthDirectory, directoryFailure } from "./directory.ts";
import { looksLikeManagementKey, parseManagementKey } from "./keys.ts";
import { type AccessIdentity, makeIdentity } from "./principal.ts";
import { roleAtLeast, type RouteAccess } from "./roles.ts";

export interface VerifiedManagementKey {
  readonly org: OrgId;
  readonly keyId: string;
  readonly name: string;
  readonly role: OrgRole;
  readonly ownerEmail?: string;
}

/** The most verified keys one isolate keeps; the oldest is dropped first. */
const MAX_CACHED_KEYS = 1024;

/** Verified keys by the SHA-256 of the whole key, with the epoch ms until which they are trusted. */
const verified = makeOrgCache<{ readonly key: VerifiedManagementKey; readonly until: number }>(
  MAX_CACHED_KEYS,
);

/** Forgets a revoked key of `org` in this isolate, so it is refused here at once. */
export const forgetVerifiedManagementKey = (org: OrgId, keyId: string): void => {
  verified.deleteWhere(
    (cachedOrg, _hash, cached) => cachedOrg === org && cached.key.keyId === keyId,
  );
};

/** Empties the cache, for tests. */
export const resetManagementKeyCache = (): void => {
  verified.clear();
};

/** The management key of a request: `Authorization: Bearer cmsm_…`, well formed or not. */
export const presentedManagementKey = (
  headers: Readonly<Record<string, string | undefined>>,
): string | undefined => {
  const [scheme, ...rest] = (headers["authorization"] ?? "").trim().split(" ");
  const value = rest.join(" ").trim();

  return scheme?.toLowerCase() === "bearer" && looksLikeManagementKey(value) ? value : undefined;
};

const invalid = new UnauthorizedError({ message: "Invalid API key" });

/** The live key behind `text`, or `Invalid API key` (401) for a malformed, unknown or revoked key. */
export const verifyManagementKey = Effect.fnUntraced(function* (text: string) {
  const parsed = parseManagementKey(text);

  if (parsed === undefined) return yield* invalid;
  const now = yield* Clock.currentTimeMillis;
  const cached = verified.get(parsed.org, parsed.hash);

  if (cached !== undefined && now < cached.until) return cached.key;
  verified.delete(parsed.org, parsed.hash);

  if (!(yield* orgExists(parsed.org, now))) return yield* invalid;
  const directory = yield* AuthDirectory;

  const verdict = yield* directory
    .verifyManagementKey(parsed.org, parsed.keyId, parsed.hash, now)
    .pipe(Effect.mapError(directoryFailure("management key verification")));

  if (!verdict.ok) return yield* invalid;

  const key: VerifiedManagementKey = {
    org: parsed.org,
    keyId: parsed.keyId,
    name: verdict.name,
    role: verdict.role,
    ...(verdict.ownerEmail === undefined ? {} : { ownerEmail: verdict.ownerEmail }),
  };

  verified.set(parsed.org, parsed.hash, { key, until: now + VERIFIED_KEY_TTL_MS });

  return key;
});

/**
 * The identity of a live management key for a management request addressed to `slug` (unscoped: the key's org) that
 * needs `needs`: 403 when the URL names another org or the key's role is below what the route needs.
 */
export const managementKeyIdentity = (
  text: string,
  slug: string | undefined,
  needs: RouteAccess,
): Effect.Effect<
  { readonly identity: AccessIdentity; readonly key: VerifiedManagementKey },
  UnauthorizedError | ForbiddenError | NotFoundError | InternalError,
  AuthDirectory
> =>
  Effect.gen(function* () {
    const key = yield* verifyManagementKey(text);

    if (slug !== undefined) {
      const directory = yield* AuthDirectory;

      const addressed = yield* directory
        .getOrgBySlug(slug)
        .pipe(Effect.mapError(directoryFailure()));

      if (addressed?.id !== key.org) return yield* new ForbiddenError({ message: "Forbidden" });
    }

    if (needs !== "platform" && !roleAtLeast(key.role, needs))
      return yield* new ForbiddenError({ message: "Forbidden" });

    const identity = yield* makeIdentity(
      {
        kind: "mkey",
        keyId: key.keyId,
        name: key.name,
        ...(key.ownerEmail === undefined ? {} : { ownerEmail: key.ownerEmail }),
      },
      key.org,
      false,
      { role: key.role },
    );

    return { identity, key };
  });
