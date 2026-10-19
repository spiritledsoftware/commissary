/**
 * `auth_index`: the stable credential handle the management API, the usage export and the control panel pass around.
 *
 * Go source: sdk/cliproxy/auth/types.go (`EnsureIndex`, `stableAuthIndex`): first 8 bytes of a SHA-256 as 16 hex
 * characters. The Go seed is path/provider-key based; on Workers every credential has a stable `id` (auth file name or the
 * content-addressed config id `kind:sha256(kind␀key␀…)[:12]` of `credentials/synthesize.ts`).
 *
 * Deviation from Go (security): the index is keyed, `hex(HMAC-SHA256(K, "auth-index:" + id))[:16]`, with `K` the
 * per-deployment secret `AUTH_INDEX_KEY` (an Alchemy `Random` kept in the stack state, `alchemy.run.ts`). Go's unsalted
 * hash of a value derived from the provider key lets anyone holding an index (or a config id) confirm key guesses offline;
 * under a secret key an index reveals nothing about the id. 16 hex characters (64 bits) stay: with a secret key they
 * only need to be unique among one deployment's credentials (a collision is a 2^-32 event for 2^16 of them), and the
 * contract, panel URLs and usage exports keep their shape. Indexes are never persisted (D1 stores the credential id,
 * the ControlPlane recomputes them for lookups), so setting or rotating the key changes every index once.
 *
 * The key fails closed: a missing, non-string or short (< 16 characters) key throws instead of hashing under an empty
 * or guessable key (node:crypto accepts a 0-byte HMAC key). On a deployed stage (`ACCESS_TEAM_DOMAIN` or `ACCESS_AUD`
 * set, the condition that also refuses `ACCESS_DEV_BYPASS`, `@commissary/auth` `isDeployedStage`) the fixed `alchemy dev` key and any
 * key shorter than 64 characters (the deploy mints 32 random bytes as 64 hex characters) are refused too
 * (`deploymentAuthIndexer`): every index then fails (management calls answer 500; Commissary's request log, which
 * only annotates with the index, leaves it out, `models/observability/trace.ts`), and the refusal is logged once per
 * isolate.
 *
 * Each org has its own key (ADR 0021): `global` uses `AUTH_INDEX_KEY` itself, so the indexes from before orgs existed
 * stay valid, and any other org `hex(HMAC-SHA256(AUTH_INDEX_KEY, "auth-index-org:" + org))`, so the same credential
 * gets unrelated indexes in two orgs ({@link orgAuthIndexer}).
 *
 * The key is imported once per isolate and the indexes are memoised. It is a node:crypto `KeyObject` rather than a
 * WebCrypto `CryptoKey`: `crypto.subtle.sign` is async only, while lookups inside the ControlPlane Durable Object and
 * the pure management views are synchronous; workerd implements both over the same BoringSSL HMAC.
 */
import { createHmac, createSecretKey, type KeyObject } from "node:crypto";
import { Effect } from "effect";
import { isDeployedStage } from "@commissary/auth";
import { CurrentOrg, GLOBAL_ORG, makeOrgCache, type OrgId } from "@commissary/core";
import {
  DEV_AUTH_INDEX_KEY,
  MIN_AUTH_INDEX_KEY_LENGTH,
  MIN_DEPLOYED_AUTH_INDEX_KEY_LENGTH,
} from "./auth-index-key.ts";
import { ModelsEnv } from "../env.ts";

/** Hex characters of an `auth_index`. */
export const AUTH_INDEX_LENGTH = 16;

/** Maps a credential id to its `auth_index` under one deployment key. */
export type AuthIndexer = (credentialId: string) => string;

/** Memoised indexes per key; the credential ids of a deployment are a small, slowly changing set. */
const MAX_MEMOISED = 4096;

const makeIndexer = (secret: string): AuthIndexer => {
  let key: KeyObject | undefined;
  const memo = new Map<string, string>();

  return (credentialId) => {
    const known = memo.get(credentialId);

    if (known !== undefined) return known;

    key ??= createSecretKey(new TextEncoder().encode(secret));

    const index = createHmac("sha256", key)
      .update(`auth-index:${credentialId}`, "utf8")
      .digest("hex")
      .slice(0, AUTH_INDEX_LENGTH);

    if (memo.size >= MAX_MEMOISED) memo.clear();
    memo.set(credentialId, index);

    return index;
  };
};

const indexers = new Map<string, AuthIndexer>();

