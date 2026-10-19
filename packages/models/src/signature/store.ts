/**
 * The `CACHE` KV store of the signature cache (`SignatureStore`, `@commissary/translation/signature`).
 *
 * Go source: internal/cache/signature_cache.go home-KV branch (`signatureKVKey`, `SignatureCacheTTL`, KVSet with
 * expiry, KVGet + KVExpire sliding TTL). On Workers the store is the `CACHE` KV namespace with `expirationTtl`.
 * Every operation swallows failures: the signature cache is an optimisation, never a reason to fail a request.
 */
import {
  isolateSignatureCache,
  type MemorySignatureCache,
  SIGNATURE_CACHE_TTL_MS,
  type SignatureStore,
  signatureStoreKey,
} from "@commissary/translation/signature";
import type { OrgId, OrgKv } from "@commissary/core";

/**
 * The per-isolate signature cache of `org`. `@commissary/translation` cannot import `@commissary/core`, so its caches
 * are keyed by a plain scope string; this is where the scope is always an org id, never a free string.
 */
export const orgSignatureCache = (org: OrgId): MemorySignatureCache => isolateSignatureCache(org);

/** KV `expirationTtl` is in seconds (minimum 60). */
const TTL_SECONDS = SIGNATURE_CACHE_TTL_MS / 1000;

/** `CACHE` KV backed store of the org `kv` belongs to. */
export const makeKvSignatureStore = (kv: OrgKv): SignatureStore => ({
  get: async (modelName, text) => {
    try {
      const value = await kv.get(signatureStoreKey(modelName, text));

      return value === null ? undefined : value;
    } catch {
      return undefined;
    }
  },
  put: async ({ modelName, text, signature }) => {
    try {
      await kv.put(signatureStoreKey(modelName, text), signature, { expirationTtl: TTL_SECONDS });
    } catch {
      // best effort
    }
  },
  delete: async (modelName, text) => {
    try {
      await kv.delete(signatureStoreKey(modelName, text));
    } catch {
      // best effort
    }
  },
});
