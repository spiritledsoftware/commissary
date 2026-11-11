/**
 * The dot-delimited suffix a router such as OpenRouter appends after a native reasoning envelope.
 *
 * Go source: internal/signature/meta_validation.go (`isValidMetaRouterSuffix`, `maxMetaRouterSuffixLen`) and
 * internal/runtime/executor/openai_responses_signature.go (`stripRouterSuffix`). GPT, Grok and Meta all share it.
 */

/** `maxMetaRouterSuffixLen`: observed suffixes are well under this bound. */
export const MAX_ROUTER_SUFFIX_LEN = 128;

const ROUTER_SUFFIX = /^[A-Za-z0-9]+$/;

/** `isValidMetaRouterSuffix`: one run of alphanumeric characters, so it is never mistaken for more envelope payload. */
export const isValidRouterSuffix = (suffix: string): boolean =>
  suffix.length > 0 && suffix.length <= MAX_ROUTER_SUFFIX_LEN && ROUTER_SUFFIX.test(suffix);

export interface RouterSplit {
  /** The native envelope, without the suffix. */
  readonly native: string;
  /** The suffix, `""` for a native value. */
  readonly routerSuffix: string;
}

/**
 * Splits at the first `.` (no native alphabet contains one); `undefined` when what follows is not a valid router
 * suffix (an empty one, a second dot, a non-alphanumeric character or one over the bound).
 */
export const splitRouterSuffix = (signature: string): RouterSplit | undefined => {
  const dot = signature.indexOf(".");

  if (dot < 0) return { native: signature, routerSuffix: "" };
  const routerSuffix = signature.slice(dot + 1);

  return isValidRouterSuffix(routerSuffix)
    ? { native: signature.slice(0, dot), routerSuffix }
    : undefined;
};

/** `stripRouterSuffix`: the native envelope of `signature` when it ends in `.<suffix>`. */
export const stripRouterSuffix = (signature: string, suffix: string): string =>
  suffix === "" || signature.length <= suffix.length + 1
    ? signature
    : signature.slice(0, signature.length - suffix.length - 1);
