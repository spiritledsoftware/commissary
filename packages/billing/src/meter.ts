/**
 * Counting requests against free usage, and the plan limit (ADR 0042): Models calls {@link countRequest} when it starts
 * serving a client API request. On Commissary Cloud it counts the request in the org's Billing part and, for a Free org
 * whose requests and tool calls of the month are used up, refuses it with {@link PlanLimitReached} (`429
 * plan_limit_reached`, `Retry-After` until the first of the next month UTC), and so for a Pay-as-you-go org whose
 * payment failed (Polar marked its subscription past due), which is held to Free's limits until a payment succeeds;
 * a Pay-as-you-go org's request that would be billed past its billing cap is refused the same way (#238). Work in
 * flight finishes. On a self-hosted Commissary it does nothing. A request the plan refuses is not counted, and
 * one that did no work (no upstream attempt: a spend limit, an unknown model, no credential) is taken back
 * ({@link uncountRequest}). New in the Workers port, no Go counterpart.
 *
 * The count is one atomic step of the org's ControlPlane (`BillingStore.admit`), so concurrent requests cannot pass the
 * limit together beyond what is in flight. An org the plan refused stays refused in the isolate for a short while
 * (`cache.ts`), so a client that retries against the limit does not reach the ControlPlane. A Billing part that cannot
 * be reached lets the request through (logged): serving needs the same object, so a refusal here would add nothing.
 */
import { Clock, Effect, Schema } from "effect";
import { CurrentOrg, type OrgId } from "@commissary/core";
import { isHosted } from "@commissary/auth";
import { panelPageUrl } from "@commissary/state";
import {
  BILLING_CAP_REFUSAL_TTL_MS,
  BILLING_TTL_MS,
  type CachedRefusal,
  refusals,
} from "./cache.ts";
import { type BillingBindings, BillingEnv, billingPartOf } from "./env.ts";
import { PlanLimitKind } from "./plan.ts";
import type { CeilingLimit, PlanRefusal } from "./store.ts";

export const PLAN_LIMIT_REACHED = "plan_limit_reached";

/**
 * A Free org used up its free usage of a unit for the month, or a Pay-as-you-go org's bill reached its billing cap. A
 * unit is requests and tool calls, browser hours or computer hours.
 */
export class PlanLimitReached extends Schema.TaggedError<PlanLimitReached>()("PlanLimitReached", {
  /** Names the limit and links to the billing page; safe to show. */
  message: Schema.String,
  /**
   * Which limit refused: free usage of a unit (requests and tool calls, browser hours, computer hours), or the billing
   * cap.
   */
  limit: PlanLimitKind,
  /** The month's free usage of the unit (requests and tool calls, or hours), or the billing cap in dollars. */
  allowed: Schema.Number,
  /** The seconds until free usage starts over (at least 1). */
  retryAfterSeconds: Schema.Number,
  /** ISO time of the first of the next month. */
  resetsAt: Schema.String,
}) {
  /** The JSON error body, in the shape of `spend_limit_reached`'s. */
  get body(): string {
    return JSON.stringify({
      error: {
        code: PLAN_LIMIT_REACHED,
        message: this.message,
        limit: this.limit,
        allowed: this.allowed,
        resets_at: this.resetsAt,
        reset_seconds: this.retryAfterSeconds,
      },
    });
  }
}

/** A request counted against a month (epoch ms of its start); `undefined` stands for one nothing was counted for. */
export interface CountedRequest {
  readonly monthStart: number;
}

/**
 * Where the panel's billing page of `org` is (`panelPageUrl`): asked once per refusal ({@link refusals} keeps the
 * answer), never for a request that is served.
 */
const billingPage = (env: BillingBindings, org: OrgId): Effect.Effect<string> =>
  panelPageUrl(env, org, "billing", "the billing page of the panel");

const groups = new Intl.NumberFormat("en-US");

const dollars = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

/**
 * The start of a refusal of free usage: the plan whose free usage is used up, and whether a failed payment put it
 * there.
 */
const heldTo = (pastDue: boolean): string =>
  pastDue
    ? "A payment failed: Pay as you go is held to the Free plan's limits until a payment succeeds, and the"
    : "The";

/** What a refusal says: the limit, when it starts over and where to see usage. */
const refusalMessage = (refusal: CachedRefusal, resetsAt: string): string => {
  if (refusal.limit === "billing_cap")
    return `The billing cap of ${dollars.format(refusal.allowed)} a month is reached: use that would be billed is refused until ${resetsAt} unless an org owner raises or removes the cap. Plan and usage: ${refusal.page}`;

  const held = heldTo(refusal.pastDue);
  const usage = `Plan and usage: ${refusal.page}`;

  if (refusal.limit === "computer_hours" && refusal.allowed <= 0)
    return `${held} Free plan has no computer hours: the computer needs Pay as you go. ${usage}`;

  const one = refusal.allowed === 1;

  const unit =
    refusal.limit === "requests"
      ? "requests and tool calls"
      : `${refusal.limit === "browser_hours" ? "browser" : "computer"} ${one ? "hour" : "hours"}`;

  return `${held} Free plan's ${groups.format(refusal.allowed)} ${unit} a month ${one ? "is" : "are"} used up; free usage starts over at ${resetsAt}. ${usage}`;
};