/** Thrown for a missing, short or (on a deployed stage) development `AUTH_INDEX_KEY`. */
export class AuthIndexKeyError extends Error {
  override readonly name = "AuthIndexKeyError";
}

/**
 * The indexer of `secret` (the `AUTH_INDEX_KEY` binding), cached per isolate. Fails closed: throws
 * `AuthIndexKeyError` unless `secret` is a string of at least 16 characters (a binding missing at runtime is
 * `undefined` whatever the env type says).
 */
export const authIndexer = (secret: string | undefined): AuthIndexer => {
  if (typeof secret !== "string" || secret.length < MIN_AUTH_INDEX_KEY_LENGTH)
    throw new AuthIndexKeyError(
      `AUTH_INDEX_KEY is not set or shorter than ${MIN_AUTH_INDEX_KEY_LENGTH} characters: the Worker needs its auth_index key (alchemy.run.ts, docs/DEPLOY.md)`,
    );
  const cached = indexers.get(secret);

  if (cached !== undefined) return cached;
  const indexer = makeIndexer(secret);
  indexers.set(secret, indexer);

  return indexer;
};

/** The bindings the key check reads; each may be missing at runtime. */
export interface AuthIndexKeyEnv {
  readonly AUTH_INDEX_KEY?: string | undefined;
  readonly ACCESS_TEAM_DOMAIN?: string | undefined;
  readonly ACCESS_AUD?: string | undefined;
}

let deployedKeyRefusalLogged = false;

/**
 * The indexer of `env.AUTH_INDEX_KEY` ({@link authIndexer}). On a deployed stage (`ACCESS_TEAM_DOMAIN` or `ACCESS_AUD`
 * set, as for the `ACCESS_DEV_BYPASS` refusal) it also refuses the development key and keys shorter than 64
 * characters, logging the refusal once per isolate.
 */
export const deploymentAuthIndexer = (env: AuthIndexKeyEnv): AuthIndexer => {
  const secret = env.AUTH_INDEX_KEY;

  const deployed = isDeployedStage(env);

  if (
    deployed &&
    (secret === DEV_AUTH_INDEX_KEY ||
      typeof secret !== "string" ||
      secret.length < MIN_DEPLOYED_AUTH_INDEX_KEY_LENGTH)
  ) {
    const message = `AUTH_INDEX_KEY is refused because ACCESS_TEAM_DOMAIN/ACCESS_AUD are set: a deployed stage needs its own random key of at least ${MIN_DEPLOYED_AUTH_INDEX_KEY_LENGTH} characters (alchemy.run.ts, docs/DEPLOY.md)`;

    if (!deployedKeyRefusalLogged) {
      deployedKeyRefusalLogged = true;
      // Sync, and also reached inside the ControlPlane Durable Object, outside a request's runtime.
      Effect.runSync(Effect.logError(message));
    }

    throw new AuthIndexKeyError(message);
  }

  return authIndexer(secret);
};

/** The key of `org` under the deployment key `secret` (any org but `global`). */
const orgKey = (secret: string, org: OrgId): string =>
  createHmac("sha256", createSecretKey(new TextEncoder().encode(secret)))
    .update(`auth-index-org:${org}`, "utf8")
    .digest("hex");

/** The indexers of the orgs this isolate serves, by deployment key; emptied when full. */
const orgIndexers = makeOrgCache<AuthIndexer>();

/**
 * The indexer of `org`: {@link deploymentAuthIndexer} for `global`, and for any other org an indexer under a key
 * derived from the deployment key, which goes through the same checks first.
 */
export const orgAuthIndexer = (env: AuthIndexKeyEnv, org: OrgId): AuthIndexer => {
  const deployment = deploymentAuthIndexer(env);

  if (org === GLOBAL_ORG) return deployment;
  // SAFETY: deploymentAuthIndexer only returns when AUTH_INDEX_KEY is a string of an accepted length.
  const secret = env.AUTH_INDEX_KEY as string;
  const cached = orgIndexers.get(org, secret);

  if (cached !== undefined) return cached;
  const indexer = makeIndexer(orgKey(secret, org));

  if (orgIndexers.size >= MAX_MEMOISED) orgIndexers.clear();
  orgIndexers.set(org, secret, indexer);

  return indexer;
};

/** The indexer of the current Worker invocation's org ({@link orgAuthIndexer}). */
export const currentAuthIndexer: Effect.Effect<AuthIndexer, never, ModelsEnv | CurrentOrg> =
  Effect.gen(function* () {
    return orgAuthIndexer(yield* ModelsEnv, yield* CurrentOrg);
  });
