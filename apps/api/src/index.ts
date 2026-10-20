import { retryOnCodeUpdate } from "@commissary/state";
import { handler } from "./http/handler.ts";
import { misdirected } from "./http/hosts.ts";
import { dispatchScheduled } from "./scheduled.ts";
import { requestContext } from "./worker-env.ts";

// Hosted agents' runs (#227): their Durable Object, which lives here (ADR 0030's amendment) and which the app Worker
// binds by this Worker's script name, and the run gateway, the entrypoint through which a run reaches the client API
// and the MCP endpoint as itself, over `ctx.exports` only (`http/run-gateway.ts`).
export { AgentRun, AgentRunGateway } from "./http/run-gateway.ts";

// Hosted agents' schedule triggers (#231): one object per schedule, whose alarm is its next tick and starts that tick's
// run (`@commissary/agents/api`'s `AgentScheduleObject`); here beside the runs' objects, which the app Worker arms by
// this Worker's script name.
export { AgentScheduleObject as AgentSchedule } from "@commissary/agents/api";

/**
 * The API Worker (ADR 0030): the client API and the cron jobs. Its Durable Objects are the state Worker's (apps/state),
 * bound by script name (alchemy.run.ts); a deploy of the state Worker resets them, and the calls cut off then are
 * retried once (`retryOnCodeUpdate`).
 */
export const api = {
  // Only the client API and `/healthz` are served here (src/http/hosts.ts); the rest is the app Worker's.
  fetch: (request, env, ctx) =>
    misdirected(request.url, env) ??
    handler(request, requestContext(retryOnCodeUpdate(env), ctx, request.url)),
  // Cron jobs (model catalog refresh, ...) are listed in `scheduledTasks` (src/scheduled.ts).
  scheduled: (controller, env, ctx) => dispatchScheduled(controller, retryOnCodeUpdate(env), ctx),
} satisfies Required<Pick<ExportedHandler<Env>, "fetch" | "scheduled">>;

export default api;
