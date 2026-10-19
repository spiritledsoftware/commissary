# Development guide

Developer notes for the TypeScript/Effect Worker. User-facing docs: [`README.md`](../README.md).
Design decisions: [`ARCHITECTURE.md`](ARCHITECTURE.md) (module layout, runtime topology, per-subsystem behaviour and
where it differs from Go).

The Go server ([router-for-me/CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI)) is a reference, not the
authority (ADR 0019). It is not part of this repository: `pnpm install` (the `prepare` script, skipped when `CI` is set) clones it into
`.repos/CLIProxyAPI` as a read-only reference. pnpm skips `prepare` when dependencies are already up to date, so refresh
it with `pnpm repos:sync` (`tools/sync-reference-repos.sh`, a fast-forward of upstream `main`).
Go paths cited in code and docs (`internal/...`, `sdk/...`) are relative to that checkout.

## Requirements

- Node.js 22+ (CI uses the version in `.node-version`) and pnpm (`devEngines.packageManager` in `package.json`).
- Go (only for `tools/fixturegen`) and the reference checkout above.

## Commands

Run from the repository root. `typecheck`, `lint`, `test` and `build` run through Turborepo (`turbo.json`), which
caches each task: run again with no change, a task replays its logs (and `build` its output) instead of running. See
"Workspace and Turborepo" below.

