/**
 * The Billing part of an org's ControlPlane (#134 "How an area's ControlPlane part works", #148): the single writer for
 * the org's plan, its free-usage counters and its billing cap, what Polar knows the org by and was sent of its usage,
 * and what a platform admin set for it (unbilled, raised ceilings; `store.ts`). An `RpcTarget` the composed
 * `ControlPlane` constructs once per object (`new BillingPart(ctx)`); callers reach it as `stub.billing().x(…)`, one
 * pipelined round trip. Methods exchange plain data only. New in the Workers port, no Go counterpart.
 *
 * The part itself does not know the deployment's mode: on a self-hosted Commissary nothing calls it (`env.ts`,
 * `meter.ts`), so it stores nothing there.
 *
 * It has no secrets, no alarm and nothing of a member's: the base's notices of what changed (`memberLeft`, `teamDeleted`,
 * …) mean nothing to it.
 */
import { RpcTarget } from "cloudflare:workers";
import type { ControlPlanePart } from "@commissary/state";
import type { CeilingKind, Ceilings, Plan, RaisedCeilings } from "./plan.ts";
import type { PlanMeter } from "./plan-meter.ts";
import {
  type Admission,
  BillingStore,
  type BillingUsage,
  type CeilingLimit,
  type MeterBatch,
  type PlanLimit,
  type RateCeiling,
  type SubscriptionChange,
} from "./store.ts";

export class BillingPart extends RpcTarget implements ControlPlanePart, PlanMeter {
  readonly #store: BillingStore;

  constructor(ctx: DurableObjectState) {
    super();
    this.#store = new BillingStore(ctx.storage.sql);
  }

  /** The org's plan: `free` until one is set. */
  plan(): Plan {
    return this.#store.plan();
  }

  /** Sets the org's plan directly (tests; Polar's webhooks go through {@link applySubscription}). */
  setPlan(plan: Plan): void {
    this.#store.setPlan(plan);
  }

  /** The plan whose limits apply: Free's while a Pay-as-you-go org is past due. */
  limitsPlan(): Plan {
    return this.#store.limitsPlan();
  }

  /** An org owner set the billing cap: dollars a month, `null` for none. Applies to the next request. */
  setBillingCap(cap: number | null): void {
    this.#store.setBillingCap(cap);
  }

  /** A platform admin marks the org unbilled, or not (`BillingStore.setUnbilled`). */
  setUnbilled(unbilled: boolean): void {
    this.#store.setUnbilled(unbilled);
  }

  /** A platform admin raises the given ceilings for the org; `null` restores the plan's. */
  raiseCeilings(raised: Partial<RaisedCeilings>): void {
    this.#store.raiseCeilings(raised);
  }

  /** The ceilings that apply to the org: its plan's, raised where a platform admin raised them. */
  ceilings(): Ceilings {
    return this.#store.ceilings();
  }

  /** The org's request-rate ceiling: its plan's binding, or a raised one this part counts ({@link admitRate}). */
  rateCeiling(): RateCeiling {
    return this.#store.rateCeiling();
  }

  /** Counts a request at `now` against the org's raised request rate; answers whether it is within it. */
  admitRate(now: number): boolean {
    return this.#store.admitRate(now);
  }

  /** Records the org's Polar customer. */
  setCustomer(customerId: string): void {
    this.#store.setCustomer(customerId);
  }

  /** Applies what Polar reports of the org's subscription; answers whether anything changed. */
  applySubscription(change: SubscriptionChange): boolean {
    return this.#store.applySubscription(change);
  }

  /** An org owner switched to Free at `now`: answers the subscription to cancel, `null` when there was none. */
  endSubscription(now: number): string | null {
    return this.#store.endSubscription(now);
  }

  /** The usage not sent to Polar yet (the batch on its way first), `null` for none. */
  meterBatch(now: number): MeterBatch | null {
    return this.#store.meterBatch(now);
  }

  /** Polar took the batch `id`. */
  meterBatchSent(id: string): void {
    this.#store.meterBatchSent(id);
  }

  /** The org's plan, what it used and billed in the month containing `now` (epoch ms), and its billing cap. */
  usage(now: number): BillingUsage {
    return this.#store.usage(now);
  }

  /** A request starts being served at `now`: counted, or refused by the plan's limit (`BillingStore.admit`). */
  admit(now: number): Admission {
    return this.#store.admit(now);
  }

  /** Takes back the request `admit` counted against `monthStart`. */
  refund(monthStart: number): void {
    this.#store.refund(monthStart);
  }

  /** The plan limit that refuses the next use of `unit` at `now` (#241), if any; counts nothing. */
  limitOf(unit: "requests" | "browserHours" | "computerHours", now: number): PlanLimit | undefined {
    return this.#store.limitOf(unit, now);
  }

  /** Counts `ms` of browser or computer time used up to `now` (#241). */
  addTime(unit: "browserHours" | "computerHours", ms: number, now: number): void {
    this.#store.addTime(unit, ms, now);
  }

  /** Whether the org, with `open` browser sessions or computers open, has reached the ceiling for another (#241). */
  checkCeiling(kind: CeilingKind, open: number): CeilingLimit | undefined {
    return this.#store.checkCeiling(kind, open);
  }

  sealPlaintext(): number {
    return 0;
  }

  alarm(): Promise<number | null> {
    return Promise.resolve(null);
  }

  /** Deletes the part's tables (their indexes go with them): the org was deleted (`wipeOrg`). */
  wipe(): void {
    this.#store.drop();
  }

  memberLeft(): Promise<void> {
    return Promise.resolve();
  }

  teamDeleted(): void {}

  teamMembersChanged(): void {}

  apiKeysDeleted(): void {}

  privateCredentialsChanged(): void {}

  /** Billing holds no credentials: no Spend limit names one of its. */
  spendCredentials(): readonly [] {
    return [];
  }

  /** Nor agents. */
  spendAgents(): readonly [] {
    return [];
  }
}
