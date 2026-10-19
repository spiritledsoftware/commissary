/**
 * Org-scoped access to Workers KV and to per-isolate caches (ADR 0044, "Org isolation is enforced in code").
 *
 * A raw KV namespace never reaches code that handles org data. Code takes an {@link OrgKv}, which is bound to one org
 * and scopes every name itself (`orgScopedName`: the `global` org's names stay unprefixed, the one documented
 * exception), so a name of org data that skips the scope has no way to be written. Deployment-wide names (the model
 * catalog, client versions) go through {@link DeploymentKv}, whose names are {@link DeploymentKey}s, made one at a
 * time by {@link deploymentKey}, so each is a visible decision. The one place a Worker's `CACHE` binding is read is
 * `@commissary/models`' `kv.ts` (lint rule `boundaries/org-scoped-kv`, `tools/oxlint/boundaries`).
 *
 * Per-isolate caches of org data go through {@link OrgCache}, which is keyed by the org and a name the same way.
 *
 * Structural interfaces stand in for `KVNamespace`: this package has no Workers types.
 */
import { GLOBAL_ORG, type OrgId, orgScopedName } from "./org.ts";

/** The part of a Workers `KVNamespace` the helpers use; a `KVNamespace` satisfies it. */
export interface KvBinding {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { readonly expirationTtl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
  list(options: { readonly prefix?: string; readonly limit?: number }): Promise<{
    readonly keys: ReadonlyArray<{ readonly name: string }>;
    readonly list_complete: boolean;
  }>;
}

/** What a write may set; KV needs an `expirationTtl` of at least 60 s. */
export interface KvPutOptions {
  readonly expirationTtl?: number;
}

/** The KV entries of one org. `name` is the name within the org; the helper scopes it. */
export interface OrgKv {
  readonly org: OrgId;
  get(name: string): Promise<string | null>;
  put(name: string, value: string, options?: KvPutOptions): Promise<void>;
  delete(name: string): Promise<void>;
  /**
   * Deletes up to `limit` of the org's entries: how many it deleted, and whether none is left. The `global` org's
   * names are unprefixed and share the namespace with the deployment's, so nothing of it is ever listed or deleted
   * this way (it cannot be deleted either).
   */
  deletePage(limit: number): Promise<{ readonly deleted: number; readonly complete: boolean }>;
}

/** The KV entries of `org` in `kv`. */
export const orgKv = (kv: KvBinding, org: OrgId): OrgKv => ({
  org,
  get: (name) => kv.get(orgScopedName(org, name)),
  put: (name, value, options) =>
    options === undefined
      ? kv.put(orgScopedName(org, name), value)
      : kv.put(orgScopedName(org, name), value, options),
  delete: (name) => kv.delete(orgScopedName(org, name)),
  deletePage: async (limit) => {
    if (org === GLOBAL_ORG) return { deleted: 0, complete: true };

    const page = await kv.list({ prefix: orgScopedName(org, ""), limit });

    await Promise.all(page.keys.map(async (key) => await kv.delete(key.name)));

    return { deleted: page.keys.length, complete: page.list_complete };
  },
});

declare const deploymentKeyBrand: unique symbol;

/** The name of a KV entry that belongs to the deployment, not to an org. Made by {@link deploymentKey} only. */
export type DeploymentKey = string & { readonly [deploymentKeyBrand]: true };

/**
 * Declares `name` a deployment-wide KV name (the models.dev catalog, a client version): every org reads the same
 * entry. Never for data of an org.
 */
export const deploymentKey = (name: string): DeploymentKey =>
  // SAFETY: the brand only records that the caller declared the name deployment-wide.
  name as DeploymentKey;

/** The KV entries that belong to the deployment as a whole. */
export interface DeploymentKv {
  get(key: DeploymentKey): Promise<string | null>;
  put(key: DeploymentKey, value: string, options?: KvPutOptions): Promise<void>;
  delete(key: DeploymentKey): Promise<void>;
}

/** The deployment-wide entries of `kv`. */
export const deploymentKv = (kv: KvBinding): DeploymentKv => ({
  get: (key) => kv.get(key),
  put: (key, value, options) =>
    options === undefined ? kv.put(key, value) : kv.put(key, value, options),
  delete: (key) => kv.delete(key),
});

/**
 * A per-isolate cache of org data: one value per org and name, so one org never reads another's entry. Unbounded;
 * callers keep their entry counts small (a few per credential) or evict themselves.
 */
export interface OrgCache<V> {
  get(org: OrgId, name: string): V | undefined;
  set(org: OrgId, name: string, value: V): void;
  delete(org: OrgId, name: string): void;
  clear(): void;
}

/** An empty {@link OrgCache}. */
export const makeOrgCache = <V>(): OrgCache<V> => {
  const entries = new Map<string, V>();

  return {
    get: (org, name) => entries.get(orgScopedName(org, name)),
    set: (org, name, value) => {
      entries.set(orgScopedName(org, name), value);
    },
    delete: (org, name) => {
      entries.delete(orgScopedName(org, name));
    },
    clear: () => {
      entries.clear();
    },
  };
};
