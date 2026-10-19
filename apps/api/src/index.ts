import { retryOnCodeUpdate } from "@commissary/state";
import { makeWebHandler } from "./http/app.ts";
import { misdirected } from "./http/hosts.ts";
import { dispatchScheduled } from "./scheduled.ts";
import { requestContext } from "./worker-env.ts";

// The handler (and its router) is built once per isolate; `env`/`ctx` are provided per request.
const { handler } = makeWebHandler();

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
