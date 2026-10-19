/**
 * Infrastructure of the Workers port, deployed with Alchemy (`pnpm deploy`, `pnpm dev`, `pnpm destroy`): the Workers of
 * ADR 0030, the state Worker, which defines the Durable Objects, the app Worker (panel, management API) with its static
 * assets, and the API Worker (the client API) with its cron trigger, which both bind the objects by script name; the KV
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
import { BUNDLE_ALIASES } from "./infra/bundle.ts";
import { previewAppName, previewOrigin } from "./infra/preview-origin.ts";
import { readSettings } from "./infra/settings.ts";
import { RATE_LIMIT_PERIOD_SECONDS, REQUEST_RATE_CEILING } from "@commissary/billing/plan";
import { DEV_AUTH_INDEX_KEY } from "@commissary/models/auth-index-key";
import { DEV_SECRETS_KEY, secretsKeyResourceId } from "./packages/state/src/secrets/key.ts";
import { CLIENT_API_PREFIXES } from "./packages/core/src/http/client-api.ts";

/**
 * Runtime compatibility of the Workers; keep in sync with apps/app/vitest.config.ts, apps/api/vitest.config.ts,
 * packages/state/vitest.config.ts, packages/models/vitest.config.ts, packages/billing/vitest.config.ts and
 * tools/workers/worker-configuration.d.ts.
 */
export const COMPATIBILITY = { date: "2026-08-01", flags: ["nodejs_compat"] };

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
          };

    // Where the client API is served (ADR 0028, ADR 0030; apps/app/src/http/hosts.ts, apps/api/src/http/hosts.ts): with
    // an API host the API Worker answers there and the app Worker on the app host; without one, zone routes on the app
    // host send the client API paths to the API Worker (a preview's API Worker answers on its own workers.dev URL). The
    // API host has no Access application: clients authenticate there with API keys.
    const split = settings.apiDomain !== "";

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
      // Redacted: bound as a secret (`secret_text`), never as a plain variable.
      AUTH_INDEX_KEY: authIndexKey,
    };

    // The secrets keys (redacted, like `AUTH_INDEX_KEY`): only the ControlPlane reads them, so only the Worker that
    // runs it binds them.
    const secretsKeyBindings = {
      ...(secretsKey === undefined ? {} : { SECRETS_KEY: secretsKey }),
      ...(previousSecretsKey === undefined ? {} : { SECRETS_KEY_PREVIOUS: previousSecretsKey }),
    };

    // The state Worker (apps/state, ADR 0030): defines ControlPlane, SessionState and Platform, and binds only what
    // their classes read (apps/state/src/env.d.ts). No routes, no domain, no workers.dev URL: the other Workers reach
    // it through their Durable Object bindings. A deploy restarts the Durable Objects a Worker defines, and Alchemy
    // uploads a Worker again only when its bundle changes, so they restart only when their own code does.
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
        ...(hosted === undefined ? {} : { COMMISSARY_MODE: "cloud" }),
        ...stateSettings,
        ...secretsKeyBindings,
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
          // Where the panel tells clients to send API keys (`GET /me` `api_url`).
          ...(apiDomain === undefined ? {} : { API_DOMAIN: apiDomain }),
          ...(hosted === undefined || auth === undefined
            ? {}
            : {
                COMMISSARY_MODE: "cloud",
                OWNED_ORG_LIMIT: hosted.ownedOrgLimit,
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
    // stage that has one, else zone routes for the client API paths on the app host (`CLIENT_API_PREFIXES`: a route
    // pattern matches every path that starts with it, as the Workers match them, so `/v1*` covers `/v1beta`). Under
    // `alchemy dev` it serves its own port. `app` is the app Worker, deployed first except on a preview.
    const apiWorker = (app: Effect.Success<ReturnType<typeof appWorker>> | undefined) =>
      Cloudflare.Worker("Api", {
        main: dev ? "./apps/api/src/dev.ts" : "./apps/api/src/index.ts",
        compatibility: COMPATIBILITY,
        workersDev: settings.preview,
        dev: { port: DEV_PORTS.api },
        ...(split ? { domain: settings.apiDomain } : {}),
        ...(dev || settings.preview || split
          ? {}
          : {
              routes: CLIENT_API_PREFIXES.map((prefix) => ({
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
          // Derived from the app Worker's output, so the API host is attached only once the app Worker no longer has it
          // (it was the app's alias before the API Worker existed; Alchemy refuses a hostname another Worker holds).
          ...(split && app !== undefined
            ? {
                APP_DOMAIN: Output.asOutput(app.url).pipe(Output.map(() => settings.appDomain)),
                API_DOMAIN: settings.apiDomain,
              }
            : {}),
          ...hostedApiEnv,
        },
      });

    // The order: the state Worker first (above); the auth Worker before the app Worker, which binds it; the app Worker
    // before the API Worker, which takes the API host from it. On a preview the API Worker comes first: the app names
    // its workers.dev host, and on Commissary Cloud the auth Worker derives the app's origin from its URL.
    const { worker, api, auth } = settings.preview
      ? yield* Effect.gen(function* () {
          const client = yield* apiWorker(undefined);

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
            api: client,
            auth: signInWorker,
            worker: yield* appWorker(previewHost, signInWorker),
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

          const app = yield* appWorker(split ? settings.apiDomain : undefined, signInWorker);

          return { worker: app, auth: signInWorker, api: yield* apiWorker(app) };
        });

    // On a stage with one host, the Access application of the app host covers the client API paths the zone routes send
    // to the API Worker; they leave Access (clients send API keys there, ADR 0022). Derived from the API Worker's output,
    // so it is applied only after the API Worker and its routes: the client API must not leave Access while a Worker
    // that only reads the Access edge's `Cf-Access-Jwt-Assertion` still serves it. An API host needs none (Access
    // covers the app host only), nor does a preview, whose API Worker's workers.dev URL is not enrolled in Access.
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