| Script                              | Purpose                                                                                                                                                                                                                                                                     |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm install`                      | Install dependencies and clone/update the Go reference checkout (`.repos/`)                                                                                                                                                                                                 |
| `pnpm repos:sync`                   | Clone or fast-forward the reference repositories in `.repos/` (`tools/sync-reference-repos.sh`)                                                                                                                                                                             |
| `pnpm dev`                          | Builds the panel, then `alchemy dev`: the app (:1337), API (:1339) and state (:1338) Workers, and the auth Worker (:1340) with `COMMISSARY_MODE=cloud`, in workerd with emulated DO/KV/D1, hot reload (`ALCHEMY_STATE=local` avoids a Cloudflare login)                     |
| `pnpm build`                        | Build the control panel (`apps/web`) into `apps/web/dist/` (the Worker's assets, served at `/`)                                                                                                                                                                             |
| `pnpm --filter @commissary/web dev` | Vite dev server for the panel on :5173 with hot reload, forwarding `/v9` to `pnpm dev` (`COMMISSARY_DEV_URL`, default :1337) and `/api` to the auth Worker (`COMMISSARY_AUTH_DEV_URL`, default :1340)                                                                       |
| `pnpm typecheck`                    | `tsc` over every program: each package's `typecheck` (Worker, panel, packages) and the root's deploy code (`typecheck:root`, `tsconfig.infra.json`)                                                                                                                         |
| `pnpm lint`                         | `lint:root`: `oxlint` over the whole repository (type-aware, with type checking, Effect and anti-slop rules) + `oxfmt --check`                                                                                                                                              |
| `pnpm format`                       | `oxfmt`                                                                                                                                                                                                                                                                     |
| `pnpm test`                         | Each package's `vitest run`: the Worker's inside the Workers runtime (`@cloudflare/vitest-plugin`), the panel's and the packages' in Node.js; arguments go to every run (`pnpm test --shard=1/3`)                                                                           |
| `pnpm smoke`                        | Builds the panel, boots `alchemy dev` with local state, waits for the Workers' ready lines, checks a few routes of each and an API key's journey across them, stops it (bundle + startup check); `COMMISSARY_MODE=cloud` runs Commissary Cloud with the auth Worker instead |
| `pnpm plan`                         | `alchemy plan`: preview infrastructure changes (needs a Cloudflare profile)                                                                                                                                                                                                 |
| `pnpm run deploy`                   | `alchemy deploy` (`pnpm deploy` is a pnpm built-in; use `run`)                                                                                                                                                                                                              |
| `pnpm destroy`                      | `alchemy destroy`: delete every resource of a stage                                                                                                                                                                                                                         |
| `pnpm logs`                         | `alchemy logs` (`--tail`)                                                                                                                                                                                                                                                   |
| `pnpm ci:setup`                     | Deploy `stacks/github.ts`: CI's Cloudflare token, check service token and GitHub environments (`docs/DEPLOY.md`)                                                                                                                                                            |
| `pnpm catalog:sync`                 | Regenerate the bundled models.dev snapshot `packages/models/src/registry/catalog/models-dev.json` (`tools/sync-models-dev-catalog.ts [url\|file]`); the catalog additions are edited by hand                                                                                |

## Infrastructure

`alchemy.run.ts` is the composition root of the deployed resources (`stacks/github.ts`, a separate stack, holds CI's
credentials) (Alchemy v2, Effect-based); `infra/settings.ts` reads
the deploy settings (`.env`), `infra/access.ts` provisions Cloudflare Access. There is no Wrangler configuration. It
declares three Workers (ADR 0030): `State` (`apps/state`), which defines the Durable Objects and has no routes,
`Commissary` (`apps/app`), the app Worker, and `Api` (`apps/api`), the API Worker, which both bind them by the state
Worker's script name, and on Commissary Cloud a fourth, `Auth` (`apps/auth`), the auth Worker, which binds them too,
with the `SignIn` database. When you add a binding or variable, change three places together for each Worker that reads
it: its `env` in `alchemy.run.ts`, its `Env` interface (`apps/app/src/env.d.ts`, `apps/api/src/env.d.ts`,
`apps/auth/src/env.d.ts`), and its test bindings (`apps/app/vitest.config.ts`, `apps/api/vitest.config.ts`,
`apps/auth/vitest.config.ts`, which mirror the deployed Workers: compatibility
settings, Durable Objects, `*.bin` Data modules). One that `@commissary/state`'s Durable Object classes read also goes into
`StateObjectEnv` (`packages/state/src/env.ts`), the state Worker's `env` in `alchemy.run.ts` and
`apps/state/src/env.d.ts`, and the state test Worker's bindings (`packages/state/vitest.config.ts`;
its `test/env.d.ts` follows `StateObjectEnv`); one the Models part reads, into `ModelsPartEnv` and the state Worker's
`env` the same way. The app's and the API's test Workers run those classes too, so they bind them as well; one that only
the classes read (the secrets keys) is declared for their tests in `apps/app/test/env.d.ts` and `apps/api/test/env.d.ts`,
not in the Workers' `Env`. One Models reads also goes into `ModelsBindings` (`packages/models/src/env.ts`)
and the Models test Worker's bindings (`packages/models/vitest.config.ts`; its `test/env.d.ts` follows `ModelsBindings`,
`StateObjectEnv` and `AuthBindings`); one Billing reads, into `BillingBindings` (`packages/billing/src/env.ts`) and the
Billing test Worker's (`packages/billing/vitest.config.ts`, `test/env.d.ts`), and in each Worker that serves a surface
Billing guards (`apps/api` today) in its `src/env.d.ts` and `vitest.config.ts`. Tools reads only `CONTROL_PLANE` (`ToolsBindings`, `packages/tools/src/env.ts`); one it comes to read goes there and
into `packages/tools/vitest.config.ts` the same way.

`tools/workers/worker-configuration.d.ts` holds the Workers runtime types for the compatibility date and flags in
`alchemy.run.ts`, shared by every program that runs in workerd (`apps/app`, `apps/api`, `packages/state`, `packages/models`, `packages/billing`, `packages/tools`; each declares its own
`Env`). Regenerate it when those change (Wrangler is used only as a type generator here):

```bash
printf '{"name":"t","main":"apps/app/src/index.ts","compatibility_date":"2026-08-01","compatibility_flags":["nodejs_compat","global_fetch_strictly_public"]}' > /tmp/rt.json
pnpm dlx wrangler@4 types --include-env=false -c /tmp/rt.json tools/workers/worker-configuration.d.ts
```

then restore the three-line header comment. Durable Object classes are SQLite-backed; Alchemy derives their class migrations from the
`DurableObject` bindings (renaming a class needs `className`/`transferredFrom`, see the Alchemy docs). The state
Worker's bindings carry `transferredFrom: "Commissary"`, which moved the namespaces out of the app Worker
(`docs/DEPLOY.md`, "The Workers"); it does nothing once a stage has moved, and stays.

Under `alchemy dev` the state Worker runs its dev entry (`apps/state/src/dev.ts`: its classes plus the dev-only
`DevStateBridge` entrypoint), and the app, API and auth Workers run theirs (`src/dev.ts`), which bind no Durable
Objects; `alchemy.run.ts` picks them on the dev flag only, so a deploy never does. The local dev registry reaches another
Worker's Durable Object by its hex id (alchemy's and miniflare's registry proxy: `getActor(…, ctx.id.toString())`,
[cloudflare/workerd#7286](https://github.com/cloudflare/workerd/issues/7286)), which drops `ctx.id.name`, the name a
ControlPlane learns its org from. So each dev entry replaces the state namespaces of its `env` with bridged ones
(`devBridgedEnv`, `@commissary/state/dev-state-bridge`) whose stubs record each call chain and send it, with the
object's name, over a service binding (`DEV_STATE_BRIDGE`) to the state Worker's `DevStateBridge`, which replays it on
a real stub of its own objects. Service-binding RPC to a named entrypoint keeps working through the dev registry, so
every Worker sees the state Worker's one copy of each object. No dev entry, nor the bridge, is in a deployed bundle.
`pnpm smoke` waits for each Worker's ready line. Deployed, Cloudflare sets `ctx.id.name` for an object reached by
`getByName` (Durable Object ID docs), so the preview deploy is where the script-name bindings are checked. Locally the
panel names its own origin as the client API's address; the API Worker answers on :1339.

With `COMMISSARY_MODE=cloud` (in the shell or `.env`) `pnpm dev` runs Commissary Cloud: the auth Worker (`apps/auth`)
starts too, on :1340, with a local `SignIn` database, Turnstile's always-passing test keys unless `TURNSTILE_*` are set,
and the app Worker on :1337 as its app origin (a host-only `localhost` session cookie spans the ports). Sign-in with
GitHub or Google needs an OAuth app of your own whose callback is `http://localhost:1340/api/auth/callback/github` (or
`/google`) in `SIGN_IN_*`. `COMMISSARY_MODE=cloud pnpm smoke` checks it (CI's `smoke (alchemy dev, Commissary Cloud)`),
and the panel's dev server forwards `/api` to the auth Worker (`COMMISSARY_AUTH_DEV_URL`).

### State RPC: expand, then contract

The state Worker deploys before its callers (ADR 0030), and while a deploy rolls out an old caller can meet a new
ControlPlane, SessionState or Platform, or the other way round. So a change to their RPC (methods, arguments, results,
a part's methods) is made in steps, one release apart:

1. **Expand**: add the new method or field next to the old one; the state Worker answers both, and a new field is
   optional for the old caller.
2. **Switch** the callers to it.
3. **Contract**: remove the old method or field a release later, once no deployed caller uses it.

A deploy of the state Worker resets its Durable Objects, and the calls in flight fail with "Durable Object reset because
its code was updated." The app and the API Worker retry such a call once, on a new stub (`retryOnCodeUpdate`,
`packages/state/src/code-update-retry.ts`, applied to the `env` in each `src/index.ts`); a call cut off by the reset
may have stored its writes before, so it may run twice. Only chains are retried: a call on a result the caller awaited
(`await stub.models()`) goes to the runtime's own stub, so call through the chain (`stub.models().x()`).

## Layout

`ARCHITECTURE.md` ("Layout" plus one section per subsystem) is the map. The repository is a pnpm workspace
(`pnpm-workspace.yaml`): Workers and the panel in `apps/`, libraries in `packages/`, under the scope `@commissary/*`.

- `apps/app` (`@commissary/app`): the app Worker (`Commissary`): panel and the management API; it binds the state Worker's Durable Objects and, on Commissary Cloud, the auth Worker. `src/access` (the gate middleware over `@commissary/auth`),
  `src/http` (router, the client API's 404, plain 404s),
  `src/management` (the org-wide management routes, panel serving, path zones, the role table, org addressing),
  `src/hosted` and `src/sso` (Commissary Cloud's sign-in page, the auth Worker's RPC and single sign-on), `src/platform`
  (org deletion), `src/dev.ts` (its `alchemy dev` entry over the bridge, "Infrastructure");
  `test/` (workerd tests through its router or `fetch`; `test/worker.ts` is the test Worker, with a fake auth Worker,
  `FakeSignIn`). It mounts Models explicitly, through
  `@commissary/models/api` and `/management` only ("Lint and format", `boundaries`), and Tools likewise through
  `@commissary/tools/api` and `/management`.
- `apps/api` (`@commissary/api`): the API Worker (`Api`, ADR 0030): the client API of every area and the cron jobs; it
  binds the state Worker's Durable Objects. `src/http` (router, the client gate, CORS, hosts: a 404 for every other
  path, `/healthz`), `src/scheduled.ts` (the cron runner), `src/dev.ts` (its `alchemy dev` entry over the bridge,
  "Infrastructure"); `test/` (workerd tests through the client API's router or `fetch`, two projects: self-hosted and
  Cloud; `test/worker.ts` is the test Worker). It mounts Models through `@commissary/models/api` only, and Tools (its
  cron task) through `@commissary/tools/api`.
- `apps/state` (`@commissary/state-worker`): the state Worker (ADR 0030). `src/index.ts` exports the ControlPlane
  (`src/control-plane.ts`: `@commissary/state`'s org-wide base composed with `@commissary/models/state`'s and
  `@commissary/tools/state`'s parts),
  SessionState and Platform, and answers every request 404; `src/env.d.ts` declares what the classes read; `src/dev.ts`
  adds the dev-only bridge ("Infrastructure"). No tests of its own: the app's, the API's and the auth Worker's test
  Workers run its classes.
- `apps/auth` (`@commissary/auth-worker`): the auth Worker (`Auth`, ADR 0030), Commissary Cloud only: Better Auth on the
  auth host and its `SignIn` database, and the `SignInService` RPC the app Worker calls. `src/http` (router, CORS for the
  app origin, the sign-in routes, `/healthz`), `src/sign-in` (Better Auth, sessions and the RPC's D1 work, the SSO
  plugin's adapter, Turnstile), `src/dev.ts` (its `alchemy dev` entry over the bridge); `test/` (workerd tests, one
  project `hosted`; `test/worker.ts` exports the entry and the state Worker's classes).
- `packages/models` (`@commissary/models`): the Models area (#134, #151). `handlers` (inbound protocols and the shared
  execution pipeline), `executor` (one directory per provider, the `Thinking` service, `translateRequestForExecutor`
  with the Codex rewrites), `credentials` (credential pool, selection, token refresh), `registry` (model catalogs and
  `/models`), `config` (with the payload rules), `oauth`, `quota`, `usage` (D1 usage records), `grants`, `spend`,
  `signature` (the `CACHE` KV store of signatures), `session-routing`, `management` (its management routes), the
  ControlPlane part, the client-API HTTP helpers, the request trace, its cron tasks and its org-deletion step. Three
  entry points and no root export: `./api` (the API Worker's: client API routes, request trace, cron tasks,
  `ModelsEnv`), `./management` (the app Worker's: management routes, OAuth callbacks, role-table entries, org-deletion
  step, its section of the org export) and `./state` (the state Worker's: `ModelsPart`); `./testing` holds what the
  Worker's tests need of it. Two more exports serve Node.js code at the root, not the Workers: `./auth-index-key` (the
  `auth_index` key constants, for `alchemy.run.ts`) and `./models-dev` (the models.dev trim, for
  `tools/sync-models-dev-catalog.ts`); the root lists the package as a dev dependency for them. It reads its bindings
  through `ModelsEnv`, its ControlPlane part's through `ModelsPartEnv`, and may import `@commissary/state`, `auth`,
  `translation`, `json`, `contract`, `core`, `effect`, `fzstd`, `yaml` and the runtime modules
  `tools/oxlint/boundaries` lists: nothing from `apps/`.
- `packages/billing` (`@commissary/billing`): Commissary Cloud's billing area (ADR 0042, #236), shaped like Models: plans
  (`free`, `payg`), free usage counted per org per calendar month in UTC, the Free plan's stop (`429 plan_limit_reached`),
  the request-rate ceiling per plan, `GET /billing`, its ControlPlane part (`BillingPart`) and its org-deletion step. It
  does nothing on a self-hosted Commissary. Entry points `./api` (what the API Worker and the areas that count call:
  `limitClientRate`, `countRequest`, `uncountRequest`, `BillingEnv`), `./management` (the app Worker's: the route, the
  org-deletion step), `./state` (the state Worker's: `BillingPart`) and `./testing`; `./plan` (the constants) serves
  `alchemy.run.ts`, not the Workers. It may import `@commissary/state`, `auth`, `contract`, `core`, `effect` and the
  runtime modules `tools/oxlint/boundaries` lists, and no other area; Models imports its `./api` only. Its tests run in
  workerd against `packages/billing/test/worker.ts`, a test-only ControlPlane (state's base composed with its part).
- `packages/tools` (`@commissary/tools`): the Tools area (#196): toolkits built from remote MCP servers, their
  credentials and tool lists. `toolkits` (names, the store, resolving the tools a caller sees, credential secrets),
  `mcp` (a minimal Streamable HTTP MCP client, behind the outbound guard), `management` (its management routes,
  role-table entries, its section of the org export), the ControlPlane part, its cron task (refreshing tool lists) and
  its org-deletion step. Three entry points like Models': `./api` (the API Worker's: cron tasks, `ToolsEnv`),
  `./management` (the app Worker's) and `./state` (the state Worker's: `ToolsPart`); `./testing` serves fake MCP
  servers to the Worker's tests (`fakeMcpServer`, `serveFakeMcpServers`). It reads its bindings through `ToolsEnv`
  (only `CONTROL_PLANE`) and may import `@commissary/state`, `auth`, `contract`, `core`, `effect` and the runtime
  modules `tools/oxlint/boundaries` lists: nothing from `apps/` or Models.
- `apps/web` (`@commissary/web`): the control panel (below).
- `packages/auth` (`@commissary/auth`): request-side authentication (#132). The principal and `AccessPrincipal`, roles,
  Access JWT verification, the cross-site checks, API and management keys (their text and the per-isolate caches of
  verified keys), admission and `syncOrgIndex`, Commissary Cloud's suspension checks and rate limit, and the two gates
  behind the entry points `authenticateClient` and `authenticateManagement`; `./sso` holds the pure parts of single sign-on,
  `./testing` the Access test helpers and an in-memory `AuthDirectory`. It reads `AuthConfig` and reaches state through
  its `AuthDirectory` service (the adapter: `@commissary/state`'s `auth-directory.ts`), never through bindings or the
  stores; the Worker passes in what its routes say (path zones, role table, org addressing: `src/management/zones.ts`,
  `policy.ts`, `org-address.ts`). It also holds the ownership rules the areas share (`ownership.ts`: `Scope`,
  `FULL_ACCESS`, `accessTo`, beside `Viewer`), which Models and Tools both apply. It may import `@commissary/core`, `@commissary/contract`, `effect` and `jose` only.
- `packages/contract` (`@commissary/contract`): the management API contract, shared by the Worker and the panel.
- `packages/core` (`@commissary/core`): the foundation without bindings, for code that two or more packages or apps
  need (today auth, state, Models and the Worker import it). `src/org.ts` (the org model: `OrgId`, `newOrgId`, `OrgSlug`, `GLOBAL_ORG`,
  `DEFAULT_ORG_SLUG`, `CurrentOrg`, org-scoped names), `src/errors.ts` (the shared tagged errors), `src/hash.ts`
  (`sha256Hex`), `src/logging.ts` (`redactHeaders`), `src/observability/` (`causeSummary`, the Workers Logs logger),
  `src/http/management.ts` (the management replies and the text, query and `If-Match` readers, `handled`),
  `src/http/route-services.ts` and `src/execution-context.ts` (`WorkerExecutionContext` over a structural
  `InvocationContext`, so core needs no Workers types, and `holdInvocation`), `src/area.ts` (what an area hands the
  Workers: `ScheduledTask`, `OrgDeletionStep`), all behind the one export `.`. It may
  import `effect` and `node:crypto` only: no bindings, no Workers APIs, no other workspace package. The per-request
  context (`requestContext`, `src/worker-env.ts`) stays in the Worker, which provides its env views; the ControlPlane
  stubs (`controlPlaneOf`, `controlPlane`) and the JSON body readers `bodyJson`/`bodyObject` (they return
  `@commissary/json` values) are `@commissary/state`.
- `packages/state` (`@commissary/state`): the org-wide state on Durable Objects (#134, #149). The ControlPlane's org-wide
  base (`src/control-plane.ts`) and its stores (`src/members`, `src/api-keys`, `src/management-keys`, `src/sso`,
  `src/secrets`, the `SessionState` instances), `composeControlPlane` (`src/compose.ts`: the base with the areas' parts,
  each reached through a method of its name, `stub.models().x()`), the Platform registry (`src/platform`), the
  general-purpose lease store (`src/lease.ts`), `SessionState` (`src/session-state`: class, client, protocol, engine),
  the stub helpers (`controlPlaneOf`, `platformOf`, `currentControlPlane`, the management routes' `controlPlane` and
  body readers), the retry on a code-update reset (`retryOnCodeUpdate`) and the one `AuthDirectory` adapter, all behind the one export `.`; `./testing` holds the workerd test helpers
  (`tablesOf`, `storedText`, `alarmOf`, `withPart`, `ORG_WIDE_TABLES`). It reads its bindings through `StateEnv` and its
  classes' settings from `StateObjectEnv`, and may import `@commissary/auth`, `@commissary/core`,
  `@commissary/contract`, `@commissary/json` and `effect` only: nothing from an area's code or `apps/`.
- `packages/json` (`@commissary/json`): the gjson/sjson path engine over parsed JSON, the `Json` types, `isValidJson`,
  `compactJson` and `stableStringify`. Depends on nothing.
- `packages/translation` (`@commissary/translation`): pure sync translation. `src/translator` (the `TranslatorRegistry`
  and one directory per format pair), `src/thinking`, `src/signature`, `src/tokenizer` and `src/sse.ts` are internal
  modules behind the exports `.` (the registry, the built-in translators, the model lookup, the summary hooks and the
  translator helpers the executors reuse), `./thinking`, `./signature`, `./tokenizer`, `./formats`, `./sse` and
  `./testing`. It may import `effect`, `@commissary/json` and `node:crypto` only: no Workers APIs, no other workspace
  package. Executors install the attempt's model lookup and signature cache around each synchronous translator call
  (`withModelInfoLookup`, `withSignatureContext`); the `CACHE` KV store of signatures is Models'
  (`packages/models/src/signature/store.ts`).
- The root stays the deploy root: `alchemy.run.ts`, `infra/`, `migrations/` (D1 schema), `stacks/`, `tools/` (with
  `tools/fixturegen`, Go programs that emit golden fixtures, see below), `go.work`, `.repos/`, `docs/` and the lint,
  format and commit configs.

## Workspace and Turborepo

Internal packages are source-only: `package.json` `exports` point at TypeScript in `src/` (`./*` → `./src/*.ts` for
the contract, named entry points for the others; `./testing` at `test/testing.ts`, "Tests" below), there is no build step, and whatever imports a package compiles it
(Alchemy's bundler, Vite, Vitest). Import a module by its subpath, e.g. `@commissary/contract/api` or
`@commissary/translation/thinking`. `apps/app` imports nothing from `apps/web` and only the state Worker's classes
from `apps/state` (types in `src/`, the classes in its test and dev entries), `apps/api` only the classes' types (and
the classes in its test entry), `apps/web` imports only
`@commissary/contract` from the workspace, and packages import nothing from `apps/` (lint rule). Versions that several packages share (`effect`, `typescript`, `vitest`, …)
are pinned once in the `catalog:` of `pnpm-workspace.yaml`.

`turbo.json` declares the tasks: `typecheck`, `test` and `build` run each package's script of that name, and the root
adds `typecheck:root` (the deploy code) and `lint:root` (one `oxlint`/`oxfmt` run over the repository). The packages
depend on each other's sources, not on build output, so every package task depends on `transit`, a task with no script whose
hash covers a package's files and those of its dependencies (Turborepo's transit-node pattern): a change in
`packages/contract` re-runs the panel's, auth's, state's, Tools' and the Worker's tasks, one in `packages/json` re-runs translation's and the
Worker's (and Models'), one in `packages/core` or `packages/auth` re-runs state's, Models', Tools' and the Worker's (and core's
auth's too), one in `packages/state` re-runs Models', Tools', the state Worker's, the app Worker's and the API Worker's, and one in
`packages/models` re-runs the state Worker's, the app Worker's and the API Worker's (`apps/state` is a dependency of
`apps/app` and `apps/api`), as does one in `packages/tools` (the root lists Models as a dev dependency for its deploy code; that re-runs no other package's tasks). The root `typecheck` and `test` tasks also hash `tools/vitest/` (the packages' Vitest configs import it), and
`typecheck` hashes `tools/workers/` (the Workers runtime types); a
package's `turbo.json` appends the root files its tasks read (`"$TURBO_EXTENDS$"`; `apps/app`: `infra/bundle.ts`,
`infra/preview-origin.ts`, `infra/settings.ts`, `migrations/`; `apps/auth`: `infra/bundle.ts`, `migrations/`; `apps/api`
and `packages/models`: `migrations/`). The cache is local
(`.turbo/cache`, one per git worktree: `cacheDir` keeps a worktree from writing into the main checkout's); there is
no remote cache. `pnpm exec turbo run <task> --force`
ignores it, `--dry` shows what would run and why.

## Model catalog

Every provider's models come from models.dev plus the catalog additions (ADR 0020; `docs/ARCHITECTURE.md`, "Model registry
and `/models` endpoints"). Three things are checked in under `packages/models/src/registry/catalog/`:

- `models-dev.json`: the trimmed models.dev snapshot a fresh deploy starts from. `pnpm catalog:sync` regenerates it from
  `https://models.dev/api.json` (or a URL or saved file given as argument); syncing a trimmed file rewrites it unchanged.
  A deployed Worker refreshes its own copy every 3 hours and from the Models page ("Refresh catalog").
- `additions.json`: what models.dev lacks (models it does not list, facts such as `thinking.dynamicAllowed`, Codex plans,
  `include`/`exclude` patterns). Edited by hand; the format and precedence ("an addition only fills gaps") are in the header
  of `packages/models/src/registry/catalog-additions.ts`. A wrong value for a model models.dev lists is fixed at models.dev, not overridden here.
- `codex_client_models.json`: the Codex client catalog, kept in its own format.

`packages/models/test/unit/catalog-build.test.ts` checks the trim, the build, the additions' rules and that every id the Go server served is
still served.

## Control panel (`apps/web`)

React 19 + Vite, Effect Atom (`effect/reactivity`, `@effect/atom-react`) for server state and TanStack Router (code-based
routes in `apps/web/src/router.tsx`). It calls the management API through the shared Effect `HttpApi` contract in
`packages/contract` (imported as `@commissary/contract/*`; the contract imports `effect` only, so it stays browser-safe,
and its own `tsconfig.json` checks it with neither DOM nor Workers types). `apps/web/tsconfig.app.json` type-checks the
panel with DOM types, `tsconfig.node.json` the Vite and Vitest configs and the tests. The tests (`apps/web/test/`)
cover the DOM-free modules of `src/lib` and run in Node.js, in UTC. Design context: `PRODUCT.md` and `.impeccable/`.

Local loop: `pnpm dev` in one terminal, `pnpm --filter @commissary/web dev` in another, open http://localhost:5173 (the
dev Access bypass applies). The build output in `apps/web/dist/` is gitignored; `pnpm dev` and `pnpm smoke` build it
first, CI before smoke and deploy. A new top-level page needs its path segment in `PANEL_SECTIONS`
(`apps/app/src/management/zones.ts`) so the Worker serves `index.html` for it.

## Tests

Every package and app keeps its tests in `test/` (no `*.test.ts` in `src/`) with its own `vitest.config.ts`. A test
lives in the lowest package that holds all the code it exercises; a test that goes through a Worker's router or `fetch`
stays with that Worker.

- **Runtime.** A package tests in plain Node.js unless the code under test needs a binding or a Durable Object. The
  app and the API Worker's tests run in workerd (`@cloudflare/vitest-plugin`, two projects each: self-hosted and Cloud)
  against their test Workers, `apps/app/test/worker.ts` and `apps/api/test/worker.ts`, which re-export the Worker's
  handler and the state Worker's Durable Objects so they run in one isolate with no auxiliary Worker (#135); the auth
  Worker's (`apps/auth/test/worker.ts`, one project, `hosted`) likewise. The app Worker's Cloud tests bind a fake of the
  auth Worker (`FakeSignIn`, reached over RPC through `ctx.exports`), whose sessions they start themselves; Better
  Auth's own flows are tested in `apps/auth`. A test
  that goes through the client API's router or `fetch` is the API Worker's; one that needs an org, member or API key
  there sets it up straight through the Durable Objects (`apps/api/test/support/client.ts`), since the management
  routes that make them are the app Worker's. So do
  `@commissary/state`'s (one project, `state`: a test Worker of its own, `packages/state/test/worker.ts`, exports the
  ControlPlane's base composed with two dummy area parts, the Platform registry and SessionState, on real SQLite
  storage; its bindings are declared in `test/env.d.ts`); `@commissary/models` has two projects (#135): `models-unit`
  runs `test/unit/` in Node.js (the tests whose modules reach no binding and no `cloudflare:*` module), `models` the
  rest in workerd against `packages/models/test/worker.ts`, a test-only ControlPlane (state's base composed with the
  Models part by `composeControlPlane`, as a Worker composes it) with the Platform registry and SessionState, its
  `CACHE` and `USAGE` and the bindings `test/env.d.ts` declares. `@commissary/billing` has one workerd project
  (`billing`): its test Worker, `packages/billing/test/worker.ts`, is a test-only ControlPlane (state's base composed
  with the Billing part) with the Platform registry and SessionState, on real SQLite storage; the bindings are in
  `test/env.d.ts`, and the rate-limit bindings are not bound in `vitest.config.ts` (tests inject their own). Models' client API harnesses put the routes behind
  `@commissary/auth`'s client gate (`test/support/client-gate.ts`), not the Worker's. The panel's and the other
  packages' tests run in Node.js. A test
  that restarts a ControlPlane (`evictDurableObject`) first disposes of every stub of a part it holds
  (`withPart(stub.models(), …)` from `@commissary/state/testing`); a pipelined call (`stub.models().x()`) leaves one
  held until the test ends, and the eviction never finishes. `@commissary/tools` has two projects the same way:
  `tools-unit` (`test/unit/`, Node.js) and `tools` (workerd, `packages/tools/test/worker.ts`: state's base composed
  with the Tools part only); its MCP servers are fakes the tests serve by replacing the isolate's `fetch`, which the
  ControlPlane in the same isolate calls (`serveFakeMcpServers`, also what the Worker's tests use through `@commissary/tools/testing`).
- **Package config.** A workerd package's `vitest.config.ts` uses `cloudflareTest` with its test Worker, the deployed
  Worker's compatibility settings and the bindings its env view names; its tsconfig adds the shared Workers runtime
  types and `@cloudflare/vitest-plugin/types`. A Node.js package's `vitest.config.ts` is
  `defineConfig(nodePackageTests("<name>"))` from
  `tools/vitest/node-package.ts`: one project named after the package over `test/**/*.test.ts`, and the `binModules`
  Vite plugin, which loads `*.bin` imports as the `ArrayBuffer` a Workers `Data` module gives (the Worker bundles them
  with that module rule, so binary assets behave the same in both runtimes). It sets `passWithNoTests`: CI's shards
  reach every package, and a package with fewer test files than shards gets none in some. The package's tsconfig
  includes `src`, `test` and `vitest.config.ts` with Node.js types but no Workers types.
- **Shared helpers.** A package whose fixtures or helpers its dependants' tests need exports them as `./testing`
  (`test/testing.ts`), e.g. `@commissary/translation/testing` (the thinking and token fixtures, the structural JSON
  comparison, the golden translator harness), `@commissary/state/testing` (a Durable Object's tables, rows and alarm,
  the ControlPlane's org-wide tables, `withPart`), `@commissary/models/testing` (the pipeline harness, the recording
  `HttpClient`, the ControlPlane and usage helpers, and the constants and modules the Worker's tests seed Models
  with) or `@commissary/billing/testing` (an org's plan and month's count set and read through the part, the free
  usage and ceiling constants, `resetBillingCaches`). There is no test-utils package. Lint allows `@commissary/*/testing`
  imports only in `test/` folders.
- **Fixtures** sit in the `test/fixtures/` of the package whose tests read them (below). A dependant reads them through
  `./testing`, never by a relative path into another package.
- **Runs.** `pnpm test` is `turbo run test`: transit nodes re-run a package's tests and its dependants' when its files
  change, and an unchanged package is answered from the cache. `pnpm test --shard=N/3` (CI's three jobs) shards
  every package's run; one package: `pnpm --filter @commissary/<name> exec vitest run [file]`.
- **Cross-org suite** (ADR 0044). `apps/app/test/org-isolation.test.ts` writes the same names (credential, key, session
  and model names) in three orgs (two made through the management API, and `global`) and checks that each store shows
  every org only its own: KV (`OrgKv`, the signature store, video bindings, Antigravity state and entitlements),
  SessionState, the per-isolate caches (signatures, Antigravity state, `ConfigReader` and registry snapshots, the
  auth Worker's standings), D1 usage through
  every query the management API exposes (records, summary, series, unpriced models, the export queue, private records,
  the credential filter), and the ControlPlane addressed by org slug (also after a rename) and by API key prefix.
  **Each new store (tool calls, approvals, runs, sandbox and browser sessions, profiles) adds one `storeCase(...)` line
  to `STORES` in that file** (`write` and `read` of one name, `test/support/org-isolation.ts`), in the same PR that
  adds the store.
- **Counts.** Tests move with the code they cover, none are dropped: a PR that moves tests lists the counts per project
  before and after.

## Golden fixtures (`tools/fixturegen`)

The generators run the real Go code of the reference checkout and write the `test/fixtures/` of the package whose tests
read them (`-out` defaults): `packages/json` (`jsonpath`), `packages/translation` (`thinking`, `signature`, `tokens`
and its rank files, `translator`) and `packages/models` (the others, and the translator cases with an executor context,
`translator-executor.json`). They form their own Go module (`tools/fixturegen/go.mod`, module path under the server's so they
may import its `internal/` packages) tied to `.repos/CLIProxyAPI` by a `replace` and the root `go.work`. Run them from the
repository root, e.g. `go run ./tools/fixturegen/translator` (use `TZ=UTC` for the translator). The model catalogs are no
longer generated from Go (ADR 0020): `…/registry` only records the listing fixtures, and `packages/models/test/fixtures/go-catalog-served.json`
(the ids Go served when the catalog moved to models.dev) is pinned, it does not follow the reference checkout.

The reference checkout follows upstream `main`, so regenerating after `pnpm repos:sync` shows what changed upstream: a
fixture diff is a change to consider (port the Go change and commit the new fixtures, or keep Commissary's behaviour and
leave the fixture as it is), not noise to commit blindly. Some
fixtures contain generated ids or timestamps that differ on every run; the tests mask those.

`tools/fixturegen/session/testdata/throwaway-rsa-2048.pem` is a public throwaway RSA test key: the Vertex service-account
cases need a fixed key so the fixture stays deterministic (`upstream-drift.yml` diffs regenerated fixtures). It is tied
to no real account and must never be used for anything real. The key appears in full in
`packages/models/test/fixtures/session.json`, so `.github/secret_scanning.yml` excludes both files from GitHub secret
scanning; exclude them from any other scanner too. The TypeScript tests generate their own keys at runtime
(`packages/models/test/support/vertex.ts`).

`tools/fixturegen/UPSTREAM_COMMIT` records the reference commit the committed fixtures were generated from (the last
ported upstream state). `tools/upstream-drift.sh` syncs the reference, regenerates every fixture, runs the tests on
them and reports the upstream commits since that commit and the test files that fail; the weekly
`.github/workflows/upstream-drift.yml` keeps one `upstream-drift` issue with that report. After porting, set
`UPSTREAM_COMMIT` to the reference commit you ported up to and commit the regenerated fixtures.

## Git hooks

`pnpm install` enables the Husky hooks in `.husky/` (the `prepare` script runs `husky`):

- `pre-commit`: lint-staged formats staged files with `oxfmt` and lints staged scripts with `oxlint --quiet` (errors
  only).
- `commit-msg`: commitlint with `@commitlint/config-conventional` (`feat:`, `fix:`, `chore:`, `docs:`, `refactor:`,
  `style:`, `test:`, `ci:`, …; header and body lines up to 100 characters).
- `pre-push`: `pnpm typecheck && pnpm lint`. The test suite runs in CI.

Skip them once with `git commit --no-verify` / `git push --no-verify`, or for a whole shell with `HUSKY=0`.

## CI and deployment

`.github/workflows/ci.yml` runs typecheck, lint, actionlint and zizmor, the tests in three shards, and the smoke test;
then deploys a preview per pull request and production from `main`. Setup and behaviour: [DEPLOY.md](DEPLOY.md).
A documentation-only change (Markdown files anywhere, everything under `docs/`) skips all of it (`tools/ci-changes.sh`):
the required checks still pass, so run `pnpm format` before committing Markdown (the pre-commit hook does).
Actions are pinned by commit SHA (Dependabot updates them weekly, `.github/dependabot.yml`), jobs get only the
permissions they need, and deploy jobs use no dependency cache.

## Lint and format

`pnpm lint` runs oxlint and `oxfmt --check`. oxlint (`.oxlintrc.json`) is type-aware (`options.typeAware`, via
`oxlint-tsgolint`) and also reports TypeScript errors (`options.typeCheck`); on top of its own rules it runs:

- **Effect tsgo** (`@effect/tsgo`, recommended preset): Effect-specific diagnostics. The `prepare` script
  (`effect-tsgo patch --no-typescript --oxlint`) patches the installed oxlint/tsgolint binaries after every install;
  `oxlint`, `oxlint-tsgolint` and `@effect/tsgo` are pinned to versions the patch supports, so upgrade them together.
- **anti-slop** (vendored in `tools/oxlint/anti-slop/`, provenance in its `UPSTREAM.md`): the copy belongs to this
  repository; edit its rules there.
- **boundaries** (`tools/oxlint/boundaries/`, ours): `boundaries/models-imports`, `boundaries/billing-imports` and
  `boundaries/tools-imports` keep `@commissary/models`, `@commissary/billing` and `@commissary/tools` behind their entry
  points (#151, #196; another package's sources import Billing's `./api` only, none import Models or Tools). An area's
  sources import only their own files, the dependencies its `package.json` declares and the runtime modules the rule
  lists; the apps import it only as `@commissary/<area>/api`, `/management` and `/state` (their tests also `/testing`),
  never its other exports or one of its files by a relative path. `boundaries/org-scoped-kv` (ADR 0044, #250) keeps org data out of raw KV: a source file of a package or an app
  (not `test/`) may not read the `CACHE` binding, name the `KVNamespace` type or use the Cache API, except the helpers
  (`packages/core/src/kv.ts`, `packages/models/src/kv.ts`; the `env.ts` and `env.d.ts` declarations may name the type).
  Org data in KV goes through an `OrgKv` (`orgKvOf(env, org)`), deployment-wide names through a `DeploymentKv`
  (`deploymentKvOf(env)`, names from `deploymentKey`); a new area that adds a binding of its own adds its helper file
  to the rule's list. Per-isolate caches of org data are an `OrgCache` by convention, which lint does not check.

Rules downgraded to warnings on purpose (reported, not failing): `effecttsgo/unstable-api-usage` (the HTTP stack is
`effect/unstable/http`), `anti-slop-effect/no-service-constructor-imports` (flags every `make*` function),
`anti-slop/no-runtime-typeof` (the translators walk arbitrary JSON like Go's gjson; `typeof` is the parse step) and
`anti-slop/no-conditional-empty-object-spread` (the `...(x === undefined ? {} : { x })` idiom required by
`exactOptionalPropertyTypes`). In `test/` folders the type-assertion and
dictionary-type rules are off (fake bindings and loose fixtures).

`no-restricted-imports` enforces the workspace boundaries: `@commissary/*/testing` only in `test/` folders, nothing
from `apps/` in `packages/` (so the org-wide ControlPlane in `@commissary/state` imports nothing from Models code).

Errors fail lint; warnings are reported but do not. Fix findings rather than silencing them: no disable comments. A type
assertion that cannot be removed carries a `// SAFETY: <invariant>` comment on the line(s) before it.

## Conventions

- Per-request Cloudflare `env` / `ctx` are passed as the `Context` argument of the web handler
  (`handler(request, requestContext(env, ctx))`); code reads the view of its package (`yield* AuthConfig`,
  `StateEnv`, `ModelsEnv`, `BillingEnv`, `ToolsEnv`, or `AppEnv` for code that stays in the app Worker, `apps/app/src/worker-env.ts`; the API
  Worker's own code reads `ApiBindings`, `apps/api/src/worker-env.ts`, and the auth Worker's `AuthWorkerEnv`,
  `apps/auth/src/worker-env.ts`), never the global `Env`. Never capture them in a layer.
- Add routes as `HttpRouter.add(...)` layers and merge them into the Worker's router (`apps/app/src/http/app.ts` for the
  panel and the management API, `apps/api/src/http/app.ts` for the client API, `apps/auth/src/http/app.ts` for the
  auth host); an area's routes reach it through the
  area's entry points (Models: the client API `ClientApiLayer` of `@commissary/models/api`, which the API Worker mounts,
  the management routes of `@commissary/models/management`, which the app Worker's `management/routes.ts` mounts;
  Tools: the MCP endpoint's `ClientApiLayer` of `@commissary/tools/api`, mounted next to Models', and its management
  routes of `@commissary/tools/management`).
- Never log tokens, API keys, JWTs or bodies; use `redactHeaders` when headers must be logged.
- No wall-clock sleeps in tests; use Effect `TestClock` or injected clocks.
- The Workers' tests live in `apps/app/test/*.test.ts`, `apps/api/test/*.test.ts` and `apps/auth/test/*.test.ts` and run in workerd ("Tests"
  above); Models' live in
  `packages/models/test/`. Use `@effect/vitest`
  (`it.effect`) for Effect code and `exports.default.fetch(...)` (`cloudflare:workers`) for end-to-end Worker requests.
- `alchemy.run.ts` gives a Worker a `workers.dev` URL on previews only, so Cloudflare Access cannot be bypassed (a
  preview's app Worker enrolls into its Access application; no Access application protects the API Worker: on a single host, the bypass application takes its paths out of
  the app host's).

## Dependency notes

- TypeScript 7 (native `tsc`). Each program has its own tsconfig extending `tsconfig.base.json`: `apps/app/tsconfig.json`
  (app Worker, workerd types), `apps/api/tsconfig.json` (API Worker, workerd types), `apps/auth/tsconfig.json` (auth Worker, workerd types), `apps/state/tsconfig.json` (state Worker, workerd types), `apps/web/tsconfig.app.json` (panel, DOM types) and `tsconfig.node.json` (its Node.js side),
  `packages/contract/tsconfig.json` (no runtime types), `packages/auth`, `packages/core`, `packages/json` and `packages/translation` (Node.js types,
  no Workers types), `packages/state`, `packages/billing`, `packages/models` and `packages/tools` (workerd types, with the Node.js tests of `test/unit/`
  checked in the same program) and the root's `tsconfig.infra.json` (deploy code, Node.js types). `tsc` only checks (`noEmit`); Turborepo caches it. `capnp-es` (via Alchemy) declares a TypeScript 5/6 peer
  range; it only ships types, so the peer warning is harmless.
- `@cloudflare/vitest-plugin` (successor of `@cloudflare/vitest-pool-workers`) is used because it supports vitest 5,
  which `@effect/vitest@4` requires.
- `alchemy` (2.0.0 beta, pinned) needs `@effect/platform-node` for its CLI; `@distilled.cloud/cloudflare` is pinned to
  the version Alchemy uses (the Access settings step calls the Cloudflare API with Alchemy's credentials).
