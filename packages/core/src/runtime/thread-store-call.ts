import { ThreadStoreError } from "../store.js";

/** Translate one Thread Store exception into its stable Runtime error. */
export async function threadStoreCall<Value>(
  operation: string,
  evaluate: () => PromiseLike<Value>,
): Promise<Value> {
  try {
    return await evaluate();
  } catch (cause) {
    if (cause instanceof ThreadStoreError) {
      throw cause;
    }
    throw new ThreadStoreError(operation, cause);
  }
}
