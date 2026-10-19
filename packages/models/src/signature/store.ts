/**
 * The `CACHE` KV store of the signature cache (`SignatureStore`, `@commissary/translation/signature`).
 *
 * Go source: internal/cache/signature_cache.go home-KV branch (`signatureKVKey`, `SignatureCacheTTL`, KVSet with
 * expiry, KVGet + KVExpire sliding TTL). On Workers the store is the `CACHE` KV namespace with `expirationTtl`.
 * Every operation swallows failures: the signature cache is an optimisation, never a reason to fail a request.
 */
import {
  SIGNATURE_CACHE_TTL_MS,
  type SignatureStore,
  signatureStoreKey,
} from "@commissary/translation/signature";
import type { OrgKv } from "@commissary/core";

/** KV `expirationTtl` is in seconds (minimum 60). */
const TTL_SECONDS = SIGNATURE_CACHE_TTL_MS / 1000;

/** `CACHE` KV backed store of the org `kv` belongs to. */
export const makeKvSignatureStore = (kv: OrgKv): SignatureStore => {
  const key = signatureStoreKey;

  return {
    get: async (modelName, text) => {
      try {
        const value = await kv.get(key(modelName, text));

        return value === null ? undefined : value;
      } catch {
        return undefined;
      }
    },
    put: async ({ modelName, text, signature }) => {
      try {
        await kv.put(key(modelName, text), signature, { expirationTtl: TTL_SECONDS });
      } catch {
        // best effort
      }
    },
    delete: async (modelName, text) => {
      try {
        await kv.delete(key(modelName, text));
      } catch {
        // best effort
      }
    },
  };
};
