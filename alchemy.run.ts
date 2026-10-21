/**
 * Infrastructure of the Workers port, deployed with Alchemy (`pnpm deploy`, `pnpm dev`, `pnpm destroy`): the Workers of
 * ADR 0030, the state Worker, which defines the Durable Objects, the app Worker (panel, management API) with its static
 * assets, and the API Worker (the client API) with its cron trigger, which both bind the objects by script name (but
 * one: the API Worker defines the agent runs' `AgentRun`, which the app Worker binds by its script name); the KV
 * namespace, the D1 usage database (migrations applied on every deploy), the `auth_index` HMAC key and the Cloudflare
 * Access application, policies and service tokens in front of the app (and of the client API on a stage with one host,
 * except that clients send API keys there). Commissary Cloud (`COMMISSARY_MODE=cloud`, ADR 0026) creates no Access
 * resources: people sign in on the auth host, served by a fourth Worker, the auth Worker (apps/auth), with Better Auth's
 * `SignIn` D1 database, its sign-in settings and secret; the app Worker asks it over a service binding, and the API
 * Worker gets the per-org rate limit.
 * Deploy-time settings are read from the environment / `.env` (see `.env.example` and infra/settings.ts).
 */
import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import * as Output from "alchemy/Output";
import { type AccessWiring, provisionAccess, provisionClientApiBypass } from "./infra/access.ts";
import { zoneRoutedPrefixes } from "./infra/access-config.ts";
import { BUNDLE_ALIASES } from "./infra/bundle.ts";
import { previewAppName, previewOrigin } from "./infra/preview-origin.ts";
import { readSettings } from "./infra/settings.ts";
import { RATE_LIMIT_PERIOD_SECONDS, REQUEST_RATE_CEILING } from "@commissary/billing/plan";
import { COMPUTER_IMAGE, COMPUTER_MARKER } from "@commissary/core/computer";
import { DEV_AUTH_INDEX_KEY } from "@commissary/models/auth-index-key";
import { DEV_SECRETS_KEY, secretsKeyResourceId } from "./packages/state/src/secrets/key.ts";

/**
 * Runtime compatibility of the Workers; keep in sync with apps/app/vitest.config.ts, apps/api/vitest.config.ts,
 * apps/auth/vitest.config.ts, packages/state/vitest.config.ts, packages/models/vitest.config.ts,
 * packages/billing/vitest.config.ts, packages/tools/vitest.config.ts, packages/agents/vitest.config.ts and
 * tools/workers/worker-configuration.d.ts. `global_fetch_strictly_public` sends a fetch to a hostname in the
 * deployment's own zone through the internet, not straight to its origin (ADR 0044, docs/ARCHITECTURE.md "Outbound
 * guard").
 */
export const COMPATIBILITY = {
  date: "2026-08-01",
  flags: ["nodejs_compat", "global_fetch_strictly_public"],
};

/** Model catalog refresh, credential refresh sweep and usage retention (apps/api/src/scheduled.ts). */
export const CRONS = ["0 */3 * * *"];

/**
 * Ports under `alchemy dev`: the app Worker's (where the panel's dev server sends `/v9`, apps/web/vite.config.ts), the
 * state Worker's, the API Worker's and, on Commissary Cloud, the auth Worker's (where the dev server sends `/api`).
 */
const DEV_PORTS = { app: 1337, state: 1338, api: 1339, auth: 1340 } as const;

/** Better Auth's signing secret under `alchemy dev` (loopback only), fixed like the dev keys below. */
const DEV_BETTER_AUTH_SECRET = "commissary-dev-better-auth-secret-never-deployed-0123456789";

// Remote state in the account (`Cloudflare.state()`, shared by every machine and CI) unless ALCHEMY_STATE=local,
// which keeps it under .alchemy/ (handy for `alchemy dev` without a Cloudflare login).
const state = process.env["ALCHEMY_STATE"] === "local" ? Alchemy.localState() : Cloudflare.state();

