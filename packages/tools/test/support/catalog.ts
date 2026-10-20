// The toolkit catalog's registry as a test of the Worker sets it (#207): a fixture's records stored in KV where the cron
// refresh stores integrations.sh's (`catalog/stored.ts`), and the isolate's catalog dropped so the next request builds
// it from them, merged with the bundled additions. Without one (`undefined`), the bundled snapshot's catalog again.
import { Effect } from "effect";
import { CATALOG_KEYS, forgetCatalog } from "../../src/catalog/stored.ts";

export const useToolkitCatalogRegistry = async (
  kv: KVNamespace,
  registry: { readonly version: 1; readonly data: ReadonlyArray<unknown> } | undefined,
): Promise<void> => {
  await (registry === undefined
    ? kv.delete(CATALOG_KEYS.registry)
    : kv.put(CATALOG_KEYS.registry, JSON.stringify(registry)));
  await Effect.runPromise(forgetCatalog);
};
