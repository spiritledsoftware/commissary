import { StoreHookError } from "@commissary/store";
import type {
  Collection,
  CreateInput,
  RecordDefinition,
  Store,
  StoreCollections,
  StoreOperatorTypes,
} from "@commissary/store";

import type { ThreadRecordDefinitions, ThreadStoreHooks } from "./store-records.js";

interface RuntimeBeforeCreateHook {
  readonly beforeCreate: (input: { readonly draft: unknown }) => unknown;
}

function isRuntimeBeforeCreateHook(value: unknown): value is RuntimeBeforeCreateHook {
  return (
    typeof value === "object" &&
    value !== null &&
    "beforeCreate" in value &&
    typeof value.beforeCreate === "function"
  );
}

/** Wrap every configured Collection create with its typed before-create hook. */
export function addThreadStoreCreateHooks<
  Definitions extends ThreadRecordDefinitions,
  Operators extends StoreOperatorTypes,
>(
  store: Store<Definitions, Operators>,
  hooks: ThreadStoreHooks<Definitions> | undefined,
): Store<Definitions, Operators> {
  if (hooks === undefined) {
    return store;
  }

  const collections: Record<string, Collection<RecordDefinition, Operators>> = {};
  for (const [name, collectionValue] of Object.entries(store.collections)) {
    // SAFETY: StoreCollections maps every runtime entry to Collection with the matching Record Definition. This loop preserves the key and wraps only create.
    const collection = collectionValue as Collection<RecordDefinition, Operators>;
    const hook = Reflect.get(hooks, name);
    if (!isRuntimeBeforeCreateHook(hook)) {
      collections[name] = collection;
      continue;
    }
    const find: typeof collection.find = (options) => collection.find(options);
    const create: typeof collection.create = async (input) => {
      let hookOutput: unknown;
      try {
        hookOutput = hook.beforeCreate({ draft: input });
      } catch (cause) {
        throw new StoreHookError(name, cause);
      }
      // SAFETY: The public ThreadStoreHooks type requires the hook to return this Collection's complete CreateInput. The Collection performs strict runtime validation next.
      return collection.create(hookOutput as CreateInput<RecordDefinition>);
    };
    const update: typeof collection.update = (input) => collection.update(input);
    const deleteRecords: typeof collection.delete = (input) => collection.delete(input);
    const count: typeof collection.count = (input) => collection.count(input);
    collections[name] = Object.freeze({
      find,
      create,
      update,
      delete: deleteRecords,
      count,
    });
  }

  // SAFETY: The loop preserves every Collection key and operation and changes only create to run the matching typed hook first.
  return {
    collections: collections as StoreCollections<Definitions, Operators>,
  };
}
