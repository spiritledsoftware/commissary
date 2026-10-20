/**
 * Tools' cron tasks (#134 "Org deletion and crons"), run by the API Worker's cron runner (`apps/api/src/scheduled.ts`):
 * for every org, each toolkit's tool list is built again from its MCP server (ADR 0036), so a tool that disappears
 * upstream drops out of the list and a new one appears (the build runs in the org's ControlPlane, with the runner's
 * outbound guard policy, ADR 0044); once for the deployment, the toolkit catalog's registry is refreshed from
 * integrations.sh (#207, `catalog/refresh.ts`).
 */
import { Effect } from "effect";
import type { HttpClient } from "effect/http";
import { CurrentOutboundPolicy, type ScheduledTask } from "@commissary/core";
import { refreshToolkitCatalog } from "./catalog/refresh.ts";
import { currentToolsControlPlane, type ToolsEnv } from "./env.ts";

/** What Tools' tasks read besides the org: the bindings, and the global `fetch` behind the outbound guard. */
export type ScheduledTaskServices = ToolsEnv | HttpClient.HttpClient;

export const scheduledTasks: ReadonlyArray<ScheduledTask<ScheduledTaskServices>> = [
  {
    name: "tool-list-refresh",
    scope: "org",
    run: Effect.gen(function* () {
      const plane = yield* currentToolsControlPlane;
      const policy = yield* CurrentOutboundPolicy;

      return yield* Effect.promise(() => plane.tools().refreshToolLists(policy));
    }),
  },
  { name: "toolkit-catalog-refresh", scope: "deployment", run: refreshToolkitCatalog("cron") },
];
