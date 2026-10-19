/**
 * Models' step of deleting an org (ADR 0027, #134 "Org deletion and crons"): its usage records in D1, then its keys in
 * the `CACHE` KV namespace (the names `org.<org>.…` of an `OrgKv`). Its ControlPlane tables go with `wipeOrg`.
 * The app Worker's org deletion (`platform/org-deletion.ts`) runs it first.
 */
import { Effect } from "effect";
import type { OrgDeletionStep } from "@commissary/core";
import { deleteOrgUsage } from "./usage/d1.ts";
import { type ModelsBindings, ModelsEnv } from "./env.ts";
import { orgKvOf } from "./kv.ts";

/** Keys read and deleted per page: each key is one KV call. */
const KV_PAGE = 100;

export const deleteOrgModels =
  (models: Pick<ModelsBindings, "USAGE" | "CACHE">): OrgDeletionStep =>
  async (org, budget) => {
    let calls = 0;

    // Usage: each batch is one D1 call; the helper bounds its own loop.
    const usage = await deleteOrgUsage(models.USAGE, org);
    calls += usage.calls;

    if (!usage.complete) return { complete: false, calls, part: "usage" };

    // KV: keys of the org, a page at a time.
    const kv = orgKvOf(models, org);

    for (;;) {
      if (budget - calls < KV_PAGE + 2) return { complete: false, calls, part: "cache" };
      const page = await kv.deletePage(KV_PAGE);
      calls += 1 + page.deleted;

      if (page.complete) return { complete: true, calls };
    }
  };

/** Models' step over the invocation's bindings. */
export const orgDeletionStep: Effect.Effect<OrgDeletionStep, never, ModelsEnv> = Effect.gen(
  function* () {
    return deleteOrgModels(yield* ModelsEnv);
  },
);
