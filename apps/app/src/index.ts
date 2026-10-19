import { makeWebHandler } from "./http/app.ts";
import { requestContext } from "./worker-env.ts";
import { retryOnCodeUpdate } from "@commissary/state";

// The handler (and its router) is built once per isolate; `env`/`ctx` are provided per request.
const { handler } = makeWebHandler();

// The app Worker (ADR 0030): the panel, its sign-in and the management API; the client API and the cron jobs are the
// API Worker's (apps/api). The Durable Objects live in the state Worker (apps/state), bound by script name
// (alchemy.run.ts). A deploy of the state Worker resets them, and the calls cut off then are retried once
// (`retryOnCodeUpdate`).
export default {
  fetch: (request, env, ctx) =>
    handler(request, requestContext(retryOnCodeUpdate(env), ctx, request.url)),
} satisfies ExportedHandler<Env>;
