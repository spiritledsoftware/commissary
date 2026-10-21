/**
 * The port through which the Tools part counts what plans count of it (#241), `@commissary/billing/api`'s `PlanMeter`:
 * the org's Billing part, seen by the Tools part of the same ControlPlane Durable Object. The state Worker's
 * composition hands it over (`apps/state/src/control-plane.ts`) on Commissary Cloud only, so a self-hosted
 * Commissary's Tools part has none and counts and limits nothing. Everything is synchronous and exchanges plain data,
 * as the Billing part's methods do (`BillingPart` implements it).
 */
import { isHosted } from "@commissary/auth";
import type { CeilingKind } from "./plan.ts";
import type { Admission, CeilingLimit, PlanLimit } from "./store.ts";

export interface PlanMeter {
  /** A tool call starts being served at `now`: counted with requests, or refused by a plan limit (`admit`). */
  admit(now: number): Admission;
  /** Takes back the tool call `admit` counted against `monthStart`: it did no work. */
  refund(monthStart: number): void;
  /** The plan limit that refuses the next use of `unit` at `now`, `undefined` when none does. Counts nothing. */
  limitOf(unit: "requests" | "browserHours" | "computerHours", now: number): PlanLimit | undefined;
  /** Counts `ms` of browser or computer time used up to `now`. */
  addTime(unit: "browserHours" | "computerHours", ms: number, now: number): void;
  /** The ceiling of `kind` the org is held to, and whether the `open` sessions or computers it has reach it. */
  checkCeiling(kind: CeilingKind, open: number): CeilingLimit | undefined;
}

/**
 * `part` as the Tools part counts through it: Commissary Cloud's, where plans exist; `undefined` on a self-hosted
 * Commissary, whose Tools part then counts and limits nothing.
 */
export const planMeterOf = (
  env: { readonly COMMISSARY_MODE?: string | undefined },
  part: PlanMeter | undefined,
): PlanMeter | undefined => (isHosted(env) ? part : undefined);
