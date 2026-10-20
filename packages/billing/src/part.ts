/**
 * The Billing part of an org's ControlPlane (#134 "How an area's ControlPlane part works", #148): the single writer for
 * the org's plan and its free-usage counters (`store.ts`). An `RpcTarget` the composed `ControlPlane` constructs once
 * per object (`new BillingPart(ctx)`); callers reach it as `stub.billing().x(…)`, one pipelined round trip. Methods
 * exchange plain data only. New in the Workers port, no Go counterpart.
 *
 * The part itself does not know the deployment's mode: on a self-hosted Commissary nothing calls it (`env.ts`,
 * `meter.ts`), so it stores nothing there.
 *
 * It has no secrets, no alarm and nothing of a member's: the base's notices of what changed (`memberLeft`, `teamDeleted`,
 * …) mean nothing to it.
 */
import { RpcTarget } from "cloudflare:workers";
import type { ControlPlanePart } from "@commissary/state";
import type { Plan } from "./plan.ts";
import { type Admission, BillingStore, type BillingUsage } from "./store.ts";

export class BillingPart extends RpcTarget implements ControlPlanePart {
  readonly #store: BillingStore;

  constructor(ctx: DurableObjectState) {
    super();
    this.#store = new BillingStore(ctx.storage.sql);
  }

  /** The org's plan: `free` until one is set. */
  plan(): Plan {
    return this.#store.plan();
  }

  /** Sets the org's plan (switching it through Polar is #237's; tests set it directly). */
  setPlan(plan: Plan): void {
    this.#store.setPlan(plan);
  }

  /** The org's plan and what it used in the month containing `now` (epoch ms). */
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
}
