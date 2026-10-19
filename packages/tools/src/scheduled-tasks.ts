/**
 * Tools' cron task (#134 "Org deletion and crons"), run by the API Worker's cron runner (`apps/api/src/scheduled.ts`)
 * for every org: each toolkit's tool list is built again from its MCP server (ADR 0036), so a tool that disappears
 * upstream drops out of the list and a new one appears. The build runs in the org's ControlPlane, with the runner's
 * outbound guard policy (ADR 0044).
 */
import { Effect } from "effect";
import { CurrentOutboundPolicy, type ScheduledTask } from "@commissary/core";
import { currentToolsControlPlane, type ToolsEnv } from "./env.ts";

/** What Tools' task reads besides the org: the bindings. */
export type ScheduledTaskServices = ToolsEnv;

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
];