export default Alchemy.Stack(
  "commissary",
  { providers: Cloudflare.providers(), state },
  Effect.gen(function* () {
    const dev = yield* Alchemy.ALCHEMY_DEV;
    const stage = yield* Alchemy.Stage;
    const settings = yield* readSettings(dev, stage);

    const cache = yield* Cloudflare.KV.Namespace("Cache");
    // Each database applies the migrations of its own folder (migrations/usage/, migrations/sign-in/).
    const usage = yield* Cloudflare.D1.Database("Usage", { migrations: "./migrations/usage" });

    // Key of the keyed `auth_index` (packages/models/src/management/auth-index.ts): 32 random bytes minted on the first
    // deploy of a stage and kept in the (encrypted) stack state, so every later deploy binds the same secret with no
    // manual step. `alchemy dev` (loopback only, no Access) uses a fixed key so local panel links survive a wiped local state.
    const authIndexKey = dev
      ? DEV_AUTH_INDEX_KEY
      : yield* Alchemy.makeRandom("AuthIndexKey", { bytes: 32 });

    // Secrets key (packages/state/src/secrets/): wraps every org's data key, which seals the stored auth files and
    // config entries. Minted like the auth index key, one `Random` per generation: raising SECRETS_KEY_GENERATION mints
    // a new one, and during the rotation the previous generation is bound as SECRETS_KEY_PREVIOUS (docs/DEPLOY.md).
    // Every generation up to the current one stays declared: Alchemy deletes an undeclared resource with its state, and
    // a `Random` exists only there, so an old key must never drop out of the stack. Losing a key loses every secret it
    // still protects.
    const secretsKeys = new Map<number, Effect.Success<ReturnType<typeof Alchemy.makeRandom>>>();

    if (!dev) {
      for (let generation = 1; generation <= settings.secretsKeyGeneration; generation += 1)
        secretsKeys.set(
          generation,
          yield* Alchemy.makeRandom(secretsKeyResourceId(generation), { bytes: 32 }),
        );
    }

    const secretsKey = dev ? DEV_SECRETS_KEY : secretsKeys.get(settings.secretsKeyGeneration);

    const previousSecretsKey =
      settings.secretsKeyPreviousGeneration === undefined
        ? undefined
        : secretsKeys.get(settings.secretsKeyPreviousGeneration);

    // `alchemy dev` serves the Workers on localhost without Access: the dev bypass (packages/auth/src/access/config.ts)
    // makes every loopback request an admin. Deployed Workers never get it and require the Access JWT (or an API key on
    // the client API).
    const { hosted } = settings;

    // The deployment's own hosts, which the outbound guard refuses (ADR 0044, `@commissary/core`'s `outboundPolicy`):
    // the base, app, API and auth hosts. A preview's and `alchemy dev`'s Workers serve workers.dev URLs or loopback, which
    // the guard learns from the request instead.
    const ownHosts =
      dev || settings.preview
        ? ""
        : [settings.baseDomain, settings.appDomain, settings.apiDomain, hosted?.authDomain ?? ""]
            .filter((host) => host !== "")
            .join(",");

    const access: AccessWiring =
      dev || hosted !== undefined
        ? { aud: "", adminServiceTokens: "", serviceTokenClientIds: {} }
        : yield* provisionAccess(settings);

    // Commissary Cloud (ADR 0026, ADR 0030), on the auth Worker: Better Auth's signing secret, minted like the keys
    // above, and its sign-in settings.
    const signInEnv =
      hosted === undefined
        ? {}
        : {
            BETTER_AUTH_SECRET: dev
              ? DEV_BETTER_AUTH_SECRET
              : yield* Alchemy.makeRandom("BetterAuthSecret", { bytes: 32 }),
            ...(hosted.githubClientId === ""
              ? {}
              : {
                  SIGN_IN_GITHUB_CLIENT_ID: hosted.githubClientId,
                  SIGN_IN_GITHUB_CLIENT_SECRET: hosted.githubClientSecret,
                }),
            ...(hosted.googleClientId === ""
              ? {}
              : {
                  SIGN_IN_GOOGLE_CLIENT_ID: hosted.googleClientId,
                  SIGN_IN_GOOGLE_CLIENT_SECRET: hosted.googleClientSecret,
                }),
            TURNSTILE_SITE_KEY: hosted.turnstileSiteKey,
            TURNSTILE_SECRET_KEY: hosted.turnstileSecretKey,
          };

    // Commissary Cloud's Pay as you go through Polar (ADR 0042, #237), on the app Worker (checkout, portal, plan
    // switches, webhooks, org deletion) and the API Worker (the cron task that sends usage): bound only when the stage
    // has all of Polar's settings (infra/settings.ts); without them nothing is billed and the billing routes answer
    // 404. The tokens are secrets (`Redacted`: bound as secret text). Production Polar on the `cloud` stage only, its
    // sandbox elsewhere. Only the app Worker takes webhooks, so only it gets the webhook secret (`polarWebhookEnv`).
    const polarEnv =
      hosted?.polar === undefined
        ? {}
        : {
            POLAR_ACCESS_TOKEN: hosted.polar.accessToken,
            POLAR_PRODUCT_ID: hosted.polar.productId,
            POLAR_SERVER: hosted.polar.server,
          };

    const polarWebhookEnv =
      hosted?.polar === undefined ? {} : { POLAR_WEBHOOK_SECRET: hosted.polar.webhookSecret };

    // Commissary Cloud on the API Worker: API keys only, under the per-org request-rate ceiling of the client API, one
    // binding per plan (60 a minute on Free, 600 on Pay as you go: the constants of `@commissary/billing`, ADR 0042),
    // each in a namespace of its own.
    const hostedApiEnv =
      hosted === undefined
        ? {}
        : {
            COMMISSARY_MODE: "cloud",
            FREE_RATE_LIMIT: Cloudflare.RateLimit("FREE_RATE_LIMIT", {
              namespaceId: hosted.orgRateLimitNamespaceId,
              simple: { limit: REQUEST_RATE_CEILING.free, period: RATE_LIMIT_PERIOD_SECONDS },
            }),
            PAYG_RATE_LIMIT: Cloudflare.RateLimit("PAYG_RATE_LIMIT", {
              namespaceId: hosted.paygRateLimitNamespaceId,
              simple: { limit: REQUEST_RATE_CEILING.payg, period: RATE_LIMIT_PERIOD_SECONDS },
            }),
            ...polarEnv,
          };

    // Where the client API is served (ADR 0028, ADR 0030; apps/app/src/http/hosts.ts, apps/api/src/http/hosts.ts): with
    // an API host the API Worker answers there and the app Worker on the app host; without one, zone routes on the app
    // host send the client API paths to the API Worker (a preview's API Worker answers on its own workers.dev URL). The
    // API host has no Access application: clients authenticate there with API keys.
    const split = settings.apiDomain !== "";

    // Commissary Cloud's OAuth server for MCP clients (#200, packages/tools/src/oauth/), on the app and the API Worker:
    // the KV namespace `@cloudflare/workers-oauth-provider` keeps clients, grants, tokens and consents in, the issuer
    // (the app host) and the resource (`/mcp` where the API Worker answers it: the API host, else the app host's zone
    // route). Not on a preview, whose hosts are workers.dev URLs, nor on a self-hosted stage (Access signs its MCP
    // clients in, ADR 0045).
    const mcpOAuthEnv =
      hosted === undefined || settings.preview
        ? {}
        : {
            OAUTH_KV: yield* Cloudflare.KV.Namespace("OAuth"),
            MCP_OAUTH_ISSUER: dev
              ? `http://localhost:${DEV_PORTS.app}`
              : `https://${settings.appDomain}`,
            MCP_OAUTH_RESOURCE: dev
              ? `http://localhost:${DEV_PORTS.api}/mcp`
              : `https://${split ? settings.apiDomain : settings.appDomain}/mcp`,
          };

    // What the state Worker's classes read besides their namespaces and the mode (`StateObjectEnv`, `ModelsPartEnv`).
    // The app and the API Worker's own code read all of it too, except the secrets keys.
    const stateSettings = {
      // Platform admins seeded as owners of `global`; the Access settings mark a deployed stage, where the dev secrets
      // key is refused (@commissary/state's secrets/).
      ACCESS_TEAM_DOMAIN: dev || hosted !== undefined ? "" : settings.teamDomain,
      ACCESS_AUD: access.aud,
      PLATFORM_ADMIN_EMAILS: settings.adminEmails.join(","),
      PLATFORM_ADMIN_SERVICE_TOKENS: access.adminServiceTokens,
      META_MINT_URL: settings.metaMintUrl,
      // The hosts the outbound guard refuses, on every Worker that fetches a user-supplied URL (app, API, state).
      OWN_HOSTS: ownHosts,
      // Redacted: bound as a secret (`secret_text`), never as a plain variable.
      AUTH_INDEX_KEY: authIndexKey,
    };

    // The secrets keys (redacted, like `AUTH_INDEX_KEY`): only the ControlPlane reads them, so only the Worker that
    // runs it binds them.
    const secretsKeyBindings = {
      ...(secretsKey === undefined ? {} : { SECRETS_KEY: secretsKey }),
      ...(previousSecretsKey === undefined ? {} : { SECRETS_KEY_PREVIOUS: previousSecretsKey }),
    };

    // Browser Run (ADR 0039, ADR 0043, #212), unless `COMMISSARY_BROWSER=off`: the state Worker's ControlPlane runs the
    // browser toolkit on it (the Tools part's built-in toolkit), and the app Worker reads its presence for `/me`'s
    // `deployment.browser`. A deploy without it has no browser toolkit and nothing else changes. Never under `alchemy
    // dev`: `quickAction()` has no local emulation (Browser Run's docs), and its remote mode needs a Cloudflare login.
    const browserEnv = settings.browser && !dev ? { BROWSER: Cloudflare.Browser("BROWSER") } : {};

    // The sandbox's computer (ADR 0041, ADR 0043, #223), when `COMMISSARY_COMPUTER=on`: one image (infra/computer/,
    // computerd and mise), attached to the `SandboxSession` class as a Durable Object-managed Container, which each
    // session object starts itself (`ctx.container`, keyed by the Container's id) with its instance size. A container
    // attached to a class has no binding in any Worker's `env`, so the State and app Workers get the `COMPUTER` marker
    // beside it (`@commissary/core`'s `COMPUTER_MARKER`), the one exception to "presence is the binding". Never under
    // `alchemy dev`, which would build and run the image with Docker.
    const computer =
      settings.computer && !dev
        ? Cloudflare.Container(COMPUTER_IMAGE, {
            schedulingPolicy: "durable_object",
            context: "./infra/computer",
          })
        : undefined;

    const computerMarker = computer === undefined ? {} : COMPUTER_MARKER;

    // Browser Run's crawls (#270), on its REST API only: the account and API token ("Browser Run - Edit", a secret) the
    // browser toolkit's crawl tools call it with, on the state Worker, whose ControlPlane runs the toolkit. Optional, and
    // only with the binding (infra/settings.ts): without them the toolkit has no crawl tools and nothing else changes.
    // `COMMISSARY_CRAWL_MAX_PAGES` caps the pages of one crawl, whose browser time lands on the deployment's account.
    const browserCrawlEnv =
      settings.browserCrawls === undefined
        ? {}
        : {
            BROWSER_RUN_ACCOUNT_ID: settings.browserCrawls.accountId,
            BROWSER_RUN_API_TOKEN: settings.browserCrawls.apiToken,
            COMMISSARY_CRAWL_MAX_PAGES: String(settings.browserCrawls.maxPages),
          };

    // The state Worker (apps/state, ADR 0030): defines ControlPlane, SessionState, Platform, BrowserSession and the
    // sandbox toolkit's SandboxSession (#222, with the computer's container when there is one, #223), and binds only
    // what their classes read (apps/state/src/env.d.ts). No
    // routes, no domain, no workers.dev URL: the other Workers reach it through their Durable Object bindings. A deploy
    // restarts the Durable Objects a Worker defines, and Alchemy uploads a Worker again only when its bundle changes, so
    // they restart only when their own code does.
    //
    // The namespaces used to live in the app Worker (`Commissary`). `transferredFrom` moves each one with every stored
    // object on the first deploy of a stage that still has it there (prod, cloud, a self-hosted stage upgrading); on a
    // fresh stage, or once moved, it does nothing, so it stays (docs/DEPLOY.md, "The state Worker").
    //
    // Dev-only guard: under `alchemy dev` the local dev registry reaches another Worker's Durable Object by its hex id
    // and drops `ctx.id.name`, which tells a ControlPlane its org (cloudflare/workerd#7286). There, and only there
    // (`dev`), the state Worker runs its dev entry (apps/state/src/dev.ts), which adds the dev-only `DevStateBridge`
    // entrypoint, and the other Workers run theirs (`src/dev.ts`), which reach the objects over a service binding to it
    // ({@link stateBindings}). A deploy always uses the `index.ts` entries and the script-name bindings.
    const stateWorker = yield* Cloudflare.Worker("State", {
      main: dev ? "./apps/state/src/dev.ts" : "./apps/state/src/index.ts",
      compatibility: COMPATIBILITY,
      workersDev: false,
      dev: { port: DEV_PORTS.state },
      limits: { cpuMs: settings.cpuMs },
      env: {
        CONTROL_PLANE: Cloudflare.DurableObject("ControlPlane", { transferredFrom: "Commissary" }),
        SESSION_STATE: Cloudflare.DurableObject("SessionState", { transferredFrom: "Commissary" }),
        PLATFORM: Cloudflare.DurableObject("Platform", { transferredFrom: "Commissary" }),
        // The browser toolkit's sessions (#213), one object each, reached only by this Worker's ControlPlane. Bound
        // with or without Browser Run: without it the toolkit is absent and no session opens, and the class never comes
        // and goes with `COMMISSARY_BROWSER`.
        BROWSER_SESSIONS: Cloudflare.DurableObject("BrowserSession"),
        // The usage database, which a browser session writes its record of browser time into when it closes (#214,
        // `BrowserSessionEnv`), and a sandbox session its record of computer time (#224, `SandboxSessionEnv`); the
        // ControlPlane above charges that time to the Spend limits.
        USAGE: usage,
        // The sandbox toolkit (ADR 0041, ADR 0043, #222), on every deployment: one object per sandbox session, reached
        // by the ControlPlane only, and Dynamic Workers (Workers Paid), where each session's just-bash runs with no
        // binding beyond its files and the sandbox's egress entrypoint as its only way out.
        // With the computer, its container is attached to the class; the session objects read its instance size.
        SANDBOX_SESSION:
          computer === undefined
            ? Cloudflare.DurableObject("SandboxSession")
            : Cloudflare.DurableObject("SandboxSession", { containers: [computer] }),
        // Also the Agents area's presence (ADR 0043): the ControlPlane has the agents toolkit (#229) where it is bound.
        LOADER: Cloudflare.WorkerLoader("LOADER"),
        ...(hosted === undefined ? {} : { COMMISSARY_MODE: "cloud" }),
        ...stateSettings,
        ...secretsKeyBindings,
        ...browserEnv,
        ...computerMarker,
        ...(computer === undefined ? {} : { COMPUTER_INSTANCE: settings.computerInstance }),
        ...browserCrawlEnv,
      },
    });

    // How the other Workers reach the state: deployed, the state Worker's namespaces bound by its script name (the
    // binding also makes them deploy after it: ADR 0030, the state Worker deploys before its callers, whose state RPC
    // changes are expand-then-contract, docs/DEVELOPMENT.md); under `alchemy dev`, its `DevStateBridge` (the dev-only
    // guard above).
    const stateBindings = dev
      ? { DEV_STATE_BRIDGE: Cloudflare.WorkerEntrypoint(stateWorker, "DevStateBridge") }
      : {
          CONTROL_PLANE: Cloudflare.DurableObject("ControlPlane", {
            scriptName: stateWorker.workerName,
          }),
          SESSION_STATE: Cloudflare.DurableObject("SessionState", {
            scriptName: stateWorker.workerName,
          }),
          PLATFORM: Cloudflare.DurableObject("Platform", { scriptName: stateWorker.workerName }),
        };

    // The Better Auth database of Commissary Cloud (ADR 0030, #130): people, sessions and linked accounts, bound by the
    // auth Worker only. A self-hosted Commissary has none.
    const signIn =
      hosted === undefined
        ? undefined
        : yield* Cloudflare.D1.Database("SignIn", { migrations: "./migrations/sign-in" });

    // The auth Worker (apps/auth, ADR 0030), Commissary Cloud only: Better Auth on the auth host
    // (`COMMISSARY_AUTH_DOMAIN`, by default `auth.<COMMISSARY_DOMAIN>`; a preview's workers.dev URL; its dev port), and
    // the RPC the app Worker asks over its service binding. It trusts and returns to the app origin only, and scopes the
    // session cookie to the base domain (ADR 0031), so the app host receives it (a preview: the account's workers.dev
    // subdomain; under `alchemy dev` a host-only `localhost` cookie, which spans the ports). The cookie's name, and its
    // domain except on a preview, come from the settings (`HostedSettings` `cookiePrefix`, `cookieDomain`).
    const authWorker = (app: {
      readonly origin: string | Output.Output<string>;
      readonly cookieDomain: string | Output.Output<string>;
    }) =>
      Cloudflare.Worker("Auth", {
        main: dev ? "./apps/auth/src/dev.ts" : "./apps/auth/src/index.ts",
        compatibility: COMPATIBILITY,
        workersDev: settings.preview,
        dev: { port: DEV_PORTS.auth },
        ...(dev || settings.preview || hosted === undefined ? {} : { domain: hosted.authDomain }),
        limits: { cpuMs: settings.cpuMs },
        build: { input: { resolve: { alias: { ...BUNDLE_ALIASES } } } },
        env: {
          ...(signIn === undefined ? {} : { SIGN_IN: signIn }),
          ...stateBindings,
          APP_ORIGIN: app.origin,
          AUTH_COOKIE_DOMAIN: app.cookieDomain,
          AUTH_COOKIE_PREFIX: hosted?.cookiePrefix ?? "",
          ...signInEnv,
        },
      });

    // The app Worker (apps/app): the panel and the management API; on Commissary Cloud the sign-in page, and it asks
    // the auth Worker (`auth`) who a session belongs to. On a Cloud preview it has an explicit name, from which the auth
    // Worker learnt its origin before it existed (infra/preview-origin.ts).
    const appWorker = (
      apiDomain: string | Output.Output<string> | undefined,
      auth: Effect.Success<ReturnType<typeof authWorker>> | undefined,
      api: Effect.Success<ReturnType<typeof apiWorker>>,
    ) =>
      Cloudflare.Worker("Commissary", {
        main: dev ? "./apps/app/src/dev.ts" : "./apps/app/src/index.ts",
        ...(hosted !== undefined && settings.preview ? { name: previewAppName(stage) } : {}),
        compatibility: COMPATIBILITY,
        // Production serves only its Access-protected domain; pull-request previews serve their workers.dev URL,
        // protected by enrolling the Worker into the preview's Access application.
        workersDev: settings.preview,
        dev: { port: DEV_PORTS.app },
        ...(dev || settings.preview ? {} : { domain: settings.appDomain }),
        ...(access.application === undefined ? {} : { access: access.application }),
        limits: { cpuMs: settings.cpuMs },
        build: { input: { resolve: { alias: { ...BUNDLE_ALIASES } } } },
        // The control panel (`pnpm build`, apps/web). The Worker runs first so Access gates the panel
        // (apps/app/src/management/web-panel.ts serves it) and a client API path gets its 404, not an asset.
        assets: { directory: "./apps/web/dist", runWorkerFirst: true },
        env: {
          CACHE: cache,
          USAGE: usage,
          ...stateBindings,
          ...stateSettings,
          ACCESS_DEV_BYPASS: dev && hosted === undefined ? settings.devBypass : "",
          ...browserEnv,
          // Read for `/me`'s `deployment.computer` only.
          ...computerMarker,
          // Dynamic Workers (ADR 0043, Workers Paid, on every deployment): the Agents area exists where they do (#226);
          // only its presence is read here, for the Agents routes and `/me`'s `deployment.agents`.
          LOADER: Cloudflare.WorkerLoader("LOADER"),
          // The agent runs (#227): the API Worker's class (ADR 0030's amendment), bound by its script name, which also
          // makes this Worker deploy after it on every stage.
          AGENT_RUN: Cloudflare.DurableObject("AgentRun", { scriptName: api.workerName }),
          // The schedule triggers (#231): the API Worker's class too, which the Agents routes arm.
          AGENT_SCHEDULE: Cloudflare.DurableObject("AgentSchedule", { scriptName: api.workerName }),
          // Where the panel tells clients to send API keys (`GET /me` `api_url`).
          ...(apiDomain === undefined ? {} : { API_DOMAIN: apiDomain }),
          ...(hosted === undefined || auth === undefined
            ? {}
            : {
                COMMISSARY_MODE: "cloud",
                OWNED_ORG_LIMIT: hosted.ownedOrgLimit,
                ...polarEnv,
                ...polarWebhookEnv,
                ...mcpOAuthEnv,
                AUTH: auth,
                // Where the sign-in page sends its requests and the orgs' identity providers send people back.
                AUTH_ORIGIN: Output.asOutput(auth.url).pipe(
                  Output.map((url) => {
                    if (url === undefined) throw new Error("the auth Worker has no URL");

                    return new URL(url).origin;
                  }),
                ),
              }),
        },
      });

    // The API Worker (apps/api): the client API and the cron jobs. Its own workers.dev URL on a preview, the API host on a
    // stage that has one, else zone routes for the client API paths on the app host (`zoneRoutedPrefixes`: a route
    // pattern matches every path that starts with it, as the Workers match them, so `/v1*` covers `/v1beta`; on a
    // self-hosted stage not `/mcp`, which the app Worker serves behind Access, ADR 0045). Under `alchemy dev` it serves
    // its own port. It deploys before the app Worker (and the auth Worker) on every stage: the app Worker binds its
    // `AgentRun` (#227).
    //
    // The agent runs' objects live here, not in the state Worker (ADR 0030's amendment): a run reaches the client API
    // and the MCP endpoint through this Worker's own run gateway over `ctx.exports` (apps/api/src/http/run-gateway.ts,
    // the trust boundary of a run's principal), where a state Worker's object would need a service binding to this
    // Worker, which binds the state Worker's objects: a cycle no fresh stage could deploy. No Worker binds the gateway.
    const apiWorker = () =>
      Cloudflare.Worker("Api", {
        main: dev ? "./apps/api/src/dev.ts" : "./apps/api/src/index.ts",
        compatibility: COMPATIBILITY,
        workersDev: settings.preview,
        dev: { port: DEV_PORTS.api },
        ...(split ? { domain: settings.apiDomain } : {}),
        ...(dev || settings.preview || split
          ? {}
          : {
              routes: zoneRoutedPrefixes({ hosted: hosted !== undefined }).map((prefix) => ({
                pattern: `${settings.appDomain}${prefix}*`,
              })),
            }),
        limits: { cpuMs: settings.cpuMs },
        // Previews have no credentials to refresh or catalog worth keeping fresh.
        crons: settings.preview ? [] : CRONS,
        env: {
          CACHE: cache,
          USAGE: usage,
          ...stateBindings,
          ...stateSettings,
          ACCESS_DEV_BYPASS: dev && hosted === undefined ? settings.devBypass : "",
          // The app host on every deployed stage, split or not: the panel's links (MCP connect pages, the billing page)
          // point there. A preview and `alchemy dev` bind none, and the links name their pages in words.
          ...(!dev && !settings.preview ? { APP_DOMAIN: settings.appDomain } : {}),
          ...(split ? { API_DOMAIN: settings.apiDomain } : {}),
          // The agent runs (#227, `@commissary/agents/api`'s `AgentRun`), one object per run, defined here.
          AGENT_RUN: Cloudflare.DurableObject("AgentRun"),
          // The schedule triggers (#231, `@commissary/agents/api`'s `AgentScheduleObject`), one object per schedule,
          // whose alarm starts the runs above: here, as the state Worker's ControlPlane cannot reach them.
          AGENT_SCHEDULE: Cloudflare.DurableObject("AgentSchedule"),
          // Dynamic Workers (ADR 0043): the Agents area's presence; the MCP endpoint serves the agents toolkit (#229)
          // where it is bound, as the app Worker serves the area's routes.
          LOADER: Cloudflare.WorkerLoader("LOADER"),
          ...hostedApiEnv,
          ...mcpOAuthEnv,
        },
      });

    // The order, on every stage: the state Worker first (above); then the API Worker, whose `AgentRun` the app Worker
    // binds; the auth Worker before the app Worker, which binds it. On a preview the app names the API Worker's
    // workers.dev host, and on Commissary Cloud the auth Worker derives the app's origin from its URL.
    const client = yield* apiWorker();

    const { worker, auth } = settings.preview
      ? yield* Effect.gen(function* () {
          // A preview always serves its workers.dev URL (`workersDev` above).
          const previewHost = Output.asOutput(client.url).pipe(
            Output.map((url) => {
              if (url === undefined)
                throw new Error("the preview API Worker has no workers.dev URL");

              return new URL(url).host;
            }),
          );

          const origin = Output.asOutput(client.url).pipe(
            Output.map((url) => previewOrigin(url, previewAppName(stage))),
          );

          const signInWorker =
            hosted === undefined
              ? undefined
              : yield* authWorker({
                  origin: origin.pipe(Output.map((found) => found.appOrigin)),
                  cookieDomain: origin.pipe(Output.map((found) => found.accountDomain)),
                });

          return {
            auth: signInWorker,
            worker: yield* appWorker(previewHost, signInWorker, client),
          };
        })
      : yield* Effect.gen(function* () {
          const signInWorker =
            hosted === undefined
              ? undefined
              : yield* authWorker(
                  dev
                    ? { origin: `http://localhost:${DEV_PORTS.app}`, cookieDomain: "" }
                    : {
                        origin: `https://${settings.appDomain}`,
                        cookieDomain: hosted.cookieDomain,
                      },
                );

          const app = yield* appWorker(
            split ? settings.apiDomain : undefined,
            signInWorker,
            client,
          );

          return { worker: app, auth: signInWorker };
        });

    const api = client;

    // On a stage with one host, the Access application of the app host covers the client API paths the zone routes send
    // to the API Worker; they leave Access (clients send API keys there, ADR 0022). Derived from the API Worker's output,
    // so it is applied only after the API Worker and its routes: the client API must not leave Access while a Worker
    // that only reads the Access edge's `Cf-Access-Jwt-Assertion` still serves it. An API host needs none (Access
    // covers the app host only), nor does a preview, whose API Worker's workers.dev URL is not enrolled in Access.
    // `/mcp` stays behind Access (ADR 0045): when an earlier deploy bypassed it, the zone route that sent it to the API
    // Worker is gone before Access covers it again, and meanwhile the app Worker, which verifies the Access JWT itself,
    // refuses a request without one.
    if (!dev && hosted === undefined && !split && !settings.preview)
      yield* provisionClientApiBypass(
        settings,
        Output.asOutput(api.url).pipe(Output.map(() => settings.appDomain)),
      );

    return {
      url: worker.url,
      // Where clients send API keys (tools/deploy-stage.sh): the API host; the API Worker's own URL on a preview or
      // under `alchemy dev`; else the app host, whose client API paths the zone routes send to the API Worker.
      apiUrl: split
        ? `https://${settings.apiDomain}`
        : dev || settings.preview
          ? api.url
          : worker.url,
      // Commissary Cloud's auth host (tools/deploy-stage.sh, tools/check-cloud-deploy.sh); none on a self-hosted one.
      ...(auth === undefined ? {} : { authUrl: auth.url }),
      accessAud: access.aud,
      serviceTokens: access.serviceTokenClientIds,
    };
  }),
);
