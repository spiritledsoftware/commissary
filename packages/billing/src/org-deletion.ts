/**
 * Billing's step of deleting an org (ADR 0027, #134 "Org deletion and crons"): what Billing keeps outside the org's
 * ControlPlane. Nothing yet (the plan and the counters are tables of the Billing part, which go with `wipeOrg`); the
 * Polar subscription, once there is one (#237), is cancelled here. The app Worker's org deletion
 * (`platform/org-deletion.ts`) runs it with the other areas' steps.
 */
import { Effect } from "effect";
import type { OrgDeletionStep } from "@commissary/core";
import type { BillingEnv } from "./env.ts";

export const deleteOrgBilling: OrgDeletionStep = () =>
  Promise.resolve({ complete: true, calls: 0 });

/** Billing's step over the invocation's bindings. */
export const orgDeletionStep: Effect.Effect<OrgDeletionStep, never, BillingEnv> =
  Effect.succeed(deleteOrgBilling);
