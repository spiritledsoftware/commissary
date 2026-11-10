/**
 * Model capability lookup for translators that depend on the registry (e.g. `reasoning_effort` -> Claude thinking).
 *
 * Go source: internal/registry/model_registry.go `LookupModelInfo`. Executors scope the registry snapshot of the
 * current attempt with {@link withModelInfoLookup}; {@link setModelInfoLookup} installs a process-wide fallback (tests).
 */
import type { ModelInfoLookup, ThinkingModelInfo } from "../thinking/index.ts";

let lookup: ModelInfoLookup = () => undefined;

/** Installs the process-wide lookup (called once at startup or by tests). */
export const setModelInfoLookup = (next: ModelInfoLookup): void => {
  lookup = next;
};

/** The installed process-wide lookup, so a test can put it back after installing its own. */
export const getModelInfoLookup = (): ModelInfoLookup => lookup;

/**
 * Runs the synchronous `fn` with `next` installed (when given) and restores the previous lookup afterwards. The
 * request pipeline passes the registry snapshot of the current attempt (`ExecutorRequest.modelLookup`) this way.
 */
export const withModelInfoLookup = <T>(next: ModelInfoLookup | undefined, fn: () => T): T => {
  if (next === undefined) return fn();
  const previous = lookup;
  lookup = next;

  try {
    return fn();
  } finally {
    lookup = previous;
  }
};

/** `registry.LookupModelInfo(modelId, provider)`. */
export const lookupModelInfo = (modelId: string, provider: string): ThinkingModelInfo | undefined =>
  lookup(modelId.trim(), provider.trim().toLowerCase());
