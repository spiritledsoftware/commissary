/**
 * What an area (Models, Tools, Billing) hands the Workers that mount it (#134 "The area package
 * convention"): its cron tasks, which the API Worker's cron runner runs, and its org-deletion step, which the app
 * Worker's org deletion runs. Each Worker lists the areas it mounts explicitly; there is no registry.
 */
import type { Effect } from "effect";
import type { CurrentOrg, OrgId } from "./org.ts";

/**
 * One cron job. A job is either deployment-wide (`scope: "deployment"`: a shared catalog, client versions) and runs once
 * per cron invocation, or org-scoped (`scope: "org"`: credentials, quotas) and runs once for every org with
 * `CurrentOrg` set. `R` is what the job reads besides the org; the runner provides it.
 */
export type ScheduledTask<R = never> =
  | {
      readonly name: string;
      readonly scope: "deployment";
      readonly run: Effect.Effect<unknown, Error, R>;
    }
  | {
      readonly name: string;
      readonly scope: "org";
      readonly run: Effect.Effect<unknown, Error, R | CurrentOrg>;
    };

/** How far one call of an {@link OrgDeletionStep} got. */
export type OrgDeletionProgress =
  | { readonly complete: true; readonly calls: number }
  | {
      readonly complete: false;
      readonly calls: number;
      /** The part of the step that stopped (Models: `usage`, `cache`), for the caller's log. */
      readonly part: string;
    };

/**
 * An area's part of deleting an org: removes the org's data the area keeps outside the ControlPlane (the parts'
 * `wipe()` covers that). `budget` is what is left of the deletion's subrequests (a Worker invocation has a limit); the
 * step keeps within it and reports the calls it made. A step that stops short answers `complete: false` and runs again
 * with the next deletion request, so it must be safe to repeat.
 */
export type OrgDeletionStep = (org: OrgId, budget: number) => Promise<OrgDeletionProgress>;
