// The API Worker's entry under `alchemy dev` only, never deployed (alchemy.run.ts picks it on its dev flag). Locally a
// cross-script Durable Object is reached through the dev registry by its hex id, which drops `ctx.id.name`, the name a
// ControlPlane learns its org from ([cloudflare/workerd#7286](https://github.com/cloudflare/workerd/issues/7286),
// docs/DEVELOPMENT.md "Infrastructure"). So under `alchemy dev` this entry reaches the state Worker's objects through its
// dev-only `DevStateBridge` entrypoint (`DEV_STATE_BRIDGE`, apps/state/src/dev.ts): the state namespaces are replaced
// with bridged ones, whose stubs send their calls, with the object's name, over that service binding
// (`@commissary/state/dev-state-bridge`). Deployed, the API Worker binds the state Worker's objects by script name and
// runs src/index.ts.
import { type DevBridgedEnv, devBridgedEnv } from "@commissary/state/dev-state-bridge";
import { api } from "./index.ts";

export default {
  fetch: (request, env, ctx) => api.fetch(request, devBridgedEnv(env), ctx),
  scheduled: (controller, env, ctx) => api.scheduled(controller, devBridgedEnv(env), ctx),
} satisfies ExportedHandler<DevBridgedEnv<Env>>;
