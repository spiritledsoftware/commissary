/**
 * One deployment-wide piece of work at a time under a named lease of the Platform registry (`lease.ts`): the Models
 * area's model catalog refresh (`catalog_refresh`) and the Tools area's toolkit catalog refresh
 * (`toolkit_catalog_refresh`), started by the cron task or the panel in whichever isolates. The lease is not renewed: the
 * work is bounded well within `LEASE_TTL_MS`.
 *
 * {@link withPlatformLease} takes the lease, runs the work and gives the lease back. A second caller finds it `held`
 * (and by whom) without running anything; a Platform registry that cannot be reached is `unavailable`, and nothing runs
 * (exclusivity cannot be shown). The invocation is held open until the lease is given back (`holdInvocation`), so a
 * request the client abandoned still releases it; a lease never released expires.
 */
import { Effect } from "effect";
import { holdInvocation } from "@commissary/core";
import type { LeaseSource, NamedLease } from "../lease.ts";
import type { StateBindings } from "../env.ts";
import { platformOf } from "./registry.ts";

/** What {@link withPlatformLease} did: ran the work (its result), or found the lease held or the registry unreachable. */
export type UnderLease<A> =
  | { readonly kind: "ran"; readonly value: A }
  | { readonly kind: "held"; readonly held: NamedLease }
  | { readonly kind: "unavailable" };

type Taken =
  | { readonly kind: "taken"; readonly token: string }
  | { readonly kind: "held"; readonly held: NamedLease }
  | { readonly kind: "unavailable" };

/** `work` under the Platform registry's lease `name`, for work `source` started. */
export const withPlatformLease = <A, E, R>(
  env: Pick<StateBindings, "PLATFORM">,
  name: string,
  source: LeaseSource,
  work: Effect.Effect<A, E, R>,
): Effect.Effect<UnderLease<A>, E, R> =>
  Effect.acquireUseRelease(
    Effect.gen(function* () {
      const hold = yield* holdInvocation;

      const taken = yield* Effect.tryPromise(async (): Promise<Taken> => {
        const lease = await platformOf(env).takeLease(name, source);

        return lease.ok
          ? { kind: "taken", token: lease.lease.token }
          : { kind: "held", held: lease.held };
      }).pipe(Effect.orElseSucceed((): Taken => ({ kind: "unavailable" })));

      return { hold, taken };
    }),
    ({ taken }): Effect.Effect<UnderLease<A>, E, R> =>
      taken.kind === "taken"
        ? Effect.map(work, (value) => ({ kind: "ran", value }))
        : Effect.succeed(taken),
    ({ hold, taken }) =>
      (taken.kind === "taken"
        ? Effect.tryPromise(() => platformOf(env).releaseLease(taken.token)).pipe(Effect.ignore)
        : Effect.void
      ).pipe(Effect.ensuring(Effect.sync(hold))),
  );

/** What a refresh that found the lease held answers: who started the one holding it, and when. */
export const refreshRunningMessage = (held: NamedLease): string =>
  `a refresh started by ${held.source === "cron" ? "the scheduled refresh" : "the panel"} at ${new Date(held.startedAt).toISOString()} is still running`;
