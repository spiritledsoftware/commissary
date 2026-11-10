/**
 * Model-name helpers shared by selection and routing.
 *
 * Go source: internal/thinking/suffix.go (`ParseSuffix`), sdk/cliproxy/auth/selector.go (`canonicalModelKey`),
 * sdk/cliproxy/service_models.go (`matchWildcard`, `applyExcludedModels`).
 */

export interface ModelSuffix {
  readonly modelName: string;
  readonly hasSuffix: boolean;
  readonly rawSuffix: string;
}

/** `thinking.ParseSuffix`: the last `(` starts a suffix when the string ends with `)`. */
export const parseModelSuffix = (model: string): ModelSuffix => {
  const lastOpen = model.lastIndexOf("(");

  if (lastOpen === -1 || !model.endsWith(")"))
    return { modelName: model, hasSuffix: false, rawSuffix: "" };

  return {
    modelName: model.slice(0, lastOpen),
    hasSuffix: true,
    rawSuffix: model.slice(lastOpen + 1, -1),
  };
};

/** `canonicalModelKey`: trims and strips the thinking suffix. */
export const canonicalModelKey = (model: string): string => {
  const trimmed = model.trim();

  if (trimmed === "") return "";
  const name = parseModelSuffix(trimmed).modelName.trim();

  return name === "" ? trimmed : name;
};

/** `canonicalModelLookupKey` (CLIProxyAPI 098af7d5): the canonical key folded to lower case, for case-insensitive lookups. */
export const canonicalModelLookupKey = (model: string): string =>
  canonicalModelKey(model).toLowerCase();

const coolsUntil = (state?: {
  readonly nextRetryAfter: number;
  readonly quota: { readonly nextRecoverAt: number };
}): number => Math.max(state?.nextRetryAfter ?? 0, state?.quota.nextRecoverAt ?? 0);

/**
 * The key of `model`'s state in a per-model record (`modelStates`): the exact canonical key when stored, else a stored
 * spelling that differs only in case (the stored casing is kept). Of several spellings, the longest-cooling one wins.
 */
export const findModelStateKey = <
  T extends { readonly nextRetryAfter: number; readonly quota: { readonly nextRecoverAt: number } },
>(
  states: Readonly<Record<string, T>>,
  model: string,
): string | undefined => {
  const key = canonicalModelKey(model);

  if (key === "") return undefined;

  if (Object.hasOwn(states, key)) return key;
  const lookup = key.toLowerCase();
  let found: string | undefined;

  for (const [stateModel, state] of Object.entries(states)) {
    if (canonicalModelLookupKey(stateModel) !== lookup) continue;

    if (found === undefined || coolsUntil(state) > coolsUntil(states[found])) found = stateModel;
  }

  return found;
};

/** `existingModelState`: the state of `model` under any spelling. */
export const findModelState = <
  T extends { readonly nextRetryAfter: number; readonly quota: { readonly nextRecoverAt: number } },
>(
  states: Readonly<Record<string, T>>,
  model: string,
): T | undefined => {
  const key = findModelStateKey(states, model);

  return key === undefined ? undefined : states[key];
};

/** `preserveResolvedModelSuffix`: re-attach the request's suffix unless the resolved name has its own. */
export const preserveResolvedSuffix = (resolved: string, request: ModelSuffix): string => {
  const name = resolved.trim();

  if (name === "") return "";

  if (parseModelSuffix(name).hasSuffix) return name;

  if (request.hasSuffix && request.rawSuffix !== "") return `${name}(${request.rawSuffix})`;

  return name;
};

/** Case-insensitive `*` wildcard match (`gpt-*`, `*-preview`, `a*b`); `*` matches any substring. */
export const matchWildcard = (pattern: string, value: string): boolean => {
  if (pattern === "") return false;

  if (!pattern.includes("*")) return pattern === value;
  const parts = pattern.split("*");
  let rest = value;
  const [prefix = ""] = parts;

  if (prefix !== "") {
    if (!rest.startsWith(prefix)) return false;
    rest = rest.slice(prefix.length);
  }

  const suffix = parts.at(-1) ?? "";

  if (suffix !== "") {
    if (!rest.endsWith(suffix)) return false;
    rest = rest.slice(0, rest.length - suffix.length);
  }

  for (let index = 1; index < parts.length - 1; index += 1) {
    const segment = parts[index] ?? "";

    if (segment === "") continue;
    const at = rest.indexOf(segment);

    if (at < 0) return false;
    rest = rest.slice(at + segment.length);
  }

  return true;
};

/** Normalises exclusion patterns: trimmed, lower-cased, de-duplicated, sorted (`ApplyAuthExcludedModelsMeta`). */
export const normalizeExclusions = (
  ...lists: ReadonlyArray<ReadonlyArray<string> | undefined>
): string[] => {
  const seen = new Set<string>();

  for (const list of lists) {
    for (const entry of list ?? []) {
      const trimmed = entry.trim().toLowerCase();

      if (trimmed !== "") seen.add(trimmed);
    }
  }

  return [...seen].toSorted();
};

/** Whether any pattern excludes `model` (case-insensitive, thinking suffix ignored). */
export const isModelExcluded = (patterns: ReadonlyArray<string>, model: string): boolean => {
  if (patterns.length === 0) return false;
  const id = canonicalModelKey(model).toLowerCase();

  if (id === "") return false;

  return patterns.some((pattern) => matchWildcard(pattern, id));
};
