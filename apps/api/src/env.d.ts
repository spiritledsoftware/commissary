// Bindings and variables of the API Worker (ADR 0030). Deployed values come from the `Api` Worker's `env` in
// `alchemy.run.ts`; keep both in sync. Tests bind the same names in `vitest.config.ts`. The Durable Object namespaces
// are the state Worker's (apps/state), bound by script name, but for the agents' (`AGENT_RUN`, `AGENT_SCHEDULE`),
// defined here; under `alchemy dev` the state Worker's come over its dev-only bridge instead (src/dev.ts). `Env` is read only by the entries (`index.ts`, `dev.ts`, `scheduled.ts`) and
// tests; other code reads its package's view (`AuthConfig`, `StateEnv`, `ModelsEnv`, `BillingEnv`, `ApiBindings`:
// `worker-env.ts`), which `Env` must satisfy.
interface __ApiWorkerEnv {
  /** Model catalogs, signature cache, Antigravity state (Workers KV). */
  CACHE: KVNamespace;
  /** Usage records (D1); schema in migrations/. */
  USAGE: D1Database;
  /** Access team name or domain (`myteam`, `myteam.cloudflareaccess.com`); empty fails closed. */
  ACCESS_TEAM_DOMAIN: string;
  /** Comma separated Access application AUD tags; empty fails closed. */
  ACCESS_AUD: string;
  /** Comma separated platform admin emails: manage every org and the Platform registry (ADR 0022). */
  PLATFORM_ADMIN_EMAILS: string;
  /** Comma separated platform admin service token Client IDs. */
  PLATFORM_ADMIN_SERVICE_TOKENS: string;
  /** Local development only: treats loopback requests as this admin. Never set when deployed. */
  ACCESS_DEV_BYPASS: string;
  /**
   * The app host (`COMMISSARY_APP_DOMAIN`), bound on every deployed stage (not on a preview or under `alchemy dev`):
   * named when another path is asked for (src/http/hosts.ts), and where the panel's links point.
   */
  APP_DOMAIN?: string;
  /** The API host (`COMMISSARY_API_DOMAIN`). Unset: zone routes or a workers.dev URL (src/http/hosts.ts). */
  API_DOMAIN?: string;
  /** Overrides the Meta key-mint endpoint (empty: default). */
  META_MINT_URL: string;
  /**
   * The deployment's own hosts (base, app, API and auth host, comma separated), which the outbound guard refuses
   * (ADR 0044, src/worker-env.ts `outboundPolicyOf`). Empty on a preview and under `alchemy dev`.
   */
  OWN_HOSTS: string;
  /**
   * Secret HMAC key of `auth_index` (packages/models/src/management/auth-index.ts). Deployed: an Alchemy `Random`
   * (alchemy.run.ts); tests and `alchemy dev` use their own. Empty fails closed.
   */
  AUTH_INDEX_KEY: string;
  /** `cloud`: Commissary Cloud (ADR 0026): API keys only, under the per-org, per-plan rate ceiling; unset: self-hosted. */
  COMMISSARY_MODE?: string;
  /**
   * Commissary Cloud's OAuth server for MCP clients (#200, `@commissary/tools`' `oauth/`): its KV namespace, where the
   * access tokens MCP clients send to `/mcp` are looked up; bound on the `cloud` stage only (and under `alchemy dev`).
   */
  OAUTH_KV?: KVNamespace;
  /** The OAuth server's issuer, `https://<app host>`; with `OAUTH_KV` only. */
  MCP_OAUTH_ISSUER?: string;
  /** The MCP endpoint as its resource, `https://<API host>/mcp` (the app host's on a stage with one host). */
  MCP_OAUTH_RESOURCE?: string;
  /**
   * Hosted: the Free plan's per-org request-rate ceiling of the client API, 60 a minute (Workers rate limiting, keyed
   * by org id).
   */
  FREE_RATE_LIMIT?: RateLimit;
  /** Hosted: Pay as you go's, 600 a minute. */
  PAYG_RATE_LIMIT?: RateLimit;
  /**
   * Hosted: Pay as you go through Polar (#237, `@commissary/billing`'s `polar.ts`): an organization access token
   * (secret), the Pay-as-you-go product and which Polar (`production` on the `cloud` stage, `sandbox` elsewhere),
   * for the cron task that sends usage. No webhook secret: only the app Worker takes webhooks. Unset (a self-hosted
   * Commissary, a stage without them): nothing is billed.
   */
  POLAR_ACCESS_TOKEN?: string;
  POLAR_PRODUCT_ID?: string;
  POLAR_SERVER?: string;
  CONTROL_PLANE: DurableObjectNamespace<import("@commissary/state-worker").ControlPlane>;
  SESSION_STATE: DurableObjectNamespace<import("@commissary/state-worker").SessionState>;
  /** The Platform registry: one object per deployment (`platformOf`, `@commissary/state`). */
  PLATFORM: DurableObjectNamespace<import("@commissary/state-worker").Platform>;
  /**
   * The agent runs (#227): this Worker's own class (`AgentRun`, src/http/run-gateway.ts; ADR 0030's amendment), one
   * object per run, which the app Worker binds by this Worker's script name.
   */
  AGENT_RUN: DurableObjectNamespace<import("@commissary/agents/api").AgentRunObject>;
  /**
   * The schedule triggers (#231): this Worker's own class (`AgentSchedule`, `@commissary/agents/api`'s
   * `AgentScheduleObject`), one object per schedule, which the app Worker binds by this Worker's script name to arm.
   */
  AGENT_SCHEDULE: DurableObjectNamespace<import("@commissary/agents/api").AgentScheduleObject>;
  /**
   * Dynamic Workers (ADR 0043, every deployment): the Agents area's presence, read only as such here: the MCP endpoint
   * serves the agents toolkit (#229) where it is bound.
   */
  LOADER?: WorkerLoader;
  // Not here on purpose: `DEV_STATE_BRIDGE`, bound under `alchemy dev` only (alchemy.run.ts) and typed by the dev entry
  // alone (`DevBridgedEnv`, src/dev.ts), so no deployed code can name it; the tests bind the objects instead.
}

declare namespace Cloudflare {
  interface GlobalProps {
    mainModule: typeof import("./index");
  }

  interface Env extends __ApiWorkerEnv {}
}

interface Env extends __ApiWorkerEnv {}

// @commissary/translation's tokenizer ranks: `Data` modules (alchemy.run.ts and vitest.config.ts `modulesRules`).
declare module "*.bin" {
  const data: ArrayBuffer;
  export default data;
}
