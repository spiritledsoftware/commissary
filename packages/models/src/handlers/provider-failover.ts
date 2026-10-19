/**
 * Request-level state of failover across providers (issue #185; not in Go): the providers excluded after an upstream
 * 400/422 that may be specific to them, and the first such error. It lives for one request, across retry rounds.
 */
import type { ExecutionError } from "../executor/errors.ts";

/** How selection compares provider keys (`selectCredential` normalises `PickRequest.providers` the same way). */
const providerKey = (provider: string): string => provider.trim().toLowerCase();

export interface ProviderFailover {
  /** The providers still allowed for the request, in preference order: what `pick` and `planRetry` are given. */
  readonly remaining: () => ReadonlyArray<string>;
  /**
   * Excludes `provider` for the rest of the request and remembers `error` when it is the first one. Returns the first
   * error that caused an exclusion.
   */
  readonly exclude: (provider: string, error: ExecutionError) => ExecutionError;
  /** The first error that caused an exclusion: the request's answer when no attempt succeeds. */
  readonly firstFault: () => ExecutionError | undefined;
}

export const providerFailover = (providers: ReadonlyArray<string>): ProviderFailover => {
  const excluded = new Set<string>();
  let first: ExecutionError | undefined;

  return {
    remaining: () => providers.filter((provider) => !excluded.has(providerKey(provider))),
    exclude: (provider, error) => {
      excluded.add(providerKey(provider));
      first ??= error;

      return first;
    },
    firstFault: () => first,
  };
};