/** What a refused ceiling says: how many the plan lets the org have open at once, and where to see usage. */
const ceilingMessage = (refusal: CeilingLimit, page: string): string => {
  const usage = `Plan and usage: ${page}`;

  const held = refusal.pastDue
    ? " A payment failed: Pay as you go is held to the Free plan's limits."
    : "";

  if (refusal.limit === "computers" && refusal.allowed <= 0)
    return `The computer needs Pay as you go: the Free plan has none.${held} ${usage}`;

  const [many, one] =
    refusal.limit === "browserSessions"
      ? ["concurrent browser sessions", "concurrent browser session"]
      : ["concurrent computers", "concurrent computer"];

  return `The plan allows ${groups.format(refusal.allowed)} ${refusal.allowed === 1 ? one : many}, and that many are open: close one to open another.${held} ${usage}`;
};

/** The refusal of a request at `now`: what the month allows, when it starts over and where to see usage. */
const refused = (refusal: CachedRefusal, now: number): PlanLimitReached => {
  const resetsAt = new Date(refusal.resetsAt).toISOString();

  return new PlanLimitReached({
    message: refusalMessage(refusal, resetsAt),
    limit: refusal.limit,
    allowed: refusal.allowed,
    retryAfterSeconds: Math.max(1, Math.ceil((refusal.resetsAt - now) / 1000)),
    resetsAt,
  });
};

/**
 * A request of the current org starts being served: counts it, or fails with {@link PlanLimitReached}. Succeeds with
 * what to take back ({@link uncountRequest}), `undefined` where nothing was counted (a self-hosted Commissary, or a
 * Billing part that could not be reached).
 */
export const countRequest: Effect.Effect<
  CountedRequest | undefined,
  PlanLimitReached,
  BillingEnv | CurrentOrg
> = Effect.gen(function* () {
  const env = yield* BillingEnv;

  if (!isHosted(env)) return undefined;
  const org = yield* CurrentOrg;
  const now = yield* Clock.currentTimeMillis;
  const known = refusals.get(org, now);

  // An org the plan refused a moment ago is refused again without asking its ControlPlane.
  if (known !== undefined) return yield* refused(known, now);

  const admission = yield* Effect.tryPromise(
    async () => await billingPartOf(env, org).admit(now),
  ).pipe(
    Effect.catch((error) =>
      Effect.logWarning(`request not counted: ${error.message}`).pipe(Effect.as(undefined)),
    ),
  );

  if (admission === undefined) return undefined;

  if (admission.ok) return { monthStart: admission.monthStart };

  const { limit } = admission;
  const page = yield* billingPage(env, org);

  const refusal = {
    limit: limit.limit,
    allowed: limit.allowed,
    resetsAt: limit.resetsAt,
    page,
    pastDue: limit.pastDue,
  };

  // A cap an owner raises in the app Worker must reach this isolate soon: its refusals lapse sooner than Free's.
  const ttl = limit.limit === "billing_cap" ? BILLING_CAP_REFUSAL_TTL_MS : BILLING_TTL_MS;

  refusals.set(org, refusal, Math.min(limit.resetsAt, now + ttl));

  return yield* refused(refusal, now);
});

/** Takes back a request {@link countRequest} counted (one that did no work); never fails. */
export const uncountRequest = (
  counted: CountedRequest | undefined,
): Effect.Effect<void, never, BillingEnv | CurrentOrg> =>
  Effect.gen(function* () {
    if (counted === undefined) return;
    const env = yield* BillingEnv;
    const org = yield* CurrentOrg;

    yield* Effect.tryPromise(
      async () => await billingPartOf(env, org).refund(counted.monthStart),
    ).pipe(Effect.catch((error) => Effect.logWarning(`request not taken back: ${error.message}`)));
  });

/**
 * The name a refusal's limit or ceiling has on the wire (#241): the `limit` of a `plan_limit_reached` body, and of the
 * MCP endpoint's `_meta`: snake_case, as the plan limits' are (`browser_sessions`; `computers` is one word).
 */
export const planLimitName = (refusal: PlanRefusal): string =>
  refusal.limit === "browserSessions" ? "browser_sessions" : refusal.limit;

/**
 * What a refusal of the Tools part says (#241): the limit or ceiling it names, when free usage starts over for a
 * limit, and the link to the panel's billing page. A refused browser or computer call, or tool call, answers this as
 * its tool error; never fails.
 */
export const planRefusalText = (
  refusal: PlanRefusal,
): Effect.Effect<string, never, BillingEnv | CurrentOrg> =>
  Effect.gen(function* () {
    const env = yield* BillingEnv;
    const org = yield* CurrentOrg;
    const page = yield* billingPage(env, org);

    if (refusal.kind === "ceiling") return ceilingMessage(refusal, page);

    return refusalMessage(
      {
        limit: refusal.limit,
        allowed: refusal.allowed,
        resetsAt: refusal.resetsAt,
        page,
        pastDue: refusal.pastDue,
      },
      new Date(refusal.resetsAt).toISOString(),
    );
  });
