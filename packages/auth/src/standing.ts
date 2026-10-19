/**
 * Sign-up and suspension on Commissary Cloud (ADR 0026): the auth Worker signs a person up when their sign-in starts a
 * session ({@link ensureSignedUp}), and the gate (`hosted-gate.ts`) checks standing on every request.
 *
 * A person who signs in for the first time without a membership gets a Personal org with them as its org owner; one
 * the index lists in some org was invited and gets none (the Platform registry decides, `PlatformStore.signIn`). A
 * suspended org or person is refused everywhere. Answers are cached per isolate for {@link STANDING_TTL_MS}, like
 * verified API keys (`api-key.ts`): a suspension applies within that time everywhere, and at once in the isolate
 * that made it (`forgetStanding`). New in the Workers port.
 */
import { Clock, Effect } from "effect";
import {
  ForbiddenError,
  GLOBAL_ORG,
  InternalError,
  makeOrgCache,
  type OrgId,
} from "@commissary/core";
import { syncOrgIndex } from "./admission.ts";
import { AuthDirectory, directoryFailure, type Standing } from "./directory.ts";

/** How long an isolate trusts a person's or an org's standing without asking the registry again. */
export const STANDING_TTL_MS = 30_000;

/** People known to be signed up and not suspended, until the epoch ms. */
const signedUp = new Map<string, number>();

const MAX_CACHED = 4096;

/** Standings of an org by email, until the epoch ms; the oldest goes first when it is full. */
const standings = makeOrgCache<{ readonly standing: Standing; readonly until: number }>(MAX_CACHED);

const remember = <V>(cache: Map<string, V>, key: string, value: V): void => {
  if (cache.size >= MAX_CACHED) {
    const oldest = cache.keys().next();

    if (oldest.done !== true) cache.delete(oldest.value);
  }

  cache.set(key, value);
};

/** Forgets what this isolate knows of a person or an org, after a platform admin changed it. */
export const forgetStanding = (change: { readonly email?: string; readonly org?: OrgId }): void => {
  if (change.email !== undefined) signedUp.delete(change.email.toLowerCase());

  standings.deleteWhere(
    (org, email) =>
      (change.org !== undefined && org === change.org) ||
      (change.email !== undefined && email === change.email.toLowerCase()),
  );
};

/** Empties the caches, for tests. */
export const resetStandingCaches = (): void => {
  signedUp.clear();
  standings.clear();
};

export const SUSPENDED = "Suspended";

/**
 * Signs up a person who signed in with a verified email, once: an invited person is signed up as they are, anyone
 * else becomes the org owner of a new Personal org first. A suspended person is refused (403). The auth Worker runs it
 * before a sign-in starts a session (ADR 0030, #132), so no session exists for someone it refused.
 */
export const ensureSignedUp = (
  email: string,
): Effect.Effect<void, ForbiddenError | InternalError, AuthDirectory> =>
  Effect.gen(function* () {
    const address = email.toLowerCase();
    const now = yield* Clock.currentTimeMillis;

    if (now < (signedUp.get(address) ?? 0)) return;
    signedUp.delete(address);
    const directory = yield* AuthDirectory;
    const state = yield* directory.signIn(address, now).pipe(Effect.mapError(directoryFailure()));

    if (state.kind === "suspended") return yield* new ForbiddenError({ message: SUSPENDED });

    if (state.kind === "personal") {
      const org = state.org.id;

      const added = yield* directory
        .addMember(
          org,
          { email: address, role: "owner" },
          { role: "owner", sensitive: false },
          "sign-up",
        )
        .pipe(Effect.mapError(directoryFailure("sign-up")));

      // A retry after a failure further down finds them a member already.
      if (!added.ok && added.error !== "member_exists")
        return yield* new InternalError({ message: `sign-up: ${added.error}` });
      yield* syncOrgIndex(org);
      yield* directory.finishSignUp(address, now).pipe(Effect.mapError(directoryFailure()));
      yield* Effect.logInfo("signed up with a Personal org").pipe(Effect.annotateLogs({ org }));
    }

    remember(signedUp, address, now + STANDING_TTL_MS);
  });

/** Where `org` and the person with `email` stand, cached for {@link STANDING_TTL_MS}. */
const cachedStanding = Effect.fnUntraced(function* (
  org: OrgId,
  email: string | undefined,
): Effect.fn.Return<Standing, InternalError, AuthDirectory> {
  const person = email?.toLowerCase() ?? "";
  const now = yield* Clock.currentTimeMillis;
  const cached = standings.get(org, person);

  const standing =
    cached !== undefined && now < cached.until
      ? cached.standing
      : yield* (yield* AuthDirectory)
          .standing(org, email)
          .pipe(Effect.mapError(directoryFailure()));

  if (cached === undefined || now >= cached.until)
    standings.set(org, person, { standing, until: now + STANDING_TTL_MS });

  return standing;
});

/**
 * Where `org` and the person with `email` stand (cached); refuses (403 `Suspended`) a suspended org or person. A
 * missing org is left to the caller.
 */
export const requireStanding = Effect.fnUntraced(function* (
  org: OrgId,
  email: string | undefined,
): Effect.fn.Return<Standing, ForbiddenError | InternalError, AuthDirectory> {
  const standing = yield* cachedStanding(org, email);

  if (standing.org === "suspended" || standing.person === "suspended")
    return yield* new ForbiddenError({ message: SUSPENDED });

  return standing;
});

/** Refuses (403 `Suspended`) a suspended person, whatever their orgs' standing (a platform admin's, cached). */
export const requireActivePerson = Effect.fnUntraced(function* (
  email: string,
): Effect.fn.Return<void, ForbiddenError | InternalError, AuthDirectory> {
  if ((yield* cachedStanding(GLOBAL_ORG, email)).person === "suspended")
    return yield* new ForbiddenError({ message: SUSPENDED });
});
