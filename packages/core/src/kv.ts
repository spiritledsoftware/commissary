/**
 * Org-scoped access to Workers KV and to per-isolate caches (ADR 0044, "Org isolation is enforced in code").
 *
 * Code that handles org data takes an {@link OrgKv}, which is bound to one org and scopes every name itself
 * (`orgScopedName`: the `global` org's names stay unprefixed, the one documented exception), so a name of org data
 * cannot be written without its scope. Deployment-wide names (the model catalog, client versions) go through
 * {@link DeploymentKv}, whose names are {@link DeploymentKey}s, each declared by {@link deploymentKey}. The only module
 * that reads a Worker's `CACHE` binding is `models/kv.ts` (lint rule `boundaries/org-scoped-kv`).
 *
 * Per-isolate caches of org data are an {@link OrgCache}: a map keyed by the org and a name. That is a convention
 * backed by this helper and by the cross-org suite, not by lint.
 *
 * Structural interfaces stand in for `KVNamespace`: this package has no Workers types.
 */
import { GLOBAL_ORG, type OrgId, orgScopedName } from "./org.ts";

/** The part of a Workers `KVNamespace` the helpers use; a `KVNamespace` satisfies it. */
export interface KvBinding {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: KvPutOptions): Promise<void>;
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

/**
 * The KV entries of `org` in `kv`. A name of `global` that starts with `org.` is refused (the call rejects): it would
 * read or write another org's entry.
 */
export const orgKv = (kv: KvBinding, org: OrgId): OrgKv => {
  const scoped = (name: string): string => {
    if (org === GLOBAL_ORG && name.startsWith("org."))
      throw new Error(
        `KV name "${name}" of the global org starts with "org.", the prefix of other orgs' names`,
      );

    return orgScopedName(org, name);
  };

  return {
    org,
    get: async (name) => await kv.get(scoped(name)),
    put: async (name, value, options) => {
      await kv.put(scoped(name), value, options);
    },
    delete: async (name) => {
      await kv.delete(scoped(name));
    },
    deletePage: async (limit) => {
      if (org === GLOBAL_ORG) return { deleted: 0, complete: true };

      const page = await kv.list({ prefix: orgScopedName(org, ""), limit });

      await Promise.all(page.keys.map(async (key) => await kv.delete(key.name)));

      return { deleted: page.keys.length, complete: page.list_complete };
    },
  };
};

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
  put: (key, value, options) => kv.put(key, value, options),
  delete: (key) => kv.delete(key),
});

/**
 * A per-isolate cache of org data: one value per org and name, so one org never reads another's entry. The key is the
 * org and the name apart (not `orgScopedName`, whose names can collide: `global`'s `org.acme.x` is not `acme`'s `x`).
 */
export interface OrgCache<V> {
  get(org: OrgId, name: string): V | undefined;
  /** Stores `value`; with a `max` the oldest entry is dropped first when the cache is full. */
  set(org: OrgId, name: string, value: V): void;
  delete(org: OrgId, name: string): void;
  /** Drops every entry `drop` answers `true` for (an org's, or the entries of one name in every org). */
  deleteWhere(drop: (org: OrgId, name: string, value: V) => boolean): void;
  readonly size: number;
  clear(): void;
}

/** An empty {@link OrgCache}, bounded to `max` entries when given. */
export const makeOrgCache = <V>(max?: number): OrgCache<V> => {
  const entries = new Map<
    string,
    { readonly org: OrgId; readonly name: string; readonly value: V }
  >();

  // The org id never contains U+0000, so the first one ends the org part, whatever the name holds.
  const keyOf = (org: OrgId, name: string): string => `${org}\u0000${name}`;

  return {
    get: (org, name) => entries.get(keyOf(org, name))?.value,
    set: (org, name, value) => {
      const key = keyOf(org, name);

      if (max !== undefined && !entries.has(key) && entries.size >= max) {
        const oldest = entries.keys().next();

        if (oldest.done !== true) entries.delete(oldest.value);
      }

      entries.set(key, { org, name, value });
    },
    delete: (org, name) => {
      entries.delete(keyOf(org, name));
    },
    deleteWhere: (drop) => {
      for (const [key, entry] of entries)
        if (drop(entry.org, entry.name, entry.value)) entries.delete(key);
    },
    get size() {
      return entries.size;
    },
    clear: () => {
      entries.clear();
    },
  };
};
