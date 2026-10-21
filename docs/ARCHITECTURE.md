# Cloudflare Workers port — architecture

This document records the binding decisions for the TypeScript/Effect rewrite of CLIProxyAPI that runs on plain
Cloudflare Workers behind Cloudflare Zero Trust Access. Behavioural references for the Go implementation live in
`docs/research/*.md`. The Go code is a reference, not the authority (ADR 0019): Commissary copies its behaviour where that
is the better design and differs where it is not. It is the read-only reference checkout in `.repos/CLIProxyAPI` (upstream [router-for-me/CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI), cloned by
`pnpm install`); Go paths cited here (`internal/...`, `sdk/...`) are relative to it.

## Goals and non-goals

Goals:

- Serve the OpenAI (chat/completions, completions, Responses), Claude (messages, count_tokens), Gemini (`/v1beta`) and
  Interactions APIs from a Worker, backed by the same provider credentials (OAuth and provider key) as the Go server.
- Faithful port of model resolution, credential selection/cooldowns/refresh, translators, the thinking pipeline and
  user payload rules.
- Cloudflare Access is the only client authentication mechanism (the Go server's client keys are imported but never enforced).

Non-goals (not ported): plugins (`internal/pluginhost`), CLIProxyAPIHome mode, TUI, mDNS discovery, pprof, git/Postgres/
object stores, request-log files, per-credential outbound proxies (`proxy-url`), uTLS TLS fingerprinting, Codex live /
realtime (WebRTC/SIP), the AI Studio `wsrelay` gateway, and deprecated `/v0/management` routes.

## Layout

A pnpm workspace run by Turborepo: Workers and the panel in `apps/`, libraries in `packages/` (scope `@commissary/*`,
source-only: they export TypeScript and whatever imports them compiles it). The deploy code stays at the root. Paths
such as `src/...` and `test/...` in the rest of this document are relative to `apps/app/`; translation's modules are
cited as `translation/...` (relative to `packages/translation/src/`), core's as `core/...` (relative to
`packages/core/src/`), auth's as `auth/...` (relative to `packages/auth/src/`), state's as `state/...` (relative to
`packages/state/src/`), Models' as `models/...` (relative to `packages/models/src/`), Billing's as `billing/...` (relative
to `packages/billing/src/`), Tools' as `tools/...` (relative to `packages/tools/src/`), Agents' as `agents/...` (relative
to `packages/agents/src/`) and the JSON path engine as `packages/json`.

```
.                             workspace root and deploy root (Alchemy, no Wrangler config); turbo.json
  alchemy.run.ts              infrastructure: app, API, state and (Cloud) auth Workers, DOs, KV, D1 (+ migrations),
                              assets, cron, zone routes, Access
  infra/                      deploy settings (.env), Cloudflare Access provisioning, a Cloud preview's app origin
  migrations/usage/           D1 schema of the usage database (`Usage`)
  migrations/sign-in/         D1 schema of Commissary Cloud's Better Auth database (`SignIn`, the auth Worker's)
  apps/app/                   @commissary/app: the app Worker (management API, panel serving, Cloud's sign-in page)
    src/
      index.ts                Worker entry: fetch; state calls retried once on a code-update reset
      dev.ts                  its `alchemy dev` entry: index.ts with the state namespaces over the state Worker's
                              dev bridge
      platform/               org deletion (every area's step, then the state's)
      http/                   router, the 404 of the client API (hosts.ts), plain 404s, /healthz
      access/                 the Access gate middleware: @commissary/auth's entry points with the Worker's routes
      management/             the org-wide /v9/management routes (members, people, orgs, SSO, API and management
                              keys), panel serving, the composition of every area's routes; path zones, role table,
                              org addressing
      hosted/, sso/           Commissary Cloud: the sign-in page, the auth Worker's RPC (sign-in.ts), per-org single
                              sign-on settings
    test/                     vitest suites in workerd: what goes through the Worker's router or fetch; worker.ts,
                              the test Worker, re-exports the handler and the state Worker's Durable Objects and binds
                              a fake auth Worker (FakeSignIn) on Cloud
  apps/api/                   @commissary/api: the API Worker (client API of every area, cron jobs; ADR 0030)
    src/
      index.ts                Worker entry: fetch, scheduled; state calls retried once on a code-update reset
      dev.ts                  its `alchemy dev` entry: index.ts with the state namespaces over the state Worker's
                              dev bridge
      scheduled.ts            the cron runner: its own job, then each area's ScheduledTasks
      http/                   router, the client gate, CORS, hosts (404 for every other path), /healthz
    test/                     vitest suites in workerd (self-hosted and Cloud projects): what goes through the client
                              API's router or fetch; worker.ts re-exports the handler and the state Worker's objects
  apps/auth/                  @commissary/auth-worker: the auth Worker, Commissary Cloud only (ADR 0030)
    src/
      index.ts                Worker entry (AuthWorker) over entrypoint.ts: fetch on the auth host, the
                              SignInService RPC methods
      dev.ts                  its `alchemy dev` entry: the state namespaces over the state Worker's dev bridge
      http/                   router: Better Auth's routes and the sign-in options, CORS for the app origin, /healthz
      sign-in/                Better Auth (auth.ts), sessions and the RPC's D1 work (sessions.ts), the SSO plugin's
                              adapter, Turnstile
    test/                     vitest suites in workerd: worker.ts re-exports the entry and the state Worker's objects
  apps/state/                 @commissary/state-worker: the state Worker, no routes (ADR 0030)
    src/index.ts              exports ControlPlane, SessionState, Platform and BrowserSession; answers every request 404
    src/dev.ts                its `alchemy dev` entry: index.ts plus the dev-only DevStateBridge entrypoint
    src/control-plane.ts      the ControlPlane Durable Object: @commissary/state's base composed with the Models,
                              Billing, Tools and Agents parts
    src/env.d.ts              what the classes read: the state Worker's bindings
  apps/web/                   @commissary/web: control panel served at / (React, Effect Atom, TanStack Router; built
                              into apps/web/dist, the Worker's assets), its tests in Node.js
  packages/auth/              @commissary/auth: request-side authentication (principals, Access JWTs, API and
                              management keys, roles, admission, Cloud suspension checks, the gates), state
                              through AuthDirectory; the viewer and the ownership rules the areas share
  packages/state/             @commissary/state: the org-wide state on Durable Objects (the ControlPlane's org-wide
                              base and its stores, composeControlPlane, Platform registry, leases, SessionState,
                              the stub helpers, the AuthDirectory adapter, Spend limits in src/spend/ behind
                              ./spend), tested in workerd
  packages/models/            @commissary/models: the Models area (#151); no root export, the Workers import it only
                              through ./api, ./management and ./state (lint rule boundaries/models-imports)
    src/api.ts                for the API Worker: client API routes, the request trace, cron tasks, ModelsEnv
    src/management.ts         for the app Worker: management routes, OAuth callbacks, role-table entries, org-deletion
                              step, its section of the org export
    src/state.ts              for the state Worker: ModelsPart, its part of the ControlPlane
    src/control-plane-part.ts the ControlPlane's Models part (config, credentials, grants, quota, OAuth)
    src/http/                 client-API HTTP helpers (error formatting per protocol, bodies, headers)
    src/observability/        the request trace
    src/config/               config schema (Effect Schema), storage, payload rules
    src/registry/             model catalogs, model info, /models listings
    src/credentials/          credential model, selection, cooldowns, refresh
    src/executor/             executor interface + one directory per provider
    src/signature/            the CACHE KV store of the thinking-signature cache
    src/handlers/             inbound protocol handlers (openai, responses, claude, gemini, interactions, ...)
    src/management/           Models' /v9/management routes (credentials, provider keys, settings, usage, ...)
    src/oauth/                provider logins (OAuth flows, public callbacks)
    src/usage/                usage records, D1 persistence
    src/quota/                server-side quota check: provider usage endpoints, stored per-credential reports
    src/grants/               grants
    test/                     Node.js tests (test/unit/) and workerd tests against a test-only ControlPlane
                              (test/worker.ts), fixtures generated from the Go code; test/testing.ts is ./testing
  packages/billing/           @commissary/billing: Commissary Cloud's billing area (plans, free usage, plan limits, the
                              request-rate ceiling per plan, Pay as you go through Polar; ADR 0042); no root export, the Workers import it only
                              through ./api, ./management and ./state (lint rule boundaries/billing-imports); does
                              nothing on a self-hosted Commissary
    src/api.ts                for the API Worker and the areas that count: limitClientRate, countRequest,
                              uncountRequest, PlanLimitReached, BillingEnv, its cron task (billing-meter-events)
    src/management.ts         for the app Worker: the /billing routes and their role-table entries, Polar's webhook
                              route (/webhooks/polar), its org-deletion step
    src/state.ts              for the state Worker: BillingPart, its part of the ControlPlane
    src/part.ts, store.ts     the Billing part (plan, free-usage counters, billing cap, Polar account and meter batches
                              in SQLite)
    src/provider.ts, providers.ts, polar.ts
                              the billing provider adapter, which one an invocation uses, and Polar's
    src/send-usage.ts, scheduled-tasks.ts, webhook.ts, org-deletion.ts
                              sending usage above free usage, the cron task, Polar's webhooks, the deletion step
    src/plan.ts, month.ts     the constants (plans, free usage, ceilings) and the calendar month in UTC
    src/bill.ts, notices.ts   Pay as you go's rates, the month's bill and the default billing cap; GET /billing's
                              notices
    src/meter.ts              counting a request against free usage and the plan limit
    src/rate-limit.ts         the per-plan request-rate ceiling
    test/                     workerd tests against a test-only ControlPlane (test/worker.ts); test/testing.ts is ./testing
  packages/tools/             @commissary/tools: the Tools area (#196); like Models, the Workers import it only
                              through ./api, ./management and ./state (lint rule boundaries/tools-imports)
    src/api.ts                for the API Worker: the MCP endpoint (/mcp), its cron tasks (tool-list-refresh,
                              toolkit-catalog-refresh), ToolsEnv
    src/management.ts         for the app Worker: management routes, role-table entries, org-deletion step, its section
                              of the org export
    src/state.ts              for the state Worker: ToolsPart, its part of the ControlPlane, the built-in toolkits'
                              providers from its env (builtInProviders, ToolsPartEnv: the optional browser binding
                              and its crawls' account and API token, BROWSER_SESSIONS, the Worker Loader and the sandbox sessions' namespace); the browser
                              sessions' Durable Object (BrowserSession and its env view, BrowserSessionEnv) and the
                              sandbox's classes (SandboxSession, SandboxEgress, WorkspaceServiceProxy)
    src/control-plane-part.ts the ControlPlane's Tools part (toolkits, their credentials, tool lists, overrides, tool
                              grants, the endpoint's list and calls, upstream sessions, browser profiles and their
                              grants)
    src/toolkits/             storage, names, the flat list of unique full names, static secrets, built-in toolkits
    src/catalog/              the toolkit catalog (#207): integrations.sh's trimmed registry (the bundled snapshot
                              integrations-sh.json and its trim, ./integrations-sh for `pnpm toolkits:sync`), the
                              sources' credentials from integrations.sh's v3 documents (integrations-sh-credentials.json,
                              ./integrations-sh-credentials), the catalog additions, the catalog's services and search,
                              its KV keys (stored.ts, all the cron refresh reads), the isolate's catalog and the cron
                              refresh, the live detect/discover lookups and their throttle, and Commissary Cloud's
                              managed OAuth apps
    src/browser/              the browser toolkit: its Quick Action tools (#212), its crawl tools and the log of who
                              started each crawl (#270), the browser-provider interface and its Browser Run adapters
                              (the binding's, the crawl REST API's); its session tools, what they do in a browser (masking
                              included) and the sessions' Durable Object (#213); browser profiles' storage (#215)
    src/sandbox/              the sandbox toolkit (#222): its tools, the sandbox-provider interface, sandbox networks,
                              output cuts, and Cloudflare's sandbox (cloudflare/: the SandboxSession object, the
                              egress entrypoint, the guarded loader, the adapter)
    src/grants/               tool grants (#198): their storage and what a member's grants give
    src/mcp/                  the MCP client that lists and calls a remote MCP server's tools, and Commissary's MCP
                              endpoint (protocol.ts, endpoint.ts)
    src/management/           Tools' /v9/management routes (toolkits, tool grants, browser profiles and their grants)
    test/                     Node.js tests (test/unit/) and workerd tests against a test-only ControlPlane
                              (test/worker.ts), fake MCP servers, a fake Browser Run binding, a fake browser
                              provider's sessions (test/support/fake-sessions.ts) and a fake second sandbox
                              provider; test/fixtures/ has the snapshot masking's golden fixtures; test/testing.ts is
                              ./testing
  packages/agents/            @commissary/agents: the Agents area (#226, ADR 0040): hosted agent definitions; like
                              Tools, the Workers import it only through ./api, ./management and ./state (lint rule
                              boundaries/agents-imports)
    src/api.ts                for the API Worker: AgentsEnv and the area's presence (the agents toolkit comes later)
    src/management.ts         for the app Worker: management routes (with AgentReferences, the seam to Models and
                              Tools), role-table entries, org-deletion step, its section of the org export
    src/state.ts              for the state Worker: AgentsPart, its part of the ControlPlane
    src/control-plane-part.ts the ControlPlane's Agents part (agents, their watchers, agent grants)
    src/agents/               storage and the checks of a definition's texts
    src/management/           Agents' /v9/management routes (agents, agent grants), the reference check
    test/                     workerd tests against a test-only ControlPlane (test/worker.ts); test/testing.ts is
                              ./testing
  packages/contract/          @commissary/contract: the management API's Effect HttpApi schemas and addressing (browser-safe)
  packages/core/              @commissary/core: the foundation without bindings (org model, shared errors, hashing,
                              log-safe helpers, management replies, route services, the execution context, the
                              area contracts ScheduledTask and OrgDeletionStep, the outbound guard, and the org-scoped
                              helpers OrgKv, DeploymentKv and OrgCache of src/kv.ts)
  packages/json/              @commissary/json: gjson/sjson-compatible path engine, Json types, JSON text helpers
  packages/translation/       @commissary/translation: pure translation, tested in Node.js
    src/translator/           registry + one directory per (client -> provider) pair
    src/thinking/             canonical thinking pipeline (port of internal/thinking)
    src/signature/            thinking-signature validation and cache (port of internal/signature, internal/cache)
    src/tokenizer/            BPE token counting (ranks in src/tokenizer/ranks/*.bin)
    src/systemone/            System One requests and errors (assets, Box, `detail` errors), SubQ conversion
    src/sse.ts                SSE line splitting and frame builders
    test/                     Node.js tests + fixtures generated from the Go code; test/testing.ts is ./testing
  tools/fixturegen/           Go programs (own module, root go.work) that emit golden fixtures from the Go code
  tools/sync-reference-repos.sh  clones/updates the reference repositories in .repos/ (pnpm install, pnpm repos:sync)
  .repos/CLIProxyAPI/         read-only Go reference checkout (git-ignored)
```

## Runtime topology

- **Workers** (stateless; ADR 0030): the **app Worker** (`Commissary`, `apps/app`): the panel and the management API,
  behind Access on a self-hosted stage; the **API Worker** (`Api`, `apps/api`): the client API of every area (routing,
  the client gate, request handling, translation, upstream `fetch`, streaming) and the cron jobs, never behind Access
  (clients send API keys); on Commissary Cloud only, the **auth Worker** (`Auth`, `apps/auth`): Better Auth on the auth
  host and its `SignIn` database (see "Commissary Cloud").
- **State Worker** (`State`, `apps/state`, ADR 0030): defines the three Durable Objects below and nothing else: no
  routes, no domain, no `workers.dev` URL, and only the bindings their classes read. The app and the API Worker bind
  them by the state Worker's script name, so a deploy uploads the state Worker first, and restarts the Durable Objects
  only when their own code changed (Alchemy uploads a Worker again only when its bundle changes). A call cut off by
  that restart ("Durable Object reset because its code was updated") is sent once more on a new stub: both Workers wrap
  the namespaces of each invocation's `env` (`retryOnCodeUpdate`, `state/code-update-retry.ts`), and the wrapped stubs
  still send each call when it is made and a pipelined `stub.models().x()` in one round trip; the retry replays the
  chain from a new stub. State RPC changes are expand-then-contract (`docs/DEVELOPMENT.md`). The namespaces moved from
  the app Worker with every stored object (`transferredFrom`, `docs/DEPLOY.md`). Under `alchemy dev` the other Workers
  do not bind the namespaces: the dev registry would reach the state Worker's objects by hex id, without the name a
  ControlPlane learns its org from ([cloudflare/workerd#7286](https://github.com/cloudflare/workerd/issues/7286)).
  Their dev entries (`src/dev.ts` of the app, API and auth Workers) reach the objects over a service binding to the
  state Worker's dev-only `DevStateBridge` entrypoint (`apps/state/src/dev.ts`, `state/dev-state-bridge.ts`: a stub's
  call chain, with the object's name, is sent over the binding and replayed on a real stub there). No dev entry is
  ever deployed. The tests run each Worker's handler and the
  classes in one isolate (`test/worker.ts` of each app).
- **Hosts** (ADR 0028, ADR 0030; `apps/app/src/http/hosts.ts`, `apps/api/src/http/hosts.ts`): each Worker serves its own
  paths wherever it answers, and neither looks at the request's hostname. The client API paths (`CLIENT_API_PREFIXES`,
  `core/http/client-api.ts`) are the API Worker's: on the API host when the deployment has one (`API_DOMAIN`, deploy
  setting `COMMISSARY_API_DOMAIN`: the API Worker's custom domain), on its own `workers.dev` URL on a preview, else
  through zone routes `<app host><prefix>*` on the app host (`COMMISSARY_APP_DOMAIN`, by default `COMMISSARY_DOMAIN`),
  which run in front of the app Worker's custom domain (on a self-hosted stage every prefix but `/mcp`, whose app-host
  path is the app Worker's MCP endpoint behind Access, ADR 0045). The
  app Worker answers a client API path that reaches it (but a self-hosted Commissary's `/mcp` itself) `404 {"error": "Not found: the client API is served at
  https://<API_DOMAIN>"}` (or "… by the API Worker" without an API host), checked before authentication; the API Worker
  answers every path but the client API and `/healthz` `404 {"error": "Not found: … serves the client API only; the
  control panel and the management API are at https://<APP_DOMAIN>"}`. Only the API Worker sends CORS headers (the
  panel calls the management API same-origin). `GET /me` reports the API host (or a preview's API Worker host) as
  `api_url` for the panel. Revoking a key, removing a member, deleting an org or suspending a person or org on the app
  Worker reaches the API Worker's per-isolate caches within their windows (`VERIFIED_KEY_TTL_MS`, `STANDING_TTL_MS`:
  30 s each), as it always reached the app Worker's other isolates.
- **Orgs** (ADR 0021, `core/org.ts`; the ControlPlane stubs in `state/org.ts`): one deployment serves many orgs, and every request and scheduled job
  belongs to exactly one. The per-request `CurrentOrg` service carries its id (`OrgId`: lowercase letters, digits and
  inner hyphens); `requestContext` provides it next to the env views as `global`, the org of the
  deployment that existed before orgs, and the Access gate replaces it with the org an org-scoped management URL
  addresses or the org an API key names. `CurrentOrg`
  is a required service, not a default: code that reaches org state without an org does not compile, and where a type
  cannot require it (the SessionState backends and the Antigravity executor also run outside a request in unit tests)
  a request without an org is a defect (`optionalRequestOrg`), never a silent read of `global`'s state.
- **`ControlPlane` Durable Object** (one per org, named by the org id: `controlPlaneOf(env, org)` is the only
  `getByName` of the namespace; `currentControlPlane` resolves the request's; SQLite storage): config document,
  credentials, selection cursors, cooldown/quota state, session affinity, OAuth login sessions, refresh scheduling via
  alarms. It is the single writer for its org's credential state, which replaces the Go `singleflight`/mutex/goroutine
  machinery, and knows its org from its own name (`ctx.id.name`; an object not named by an org id throws instead of
  serving `global`). The Worker talks to it through JS RPC methods (e.g.
  `pick`, `report`, `getConfig`). The org `global` keeps the object it always had (`getByName("global")`), so upgrading
  moves no data.
  - **Base and parts** (#134 "How an area's ControlPlane part works", #148, #149): the class `ControlPlane`
    (`apps/state/src/control-plane.ts`) is the org-wide base (`state/control-plane.ts`: members, teams, service tokens, the
    membership index and settings, API keys, management keys, SSO, `SessionState` instances, the org's data key)
    composed (`composeControlPlane`, `state/compose.ts`, which gives each part a method of its name) with the Models part (`models/control-plane-part.ts`: config, credentials, selection, refresh, grants,
    quota, reset grants, OAuth logins; it checks and charges Spend limits through the base's, `core.spend`), the Billing part (`billing/part.ts`: the plan and the
    free-usage counters, `stub.billing().admit(…)`; see "Billing") and the Tools part (`tools/control-plane-part.ts`:
    toolkits, their credentials, tool lists, overrides and prices; see "Tools"). A part is an `RpcTarget` constructed once per object with the
    base's in-object view (`OrgCore`: org id, member and team lookups, data key, the alarm), creates its own tables and
    is reached through a method, `stub.models().pick(…)`: one pipelined round trip. A getter (`stub.models.pick(…)`) was
    the first plan; vitest-pool-workers answers a getter of a Durable Object stub with a function, so the pipelined call
    fails there (it works in plain workerd). The base imports nothing from Models code (it lives in `@commissary/state`,
    which imports nothing from `apps/`); it tells the part what changed in the org (`ControlPlanePart`: a member left, a team was deleted,
    API keys were deleted, …), calls its `wipe()` from `wipeOrg`, seals its plain-text secrets on the first start, and
    owns the object's one alarm: each part reports its next wake-up, the alarm is set to the earliest and calls the parts
    that are due (a part not heard from since the object started is called too). Tables and storage are the same as
    before the split. A test that evicts a ControlPlane first disposes of any stub of the part it holds: a held stub
    keeps `evictDurableObject` from finishing.
- **Org-scoped names**: everything the Worker derives for an org outside its ControlPlane is named per org with
  `orgScopedName(org, name)`: unchanged for `global` (so existing KV entries, SessionState instances and live sessions
  survive the upgrade), `org.<org>.<name>` for any other org. That covers the SessionState addresses (the store name),
  the KV entries of org data (Antigravity cooldowns, credits and model entitlements, the signature cache, xAI video
  bindings), the Antigravity credits-probe slot and OAuth callback states. Caller scopes hash the org in for any org but
  `global` (`callerScope(principal, org)`), and `auth_index` values use a key derived per org from `AUTH_INDEX_KEY`
  (`orgAuthIndexer`; `global` keeps the deployment key, so existing handles and panel links do not change). Worker-side
  caches of org data are keyed by org (below).
  Org isolation is enforced in code (ADR 0044, #250). KV: code never holds a raw `KVNamespace`; org data goes through
  an `OrgKv` (`core/kv.ts`), bound to one org, which scopes every name with `orgScopedName` (a name of `global` that
  starts with `org.` is refused, so it cannot reach another org's entry; `global`'s unprefixed names are the one
  exception). Deployment-wide entries (the models.dev catalog and its refresh status, the xAI and Antigravity client
  versions) go through a `DeploymentKv`, whose names are declared one by one with `deploymentKey(...)`. The `CACHE`
  binding is read in `models/kv.ts` only (`orgKvOf`, `deploymentKvOf`); the lint rule `boundaries/org-scoped-kv` fails
  any other source file that reads `CACHE`, names the `KVNamespace` type (the `env.ts` and `env.d.ts` declarations
  aside) or uses the Cache API (the Workers use none today). Per-isolate caches: the auth caches (verified API and
  management keys, standings), Billing's plans and plan-limit refusals, the `auth_index` indexers and the in-memory
  Antigravity state are an `OrgCache`
  (`core/kv.ts`), keyed by the org and the name apart; the `ConfigReader` and registry snapshots are maps keyed by the
  typed `OrgId`; the signature caches of `@commissary/translation`, which cannot import `core`, take a plain scope,
  and `orgSignatureCache` (`models/signature/store.ts`) is where it is always an org id. No lint rule covers these
  caches: they rest on the helper, on that convention and on the cross-org suite (`apps/app/test/org-isolation.test.ts`),
  which writes the same names in three orgs and reads every store from the others.
- **`Platform` Durable Object** (the Platform registry, `state/platform/{platform,registry,registry-store}.ts`; one object
  per deployment, `platformOf(env)` = `getByName("platform")`, SQLite storage, tables `CREATE IF NOT EXISTS` on
  construction so a deployment gains it without a migration): what spans orgs. The list of orgs (`orgs`: permanent `id`,
  unique `slug`, `name`, `created_at`; `global` is seeded as slug `default`, name `Default` and left alone afterwards, so
  a rename sticks), the indexes of which orgs a person (`org_members`) and an Access service token
  (`org_service_tokens`) belong to (a copy of the orgs' members and service tokens, pushed by the Worker: see "Members,
  roles and teams"; the orgs' ControlPlanes stay authoritative, so the indexes are repairable), and the catalog refresh
  lease (below). Platform admins are not stored in it: the
  deployment's variables name them (see Authentication), so they can always repair the registry. See "Orgs in
  addresses" below.
- **Deployment-wide state**: the model catalog (KV copy, refresh status and refresh lease) and the client versions
  (Antigravity, xAI) are shared by every org. The catalog's source, `models.catalog`, is a deployment setting: only the
  `global` org's config may set it (another org's `ConfigStore` refuses a document that does, `422` through the
  management API), every org's `ConfigReader` snapshot carries `global`'s value (the read fails while `global`'s
  config was never read and cannot be, rather than fall back to the org's default), and every refresh (cron or any org's
  panel) uses `global`'s setting and the refresh lease in the Platform registry, so no org can repoint the shared
  catalog.
- **`SessionState` Durable Object** (one instance per store + caller scope + session key, `getByName`, SQLite storage):
  the replay and continuity caches (Codex/xAI/Claude/Kimi/Gemini/Antigravity reasoning replay, Claude continuity, Devin turn
  counter, Antigravity Interactions continuation) with TTL and compare-and-swap semantics, see "SessionState Durable Object".
  The Responses WebSocket does **not** use it: that state lives in the Worker invocation that accepted the socket (see
  "Responses WebSocket transports").
- **KV `CACHE`**: the model catalog (one trimmed models.dev document, refreshed by cron or on demand) and the status of its
  last refresh, best-effort caches (signature cache) with `expirationTtl`; org data under org-scoped keys.
- **D1 `USAGE`**: usage records written with `ctx.waitUntil`, each with its `org_id`; every query filters on it.
- **Static assets** (`apps/web/dist/`, Worker runs first): the control panel (`apps/web` build).
- **Cron trigger** (every 3 h, production only; on the API Worker, the runner `apps/api/src/scheduled.ts`, which
  provides the state's and each area's env view itself): its own job (expired API keys), then each area's tasks
  (`ScheduledTask` of `@commissary/core`; Models' from `models/api.ts`): the model catalog refresh (the one
  models.dev document: every provider's models, OpenCode's included), Antigravity version and model entitlements, xAI client version, usage retention, the Devin user status, a
  safety sweep that re-arms credential refresh alarms, and the quota check of connected accounts; then Tools' tool list
  refresh (`tools/scheduled-tasks.ts`, org-scoped: see "Tools"); then Agents' agent run retention
  (`agents/runs/retention.ts`, deployment-wide: see "Agent runs"). A job is
  deployment-wide (catalog, client versions, usage retention, agent run retention: once per run) or org-scoped (entitlements, Devin status,
  refresh sweep, quota check: once per org the Platform registry lists, `global` first, with `CurrentOrg` set, a failure in one org not
  stopping the next). When the registry cannot be read the org jobs run for `global` alone, so a registry outage does not
  stop the deployment's own jobs.

Request flow:

```
client -> (Cloudflare Access bypass on a single host) -> API Worker
  verify the API key (or an Access JWT) -> principal (the key's member | email | service token); CurrentOrg (the key's org)
  handler parses body (entry protocol) -> resolve model/providers (registry + config, suffixes, aliases)
  loop (retry rounds): ControlPlane.pick(...) of the request's org -> credential snapshot + lease
      executor: translate request -> thinking -> provider shaping -> payload rules (final) -> fetch upstream
      translate response (stream: one SSE line at a time with per-request state)
      ControlPlane.report(lease, result) -> cooldown/quota bookkeeping
  frame response for the entry protocol (SSE / JSON / WebSocket); usage record via waitUntil
```

## Engineering conventions

- TypeScript strict mode, ESM, `effect@4` (HTTP via `effect/http` `HttpRouter.toWebHandler`; per-request Cloudflare
  `env`/`ctx` are provided as services through the handler's per-request `Context`).
- Each package reads its own view of `env` (#134): `AuthConfig` (`auth/config.ts`: Access, platform admins,
  dev bypass, hosted mode), `StateEnv` (`state/env.ts`: the Durable Object namespaces, typed through
  their classes; the classes read `StateObjectEnv`, the bindings plus platform admins, mode and secrets keys), `ModelsEnv` (`models/env.ts`: `CACHE`, `USAGE`, `SESSION_STATE`, `AUTH_INDEX_KEY`,
  `META_MINT_URL`, and `CONTROL_PLANE` typed as objects with `models()`, the Models part's methods Models calls); `BillingEnv` (`billing/env.ts`: `CONTROL_PLANE` typed with `billing()`, `PLATFORM`, `COMMISSARY_MODE`, the two rate-limit
  bindings, `APP_DOMAIN`, Polar's settings); `core` reads none. Code that stays in the
  Worker reads `AppEnv` (`src/worker-env.ts`). `requestContext` provides each from the invocation's `env`, plus auth's
  ports over it: `AuthDirectory` (`state/auth-directory.ts`, the Durable Object stubs) and `SignInSessions`
  (`src/hosted/sign-in.ts`, the auth Worker's RPC); the global
  `Env` appears only in the entries (`index.ts`, `dev.ts`, the API Worker's `scheduled.ts`) and tests; the API Worker's
  code reads `ApiBindings` (`apps/api/src/worker-env.ts`); the state Worker's classes read
  `StateObjectEnv` and their parts' views (`apps/state/src/env.d.ts`); the auth Worker's code reads `AuthWorkerEnv`
  (`apps/auth/src/worker-env.ts`).
- Use Effect at boundaries and for orchestration: services (`Context.Service`) + `Layer`s, `Schema` for config,
  credentials and external payloads, tagged errors, `Stream` for upstream/downstream streaming, `HttpClient`
  (`FetchHttpClient`) for upstream calls so tests can swap the transport.
- Translators, thinking appliers, and payload rules are pure synchronous functions over parsed JSON values
  (`JSON.parse` output). Preserve key order; do not reorder fields when not required. Keep the Go structure
  (one module per Go file group) so future upstream changes can be ported mechanically; cite the Go source path at the
  top of each ported module.
- Payload rules remain the final semantic mutation before the upstream request in every executor path (see AGENTS.md).
- No wall-clock sleeps in tests; use Effect `TestClock`.
- Tests: `vitest` + `@effect/vitest`; Worker/Durable Object integration tests with `@cloudflare/vitest-plugin` (successor of `@cloudflare/vitest-pool-workers`). `@commissary/state` tests its Durable Object classes on real SQLite storage in a test Worker of its own (`packages/state/test/worker.ts`: the base composed with two dummy area parts, the Platform registry and SessionState). `@commissary/models` has two projects: Node.js (`packages/models/test/unit/`) and workerd, in a test Worker with a test-only ControlPlane (`packages/models/test/worker.ts`); `@commissary/billing` tests in workerd against a test-only ControlPlane with its part (`packages/billing/test/worker.ts`).
  Translators and the thinking pipeline are verified against golden fixtures produced by `tools/fixturegen`
  from the Go implementation (`go run ./tools/fixturegen`), checked in under the package's `test/fixtures/`.
- Never log tokens, provider keys or JWTs.

## JSON values, config and payload rules

- **JSON output**: Commissary emits plain `JSON.stringify` output (`packages/json/src/text.ts`): no HTML escaping of `<`, `>`,
  `&`, U+2028 and U+2029, and keys in the order they are built, not Go's sorted map order (ADR 0019: the Go server is a
  reference, and no client depends on those bytes). `compactJson` still leaves number text verbatim. The one sorted
  serialiser, `stableStringify`, is for text that feeds a hash or an equality check (session-routing fingerprints and
  derived identities, Antigravity replay digests and comparisons, Claude thinking replay, the Gemini-to-Claude tool use id);
  those must be stable but need not match Go. Golden fixtures from `tools/fixturegen` compare JSON structurally (parsed,
  order-insensitive) while SSE framing and non-JSON text stay exact. The hash keys changed once at the deploy that introduced
  this, which costs one sticky-session, replay and prompt-cache miss per live conversation.
- **Path engine (`packages/json`)**: gjson/sjson semantics over parsed `JSON.parse` values instead of raw bytes, verified
  against the real tidwall libraries through golden fixtures (`go run ./tools/fixturegen/jsonpath`). `get`
  returns `undefined` for "does not exist" (`null` exists); `set`, `setRaw` and `del` mutate containers in place and
  return the root; values are inserted by reference (clone shared values). Known differences from Go: integer-like
  object keys are enumerated first by the JS engine, numbers are doubles (raw text such as `1.0` is not preserved),
  and sets/deletes on complex paths (`#`, `|`, `@`, `*`, `?`) throw `JsonPathError` (sjson silently rewrites matches;
  nothing in the Go code relies on it, payload rules expand `#(...)` queries into index paths first). Reads support
  `#`, `#.key`, `#(q)`, `#(q)#`, wildcards, pipes and the modifiers `@this @reverse @keys @values @flatten`.
- **Config (`models/config/`)**: the canonical document is the v8 layout restricted to keys that apply on Workers
  (`schema.ts`, kebab-case keys as in YAML). `codec.ts` imports YAML/JSON (v8, legacy flat layout and historical v8
  spellings, see `document.ts`), validates, normalises (`normalize.ts`, port of the Go `Sanitize*` functions) and
  encodes it back to the v8 layout (`encodeConfig`, which config entries are made of). The schema still decodes
  `access.admin-emails` and `access.admin-service-tokens` so a document that carries them imports, but they are no
  settings: an import lists them as `not_applied` (org members and roles replace them, see "Members, roles and teams").
  Keys that are accepted but have no effect on Workers are listed in `config/not-applied.ts` with a one-line reason (and
  MIGRATION.md); the import names them in its answer (`not_applied`) and stores none of them (ADR 0025), so the Settings
  view carries no such list. `requests.proxy-url` is accepted but ignored. Unknown/inapplicable keys are dropped on import.
- **Storage** (ADR 0025): the `ControlPlane` DO's Models part (`models/control-plane-part.ts`) keeps the org's configuration as
  config entries in SQLite (`ConfigStore`, `models/config/store.ts`; the pure mapping between a `Config` and its rows is
  `models/config/entries.ts`). Every setting (by dotted path, e.g. `routing.strategy`), every provider key group, every provider key
  (its id is its credential id), every channel's model aliases, every channel's model exclusions and every payload rule
  is a row of its own with a `revision`, `updated_at` and `updated_by`. One change counter per org (`config_changes`)
  moves on every write and is the config `version`; each entry a write changes takes the counter's new value as its
  revision. A missing entry has revision 0, and so has a setting at its default, which is not stored. Since the counter
  never goes back, an entry deleted and created again never repeats a revision. A write names the revision of every entry
  it changes and is refused (`conflict`) when one is stale, so writes to different entries never conflict; its rows are
  applied and the assembled config decoded in one storage transaction, and a write that would leave an invalid config is
  rolled back (`invalid`). RPC: `getConfig(sinceVersion?)` (the assembled config, `unchanged: true` when the caller is
  current), `configEntries()` (that config with the revision of every entry, which the management routes edit),
  `writeSettings`, `writeChannelRule`, `writeKeyGroup` and `importConfig(text, by)` (all return a structured result with
  `invalid` / `conflict` instead of throwing). The ControlPlane assembles the config from the entries (`current()` /
  `snapshot()`) and only re-assembles it when the counter moved. The Worker reads through `ConfigReader`
  (`models/config/reader.ts`): per-isolate snapshot per org, 5 s TTL then a version check, stale-if-error, so readers still
  rebuild their cached views when the version moves. Each org's ControlPlane stores its own entries; deployment settings
  (`DEPLOYMENT_SETTINGS` in `config/store.ts`, today `models.catalog`) are accepted in the `global` org's config only, and
  `ConfigReader` puts `global`'s value into every other org's snapshot.
- **Config migration** (`ConfigStore`, a Durable Object SQLite schema migration; there is no D1 migration): a
  ControlPlane that stored the config as one document (the former single `config` row, config-version 8) and has no
  entries yet imports it on first start, in one transaction. The Config is the same, credential ids are the same (the Go
  content hash of each key, so auth indexes do not change), the counter continues after the document's version (every
  cached view rebuilds), the old row is kept, and the entries it writes have `updated_by = "migration"`. Not-applied keys
  are dropped, as on import.
- **Stored secrets** (`state/secrets/`): every value the ControlPlane stores that can hold a secret is a _sealed value_:
  the JSON of each auth file (`credentials.metadata`) and the value of every config entry (settings, key groups with
  their headers, provider keys, model rules, payload rules; and the legacy `config` document). Ids, positions, revisions,
  writers, `credential_state`, price overrides (`config_price_overrides`, prices only) and the usage tables stay
  readable. A sealed value is `enc:v1:` + base64url of a 96-bit
  random nonce, the AES-256-GCM ciphertext and its 128-bit tag, with `enc:v1\0<table>/<row id>` as additional data, so
  a value copied to another row or another org does not open (`SecretCipher`, `cipher.ts`). Each org has its own random
  256-bit _data key_, stored only wrapped in the ControlPlane's `org_data_key` table (`wk:v1:`, AES-GCM, the org id as
  additional data); the wrapping key is derived with HKDF-SHA-256 from the stage's _secrets key_ `SECRETS_KEY`
  (`deployment-keys.ts`, minted by the deploy, see DEPLOY.md). The ControlPlane opens the data key once per start, in
  `blockConcurrencyWhile` (`OrgSecrets`, `data-key.ts`), so no call reaches a store before; sealing and opening are then
  synchronous (`node:crypto`, since the stores' read-modify-write sequences must stay synchronous under the input gate;
  the wrapping key stays a non-extractable WebCrypto key). On the first start it creates the data key and seals every
  value still in plain text in the same transaction as the key row, so a stored key means every value is sealed (a
  Durable Object SQLite migration; there is no D1 migration). After a rotation it unwraps with `SECRETS_KEY_PREVIOUS`
  and wraps the same data key under the new key; the data is not encrypted again. When the secrets key is missing,
  refused (a deployed stage refuses the development key and keys under 64 characters) or opens no data key, the object
  logs why and every call fails with the reason: no store reads garbage or writes under another key. A value that does
  not open (changed, copied, plain text after the migration) fails that read with `SealedValueError`, naming the row,
  never the value. Removing an auth file does not open it. Not sealed: provider OAuth login sessions (PKCE verifiers,
  short-lived), `SessionState`, KV caches.
- **Payload rules (`models/config/payload/`)**: `applyPayloadRules(config, request, payload)` is the single final barrier;
  it mutates `payload` in place (callers pass a freshly built body and a distinct `original`). The Codex tool-schema
  integer normalisation that Go performs inside the same function lives in `executor/helps/payload.ts` (`finalizePayload`: normalise
  for Codex clients targeting non-Codex executors, then `applyPayloadRules`); executors call `finalizePayload`.
- **Config normalisation** follows the Go `Sanitize*` functions on the _flattened_ list: gemini/interactions keys are
  deduplicated across all groups of a family (key, base URL, proxy, prefix, order-independent headers; entry values override
  the group's), vertex keys by `api-key|base-url` (keys without api-key and models without name or alias are dropped), and
  credential-less entries (a gemini entry with only a base URL) are accepted.

## Thinking pipeline (`translation/thinking/`)

Port of `internal/thinking`, keeping the "canonical `ThinkingConfig` → central validation → provider applier" shape.

- Entry point: `applyThinking(body, options)` collapses the five Go entry points (`ApplyThinking`,
  `…WithSummary`, `…WithSourceAndSummary`, `…WithModelInfo[AndSummary]`) via options: `sourceBody`, `summaryConfig`,
  `normalizedUpdatesChanged`, and `modelInfo` (resolved exact model; `null` = resolved but unknown) or
  `lookupModelInfo` (the registry lookup, `(modelId, providerKey) => info`). It returns `{ body, error? }`
  (`ThinkingError`, HTTP 400) and never throws.
- Bodies are parsed JSON mutated in place (`undefined` = Go's empty/invalid body). A `sourceBody` aliasing `body` is
  cloned first. Debug logging and plugin appliers are not ported. Applier errors (Kimi sjson failures) cannot occur
  on parsed JSON and are dropped.
- Model capabilities come from a minimal structural `ThinkingModelInfo`/`ModelThinkingSupport` (camelCase of
  `registry.ModelInfo`); the model registry slice supplies richer records and the lookup.
- Summary helpers (`extractSummaryConfig`, `applySummaryConfigForProvider`, `applyTranslatedSummaryToClaude`, …) are
  exported for the translator registry (Go calls them from `TranslateRequestEnvelope`).
- Fixtures: `go run ./tools/fixturegen/thinking` → `packages/translation/test/fixtures/thinking.json` (~2.7 MB; includes the Go
  static model catalog used by the lookup). Known Go quirk not mirrored: gjson reads _unparsable_ source JSON
  leniently in `extractCodexConfig`; the Workers port only handles parsed bodies.

## Credentials and selection (ControlPlane)

- **Per org**: each org's ControlPlane (`controlPlaneOf(env, org)`, see Runtime topology) holds that org's config,
  credentials, cooldowns, quota state, session affinity and OAuth logins; nothing below is shared between orgs. The
  Worker-side picker (`ControlPlanePickerLayer`) and refresher (`CredentialRefresher.controlPlane`) resolve the stub
  from `ModelsEnv` and `CurrentOrg` on every call, so the same credential name in two orgs is two credentials with
  separate cooldowns, and its `auth_index` differs between them (`orgAuthIndexer`).
- **Sources** (`models/credentials/`): auth JSON files imported through `importAuthFile`/`upsertCredential` (stored verbatim, sealed
  with the org's data key (_Stored secrets_ above), in the DO's SQLite `credentials` table; the file _is_ the metadata) and provider keys synthesised from `api-keys` config with
  the Go content-hash ids (`synthesize.ts`, verified against the Go synthesizer via `tools/fixturegen/credentials`).
  `derive.ts` turns a stored file into the immutable `Credential` (priority, weight, prefix, headers, exclusions,
  aliases, plan/domain attributes); global exclusions and aliases are applied at selection time, so config edits take
  effect immediately. Config credentials are never stored; their runtime state is pruned when their id disappears.
- **Selection** (`selection/`, pure and deterministic, clock injected): candidate set -> availability (`availability.ts`,
  incl. "never an expired OAuth token") -> highest priority tier -> strategy (`strategies.ts`: round-robin, smooth
  weighted round-robin, fill-first) -> optional session affinity (`affinity.ts`, TTL cache keyed
  `callerScope::providers::session::model`). Model prefixes, `force-model-prefix`, exclusions, OAuth/API-key aliases,
  `force-mapping` and alias pools are resolved per credential in `routing.ts`. The caller still resolves the provider set
  (`PickRequest.providers`) from the model registry; the DO enforces the per-credential rules.
- **Grants** (ADR 0023, _Grants_ below): `pick` takes the caller's `Reach` (`CredentialPool` option `reach(member)`,
  computed from the org's grants and the member's teams) and `selection/grants.ts` `grantedRoute` runs **before** the
  availability check, the priority tiers and the strategy. For a shared credential it resolves the requested model as
  `routing.ts` does (prefix, alias, alias pool) and keeps only the upstream models the reach permits, so a pool tries
  its granted members and an alias to an ungranted model is refused. A credential left with no granted route is not a
  candidate; session affinity and the content-based sessions search the candidates that remain, so a session bound to a
  credential whose grant was removed moves to another one (the pick binds the session to the credential it chose).
  A private credential is never filtered (grants do not apply; the owner rule of ADR 0023 decides). When grants alone left
  nothing for a model some credential would serve, the failure is `model_not_found` (`400`, the body of `unknownModelBody`, the
  one the pipeline answers for a model no credential serves), not `auth_not_found`: an unreachable model answers like an
  unknown one and does not say a grant exists. A prefix (`work/gpt-5`) pins its credential only when that credential is
  granted. A request without a member (a service token, the orchestrator's traffic in `global`) has the reach of the
  grants for everyone only. The failure body names the model the client sent, thinking suffix included, exactly like
  `resolveModel`'s. A Gemini Interactions **agent** request has no upstream model to match: it selects with
  `gemini-2.5-flash` (`INTERACTIONS_AGENT_AUTH_SELECTION_MODEL`), so a grant for that model covers every agent.
- **RPC**: `pick(request)` returns `{ ok: true, credential, route, lease }` (credential snapshot including token
  metadata, resolved base URL/headers, and the requested -> upstream model mapping) or `{ ok: false, failure }`
  (`model_cooldown` 429 + body, `auth_unavailable` 503, `auth_not_found`, `provider_not_found`). `report(lease, result)`
  runs the cooldown/quota state machine (below); `planRetry(query)` answers whether another retry round is worth starting
  and how long to wait.
  Management methods: `listCredentials` (redacted), `upsertCredential` (re-login merge, credentials.md §11),
  `importAuthFile`, `removeCredential`, `setCredentialDisabled`.
- **Results, cooldowns and quota** (`credentials/cooldown/`, port of `conductor_cooldown.go` `MarkResult`): `markResult`
  is a pure function over `CredentialState` with an injected clock. Per-(credential, model) cooldowns: 401/402/403 30 min,
  404 and model-support errors 12 h (or `Retry-After`), 429 `Retry-After` (>= 10 s) or the 1 s·2^n ladder (once per open
  window), 408/5xx 60 s (`transient-error-cooldown-seconds`), Cloudflare challenge ladder, invalid_grant 30 min;
  credential-scoped 429s (`ReportResult.credentialScoped`: Anthropic 5h/7d windows, Codex `usage_limit_reached`) block the
  whole credential (`credential_quota`); cooldowns only ever extend; request-scoped, connection-lifecycle and
  transient-transport failures never cool (`classify.ts`, shared with the Worker). `disable-cooling` precedence: credential
  metadata, then `routing.cooldown.disable-cooling`. Also kept per credential: counters, a 20x10 min recent-requests ring
  and the passive quota header snapshot (claude/codex/devin). Alias pools report each attempt under its upstream model
  (`ReportResult.model`, `route.pooled`) and `pick` drops cooling upstream models (a credential without any usable one is
  skipped). Persistence: counters, the last error and the cooldown fields (credential and per-model) are always saved,
  as plain `credential_state` rows instead of the Go `.cds` files; `routing.cooldown.save-cooldown-status` has no effect.
- **Retry planning** (`selection/retry.ts`, `retryAllowed` + `closestCooldownWait`): per-credential `request_retry`,
  `max-retry-interval`, the 10 s floor for an already-attempted 429 credential. `PickRequest.retryRound`/`requestRetry`
  make credentials with an exhausted budget age out of later rounds. Alias pools count as available when any upstream model
  is (Go only discovers a cooling pool when it filters the execution models). When the wait exceeds the limit the plan
  carries the recovery time so the Worker can answer with `Retry-After`.
- **Shared and private credentials** (`credentials/ownership.ts`, `credentials/private-keys.ts`; Workers addition, ADR 0023,
  ADR 0025, no Go counterpart): a credential belongs to the org (a _shared credential_, `owner` unset) or to one member (a
  _private credential_, `owner` the member's id). A stored account carries `owner` (nullable `credentials.owner`, also on
  `oauth_sessions.owner` so a login finished later stays the member's); every credential that existed before is shared. A
  private provider key group is one sealed row of its own in `private_key_groups` (value sealed with the org data key,
  `private_key_changes` is its change counter) and never enters the org's config entries, so the config, its snapshot and
  every export stay what an org admin may see; `CredentialPool` derives the private groups of every owner and stamps their
  credentials with the owner. `membership.private_credentials` is the org setting "members may connect private
  credentials": on for `global` (the upgrade sets it), off for a new org unless `POST /orgs` chose it; off, `CredentialPool`
  derives every private credential as disabled (kept, not deleted) until it is on again.
  - **Who a call runs for** (fail closed): every `ControlPlane` method that filters by ownership takes a required `Scope`
    (`viewer`): the caller's `Viewer`, or `FULL_ACCESS` for the system (cron sweeps, the registry's model sources, the
    public OAuth callback, migrations). There is no default, so a member-scoped route cannot forget it: leaving it out is a
    type error, which `packages/models/test/credentials-scope.test.ts` pins with `@ts-expect-error` per method next to a runtime test of
    what each viewer reaches.
  - **Selection**: `PickRequest.memberId` (the caller's member id, also in the retry query) enters `pick` and `planRetry`;
    a private credential is a candidate only when `credential.owner === memberId` (`servesMember`), so a request of another
    member, of an org admin or of a service token never reaches it. For its owner it competes with the shared credentials
    in the same tiers and strategies.
  - **Management** (`Viewer` = member id + whether an org admin, `auth/viewer.ts`, handed by every credential route to the ControlPlane;
    `accessTo` answers `full`, `limited` or `none`): the owner reads and changes everything of their private credential.
    An org admin gets `limited`: `GET /credentials` lists it in `others` (`LimitedCredentialEntry`: provider, label, owner,
    `disabled`; no file fields, quota, models or state) and `PATCH /credentials/status` (disable, enable) and `DELETE`
    work, nothing else; anybody else, and an org admin for any other operation, gets `404`. `GET /provider-keys` likewise lists
    other members' private groups in `others` (`LimitedKeyGroup`: family, label, owner); an org admin can only remove one
    (`DELETE /provider-keys/groups` with `private`) from the Keys page, since a private group is not in the config they edit; a
    private key listed among the accounts (OpenCode Go) can also be disabled and enabled there (`PrivateKeyStore.setKeyExcludedAll`,
    the `*` exclusion, like a shared key). A shared credential
    stays admin-only. A plain member reaches only their own private credentials through the same routes (`/credentials*`,
    `/oauth/*`, `/provider-keys*`: Models' role-table entries, `models/management/access-rules.ts`); what they upload, log in or add is private
    whatever they send, an org admin's is shared unless `?private=true` (`private: true` for a key group) asks otherwise.
    Where the org setting is off creating one answers `403` (`forbidden` for an account, `private_credentials_unavailable`
    for a key group). The download is the owner's alone (`403 private_credential` for an org admin, a service-token owner
    included); an owner downloads their own with their session, a shared credential keeps ADR 0006.
  - **Usage and registry**: usage records carry `private` (`migrations/usage/0006_usage_private.sql`), set by the client API handlers
    from the credential that served the request; every org-wide read, export and the export queue leave private records
    out, and a member's reads add their own (`UsageFilter.privateOf`), see _Usage accounting and observability_. The model
    registry lists a private credential's models to its owner only (`RegistrySnapshot.visibleTo(member)` for `/v1/models`,
    `/v1beta/models`, the spawn-agent list and the routing view); routing itself resolves through the full snapshot, since
    the picker is what keeps private credentials from other callers.
- Deviations from Go: several providers are selected from one ID-sorted union (no per-provider slot cursor); alias groups
  of the session cache are independent keys (the LCP matcher is ported, see Sessions below). `PickRequest.session` carries the
  explicit id extracted by `handlers/session.ts`; `lcp` and `fallbackSession` carry the content-based identities.
  Cooldowns are always persisted (Go only with `save-cooldown-status`, for its restarts): workerd evicts an idle ControlPlane
  after seconds, which is not a restart, and a Worker cannot tell an eviction from a deploy. Without this a cooling model
  (for example an OpenCode "Model access is disabled" answer) was picked again after the first idle gap.

## Request pipeline

Core contracts every provider slice implements (Go references in each module header):

- **Translators (`translation/translator/`)**: `TranslatorRegistry` keyed by `(client format, provider format)` with named
  `client`/`provider` arguments (Go's inverted `TranslateStream(from=provider, to=client)` order does not leak).
  Request transforms are pure functions over a private copy of the parsed body (refusals throw `TranslationError`,
  a request-scoped 400); response transforms take raw text (one upstream SSE line, or the whole body) and return
  complete client chunks as text (bare JSON for OpenAI/Gemini, `event:`/`data:` framed for Claude/Responses/
  Interactions). Per-attempt state is `TranslationState` (Go `param *any`), incl. `toolInputError` and
  `canFinalize`. Go fallbacks are kept (force `model`; passthrough stream/non-stream; raw usage for token counts).
  The thinking summary hooks are injected (`SummaryHooks`). Pairs are registered in `translator/builtin.ts`;
  golden fixtures come from `go run ./tools/fixturegen/translator` (corpus files under
  `tools/fixturegen/translator/corpus/`, one fixture file per corpus file under translation's `test/fixtures/translator/`,
  picked up automatically by its `test/translator-fixtures.test.ts`; the cases with an executor context, which need the
  Worker's executor-level rewrites, go to `packages/models/test/fixtures/translator-executor.json`; cases may declare `needs` to
  be skipped until a capability lands).
- **Executors (`models/executor/`)**: `ProviderExecutor { execute, executeStream, countTokens }` over
  `ExecutorRequest`/`ExecutorOptions` (Go `Request`/`Options`, typed `ExecutionMetadata`) and an `ExecutionContext`
  (credential snapshot, config snapshot, `UsageReporter`). Streams are `Stream<string, ExecutionError>` of client
  chunks. All failures are `ExecutionError` (status, upstream body as message, `retryAfterMs`, `credentialScoped`,
  `requestScoped`, `terminalAuth`, `direct`, `code`). Order inside executors: translate -> `Thinking.apply` -> provider shaping -> `applyPayloadRules` (last) -> `HttpClient` (tracing
  propagation disabled so no `traceparent` reaches providers). Shared helpers live in `executor/helps/`.
- **Credential selection**: `CredentialPicker { pick, report, planRetry }` (`executor/picker.ts`, contract documented
  there). The default implementation (`control-plane-picker.ts`) is a thin adapter over the ControlPlane RPC; it maps the
  DO snapshot to the executor view (`kind`, `header:<Name>` attributes, `base_url`) and turns pick failures into
  `ExecutionError`s (`model_cooldown` keeps its JSON body and `Retry-After`). `static-picker.ts` is a config-only stand-in
  for tests (`makePipeline` uses it; `packages/models/test/support/pool.ts` runs the real `CredentialPool` in-process with an injected
  clock). The route returned by `pick` (`PickedRoute`: upstream model pool, `originalAlias`, `forceMapping`, `pooled`) is
  computed in the DO; `executor/models.ts` is only used by the static picker.
- **Handlers (`models/handlers/`)**: `execute.ts` runs resolve (`ModelProviders` service: the model registry;
  `ModelProviders.configLayer` serves tests without one) -> pick -> executor -> report -> usage (one record per attempt via `UsageSink`, published when the
  stream ends). `respond.ts` peeks the first stream chunk inside the request scope (the web handler keeps the scope
  open for streamed bodies) so pre-stream failures become real HTTP errors, then frames with a per-protocol
  `StreamFramer` (`framing.ts`), with optional keep-alives. Error bodies per protocol are in `models/http/errors.ts`. Non-stream answers of Claude, OpenAI chat/completions,
  Gemini/Interactions, images and OpenAI-shaped video retrieval go through `withNonStreamKeepAlive` (`requests.nonstream-keepalive-interval`):
  nothing is committed before the first interval, so a timely answer keeps its real status; afterwards a blank line is written per interval and
  the final body (errors included) follows under a committed `200 application/json`, like Go. Video content downloads and `/v1/responses` are
  not wrapped (Go does not either).
  Route layers close over the services (`handlers/layer.ts`, `makeClientApiRoutes` for tests) and are Access-gated.
  Deviation: `POST /chat/completions`, `/completions`, `/responses`, `/responses/compact` and the `GET /responses`
  WebSocket are unprefixed aliases of the `/v1` routes (Go serves only `/v1`). A client whose Anthropic models append
  `/v1/messages` and whose OpenAI models append `/chat/completions` to the same base URL (pi's `opencode-go` catalog)
  then needs a single base URL. The aliases are in `CLIENT_API_PREFIXES` (`core/http/client-api.ts`). `GET /models` is not
  aliased, because it is a control panel page.
  Request bodies (`handlers/request.ts`, `models/http/body.ts`) decode `Content-Encoding: zstd` with a 32 MiB cap on the
  decoded size (`models/http/zstd.ts`: frame windows/content sizes are checked before fzstd allocates, the streaming decoder stops past the
  cap); a larger body answers 413 (deviation: Go reads it unbounded).
- **Conductor** (`handlers/conductor.ts`, port of `conductor_execution.go`/`conductor_stream.go`): `conduct(prepared, run)`
  runs retry rounds. A round picks credentials one after another (`excludedIds` grows, no sleeping) until one succeeds, a
  stop condition hits (request-scoped rule `stop*`, request faults 409/413 and the listed body codes,
  `responses/compact` faults, Commissary's own request-scoped errors) or nothing is selectable; the final error is the
  last one that reached an upstream. An upstream 400/422 is treated differently from Go (ADR 0019, issue #185): Go stops
  the request there, Commissary fails over to another provider, because providers shape requests differently
  (cloaking, betas, translation, gateways) and such an error may be specific to the provider that answered. Request-scoped
  rules are matched first; without a rule action the credential takes no cooldown, its provider (an OpenAI-compatible
  endpoint is its own provider) and the rest of its alias pool are excluded for the rest of the request, across retry
  rounds (`provider-failover.ts`: its remaining providers are what `pick` and `planRetry` are given), and selection picks
  the next attempt as usual. When no attempt succeeds the client gets that first 400/422, not a later error; a request
  with no other provider left fails at once. Between rounds the Worker asks `planRetry` (only for 403/408/429/500/502/503/504 and transient transport errors) and sleeps
  `wait + jitter` (Effect clock, so tests use `TestClock`). `max-retry-credentials` caps a round, per-credential
  `request-retry` ages credentials out of later rounds, request-scoped rules (`continue`, `continue-and-cooldown`, `stop`,
  `stop-and-cooldown`) come from credential metadata or `oauth.request-scoped-errors`. Every attempt is reported exactly
  once (`Attempt.finish`: picker report + one usage record), including client aborts (`connection_lifecycle`, no cooldown).
  Each attempt holds the invocation open with `ctx.waitUntil` from its start until `finish` completed (`holdInvocation`,
  `core/execution-context.ts`; released by the request scope if `finish` never started), because a cancelled streamed body is finalised
  after the response and workerd drops pending work of a disconnected client otherwise. Route layers capture their services
  with `routeServices()` (`core/http/route-services.ts`), which drops the layer's `Scope`: providing `Effect.context()` of a layer to
  a handler replaced the request scope with the isolate-lifetime layer scope, so streamed attempts were never finalised on a
  client disconnect.
  Workers limits (deviation): at most 16 upstream attempts per request and cooldown waits capped at 30 s; a longer recovery
  returns the last error (429/503) with `Retry-After`.
  Streams are only "successful" after the first payload chunk (bootstrap read inside the request scope); earlier errors, an
  immediate close (`empty_stream`) or an HTTP error fail over; later errors reach the client and are reported when the
  stream ends. `requests.streaming.bootstrap-retries` repeats the whole execution for bootstrap failures. Force-mapped
  aliases rewrite the `model` fields of responses and chunks (`handlers/model-rewrite.ts`).
  Credential preparation and the 401 loop wrap every attempt (`executor/helps/credential-refresh.ts`, port of
  `prepareRequestAuth` + `tryRefreshAfterUnauthorized`): `ensureFresh` first when the snapshot cannot be used as is (Vertex
  without a minted token, Meta without a key, OAuth token missing/expired, Antigravity within 5 min), and after a 401
  `refreshNow(id, rejectedToken)` plus one repeat with the new token (a rejected attempt keeps its own failed usage record;
  results are reported against the refreshed `credentialVersion`; a token that did not change is not repeated, a terminal
  refresh failure marks the 401 `terminalAuth`). Executors with their own transport paths (WebSocket) can call
  `withCredentialRefresh(context, use)` directly; `CredentialRefresher.none` disables it for API-key-only tests.
- **Models and thinking**: `ModelProviders.registryLayer` resolves providers from the `ModelRegistry` snapshot
  (`providersForModel`, `firstAvailableModel`); `ModelProviders.configLayer` remains for tests without a registry.
  `Thinking.live` (`executor/thinking.ts`) wires `applyThinking`, the translated summary-intent rules of `helps/thinking.go`
  and the registry summary hooks; `Thinking.noop` stays for tests. The conductor resolves the capabilities of each attempt
  through `ModelCapabilities.registryLayer` (the credential's own registration first - prefix/alias/config `models` aware -
  then `snapshot.lookupModelInfo`) and hands them to the executor as `ExecutorRequest.modelInfo` plus
  `modelLookup = snapshot.lookupModelInfo`, which executors pass to `Thinking.apply`.
- **Sessions**: `handlers/session.ts` ports `session.ExtractSessionInfo` (headers, Claude `metadata.user_id`, body fields)
  and feeds `PickRequest.session` together with the Access `callerScope`. Requests without an explicit marker are bound by
  content (`models/session-routing/`, `routing.ts` = `prepareSessionRouting`, only when `routing.session-affinity` is on):
  - **LCP conversation matcher** (`canonical.ts`, `matcher.ts`; Go `session/lcp.go`, `auth/selector.go pickLCP/OnResult`):
    the request is reduced to canonical turns (five protocols, thinking tags/CRLF/timestamps/UUIDs of system text masked,
    tool parts sorted, >16 KiB values sampled) and a SHA-256 fingerprint per turn. The `MerklePrefixMatcher` (bounded: 1024
    turns, 4096 groups, 262144 prefixes, TTL = `session-affinity-ttl`) lives next to the affinity cache in the ControlPlane
    pool: `pick` matches the longest known prefix (fork = divergence, compaction = shared tail after history reduction), binds
    new sequences to the picked credential and returns the LCP identity (`PickResult.session`, used for usage records);
    `report` touches the sequence on success or drops exactly that sequence on a credential-attributed failure (the lease
    carries the sequence and the access generation, so a late failure cannot evict a refreshed binding). Namespace
    `lcp:v1::<provider|mixed>::<model>::<callerScope>`; credential changes call `invalidateAuth`.
  - **Derived identity** (`identity.ts`; Go `session.DeriveID`/`hasExplicitSession`): `derived:ctx:v1:<sha256>` over the
    leading instructions and the first user input (only when no explicit marker exists); used when the LCP matcher does not
    apply (no non-system turn) and recorded in usage even with affinity off. Last fallback: the FNV message hash of the first
    system/user/assistant messages (`msg:<hex>`, short hash as parent).
  - The derived id also reaches executors as `ExecutionMetadata.derivedSessionId` (`ctx:v1:...`, absent with an explicit marker): OpenAI-compatible prompt-cache keys and Antigravity's `derivedAntigravitySessionId` hash it like Go's `DerivedSessionUUID`.
  - Deviations: the Go JSON `Raw` text is replaced by the compact re-serialisation of the parsed body (sampling of >16 KiB JSON
    parts and `original_size` are measured on it), a sparse sample cut inside a multi-byte character decodes to U+FFFD, and
    execution-session (WebSocket) metadata ids are not consulted. Go parity is tested with `tools/fixturegen/session`
    (`packages/models/test/fixtures/session.json`: turns, fingerprints, derive ids, matcher scenarios).

## Codex provider and Responses API (`models/executor/codex/`, `translation/translator/codex/`, `models/handlers/responses/`)

- **Translators** (`translator/codex/<pkg>/{request,response}.ts`, registered by `codex/register.ts`): faithful ports of
  `internal/translator/codex/*` for `openai`, `openai-response`, `claude`, `gemini` and `interactions` -> `codex`. Shared
  helpers are under `translator/common/` (SSE frame builders, `UserTurnDrops`, apply_patch bridge, Responses tool winners,
  Claude message helpers; the signature checks are `translation/signature/`). `TranslationError` may carry the translated `body` (Go returns both
  for unsupported-part refusals). Golden fixtures: `corpus/codex-*.json`; **generate them with `TZ=UTC`** (Gemini timestamps
  use the process time zone in Go). The Interactions `interaction.completed` event embeds the current time, so it is
  covered by a fake-timer unit test instead of a fixture. Request `tool_use.input` text is re-serialised compactly (Go
  forwards the raw bytes), hence the corpus files are excluded from the formatter (`.oxfmtrc.jsonc`).
- **Executor** (`executor/codex/executor.ts`): per attempt `translate -> Thinking.apply -> model/stream fields ->
  instructions -> image_generation tool -> reasoning sanitising -> parallel_tool_calls -> tool schema normalisation ->
  reasoning replay -> prompt cache key + Session-Id -> input id sanitising -> finalizePayload (last) -> headers (routing
  hint reads the final body) -> fetch`. Streams are processed line by line (`stream.ts`); non-stream aggregates the SSE
  until the terminal event; compaction posts to `/responses/compact` as `openai-response`. Errors (`errors.ts`) follow
  `codex_executor_terminal.go`: usage-limit/capacity -> 429 (credential-scoped unless `model-level-cooling`), body
  rewrites (`context_too_large`, `thinking_signature_invalid`, `previous_response_not_found`, `auth_unavailable`),
  in-stream `error`/`response.failed` mapping, empty `response.incomplete` -> request-scoped 502, missing terminal ->
  request-scoped 408. 401 refresh/retry is done by the conductor (`withCredentialRefresh`), not by the executor.
- **Reasoning replay** (`replay.ts`): Claude-format callers get cached encrypted reasoning/tool calls re-inserted by
  anchor matching. The store is an interface; the default keeps one entry per model in the `SessionState` DO of the session
  (TTL 1 h, appends are compare-and-swap read-modify-writes, session keys are isolated per caller scope), with a per-isolate
  memory fallback when the binding is absent and `makeInMemoryReplayStore` for tests.
- **Handlers**: `POST /v1/responses`, `/v1/responses/compact` and `/backend-api/codex/{responses,responses/compact}` share
  `responses/routes.ts`; the Responses frame assembler (`responses/framer.ts`) buffers partial frames, filters private
  `responsesapi.*`/`codex.*` events (Codex clients keep `codex.response.metadata`), rebuilds an empty
  `response.output`, normalises error payloads (redacting secrets) and ends with a bare newline. `/v1/images/{generations,
  edits}` (`handlers/openai/images.ts`) serve the Codex `gpt-image-*` models (multipart edits become JSON in the handler;
  free-plan credentials are excluded through `ExecutionInput.disallowFreeAuth`). `/v1/alpha/search` and
  `/backend-api/codex/alpha/search` (`handlers/codex/alpha-search.ts`) forward the sanitised body to
  `.../alpha/search`, selecting only OAuth credentials or provider keys with `alpha-search` (`executor/policy-picker.ts`).
- **Multi-agent v2, orphan delegation, `is-compat`** (slice #26, see "Codex client rewriting and compat variants"): the executor
  optimises collaboration tools/namespace (`optimizeCodexMultiAgentV2RequestForAuth`, restored in stream, non-stream and WebSocket
  events) and compat models use the `claude -> codex` compat transform.
- **Stream bootstrap buffering** (`upstream.codex.stream-bootstrap-buffering` / `-timeout`, `bootstrap.ts` + `stream.ts`/`websocket.ts`): frames that
  carry nothing observable (handshake preamble, keepalives, empty `*.added` frames; a closed allow-list like Go's
  `isCodexBootstrapBufferableEvent`) are held until the first real event, within 48 upstream lines (WebSocket: messages read), 1 MiB and the
  optional timeout (Go duration or whole seconds, `0`/`none`/... = unlimited; the clock is the Effect clock on the WebSocket path, the reader's
  injected `nowMs` on SSE). An overload/rate-limit/capacity rejection inside the HTTP 200 stream (or any upstream `error` frame on the WebSocket)
  fails the attempt with a 503 before anything reaches the client, so the conductor fails over to the next credential; other terminal
  failures flush the held handshake and are delivered in-stream; a clean EOF while holding fails the attempt without releasing. `grok-pager` /
  `grok-shell` clients get `keepalive` events as `: keepalive` SSE comments (`TransformKeepaliveSSELine`).

- **models.json header overrides** (`helps/model-headers.ts`): `config.override_header` of the executed model is read from the attempt's
  registry snapshot (`ExecutorRequest.modelLookup(model, "")`, `ThinkingModelInfo.config.overrideHeader`) and forced onto every
  upstream request (HTTP, images, WebSocket handshake) like `applyModelHeaderOverrides`; the `modelHeaderOverrides` executor option
  still wins in tests.
- **`is-compat` fallback** (`codex/compat.ts`, Go `resolveCodexModelIsCompat`): the resolved model info decides; without one the
  credential's `api-keys.codex` entry (index, then key + base URL) is authoritative for its `models` list, then the generic
  API-key lookup.
- **Image tool usage** (`publishCodexImageToolUsage`): `response.tool_usage.image_gen` tokens become an extra usage record under the
  `image_generation` tool model (`UsageReporter.publishAdditionalModel`; the conductor publishes the extra records after the main one).

- **WebSocket**: `executor/codex/websocket.ts` is the upstream transport (Go `CodexWebsocketsExecutor`), dispatched from
  `executeStream` like Go's `CodexAutoExecutor`; see "Responses WebSocket transports".
- **Response steering / full duplex** (`upstream.codex.response-steering`, `codex/duplex.ts`, Go `streamCodexDuplex`): with the flag on, a
  downstream socket on a Codex credential with `websockets` hands its single client-frame reader to the executor
  (`WebsocketExecution.duplex`, set by `handlers/responses/websocket/socket.ts`). The executor owns the upstream socket until the
  client goes away: a writer fiber queues explicit creates (max 16) while steering is unacknowledged, forwards `response.steer`
  (payload rules as `codex-websockets`, `type` re-forced) and answers malformed/unsupported frames with a local 400 `error` event;
  a reader fiber classifies per-response failures, keeps the per-response settings (replay scope, native output, collaboration-tool
  renaming, reasoning/instructions; 16 retained) that automatic successors and `response.append` inherit, and forwards
  `response.steer.*` events byte for byte. A failure before the first `response.created` fails the attempt (credential failover);
  later 401/403/429 events are delivered and then end the socket; ambiguous failures end it without cooling the credential
  (`duplexConnectionError` is request-scoped). The handler treats a duplex stream as the socket: error events after
  `response.created` are events, the stream ending closes the socket quietly, and the upstream-disconnect callback is left to the
  executor. Deviations: one usage record per attempt with the summed tokens of all responses (Go: a record per response);
  `authEnabled` defaults to true (a credential disabled mid-socket is not re-checked); other providers never run duplex.
- **Non-stream over WebSocket** (`makeCodexWebsocketExecute`, Go `CodexWebsocketsExecutor.Execute`): a non-stream execution carrying
  `metadata.websocket` on a `websockets` credential reads the upstream events until the first terminal one and answers with the
  translated completed response (same session/socket rules, replay-required for continuations without a live socket).
- **Not ported (follow-ups)**: the Responses-tool image path being reachable only for non-`gpt-image` models (ported but not routed).

## xAI provider and media endpoints (`models/executor/xai/`, `models/handlers/openai/{videos,speech,xai-*}.ts`)

Port of `xai_executor*.go` (HTTP/SSE; the Responses WebSocket executor is `executor/xai/websocket.ts`, see "Responses
WebSocket transports"). Reuses the Codex translators
(`* -> codex`, compaction `* -> openai-response`) and the Codex output helpers.

- **Base URLs and identity** (`credentials.ts`, `headers.ts`): `using_api` (attribute, metadata, `auth_kind`; OAuth defaults to
  `false`) selects the API (`https://api.x.ai/v1`) or the CLI chat proxy (`https://cli-chat-proxy.grok.com/v1`) for chat and
  media; `/responses/compact` and `/tts` always use the official API (the proxy 404s and a 404 would cool the pool).
  The CLI identity headers (`X-XAI-Token-Auth`, `x-grok-client-version`, `xai-grok-workspace/<ver>` UA, ...) are only sent for
  `POST /responses` against the proxy. The client version comes from KV `CACHE` key `xai/client-version` (fallback `1.0.46`),
  written by the cron task `xai-client-version-refresh` (npm `@xai-official/grok/latest`, strict `x.y.z` >= 1.0.13) and read through
  `Effect.serviceOption(ModelsEnv)` with a one-minute per-isolate cache, so executor signatures stay unchanged.
- **Responses shaping** (`executor.ts` `prepare`): translate -> `Thinking.apply` (target format `xai`) -> model/stream -> tool
  normalisation (`tools.ts`, `tool-choice.ts`: namespace flattening or folding into dispatcher functions above 200 tools,
  `custom` -> `function`, `$ref` inlining, schema simplification, `additional_tools` promotion, hosted-tool choices, orphaned
  `tool_choice`, `web_search` client alias, optional `x_search` injection) -> reasoning replay -> input normalisation
  (`input.ts`) -> `prompt_cache_key`/`x-grok-conv-id` -> `finalizePayload` (user payload rules, last). Response events
  (`response.ts`, `stream.ts`) get reasoning-text -> summary normalisation, namespace/alias restoration, hidden X Search trace
  filtering and a rebuilt `response.output`. Non-stream requests still stream upstream and aggregate; truncated streams answer 408.
- **Compaction**: `responses/compact` posts to the official API; a streaming request with a `compaction_trigger` input item is
  executed through compact and re-emitted as a synthetic Responses SSE stream (`compact.ts`).
- **Reasoning replay** (`replay.ts`): Claude/Responses callers get cached encrypted reasoning, assistant text and tool calls of the
  previous turn re-inserted (sliding TTL 1 h). Same pattern as Codex: a store interface over the `SessionState` DO (per-isolate
  memory fallback, `makeInMemoryXaiReplayStore` for tests); session keys are isolated per Access `callerScope` (no scope, no replay).
- **Errors** (`errors.ts`): 403 "bad credentials" -> 401 (conductor refresh + retry), 429 `free-usage-exhausted` -> 24 h cooldown
  hint (`retryAfterMs`), speech 404s that do not say the model is unavailable are request-scoped.
- **Media** (`media.ts` + handlers): executor entry protocols `openai-image`/`openai-video`/`openai-speech` (whole bodies returned
  verbatim; `ExecutorResponse.bytes` carries audio). `/v1/images/{generations,edits}` accept `grok-imagine-image*` (converted to
  the xAI shape and back; streams replay the result as `*.completed` frames like Go). `/v1/videos*` (xAI-native) and
  `/openai/v1/videos*` (OpenAI shape, `sora-2` maps to `grok-imagine-video`, content downloads proxied). Video results are only
  retrievable with the creating credential: the handler stores `{authId, routing model}` in KV (`xai/video-binding/<sha256(id)>`,
  TTL `multimedia.video-result-auth-cache-ttl`, default 3 h, KV minimum 60 s) and pins retrievals through `ExecutionInput.pinnedId`
  (`ExecutionOutput.credentialId` reports the serving credential). `/v1/audio/speech` and `/v1/tts` convert to `POST /tts`.
- **apply_patch bridge** (`helps/apply-patch-responses.ts`, `translator/common/apply-patch-responses.ts`; Go
  `NormalizeApplyPatchResponsesRequest` / `ApplyPatchResponsesBridge` / `ApplyPatchResponsesState`): the winning custom `apply_patch`
  declaration (also inside namespaces / `additional_tools`), its history items and tool choices become the strict `{"input": ...}`
  function before the xAI tool normalisation; every upstream event passes `rememberDispatcherEvent` (pre-restoration evidence), the
  namespace/alias/X Search pipeline and the state's `transform`, which restores `custom_tool_call` items and
  `response.custom_tool_call_input.*` events, expands folded dispatcher envelopes (`{"name": <child>, "arguments": ...}`, folded above 200
  tools) into the child call, validates identity (item id, call id, output index) and arguments, resequences `sequence_number` and
  fails the turn with one local `response.failed` frame plus a sanitised 502 (`Invalid apply_patch tool arguments received from
  upstream.`). EOF/`[DONE]` without a validated completion fails the same way. Non-stream, compact answers (bare response), SSE lines and the
  WebSocket path (failure frame, upstream socket invalidated, EOF drop with an open patch call) use the same state. Verified against the real
  Go state over 55 scripted scenarios (`go run ./tools/fixturegen/applypatch`, `packages/models/test/unit/apply-patch-responses.test.ts`). A non-string
  patch history input is a request-scoped 400 (Go returns a plain error).
- **Compaction over the xAI socket**: a `compaction_trigger` on a downstream WebSocket whose credential has `websockets` compacts the socket's
  recorded transcript over HTTP `/responses/compact` (`executeCompactionTriggerFromWebsocket`; without a transcript the request's own
  input, else `previous_response_id`; empty context = 400, a malformed compacted answer = 502), replaces the transcript by the compacted
  item, maps the new response id to "no upstream id" and re-emits the synthetic Responses stream. A frame that needs the upstream socket
  answers replay-required.
- **Multi-agent v2** input rewriting (`rewriteCodexMultiAgentV2Input`, after the stream/model fields are set) and orphan delegation
  (translation step) are shared with Codex.
- **Not ported (follow-ups)**: for xAI image requests, mask/`input_fidelity` style Codex-only options.

- **`ForAPIKey` scoping**: done for every provider by `withApiKeyScope` in the executor registry (xAI included, also on the WebSocket path:
  the socket runs through the conductor). Go's xAI settings live under the shared `upstream.xai`, which `ForAPIKey` keeps, so there is
  nothing xAI-specific to scope.

- **Multi-agent v2** input rewriting (`rewriteCodexMultiAgentV2Input`, after the stream/model fields are set) and orphan delegation
  (translation step) are shared with Codex. xAI image requests ignore `mask`/`input_fidelity` exactly like Go (the xAI edit body only
  carries prompt, images, `aspect_ratio`, `resolution`, `quality` and `n`). The Go Claude stream input-token estimate on the xAI
  WebSocket path cannot trigger here: downstream sockets only carry Responses-format requests (`NewClaudeInputTokenState` needs a
  Claude client), and the HTTP path gets it from `TranslatorRegistry.translateStream`.

## Responses WebSocket transports (`models/handlers/responses/websocket/`, `models/executor/websocket/`, `models/executor/{codex,xai}/websocket.ts`)

Port of `openai_responses_websocket*.go` (inbound `GET /v1/responses` and `GET /backend-api/codex/responses` with
`Upgrade: websocket`), `codex_websockets_*.go` and `xai_websockets_executor.go`. The Access gate authenticates the
upgrade request like any other (default-deny prefixes); the principal is captured for the socket's lifetime.

- **Where the socket lives (decision)**: in the Worker invocation that accepts it (`WebSocketPair` + `server.accept()`,
  `routes.ts`), **not** in a `SessionState` Durable Object. Per-socket state (previous request/response chaining, pending tool
  calls, pinned credential, upstream mode, tool-call repair caches) is plain memory of the socket's fiber and dies with the socket,
  like the goroutine-per-connection state in Go. A DO with the hibernation API would add nothing: the outbound upstream
  WebSocket and the running turn keep the object awake anyway and outbound sockets cannot hibernate; it would only add an RPC hop
  per frame. The cost is that an isolate restart (deploy) drops live sockets; clients reconnect and replay full input, which is
  also what happens when Go restarts. The `SessionState` object holds no socket state.
- **Loop** (`socket.ts`): one fiber per socket, started with `Effect.runForkWith(context)` from the upgrade handler (the services of the
  request are captured once; every turn runs in its own `Effect.scoped`). A second fiber is the only reader of the client socket so
  `response.interrupt` reaches the running upstream socket (or cancels a local HTTP turn) without waiting behind the response.
  Closing the client socket interrupts the fiber: the attempt is reported as a connection-lifecycle failure (no cooldown) and the
  upstream execution sessions are closed. Turns call `executeStream` (the normal conductor: pick, failover, usage, refresh) with
  `ExecutionInput.websocket = { sessionId, requireUpstream }`, `onSelected` (the credential of each attempt) and `pinnedId`;
  `preferWebsockets` makes `pick` prefer Codex credentials with `websockets`.
- **Per-frame planning** (`plan.ts`, `normalize.ts`; pure): `response.create` / `response.append` become executable bodies. Without
  an upstream socket the transcript is rebuilt locally (previous input + previous output + new input, compaction/replacement
  detection, call-id and item-id dedupe; `generate:false` warm-ups answered with synthetic `response.created`/`response.completed`
  `resp_prewarm_<uuid>`). After a turn that ran on a credential with `websockets` (Codex/xAI) the socket pins that credential and later
  frames pass through (`previous_response_id` kept, state upstream); a model change drops the pin. A continuation that needs the live
  upstream socket but cannot have it closes the client with 1012 "upstream requires HTTP replay" (the client replays full input).
  Terminal failures expose request-shape errors (and terminal auth) as a Responses `error` frame and close; credential/quota/transport
  failures close silently (1011) like Go; 1009 (message too big) and replay-required map to their own close codes.
- **Tool-call repair** (`tool-cache.ts`): orphaned `function_call(_output)` items of replayed input are re-attached from per-session
  caches (256 entries, per isolate, keyed by caller scope + the client's session key, released with the last socket).
- **Upstream transport** (`executor/websocket/`): `UpstreamWebSocketConnector` dials with `fetch` + `Upgrade: websocket` (30 s handshake
  timeout, `wss:` URLs are fetched as `https:`); tests substitute in-memory sockets through `makeClientApiRoutes({ websocketConnector })`.
  `UpstreamSessionStore` keeps one retained socket per execution session (= downstream socket id), serialises requests with a
  semaphore, reuses the socket while the target `(credential id, URL)` is unchanged, redials once when a send fails, applies the 5 minute
  idle read deadline (`Effect.timeout`, testable with `TestClock`), maps binary frames, close codes and drops to errors, and
  invalidates a socket whose turn ended before its terminal event. An idle socket that the upstream drops closes the downstream socket
  (Go `UpstreamDisconnectChan`). Requests without a session use an ephemeral socket closed after the turn. The Worker holds at most
  one upstream socket per client socket; it counts towards the 6 simultaneous outbound connections of the invocation.
- **Codex** (`codex/websocket.ts`): the HTTP `prepare` in websocket mode (`previous_response_id`, `generate`, `stream_options` kept;
  payload rules last) then framing only (`type: "response.create"`). Handshake headers follow `applyCodexWebsocketHeaders`
  (`OpenAI-Beta: responses_websockets=2026-02-06`, `session_id`/`Conversation_id`, turn-state/metadata passthrough, routing hint).
  Events are forwarded as bare JSON (Go skips response translation for downstream sockets): `response.done` -> `response.completed`,
  rebuilt `response.output`, usage detail objects, replay cache update, `error` frames and terminal failures classified like the SSE path
  (`websocket_connection_limit_reached` retries immediately on another credential).
- **xAI** (`xai/websocket.ts`, `websocket-ids.ts`): official API base URL only (the CLI chat proxy answers 405 to upgrades), frame =
  prepared body with `type: response.create`, no `stream`/`stream_options`/`background`, `store: true`, no `instructions` on
  continuations, payload rules on that body and `type` re-forced afterwards. Downstream response ids are mapped to upstream ids
  (`-xai-<seq>` suffix for repeats; `previous_response_id` dropped and the recorded transcript prepended when the upstream target
  changed). `generate:false` warm-ups end after `response.created` with a synthesised `response.completed`.
- **Fallback to HTTP**: credentials without `websockets` (or other providers) run each turn over the ordinary HTTP executors, with the
  transcript rebuilt locally; a downstream WebSocket never needs an upstream one.

Deviations from Go / not ported: no WebSocket ping keep-alives (`streaming.keepalive-seconds` is ignored: the Workers WebSocket API
cannot send ping frames); terminal failures close with 1011/1012/1009 instead of dropping the TCP connection; credential pinning only
covers WebSocket-capable credentials and the decision to pass through is based on the previously pinned credential instead of the global
credential list; no request-log timelines. Response steering / full duplex and non-stream execution over WebSocket are ported
(see the Codex section). The multi-agent v2 tool preparation and orphan delegation rewrite run on
each planned frame (`handlers/responses/codex-prepare.ts`), the executors do the rest. Upgrades whose `Origin` is not the Worker's own host are refused by the Access gate (Go: `CheckOrigin` always true; the
Access cookie makes cross-site WebSocket hijacking possible, see Authentication). CPU limits for
long-lived sockets follow the Workers platform rules (`limits.cpu_ms`).

## Model registry and `/models` endpoints (`models/registry/`)

Port of `internal/registry` plus the model registration in `sdk/cliproxy/service_models.go`. The Go registry is a mutable
process-wide singleton that the service keeps in sync with credentials; on Workers it is a pure function of three inputs,
evaluated per isolate and cached for 5 s (`ModelRegistry.snapshot`, `RegistrySnapshot`; `ModelRegistry.fresh` builds uncached):

- **Credentials**: `ControlPlane.listModelSources()` returns a `ModelSource` per credential (provider, executor key, prefix,
  plan tier, exclusions, per-account aliases, the `models:` of config entries, credential/model runtime state; no secrets).
- **Config**: `ConfigReader` (global `oauth.model-alias`, `oauth.settings`, `routing.force-model-prefix`,
  `upstream.claude.disable-cloaking-model-list`).
- **Catalogs** (ADR 0019, ADR 0020): every provider's models come from **models.dev** plus the **catalog additions**, not
  from the Go server's embedded JSON.
  - _Document_ (`models-dev.ts`): the models.dev `api.json` (≈5.4 MB) trimmed to the nine providers Commissary reads
    (`anthropic`, `google`, `google-vertex`, `xai`, `meta`, `kimi-code-plan-global`, `openai`, `opencode`, `opencode-go`)
    and to the fields it uses: no prices (only a `free` flag where the OpenCode gateways list a model at 0/0), no
    knowledge cut-off or other metadata. A document missing a provider or with a provider without models is invalid
    (the one-document rule: it feeds every provider, so it is all or nothing); a single malformed model is skipped and
    counted (the refresh reports and logs the number). `reasoning_options: null` (models.dev's way to say a model reasons
    without settings) is kept as an empty list.
  - _Additions_ (`catalog-additions.ts`, `catalog/additions.json`): what Commissary owns on top, versioned data that is
    never fetched: full records for models models.dev does not list (Antigravity and Devin entirely, models models.dev
    dropped), per-model `facts` models.dev lacks (thinking `dynamicAllowed`, web search, ...), per-provider `defaults`,
    `include`/`exclude` patterns and the Codex `plans` (which model ids each plan offers). Seeded once from the Go
    catalog. An addition only **fills gaps**: where models.dev has a value it wins (a wrong value is fixed at models.dev).
    Context length, output limit, modalities and the reasoning levels of a model models.dev lists follow models.dev, so
    some limits differ from Go's (Codex context windows grow to models.dev's figure; thinking levels come from
    `reasoning_options`, falling back to the additions' ranges). Thinking rules: a `budget_tokens` option gives a range
    but allows a budget of 0 (`zeroAllowed`) only with `min: 0` or a `toggle` option; an `effort` value `none` allows it
    too; a model that reasons with an empty or null `reasoning_options` has no thinking settings of its own (the
    additions' facts may still fill some, but no levels are invented); a model models.dev marks `reasoning: false` has no
    thinking at all, whatever the additions say (so `vertex/gemini-2.5-flash-image` no longer reports a budget). Every
    Codex plan id has a full record in the additions: it fills gaps and stands in if models.dev stops listing the id, so
    a refresh cannot empty a plan, and the provider `defaults` are not applied to plan models. Intended behaviour
    change: models.dev's `none` effort now reaches the Codex plan models (`gpt-5.5`, `gpt-6-*`, `gpt-5.6-*`), so
    `reasoning.effort: "none"` is forwarded upstream instead of being lowered to `low`. The Codex client catalog
    (`catalog/codex_client_models.json`) keeps its own format and stays bundled.
  - _Build_ (`catalog-build.ts`, `catalog.ts`): `buildModelsCatalog(document, additions)` makes the 13 sections (`claude`,
    `gemini`, `vertex`, `aistudio`, `codex-free|team|plus|pro`, `kimi`, `antigravity`, `xai`, `devin`, `meta`). A provider
    offers every current (not `deprecated`) text-output model models.dev lists for it, minus its `exclude`s, then the
    additions' own records. `aistudio` and `gemini` share `google`, `vertex` takes `google-vertex`, Codex plans take
    `openai`. Differences from Go: Devin is one aggregated section (a `devin/<id>` lookup resolves the whole section, Go's raw-section
    quirk is not repeated for `devin/` ids in `lookupModelInfo`), and Go's hard-coded Codex/xAI/Devin built-ins
    (`builtins.json`) are now additions.
  - _Bundled and stored copies_: `catalog/models-dev.json` is the trimmed snapshot shipped with the Worker (regenerated
    with `pnpm catalog:sync [url|file]`, `tools/sync-models-dev-catalog.ts`, idempotent). The same document is stored in KV
    `CACHE` (`registry/models-dev.json`) by the refresh; `CatalogStore` (`catalog-store.ts`) serves the KV copy per isolate,
    re-read at most once a minute, and falls back to the bundled one when KV is empty, unreadable or invalid. `models.catalog: embed` ignores the KV copy (the registry
    and the OpenCode executor read the bundled one at once, whatever KV still holds). The request path never fetches.
  - _Refresh_ (`refresh.ts`, `refreshModelsDev`): one operation for the cron task `model-catalog-refresh` (every 3 h like
    `ModelsRefreshInterval`) and the panel's on-demand refresh. It downloads the document (default
    `https://models.dev/api.json`, 30 s timeout, 16 MiB limit checked on `content-length` and while streaming), validates
    and trims it, stores it only when it changed (then drops the isolate cache) and records the attempt in KV
    (`registry/refresh-status.json`: time, outcome, reason, and the time the stored copy was last confirmed current). A failed,
    oversized or invalid download keeps the stored catalog. `models.catalog` chooses the source: empty = official,
    `embed` = delete the stored copy and serve the bundled snapshot, `disabled` = never refresh, otherwise one http(s)
    URL. `models.codex-catalog` and `models.devin-catalog` are accepted and no longer have an effect (listed under
    _Not applied_).
  - _One refresh at a time_: a download takes the **catalog refresh lease** in the Platform registry
    (`withPlatformLease`, `state/platform/refresh-lease.ts`, which the toolkit catalog's refresh uses too:
    `takeLease("catalog_refresh", …)` / `releaseLease(token)` of the general-purpose lease store `state/lease.ts`, as
    the quota sweep's, table `catalog_refresh_lease`, atomic on the object's clock, 2 min expiry, given back with its token; the refresh is bounded
    by its 30 s timeout so it is not renewed). The cron task and the panel therefore never download at once, in whichever
    isolates they run; the second gets `running` without a request being made. The invocation is held open with
    `waitUntil` until the lease is given back. A Platform registry that cannot be reached fails the refresh (exclusivity
    cannot be shown); `embed` and `disabled` need no lease.
- **Catalog status and on-demand refresh** (`models/management/catalog-routes.ts`, `@commissary/contract/catalog`; no Go counterpart):
  `GET /v9/management/models/catalog` answers `{mode, source_host?, source_problem?, stored, refreshed_at?, last_attempt?,
  models}`: the `models.catalog` mode (`official`, `embed`, `disabled`, `custom` with the host of the address, never the
  URL; an address that is not http(s) reads `disabled` with `source_problem` saying why), whether a refreshed copy from KV
  (`stored`) or the copy shipped with the Worker is in use (`embed` always reports the shipped copy: the stored one is not
  read), when the stored copy was last confirmed current, the latest attempt (`{at, status: updated|unchanged|failed,
  message?}`, the cron's or the panel's) and the model count per models.dev provider. `POST
  /v9/management/models/catalog/refresh` runs the cron task's operation now with the stored `models.catalog` setting and
  answers `200 {status: updated|unchanged|failed, message?, added?, removed?, skipped?, catalog}` (`added`/`removed`: models
  clients can call that appeared/disappeared, computed on the built catalogs per provider and counted once across Codex
  plans, so a deprecated or gateway-only change does not count; the removed ids are logged at warning level; `skipped`:
  malformed entries of the document that were left out; a failed download, size or validation problem is a `200` with
  `status: "failed"` and a fixed `message`, the stored catalog stays); `409 catalog_refresh_running` while another refresh
  (the scheduled one included) holds the lease, nothing is downloaded; `409 catalog_not_fetched` when `models.catalog` is
  `embed`, `disabled` or not an http(s) address. Admin only, CSRF rules as every write.
- **Assembly** (`credential-models.ts`): `registerModelsForAuth` per credential: base list (provider catalog, Codex plan
  tier, config `models:`), exclusions, OAuth aliases (`fork`, display names, per-credential first), `oauth.settings`
  context length, prefixes (`force-model-prefix`). OpenAI-compatibility models keep duplicate aliases (model pools) and skip
  exclusions/aliases like Go.
- **Grants in the registry** (ADR 0023, `grant-filter.ts`): the snapshot knows every model (routing and the pick enforce
  grants themselves); `RegistrySnapshot.visibleTo(memberId)` is the registry as one caller may use it. It builds a snapshot
  of its own from the same sources under the member's `Reach`: `assembleCredentialModels` drops the models of a shared
  credential that `grantsReach` says selection could not serve, asking `resolveModelRoute` (the same function the pick uses,
  over the `ModelSource`) whether any upstream model of the id is permitted on that credential. So an alias is listed when
  its upstream model is granted, a pool alias when any member of the pool is, and `prefix/model` when the model is granted on
  the credential behind the prefix. A private credential's models stay with its owner. Views are cached per snapshot and
  member; a snapshot is built from the grants version read with the sources (`ControlPlane.grantTable()`: grants, teams
  and a counter that moves with every grant write and team membership change), so the registry is cached per org, per
  member and per grants version, and the whole snapshot is one 5 s TTL stale at most. A registry that cannot read the grants
  is not built (the previous snapshot keeps serving, `fresh` answers 502); it is never built as if everyone had every model.
  With the default grant, or no restriction, `visibleTo` is the snapshot itself. The lists (`/v1/models`, `/v1beta/models`,
  the Claude and Codex lists, the spawn-agent list), `ModelProviders.providersFor` / `firstAvailableModel` (so a model the
  member cannot reach answers `400 model_not_found` like an unknown one, also for another member's private-only model, which
  used to answer `503`) and the routing view (`routingView(snapshot.visibleTo(member))`) all read the caller's view.
  `GET /v9/management/models/mine` answers the caller's own list (every role).
- **Index** (`registry.ts`): provider counts, per-provider records ("last registered wins", credentials registered in id
  order), the 5 min quota window and suspension rules of `modelRegistrationAvailability`, `GetModelProviders`,
  `GetModelInfo`, `LookupModelInfo` (registry, then static catalogs), `GetFirstAvailableModel`, native web-search capability.
  Records are camelCase `ModelInfo`s that satisfy `ThinkingModelInfo`; `snapshot.lookupModelInfo` is the `ModelInfoLookup`
  for `applyThinking`, `snapshot.providersForModel` is `util.GetProviderName` (the pipeline's `ModelProviders`).
- **Listings** (`listings.ts`, `models-api.ts`, `routes.ts`): `GET /v1/models[/{id}]` dispatches Grok shell UA -> `client_version`
  query -> Anthropic (`Anthropic-Version` or `claude-cli` UA, with ID cloaking `claude-fable-5-dd-<reversed id>`) -> OpenAI;
  detail routes pick the entry whose `id` equals the path remainder (ids may contain `/`). `GET /v1beta/models[/{model}]` is
  the Gemini shape. Bodies are plain `JSON.stringify` output (see _JSON output_ above); lists are sorted by model id
  (Go's order is map iteration order).
- **Routing view** (`routing-view.ts`, `GET /v9/management/routing/models`; no Go counterpart): the admin answer to "which
  credentials serve each model, and why not". `RegistrySnapshot` keeps the enriched `sources` and the `configVersion` it was
  built from; `ModelRegistry.fresh` drops the config reader's cache, builds now and stores the result in the 5 s cache (no
  stale fallback: failures answer 502), so an edit shows on the next read (other isolates follow within the config and
  snapshot TTLs). `routingView(snapshot, now)` assembles every credential twice (`assembleCredentialModels`: as registered,
  and enabled without exclusions); each model of the second list is a route (`auth_index`, `upstream` = `metadataModelId`,
  `via` catalog/config/alias, `prefix`). State: `disabled` (credential off), `excluded` (missing from the registered list;
  `reason` = first matching pattern, `rule_scope` channel/account/key), else read from the credential state like
  `projectModel` (`quota` / `cooling` with `until`, `unavailable`, `available`). `listed` and `providers` come from the
  index, so they equal `/v1/models`; a model whose only routes are cooling is unlisted but still shown. The body also carries
  `oauth.model-alias`, `oauth.excluded-models`, `force_model_prefix`, per-channel account counts, `config_version` and `revisions` (the revision of each
  channel's rules by channel, the `If-Match` value of rule edits, see _Config entries_ below). Contract: `@commissary/contract/routing`.
- Fixtures: `go run ./tools/fixturegen/registry` drives the real Go handlers (`OpenAIModels`, `ClaudeModels`,
  `GeminiModels`, `GeminiGetHandler`, `WriteModelListResponse` detail mode) against a real `registry.ModelRegistry` and records
  bodies and registry queries (`packages/models/test/fixtures/registry.json`).

Deviations from Go: models are registered under the credential's **executor key** (`kimi.com` -> `kimi`), which is what
`PickRequest.providers` is matched against; the quota window starts at the model state's observation time; Go's
`GetFirstAvailableModel` sorts with an inconsistent comparator for models without `created`, the port is deterministic
(newest, then id); credential/catalog edits show up within the 5 s snapshot TTL (1 min for KV catalogs). Not ported: plugin
models and Home.

**Codex client catalog** (`GET /v1/models[/{id}]?client_version=...`, `registry/codex-client-models.ts`, port of
`internal/client/codex/models`): every available model becomes an entry cloned from its template in `codex_client_models.json`
(or the `gpt-5.5` template with compact instructions), with reasoning levels (`max`/`ultra` only for clients >= 0.144.0 or
unparseable versions), modalities, priorities, Devin display names, `client.codex.optimize-multi-agent-v2` (`multi_agent_version`),
`client.codex.enable-apply-patch` (`apply_patch_tool_type: freeform` only when every provider of the exact public model has an
executor, `supportsApplyPatchProviders`) and `cpa_capabilities.web_search` for `client_version=cpa`. The body is plain `JSON.stringify` output.
Fixtures: the real Go `OpenAIModels` handler over the registry scenarios (`codexClient` section of `packages/models/test/fixtures/registry.json`:
per-entry and whole-body hashes of Go's sorted compact bytes, which the test reproduces itself before hashing).

## Token refresh (`models/credentials/refresh/`)

Port of `auto_refresh_loop.go` + `conductor_refresh.go` + the per-provider `Refresh` executors. The `RefreshManager`
(Cloudflare-free, unit tested with a fake host/alarm/clock) is owned by the `ControlPlane` DO, which is the only writer:

- **Scheduling** (`schedule.ts`): `nextRefreshCheckAt` is a pure function of (now, credential, state) with the Go leads
  (codex 24 h, claude 4 h, antigravity 30 min, xai/kimi/kimi-ai/kimi.ai 5 min; devin, meta, kimi.com, vertex never).
  One alarm is multiplexed over all credentials: `rearm()` takes the minimum over the stored credentials (no heap) and
  is called after every credential mutation, after each alarm run and by the cron `sweepRefresh()`. `alarm()` refreshes
  what is due (`oauth.auth-auto-refresh-workers`, default 16, concurrently) and always re-arms, never sooner than 30 s
  when a credential is still due (guards against spinning). A running refresh pushes that credential's next check 60 s.
- **Single writer / dedupe**: one in-flight refresh per credential; the alarm, concurrent 401 recoveries and management
  calls share its outcome. `refreshNow(id, rejectedAccessToken?)` first records the rejected token (only when the token
  has no expiry of its own, like Go), returns the current credential without an upstream call when the token was
  already replaced, and otherwise refreshes. `forceRefresh(id)` ignores the terminal-unauthorized gating.
- **Persistence** (`pool.commitRefresh`, synchronous SQLite): new metadata is merged three-way (`three-way.ts`, the
  `MergeRefreshedAuth` metadata rules; user edits made while the refresh ran win, token keys take the refreshed value)
  and written before any caller sees the token, then runtime state (`outcome.ts`: failure table of credentials.md §9.2,
  back-off 5 min / invalid_grant 1->30 min, terminal 401, 30 s ineffective-refresh guard, concurrent cooldowns kept).
  A refresh whose base tokens were replaced meanwhile (re-login) is discarded. `credentialVersion` bumps on rotation,
  so leases of the old tokens are ignored by `report`.
- **Protocols** (`claude|codex|antigravity|xai|kimi|meta.ts`): `(context) => Effect<updatedMetadata, RefreshError,
  HttpClient>` over the injectable Effect `HttpClient` (`FetchHttpClient.layer` in production, a recording client in
  tests). Each HTTP call is bounded to 30 s, a whole refresh to 120 s. Claude retries only HTTP >= 500 and blocks the
  credential for `Retry-After` on 429; Codex retries three times except `refresh_token_reused`.
- **Request-time preparation** (`ensureFresh(id)`): returns a snapshot with a usable `metadata.access_token`: Meta mints
  the provider key from the DCA token (persisted first), OAuth providers refresh when the token is missing/expired/rejected
  (Antigravity: within 5 min), **Vertex** mints a service-account token. `patchCredentialMetadata(id, patch)` persists
  preparation results (Antigravity `project_id`, Claude profile fields) without touching token material.
- **Vertex** (`vertex.ts`): no auth-file refresh. RS256 JWT-bearer grant with WebCrypto (PEM repaired like
  `keyutil.go`, PKCS#1 wrapped into PKCS#8, scope cloud-platform, 1 h lifetime). The token is cached in DO memory per
  credential (fingerprint = `credentialVersion:updatedAt`) until `exp - 60 s`, never persisted. Executors get it two ways:
  `pick` returns a snapshot whose `metadata.access_token`/`expired` are injected from the cache when still valid
  (`CredentialPool` `decorate` hook), and `ensureFresh` mints on a miss (concurrent callers share one mint). An executor
  therefore does: `if (!snapshot.metadata.access_token) snapshot = (await controlPlane.ensureFresh(id)).credential`.

Deviations from Go: credentials without a refresh token are never scheduled (Go loops every 30 s on an unchanged auth);
Codex keeps `email`/`plan_type` when the new `id_token` lacks them; a cached xAI `token_endpoint` must be an https x.ai
URL; Kimi/Claude device/uTLS headers are constants/subsets; Devin's metadata refresh (protobuf quota probe, never
scheduled) is not ported; `META_MINT_URL` is the Worker var of the same name (`RefreshContext.metaMintUrl`, also used by the Meta
login); Claude device-profile preparation is the executor's `stabilize-device-profile` store (below); Antigravity project discovery and the credits probe run in the Antigravity executor.

## Claude provider (`models/executor/claude/`, `translation/translator/claude/`)

Ported from `internal/runtime/executor/claude_executor*.go`, `internal/translator/claude/*` and the helpers they use.

- **Credentials**: OAuth access tokens (`metadata.access_token`) and provider keys (`api-keys.claude[]`, synthesised by
  `claude/config-credentials.ts`); base URL defaults to `https://api.anthropic.com`. OAuth credentials get the Claude
  Code treatment (cloaking); API-key credentials to first-party hosts keep caller-owned mode (caller betas verbatim,
  body `betas` appended). Custom `base-url` gateways skip upstream `count_tokens` and estimate locally.
- **Cloak mode and level** (`credentials.ts` `resolveWirePolicy`): the cloak mode says _when_ a request is cloaked
  (`auto`: accounts, and provider keys with a `cloak` entry or the `claude-code-cli` fingerprint profile; `always`;
  `never`), from `upstream.claude.disable-claude-cloak-mode`,
  the `cloak_mode` attribute and `api-keys.claude[].cloak.mode`. Confirmed Claude Code clients are never cloaked. The
  cloak level says _how much_: `full` (default) sends everything Claude Code sends; `minimal` only what a subscription
  checks. It comes from `upstream.claude.cloak-level`, then the `cloak_level` attribute, then
  `api-keys.claude[].cloak.level` (trimmed, case-insensitive, unknown = `full`), and never turns cloaking on: a key
  whose only cloak setting is a level stays uncloaked under `auto`. At `minimal` the caller's system prompt still leaves
  the top-level `system` (as under `full`) and `system` holds only the identity line `You are Claude Code, Anthropic's
  official CLI for Claude.`; `anthropic-beta` keeps `oauth-2025-04-20` and the feature betas but not
  `claude-code-20250219`. Not sent: the billing block (so no CCH), the date reminder and continuity tags, MCP tool
  aliases, sensitive-word obfuscation, `metadata.user_id`, `diagnostics`, the Opus 5.5 / Fable `fallbacks`,
  `thinking.display`, the probe/subagent cache-TTL stripping, the CLI user agent (the caller's goes through), the
  Stainless / `x-app` / `x-claude-code-session-id` / `x-client-request-id` headers. `strict-mode`, `sensitive-words` and
  `cache-user-id` are ignored. Translation, thinking, sanitising, cache control, context management and payload rules
  are the same at both levels. Live tests against a Max subscription (issue #58) found this the smallest shape the
  subscription accepts: a caller system prompt at the top level, or neither the identity line nor a billing block, is
  refused.
- **Who a subscription credential is for**: a Claude subscription (Pro/Max) credential is for the person who owns
  the subscription, sending their own requests. Don't share it with other people or route their traffic through it;
  connect it as that member's private credential (ADR 0023), and for anything shared use a Claude provider key (Max and
  Team plans include monthly API credits). Anthropic's Usage Policy (effective 2026-11-12) prohibits services that route requests
  through consumer subscriptions or misrepresent the client. Cloaking at either level misrepresents the client, so
  using it is at the deployment's own risk. The panel says the same next to the cloak settings and when a Claude account
  is connected.
- **Request order** (matches the Go executor and the payload-rules barrier): translate -> thinking -> sanitise ->
  cloaking (system relocation, billing block, identity, date reminder, user_id, context management) ->
  MCP tool aliasing -> cache-control policy -> payload rules -> CCH signing (`cch=` is `xxh64` over the normalised
  final body; only the five hex digits change) -> HTTP. Signing is the last step so it covers payload-rule output.
- **Responses**: Claude upstream always streams for non-stream clients; tool aliases are restored in non-stream bodies
  and stream lines; `ExecutionError` classification (`ratelimit.ts`) separates credential-scoped (unified-limit 429/401),
  request-scoped (Fast mode entitlement) and model-level failures for the picker.
- **Translators**: OpenAI chat, OpenAI Responses, Gemini and Interactions clients -> Claude, each with request and
  response (stream/non-stream/token-count) functions, golden-tested against Go through the translator corpus.
  `claude -> claude` has no translator (registry fallback forces `model`). Model capabilities (adaptive levels,
  max tokens) come from `translator/model-info.ts`, which the model registry slice populates.

Deviations from Go (all deliberate, documented in code headers):

- No uTLS/HTTP-2 fingerprinting (Workers limitation); `wire-policy` is dropped on import.
- **Cloak level** (`upstream.claude.cloak-level`, `cloak_level`, `cloak.level`) is a Commissary addition (ADR 0019): Go
  has only the cloak mode and always cloaks fully, which is the `full` level.
- **Device-profile stabiliser** (`device-profile.ts`, `upstream.claude.header-defaults.stabilize-device-profile`; Go
  `helps/claude_device_profile.go` local mode): confirmed Claude Code clients contribute their user agent / Stainless
  versions (only when they equal the configured baseline tuple; the platform is always pinned to the baseline), stored per
  credential and CLI entrypoint scope in the `SessionState` DO (sliding 7 d TTL, newer CLI version upgrades, compare-and-swap);
  unconfirmed clients get the baseline. The Home KV mode is not ported. Go parity: `tools/fixturegen/claudeprofile`.
- **`rebuild-mid-system-message`** (`mid-system.ts`): `role: "system"` messages are folded into `system` right after the
  thinking step (messages, count_tokens and the local estimator), enabled per `api-keys.claude` entry or the
  `rebuild_mid_system_message` credential attribute.
- **Thread continuation** (`thread.ts`): `thread.type = "continue"` requests without `tools` restore the MCP tool aliases saved
  for `message:<previous_message_id>` / `message:<new id>` (SessionState DO per caller scope, 1024 entries, 7 d TTL; Go: executor
  memory); an unknown previous message is the request-scoped 404 `not_found_error`.
- **Post-payload reconcilers** (`reconcile.ts`: Fable 5.1 / Opus 5.5 fallbacks, `thinking.display`, `# Reporting outcomes`
  block, system-turn placement) are ported and tested against the Go cases but, exactly like in Go, not called by the
  executors: payload rules are the final mutation, nothing may rewrite the body after them. `experimental-cch-signing` is
  accepted and ignored (Go keeps it for compatibility; signing is automatic).
- Kimi attribution stripping is in the pipeline (`stripAttributionSystem`); the continuity and thinking-replay stores live in the `SessionState` DO (see below): `begin` = one read (which
  slides the 1 h TTL) plus one write only when the prompt id or pinned date changed, `commit` = one compare-and-swap write using
  the generation carried in `ContinuityState` (`planContinuity` computes the arguments, the store is awaited before the
  synchronous `applyCloaking`).
- Signature handling is the full `internal/signature` port (`translation/signature/`, see "Signature validation"):
  `sanitizeClaudeMessagesForClaudeUpstream` runs before the Claude upstream request.
- OpenAI Responses -> Claude: the Codex `apply_patch` custom tool is a strict `{"input": ...}` function upstream and the
  response translator (`claude/openai/responses/response.ts`) decodes it into `custom_tool_call` events
  (`ApplyPatchCallState`, identity/snapshot validation, `response.failed` + 502 on malformed input). Go's log-only invariant
  diagnostics are omitted.
- **Responses compaction capsules** (`helps/compaction.ts`, `claude/compaction.ts`; Go `helps/antigravity_compaction.go`,
  `claude_executor_compaction.go`): `responses/compact` and streaming `compaction_trigger` run a non-stream summary turn (Responses payload
  -> summary prompt appended, `tools`/`stream`/... removed; Claude keeps the tool definitions for `tool_use` history and sets
  `tool_choice: none`, without definitions the tool blocks are flattened to text after the CCH step and before the payload rules) and seal
  the answer into `cpa-ag-compact-v1:` + base64url(`nonce(12) || AES-256-GCM(SHA-256("CLIProxyAPI"), {"summary","model","created_at"})`)
  with WebCrypto. The key is the fixed Go secret on purpose: capsules stay interchangeable with the Go server and between deployments (it
  is obfuscation, not a secret). Incoming `compaction` items are expanded into developer messages before translation; Claude drops
  foreign (non-CPA) items, an unreadable capsule is a request-scoped 400. Usage follows the Responses accounting (input = input + cache
  creation + cache read). Verified against the real Go executors (`go run ./tools/fixturegen/compaction`,
  `packages/models/test/compaction-fixtures.test.ts`: upstream request bodies, outputs, unsealed summaries, deterministic sealing with a fixed nonce; capsules sealed by Go open, plaintext compared structurally).
  The Claude and Antigravity executors also add the `output_tokens_details`/`input_tokens_details` of Responses answers
  (`EnsureResponsesUsageDetails`) that were missing on their non-stream/stream paths.
- `responses/compact` stays 501 where Go answers 501: Gemini/Vertex (`gemini_executor.go`, `gemini_vertex_executor.go`), Meta and Kimi.
  The OpenAI-compatibility executor posts the Responses-format request to `{base-url}/responses/compact` (no chat shaping, `stream`
  removed, reasoning cleartext cleared).

## Gemini, Vertex and Interactions (`models/executor/gemini/`, `translation/translator/gemini/`, `models/handlers/gemini/`)

- **Providers**: one engine (`executor/gemini/google.ts`) parameterised by a `GoogleVariant` (`targets.ts`): `gemini`
  (provider key, `x-goog-api-key`), `gemini-interactions` (same key, native `POST /v1beta/interactions` with the
  `Api-Revision` header) and `vertex` (provider key against the project-less host, or a service account against the regional
  `projects/<id>/locations/<loc>` endpoint; Imagen models go through `:predict` with the request/response converters).
  Request shaping (`shaping.ts`: model/suffix handling, `maxOutputTokens` cap, content-turn splitting) and usage parsing
  (`usage.ts`: `usageMetadata`/Interactions usage with the v2 token breakdown - re-exported from `usage/parsers.ts` - and intermediate-usage filtering) follow the Go executors. Payload rules
  stay the last mutation of the body in every path (stream, count, Imagen, native Interactions).
- **Routes**: `POST /v1beta/models/*` (`generateContent`, `streamGenerateContent`, `countTokens`, Gemini SSE or raw
  chunks for other `alt`s) and `POST /v1beta/interactions` (exactly one of `model`/`agent`; agent requests are forced to
  the `gemini-interactions` provider and select credentials as for `gemini-2.5-flash`, the Go `auth_selection_model`).
  `ExecutionInput.forcedProvider`/`authSelectionModel` and `PickRequest.selectionModel` carry that through the conductor.
- **Vertex tokens**: service-account access tokens are minted by the ControlPlane (`ensureFresh`) before the attempt by
  the conductor's credential preparation (`needsPreparation` for `vertex` without `metadata.access_token`); the executor
  only reads `metadata.access_token` (401 `credentialScoped` when missing). API-key vs service-account is decided by the
  `api_key` attribute (a minted `access_token` next to a `service_account` is a bearer token, not a provider key).
- **Translators** (all golden-fixture tested against Go, `tools/fixturegen/translator/corpus/*-gemini.json`,
  `gemini-interactions.json`, `interactions-*.json`): gemini->gemini, claude->gemini, openai->gemini,
  openai-response->gemini, interactions<->gemini, interactions->interactions (passthrough). Shared Gemini pieces live
  in `translator/gemini/{common,util}`: contents merging, thought-signature replay policy (Gemini target only; other
  providers' signatures are never replayable for Gemini, so only the Gemini decision table is ported), JSON-schema
  cleaners and the MIME table.
- **Responses (`translator/gemini/openai/responses/`)**: request/response ported file by file (carrier, trailing
  signature, tools, media, web search, streaming and non-streaming). Gemini returns whole function calls, so the
  apply_patch bridge is reduced to strict `{"input": ...}` validation (`finishApplyPatchArguments`) plus the event
  helpers it needs; a retained failure sets `state.toolInputError` (stream: `response.failed`, non-stream: translation
  failure -> 502). Hidden text signatures (a signature that trails the visible text) go to a `ReplayCache`
  (`replay-cache.ts`): the translators see a synchronous cache; the Gemini executor installs a request-scoped one
  around each synchronous translator call (`withReplayCache`, `executor/gemini/replay.ts`): it prefetches the cache keys of the
  assistant messages in the request in one DO round trip before translating (`textSignatureKeys`) and flushes the entries the
  response translation stored in one write before the chunk is emitted. One DO instance per caller scope holds the entries (1 h
  TTL, 10240 per caller); a backend failure degrades to the bypass signature, never to an error.
- **Fixtures**: cases with generated ids/timestamps are tagged `needs: ["id-normalization"]` and run by
  translation's `test/translator-fixtures-ids.test.ts` (ids and `created_at` masked on both sides; thinking-summary
  cases apply the real summary hooks); everything else must match the Go output structurally
  (`test/translator-fixtures.test.ts`).
- **Deviations from Go**: `TranslationError.body` returns the partially translated body for fixture parity only;
  `gjson.Raw` whitespace is not preserved (embedded raw JSON is compacted); model capability lookups
  (`ModelSupportsWebSearch`, the Claude thinking budget) go through the lookup the executor installs
  (`withModelInfoLookup`: the attempt's registry snapshot, which falls back to the static catalogs); Go's
  `PrepareAntigravityInteractions` lives in `executor/gemini/antigravity-interactions.ts` (see _SessionState Durable Object_); a Vertex Imagen
  request without a prompt answers 400; logging of signature decisions is dropped. `claude -> interactions` is ported separately (see below).

## Claude clients on Interactions providers (`translation/translator/interactions/`)

Port of `internal/translator/interactions/claude` (registered as `claude -> interactions` by
`interactions/register.ts`): Claude Messages requests served by `gemini-interactions` (native `POST /v1beta/interactions`) and Devin.

- **Request** (`claude/request.ts`): `system` -> `system_instruction` (blocks joined with `\n`, attribution blocks kept like Go),
  `max_tokens`/`temperature`/`top_p`/`stop_sequences`/`thinking`/`output_config.effort`/`tool_choice` -> `generation_config`,
  messages -> `input` steps (`user_input`, `model_output`, `thought`, `function_call`, `function_result`), message-level `system`
  entries -> `<system-reminder>` user steps (held back behind pending tool results), tool results re-aligned with their `tool_use`
  order (`alignClaudeToolResults`), `tools` -> function declarations. Only inline base64 media is forwarded; a user turn emptied
  by unsendable parts is refused with a request-scoped 400 (`UserTurnDrops`). `convertClaudeRequestToInteractionsWithCompat`
  keeps empty thinking blocks and is selected for `is-compat` models by `translateRequestForExecutor` (the `gemini-interactions`
  executor).
- **Response** (`claude/response.ts`): Interactions stream events/aggregates -> Claude `message_start`/`content_block_*`/
  `message_delta`/`message_stop`/`error` frames (each frame ends with three newlines like Go) and Claude `message` bodies;
  `status: incomplete`/length finish reasons -> `max_tokens`, function calls -> `tool_use`, usage re-based so that Claude's
  `input_tokens` excludes cache reads/writes.
- **Fixtures**: `corpus/claude-interactions.json` (101 cases: Go tests ported plus edge cases); the golden harness now also masks
  the wall-clock `msg_<unixnano>` ids. End-to-end: `packages/models/test/claude-interactions-pipeline.test.ts` (gemini-interactions through the
  full pipeline, Devin through its executor with a Claude source).

## OpenAI-compatible upstream for every client protocol (`translation/translator/openai/`, `models/executor/openai-compat/`)

Port of `internal/translator/openai/{claude,gemini,openai,interactions}` plus the image paths of
`openai_compat_executor.go` and `openai_images_handlers.go`. `translator/openai/register.ts` registers (client -> provider):
claude/gemini/openai-response -> openai, interactions <-> openai (Chat Completions) and interactions <-> openai-response;
`handlers/openai/routes.ts` already converts Responses-shaped bodies sent to `/v1/chat/completions`.

- **Layout**: one directory per Go package; the helpers of Go's `translator/common` live in `translator/common/` (apply_patch
  bridge, Responses tool descriptors, tool-name fixing, user-turn-drop policy, file data, ...); `openai/common/read.ts` only adds
  OpenAI-side readers. Modules cite their Go source. The
  apply_patch identity state machine of `interactions/responses` is ported statement by statement (including the
  `ApplyPatchInputDecoder`), and every translator is covered by golden fixtures (`corpus/*-openai*.json`, `*-interactions.json`).
- **Images**: the executor serves `openai-image` entry requests (`executor/openai-compat/images.ts`): the JSON body is
  forwarded to `{base-url}/images/generations|edits` with model/stream normalised and payload rules applied last. The handler
  routes `gpt-image-*` to Codex and every model the registry types `openai-image` (config `models[].image: true`; test
  doubles of `ModelProviders` may implement the optional `modelType`) to the OpenAI-compatible executor, converting the
  non-stream answer to `response_format` (`buildImagesApiResponse`). The handler turns multipart edits into the JSON edit
  form, so the executor rebuilds `multipart/form-data` for the upstream (file names are not kept).
- **Executor shaping** (`openai-compat/executor.ts`): models whose `input-modalities` list text without image get their Chat tool
  results flattened to text, relayed Claude tool-result images replaced by `[image omitted: unsupported by upstream]`
  (`helps/openai-compat-tool-results.ts`, verified against Go by `fixturegen/compatparity`). With `support-prompt-cache-key` the
  `prompt_cache_key` is the client's, else (Claude callers) the Claude Code agent scope, else a UUIDv5 over provider, model, source
  format and the provider session (`ProviderSessionUUID`: the WebSocket execution session, then the derived session identity).
  SEAM: the derived identity is read from `ExecutionMetadata.sessionId`, like Codex and Antigravity; the content-hash derivation of the
  session slice feeds the same field.
- **Deviations**: a patch-enabled Interactions stream that ends without its source
  terminator now fails through `state.finalizeToolInput` (executors call it, see Devin); malformed
  Interactions event JSON is only approximated (longest valid object prefix) because gjson reads lazily; raw JSON texts that
  Go copies byte for byte (`gjson.Raw`) are re-serialised compactly.
- **No equivalent needed**: the Go OpenAI-compatible executor has no refresh and no reasoning replay cache (§7 of the pipeline
  research lists none for it); 401s are ordinary upstream errors for the conductor's classification.

## Outbound guard (`core/outbound/`)

Every URL an org or member supplies passes one **outbound guard** before Commissary fetches it (ADR 0044,
`docs/THREAT-MODEL.md` "Outbound requests to places they shouldn't reach"). Today these are guarded:

- a provider's `base_url` (provider key groups, the config import, auth files: `base_url`, `base-url`, `api_base_url`);
- a Vertex service account's `token_uri`, fetched on every token mint (the Vertex import, auth files);
- the `models.catalog` source, fetched by the cron and the panel's catalog refresh;
- Commissary Cloud's SSO: an org's OIDC issuer (its discovery document), the JWKS endpoint and the SAML sign-in URL;
- a toolkit's source, the MCP server's URL, on save and on every fetch (see "Tools");
- a Discovery toolkit's `rootUrl`, which its calls go under, on save (adding the toolkit, replacing its uploaded
  document) and on every build, besides every call (see "Tools", Discovery toolkits);
- Commissary Cloud's OAuth server for MCP clients: a client's Client ID Metadata Document (CIMD) and the JWKS it names,
  which `@cloudflare/workers-oauth-provider` fetches itself with the global `fetch`. Every call of the library that may
  fetch runs inside `withOutboundGuard(policy, run)` (`core/outbound/global-fetch.ts`): while `run` is pending, the
  global `fetch` of the isolate checks each request it makes, and each redirect hop (followed by hand, at most five),
  against the policy of the request being served (an `AsyncLocalStorage` scope, so other requests of the isolate are
  untouched; a `fetch` replaced in the meantime, as tests do, is wrapped again). A refused URL rejects like a failed
  fetch, which the library answers as a CIMD failure.
- toolkits' OAuth 2 sign-ins (#202, "Tools", OAuth 2 sign-in): every metadata URL discovery fetches and every endpoint
  the metadata names (authorization, token, registration), on every sign-in and token refresh; a toolkit's OAuth app's
  authorize and token URLs and a client credentials grant's token URL, on save and on every use.
- the URL a browser crawl starts from (#270, "Tools", Crawls), before Browser Run is asked to crawl it; the browser
  toolkit's other URLs are exempt, as Browser Run fetches them from its own network (ADR 0044).

The sandbox's egress point (`SandboxEgress`, see "Tools") applies it to every request a sandbox session makes, after
the session's network. The toolkit catalog's live checks use the same guard when they land, from `@commissary/core`.

- **The check** (`core/outbound/check.ts`, `checkOutboundUrl`): only `https:`, plus `http:` and `https:` to loopback
  (`localhost`, `*.localhost`, `127.0.0.0/8`, `::1`) in local development; no IP literal outside the public internet
  (IANA's special-purpose ranges: IPv4 this-network, private, CGNAT, loopback, link-local and the metadata address
  `169.254.169.254`, IETF assignments, documentation, benchmarking, 6to4 relay, multicast, reserved and broadcast; IPv6
  everything outside global unicast `2000::/3` (unspecified, loopback, unique local `fc00::/7`, link-local, site-local,
  multicast, discard-only, ...) plus Teredo and the other IETF assignments, and documentation; an IPv4-mapped, NAT64 or
  6to4 address is judged by the IPv4 address it carries); none of the deployment's own hosts. The WHATWG URL parser
  turns IPv4's odd notations (decimal, octal, hex, short forms) into a dotted quad first, so they are refused like the
  plain spelling. Names are **not resolved**: the guard relies on Cloudflare's network not routing a Worker's `fetch`
  to a private address (below). A refusal is `OutboundRefused` (`reason`, the refused `host`, never a path or query),
  whose message is "Commissary only reaches public HTTPS addresses".
- **The transport** (`core/outbound/client.ts`, `guardHttpClient`, `OutboundHttpClientLive`): an `HttpClient` that
  checks every request and follows redirects itself (`redirect: "manual"` to `fetch`), checking each hop, at most five
  (`MAX_OUTBOUND_REDIRECTS`; one more is refused, `too_many_redirects`). A redirected POST becomes a GET as `fetch` does,
  and `Authorization` and cookies are dropped on a change of origin. A caller that asked for `redirect: "manual"` itself
  (the quota probes) keeps reading its redirects; only the first hop is checked for it. A refusal fails the request
  with an `HttpClientError` (`InvalidUrlError`) whose cause is the `OutboundRefused`; `outboundRefusalOf` finds it.
- **The policy** (`CurrentOutboundPolicy`, `outboundPolicy`): each Worker provides it per request in `requestContext`
  from its bindings and the request's URL. Own hosts are `OWN_HOSTS` (the base, app, API and auth hosts, set by
  `alchemy.run.ts` on the app, API and state Workers; empty on a preview and under `alchemy dev`), the Worker's own
  `API_DOMAIN`/`APP_DOMAIN`/`AUTH_ORIGIN`, and the request's host; a request to a workers.dev host (a preview) refuses
  every Worker of that account's workers.dev subdomain. Local development is decided like the Access dev bypass: the
  request came to a loopback host (`isLoopbackHost`), which only `alchemy dev` serves. Without a policy (cron jobs, the
  ControlPlane) the strictest applies: no loopback, the bindings' own hosts only. On a preview that leaves the
  ControlPlane without the preview's workers.dev hosts: `infra/preview-origin.ts` learns the account subdomain only from
  the API Worker's URL, after the state Worker is deployed, so `OWN_HOSTS` cannot carry it. The app and API Workers
  cover the gap through the request's host.
- **Where Models uses it**: the client API's executors (`handlers/layer.ts` wraps whatever `HttpClient` it is given, the
  tests' mocks included), the management routes (`ManagementServicesLive`: the key probe, quota checks, the catalog
  refresh), the API Worker's cron jobs (`apps/api/src/scheduled.ts`: the catalog refresh among them) and the
  ControlPlane (the Devin status sweep and the `RefreshManager`, whose Vertex token mint checks `token_uri`). The Codex
  and xAI WebSocket transports check the dial URL (`wss:` as `https:`, `executor/websocket/session.ts`) and do not
  follow a redirected upgrade. On use, the conductor turns a refusal into a `400` (`code: outbound_refused`) with the
  guard's message: no cooldown, and the request moves on to another provider as after an upstream 400. On write
  (`management/base-url-guard.ts`, `management/settings.ts`), a provider key group (`PUT /provider-keys/groups`, `422`),
  a config import (`422 invalid_config` with the `path`), a settings save of `models.catalog` (`422 invalid_setting`),
  an auth file upload (`422` with the `path` and the file's `name`), a Vertex import (`422` with the `path`) and a field
  patch of an auth file are refused with the same message. An existing `http:` or private URL stops working; there is no
  override (`docs/MIGRATION.md`).
- **SSO** (`apps/app/src/sso/idp.ts`): saving a provider checks the OIDC issuer or the SAML sign-in URL with
  `checkOutboundUrl`, and Better Auth's discovery trusts an endpoint the document names only when the guard lets it
  through (`isTrustedOrigin`); testing a provider checks the stored issuer and JWKS endpoint again before fetching them.
  The guard replaces Better Auth's own `isPublicRoutableHost`, which also refuses metadata names such as
  `metadata.google.internal`; dropping those name checks is fine on Workers, where names are not resolved and a
  Worker's `fetch` never reaches a private address (ADR 0044).
- **`global_fetch_strictly_public`** is set on every Worker (`COMPATIBILITY` in `alchemy.run.ts`, mirrored in each
  `vitest.config.ts`).

### What a deployed Worker's `fetch` reaches

What Cloudflare documents (read 2026-10-19). Not yet verified on a deployed stage; see #255.

- **The deployment's own zone.** Without the flag, a `fetch` to a hostname in the Worker's own zone "is routed to the
  zone's origin server, ignoring any Workers mapped to the URL and also bypassing Cloudflare security settings"
  (Access included); with `global_fetch_strictly_public` it goes to Cloudflare's front door like a request from the
  internet ([compatibility flags, "Global fetch() strictly
  public"](https://developers.cloudflare.com/workers/configuration/compatibility-flags/#global-fetch-strictly-public)).
- **Private, loopback and link-local addresses.** The `fetch` documentation says nothing either way
  ([Fetch](https://developers.cloudflare.com/workers/runtime-apis/fetch/)). For TCP sockets Cloudflare documents that
  "Cloudflare IPs, `localhost`, and private network IPs" are disallowed
  ([TCP sockets, troubleshooting](https://developers.cloudflare.com/workers/runtime-apis/tcp-sockets/#troubleshooting)),
  and reaching a private network takes Workers VPC over a Cloudflare Tunnel, Mesh or WAN on-ramp
  ([Workers VPC](https://developers.cloudflare.com/workers-vpc/)): a Worker has no route into a private network of its
  own. A Cloudflare IP literal answers error 1003
  ([error 1003](https://developers.cloudflare.com/support/troubleshooting/http-status-codes/cloudflare-1xxx-errors/error-1003/)),
  and a proxied record that points at a Cloudflare IP answers error 1000
  ([error 1000](https://developers.cloudflare.com/support/troubleshooting/http-status-codes/cloudflare-1xxx-errors/error-1000/)).
- **A public name that resolves to a private address.** Not documented for `fetch`; this is the case the guard leaves to
  Cloudflare's network, since it does not resolve names.

## Management API and control panel (`src/management/`)

Port of `internal/api/handlers/management` for the `/v9/management` routes that apply on Workers. The API serves the
control panel at `/` (`apps/web`, through `@commissary/contract`) and may change incompatibly: routes keep Go's response shapes where
that is cheap, but scripts written for the Go server are not guaranteed to keep working. The upstream panel (`Cli-Proxy-API-Management-Center`) is not served:
its address redirects to `/` (_Legacy panel address_ below), and the routes only it needed are gone (`requests/api-call`,
the operational and log routes listed under _Also not ported_) or replaced by the config entry routes (_Config entries_). Auth is the Access admin gate only (`management/zones.ts` classifies `/v9/management*`, the
panel paths and `/management.html` as `management`), or Commissary Cloud's sign-in (_Commissary Cloud_ below); Go's single
management key is not ported, and the port's per-org management keys (_Management keys_ below) are its own design.

- **Config entries** (`settings-routes.ts`, `provider-keys-routes.ts`, `model-rules-routes.ts`, contract `config.ts`): Go's
  management API reads and edits the whole configuration as one document (`GET|PUT|PATCH /config`, `GET|PUT /config.yaml`,
  `GET|PUT|PATCH|DELETE /config/*path`) and writes without a version. Dropping those routes is a deliberate difference
  (ADR 0025, ADR 0019): the Workers port stores every setting, key group, provider key, channel rule list and payload rule as a
  config entry with a revision (_Storage_ above), and each route below edits its own kind of entry and names the revision
  it read. A stale revision, or a group that vanished, answers `409 conflict` and stores nothing; a write of another
  entry never conflicts. Answers carry the new change counter as `version` (`Saved`, `EntrySaved` in `@commissary/contract/config`).
  - **Removed**: `GET|PUT|PATCH /config`, `GET|PUT /config.yaml`, `GET|PUT|PATCH|DELETE /config/*path`,
    `GET /settings/config`, `POST /settings/config/check`, `PUT /settings/config` and
    `PUT|DELETE /config/oauth/model-alias|excluded-models/:channel` answer `404` now (still behind the admin gate). With
    them go the raw configuration editor and its masking and placeholder machinery (`config-secrets.ts`,
    `settings-raw.ts`, `config-document.ts`): no route reads the whole document back, and no route reads a secret back
    at all (the provider keys page shows previews, the settings view carries no secret), so there is nothing to mask and
    nothing to restore. The one whole-configuration write is the import (_Settings_ below).
  - Config errors never quote a value (`config/codec.ts`: a YAML syntax error is a fixed sentence per `yaml` error code
    from `config/yaml-message.ts`, never the library's text, plus `line`/`column`; an unresolvable alias
    `invalid YAML: unresolvable aliases`; a schema error its expectation and `path`, formatted without `got <input>`;
    `disable-image-generation` without its value). They name at most keys of the written document (the `path`, an unknown
    `api-keys` family or group field) and are passed on unscrubbed: scrubbing stored secrets out of an echoed key would
    itself tell a right guess from a wrong one. So a refused write reads the same whether a typed value, key or alias
    name equals a stored secret or not.
  - Model rules (`model-rules-routes.ts`, contract `routing.ts`; Workers addition, Go's panel writes `oauth-model-alias` and
    `oauth-excluded-models` through `/config` paths): `PUT|DELETE /model-rules/aliases/:channel` and
    `/model-rules/exclusions/:channel` replace or remove one channel's whole list, which is one entry. The request names the
    revision it was based on in `If-Match` (`12`, `"12"` or `W/"12"`; `0` for a channel without rules): a missing or
    malformed header is `400 invalid_if_match`, a channel changed since `409 conflict`, a `DELETE` of a channel without
    rules `404 not_found`, and a list of which the normaliser would keep nothing `422 invalid_config`. The channel is the
    config's key, trimmed and lower-cased. The answer is `{status, version, revision}` with the channel's new revision (`0`
    after a delete). `GET /routing/models` carries `revisions: {aliases: {channel: rev}, exclusions: {channel: rev}}` (read
    first, so a write landing in between makes the edit answer `409` instead of overwriting a change the view did not show).
  - Price overrides (`price-routes.ts`, contract `prices.ts`; Workers addition): an org's price for a provider and model,
    one entry each, see _Usage accounting and observability_ (Cost). They are not part of the config document, so
    `GET /settings` and the import never carry them.
- **Private credentials in the API** (ADR 0023): every credential and provider key route takes the caller as a `Viewer`; plain
  members reach the credential, OAuth and provider key routes for their own private credentials only (the policy opens those
  routes to members, the handlers narrow them), org admins get existence-only rows (`others`) for the rest. See _Credentials
  and selection_ for the rules; `docs/ACCESS.md` for the matrix.
- **Credentials** (`credentials-routes.ts`, `credential-entry.ts`, `credentials/field-patch.ts`): list (filters,
  pagination), upload (multipart or raw JSON + `?name=`), delete (`name`/`names`/`all`), download (the stored file,
  tokens included; deviation from Go: only a service-token admin may call it, an email admin gets
  `403 download_requires_service_token`: the response is the one place a stored refresh token leaves the Worker, and
  a service token is the credential meant for scripts, see `ACCESS.md`), `models`, `status`, `fields`, `refresh`, `routing/cooldown/reset`. Credential id = file name; the
  list holds the auth files plus the provider keys whose provider reports quota with the key itself (`source:
  "config"`, `quota/report.ts` `CONFIG_QUOTA_PROVIDERS`: OpenCode Go only; `status` toggles any config key through its
  `excluded-models`, see _Provider keys_ below). Deviation from Go, which lists no provider keys in `/auth-files` (its
  panel shows them on the providers page only): the panel's Accounts page needs them for the OpenCode Go usage windows
  (see _Quota check_). Such an entry is named by its `auth_index` (`id` and `name`; the content-addressed credential id
  is never sent), `account` is the masked key (`[redacted]…abcd`), `supports_quota` is true, `key_group` (`{family,
  index}`) is where the key is edited on the Keys page, `disabled` means `*` in its `excluded-models`, and the status
  message is scrubbed of the key; the file-only fields (size, file times, note, weight, routing fields, headers) are
  absent. The quota check, `models` and the cooldown reset take its `auth_index`; the file-only operations naming it
  (delete, download, `fields`, `refresh`, `status` by `name`) answer `409 config_credential`, a several-name delete
  reports that `error` for it in its `207`, and a batch answers that `error` per account.
  Other config keys stay off the list (OpenCode Zen and the rest have no usage endpoint that takes the key). `auth_index` = `hex(HMAC-SHA256(AUTH_INDEX_KEY, "auth-index:" + id))[:16]` (`auth-index.ts`).
  Deviation from Go (security): Go's index is the unsalted `sha256(seed)[:16 hex]`, and a config credential id is
  itself `kind:sha256(kind␀key␀base␀proxy␀prefix␀headers)[:12]` (`credentials/synthesize.ts`), so anyone holding
  either could confirm guessed provider keys offline and brute-force low-entropy ones (self-hosted or compat endpoints),
  narrowed further by the `…abcd` preview. The index is keyed with a per-deployment secret (`AUTH_INDEX_KEY`, an
  Alchemy `Random` minted on a stage's first deploy and kept in the stack state, `alchemy.run.ts`; fixed keys in
  `alchemy dev` and the tests), and config credential ids never leave the Worker: no management response, usage
  export or client API header carries them, `name` lookups (`PATCH /credentials/status`, `GET /credentials/models`) match
  auth files only, and a config key is addressed by its `auth_index`. The index is never stored (D1 keeps the
  credential id, the ControlPlane recomputes indexes for lookups), so setting or rotating the key changes every index
  once (panel links `/accounts/<auth_index>` included). The key fails closed: a missing, non-string or < 16-character
  key throws instead of hashing (node:crypto accepts a 0-byte HMAC key), and once `ACCESS_TEAM_DOMAIN` or `ACCESS_AUD`
  is set (the condition that refuses `ACCESS_DEV_BYPASS`) the `alchemy dev` key and keys under 64 characters are
  refused too (`deploymentAuthIndexer`, logged once per isolate; the ControlPlane resolves the key per call, so a
  refusal fails the management calls that need an index, not the Durable Object; model traffic is unaffected, its log
  line then omits `authIndex`). `auth_index` inputs match case-insensitively. The key is a node:crypto `KeyObject` imported once per isolate
  and the indexes are memoised (`subtle.sign` is async-only; DO lookups and the views are synchronous). The ControlPlane builds the redacted panel
  entries (`listCredentialEntries`) and owns the mutations (`patchCredentialFields`, `refreshCredential`,
  `refreshAllCredentials`, `resetCredentialCooldown`, `removeCredentials`, `getCredentialFile`, `batchCredentials`).
  `POST /credentials/batch {action: enable|disable|refresh|delete, names}` (`credentials-batch.ts`, Workers addition
  for the Accounts page's selection) answers `200 {action, results, succeeded, failed, skipped}` with one `{name, ok,
  skipped?, error?, message?, status?}` per distinct name (names are exact file names, not trimmed), so a partial
  failure names who failed and why: `not_found` for unknown names and config credential ids (a delete of a name
  already gone counts as done, as the single delete would leave it; so does a config id, which must read like any
  unknown name or the reply would confirm a guessed provider key), `config_credential` for a listed config account named by
  its `auth_index` (indexes are public, so this confirms nothing), `refresh_failed` with a fixed message and the upstream status
  (never the token endpoint's body, which can echo the refresh token), and `skipped` + `not_refreshable` for an account
  without a refresh token. At most `MAX_BATCH_NAMES` (100) names, `MAX_BATCH_REFRESH_NAMES` (20) for a refresh (each
  name is an upstream call), `400` beyond or when empty; the body is read up to 64 KiB (`413` beyond). One endpoint
  instead of the panel calling the single-account routes: the single-writer ControlPlane applies
  enable/disable/delete against one snapshot in one SQLite transaction with one alarm re-arm (per-account calls would
  interleave with other writes and re-arm each time; a batch delete shares `removeCredentials`' cleanup of state,
  quota reports and the pool), the Worker spends one RPC instead of one per account, and token refreshes run in the
  object four at a time. Entries
  also carry the
  account's own routing fields for the panel (Workers addition): `prefix` (the effective one selection uses, not the
  raw metadata), `disable_cooling`, `headers` (masked like the provider keys page, `maskHeaders`: every non-empty value
  except the safe-header allow-list `SAFE_HEADER_NAMES` and pure client copies `$Name` / `$CPA-SESSION-ID`, since a
  secret can sit under any name), `excluded_models` and `model_aliases` (its own lists, without the channel rules).
  `PATCH /credentials/fields` type-checks the fields the panel edits (`prefix` with outer slashes dropped like Go's
  synthesizer, then without `/` or spaces; booleans; exclusion patterns stored lower-cased; aliases with both names,
  different, each alias once; header names and single-line values, merged with names matched case-insensitively, an
  empty value removing a header whatever its name) and answers a refused value with `422 {error, path}`, where `path`
  is the field or its entry (`headers.<name>`, `model_aliases.<index>`) (Go: `400`, and it stored most values as sent;
  a malformed request stays `400`, including a nested path into a typed field such as `headers.X-Foo`, which Go set). A
  header value equal to the mask of the same header's stored value keeps the stored value; any other value containing
  `[redacted` or `[new secret` is refused, so a masked value is never stored or copied to another header. This does
  not make stored secrets immovable: a PATCH of `base_url` (stored as sent, as in Go) still sends the account's token
  to the new address.
- **Provider keys** (`provider-keys-routes.ts`, `provider-keys-view.ts`, `provider-keys-write.ts`, `provider-keys-probe.ts`, contract `provider-keys.ts`):
  the control panel's keys page. Workers addition, no Go counterpart (Go's panel edits whole family arrays with raw keys).
  - `GET /provider-keys`: every `api-keys` group (all families, compat endpoints included) with the config `version`, the
    group's `id` and `revision` (its config entry, see _Config entries_), the effective base URL and, per key, `auth_index`, a `[redacted]…abcd` preview, `disabled` (effective `excluded-models`
    holds `*`) and the runtime of its credential (`auth_index`, counters, cooldowns, last error; not its id). Built in the ControlPlane
    (`apiKeysView`) from one snapshot of config and credential pool. **Secrets never leave**: keys are previews, every
    header value is masked (`[redacted]…`) except safe headers and pure client copies (`maskHeaders`), `proxy-url` and `experimental-cch-signing` (no effect
    on Workers) are left out and only reported as group `warnings`.
  - `PUT /provider-keys/groups` (`{family, id?, revision, group}`: replace the group `id` at `revision`, or add one after the
    family's last, with no `id` and `revision` 0) and `DELETE /provider-keys/groups` (`{family, id, revision}`): a group and its
    keys are config entries (ADR 0025). The Worker reads the entries, answers `409 conflict` when the group changed since
    `revision` or vanished (a write of another group never conflicts), applies the edit to the assembled document,
    dry-runs it through the config decoder and writes the group alone (`writeKeyGroup`) **without retry** (the panel
    re-reads and the user decides). The duplicate settlement below reads the other groups without naming their
    revisions, so the store also refuses (`409 conflict`) a write after which the normaliser would drop a key another
    group of the family stored since that read. The answer is `{status, version, id, revision}` (the group's new revision; `0` once
    deleted). A key in a written group is `auth_index` (keep the stored secret) and/or `api-key` (new secret): a key is
    an entry whose id is its credential id, so editing the secret of a key keeps its credential id and so its
    `auth_index` (the old document model made it a new credential); an unknown `auth_index` is `409 unknown_auth_index`,
    a missing group `404 group not found`. Hidden settings and masked header
    values are carried over from the stored entry, so a write is lossless. The config normaliser drops groups and keys
    silently (codex without `base-url`, empty keys, ...): the dry run compares the result with the request and answers
    `422` with the reason when the written group's own shape caused the loss. Duplicate keys are the exception and are
    dropped silently, as Go's `Sanitize*Keys` do (Go answers `200`; the Workers port used to answer `422 duplicate
    key`). Deviations from Go, deliberate: (1) a `422` for a typed key equal to a stored one would let an admin
    confirm a guessed secret, so the reply (`{status, version, id, revision}`, the version always advancing) is the same for a
    right and a wrong guess: the reply does not confirm a guess, the next read does. (2) Stored keys win (Go keeps the
    first of a family's duplicates, which would let a typed key in an earlier group delete the stored key, or the
    whole group, of a later one): for the families Go deduplicates across groups (gemini, interactions, vertex;
    `keyIdentities` in `config/normalize.ts` is the normaliser's own uniqueness id) `settleDuplicates`
    (`provider-keys-write.ts`, `key-duplicates.ts`) drops from the written group every typed key (`api-key`) equal to a
    key of another group, to a key the group keeps by `auth_index`, or to an earlier typed key, before the
    normaliser runs. A key counts as typed when the request writes its secret, header values (other than
    masked placeholders), a `proxy-url` or, for its group, another `base-url`: these feed the uniqueness id, so a
    collision found by trying a value would confirm a guess (an admin could try header values on a key kept by
    `auth_index`) and is dropped silently instead. A key kept by `auth_index` that the edit makes equal to a key of
    another group by its `prefix` alone is `422` (the other key differs only by a value the caller can read). `checkSurvival` asserts that every other group keeps its key count. A group
    left without keys (a new group, or a replaced one, made only of copies) is stored but not shown, as the list leaves
    out a group without keys, and the reply is the same. The assembled document is canonical (the store decodes it on every
    write), so list positions are document positions.
  - `POST /provider-keys/probe {auth_index}`: one connection test, made by the **Worker** with the credential's own base URL
    and headers (the ControlPlane only hands over the target, `apiKeyProbeTarget`, like `quotaProbeTarget`): a model
    listing (gemini/interactions `/v1beta/models` paged, claude `/v1/models` with `x-api-key` on api.anthropic.com
    else Bearer, codex/xai/meta `/models` or `/v1/models`, compat `/models`) or, for Vertex (no listing), a one-token
    `countTokens` on the first configured model. 30 s bound, not reported to the credential pool (no counters or
    cooldown), `200` always (`ok: false` with `status_code` and a fixed message; bodies and keys are never copied).
    Meta `/models` and Vertex `countTokens` are unverified against the live services.
  - `PATCH /credentials/status` (`auth_index`; `name` addresses auth files only) on a provider key adds or removes `*` in its
    `excluded-models` (Go `toggleConfigAPIKeyExcludedAll`; answers `via: "config:excluded-models"`, `excluded_pattern: "*"`);
    the id and `auth_index` do not change. A compat key answers `409`: disable the endpoint (its group's `disabled`). The
    toggle names no revision: it sets one flag to the state asked for, so the last toggle wins; it moves the group's
    revision, so a key group form opened before it answers `409` on save instead of undoing it.
  - `configKeyIds` (`credentials/key-ids.ts`) maps config positions to credential ids through the synthesised credentials;
    the ControlPlane and the keys page share it. `includeDisabledGroups` also addresses the keys of a disabled compat
    group (they have no credentials in the pool).
- **Settings** (`settings-routes.ts`, `settings.ts`, contract `settings.ts`): the control panel's Settings page and the
  config import. Workers addition, no Go counterpart (Go v8 edits `/config` paths without a version and normalises
  silently). Every setting is a config entry of its own, by dotted path (_Storage_ above).
  - `GET /settings`: every Settings-owned value (`SETTINGS_TREE`: routing, retries/cooldowns, requests/streaming,
    upstream provider flags and header defaults, Codex client flags, refresh concurrency, OAuth provider settings,
    multimedia, model catalogs) in config spelling with defaults filled (unset Go pointers are
    `null`), the `defaults`, the config `version` and `updated_at`, `revisions` (the revision of every stored setting by
    dotted path; a setting at its default is not stored and is not listed, revision 0),
    `payload` rule counts per kind, `prefixed_credentials` and the read-only `request_scoped_errors` map. There is no
    `not_applied` list: not-applied keys are never stored, only the import names them. **No secrets**: provider keys, proxy
    URLs and client keys are never in the view.
  - `PATCH /settings {revisions, patch}`: `patch` is a deep partial of the values; `null` resets a setting to its default
    (its entry is deleted). `revisions` names the revision of each setting the patch changes (absent = 0): a setting
    changed since answers `409 conflict` and nothing is stored, and writes to other settings never conflict. Unknown paths
    and not-applied keys answer `400 not_a_setting`, like any path that is no setting; invalid values
    `422 invalid_setting` with `message` and `path` (naming the value, e.g. `“EST” is not an IANA time zone`; type, then rules: Go
    durations > 0, non-negative counts, strategy literal, `gpt-` model prefix, catalog `""`/`embed`/`disabled`/http(s),
    IANA time zone or `Local`); then the edited document is dry-run through the config
    decoder and every written leaf must come back unchanged (a value the normaliser trims, lower-cases or clamps is
    refused with its path instead of "succeeding"). Ok:
    `{status: "ok", version, revisions}`: the new revision of each changed setting (`0` for one reset to its default).
  - `POST /settings/import` (body: YAML or JSON text, `application/yaml`, `text/yaml` or `application/json`, at most
    512 KiB, `413 body_too_large` beyond; counted while it is read): the **only** write of the whole configuration. It
    replaces **every** config entry of the org with a Go config document (v8 or legacy layout, as `config/codec.ts`
    reads it) in one transaction, so what the document does not set goes back to its default and every key group,
    key, rule list and payload rule it does not list is deleted. It answers `{status: "ok", version, not_applied}`:
    the keys that have no effect on Workers, which are not stored (`config/not-applied.ts`; ADR 0015's round trip
    through the stored document is replaced by this answer). Who manages the org is not part of the document: its
    `access.admin-*` lists are named as not applied (members, ADR 0022). A key whose secret a stored key
    of its family has keeps that key's id (a secret edited in the panel no longer matches its content hash), so
    re-importing a document keeps credential ids and auth indexes. Invalid YAML
    is `422 invalid_config` with `message`, `line` and `column` (a fixed sentence per error code, never the source; YAML
    parsed with the 1.2 core schema, custom tags, merge keys and a `%YAML 1.1` directive refused, anchors expanded); a
    config that does not decode is `422 invalid_config` with `path` when known, and so is a document that sets a
    deployment setting (`models.catalog`) in an org other than `global`. Because it replaces everything, every key in the
    document is typed and there is no stored key to protect: Go's first-wins deduplication of keys applies inside the
    imported document, and the reply cannot tell a typed key from a stored one (nothing stored is kept). The panel has no UI
    for it yet: it is for `curl` and scripts (MIGRATION.md).
  - `ManagementError` decodes the optional `message` and `path` of an error body, so the panel can show the reason
    and focus the field.
- **Also not ported** (only the upstream panel called these; all answer `404`): `server/latest-version`
  (GitHub release lookup), the file-log routes (`GET|DELETE /observability/logs`, `/observability/logs/errors/*`,
  `/observability/logs/requests/*`; Workers have no log files), `routing/model-definitions/:channel` (static catalogs;
  the panel reads `routing/models` and `credentials/models`), `GET /observability/usage/api-keys` (per-key counters;
  `GET /provider-keys` carries them) and `GET /oauth/callback` (the local callback forwarder's target; `POST` is the panel's).
  The upstream panel's `X-CPA-Version` and `X-CPA-Support-Plugin` response headers are not sent either (deviation from Go).
- **Not here**: `/oauth/*` (`oauth-routes.ts`, see _Provider OAuth logins_), `/observability/usage/*` (`usage-routes.ts`, see
  "Usage accounting and observability"), plugins, Home, `/v0/management`, and (deviation from Go) `POST /requests/api-call`:
  Go substitutes a credential's token into a request to any host the caller names, for the upstream panel's browser-side
  quota and key probes; here those probes run server-side (`credentials/quota`, `provider-keys/probe`), so the route is not
  ported and answers `404` (still behind the admin gate).
- **Control panel** (`web-panel.ts`, `apps/web`): `GET /`, the panel's page paths (`/accounts`, `/keys`, `/models`, `/usage`,
  `/settings` and their sub-paths; `management/zones.ts` `PANEL_SECTIONS`) and `/assets/*` (hashed bundle files) are in the
  management zone, so only Access admins get them. Every page path answers the build's `index.html` (the browser router picks
  the page) with a strict CSP (own origin only; inline `style` attributes allowed for meter widths and chart sizes), `404` with a build
  hint when it is missing. The panel calls `/v9/management` on its own origin with no key; Access authenticates the calls.
  Its client is derived from `@commissary/contract` (`packages/contract`: Effect `HttpApi` groups for the endpoints it
  uses, imported by the Worker, its tests and the browser as `@commissary/contract/<module>`; `test/management-contract.test.ts` decodes real responses through it). Deviation
  from Go: `/` was a public JSON banner there.
- **Panel theme** (`apps/web/src/lib/theme.ts`, `apps/web/src/theme-boot.ts`, `apps/web/src/styles/tokens.css`): light and dark through
  semantic `light-dark()` tokens. The theme follows `prefers-color-scheme` until the operator picks Light or Dark in the
  shell's theme menu (kept in `localStorage` as `commissary.theme`). The CSP allows no inline script, so a Vite plugin
  builds `theme-boot.ts` into a hashed same-origin classic script (`/assets/theme-<hash>.js`) placed in `<head>`; it sets
  `data-theme`, `color-scheme` and the `theme-color` metas before the first paint, so a stored choice never flashes.
- **Panel pages** (`apps/web/src/pages/`): Overview (`/`); Accounts (`/accounts`: every account ordered by urgency, filters
  All / Needs attention / Disabled, search, allowance meters, "Check all quotas" with the accounts whose check failed,
  and a Select mode: checkboxes, select-all of the shown rows, and a bar pinned to the window bottom that enables,
  disables, refreshes the tokens of or deletes (after a confirmation naming each account) the selected accounts the
  filter shows, through `POST /credentials/batch` in requests of 100 (20 for a refresh, which leaves out providers
  without one); failed and left-out accounts stay selected with their reason on the bar and on the row; the delete
  confirmation stays open until the deletion settles, then focus moves to the result; the Select toggle reads Done
  while selecting, and leaving returns focus to it; config accounts (OpenCode Go keys) carry a "Config key" mark,
  take part in "Check all quotas" and stay out of a selection); Account (`/accounts/$authIndex`: allowance with reset
  blades, cooldowns with clear, window history, the Routing section (`#routing`: priority, weight, retry rounds,
  cooling, Codex WebSocket preference, model prefix, exclusions, aliases, extra headers with secret values kept masked,
  note; only the fields that apply to the provider; one save of the changed fields with a change count, a leave guard
  and a `422` under the row it names; Models links an account's own rules here), details, served models, check quota, refresh
  tokens, enable/disable, delete; a config account keeps the allowance, quota check, cooldowns, history and models,
  and links its key group on the Keys page in place of routing, enable/disable and delete); Connect (`/accounts/connect`: OAuth sign-in by pasted callback address or device
  code, Vertex service-account import, auth-file upload); Usage (`/usage`: totals, tokens per hour or day, a breakdown
  by model, account, provider, user or endpoint whose rows narrow the page, and the request log with each request's
  details and failure body); provider keys (`/keys`: every `api-keys` group by provider, each OpenAI-compatible endpoint
  its own section, keys by their last characters with state, recent requests, a connection test, clear cooldowns and
  enable/disable; `/keys/$family/$index` and `/keys/new?family=` edit or add one group: endpoint, keys typed in once,
  models with discovery through the probe, exclusions, delete; reads `GET /provider-keys` and writes one group with
  `PUT /provider-keys/groups` carrying the group's `id` and `revision`, existing keys by `auth_index`, everything the form
  does not show kept as stored; delete sends `id` and `revision` too; a `409` shows a Reload button and no automatic
  refetch, so the draft stays); Models (`/models`: every model clients can call, plus the hidden ones
  no account serves now, ordered by standing, filters All / Needs attention / Hidden, search over names, aliases and
  accounts, each model's routes with their account or key, upstream name, alias or exclusion and the rule's channel,
  cooldowns with clear; a catalog line under the title ("Catalog refreshed 2 h ago · from models.dev", "shipped copy" while
  nothing is stored, the host of a custom address) with a **Refresh catalog** button that calls `POST /models/catalog/refresh` and says the outcome inline
  (models added/removed, already up to date, the failure reason, "already running"); the button is off, with the reason, while
  the source is Embedded copy or Off; `/models/rules` edits the channel rules `oauth-model-alias` and `oauth-excluded-models`, one
  section per channel with a live count of the models a pattern matches; reads `GET /routing/models` and writes one
  channel's list with `PUT`/`DELETE /model-rules/aliases|exclusions/:channel` carrying the channel's revision from the
  view's `revisions` as `If-Match`; on `409` the edit is planned again once on a fresh read, and a second refusal or a
  changed entry offers a reload); Settings (`/settings`: the settings that apply on Workers in sections, Routing,
  Retries & cooldowns, Requests & streaming, Payload rules, Images & video, Providers, Model catalog (one source field), Admin access,
  Account refresh; one
  form per section whose draft is a delta of the touched fields (`apps/web/src/lib/settings.ts`), saved with
  `PATCH /settings` carrying the `revisions` of the changed settings and only the changed leaves (`null` back to the default); inputs
  are checked and normalised as the server would (trimmed, admin emails lower-case) before sending; after a save the
  view refetches and the other sections' drafts rebase onto it, listing a changed field that moved on the server; on
  `409` the panel re-reads and re-applies the delta once, stopping with the list of fields that moved when it still does not
  apply, and a `422` lands under the field its `path` names (the message
  names the bad value; the hint says what is expected); other save outcomes show in the section's sticky save bar; the
  jump list counts each section's unsaved changes and leaving the page with any asks first (`useBlocker`); payload
  rules and account error rules are read-only there ("Set … by importing a Go config document (POST /settings/import)."; the import has no panel
  UI yet, see _Config entries_). There is no raw configuration editor (removed with its CodeMirror dependencies, ADR 0025).
  The Usage page keeps its range (24 hours, 7 days, 30 days), breakdown and filters in the
  address (`?range=&by=&model=&provider=&account=&user=&member=&team=&failed=`, decoded per parameter by `apps/web/src/lib/usage.ts`
  `readUsageSearch`, a malformed one dropped), reads `GET /observability/usage/summary`, `/series` (provider series
  summed in the browser; no principal filter, so no chart while a user filter is set) and `/records` (pages of 50
  through the `next_before` cursor); every range starts at its first bar. The shell's Refresh bumps one epoch atom
  that every usage query reads, so they all refetch. The page shows the period's **Cost**, the **Unpriced requests**
  count, a Cost column per breakdown row, the cost in each request's details and, while models without a price have
  requests in the view, a callout (from `/observability/usage/unpriced`, narrowed like the page) whose links open
  `/usage/prices?provider=&model=`. **Prices** (`/usage/prices`, `apps/web/src/pages/Prices.tsx`, model in
  `apps/web/src/lib/prices.ts`) lists, adds, edits and removes the org's price overrides over `/price-overrides`, with the
  entry revision as `If-Match` (a `409` reloads the list and says to make the edit again); the form opens with the
  provider and model from the address, or edits the override that has them. The Usage page also breaks down and filters
  by member (`by=member`, `?member=`, shown by email) and filters by team (`?team=`, a picker of the org's teams). **Grants**
  (`/grants`) and **My models** (`/my-models`) are described in _Grants_ below. **Members** (`/members`, `apps/web/src/pages/Members*.tsx`, rules in
  `apps/web/src/lib/role.ts`) lists the org's members, teams and service tokens and offers only what the caller's role allows
  (read from the org-scoped `GET /me`): admins add and remove plain members and manage teams, owners change roles and
  auto-join, and a token role above member is offered to a platform admin only. A plain member's panel is the Usage page
  alone: the nav lists nothing else, `/` lands on Usage, other pages show a not-allowed note, and Usage hides the
  breakdowns and lists they cannot read. Allowance figures (`apps/web/src/lib/quota.ts`) come from the
  stored quota check when it is newer than the last response's rate-limit headers, otherwise from the headers. Window
  history (`apps/web/src/lib/history.ts`) sums `GET /observability/usage/series` hourly points into the account's past quota
  windows, counted back from the current reset (approximate for windows the provider starts on first use), or into days
  for an account without windows. The Vertex import is multipart, so the panel posts a `FormData` itself and decodes the
  answer with `@commissary/contract/oauth` `VertexImported` / `VertexImportFailed`. Pure helpers in `apps/web/src/lib/` are tested in
  Node.js (`apps/web/test/`).
- **Legacy panel address** (`web-panel.ts` `LEGACY_PANEL_REDIRECT`, deviation from Go, which serves the upstream panel
  there): `GET|HEAD /management.html` (any case or percent-encoding) answers `302 Location: /` with
  `cache-control: no-store`. It stays in the management zone (`management/zones.ts` `LEGACY_PANEL_PATH`): `401`
  unauthenticated, `403` for non-admins, no CORS. The browser keeps the old `#/auth-files`-style fragment over the
  redirect, and the panel maps it on boot to the page that replaced it (`apps/web/src/lib/legacy-hash.ts`: auth files and
  quota → `/accounts`, OAuth → `/accounts/connect`, providers → `/keys`, OAuth rule editors → `/models/rules`, config and
  system → `/settings`, the rest → `/`).
- Deviations from Go: `/` serves the control panel (admins only) instead of the public JSON banner; cooldown `reason`s are
  limited to the quota reason / last error code; `GET /credentials` always returns JSON timestamps as RFC 3339 strings;
  `POST /credentials/quota`, `POST /credentials/quota/all`, `POST /credentials/batch` and the entries' `quota_report`
  are Workers additions (see _Quota check_), as are `/credentials/reset-grants` and the entries' `reset_grants` (see
  _Claude reset grants_). The provider keys,
  Settings (with the import) and model rule routes are Workers additions (secrets never in their responses and never read
  back; every write names the revision of the entry it changes and a stale one is `409`; values the normaliser would
  rewrite refused with `422` instead of silently changed). Go's whole-document `/config*` routes are not ported
  (_Config entries_ above). Provider keys can be toggled
  (Go answers the same through `excluded-models`); compat keys cannot, only their endpoint.

## Quota check (`models/quota/`, `models/management/quota-routes.ts`)

Workers addition with no Go counterpart: the upstream panel asks the provider usage endpoints itself, from the browser,
through Go's `POST /requests/api-call` (not ported). Here the server does it, so tokens never reach the browser and the
result is stored.

- **Flow** (`check.ts`): the ControlPlane resolves the account and its token (`quotaProbeTarget`: `ensureFresh`, then
  `target.ts`; the token Go's api-call substitutes for `$TOKEN$`, the Meta `dca_token`, the Devin session token; for a
  listed provider key, named by its `auth_index`, the key itself without a refresh). The
  **Worker** then calls the usage endpoint with its `HttpClient` (`probe.ts`, 15 s per call), so the single-writer
  object is never held by a slow provider. Finally the ControlPlane merges the outcome into the stored report
  (`recordQuotaReport`, `report.ts`).
- **Routes**:
  - `POST /v9/management/credentials/quota {name}` answers `200 {status: "ok", report}`, including when the upstream call
    failed; the report then carries `error`.
  - `name` is the listed name: an auth file name, or a listed config key's `auth_index` (a config credential id is
    never accepted, so a check confirms no guessed key).
  - `404` for an unknown account; `422 quota check is not supported for <provider>` for providers without a usage
    endpoint.
  - `POST /v9/management/credentials/quota/all` (the panel's "Check all quotas") runs the sweep below now and answers
    `200 {started_at, finished_at, results, checked, failed}` (`results`: `{name, ok, error?, message?, status?}` per
    account, `status` the provider's HTTP status so the panel can tell a refused sign-in); `409 quota_check_running`
    while another sweep holds the lease.
  - A single check whose account's tokens changed while the provider answered (`credentialVersion` changed: a
    re-login or a token refresh) answers `409 stale`: the outcome describes the old tokens and is dropped, like a refresh
    result for replaced tokens.
- **Sweep** (`sweepQuotas`): every enabled account of a supported provider (auth files, and the listed config keys
  without `*` in their `excluded-models`, named by `auth_index`), two accounts at a time. A Claude check
  opens up to three upstream connections at once (usage, profile, reset grants), so two checks stay within the six
  connections a Workers invocation may have waiting for response headers (more are queued, and could run into the
  15 s bound). An outcome for replaced tokens is dropped (`stale`), its reset grant status with it. One sweep at a time across isolates: it takes a lease in the
  ControlPlane first (`quota_sweep` in the lease store `state/lease.ts`, one SQLite row, taken atomically under the input gate on the object's clock,
  given back with its token; a table from before `renewed_at` is recreated, it only holds a transient lease). Each
  recorded account renews it (`renewed_at`), and so does a background renewal every 30 s, since one account's check
  can outlast the lease (`ensureFresh` up to 120 s plus the 15 s probe); when a renewal finds the lease lost the sweep
  stops (`409 quota_check_lost` for the panel). A lease not renewed for 2 min counts as abandoned, so a long sweep
  keeps it while a Worker that died mid-sweep blocks the next one for at most 2 min. Taking the lease is the acquire
  step of `acquireUseRelease`, so it is given back however the sweep ends (failure, a cancelled request), and the
  invocation is held open with `waitUntil` until it has been. `waitUntil` only extends an invocation by about 30 s
  after the client disconnects; if the release has not run by then, the lease expiry covers the rest.
- **Cron**: the `refresh` sweep runs before `quota-check` (`runQuotaSweep`, the same sweep), so the check sees the
  fresh tokens; the quota check skips its run (`skipped: true`) while the panel's sweep holds the lease instead of
  asking every provider twice.
  - **Subrequests per run**: the lease and list RPCs, then per account two RPCs (`quotaProbeTarget`,
    `recordQuotaReport`) and its upstream calls: three for Claude (usage, profile, reset grants), two when the sweep
    skips the grant read (stored status under 6 h old, or under 24 h old when not eligible; cron and "Check all
    quotas" alike), one or two for the other providers. Token refreshes run in the ControlPlane, not in the
    invocation. On Workers Paid (10,000 external subrequests per invocation; Workers Free isn't supported, ADR 0043)
    the limit is out of reach. Redirects are never followed for Anthropic
    calls, so a redirect chain cannot add subrequests.
- **Report**:
  - `checked_at` is the last attempt and `refreshed_at` the last success.
  - `windows` and `plan` survive a failed check, and a success without a plan keeps the previous plan.
  - `error` is a fixed message plus the upstream status, never a response body.
- **Storage** (`store.ts`): a separate SQLite table `credential_quota_report` in the ControlPlane, one JSON row per
  credential. It is not part of the cooldown state (`credential_state`), so cooldown resets do not touch it. A row is deleted with its credential and when an upsert replaces an existing credential's token
  material (a re-login). A config key's credential id is content-addressed, so editing the key gives it a new id and a
  fresh report; the old row is dropped by the next sweep (`quotaCheckTargets` keeps only the rows of current
  credentials). `listCredentialEntries`/`refreshCredential` add it to the entry as `quota_report`.
- **Providers and window ids**:

| Executor key      | Endpoint                                                                                                             | Window ids                                                                                                                                                         |
| ----------------- | -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `claude`          | `GET api.anthropic.com/api/oauth/usage` (plus `/profile` for the plan and the reset grant read, failures tolerated)  | the payload keys (`five_hour`, `seven_day`, `seven_day_opus`, …, unknown keys title-cased); dollar pools skipped; `limits[]` `weekly_scoped` → `seven_day_<model>` |
| `codex`           | `GET chatgpt.com/backend-api/wham/usage`                                                                             | `primary`, `secondary`, `code_review_*`, `<limit>_*`; labelled from `limit_window_seconds`; plan = `plan_type`                                                     |
| `antigravity`     | `POST …/v1internal:retrieveUserQuotaSummary` (three hosts in order)                                                  | `bucketId`, labelled "Group · bucket", `used = 1 - remainingFraction`                                                                                              |
| `kimi`, `kimi-ai` | `GET api.kimi.com` / `api.kimi.ai` `/coding/v1/usages` (only these two hosts)                                        | `limits[]` by length (`five_hour`, …, else `limit_<n>`), `weekly` (summary), `monthly`                                                                             |
| `xai`             | `GET cli-chat-proxy.grok.com/v1/billing` (`?format=credits` for weekly)                                              | `weekly`, `monthly`                                                                                                                                                |
| `meta`            | `POST api.meta.ai/muse-code/key` with the `dca_token`                                                                | `window`, `weekly`                                                                                                                                                 |
| `devin`           | `GetUserStatus` (the `devin-user-status` call)                                                                       | `daily`, `weekly` (`used = 100 - remaining`)                                                                                                                       |
| `opencode-go`     | `GET {base}/usage` (default `opencode.ai/inference/go/v1/usage`, `Authorization: Bearer <config key>`, no redirects) | `rolling` → `five_hour` ("5-hour"), `weekly`, `monthly` (`percent` used; a status other than `ok` reads as used up)                                                |

- **Differences from the upstream panel**:
  - xAI never makes its paid-account fallback (`/v1/me` plus a real chat completion). Its billing calls send the
    executor's Grok CLI version (KV `xai/client-version`, fallback `1.0.46`) instead of a pinned one: the chat proxy
    answers 426 to versions below 1.0.13, billing included. The billing payload is protobuf JSON, which omits zero
    values: a weekly period without `creditUsagePercent` reads as 0% used, and a `monthlyLimit` of 0 (no included
    allowance) gives no monthly window.
  - The Codex subscription and reset-credit calls and the Antigravity tier call are skipped.
  - Windows without a percentage are dropped (`used_percent` is required).
  - Labels are English and fixed.

## Claude reset grants (`models/quota/reset-grant*.ts`, `models/management/reset-grant-routes.ts`)

Workers addition with no Go counterpart (Go has no reset grant code; the upstream panel makes these calls from the
browser through `POST /requests/api-call`, not ported). A reset grant is Anthropic's `cedar_ember` program: a bundle of
resets, each of which empties the usage windows it `clears` (`five_hour`, `seven_day`, …). Upstream panel sources:
`services/api/claudeResetGrants.ts`, `features/quota/providers/claude/{selectResetGrant,resetGrantOperations}.ts`.

- **Upstream calls** (fixed host `api.anthropic.com`, Claude CLI headers and the account's OAuth bearer, from the Worker
  like the quota check): status `GET /api/oauth/usage?cedar_ember=1&skip_spend=1` (its `cedar_ember` block; 12 s),
  organization `GET /api/oauth/profile` (`organization.uuid`; 12 s), claim
  `POST /api/organizations/{uuid}/reset_rate_limits {program: "cedar_ember", grant_id, request_id}` (25 s).
- **Status** (`reset-grants.ts`): parsed fail-closed like the panel (one malformed grant, a duplicate id or a bad
  timestamp rejects the block; missing `usable_now` reads false, missing `use_requires_limit` true; labels stripped of
  control characters). `claimable` is `next_grant_id` when usable, else the lowest usable id; otherwise `blocked_by`
  says why (`ineligible`, `cooldown`, `none_left`, `unusable`, `not_limited`). The quota check reads it as a third,
  tolerated Claude call (one more subrequest per Claude account per check; the cron sweep skips it while the stored
  status is under 6 h old, or under 24 h old when it says not eligible, so new grants are eventually noticed); `GET /v9/management/credentials/reset-grants?auth_index=` reads it now.
  A status is dated by when its read started. The last good status is stored (SQLite table `credential_reset_grants`,
  `reset-grant-store.ts`) and listed as the entry's `reset_grants`; an older read never overwrites a newer one.
- **Stale reads** (`reset-grant-store.ts`): each row keeps two counters that are never reset, a `generation` bumped
  when a re-login replaces the tokens or the credential is removed (so re-creating the same name starts a new one) and
  a `claim_seq` bumped at every claim start and answer. The ControlPlane hands out the credential's `generation` and
  the sum of every row's `claim_seq` with the token (`resetGrantTarget`, `quotaProbeTarget`), so a claim of another
  auth file of the same organization also outdates a read, even once its journal is gone; a status read under an older pair is not stored, a read whose credential
  was replaced answers `409`, and a fresh claim decided on it is refused with `409` ("check resets and try again"),
  since the read may predate a reset another claim spent. Counters instead of timestamps: only the ControlPlane's own
  values are compared, never the clocks of the Worker and the Durable Object.
- **Claim** (`POST /v9/management/credentials/reset-grants/claim {auth_index}`, `reset-grant-flow.ts`): refused with
  `409` on a disabled account (reads stay allowed); re-reads the status (`502` when it cannot; nothing is sent), answers `outcome: "none_available"` without a request when nothing is
  claimable, reads the organization (`502` when it cannot), then sends the claim. Anthropic's `result` is the
  `outcome`; `429` is `rate_limited`, `401`/`403` `auth_error`; any other status or body, a timeout or a transport
  error is `unknown` (a reset may have been spent; "HTTP 200 alone is not a reset"); so is a `3xx`, since Anthropic
  calls never follow redirects (`redirect: "manual"`; a redirected status read is a failed read). Only `reset` (or
  `already_used` on a resend) counts as spent: Commissary then clears the account's cooldowns (as
  `POST /routing/cooldown/reset`) and checks its quota again. When the answer cannot be recorded in the ControlPlane
  the `outcome` is still returned, with a `warning`.
- **Double spends**: the claim journal lives in the ControlPlane (single writer, so serialized across tabs and admins):
  a claim in flight answers `409` to a second one for 60 s; an `unknown` claim stays open for 10 minutes and the next
  claim resends it with the same grant and `request_id`, naming the request it saw (`409` when another claim replaced
  it). The resend reads the status first (a failing read does not block it): when the grant's `resets_left` dropped
  below the count the claim was decided on, or a `cooldown_until` runs from after the claim started, the claim is
  answered without sending, as spent (claim closed, cooldowns cleared) only when that read also shows
  `at_limit: false`, else with `outcome: "not_confirmed"` (nothing cleared; "check resets before trying again"; the
  claim stays open and the next resend sends the same `request_id`). One claim per Anthropic
  organization runs or stays open at a time across every auth file of it: a claim in flight or open in another file
  of the same organization (two files of one account, or a re-login into it) answers `409`, which names the case of
  a removed file's claim (it frees itself within 10 minutes). A resend for another organization
  (the account was replaced) is refused with `409`, and a refusal of a resend keeps the claim open, since it cannot
  prove the first request did not spend (panel rules). `pending_claim.in_flight` says a request of the open claim is
  running (the panel offers no resend then); a resend whose claim another tab answered meanwhile gets its own `409`.
  The journal and the stored status are dropped with the credential and when a re-login replaces its tokens, except a
  journal in flight: its answer is still recorded and it keeps holding its organization.
- **Assumptions** (no Anthropic documentation exists for these endpoints; taken from the upstream panel and the
  Claude Code client, not verified against Anthropic): the `request_id` is an idempotency key, so a resend with it
  does not spend a second reset; `already_used` answering a resend means the first request spent the reset; a reset
  is the only thing that lowers a grant's `resets_left` or starts a `cooldown_until`; `skip_spend=1` makes the status
  read free of side effects; the Claude CLI headers (`CLAUDE_HEADERS`) are required. Clearing Commissary's cooldowns
  after a reset follows the Go maintainers' advice in issue #6507, not upstream code.
- **Differences from the upstream panel**: the journal is server-side and shared instead of per tab, with the in-flight
  lease; an open claim past its 10 minutes is dropped and the next claim starts fresh (the panel blocks the tab until
  reload); cooldowns are cleared after a reset (the panel leaves them); `percent_used` is not kept; window ids beyond
  the panel's three are kept when they look like ids. The weekly `juniper_tide` program is not handled (nor by the
  panel).

## Usage accounting and observability (`models/usage/`, `models/observability/`, `models/management/usage-routes.ts`)

Port of `sdk/cliproxy/usage` (token accounting v2), `helps/usage_helpers.go` (parsers, `StreamUsageBuffer`, TTFT) and the
`internal/redisqueue` export shape. One `UsageRecord` per upstream attempt (`UsageReporter` per attempt, `finish` exactly
once; a 401 retry keeps the rejected attempt's failed record, a failed-over credential gets its own).

- **Accounting v2** (`accounting.ts`): `TokenBreakdown` (`input = uncached + cacheRead + cacheWrite`, `output =
  nonReasoning + reasoning`, `total = input + output + unclassified`, quality `complete|unclassified|inconsistent`).
  `ensureTokenBreakdown(detail, provider, executorType)` picks the semantics: **subset** (openai, codex, xai, grok, kimi,
  qwen, deepseek, openrouter, `openai-compatible-*`; cache inside input, reasoning inside output), **independent**
  (claude/anthropic; cache outside `input_tokens`, thinking inside `output_tokens`), **separate-reasoning** (gemini,
  aistudio, antigravity, vertex, interactions; `candidatesTokenCount` excludes thoughts), otherwise unclassified. Parsers
  attach the protocol's own breakdown (`record.ts` OpenAI/Responses/Codex, `parsers.ts` Claude, Gemini, Interactions,
  Antigravity + `mergeStreamUsageDetail`); `UsageReporter.finish` guarantees a valid breakdown on every record.
  Executors feed the reporter with `publish` (latest wins, tier-only updates keep the token detail, an earlier response
  tier survives) or `publishMerged` (Claude/Interactions events that complement each other). Go's int64 overflow checks
  become safe-integer checks. Executors must use these parsers: a hand-rolled `UsageDetail` without a breakdown is
  re-derived from the raw buckets, which is wrong for Claude (reasoning inside output).
- **TTFT** (`ttft.ts` + reporter): `markFirstByte` (non-stream: effective TTFT), `recordFirstPacket` /
  `observeTokenEvent(now, isToken)` (streams: first substantive token event, first packet as fallback). Codex streams use
  `isResponsesTokenEvent`; OpenAI-compatible and Claude executors still mark the first response byte (hook the matching
  `is*TokenEvent` into their stream loops to refine it).
- **Persistence** (`d1.ts`, `d1-sink.ts`, `migrations/usage/0001_usage_records.sql`): table `usage_records` (primary key =
  attempt `request_id`, `trace_id` = inbound request id, raw token columns plus the `acct_*` breakdown columns,
  `exported_at` for the queue; `migrations/usage/0002_usage_sessions.sql` adds `session_id`, `parent_session_id` and `base_url`: the
  explicit, derived (`derived:ctx:v1:...`) or LCP (`lcp:v1:...`) session identity of the attempt - the LCP one comes back
  from `pick` - and the credential's configured upstream base URL; the queue export projects the session ids to canonical
  UUIDs like Go's `NormalizeToCanonicalUUID`, the parent only when it differs). `migrations/usage/0003_usage_org.sql` adds
  `org_id` (`NOT NULL DEFAULT 'global'`, so records from before orgs are `global`'s) with `(org_id, requested_at)`
  indexes: the writer stores the request's `CurrentOrg`, and every listing, summary, series, export and queue query
  filters on it. `migrations/usage/0005_usage_member.sql` adds `member_id` (the caller's member id in the org, `NULL` for records
  from before members and for callers admitted without a member record) with an `(org_id, member_id, requested_at)` index.
  `migrations/usage/0006_usage_private.sql` adds `private` (`1` when a private credential served the request, `0` for every record
  written before and for shared credentials): a private record is its owner's alone. Every listing, summary, series, export
  and the export queue filter `private = 0` unless the reader is named (`UsageFilter.privateOf`, the caller's member id,
  which then adds that member's own private records), so an org admin's org-wide views never include a member's private
  traffic and a member reads their own private records with their other ones. The usage reporter's `finish()` now keeps the
  member id of the request (it was dropped before).
  `D1UsageSink` (default in `makeClientApiRoutes`) inserts through `ctx.waitUntil` (awaits when
  `waitUntil` throws), logs failures with request id and message only and never fails the request. The sink reads
  `ModelsEnv`/`WorkerExecutionContext` from the fiber context at publish time (not part of its type, so the conductor's
  attempt plumbing is unchanged). `migrations/usage/` is applied by Alchemy on every deploy
  (`D1.Database` `migrations` in `alchemy.run.ts`). Failure bodies are truncated to 2 KiB.
- **Cost** (`pricing.ts`, `pricing-service.ts`, `migrations/usage/0004_usage_cost.sql`; Workers addition, ADR 0024): each record
  stores the cost of its attempt in micro-dollars (`cost_micros`, `NULL` on records written before costs, never
  backfilled) and an `unpriced` flag (`1` = no price found), with a partial index on flagged rows. The cost is the
  token breakdown priced at the model's price: a **price override** of the org for the record's provider key and model
  (case-insensitive) wins; otherwise the models.dev price the model catalog carries (`registry/models-dev.ts` keeps
  each model's `cost`: input, output, cache read/write, reasoning and the long-context `tiers`; a model id also matches
  without a trailing `-YYYYMMDD`). `PRICE_PROVIDERS` maps a provider key to the models.dev providers whose prices
  apply (`claude` → `anthropic`, `codex` → `openai`, `gemini`/`gemini-interactions` → `google`, `vertex` →
  `google-vertex`+`google`, `antigravity` → `google`+`anthropic`, `xai`, `meta`, `opencode-zen` → `opencode`,
  `opencode-go`); subscription accounts cost the same as provider keys (API-equivalent). Devin, Kimi (models.dev lists only
  its zero-priced subscription plan) and OpenAI-compatible endpoints have no catalog price: their models are unpriced
  until an override names them. Rates are US dollars per million tokens
  and one token at $1 per million is one micro-dollar, so the cost is the sum of tokens × rate rounded once; a missing
  cache rate charges those tokens at the input rate, reasoning tokens take the output rate unless a reasoning rate is
  stated, tokens the provider reported only in total cost nothing, and a long-context tier's rates apply when the
  attempt's input exceeds its size (a rate the tier leaves out keeps the base price's). An unpriced record costs `0` and is flagged, except an attempt with no tokens at
  all (a refused request), which costs `0` and is not flagged. `UsagePricing` (`pricing-service.ts`) prices a record in
  the sink's detached `waitUntil` path, not on the request path: it reads the org's overrides through `ConfigReader`
  (a failed read is logged and the record is priced from the catalog alone) and the active catalog, then the bundled
  snapshot, so a catalog stored before costs existed still prices. The cost is fixed when the record is written: a
  later override or catalog change prices later records only, which is the intended audit behaviour. Price overrides
  are config entries in their own ControlPlane table (`config_price_overrides`, unique per lower-cased provider and
  model, with a revision like every entry) so a Go-document import, which replaces the other entry tables, leaves them
  alone; the table is created idempotently with the rest of the schema. Rates must be finite, from 0 to 100,000.
- **Retention** (`retention.ts`, cron task `usage-retention`, ADR 0027): deletes each org's records older than that org's
  `usage_retention_days` (a column of the Platform registry's `orgs` table; `null` keeps them; new orgs start at 90, `global` at `null`) in bounded batches (a deployment-wide cron
  task). The deployment variable `USAGE_RETENTION_DAYS` (default 30) is gone: the period belongs to the org and an org admin
  sets it (`PATCH /org`). `usage-statistics-enabled` and `redis-usage-queue-retention-seconds` are not used:
  persistence is always on when the `USAGE` binding exists.
- **Agent runs** (#228, ADR 0040; columns of migration `0011_usage_agent_runs.sql`, "Agent runs"): `records`, `summary`
  and `series` take `agent` (a hosted agent's id) and `run` (a run's id) filters, in whichever area the read covers, so
  a run's model attempts, tool calls and browser time read together with `area=all`. `records` names each record's
  `agent_id`, `run_id` and `starter` (`member:<id>`); the queue keeps Go's export shape and names none. A private
  agent's run's records are written `private` (`UsageRun.private`), so they are its member's alone, as
  private-credential traffic is; a shared agent's are the org's. Migration `0013_usage_private_agent_runs.sql` marks
  the records #227 wrote before that (a run's record that names a member, which only a private agent's run does).
- **Failures without a body** (difference from Go): a failed attempt's usage record keeps the upstream status, error type
  and error code, and nothing of the response body (the `fail_body` column stays `NULL`; migration `0007` clears the
  bodies stored before it). Go's queue keeps the failure body for the management API.
- **Tool calls** (#199, ADR 0038; `migrations/usage/0010_usage_tool_calls.sql`, `tools/usage/record.ts`): every call of
  Commissary's MCP endpoint that reaches a tool leaves one record in `usage_records`, beside the model attempts. The
  migration adds `area` (`models` by default, so every earlier record is a model attempt's; `tools` for a tool call),
  `toolkit_id`, `tool_id` (the stable id, `<toolkit id>:<upstream name>`), `tool_outcome` (`success`, `tool_error` for
  an upstream result with `isError`, `upstream_failure`, `refused` by a Spend limit, `needs_credential`, and under an
  approval rule `approval_pending` or `not_approved`), `request_bytes` and `response_bytes` (the UTF-8 bytes of the
  arguments and of the answered result as JSON) and `approval` (#201: `none`, `approved_elicitation`,
  `approved_panel`, `denied` or `pending`; empty on records from before approvals, _Tools_,
  "Approvals"); it holds no arguments and no results. The org, principal (an API key's
  `key:<id>` names the key), member, `private` (a private credential or a private toolkit), latency (measured in the
  endpoint, from the call's arrival to its answer), `cost_micros` (the price charged, else 0; never `unpriced`) and
  `failed` (any outcome but `success`) are the columns model attempts use. Two columns of Models' credentials are
  reused: `auth_type` holds which of the toolkit's credentials served the call (`shared` or `private`, empty when none
  did), and `auth_id` is empty (a toolkit's credential has no keyed `auth_index`); provider and model are empty too. A
  call of an unknown tool leaves no record: it names no toolkit, only what the client typed. Nor does a call whose
  ControlPlane round trip fails (the RPC, not the upstream): the endpoint never learns which tool it reached, or
  whether the ControlPlane charged it, so the gap is accepted rather than guessed at; an upstream failure is reported
  by the ControlPlane and recorded. **Tools writes its own rows** (`writeToolCallRecord`, off the response path through
  `runAfterResponse` of `@commissary/core` like the D1 sink, a failed write logged with the request id only) into the shared table, through its
  own `USAGE` binding (`ToolsBindings`): Models' writer is the model attempt's (the reporter, token accounting,
  pricing by the token) and has nothing a tool call needs, while one table keeps one set of reads, one retention task
  and one org-deletion statement, which delete by org and so cover tool calls with no change. **Reads** take `area`
  (`models`, `tools` or `all`), `toolkit` and `tool` filters; unset, they read model attempts (tool calls when
  `toolkit` or `tool` is set or the grouping is by toolkit or tool, both areas when it is by area), so a model-only
  client reads what it read before. `summary` groups by `area`, `toolkit`
  or `tool` too, `series` by `toolkit` or `tool`. A tool call's JSON adds `area`, `toolkit_id`, `tool_id`, `outcome`,
  `credential`, the sizes and `approval`, answers `auth_index: ""` (its credential is the toolkit's, not a keyed
  Models credential; `group_by=auth` keys tool calls by `""` too) and `fail: {status_code: 200}` whatever the outcome (the MCP endpoint answered 200; `outcome`
  says how it went). The queue (`.../queue`) keeps Go's export shape and hands out model attempts only (its partial
  index is rebuilt with `area = 'models'`, so the tool calls it skips are not scanned and never marked exported), and
  `.../unpriced` lists models only. The private-traffic rule applies as to model attempts. **Rollback**: migration
  `0010` is forward-only, as every migration here; code from before it reads every record as a model attempt, so
  reverting the code means first running `DELETE FROM usage_records WHERE area = 'tools'` (the migration's header
  also gives the dropped export-queue index to recreate).
- **Browser time** (#214, ADR 0039; `migrations/usage/0012_usage_browser_time.sql`): `browser_ms`, the browser time a
  browser toolkit's record holds, in milliseconds: a Quick Action's call's (what Browser Run reported for it), or a
  browser session's from opening to closing, on the one record the session writes when it closes (_Tools_, "Its
  browser time"): `area = 'tools'`, the toolkit, no `tool_id` and no `tool_outcome`, `auth_type` `shared`, the
  session's id as `request_id`, its browser time's cost at the price per browser hour as `cost_micros`, and the browser
  profile it opened from (#215) as `browser_profile_id` (`NULL` for none). The calls
  in a session keep their own records, without browser time, so a cost is never counted twice. The JSON of a tool's
  record adds `browser_ms` (and a session's `browser_profile_id`) when it has one; a session's record has no `tool_id`
  or `outcome`. Browser hours are not requests (ADR 0042): a summary and a series count a session's record toward no
  request, failure or average latency (`area = 'tools' AND tool_id IS NULL`, `usage/d1.ts`), while its cost counts in
  `cost_micros` and its browser time in the totals' `browser_ms` (the Quick Actions' and the sessions'). `NULL` on every
  other record; code from before the migration ignores the columns. Tools' org-deletion step deletes the org's
  session records once it deleted its open sessions, for one written after Models' step deleted the org's rows.
- **Computer time** (#224, ADR 0041; `migrations/usage/0014_usage_computer_time.sql`): `computer_ms`, how long a
  sandbox session's computer ran, in milliseconds, on the one record the session writes when it closes (_Tools_,
  "Computer time"), shaped as a browser session's: `area = 'tools'`, the sandbox toolkit, no `tool_id` and no
  `tool_outcome`, `auth_type` `shared`, the session's id as `request_id`, the member and the agent run (#228) that
  opened it, and its computer time's cost at the price per computer hour as `cost_micros`. The calls in a session keep
  their own records, without computer time. The JSON of the record adds `computer_ms`; a summary and a series count it
  toward no request, failure or average latency (the same `area = 'tools' AND tool_id IS NULL`), while its cost counts
  in `cost_micros` and its computer time in the totals' `computer_ms`. A session that never started its computer
  writes one too, with `computer_ms` 0 (a session opened before #224 writes none). `NULL` on every other record; code
  from before the migration ignores the column. Tools' org-deletion step deletes these records with the browser
  sessions' (`deleteSessionRecords`).
- **Management** (`models/management/usage-routes.ts`): `GET /v9/management/observability/usage/queue?count=N` (atomically pops the oldest unexported records, Go queue JSON with
  `token_breakdown`; `api_key` = Access principal id, `auth_index` = the management (keyed) `auth_index`) and the Workers
  additions `.../records` (filters `since|until|provider|model|principal|member|team|auth_index|failed`, `limit`, keyset
  `before`; `team` is the team's member ids, one `json_each` parameter so a large team stays within D1's bound parameters)
  and `.../summary` (`group_by=model|provider|principal|member|team|key|auth|endpoint|day`, totals per v2 bucket, avg latency/TTFT) and
  `.../series` (not in Go; the panel's per-account quota-window bars: `since` required, `until` default now, `bucket=hour|day`
  UTC, `group_by=auth|model|provider`, filters `provider|model|member|team|auth_index`; per key the points `{start, requests, failed,
  total_tokens}` (`acct_total_tokens`) of buckets with requests, one aggregate query; hour ranges are capped at 31 days and
  day ranges at 400, else 400). `summary` totals and groups, `series` points and `records` carry `cost_micros`; summaries
  add `unpriced_requests` and a record `unpriced` (and `member_id` when it has one). A plain member may read `records`,
  `summary` and `series` and is narrowed to their own records whatever the filters say (`member_id` = theirs, or
  `principal_id` = theirs for records without one). `.../unpriced` (filters `since|until|provider|model|principal|member|team|auth_index`)
  lists the provider and model pairs with flagged records, the busiest first, to give them a price. `GET|POST
  /price-overrides` and `PUT|DELETE /price-overrides/:id` (`price-routes.ts`, contract `prices.ts`) manage overrides like
  the model rules: `PUT` and `DELETE` carry the entry's revision in `If-Match` (`400 invalid_if_match`), `404`, `409
  conflict` (stale revision, or a second override for the same provider and model), `422 invalid_config` for a bad
  name or rate. Credentials appear as their keyed `auth_index` only: `group_by=auth` keys are mapped
  from the stored `auth_id` on read (series re-sorted by index), and the `auth_index` filter (case-insensitive) is
  resolved by the ControlPlane to the live credential's id (`credentialIdOfAuthIndex`, no D1 read); only an index of
  no live credential (deleted, or matching nothing) reads the distinct `auth_id`s of the filtered rows
  (`resolveAuthIds`, an index scan bounded by the retained records). The former `auth_id`
  filter answers 400 instead of being ignored.
- **Trace and logs** (`models/observability/`, `core/observability/`): the global `TraceLayer` middleware gives each request a `RequestTrace` (Context
  reference, `undefined` outside the router) and sets `X-CPA-TRACE-ID` = the request id (a random UUID, also the usage
  records' `trace_id`). Deviation from Go: Go sends `yyyyMMddHHmmss-<auth index>-<request id>` to every API client (none
  when no credential was selected); its unsalted index would let any client confirm key guesses, and even a keyed one
  tells a client which credential served it. Nothing here or in the Go panel parses the header; admins join a response
  to its credential through the usage record (`trace_id` → `auth_index`) or the log line. `/healthz` is exempt. One structured log line per request
  (`method`, pathname without query, `status`, `latencyMs`, `principal`, `provider`, `model`, `authIndex`, `attempts`,
  `requestId`; `authIndex` is the keyed index) through Effect logging; `WorkersLoggerLayer` (`Logger.consoleStructured`) makes Workers Logs index the
  annotations. Headers, bodies, query strings and credentials are never logged. `principal` is the Access id (`user:<email>`),
  i.e. personal data, documented in ACCESS.md "Logs and personal data" (not hashed so operators can attribute usage). Failure
  logs of cron jobs and management handlers use `core/observability/cause.ts` (`causeSummary`: tag + message, URL queries removed,
  no stack) instead of `Cause.pretty`.

## Kimi, Meta and Devin providers (`models/executor/{kimi,meta,devin}/`)

Ported from `kimi_executor.go`/`kimi_thinking_replay.go`, `meta_executor*.go`, `devin_executor.go` and the `helps/devin_*`
helpers; `oauth_scope_executor.go` is `executor/helps/oauth-scope.ts`.

- **Kimi** routes by the client protocol: Claude -> the embedded Claude executor (`makeClaudeExecutor({ profile })`, see
  `claude/profile.ts`: Kimi model naming incl. `[1m]`/K2.x aliases, the response model restored to the requested one, the
  Claude Code attribution system block stripped unless the CLI fingerprint profile is on, `count_tokens` always upstream, base
  URL = the Messages base `.../coding`); OpenAI Responses -> `{base}/v1/responses` (body kept, `NormalizeKimiResponsesInput`,
  tool schemas, temperature); everything else -> `{base}/v1/chat/completions` (`normalizeKimiToolMessageLinks`, tool schema
  inlining via `helps/inline-refs.ts`, temperature rule, `stream_options.include_usage`). Device headers: the login-time
  `metadata.device_id` (persisted in the ControlPlane with the credential) else a UUIDv5 of the credential id; device
  name/model are constants. Thinking replay for Claude callers (`kimi/replay.ts`) reuses the matcher/accumulator of
  `claude/thinking-replay.ts` over the `SessionState` DO (own store name, TTL 1 h, isolated per caller scope).
- **Meta** is the Codex Responses pipeline without replay/images: `meta/request.ts` (translate to `codex`, thinking, model/stream,
  field deletions, instructions, keep-foreign reasoning sanitising via `codex/request.ts`, `search_content_types` removal,
  payload rules with protocol `meta`), `meta/errors.ts` (`resets_at` retry, 5 min 404 cooldown, credential-scoped
  subscription quota), always-streaming upstream aggregated for non-stream callers. The shaping and the SSE response handling
  live in `helps/responses-request.ts` / `helps/responses-sse.ts`, shared with the OpenCode `responses` protocol. The lazy DCA -> API-key mint is the
  conductor's `ensureFresh` (see Token refresh); the executor only reads the minted key.
- **Devin** (`devin/`): `protobuf.ts` (varint/bytes/fixed codec), `wire.ts` (`GetChatMessageRequest`, frame decoding, trailer
  mapping, system prompt sanitising), `connect.ts` (streaming 5-byte frame parser, gzip via `DecompressionStream`),
  `interactions.ts` (client Interactions body -> prompts/tools, incl. original-request supplements), `models.ts` (UID
  resolution over the embedded/registry catalog), `payload.ts` (payload rules run on the JSON view of the protobuf business
  fields and only those fields are re-encoded), `stream.ts` (frames -> Interactions events / aggregate, tool-call ordering,
  deferred thought stops, 128 tool call cap, EOS trailer required) and `executor.ts`. Non-Interactions clients need the
  `client -> interactions` translators registered in the translator registry (`gemini` and `interactions` exist; `openai`/
  `openai-response` belong to the OpenAI-compatibility slice; `claude -> interactions` is what Claude Code needs to use Devin, see
  _Claude clients on Interactions providers_); without one the body is parsed as-is (`messages` fallback) and the response
  passes through untranslated.
- **Fixtures**: `go run ./tools/fixturegen/devin` runs the real Go `DevinExecutor` against an `httptest` Connect-RPC
  server (request bytes, Interactions events, aggregates, trailer/model-UID/frame/system-prompt helpers) into
  `packages/models/test/fixtures/devin.json`; `packages/models/test/devin-*.test.ts` compare the TypeScript output with it.
- **API-key scoping**: `withApiKeyScope` (registry) gives API-key credentials the config without `oauth.providers.*`
  (Codex, Claude, Meta, Kimi, xAI, OpenAI-compatible; not Devin). Settings imported from aliased `upstream.*` spellings lose their
  OAuth-only origin and stay global (the Go `OAuthOnlyFields` provenance is not kept).

Deviations from Go: Devin's per-session turn counter is an atomic `incr` in the `SessionState` DO (TTL 24 h, per caller scope, not an
LRU of 5000); `fetch` always sends a
User-Agent (native devin-cli sends none; the executor sets it empty); missing Devin credentials answer 401 instead of a plain
error. Kimi `/responses` and Meta bridge the Codex `apply_patch` tool through the strict function (see the xAI section for the shared
state). Executor-level apply_patch guards (`helps/apply-patch-stream.ts`, Go `EndApplyPatchStream` & co): a failing non-stream request
of a client that declares the custom `apply_patch` tool, and a non-stream call of that tool whose arguments never became valid JSON, answer
the sanitised 502; a patch-enabled Responses stream that ends without its terminator (EOF, read error, trailer error) emits the translator's one
`response.failed` frame (`state.finalizeToolInput` of the Interactions -> Responses translator) and fails with the same 502 instead of the
generic abort events. `GetUserStatus` quota/profile refresh is the cron task `devin-user-status` (`credentials/devin-status.ts`,
`ControlPlane.refreshDevinStatus`): per stored credential it writes email/user/team/plan/org into the auth file, `quota.signals`
(`daily|weekly_quota_remaining_percent`, `*_reset_at`, `plan`, `plan_start|end`) and `last_refresh`; failures leave the credential untouched.
Devin's models are catalog additions (`devin/<id>` records, no source to fetch); the executor now resolves effort variants and max tokens through
the registry snapshot (`modelLookup`, ids `devin/<id>`) before the embedded catalog. Not ported: the Kimi
`X-Msh-Device-Name/Model` of the real host, request/response debug logs, the developer-only `cmd/fetch_devin_models` live catalog probe.

## OpenCode Zen and OpenCode Go (`models/executor/opencode/`, `models/registry/opencode-*.ts`)

No Go counterpart: CLIProxyAPI reaches OpenCode only through an `openai-compatibility` entry (chat only). The Workers port has two
API-key providers, `opencode-zen` (`https://opencode.ai/inference/v1`) and `opencode-go` (`https://opencode.ai/inference/go/v1`), configured
under `api-keys.opencode-zen` / `api-keys.opencode-go` (same group/key shape as the other provider key families; `models[].protocol`
is `chat`, `responses`, `messages`, `gemini` or `systemone`). One executor (`executor.ts`) serves both keys. `models[].protocol` decodes as
any string: the normaliser drops it in every other provider section (a stray value never breaks a document), and
`decodeRawConfig` rejects an unknown value in the OpenCode sections, naming its path. The panel's OpenCode model rows offer it as a
select ("Auto (catalog)" when unset).

The defaults are OpenCode's `/inference` gateway (#178): under one base per gateway it routes every protocol path below plus
`GET models` and Go's `GET usage`, so a key group keeps a single base URL (the per-SDK prefixes `/inference/openai/v1`,
`/inference/anthropic/v1`, `/inference/google/v1beta` that models.dev now lists are not used, and the models.dev `api` field is
not read). An explicit `base-url` on the older `https://opencode.ai/zen/v1` / `…/zen/go/v1` paths is kept as written: it still
works, and is not migrated.

- **Protocol per model** (`protocol.ts`): the `protocol` of the credential's config model entry (key `models`, else group
  `models`; the key is found by `config_index` and checked against its secret), else `systemone` for a System One model of
  Zen's catalog additions (see _System One_, "OpenCode Zen"; models.dev lists none, and the additions win should it list one
  later), else the model's AI SDK package in the OpenCode catalog, mapped as OpenCode's own client does (`@ai-sdk/openai` ->
  `responses`, `@ai-sdk/anthropic` -> `messages`, `@ai-sdk/google` -> `gemini`, `@ai-sdk/openai-compatible`/`@ai-sdk/mistral` ->
  `chat`), else `chat` with a logged warning (unknown model or package). Gemini and System One exist only on Zen; on Go either
  protocol falls back to chat (and a configured `systemone` does not type the model `systemone`).
- **Paths**: `chat` -> `{base}/chat/completions` (`chat.ts`: openai-compat shaping, max-token normalisation from the entry's
  `use-max-completion-tokens`, `stream_options.include_usage`, `OpenAICompatStreamReader`); `responses` -> `{base}/responses`, always
  streamed upstream and aggregated for non-stream callers (the Responses shaping and SSE handling shared with Meta:
  `helps/responses-request.ts`, `helps/responses-sse.ts`, incl. the apply_patch bridge); `messages` -> `{base}/messages`
  (`messages.ts`: translate to Claude, non-Claude non-stream clients read a streamed answer that is validated and translated in one
  piece, `ClaudeStreamReader`); `gemini` -> `{base}/models/{model}:generateContent|streamGenerateContent` (`gemini.ts`: the shared
  Google engine as an API-key Gemini variant); `systemone` -> `{base}/systemone` (`systemone.ts`, System One requests only, see
  _System One_). Thinking and payload rules run as everywhere (payload rules last; protocol
  `openai`, `openai-response`, `claude`, the Gemini engine's or `systemone`). Token counting is local for every protocol but
  `systemone`, which has none (Gemini bodies are counted as chat). Images/video/speech entry formats and `/responses/compact` answer 501.
- **Headers** (`headers.ts`): each protocol's native auth (`Authorization: Bearer` for chat/Responses/System One, `x-api-key` +
  `anthropic-version: 2023-06-01` for Messages, `x-goog-api-key` for Gemini); `User-Agent: commissary`,
  `x-opencode-client: commissary`; `x-opencode-session` = the client's own `x-opencode-session` unchanged, else a UUIDv5
  (`providerSessionUuid("opencode", …)`) of the explicit session identity, the WebSocket execution session or the derived
  conversation identity (stable across turns, distinct across conversations), else a random UUID (OpenCode Go answers 400
  `MissingSessionID` without the header). Another client's raw session id is never forwarded. Custom headers apply last and win.
  A cloaked request (below) sends the free-tier markers instead of the plain identity.
  Only the Messages protocol sends `anthropic-beta` (`betas.ts`): the client's betas, trimmed, deduplicated and in the
  client's order, except the identity betas (`claude-code-*`, `oauth-*`, which describe the Claude Code / Anthropic-account
  client rather than the request schema and never reach a provider-key gateway), plus `mid-conversation-output-config-2026-07-01`
  when the final body has a `role: "system"` message with an `output_config` (as OpenCode's own client does), even if the client
  did not send it; with none left no header is sent, and a custom `anthropic-beta` header still wins. The other protocols send
  none. On the Messages protocol a client's `metadata.user_id` (Claude Code's device, account and session ids) is replaced by a
  stable UUIDv5 of it before the payload rules, so no raw client identity reaches the gateway.
- **Free-tier cloak** (`cloak.ts`, `session-id.ts`, `chat-collect.ts`, ADR 0033): Zen serves its free models (`free` in the
  catalog) only to requests that look like OpenCode's own client; anything else gets 403 `FreeTierError`, with or without a
  key, because the check runs before authentication. Probed 2026-10-18, it needs all of: a User-Agent containing
  `opencode/<channel>/<version>/<name>` with version >= 1.18.0 (older: 426 `UpgradeRequired`), an `x-opencode-session` in
  OpenCode's id format (`ses_` + 12 hex digits of `~(timestampMs * 0x1000 + counter)` + 14 base62; any timestamp passes, a UUID
  does not), `stream: true`, and a tool named exactly `read` (any description or schema). A cloaked request therefore sends
  `User-Agent: commissary opencode/latest/<OPENCODE_CLOAK_VERSION>/commissary` (raise the pinned version when Zen answers 426;
  `x-opencode-client` stays `commissary`), an OpenCode-format session derived from the same identities as the UUID above (a
  client's own `ses_` id is kept, any other client value is replaced), always streams upstream (a non-stream client gets the
  stream collected into one `chat.completion`), and appends a stub `read` tool described as unavailable when the client declares
  no `read` (a client without tools also gets `tool_choice: "none"`); the model's calls to the stub are removed from the answer
  (streamed and collected; the client's own calls are renumbered, a choice left without calls finishes `stop`). All of it happens
  before the payload rules. Only `opencode-zen` chat-protocol attempts are cloaked: with the key's `cloak.mode` `auto` (default)
  for free catalog models, `always` for every chat model, `never` for none; `upstream.opencode.disable-cloaking: true` forces
  `never` on every key (Settings, "Providers"). The key's mode reaches registration as the credential attribute `cloak_mode`.
  OpenCode Go, paid Zen models in `auto` and the Messages/Responses/Gemini protocols keep the plain `commissary` identity.
  Injecting one of OpenCode's system prompts also passes the check but changes what the model answers, so it is not done. A Zen
  key also needs its workspace's Privacy setting to allow free endpoints (below).
- **Errors** (`errors.ts`): `ModelProtocolUnsupported`, "Model is unavailable", "Model access is disabled" (Zen workspace
  setting), `FreeTierError` (Zen free models outside OpenCode or the cloak) and the 400 "Free models may train on request data.
  Allow free endpoints in your workspace's Privacy settings" (logged with a hint) concern one model: they become `code: model_not_found` with a
  cooldown hint (5 min for the protocol mismatch, 30 min otherwise), so the conductor cools only that model of the credential and
  tries the next credential. 401 (bad key) and 402 (no balance) are credential-scoped (the conductor skips the rest of an alias
  pool; the cooldown itself is the model-level hard cooldown of a 401/402); a Go 429 (subscription limit) is credential-scoped, a
  Zen 429 stays model-level; `Retry-After` (seconds or an HTTP date) is honoured on 429 and 5xx. Gemini engine errors are
  re-classified with the same rules, before the stream and mid-stream.
- **Usage limits** (`usage-limit.ts`, OpenCode Go): over a subscription window the gateway answers `429` with
  `Retry-After: <seconds to the reset>` and `{"error":{"type":"GoUsageLimitError","message":"5-hour usage limit reached.
  Resets in 2hr 13min. …"},"metadata":{"limitName":"5 hour"}}` (opencode console handler, last public before the
  inference gateway went closed source; "Weekly"/"Monthly" likewise). Only OpenCode Go answers are classified, and
  narrowly: the `GoUsageLimitError` type on any status, or a message that starts with "5-hour"/"Weekly"/"Monthly usage
  limit reached" on a `402`, `403` or `429` (a message merely containing the phrase, such as a `400` echoing the
  prompt, is not a limit). On a stream it applies to the error event too. It is checked before the rules above and
  becomes a credential-scoped `429` whose cooldown is the longer of `Retry-After` and the "Resets in …" duration ("2hr
  13min", "3 days", "45min", "2h 13m"; read up to the sentence's end or "To continue"), else 30 min, and at most 32
  days (a bogus header cannot park a key for longer than a monthly window): the whole key is cooled (`credential_quota`) until the window resets, so the next request goes to another key or the fallback
  without asking the gateway again. No usage fetch on the request path; the quota check reads the windows.
- **Quota** (`models/quota/opencode-go.ts`): OpenCode Go keys are listed on the Accounts page as config accounts with the
  5-hour, weekly and monthly windows of `GET {base}/usage` (see _Quota check_ and _Management API_ "Credentials").
  OpenCode Zen has no usage endpoint.
- **Key test** (`models/management/provider-keys-probe.ts`): the gateways list models without authentication, so the panel's key test
  POSTs `{base}/chat/completions` with the key, the gateway headers and the model `commissary-key-check` (`max_tokens: 1`); any
  2xx or 400 ("Model is unavailable": the key was accepted, nothing is billed) passes, 401 and other statuses fail.
- **Catalog** (`opencode-catalog.ts`): the gateways read the same models.dev document as every other provider (`opencode` and
  `opencode-go`, ADR 0020), bundled in `catalog/models-dev.json` and refreshed into KV by the one `model-catalog-refresh` task
  (see _Model registry_, "Catalogs"); there is no separate OpenCode catalog task, file or script any more. The request path
  reads the KV copy (per isolate, re-read at most once a minute) and falls back to the bundled snapshot when KV is empty or
  invalid. Without config `models` a gateway registers every non-deprecated catalog model (Zen leaves out its free models,
  flagged `free` in the trimmed document, only while the key's cloak mode is `never`: without the cloak the gateway rejects
  them), and Zen also its System One models from the catalog additions, free or not; listed models get the catalog's
  context/output limits, input modalities, reasoning levels and the protocol's registry type.

Deviations (the whole provider is one): the session header is derived per conversation instead of OpenCode's per-chat id;
Zen's free models are reached by cloaking as OpenCode (ADR 0033), unlike the plain `commissary` identity everywhere else; the
`openai-compatibility` executor is not reused (its settings come from the compat group of the credential and its User-Agent is
fixed); no `prompt_cache_key` is derived; model-scoped gateway errors use the model-not-found cooldown instead of a plain client
error; `X-Opencode-Session` from a client is also an explicit session identity for routing and usage (`handlers/session.ts`); the
OpenCode Go keys are listed as Accounts (config-sourced) for their usage windows.

## System One (`models/handlers/systemone/`, `models/executor/systemone/`, `translation/systemone/`)

No Go counterpart (ADR 0032). System One models (TypeSafe's Jev, Subquadratic's SubQ Snap) answer typed questions about
a state instead of generating text. Commissary serves them on one endpoint that speaks TypeSafe's System One API,
whichever provider serves the model, and converts per provider.

- **Endpoint** (`handlers/systemone/routes.ts`): `POST /v1/systemone`, client format and entry protocol `systemone`
  (`EntryOnlyFormats.SystemOne`, also the registry type of System One models and the payload-rule protocol of their
  requests). The body is JSON or `multipart/form-data` (the SDKs upload images that way): the first part, `request`,
  holds the JSON and the other parts are the files the JSON's `assets.<ref>.part` name. TypeSafe's multipart rules are
  checked before anything runs: unique non-empty part names, `request` reserved, every file part used by exactly one
  asset, image part types `image/png`, `image/jpeg`, `image/jpg`, `application/octet-stream` or none (else 415). The
  multipart body is split by hand (`executor/systemone/multipart.ts`), not with `Request.formData()`, which would decode
  a file part without a filename as UTF-8 text. The body limit is TypeSafe's 32 MiB (413, checked against
  `Content-Length` before reading, then the bytes read and the decoded size); `Content-Encoding: zstd` (what the SDK
  sends for bodies of 1 KiB and more) is decoded like on the other endpoints. The request then takes the normal path
  (`execute.ts`): grants and reach, spend limits, credential selection, failover and retry rounds, cooldowns, usage. The
  file parts travel next to the JSON (`ExecutorOptions.systemOneParts`) and are re-read on every attempt. There is no
  streaming, no token count, and no non-stream keep-alive: a committed 200 would hide the status TypeSafe's SDKs retry
  on. System One requests have no session: nothing of their state is derived into a session identity or routing
  fingerprint (ADR 0027).
- **Errors** (`handlers/respond.ts`, error protocol `systemone`, the third next to the OpenAI and Claude shapes): every
  error reaches the client as TypeSafe's `{"detail":{"error_type","message"}}` with its status kept. Upstream bodies are
  read with `parseUpstreamSystemOneError` (`translation/systemone/errors.ts`): TypeSafe's and SubQ's `detail` (also
  FastAPI's validation lists), OpenCode Zen's `{"type":"error","error":{…}}` and `{"error":{…}}`, and Commissary's own
  OpenAI-shaped or plain-text errors; only TypeSafe's own `error_type` is kept, otherwise it follows the status
  (`systemOneErrorType` in `@commissary/core`: 429 `rate_limit_error`, 529 `overloaded_error`, …). An upstream
  `Retry-After` (and `retry-after-ms`) of a 429, 503 or 529 is always passed through so the SDKs' retries work. The API
  Worker's gate, the authentication refusals and its 404 for a method other than `POST` answer this path in the same
  shape (`refusalResponse(…, "systemone")`). 529 Overloaded (TypeSafe's 503) cools and retries like a 503
  (`mark-result.ts`, `isCredentialRetryRoundStatus`, the conductor's `Retry-After`).
- **Model separation** (`handlers/resolve.ts`): the registry type of the model as named (prefix, alias or suffixed name)
  decides: `/v1/systemone` serves only `systemone` models and every other endpoint refuses them, each with a
  request-scoped 400. System One models are listed in `/v1/models` like any other model; the OpenAI listing adds `type:
  "systemone"` to them only. Executors that cannot serve the format refuse it (501) before doing anything
  (`withoutSystemOne`, `executor/registry.ts`; the ones that can are `SYSTEM_ONE_EXECUTORS`).
- **Catalog** (`registry/catalog/additions.json`, ADR 0020): models.dev lists none of these models, so they are catalog
  additions entirely, in sections `typesafe`, `subq` and `opencode-zen` (the last holds Zen's System One models only). A
  record carries its price (`cost`, models.dev's shape; `usage/pricing.ts` prices the model from it, ahead of models.dev
  should it list the model later, and an org's price override wins as everywhere) and its `systemOne` capabilities:
  `box` (Box questions) and `images` (`false`, or the limits `max`, `maxBytes`, `totalBytes`, `mediaTypes`). Neither
  reaches the registry's model records. Provider-key groups without `models` register their section; configured models
  and aliases are typed `systemone`.
- **Local refusals** (`executor/systemone/capabilities.ts`): a Box question on a model without Box and an image on a
  model whose `images` is `false` are refused with a request-scoped 400 before anything is sent. A model id the catalog
  does not know (TypeSafe accepts any versioned id) has no facts and is not refused here (SubQ's image limits, which are
  its API's, still apply: see "SubQ"). A refusal ends the request: a model alias spanning a provider that refuses and
  one that would not does not fail over to the second (the check is per executor, so it can become per candidate later).
- **Executor** (`executor/systemone/executor.ts`, one per provider from `specs.ts`): refusals, then the provider body
  (`spec.buildBody` from the client's JSON with the upstream model and its file parts), then the payload rules on the
  JSON only (protocol `systemone`, the final mutation; file parts are never touched), then `POST {base}/systemone` with
  `Authorization: Bearer`, the client headers the spec forwards and the credential's custom headers, as JSON or, when
  the body keeps file parts, as multipart with `request` first. Errors (`errors.ts`): 401 and 402 are credential-scoped,
  429 and 5xx (529 included) transient with their `Retry-After`. Usage (`usage.ts`) is the answer's `usage.input_tokens`
  and `output_tokens`, independent counts without cache or reasoning tokens (accounting semantics `independent`), priced
  at the catalog price. Usage records keep the status and `detail.error_type` of a failure, never a body (ADR 0027).

### TypeSafe

Provider key `typesafe` (`api-keys.typesafe`, default base `https://api.typesafe.ai/v1`). Models `jev-1.13.0`,
`jev-1.14.0` and TypeSafe's aliases `jev-latest` (1.13) and `jev-preview` (1.14), registered under TypeSafe's own ids;
$0.042 per million input tokens, output free; both take images, only 1.14 takes Box questions. A request goes on in the
form the client used: multipart stays multipart with the file parts' names, media types (parameters dropped) and bytes
unchanged (a part sent without a filename takes its part name as one), JSON stays JSON. The
`TypeSafe-Danger-Zone-Images` and `TypeSafe-Danger-Zone-Long-Context` opt-ins are forwarded. A missing key's 403 "Must
supply an API key" is credential-scoped like a 401. The key test is an authenticated `GET {base}/models` (TypeSafe's
`{models:[{name,…}]}`, not OpenAI-shaped).

### SubQ

Provider key `subq` (`api-keys.subq`, default base `https://api.subq.ai/v1`). Model `subq-snap-preview`, $0.05 per
million input tokens, output free (SubQ answers `output_tokens: 0`), no Box questions. Always sent as JSON, without
TypeSafe's opt-in headers; 402 (no credits) is credential-scoped.

- **Request** (`executor/systemone/subq.ts`, conversion in `translation/systemone/subq.ts`): SubQ's Decisions API is
  TypeSafe's except for images. Every asset, inline (`data_base64`, sent on as the client wrote it) or a multipart file
  part (read and base64-encoded), becomes an entry of SubQ's `images` (`{mediaType, base64}`) in asset order; `assets`
  is dropped, and so is an `images` field the client sent. The media type is the asset's `format` (`png`, `jpg`,
  `jpeg`, `webp`), else the part's image content type (`image/jpg` read as `image/jpeg`), else the image's first bytes
  (PNG, JPEG or WebP) for a part sent as `application/octet-stream` or without a type.
- **References**: each asset's reference in a string value of `state` or of a question's `instructions` or `criteria`
  is replaced by a positional label, `[image 1]` for the first asset and so on (object keys stay: choice option names
  are answer keys). The replacement is plain text, in one pass, longest reference first, so `img1` never replaces part
  of `img10`; but a reference that also occurs as ordinary text is replaced there too, as TypeSafe's own substitution
  does.
- **What is lost on SubQ**: TypeSafe places an image where its reference appears, for the question that names it; SubQ
  shows every image to every question, and the model sees only a label where the image was. Box questions are refused on
  `subq-snap-preview` (SubQ has none). TypeSafe's opt-ins have no SubQ counterpart: SubQ needs no header for images, and
  its context limit (384K tokens) is fixed.
- **Limits** (the catalog's `systemOne.images`: at most 4 images, 4 MiB each and 8 MiB in all decoded, PNG, JPEG or
  WebP; a SubQ model id the catalog lacks gets `subq-snap-preview`'s): the count and sizes are checked from the assets,
  `File.size` and the length of the inline base64 before any image is read or encoded (a Worker has 128 MB of memory),
  then the media types. A request over them is refused locally with a request-scoped 400.
- **Key test** (`provider-keys-probe.ts`): `POST {base}/systemone` with the smallest valid request (one noul question
  about an empty state on the group's first configured model, else `subq-snap-preview`); a 2xx is a working key, any
  other status fails the test with it (401 bad key, 402 no credits, 403 model not allowed). SubQ's `GET /models` is
  public, and SubQ validates a request's body and model before its key (an invalid request answers 422 even with a
  made-up key), so only a valid request proves the key, and a working key pays for a few dozen input tokens. That order
  was checked live with a made-up key (October 2026), never with a real one. The panel's key form offers no model
  discovery for SubQ (the test lists nothing).

### OpenCode Zen

Provider key `opencode-zen` (see _OpenCode Zen and OpenCode Go_), model protocol `systemone`
(`executor/opencode/systemone.ts`). Models `jev-1.13` ($0.042 per million input tokens, output free) and `jev-1.13-free`
($0), Zen's own ids, text only, no Box questions: the `opencode-zen` section of the catalog additions. A Zen key group
without `models` registers both next to its models.dev models, although Zen otherwise skips free models (its other free
models stay unregistered, #177); the additions decide for these ids whatever models.dev says. The protocol comes from
the same records, so a Jev model never falls back to chat (a config `protocol` still overrides it, as for any OpenCode
model). OpenCode Go serves no System One model and registers none. The client's JSON goes to `POST {base}/systemone`
(`https://opencode.ai/inference/v1/systemone` by default) with the gateway headers (Bearer key, `User-Agent` and
`x-opencode-client`, `x-opencode-session`, custom headers last) and TypeSafe's two Danger Zone opt-ins forwarded. Zen
drops `TypeSafe-Danger-Zone-Images` and rejects multipart, so an image request is refused locally from the catalog fact
(`images: false`; one change there enables images later), and file parts are refused for any model (a gateway fact, not
a catalog one). Errors are classified as on Zen's other protocols (`executor/opencode/errors.ts`): 401 and 402 cool the
key, "Model is unavailable" and the other model faults cool only the model, 429 and 5xx keep their `Retry-After`; the
body (Zen's `{"type":"error","error":{…}}`, `{"error":{…}}` or TypeSafe's `detail` passed through) reaches the client in
TypeSafe's shape. Usage and price are those of every System One provider. An org that wants TypeSafe's `jev-latest`
served by Zen defines a model alias; Commissary does not map ids across providers.

## Zero data retention (`src/platform/org-deletion.ts`, `models/org-deletion.ts`, `src/management/org-routes.ts`, `models/management/export-view.ts`)

ADR 0027: deleting something deletes it at once, and Commissary keeps no content it does not need. The pieces:

- **Retention** per org, `usage_retention_days` in the Platform registry (see "Usage accounting"), and
  `run_retention_days` for agent runs (see "Agent runs"). **Usage failures** keep status, type and code, not the body
  (same section).
- **Member removal** deletes the member's private data in the ControlPlane (`#deleteMemberData`: their API keys in the
  base, then the Models, Tools and Agents parts' `memberLeft`: Tools deletes their private toolkits and their private
  credentials on org toolkits, Agents their private agents and the agent grants and watchers that named them, and every
  run they started or their private agents ran, whose objects the route then deletes, "Agent runs"), and their Spend limits and counters; **API keys** are deleted when revoked or expired ("API keys"), and `ApiKeyStore` reports every key it
  deletes so the key's Spend limits and counters go with it.
- **Org deletion** (`deleteOrg`, called by `DELETE /org` and by account deletion, app-only) runs, in this order: the
  org-deletion steps of the areas the Worker mounts, which it takes as input (`OrgDeletionStep` of `@commissary/core`;
  Models' `deleteOrgModels`: the org's usage rows in D1, `deleteOrgUsage`, batched, tool calls' included, then its `org.<id>.…` keys in the
  `CACHE` KV namespace; Billing's sends the org's unsent usage to Polar and cancels its subscription; Tools', on
  Commissary Cloud, the org's OAuth sign-ins of MCP clients in `OAUTH_KV`: the grants and tokens of the users
  `<org>/<member>`, a page at a time), the
  `SessionState` instances it registered, its ControlPlane's whole storage (`ControlPlane.wipeOrg`: the Models, Billing
  and Tools parts drop their tables, then the rest of the SQL
  tables, the key-value store and the alarm go) and last its registry entry, which frees the slug. The registry entry goes last, so a deletion that stops half way
  (a Worker invocation has a subrequest limit: `DELETION_BUDGET`, 400 calls shared by every step; the step is named in the log) is repeated by
  sending the request again: the org is still listed and each earlier step finds less to do. `global` is refused. After the
  wipe the object keeps a `#wiped` flag: a stale in-memory ControlPlane of the deleted org answers empty for session
  instances and refuses to wipe twice; a request that still names the org's id is refused by the registry check before a
  ControlPlane is reached.
- **`SessionState` registration**: a `SessionState` instance is named by its store, caller scope and session, which hold no
  org id to enumerate. So the instance registers itself with its org's ControlPlane when it first writes
  (`state/session-state/instances.ts`, from the org-scoped store name; table `session_instances` with the expiry of the data, at
  most seven days) and org deletion wipes the registered ones. Instances written before this change are not registered: they
  hold replay state only, which expires on its own within seven days.
- **Export** (`GET /export`, `org-routes.ts` with each area's section: Models' `exportSection` in `export-view.ts`,
  Tools' in `tools/management/export-view.ts`: the toolkits the caller reaches, the kind of each credential, never a
  secret, and the overrides): the panel offers it before an org is deleted. It assembles what the org has
  from the same reads the pages use and masks every secret as a preview (`maskConfigSecrets`: secret-named keys, header
  values the header classifier calls secret or does not know, credentials in a `proxy-url`); it never carries tokens. Usage
  records are not included: the usage routes page and export them.
- **Account deletion** (`DELETE /me`): decides first (`ControlPlane.accountStanding` per org: refuse while the person is the
  only owner of an org that has other members), then deletes the orgs the person is alone in (never `global`), leaves the
  others (`ControlPlane.leaveOrg`: removes the member and their data and clears the removal note that blocks a removed
  member from auto-joining again, which only an admin removal keeps), re-syncs the registry index and drops the person's
  index rows. On Commissary Cloud the sign-in account is deleted after the last org step and before the registry forgets the
  person (`hosted/sign-in.ts` `deleteSignInAccount`, which asks the auth Worker: Better Auth's user with its sessions and
  linked accounts, in one batch on its `SignIn` database; the registry's `people` row goes with `removePerson`, so a later sign-in is a new sign-up).

## SessionState Durable Object (`state/session-state/`)

Replaces the per-process maps of `internal/cache` (and the Home KV): `SESSION_STATE.getByName(<store>:<sha256(scope, session)[:32]>)`
is one instance per store, caller scope and session key (session keys are caller-isolated by their store, either by hashing the
Access `callerScope` into the key (Codex, xAI, Kimi, Antigravity), by prefixing it (Claude) or through the `scope` address part
(Gemini cache, Devin counter)); the instance holds a handful of `key -> string` entries in SQLite. The store name is
org-scoped (`orgScopedName`: unchanged for `global`, so live sessions survive the upgrade), and so are caller scopes, so
two orgs never share an instance.

- **Protocol** (`protocol.ts`, DO method `run(ops, now)`): ops `get` (optional sliding `extendTtlMs`), `put` (TTL, `ifGeneration`,
  `maxEntries`), `delete` (`ifGeneration`) and `incr` (atomic counter), executed in order in one `transactionSync`; results are
  `ok {generation, value?}`, `conflict {generation, value?}` (the current state, so a retry needs no read) or `rejected`. Generation
  `0` is "absent"; generations are `max(last + 1, now)`, so they are never reused, not even after an empty instance deleted
  itself (no ABA on stale tokens). The clock is the _caller's_ Effect `Clock`, which is what makes TTL tests deterministic
  (`TestClock`; start it at the real time so the alarm of the Durable Object is not armed in the past).
- **Engine** (`engine.ts`) is synchronous over a `StateTable`: `SqliteStateTable` in the DO (values chunked into 256 Ki-unit rows
  because a SQLite row is limited to 2 MiB while the Go caches allow 16 MiB per entry) and `MemoryStateTable` for the in-process
  backend and unit tests. Expiry is lazy (an expired entry reads as absent) plus an alarm armed at the earliest expiry that
  deletes expired entries and, when nothing is left, the whole instance storage (`deleteAll`, tables re-created). Bounds: TTL
  clamp 1 s .. 7 d, value <= 20 Mi units, `maxEntries` per instance (oldest writes evicted, expired purged first).
- **Client** (`client.ts`): `SessionStateBackend.run(address, ops)`; `durableObjectBackend` (per-request stubs from `StateEnv`,
  never captured), `makeMemoryBackend(now?)` (bounded to 10240 instances) and `resolveBackend()` = the DO when `StateEnv`
  binds `SESSION_STATE`, else the per-isolate memory backend (unit tests, local runs without the binding).
  `updateEntry` is the compare-and-swap read-modify-write loop (`known`/`slideTtl` options save the initial read).
  Every store treats a backend failure as a cache miss (`bestEffort`, logged): a request never fails because of replay state.
- **Stores** keep their interfaces; `makeInMemory*`/`makeMemory*` constructors are the same code over a memory backend (so tests
  and production share one implementation): `codex/replay.ts` (store `codex-replay`; read = 1 RPC, append = get + CAS put),
  `xai/replay.ts`, `claude/thinking-replay.ts` (the generation is the snapshot of `replaceIfUnchanged`/`deleteIfUnchanged`; Kimi
  uses it with its own store name), `claude/continuity.ts`, `devin/credentials.ts` (`incr`, one RPC per turn),
  `gemini/replay.ts` (batched prefetch/flush), `antigravity/replay/ledger.ts` and `gemini/antigravity-interactions.ts`.
  The Claude thinking replay and continuity interfaces became Effect-returning (they were synchronous).
- **Antigravity reasoning replay** (`executor/antigravity/replay/`, Go `antigravity_reasoning_replay.go` +
  `cache/antigravity_reasoning_replay_cache.go`): `scope.ts` (session key: Claude Code scope + system lane, `Session-Id`,
  body `session_id`, `prompt_cache_key`, derived id, else the stable id of the first user turn), `request-index.ts` (request
  index, context fingerprints, ledger items of the history), `apply.ts` (eligibility, locating parts by call id / opaque Claude id /
  context / occurrence, restoring native calls and signatures, inserting missing model calls), `provenance.ts` (degrading unresolved
  reserved ids to `call_<hash>`, signing first calls, `ValidateGeminiFunctionCallPairing`), `accumulator.ts` (turns the response
  into items; committed only after a finish reason, before `response.completed` for Responses clients, otherwise before the EOF
  completion), `ledger.ts` (normalisation, 1 h sliding TTL, snapshot-guarded replace/delete with _tombstones_, so a writer that read
  an older state cannot publish over a delete), `prepare.ts` (`prepareAntigravityGeminiReasoningReplayPayload`: replay, role
  normalisation, degrade, repair, pairing check; a replay that breaks pairing is dropped and the entry invalidated; an upstream 400
  mentioning a signature clears the entry). Only Gemini-family models use it; the replay runs after the credits flag and before the
  boundary turns and the envelope.
- **Interactions continuation** (`gemini/antigravity-interactions.ts`, Go `PrepareAntigravityInteractions`): for models starting
  with `antigravity` on the native Interactions path, a completed `requires_action` interaction is stored under the conversation
  key (caller, credential, endpoint, model, session identity or hash of the input up to the last user turn) and the sorted
  pending call ids (hashed, NULs are not valid SQLite keys), TTL 30 min from the write, 1024 entries per conversation; the next
  request with only matching `function_result` steps gets `previous_interaction_id` (and `environment_id`) and just those steps.
- **Not moved (by design)**: the Responses WebSocket tool caches and xAI WebSocket id state stay in the invocation that owns the
  socket (a live socket pins its isolate; Go loses them on restart too), see "Responses WebSocket transports".
- **Deviations from Go**: the global entry caps (10240 / 4096 / 1024 entries) are per-instance bounds plus the TTL sweep (an
  unbounded number of sessions costs storage only until they expire); Codex replay session keys are caller-isolated (Go isolates
  Claude/Kimi/xAI only); Antigravity replay sessions are caller-isolated too and have no execution-session metadata key; only the
  sequential replay application of Go is ported (its batched splice path is an optimisation that "retains the exact legacy
  behavior"), and context fingerprints are self-consistent hashes (not byte-identical with Go's); the Gemini cache is per caller
  instead of global; a miss no longer reserves a tombstone (the generation of the absent entry fences concurrent writers).
- **Retention and deletion** (ADR 0027): an instance keeps its entries for at most seven days (`session-state` TTLs are
  unchanged). It registers itself with its org's ControlPlane on its first write so that deleting the org can wipe it
  (`state/session-state/instances.ts`, `SessionState.wipe`); see "Zero data retention".

## Local token counting (`translation/tokenizer/`, `models/executor/helps/token-count.ts`)

Port of the `tiktoken-go/tokenizer` usage in `helps/token_helpers.go`, `codex_executor_tokens.go` (also Meta),
`xai_executor_tokens.go`, `helps/claude_input_tokens.go` and `claude_executor_tokens.go` (gateway estimate). It replaces the
501 answers of `countTokens` for Codex, xAI, Meta and OpenAI-compatibility providers and the heuristic Claude estimate.

- **Tokenizer** (`bpe.ts`, `encodings.ts`): no npm dependency. `BpeCodec.count` is the Go `codec.Codec.Count` algorithm: the
  encoding's pre-tokenisation regex (translated to JavaScript), a whole-piece vocabulary hit counts one token, otherwise the
  piece is merged from bytes by lowest rank (leftmost wins ties); pieces over 192 bytes use an equivalent O(n log n) heap merge
  (Go's loop is quadratic). Special tokens are plain text, like Go. Encodings: `o200k_base` and `cl100k_base`; model mapping
  `encodingForModel` (`TokenizerForModel`: empty/gpt-4/gpt-3 -> cl100k, everything else o200k) and `encodingForCodexModel`
  (gpt-5/4.1/4o -> o200k, otherwise cl100k).
- **Ranks** are `translation/tokenizer/ranks/{o200k_base,cl100k_base}.bin` (`count:u32le`, then `len:u8,bytes` per token in rank order,
  1.6 MB + 0.7 MB), generated from the Go vocabularies by `go run ./tools/fixturegen/tokens`. They are Workers `Data`
  modules (Alchemy's bundler rule for `*.bin`; `modulesRules` in `vitest.config.ts`), i.e. raw bytes without JavaScript to parse. The `Map` is
  built lazily on the first `count` of an encoding (o200k ~190 ms, cl100k ~80 ms once per isolate, in workerd), so module
  load stays cheap: `wrangler check startup` reported ~105-120 ms active startup before and after the
  slice (the 1 s limit is not at risk). Bundle size grows from 946 KiB to 2419 KiB gzipped (free plan limit 3 MiB, paid 10 MiB):
  dropping `cl100k_base` would save ~0.4 MiB if the limit becomes tight.
- **Regex fidelity**: Go's `regexp2` generated matchers differ from the textbook patterns, and parity is defined by Go:
  U+007F (DEL) is never matched (dropped), `\s*[\r\n]+` ends at the first newline run (`" \n \n"` is two pieces), and `\s` is
  `unicode.IsSpace` (U+0085 yes, U+FEFF no). `encodings.ts` encodes these quirks; `strings.TrimSpace` is `goTrimSpace`.
- **Counters** (`helps/token-count.ts`): `countOpenAIChatTokens`, `countCodexInputTokens`, `countXaiInputTokens` collect segments
  of the _final_ upstream body (after payload rules) exactly like the Go collectors. Executors: Codex shapes the body like Go's
  `CountTokens` (translate with `stream=false`, thinking, model, field deletions, instructions, payload rules; no replay, cache
  key or tool-schema normalisation), OpenAI-compatibility skips max-token/cache-key shaping, xAI reuses `prepare` + payload
  rules, Meta reuses `prepareMetaRequest(..., stream=false)` after the token check. Responses are produced by the registry's
  `translateTokenCount`. Devin keeps Go's `len/4`; Claude/Kimi use upstream `count_tokens` where Go does.
- **Claude stream input tokens** (`tokenizer/claude-input.ts`): `TranslatorRegistry.translateStream` applies Go's
  `ClaudeInputTokenState` for every `claude` client served by a non-Claude provider format (all executors, including future
  ones, without per-call-site wiring): the first `message_start` whose `message.usage.input_tokens` is missing/0 gets the
  `o200k_base` estimate of the client's original request (`ResponseContext.originalRequest`); the once-per-attempt flag is
  `TranslationState.claudeInputTokensHandled`. Estimation failures leave the chunk untouched. The raw Go translator corpus
  tests set the flag so they keep exercising the bare translators.
- **Fixtures** (`packages/translation/test/fixtures/tokens.json`, `go run ./tools/fixturegen/tokens`): ~390 texts x 2 encodings (edge cases,
  scripts, emoji, whitespace/newline/DEL fuzz, long pieces), the model -> encoding table, Claude estimates, 390 `CountTokens`
  answers of the real Go Codex/OpenAI-compat/xAI/Meta/Claude executors, and 21 stream scenarios through
  `helps.TranslateStreamWithClaudeInputTokens` (real translators plus a passthrough format for framing edge cases).
  Tests: `tokenizer-parity`, `tokenizer-units`, `token-count-executors`, `claude-input-tokens`.

Deviations from Go: raw JSON segments are `JSON.stringify` output of the parsed body (Go counts raw bytes: pretty-printed tool
schemas or `1.0` numbers sent by a client count slightly differently); Unicode property tables (`\p{L}` ...) come from V8, not
Go's `unicode` package, so characters assigned after the older table can be classified differently; a stream estimate error is
silent (Go logs a warning).

## Antigravity provider (`models/executor/antigravity/`, `translation/translator/antigravity/`, `translation/signature/`)

Ported from `antigravity_executor*.go`, `internal/translator/antigravity/*`, `internal/signature`, `internal/cache/signature_cache.go`,
`internal/misc/antigravity_version.go` and `sdk/cliproxy/antigravity_models.go`.

- **Translators** (`translator/antigravity/{gemini,openai,claude,interactions}/`, registered by `antigravity/register.ts`): gemini, openai,
  openai-response (a request _envelope_ transform: native web search depends on the resolved model info), claude and interactions -> antigravity,
  each with request, stream, non-stream (and token count) transforms, all golden-tested against Go (`corpus/antigravity-*.json`,
  `test/translator-fixtures{,-ids}.test.ts`). `ResponseContext.alt` carries the Gemini `alt` option the Go handlers put in the context
  (the Gemini response translator emits nothing without it; streams always use `""`). Claude clients get Gemini signatures as
  _carrier_ thinking blocks (`cpa-gemini-carrier-v1:<direction>:<kind>:<b64>`, `claude/carrier.ts`), Claude models keep R/Q-form
  signatures, and `web_search_*` tools map to native Google Search (`claude/web-search.ts`, request building and grounding -> `web_search_tool_result`
  blocks; the capability comes from the registry record, `supportsWebSearch`).
- **Signatures** (`translation/signature/`): `claude.ts` ports the E/R/Q/CAIS validation including the strict protobuf-tree mode
  (`signature-bypass-strict`, default off) and `compatibleAntigravityClaudeThinkingSignature`; `provider.ts` the provider detection and
  `decideSignatureCompatibility` decision table for every target (claude, gemini, gpt, kimi, swe, grok); the Gemini envelope checks and replay sanitiser live in `gemini.ts` (re-exported by `translator/gemini/common/signature.ts`). `go run ./tools/fixturegen/signature` drives the real Go package over a corpus of
  synthetic envelopes (`packages/translation/test/fixtures/signature.json`, its `test/signature-fixtures.test.ts`).
- **Signature cache** (`cache.ts`, `store.ts`): translators are synchronous, so the cache they read is a bounded per-isolate map with the Go
  semantics (3 h sliding TTL, 50 char minimum, gpt/claude/gemini buckets, Gemini sentinel on a miss). It is installed around the synchronous
  translator calls with `withSignatureContext` (like `withModelInfoLookup`); persistence is the `CACHE` KV namespace behind the
  `SignatureStore` interface (`sig:<group>:<sha256(text)[:16]>`, `expirationTtl` 3 h): the executor _prefetches_ the signatures a Claude request
  needs (thinking blocks without a usable signature) before translating and _flushes_ the writes recorded by the response translator through
  `waitUntil`. Every store failure is swallowed. `antigravity.signature-cache-enabled` / `signature-bypass-strict` switch cache and bypass mode.
- **Executor** (`executor/executor.ts`): per attempt `validate Claude signatures -> prefetch -> translate -> thinking -> sensitive words ->
  Gemini signature sanitising (+ function-response role normalisation) -> credits flag -> boundary user turns -> envelope (project, requestType,
  requestId, sessionId) -> model shaping (maxOutputTokens cap/removal, schema cleaning at schema locations only, Claude `VALIDATED`) ->
  payload rules (root `request`, always last) -> fetch`. Daily endpoint unless `base_url` is set (no cross-tier fallback), header whitelist
  (`Content-Type`, `Authorization`, short `User-Agent`, `header:*` attributes). Claude, `gemini-3-pro` and `gemini-3.1-flash-image` models
  stream upstream and the SSE is merged for non-stream callers (`stream.ts`); streams filter usage (non-terminal usage becomes
  `cpaUsageMetadata`, the stop-chunk bookkeeping is per stream), join JSON split over several lines, map in-stream `error` objects to status
  errors and synthesise the terminal event only after a clean EOF. `countTokens` posts the bare request. The conductor refreshes the token
  (`needsPreparation`/401 loop); a credential without `project_id` is completed through `loadCodeAssist`/`onboardUser` (the OAuth flow code) and
  persisted with `patchCredentialMetadata`.
- **429 handling** (`errors.ts`, `state.ts`): the Go decision table (`decideAntigravity429`) and `ParseRetryDelay`; a rate limit with a delay
  under 5 min records a per-(credential, model) short cooldown (KV `ag:sc:*`, memory without a binding) and later calls answer
  `429 auth in short cooldown` without an upstream request; `retryAfterMs` of every 429 reaches the ControlPlane cooldown bookkeeping.
- **Credits** (`credits.ts`, `handlers/conductor.ts`): `quota-exceeded.antigravity-credits` enables one extra _credits round_ after the normal
  rotation failed with 429/503/`auth_not_found|auth_unavailable|model_cooldown` for Claude models: the conductor picks Antigravity credentials
  again with `PickRequest.ignoreCooldown` (cooling credentials stay selectable), skips credentials whose stored balance is known to be empty and
  asks the executor for `enabledCreditTypes: ["GOOGLE_ONE_AI"]` through `ExecutorOptions.metadata.antigravityCredits`
  (`attemptOptions`). `INSUFFICIENT_G1_CREDITS_BALANCE` marks the credential out of credits (KV `ag:credits:<id>`, 30 min); the balance probe
  (`loadCodeAssist`, prod endpoint, `waitUntil`; one probe per credential per 10 min, claimed atomically with a create-if-absent
  write in the `SessionState` DO, not KV) refreshes it. The round walks every Antigravity credential once in the Go order
  (`findAllAntigravityCreditsCandidateAuths`): known-available balances first, then unknown ones (optimistic), each group sorted by credential id;
  known-empty credentials are skipped without an attempt (the conductor collects them with repeated `pick`s and releases the skipped leases
  as connection-lifecycle failures).
- **Cron** (`models/scheduled-tasks.ts`): `antigravity-version` polls the Hub manifest into KV `antigravity:version` (`2.9.1` fallback, 6 h TTL; executors read it
  through a 60 s isolate cache) and `antigravity-models` probes `fetchAvailableModels` for every enabled credential (first endpoint only, global
  user agent, failures keep the last good list and back off 2-30 min with jitter) into KV `ag:models:<id>`. The registry snapshot attaches
  the stored entitlements to the credential's `ModelSource` (`antigravityHints`): registered models = static list intersected with the fetched
  ids, `webSearchModelIds` set `supportsWebSearch`; credentials without a record serve the static list (like Go before the probe finishes).
  The Go 1-minute scan is replaced by the 3 h cron (= the Go catalog TTL).

The **reasoning-replay ledger** (Gemini-family models) and the Interactions **continuation sessions** run on the `SessionState` DO, see
_SessionState Durable Object_.

- **Compaction**: `responses/compact` (non-stream) and `compaction_trigger` run the summary turn through the normal Gemini/Claude path and
  seal a capsule (see the Claude section); sealed items in any Responses request are expanded first. Streaming `/responses/compact` is a 400.
- **Grounding redirects** (`grounding.ts`): for Claude clients with typed `web_search_*` tools and Responses clients with a web search tool
  whose translated request holds `googleSearch`, `groundingChunks[].web.uri` values of
  `https://vertexaisearch.cloud.google.com/grounding-api-redirect/*` are resolved with `HEAD` (`redirect: "manual"`, the 3xx `Location` must be
  https) before translation, in non-stream, aggregated and streamed payloads; any failure keeps the redirect URL. Verified by
  `packages/models/test/antigravity-grounding.test.ts` (Go `antigravity_grounding_urls_test.go` scenario plus executor wiring).

Deviations from Go / not ported: per-credential HTTP pools and proxies; a bare `[DONE]` line yields nothing in the
Interactions response translator (as in Go), so the Interactions stream ends with `interaction.completed` only; short-cooldown
state and signature persistence are KV (eventually consistent), not the Go home KV.

## Signature validation (`translation/signature/`)

Full port of `internal/signature`: `claude.ts` (E/R/Q/CAIS validation incl. strict protobuf mode), `gemini.ts` (envelope
inspection, `sanitizeGeminiRequestThoughtSignatures`, `validateGeminiThoughtSignatures`, `validateGeminiFunctionCallPairing`),
`gpt.ts`, `grok.ts` (`isValidGrokEncryptedContent`, `isRecognizedReasoningSignature`), `entropy.ts`, `provider.ts` (provider
detection by structure, `decideSignatureCompatibility` with Go's `reason` strings for every target) and `claude-messages.ts`
(`sanitizeClaudeMessagesSignaturesForTarget`/`ForModel`/`ForClaudeUpstream`, in place on parsed bodies). The simplified checks of
the earlier slices (`translator/common/signature.ts`, `openai/common/signature.ts`, `common/gemini-signature.ts`, the decodable-prefix
test in `executor/claude/sanitize.ts`, Devin's approximation) are gone: the Codex/OpenAI/Claude/Kimi/xAI/Devin paths call this module.
`go run ./tools/fixturegen/signature` (`packages/translation/test/fixtures/signature.json`) records detection, decisions (incl. reasons),
Grok/GPT/recognised checks, Gemini replay, ~500 sanitiser runs over synthetic histories and Gemini validation/pairing cases;
`test/signature-fixtures.test.ts` compares them with the port (key order included).

## Codex client rewriting and compat variants (`models/executor/helps/{codex-multi-agent-v2,translate}.ts`)

- **Multi-agent v2** (`codex-multi-agent-v2.ts`, port of `internal/client/codex/optimize-multi-agent-v2`): for official Codex
  clients (User-Agent allow-list) and `client.codex.optimize-multi-agent-v2`: `prepareCodexMultiAgentV2Tools` lists the available
  models in the `spawn_agent` description and removes `message.encrypted` from the collaboration tools; the Codex executor
  additionally renames the `collaboration` namespace to `collaboration-optimize` (unless the request already uses it) and restores
  it in every response event (`restoreCodexMultiAgentV2Response`, re-serialised with `JSON.stringify`); `rewriteCodexMultiAgentV2Input`
  turns `agent_message` items into user messages for non-Codex targets (and strips `author`/`recipient` for compat models);
  `rewriteCodexOrphanDelegationInput` (`upstream.codex.orphan-delegation-compatibility` and `X-Openai-Subagent: collab_spawn`)
  downgrades orphan `codex_app` delegation outputs. The Responses handler and WebSocket frames prepare the tools once
  (`handlers/responses/codex-prepare.ts`, model list from `ModelProviders.spawnAgentSource`); executors repeat the idempotent parts
  without the model list. Fixtures: `go run ./tools/fixturegen/multiagent` (896 combinations of client identity, flags and
  compat over the real Go functions, `packages/models/test/fixtures/multiagent.json`).
- **`is-compat` models** (`translate.ts`): `translateRequestForExecutor` replaces every direct `registry.translateRequest` of the
  executors that Go routes through `helps.Translate*WithAPIKeyModelCompatibility` (Claude, Codex, Gemini/Vertex Interactions, Meta,
  OpenAI-compatibility, xAI; Kimi and Antigravity use it for the multi-agent rewrite only). The registry holds the `*WithCompat`
  request transforms (`registerCompatRequest`: claude -> codex/gemini/interactions/openai, openai/openai-response -> claude), selected
  when the resolved model info has `isCompat` (`ThinkingModelInfo.isCompat`). The Codex reasoning sanitiser keeps reasoning content
  and foreign `encrypted_content` for compat models. Fixtures: corpus `executor-compat.json` runs the Go helper itself
  (`corpusCase.executor`).

## Orgs in addresses (`src/management/org-address.ts`, `src/management/org-routes.ts`)

An org is addressed by its slug (ADR 0021), in two places, and the address is the only thing that names an org to the
management API and the panel (the client API endpoints still name it with the caller's key):

- **`/v9/management/orgs/<slug>/<route>`** and **`/o/<slug>/<page>`** (`parseOrgAddress`, `management/zones.ts`). `orgAddressing` is a
  router middleware around the whole application: it takes the org prefix out of the URL before routing, so every
  management handler and the panel page handler are written once, for an unscoped path, and run against the org the address
  names (the `CurrentOrg` they read). The unscoped path means `global`. Matching is case-, slash- and
  percent-encoding-insensitive like the rest of the classification (`/V9/Management//Orgs/Acme/settings`), and
  `/v9/management/orgs` and `/v9/management/orgs/<slug>` (no route after the slug) are not prefixes: they are the
  platform-level routes below. The CSRF guards and the admin gate see the original URL, so every rule that applies to
  `/v9/management*` and to the panel pages applies to the scoped spellings too.
- The slug is resolved by the Platform registry (`getOrgBySlug`) **after** authentication, so an unauthenticated caller
  learns nothing about which slugs exist. A platform admin gets the org; a slug the registry does not list is `404` for a
  platform admin and `403` for anyone else; a known slug then needs the caller to be a member of the org (see
  "Members, roles and teams"). A registry that cannot be reached fails a scoped address
  with `500` (the org cannot be told); the unscoped addresses need no lookup and keep working.

Platform-level routes (`org-routes.ts`, contract group `orgs`, `packages/contract/src/orgs.ts`):

| Route                              | Who            | Does                                                                                                                                                                                                                                                                       |
| ---------------------------------- | -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /v9/management/me`            | anyone         | `{platform_admin, role, orgs: [{slug, name}], deployment: {hosted, browser, computer}}`: `role` in the addressed org (`null` without one); every org for a platform admin, the orgs the caller belongs to otherwise; on Commissary Cloud also `org_limit` and `owned_orgs` |
| `GET /v9/management/orgs`          | platform admin | every org, `global` first (`suspended` on a suspended one)                                                                                                                                                                                                                 |
| `POST /v9/management/orgs`         | platform admin | creates `{slug, name}`; `201`, `409 slug_taken`, `422 invalid_slug`/`invalid_name`; on Commissary Cloud anyone signed in, up to their owned-org limit (`409 org_limit_reached`), becoming its owner                                                                        |
| `PATCH /v9/management/orgs/<slug>` | platform admin | changes `slug` and/or `name`; the id never changes, so stored data stays where it is; on Commissary Cloud also `suspended`                                                                                                                                                 |

Anyone else gets `403 platform_admin_required` on the org routes it may not use. The panel reads `/me` for its org switcher.

`deployment` (ADR 0043) is on every deployment: `hosted` is `isHosted`, `browser` is true exactly when the deployment has a
Browser Run binding, `computer` exactly when it has the sandbox's computer, each read from `env` at request time.
**The two checks are `hasBrowserBinding` and `hasComputerBinding` in `apps/app/src/management/deployment.ts`**:
the browser's is its binding (#212: the app Worker binds Browser Run, `BROWSER` in `AppBindings`, exactly when the state
Worker does, unless `COMMISSARY_BROWSER=off`, and reads only its presence). The computer's is the one piece read from a
variable rather than its binding (#223): its container is attached to the state Worker's `SandboxSession` class and
exists only as `ctx.container` inside those objects, with no binding in any Worker's `env`, so the deploy binds the
marker `COMPUTER=on` on the State and app Workers exactly when it attaches the container, from the one
`COMMISSARY_COMPUTER` setting (`@commissary/core`'s `COMPUTER_MARKER` and `hasComputer`, which both the deploy and the
checks use; the session objects check `ctx.container` themselves too). The panel reads `me.deployment.hosted` for the mode and `browser` for the Browser sessions pages and the link to them
(#216, #217: without it the pages answer Not found and nothing links to them, and Usage shows no browser time);
`computer` is exposed for #225 and unused so far.

Routes of the addressed org (`/org`, `/export`) and the account route (`DELETE /me`), all in `org-routes.ts` (ADR 0027,
"Zero data retention" below):

| Route         | Who                                 | Does                                                                                                                        |
| ------------- | ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `GET /org`    | org admin                           | the org (`OrgView`: id, slug, name, `usage_retention_days`, `run_retention_days`)                                           |
| `PATCH /org`  | org admin                           | `{usage_retention_days?, run_retention_days?: <1..3650> \| null}`, at least one; `422` for any other number                 |
| `GET /export` | org admin                           | the org's settings, masked shared config, price overrides, credential summaries, grants, members, teams, tokens             |
| `DELETE /org` | a person: org owner, platform admin | `{name}` retyped; deletes the org and everything it holds; `409 global_org`, `422 name_mismatch`, `503 deletion_incomplete` |
| `DELETE /me`  | a person                            | `{email}` retyped; leaves every org, deletes the orgs the person is alone in; `409 sole_owner`, `422 email_mismatch`        |

**Panel.** The panel of an org is the same single-page app served at `/o/<slug>/...` (the Worker answers every page path of
every org with `index.html`). The app reads its org from the address: TanStack Router's `basepath` is `/o/<slug>`, and the
typed client rewrites each request to `/v9/management/orgs/<slug>/...` except `/orgs` (`scopedApiUrl` in `@commissary/contract/api`,
`ManagementClient`'s `transformClient`; the one hand-written request, the Vertex import, does the same). The shell bar shows an
org switcher to anyone who belongs to several orgs or may create them; choosing an org reloads the app at its address. An
address without an org (`/`, `/accounts`, ...) goes through `orgRedirect` (`web-panel.ts`): a caller who belongs to exactly
one org is redirected (`302`, uncached, path and query kept) to the same page of it; otherwise the app loads without an
org and shows the **chooser** (the orgs of `/me`, and for a platform admin a form that creates one). `/?choose` skips the
redirect, so a platform admin of one org can reach the form. Bookmarks and clients of the unscoped management API are
unaffected.

## Members, roles and teams (`state/members/`, `auth/roles.ts`, `src/management/policy.ts`, `src/management/member-routes.ts`)

Workers addition, no Go counterpart (Go has one management key for everything); ADR 0022. The permission matrix and the
error codes are in `docs/ACCESS.md` "Members, roles and teams".

- **Store** (`state/members/store.ts` `MemberStore`, in each org's ControlPlane, SQLite, tables `CREATE IF NOT EXISTS`): `members`
  (permanent `mem-…` id, lowercased unique email, role, who added them), `teams` and `team_members`, `service_tokens` (Client
  ID, name, role) and one `membership` row (auto-join, whether the platform admins were seeded, a change counter and the
  change the registry's index holds) and the org setting `private_credentials` (members may connect private credentials: `1`
  for `global`, `0` for a new org unless `POST /orgs` chose it (that route sets it in the new org's ControlPlane first and
  creates the org in the registry second, so a failure creates nothing and an existing org never has another setting than
  the one chosen); `GET`/`PATCH /membership`, `/me` and the panel read it; an org
  admin changes it, and a change makes the credential pool derive again) and the org setting `private_toolkits`
  (members may add private toolkits, #198: the same defaults and the same `POST /orgs` choice; an org from before it
  takes its `private_credentials` value; the Tools part reads it on every use, _Tools_) and the org setting
  `private_agents` (members may create private agents, #226: the same defaults and the same `POST /orgs` choice; an
  org from before it takes its `private_toolkits` value, as ADR 0040 has private agents follow private toolkits, and
  `global` has it on; _Agents_). Members are not config entries: a config import replaces every entry and must not remove people. Every write takes the actor's role and
  checks it against the target in the same Durable Object call (`auth/roles.ts`: `mayManageMember`, `mayChangeRoles`,
  `mayGrantTokenRole`, `holdsSensitivePowers`), so check and write cannot interleave with another request; refusals are
  data (`{ok: false, error, message}`) that `member-routes.ts` maps to statuses.
- **Admission** (`auth/admission.ts`, called by the gates on every protected request through `AuthDirectory`): the org's ControlPlane
  answers the principal's role and member id (`admit`), joining a person as a plain member when auto-join is on; a
  platform admin is an owner without joining. The ControlPlane is asked on every request, so removing a member or lowering
  a role applies on the next one. An unreachable ControlPlane fails the request (500) unless the caller is a platform admin
  or the route is platform-level. `AccessIdentity` carries `role` and `memberId`; client API handlers write the member id into
  usage records (`member_id`, `migrations/usage/0005_usage_member.sql`).
- **Policy** (`management/policy.ts` `routeAccess`, the role table the Worker passes to `authenticateManagement` as `needs`; each area hands it its entries, `AccessRule` of `@commissary/auth`, Models' in `models/management/access-rules.ts`; the Worker's own, API keys and Spend limits, are in `policy.ts`): platform-level (no role: `/v9/management/me`, `/v9/management/orgs*`, panel
  pages without an org, `/assets`, `/management.html`), member (the client API endpoints, the org's panel pages, `GET` usage
  records/summary/series, where a plain member is narrowed to their own records: by member id, or by Access principal for
  records from before members), admin (every other management route). Owner-only and ADR 0006 checks live in the handlers
  (role changes, auto-join, service token roles above member, the credential download). A plain member also reaches the
  credential, OAuth and provider key routes Models' entries name (their own private credentials, ADR 0023); the handlers
  narrow every operation to what the caller's `Viewer` reaches (_Shared and private credentials_ above).
- **Registry index**: the Platform registry lists which orgs each person and service token belong to, for `/me` and the
  panel's org switcher. Each member or token change bumps the ControlPlane's counter; the Worker then pushes the org's lists
  (`syncOrgIndex`: `membershipIndex` → `replaceOrgIndex` → `markIndexSynced(counter)`), and admission retries a push that
  failed. A service token belongs to one org: registering one the registry indexes for another org answers
  `409 service_token_taken`.
- **Platform admins in `global`** (`MemberStore.seedPlatformAdmins`, once per ControlPlane, before member calls): the first time `global` is used, the emails in `PLATFORM_ADMIN_EMAILS` become org owners
  of it, so a platform admin has a member id there (API keys, private credentials) without adding themselves; another
  org only records that it ran (the stored flag is the `membership` column `admins_migrated`, and the rows say
  `added_by = "migration"`, names kept so stages that stored them do not seed again). Taking an email out of the variable
  later ends its platform admin rights but not its `global` membership.

## Grants (`models/grants/`, `models/management/grant-routes.ts`, `tools/grants/`, `tools/management/routes.ts`)

Workers addition, no Go counterpart; ADR 0023, ADR 0038. A grant says which upstream models of which **shared**
credentials a subject may use; selection and the model registry read it (_Credentials and selection_, _Model registry_).
A **tool grant** says which tools of which org toolkits' shared credentials a subject may use (_Tool grants_ below);
the MCP endpoint reads it (_Tools_). A model grant never touches tool reach, nor a tool grant model reach.

- **Entries** (`grants/grant.ts`, `grants/store.ts` `GrantStore`, in each org's ControlPlane, SQLite tables `grants` and
  `grant_state`, `CREATE IF NOT EXISTS`, so there is no D1 migration): a subject (`everyone`, a member id or a team id), a
  scope (`all` shared credentials, one `provider` (the executor key), or one `credential` id) and model patterns written like
  model exclusions (`matchWildcard`: case-insensitive `*`, the thinking suffix ignored; lower-cased and de-duplicated when
  stored; at least one). Each grant is a config entry in the sense of ADR 0025: a revision, `updated_at`, `updated_by`, and a
  write names the revision it is based on (`0` creates; a stale one is a `conflict`); one grant per subject and scope. The
  store keeps a counter that moves with every grant write and with every change of who is on a team
  (`membershipChanged`, called by the ControlPlane's team writes). A grant for a member or team the org does not have is
  refused, and removing a member or deleting a team deletes the grants that name them in the same call.
- **Default grant** (`GrantStore`'s constructor): the first time a ControlPlane constructs the store it writes
  "everyone, all shared credentials, `*`" and records that in `grant_state`, in one transaction. Every org (`global`
  included) therefore starts with it until an org admin deletes it; deleting it is not undone by a later start
  (`grant_state` says it was seeded).
- **Reach** (`grants/reach.ts`): the union of the grants that name a holder (`everyone`, their member id, their
  teams). `unrestricted` when a grant for all credentials gives `*`; `coversAll(credential)` when one grant gives `*` on
  the credential; `permits(credential, upstreamModel)` otherwise. There is no deny. `reachFromTable(table, memberId)`
  is the same computation for the Worker, from `grantTable()`.
- **Routes** (`grant-routes.ts`, contract `@commissary/contract/grants`): `GET /v9/management/grants` answers `{version, grants}`;
  `POST /grants` creates one (`409 conflict` when the subject and scope have one); `PUT|DELETE /grants/:id` take `If-Match`
  (`409` stale, `400 invalid_if_match` missing); an empty pattern list or a member or team the org does not have is `422
  invalid_config`. Org admins only. `GET /models/mine` answers `{models}` from `snapshot.visibleTo(caller)` for every role
  (Models' entries in `models/management/access-rules.ts`).
- **Panel** (`apps/web/src/pages/Grants.tsx`, `MyModels.tsx`, model in `apps/web/src/lib/grants.ts`): **Grants** (`/grants`, org
  admins) reads the grants by member (what reaches each member: their own, their teams' and everyone's, marked "via"), by team
  or by credential (who may use each account, provider or all of them) and adds, edits and removes them with the entry
  revision as `If-Match` (a `409` reloads the list). **My models** (`/my-models`, every member) lists the models the caller
  may use, and says what to ask for when there are none.
- **Scope of the guarantee**: the pick enforces grants against the ControlPlane's own copy, so a removed grant stops
  selection on the next request. Model lists lag by the registry's 5 s snapshot TTL. Grants never apply to private
  credentials, and Spend limits are separate (ADR 0024, _Spend limits_).
- **Tool grants** (`tools/grants/{grant,store,reach}.ts`, the Tools part, #198): the same grant (the subjects of
  `@commissary/contract/grants`, a union of the grants that name a member, no deny), kept by the Tools area in its own
  table `tool_grants` beside its toolkits. A tool grant names a subject, one **org** toolkit (a private toolkit's tools
  are its owner's and take none) and its tools: `all`, `read` (by tool class, overrides included, so reclassifying a
  tool changes what such a grant gives at once) or `named` (stable ids `<toolkit id>:<upstream name>`, at least one,
  each of that toolkit). One grant per subject, toolkit and selection: a subject may hold several on a toolkit (`read`
  and a `named` one, say), and they add up. Each is a config entry with its own revision (`1` when created, `+1` per
  write; `If-Match` on `PUT|DELETE`, a stale one `409 conflict`, a second grant of a subject on a toolkit with the
  same selection `409 conflict`, an unknown member, team or toolkit, a private toolkit, or an empty or foreign named
  tool `422 invalid`). **No default grant** (unlike `DEFAULT_GRANT` for models, ADR 0038): connecting a toolkit's shared
  credential names who may use it and writes that grant (_Tools_, "Credentials"). A named tool the toolkit's list no
  longer has is shown in the grant's `missing` and gives nothing until its source lists it again. Reach is computed on
  every list and call from the table and `core.teamIdsOf`, so a grant or team change applies at once.
  - **Why the Tools area keeps them** (#198 asked to choose): a Tools-owned store with the same subject model, rather
    than moving the `GrantStore` into the org-wide base for both areas. A tool grant's scope (one toolkit and a tool
    selection) and a model grant's (credentials and model patterns) share only the subject; the checks of a write (the
    toolkit exists and is the org's, a named tool is the toolkit's) and the reach computation need the Tools part's own
    tables, as model grants need Models'; and Models' store keeps its seeded default grant and its counter for the
    registry snapshot, which tools need neither of. Moving the store would have coupled the two areas' parts through
    the base for one shared column, and changed Models for no gain. What the two share is the subject model (the
    contract's `GrantSubject`) and the admin-only route family.
  - **Routes** (`ToolGrantsGroup` in `@commissary/contract/grants`): `GET /v9/management/grants/tools` answers
    `{grants}`, `POST /grants/tools` creates one, `PUT|DELETE /grants/tools/:id` take `If-Match`; writes answer
    `{status: "ok", id, revision}` (`0` once removed). They sit beside Models' `/grants`, so the panel's Grants page
    (#209) reads both; org admins only, by the role table's default.

## API keys (`state/api-keys/`, `auth/api-key.ts`, `src/management/api-key-routes.ts`)

Workers addition replacing the Go server's client keys (`access.api-keys`, imported but never enforced); ADR 0022. User docs:
`docs/ACCESS.md` "API keys", `docs/CLIENTS.md`.

- **Format** (`auth/keys.ts`): `cms_<org id>_<key id>_<secret>`, key id 20 hex characters, secret 36 random bytes in
  base64url. The org id is the permanent id, not the slug, so renaming an org keeps its keys working. Only the SHA-256 of
  the whole key is stored, with a display prefix (`cms_<org>_<key id>_` and 4 characters of the secret).
- **Store**: table `api_keys` in each org's ControlPlane (`CREATE IF NOT EXISTS`, next to the members tables): member id,
  name, hash, prefix, created, last used (written at most once a minute per key), expiry. Listing and revoking
  are narrowed to the caller's own keys unless the gate admitted an org admin; creating checks in the ControlPlane that
  the member exists. Nothing dead is kept (ADR 0027): revoking deletes the row (the answer still carries `revoked_at`),
  an expired key's row is deleted by the next listing, issue or presentation of it (`purgeExpired`, also the org cron
  task `api-key-expiry` for an org nobody opens), and the rows the first version kept as revoked are deleted when the
  ControlPlane starts (the `revoked_at` column stays, never written). A member holds at most 100 keys (`409
  too_many_keys`). Removing a member deletes their keys, private accounts, private key groups and OAuth logins in the
  same Durable Object call.
- **Gate** (`auth/api-key.ts`): on a client API route the first `cms_…` credential in the Go config access provider's order
  wins over everything else, including an Access JWT. Verification asks the Platform registry whether the org exists (the
  answer is trusted for 30 s per isolate) (so a made-up org id never creates a ControlPlane), then the org's ControlPlane, which compares
  hashes in constant time and answers the member's id, email and role. The answer is cached per isolate for 30 s (never
  past the key's expiry, at most 1024 keys): a revoked key, a removed member's keys and the keys of a deleted org may keep working for up to 30 s. The management
  routes that revoke do not clear this cache: the client API may run in its own Worker (ADR 0030), where they could not
  reach it, so the window is the same in every isolate. A deliberate trade against a ControlPlane round trip on every
  request (ADR 0027 asks for "at once"; the member and role checks of Access sign-ins stay per request).
- **Tool scope** (#200, `ToolScope` in `@commissary/contract/api-keys`; the `tool_scope` JSON column): a key may name the
  tools of the MCP endpoint it may use, as a tool grant selects them, per toolkit all of its tools, its read tools or
  tools by stable id (`<toolkit id>:<tool name>`); none (`null`) is every tool its member may use. It narrows the
  member's reach, never widens it: the Tools part intersects the member's reach, the scope and `?toolkits=` on every
  list and call (`ToolsPart.#keyScope`, read from the org-wide base per request, so a change applies at once). Set on
  creation (`POST /api-keys` `tool_scope`) and changed by the key's own member only (`PATCH /api-keys/:id`; another's key
  is `404`, an admin cannot widen or narrow a member's key); `422 invalid_tool_scope` for a malformed one. A key's view
  carries `tool_scope`, `tool_count` (what it may use now) and `tool_scope_missing` (ids its scope names that are gone:
  a removed toolkit or tool stays in the scope, giving nothing). `GET /tools` lists what the caller may use, by toolkit,
  for the panel's editor and the consent page of an MCP client's sign-in (_Commissary Cloud_); each toolkit also says why
  the caller reaches it (`via`, #209: their private credential, `private` once connected and `private_available` while
  the toolkit takes one and the org allows it but they have none; the tool grants that name them with the tools each
  gives; the agents toolkit), as members cannot read `GET /grants/tools`. The model routes ignore the scope.
- **Principal** `{kind: "key", keyId, memberId, email}`: usage records and logs store `key:<key id>` and the member id; the
  caller scope of session state is the member's (`user:<email>`), so a member's keys and their Access-era sessions share
  state. A key is never a platform admin, and the management zone never reads keys.
- **Access sign-ins for clients** (`membership.access_clients`, `PATCH /membership`, owner only): ADR 0022 says client API routes
  stop accepting Access sign-ins. The port keeps them in `global` behind this setting (on by default), so a deployment's
  existing `cloudflared access` clients survive the move of the client API out of Access; an owner turns it off once
  every client has a key. A sign-in names no org, so it never reaches another org, where the setting does not exist
  (`422 access_clients_global_only`). Without the
  Access edge the Worker reads the JWT from `cf-access-token` too (Access only sets `Cf-Access-Jwt-Assertion` on paths
  it guards). Service token headers cannot be honoured there: only Access turns them into a JWT, and the bypass
  application skips it.
- **Infra** (`infra/access.ts` `provisionClientApiBypass`): a second self-hosted Access application on the client API paths of the
  Worker's hostname (custom domain, or the preview's `workers.dev` URL) with a Bypass/everyone policy; Access matches the
  most specific application, so the main application keeps every other path. It is derived from the Worker's output, so
  a deploy applies it only after the new Worker, which reads `cf-access-token`, is live. `tools/check-deploy.sh` verifies
  both sides after each CI deploy, and that a `cloudflared`-style request (`cf-access-token` plus a dummy key) is served.

## Spend limits (`state/spend/`, `src/management/spend-routes.ts`)

Workers addition, no Go counterpart; ADR 0024. A Spend limit caps the Cost an org's traffic adds up to over a day, week or
month. Cost is the attempt's token breakdown at the model's price (_Usage accounting and observability_), or a tool
call's price (_Tools_), or browser time at the price per browser hour (#214), or a sandbox session's computer time at
the price per computer hour (#224); the Worker prices each attempt, the ControlPlane prices each tool call, browser
time and computer time, counts and decides.

- **Where it lives** (#199): the org-wide base, `@commissary/state/spend` (model, calendar, store, ledger and
  `SpendService`, pure modules that Node.js tests import too). The base owns the object's one `SpendService` and gives
  it to the parts as `OrgCore.spend`; Models checks and charges model attempts through it, Tools tool calls. Lifted out
  of the Models part rather than reached over an RPC from Tools because a Spend limit spans both areas (a member's,
  team's, org's or key's limit counts model attempts and tool calls together) and the store caches the limits in the
  object: one instance per object must decide, and a call between two parts of the same object would be a detour
  through the base anyway. The management side is the base's too: `spendOverview`, `createSpendLimit`,
  `updateSpendLimit`, `removeSpendLimit` and `setSpendSettings` are methods of the ControlPlane itself
  (`stub.createSpendLimit(…)`), and their routes are the app Worker's (`src/management/spend-routes.ts`, their role
  entries in `management/policy.ts`), like the API keys'. Each part's contribution stays a hook: it names the
  credentials a limit may cover (`ControlPlanePart.spendCredentials`: Models' shared credentials by `auth_index`,
  Tools' org toolkits with a shared credential) and the shared agents (`ControlPlanePart.spendAgents`, Agents' part,
  #226), so the routes resolve and label a `credential`, `toolkit_credential` or `agent` subject without the base
  knowing any area. The base forgets the limits of a member, team or
  API key it removes; a part forgets those of the credentials it removes (`spend.forget`). The refusal's wording is
  one for both areas (`spendRefusalMessage`).

- **Entries** (`spend/store.ts` `SpendStore`, in each org's ControlPlane, SQLite tables `spend_limits`, `spend_counters`
  and `spend_settings`, `CREATE IF NOT EXISTS`, so there is no D1 migration and a ControlPlane that predates the feature
  upgrades in place with no limits): a subject (`member`, `team`, `org`, `credential` (a shared one, named by its
  `auth_index`), `key` (an API key id), `toolkit_credential` (an org toolkit's shared credential, named by the toolkit's id; #199) or `agent` (a shared hosted agent, by id; #226, its runs' usage counts toward it, #228)), a period and an amount in micro-USD, written by an org admin or, on their own
  API key, by a member. Each limit has a revision and `updated_at/by`; an edit or delete names the revision in `If-Match`
  (`409 conflict` when stale). There is one limit per subject, period and writer, and the limits on one subject and period
  are enforced together, so the smaller amount binds. A member may not write a limit above an admin's on the same key and
  period (`422 exceeds_admin_limit`). A credential limit stores the credential's id and is named by its `auth_index` at the
  edge. Removing a member (with their API keys), deleting a team, removing a credential, removing an org toolkit and
  disconnecting its shared credential delete the limits and counters that name them in the same call; revoking an API key leaves its limit, which no request meets any more.
- **Calendar** (`spend_settings`, `PATCH /spend/settings`, org admins): an IANA time zone and the first day of the week;
  `UTC` and Monday until set. A day runs from local midnight to the next local midnight (`spend/period.ts`, through
  `Intl`, so a DST day has 23 or 25 hours), a week from the first day of the week, a month from the 1st. A counter is
  keyed by the start of its period, and changing the time zone or the first day of the week deletes the counters, so every
  period starts afresh under the new calendar (an old counter cannot come back when the calendar returns).
- **Counters**: only a subject with a limit has one, and only for the current period of each limit's period; an org
  without limits stores nothing and its check returns at once. A new limit counts from its creation (it does not look back
  at earlier usage), and the last limit of a subject and period drops its counter.
- **Check** (`spend/ledger.ts` `SpendLedger`, the pool's `SpendPolicy`; `credentials/selection/pick.ts`): before a credential
  is chosen the pool asks the ledger for the `SpendGate` of the caller (member, teams, API key): a **key** limit with no
  room refuses the request; a **member, team or org** limit with no room keeps the shared credentials away, so only the
  member's own private credentials may serve it, and when none can the request is refused; a **credential** limit with no
  room skips that credential like an unavailable one (the next credential serves, and with none left the answer is the usual
  `503 auth_unavailable`: the limit is the credential's, not the request's). A refusal is the pick failure `spend_limit_reached`: `429` with the OpenAI-shaped body, a message naming the
  period ("the daily Spend limit ... is reached") and `Retry-After` until the period ends. It is request-level: no
  cooldown is set on any credential and the conductor does not fail over (`spendLimitReached` stops the attempt loop).
- **Tool calls** (`ToolsPart.callTool`, `SpendLedger.refusal`; #199): a priced call is checked before the upstream is
  reached against every limit it would be charged to (the scopes below); a call has one credential to go to, so any of
  them without room refuses it, a `toolkit_credential` limit included. The refusal is a tool result with `isError` naming the
  limit and when it resets ("The daily Spend limit of this API key is reached; it resets at …"), and the call's usage
  record says `refused`. A free call (no price, or `0`) is neither checked nor charged, so it goes ahead whatever the
  limits say. The call is charged once the upstream answered with a result, an `isError` one included (the upstream
  did the work); an upstream or transport failure is not charged. As for model attempts, a call on the toolkit's
  shared credential counts toward the key's, member's, teams', org's and toolkit's limits, one on the member's private
  credential toward the key's only. As for model attempts, the check comes before the call and the charge after it,
  so priced calls running at once can each pass the check and together overrun a limit by their prices.
- **Browser time** (`ToolsPart.callTool`, `browserSessionClosed`, `tools/browser/session-object.ts`; #214, ADR 0039):
  with a price per browser hour on the browser toolkit, its browser time costs that price, prorated by the millisecond
  and rounded half up, computed exactly (`hourlyCost`, `tools/toolkits/price.ts`), on top of any price per
  call of the tool, and counts toward the same limits as the toolkit's priced calls (the key's, member's, teams' and
  org's; the browser toolkit's credential is its shared one). Each tool says what it does with browser time
  (`browserTimeOf`, from the session tools' table, `SESSION_TOOLS[...].browserTime`): the Quick Actions and the session
  tools that reach the browser use it, so with a price each call of one is checked as a priced call is (a Quick Action
  or `browser_open` is refused when a limit it counts toward has no room); `browser_close` ends it and
  `browser_profile_list` reaches no browser, so neither is checked; the crawl tools are not metered yet (#270, a
  follow-up). A Quick Action is charged its browser time (Browser Run's `X-Browser-Ms-Used`) with its call. A session's
  time is charged as it runs: each call in it charges the time since the call before, at the price in force since
  then (the session's object meters it and answers it with the call's result), and the alarm that closes an idle
  session reports the close with the last stretch to the org's ControlPlane (`browserSessionClosed`), which charges it,
  since no call is there to. A new price applies from the next call of a session on: the stretch before that call is
  costed at the price in force when it began, as a cost is a price at the time (ADR 0024). So a session's own time uses a limit up while it
  is open, and once a limit it counts toward has no room the next call in it is refused and the session closed with
  it (the tool error says so; its object writes its record). The check is on each call: between calls a session's
  time can pass a limit by up to its idle minutes' worth. Without a price browser time costs nothing and is never
  checked.
- **Computer time** (`ToolsPart.callTool`, `sandboxComputerTime`, `tools/sandbox/cloudflare/session.ts`; #224, ADR
  0041): one mechanism with browser time (`HOUR_PRICES`, `tools/toolkits/price.ts`): with a price per computer hour on
  the sandbox toolkit, the time a sandbox session's computer runs (the fallback for what just-bash cannot run, #223)
  costs that price, prorated the same way, on top of any price per call, toward the same limits as the toolkit's priced
  calls (the key's, member's, teams' and org's, or a shared agent's run's agent's and the org's, #228; the sandbox
  toolkit's credential is its shared one). Its computer runs from the command that starts it until its container's
  idle minutes after its last command ended, or until the session stops it (`computer-time.ts`), so the idle minutes
  cost as the container's do; a command that could not start the computer (its container refused, or failing before
  it reached it) adds nothing, and just-bash's time costs nothing. It is charged as it runs: each call in the session
  charges its computer time since the call before, at the price in force since then (the object meters it and the
  provider answers it with the call's result or failure, `Metered`, `SandboxError.computerTime`); when the computer
  stops by itself, its idle minutes over, the session's alarm meters that run at once and reports its cost
  (`sandboxComputerTime`, tried again until it goes through or a call answers it), and the alarm that closes an idle
  session reports the close with what is left, which charges it. Each stretch is charged once, and the session's
  record holds their sum. A member who leaves has their sessions settled as closes first (`memberLeft`, _Tools_,
  "Sessions"); the org's deletion charges and records nothing. Only the session knows whether a call meets its
  computer, so every session tool but `sandbox_open` and `sandbox_close` (`meetsComputer`, `tools/sandbox/toolkit.ts`)
  is checked, and the check's answer goes with the call (`ComputerMeter.limitReached`); once a limit it counts toward
  has no room the session decides (`#stopForLimit`). The issue's two rules read: "a running computer is stopped" (a
  call that finds the computer running stops it quietly and goes on, its result saying so: `note` on `sandbox_bash`,
  an added text on the others, `COMPUTER_STOPPED_NOTE`), and "the fallback is refused" (only a command that would run
  on the computer is refused, the refusal saying it needs the computer, and that the call stopped it when it found it
  running); so a just-bash command, a read or a list goes
  on, and the session's just-bash and files stay usable. A tool with a price per call (`sandbox_close` too) is refused
  before it reaches the session, so the part stops a running computer itself (`stopComputer`, the provider's
  operation, `stopForLimit` on the object, which is no use of the session: its idle day goes on), and the refusal
  says so. Between calls a running computer can pass a limit by up to its idle minutes' worth. Without a price
  computer time is recorded and costs nothing, and is never checked.
- **Charge** (`conductor.ts` `finish`, `usage/sink.ts` `priceForSpend`): when the lease carries limits the Worker builds the
  attempt's usage records first, prices them (`UsageSink.cost`, the same price table the D1 sink writes with, so the
  stored record and the counter agree), reports `costMicros` with `report`, and the ControlPlane adds it to every
  counter the attempt belongs to (`SpendLedger.scopes`): the key's, and, for traffic served by a **shared** credential,
  the member's, the member's teams', the org's and the credential's. A shared hosted agent's run (#228,
  `SpendCaller.agentId`) has no key and no member: it is checked (at the pick and when a retry round is planned)
  and charged as the agent, so the agent's limits and the org's apply (a refused run's turn ends with the refusal, "Agent runs"), never its starter's; a private agent's
  run is its member's traffic. Traffic served by a **private** credential is the
  member's own account with the provider, so only the key's counters see it. An org admin who reads a key limit's `spent_micros` therefore sees a total that includes
  that key's private-credential Cost, but only the total: which credential or model it went to stays with the owner. An unpriced attempt costs 0 and is never
  capped. The attempt in flight when a limit is reached finishes, so Spend can pass a limit by the Cost of the requests
  already running (ADR 0024). Alpha search publishes no usage record, so it is not charged; a key limit still refuses it.
- **`global`**: an org starts with no limits and an upgrade adds none, so nothing is limited until an org admin sets one;
  the first request of an org with no limits does no ledger work.
- **Routes** (`src/management/spend-routes.ts`, the app Worker's, contract `@commissary/contract/spend`; the role-table entries in `management/policy.ts`): `GET /spend` answers the calendar and
  the limits the caller sees with `spent_micros`, `remaining_micros`, `period_start`, `resets_at` and `editable`
  (org admins: every limit; a plain member: their own member limit, their teams', the org's and those on their API
  keys; a `toolkit_credential` limit is an org admin's, listed to admins); `POST /spend/limits` (201), `PUT|DELETE /spend/limits/:id` and `PATCH /spend/settings` (org admins only). Every
  other route above is open to members; the ControlPlane's `SpendService` decides what each may write
  (`403 forbidden` for a member on anything but their own keys, `404 subject_not_found`, `409 conflict` for a second
  limit on the subject and period, `422 invalid_limit`).
- **Usage breakdowns** (`usage/d1.ts`): `GET /observability/usage/summary?group_by=team|key` adds the cost by team (each
  team's members' records summed apart, so a member on two teams counts in both and the groups can overlap) and by
  API key (`key:<id>` principals; other sign-ins have the empty key). The private-traffic filter applies to both: a
  private-credential record is read by its owner alone.
- **Panel** (`apps/web/src/pages/Limits.tsx`, `LimitsForms.tsx`, model in `apps/web/src/lib/spend.ts`): **Limits** (`/limits`, every
  member) lists the limits the caller sees with the Spend so far, what is left and when each starts over; org admins add,
  edit and remove any limit and set the calendar, a plain member limits their own API keys. The Usage page offers Team and
  API key breakdowns beside Member.

## Authentication (Cloudflare Access)

- Access application on the app Worker's custom domain, provisioned with the Workers by `alchemy.run.ts`/`infra/access.ts`
  (Allow policy for people, Service Auth policy for the stack's service tokens, SameSite=Lax cookie; its AUD tag feeds
  `ACCESS_AUD`); no `workers.dev`/preview URLs outside previews, so Access cannot be bypassed. The client API is outside
  it ("API keys" above): there the API Worker is the only gate, and no Access application protects it. With an API host
  ("Runtime topology") the application covers the app host only and the API host has none; on a stage with one host a
  bypass application takes the client API paths, which zone routes send to the API Worker, out of Access (but `/mcp`,
  which stays the app Worker's behind Access: "MCP clients signed in through Access" below); a preview's API Worker
  answers on its own `workers.dev` URL, outside the preview's application. The application has Managed OAuth on with `ACCESS_MANAGED_OAUTH=true`.
- The Worker verifies `Cf-Access-Jwt-Assertion` (RS256, JWKS from `https://<team>.cloudflareaccess.com/cdn-cgi/access/certs`,
  `iss` = team domain, `aud` contains the application AUD tag, `exp`/`nbf`). JWKS is cached per isolate.
- MCP clients of a self-hosted Commissary sign in through Access ("MCP clients signed in through Access"); on
  Commissary Cloud, through Commissary's own OAuth server ("Commissary Cloud", "OAuth for MCP clients").
- Principal: `email` for users, `common_name` (service token client id) for service tokens. The principal replaces the
  Go `userApiKey` for usage records and the `caller_scope` hash used to isolate session state.
- Past Access, every protected request needs a role in its org (see "Members, roles and teams"): the
  `PLATFORM_ADMIN_EMAILS`/`PLATFORM_ADMIN_SERVICE_TOKENS` variables name the **platform admins**, owners of every org (checked
  first, no I/O, so one can always repair an org and the registry); anyone else is admitted by the org's
  ControlPlane. The route's policy (`management/policy.ts`) names the role it needs.
- Cross-site protections (`auth/csrf.ts`, with the Worker's routes in `src/access/csrf.ts`, before authentication; new in the port because the Access session cookie is sent by
  browsers automatically): state-changing requests are refused on protected and management zones when `Sec-Fetch-Site` is
  `cross-site`/`same-site` or `Origin` is another host; management requests of any method with a foreign `Origin` (or a
  cross-site `Sec-Fetch-Site`, unless a `GET`/`HEAD` with `Sec-Fetch-Mode: navigate` and `Sec-Fetch-Dest: document` to a
  panel page or `/management.html`: `management/zones.ts` `isPanelPagePath`; frames, `/assets` and `/v9/management*` never) too; WebSocket upgrades with a foreign `Origin`; management writes need
  JSON (multipart for `POST /credentials`, YAML for `POST /settings/import`) or no body (415). Only the API Worker has a
  CORS middleware (`apps/api/src/http/cors.ts`); the app Worker sends no CORS headers (deviation from Go's `*` on the
  management API).
- Implementation notes (`src/access/` of the app Worker, `apps/api/src/http/gate.ts`, `packages/auth`): each gate is a
  _global_ router middleware that matches path prefixes, normalising case, duplicate slashes and percent-encoding: the
  API Worker's default-denies the client API (`/v1*`, `/openai/v1*`, `/backend-api/codex*`, the unprefixed
  `/chat/completions`, `/completions`, `/responses`, and `/mcp`; not toolkits' CIMD document
  `/oauth/toolkits/client.json`, which authorization servers fetch without a key, #202), the app Worker's
  `/v9/management*` and the panel (and answers a client API path 404 before authenticating anything); each provides
  `AccessPrincipal`; route layers that read it use `withAccess(...)` (the app Worker) or `behindGate(...)` (the API
  Worker) for typing. JWKS keys are cached per isolate and refreshed on unknown `kid` at most once per 30 s (no
  cross-request locks, which workerd forbids). `ACCESS_DEV_BYPASS` only applies when the request host is loopback (i.e.
  `alchemy dev`) and is refused (warning logged once per isolate) whenever `ACCESS_TEAM_DOMAIN` or `ACCESS_AUD` is set.
- **`@commissary/auth`** (`packages/auth`, #132): request-side authentication with two entry points,
  `authenticateClient(headers, url)` (the client API) and `authenticateManagement(headers, url, {needs, slug})` (the
  management API and the panel), each picking the Access gate (`auth/access-gate.ts`) or Commissary Cloud's
  (`auth/hosted-gate.ts`); the API Worker calls the first, the app Worker the second. Each Worker owns its routes and passes in what a path needs: the app Worker the zone (`management/zones.ts`
  `classifyPath`: public, management, or the client API it refuses), the role (`management/policy.ts`), the addressed org's slug and, for the cross-site
  checks, whether a path is a panel page and which body types its route takes (`src/access/csrf.ts`); `src/access/`
  keeps the router middleware. Auth reads `AuthConfig` (raw variables, parsed per request) and reaches state only through
  `AuthDirectory`, a narrow Effect service of the ControlPlane and Platform calls it makes (`auth/directory.ts`, which
  also holds the types crossing it, such as `ApiKeyVerdict`, `Admission` and `Standing`, that the stores import); the
  adapter over the Durable Object stubs is `state/auth-directory.ts`, an in-memory one is
  `@commissary/auth/testing`. The session lookup is the auth Worker's, reached over its RPC behind auth's `SignInSessions` port. Auth
  imports `@commissary/core`, `@commissary/contract`, `effect` and `jose` only, and tests in Node.js.
- **MCP clients signed in through Access** (ADR 0045): with `ACCESS_MANAGED_OAUTH=true` (off by default while Managed
  OAuth is in open beta, as it makes Access answer the whole app host's non-browser requests `401` instead of
  redirecting them, #267) the stack's Access application has Managed OAuth on (`oauth_configuration`: dynamic client
  registration for `ACCESS_OAUTH_REDIRECT_URIS` and, with `ACCESS_OAUTH_LOOPBACK_CLIENTS`, any `localhost`/`127.0.0.1`
  redirect; `infra/access-config.ts` `managedOAuth`). Access is
  the OAuth server and resolves its opaque token into the usual `Cf-Access-Jwt-Assertion`, so the app Worker's MCP
  endpoint (`/mcp`, "Tools") authenticates such a client as it does the panel, and it acts as the person's member:
  usage and logs show the member, not the client, and cutting one client off means revoking the person's Access
  session. Alchemy's application resource sets `oauthConfiguration`, but the follow-up PUT that re-applies the cookie
  settings would reset it, so that step sends it again (with the grant the application has) and fails the deploy unless
  Cloudflare answers with it on. Managed OAuth documents DCR but not CIMD. Without it the endpoint takes the same
  Access JWT from a `cloudflared` token or a service token. With `ACCESS_AUD` the operator turns it on (docs/DEPLOY.md).
- Clients of the client API send API keys ("API keys" above). Scripts on the management API use Access service
  tokens (`CF-Access-Client-Id`/`CF-Access-Client-Secret` headers, or Access single-header mode via `x-api-key`, set on
  the Access application with `read_service_tokens_from_header`; the Worker only sees the resulting JWT, so no Worker
  code is involved). User docs: `README.md` and `ACCESS.md`, `CLIENTS.md`, `MIGRATION.md`,
  `DEVELOPMENT.md` in this directory.

## Management keys (`state/management-keys/`, `auth/management-key.ts`, `src/management/management-key-routes.ts`)

Workers addition, no Go counterpart (Go's single `remote-management.secret-key` is not ported); ADR 0026. User docs:
`docs/ACCESS.md` "Management keys".

- **Format** (`auth/keys.ts`): `cmsm_<org id>_<key id>_<secret>`, minted and parsed by the API keys' code
  (`mintOrgKey`/`parseOrgKey`) with its own prefix, so neither kind is ever taken for the other.
- **Store** (`state/management-keys/store.ts`): table `management_keys` in each org's ControlPlane (`CREATE IF NOT EXISTS`):
  name, role, issuer, hash, prefix, created and last used (no expiry; revoking deletes the row); at most 100 rows per org
  (`409 too_many_keys`).
- **Gate**: `Authorization: Bearer cmsm_…` on the management zone of either mode, before the session or Access JWT. The
  key is checked like an API key (registry `orgExists`, then the org's ControlPlane, cached 30 s per isolate, forgotten
  at once in the isolate that revokes it) and becomes the principal `{kind: "mkey"}` (`mkey:<key id>` in logs), with the
  key's role in its org and never platform admin. `AdmissiblePrincipal` excludes it: a key is never admitted by the
  member tables, and an org-scoped address of another org answers 403. On a self-hosted Commissary the Access application
  still stands in front of the management zone, so the request must pass Access as well.
- **Limits**: the role is at most the issuer's; a key never downloads a credential, registers or re-roles a service
  token, or issues a key (`management_key_forbidden`); on Commissary Cloud a key of a suspended org or issuer is refused.

## Commissary Cloud (`apps/auth`, `src/hosted/`, `auth/hosted-gate.ts`, `auth/standing.ts`)

Workers addition, no Go counterpart; ADR 0026, ADR 0030. `COMMISSARY_MODE=cloud` (`auth/mode.ts` `isHosted`) replaces
Access with Commissary's own sign-in; unset, every hosted route answers like an unknown path (`hosted/only.ts`), the gate
is the Access one, unchanged, and there is no auth Worker. User docs: `docs/ACCESS.md` "Commissary Cloud",
`docs/DEPLOY.md` "Commissary Cloud".

- **Auth Worker and hosts** (`apps/auth`, ADR 0030, #130, #132, #133): Better Auth runs in its own Worker, on the auth
  host (`COMMISSARY_AUTH_DOMAIN`, by default `auth.<COMMISSARY_DOMAIN>`; a preview's auth workers.dev URL), which alone
  binds the `SignIn` D1 database (migrations/sign-in/, Better Auth's default table names; the usage database holds
  usage records only). The sign-in page is the panel's, on the app host (`/sign-in`, `src/hosted/routes.ts`); it calls the auth host across origins, which the app
  Worker names in the page (`<meta name="commissary-auth-origin">`, `AUTH_ORIGIN`, `management/web-panel.ts`) and allows
  in the page's `connect-src`. The auth Worker answers CORS for the app origin (`APP_ORIGIN`) only, with credentials
  (`apps/auth/src/http/cors.ts`); Better Auth trusts and returns to that origin alone, and its session cookie is scoped
  to the base domain (`AUTH_COOKIE_DOMAIN` = `COMMISSARY_DOMAIN`, ADR 0031), so the app host under it receives it, as
  does every other host under it. Once the base domain is above the app host the cookie is named
  `__Secure-commissary.*` (`AUTH_COOKIE_PREFIX`, `infra/settings.ts` `BASE_COOKIE_PREFIX`), so a cookie of the same name
  still scoped to the app host from before cannot shadow it (Better Auth reads the first of two cookies of one name). A
  preview's Workers share the account's workers.dev subdomain, which its cookie is scoped to, so each preview names its
  cookie apart (`AUTH_COOKIE_PREFIX`). A Cloud preview's app origin is derived before the app Worker exists
  (`infra/preview-origin.ts`). The app host has none of Better Auth's routes.
- **OAuth for MCP clients** (#200, ADR 0036; `tools/oauth/`, `src/hosted/mcp-oauth.ts`, `apps/api/src/http/gate.ts`):
  an OAuth 2.1 authorization server on `@cloudflare/workers-oauth-provider` (`OAuthAuthorizationServer`), so an MCP
  client (Claude's connectors, Claude Code, Cursor, Codex) signs in by itself. It is on only with
  `COMMISSARY_MODE=cloud` and its three bindings, which the deploy gives the app and API Workers of the `cloud` stage
  (and `alchemy dev`), never a self-hosted stage or a preview (`mcpOAuthConfig`): `OAUTH_KV` (the library's own KV
  layout: clients, grants, tokens, consent transactions; a grant's user is `<org id>/<member id>`, so it is org data in
  the cross-org suite), `MCP_OAUTH_ISSUER` (`https://<app host>`) and `MCP_OAUTH_RESOURCE` (`https://<API host>/mcp`, or
  the app host's `/mcp` on a stage with one host). Elsewhere every path below answers like an unknown one.
  - **Discovery**: a `401` on `/mcp` names `resource_metadata` (RFC 9728), served at
    `/.well-known/oauth-protected-resource/mcp` on the resource's origin (by the API Worker, whose `hosts.ts` lets that
    path through, or by the app Worker on a stage with one host); it names the issuer, whose RFC 8414 metadata, token
    endpoint (`/oauth/token`, also RFC 7009 revocation) and dynamic registration (`/oauth/register`, RFC 7591) the app
    Worker serves through the library (public zone; the library answers CORS and wrong methods).
  - **Clients**: CIMD (the client id is an `https` URL of its metadata document, fetched behind the outbound guard)
    preferred, DCR as the fallback. Redirect URIs match exactly, except the port of a loopback redirect URI (RFC 8252
    §7.3: a native client listens on any free port); PKCE (S256) is required of every client, confidential
    ones too (Commissary refuses a request without it with an `invalid_request` redirect); `resource` (RFC 8707) must be
    the MCP endpoint, and every token is bound to it; `iss` (RFC 9207) comes back with the code.
  - **Consent**: the authorization endpoint is the panel's `/authorize` (a page section, `zones.ts`; `/o/<slug>/authorize`
    in an org), behind the panel session like any page (a browser without one goes to the sign-in page and back). The
    page posts the client's query to `POST /mcp-sign-ins` (`McpSignInsGroup`, member role), which validates it and keeps
    the request server-side in the library's KV, bound to the browser by a `__Host-` cookie; the page gets a handle and
    what to show of the client (its self-asserted name, or a CIMD client's domain; where the redirect goes, loopback or
    not). `POST /mcp-sign-ins/approve` (with the tool scope the member picked) creates **one API key** of the member in
    that org, named after the client, then completes the authorization; `/deny` answers `access_denied`. A handle works
    once, in that browser, for ten minutes; a refusal the page shows is `422 sign_in_refused`. A member's later sign-in
    of the same client (a CIMD client: from the same redirect URI) replaces the grant, as the library does, and revokes
    the replaced grant's key, best-effort: the library has deleted the grant's tokens already and nobody else holds
    the key, so a revocation that fails is logged and leaves a key no one can use in the member's list.
  - **Tokens stand for the key**: the grant's props carry the key itself, encrypted by the library with key material
    only a token unwraps, and the metadata its id. On `/mcp` the API Worker's gate swaps a bearer that is not a `cms_`
    key for the key its live access token carries (`withMcpAccessToken`) before `authenticateClient`, so the request is
    the key's in everything: usage, Spend limits, the plan's rate ceiling, the tool scope. A token of another resource,
    expired or of no grant stays as sent and is refused like a bad key; a store that cannot be read answers `503`, not
    `401`, so the client retries rather than sending its member through a sign-in again. The token endpoint checks on
    every code exchange and refresh that the key is still live (`verifyApiKey`): a revoked key answers
    `invalid_grant`, which also revokes the grant; a check that cannot be made answers `temporarily_unavailable` and
    keeps it. Revoking the key in the panel therefore signs the client out: an access token already issued may pass the gate for the verified-key
    cache's 30 s, but reaches no tool, since the tool scope of a key no longer stored is none (`ToolsPart`). A client
    that revokes its own grant (RFC 7009) leaves its key in the member's list, where nothing can use it (no token
    reaches it, and the key itself was only ever in the grant); nothing sweeps it, the member revokes it.
    No token passes through: neither these tokens nor any upstream credential cross over.
- **RPC** (`SignInService`, `auth/sign-in-service.ts`; `src/hosted/sign-in.ts`): the app Worker binds the auth Worker
  as a service (`AUTH`, Cloud only) and asks it whose session a cookie is (the gate's `SignInSessions` port), to end
  people's or a domain's sessions (a suspension, single sign-on becoming required) and to delete a sign-in account.
  A lookup that fails (no binding, a broken auth Worker) answers 500, never a signed-out 401. Changes are
  expand-then-contract, like the state RPC. The tests bind a fake of it (`test/worker.ts` `FakeSignIn`). The app Worker
  runs no Better Auth: it keeps `@better-auth/sso` and `@better-auth/core` only to check an org's OIDC discovery
  document when an admin saves its identity provider (`sso/idp.ts`).
- **Sign-in** (`apps/auth/src/sign-in/`: `auth.ts`, `sessions.ts`, `turnstile.ts`; `http/sign-in-routes.ts`): Better
  Auth (core only, social providers GitHub and Google, account linking by verified email), mounted at `/api/auth/*` on
  the auth host, of which the auth Worker passes only social sign-in, the providers' callbacks, `get-session`,
  `sign-out` and its health check `ok` (the rest answers 404). An unverified email is refused; provider tokens, IP and
  user agent are never stored (database hooks blank them). `POST /api/auth/sign-in/social` needs a Turnstile token
  (`x-captcha-response`) solved on the app host, where the widget renders, verified against `TURNSTILE_SECRET_KEY`.
  `/api/sign-in-options` tells the sign-in page the enabled providers and the Turnstile site key. A write from any
  origin but the app host's and the auth host's own is refused (`crossSiteWrite`). The app Worker asks about the
  session cookie on every request, so a session ended by sign-out or suspension stops working at once.
- **Gate** (`auth/hosted-gate.ts`, picked by the entry points when hosted): client API routes take API keys
  only (rate-limited per org and plan by the API Worker's gate after authentication, `billing/rate-limit.ts`, `429` with `Retry-After`; see "Billing"); the management zone takes a management key,
  else the Better Auth session cookie (looked up by the auth Worker over the RPC, behind auth's `SignInSessions` port), whose verified email becomes a `user` principal admitted like an Access email
  (platform admin when in `PLATFORM_ADMIN_EMAILS`). Access JWTs and service tokens are ignored. A panel page without a
  session redirects to `/sign-in?next=…`; the management API answers `401 Not signed in`. The cross-site checks
  (`auth/csrf.ts`) run first, as on a self-hosted Commissary.
- **Standing** (`auth/standing.ts`, Platform registry `signIn`/`standing`): the auth Worker signs a person up before their
  first session starts (`ensureSignedUp`, #132), creating a Personal org they own unless the person-to-orgs index
  already lists them (invited), and starts no session for a suspended person; `admitPrincipal` never
  auto-joins anyone to `global` on Commissary Cloud, whatever its stored setting. The registry records
  `people` (owned-org limit, suspension) and each org's `created_by` (owned orgs are counted by it) and `suspended_at`.
  Every request checks that neither the person nor the org is suspended, cached 30 s per isolate and forgotten at once
  where a suspension is made; suspending also ends the person's (or the org members') sessions, over the RPC.
- **Per-org single sign-on** (`src/sso/`, `@commissary/auth/sso`, `apps/auth/src/sign-in/sso-adapter.ts`, `management/sso-routes.ts`; issue #76): each org's one
  identity provider (OIDC or SAML, sealed with the org's data key) and its email domains live in its ControlPlane
  (`state/sso/store.ts`); the Platform registry keeps the index of verified domains (`sso_domains`, one org per domain, with
  `require_sso`) that a sign-in looks up. A domain is proved by a DNS TXT record read over DNS over HTTPS (`sso/dns.ts`).
  Better Auth's SSO plugin runs the OIDC (PKCE) and SAML flows, but its `ssoProvider` model is never in D1: the adapter
  wrapper answers it from the org's ControlPlane by provider id (`sso-<org id>`, `auth/sso/provider.ts`), so no migration is
  needed and nothing writes it (the plugin's registration and domain-verification routes are not passed). `POST
  /api/auth/sign-in/sso {email}` is rewritten by the auth Worker to the provider of the org holding the email's domain
  (the providers send people back to the auth host: the settings name its URLs, `AUTH_ORIGIN`). A
  completed SSO sign-in is admitted by `ControlPlane.admitThroughSso` (the email's domain must be one the org verified;
  a removed person is refused until re-added), which joins the person as a `member` instead of creating a Personal org.
  Requiring SSO for a domain makes the social sign-in hook refuse that domain (`sso_required`) and deletes the D1
  sessions of everyone at it. Refusals redirect to the app host's `/sign-in?error=<code>`. Differences from Better Auth's own
  organization SSO: providers are not stored by the plugin, domain proof uses our own TXT record, and membership is the
  Commissary's, not the plugin's.
  The plugin's dependencies (samlify, xmldom, xpath) are imported lazily, but every module of the bundle is still
  compiled at Worker startup, which has a CPU time limit: `infra/bundle.ts` aliases `tldts` to a host-name stand-in
  (`auth/sso/tldts.ts`) and `pnpm-workspace.yaml` keeps one copy of xpath.
- **Platform-level routes**: `POST /orgs` for everyone signed in, up to the owned-org limit; `PATCH /orgs/<slug>
  {suspended}` and `GET|PATCH /people/<email>` (`people-routes.ts`) for platform admins.
- **Downloads**: only platform admins download a stored credential (`download_requires_platform_admin`), since no
  service token exists to carry ADR 0006's rule.
- **Infra**: `alchemy.run.ts` creates no Access application or bypass on Commissary Cloud; it creates the auth Worker and
  its `SignIn` database, mints `BETTER_AUTH_SECRET` as an Alchemy `Random`, and binds the sign-in settings to the auth
  Worker, the auth Worker to the app Worker, and the `FREE_RATE_LIMIT` and `PAYG_RATE_LIMIT` rate-limit bindings to the API
  Worker (`infra/settings.ts` validates their namespaces). Deploy order: state, auth, app, API (a preview: state, API, auth, app). CI deploys
  a preview as Commissary Cloud while its pull request has the `cloud-preview` label and checks it with
  `tools/check-cloud-deploy.sh`; `COMMISSARY_MODE=cloud pnpm smoke` runs it under `alchemy dev`.

## Billing (`billing/`, `models/handlers/metering.ts`, `apps/api/src/http/gate.ts`, `billing/routes.ts`)

Workers addition, no Go counterpart; ADR 0042, #236, #237. Commissary Cloud's plans: every org holds one, `free` or
`payg`, and has a month's **free usage** counted in its ControlPlane; Pay as you go is billed through Polar and stopped
by the org's **billing cap** (#238). The other units come later (#241). **A self-hosted Commissary has none of it**:
the package checks `isHosted` before it counts, refuses or reads anything, and its routes answer 404.

- **Seam** (`codebase-design`): Billing is an area package (`packages/billing`, entries `./api`, `./management`,
  `./state`, `./testing`, lint rule `boundaries/billing-imports`) that imports no other area. What callers see is small:
  `countRequest` / `uncountRequest` (Models), `limitClientRate` and the cron task (the API Worker), the `/billing`
  routes, their role-table entries, Polar's webhook route and the org-deletion step (the app Worker) and `BillingPart`
  (the state Worker). Models imports `@commissary/billing/api` (the lint rule lets another
  package's sources import only `./api`); Billing imports `@commissary/auth` (`isHosted`), `@commissary/state` (stubs,
  `ControlPlanePart`), `@commissary/core` and `@commissary/contract`.
- **The part** (`billing/part.ts`, `store.ts`): tables `billing_plan` (one row; none means `free`, so an org that existed
  before plans needs no backfill and nothing of past usage is counted) and `billing_usage` (`month_start`, `unit`,
  `amount`; a row appears with the month's first use, so a new month starts at zero by itself, like the spend counters of
  `state/spend/store.ts`, and nothing is derived from the D1 usage records). `admit(now)` is one synchronous step of the
  object: a Free org (or a Pay-as-you-go one that is past due, `limitsPlan()`) with `requests` at the free usage is
  refused (and not counted), anything else is counted, on either plan; `refund(monthStart)` takes a count back. `usage(now)` reads the plan and the month. Hours of the other two units
  are stored as `REAL` and read 0 until #241 counts them. `setPlan` stores the plan directly (tests; Polar's webhooks go
  through `applySubscription`). Three tables serve Polar (#237): `billing_account` (one row: the Polar customer, the
  current subscription, the payment state `ok`/`past_due`, and Polar's `modified_at` of the last change applied),
  `billing_meter_sent` (what was sent of each unit and month) and `billing_meter_batch` (the one batch on its way).
  `billing_cap` (#238) holds the billing cap org owners set (`setBillingCap`, dollars a month or `NULL` for none; no
  row: the default $50). `usage(now)` also answers the month's bill and the cap. `billing_overrides` (#240) holds what
  a platform admin set: unbilled, and raised ceilings. `wipe()` drops all seven.
- **Constants** (`billing/plan.ts`, ADR 0042): free usage `25,000` requests and tool calls, 1 browser hour, 0 computer
  hours; request-rate ceilings 60 a minute on Free and 600 on Pay as you go; Pay as you go's rates above free usage,
  $0.50 per 100,000 requests and tool calls and $0.15 a browser or computer hour, and the default billing cap, $50 a
  month (`billing/bill.ts`). Amounts are summed in micro-dollars (5 µ$ a request), so a month's bill is exact and
  compares with a cap without floating-point drift; the API speaks dollars. The Polar product's prices must equal
  these rates (`docs/DEPLOY.md` "Polar"). The month is the calendar month in UTC
  (`billing/month.ts`); the Worker side passes `Clock.currentTimeMillis` to the object, so tests drive it with `TestClock`.
- **Counting and the plan limit** (`billing/meter.ts`, `models/handlers/metering.ts`): only a **Request** counts
  (GLOSSARY: one model call a client makes). `executeNonStream`, `executeStream` and the Codex alpha search wrap their
  work in `metered`: before any work it calls `countRequest` once, so a request counts once whatever its credential
  (shared or private), outcome or number of attempts (stream bootstrap retries and failover are inside the one request).
  A Free org over its free usage is refused first with `429 plan_limit_reached`: `Retry-After` the seconds until the
  first of the next month UTC, a JSON error (`code`, `message`, `limit`, `allowed`, `resets_at`, `reset_seconds`, like
  `spend_limit_reached`'s; the alpha search answers the same body) whose message names the limit and links to the
  panel's billing page (`https://<app host>/o/<slug>/billing`, built in #239, through `panelPageUrl`; the words "the
  billing page of the panel" without an app host or when the registry cannot name the slug). Work in flight finishes. A
  request counts if it **did work**: the conductor marks the request when it makes its first upstream attempt
  (`markWorked`), and one that fails without it (a spend limit, an unknown model or provider, no credential to pick,
  `auth_not_found`) gives the count back (`uncountRequest`), while a later round's spend stop does not take back a
  request that already did work. Not counted: a request refused before Models serves it (authentication, the rate
  ceiling) or by the plan limit; a body that does not parse (rejected before execution); **token counting**
  (`executeCountTokens`) and **polling a video** (status and content retrieval, which run `executeNonStreamUnmetered`),
  which are not Requests; model listings and other reads. A Billing part that cannot be reached lets the request through
  (logged): serving needs the same object. An isolate remembers a refusal for 30 seconds (`billing/cache.ts`; the
  registry lookup of the org's slug for the link, which the client API's key (an org id) does not carry, runs once per
  refusal), so a client that retries against the limit does not reach the ControlPlane.
- **Billing cap** (`billing/store.ts` `admit`, `billing/bill.ts`, #238): what Commissary Cloud may bill a Pay-as-you-go
  org in a month, default $50, which org owners set to any amount from $0 in whole cents or remove (`PATCH /billing`);
  Polar has no customer spending cap, so Commissary enforces it (ADR 0042). The month's bill is computed from the
  counters at the rates above, above free usage, whatever the plan. A Pay-as-you-go org's request that would be billed
  (its free usage of requests is used up) and would take the bill past the cap is refused like Free's limit (one test,
  `capRefusesNextRequest`, which the 100% notice uses too): `429 plan_limit_reached`, `Retry-After` to the first of the
  next month UTC, the body's `limit` `billing_cap` and `allowed` the cap in dollars, a message that names the cap and
  links to the billing page. So the request that brings the bill to exactly the cap is served, and use within free
  usage is never refused, even at a cap of $0. A past-due org is held to Free's limits, so the cap does not apply to
  it. Work in flight finishes. Changing the cap takes effect at the next request in the isolate that changed it
  (`forgetBilling`) and **within 5 seconds on the client API**: the app Worker cannot clear the API Worker's isolates,
  so they remember a refusal by the cap for 5 seconds only (`BILLING_CAP_REFUSAL_TTL_MS`), not Free's 30.
- **Request-rate ceiling** (`billing/rate-limit.ts`): two Workers rate-limiting bindings on the API Worker,
  `FREE_RATE_LIMIT` (60 a minute) and `PAYG_RATE_LIMIT` (600), keyed by org id; the plan whose limits apply (a
  `limitsPlan()` call to its Billing part: Free's while a Pay-as-you-go org is past due; cached per isolate for 30
  seconds like `@commissary/auth`'s standing) picks one. The API Worker's
  client gate calls `limitClientRate` after authentication and the standing checks (it left `@commissary/auth`'s hosted
  gate, which no longer knows plans), so every client-facing surface behind that gate is covered, and the MCP endpoint
  (#197) and webhook triggers (#231) join it by sitting behind the gate or calling the same function (a proven
  delivery; every delivery is counted before its proof on a bucket of its own in the same bindings,
  `limitWebhookAttempts`, key `webhook:<org>`, so unproven ones never use up the org's ceiling). The management API has
  none. Like before, a deployment without the bindings has no ceiling and a failing binding lets the
  request through (logged); an org whose plan cannot be read gets Free's ceiling. The ceilings are constants; only the
  namespaces are deployment settings (`ORG_RATE_LIMIT_NAMESPACE_ID`, `ORG_RATE_LIMIT_PAYG_NAMESPACE_ID`, `docs/DEPLOY.md`).
  Since the bindings' limits are fixed, an org whose rate a platform admin raised above its plan's is counted by its
  Billing part instead (`rateCeiling()` says which, cached like the plan; `admitRate(now)`: fixed one-minute windows
  counted in the object's memory, so a restart starts the minute over), one ControlPlane call per request for that org
  only; a part that cannot be reached lets the request through (logged).
- **Management API** (`billing/routes.ts`, `@commissary/contract/billing`): `GET /v9/management/billing` answers the plan,
  the payment state (`payment`: `ok` or `past_due`), whether the org's Polar customer has a card on file (`card_on_file`:
  asked of Polar on each read; `false` before the first checkout or without Polar, `null` when Polar cannot be asked),
  the month's start and end and, for each unit, `used` and the `free` usage, the billing cap (`billing_cap`, dollars,
  `null` for none), the month's bill so far (`bill`, dollars), Pay as you go's rate of each unit above free usage
  (`rates`: `dollars` per `per` of it, from `PAYG_RATE_MICROS` and `PAYG_RATE_PER` in `billing/bill.ts`, so the panel
  states the rates the bill counts at) and the **notices** (`billing/notices.ts`); any org admin
  may read it (the role table's default; `docs/ACCESS.md`). Units not counted yet read 0. Commissary sends no billing
  email (ADR 0042): the notices are state the panel (#239) shows owners and admins. `free_usage` (a unit, 80 or 100):
  where Free's limits apply (on Free, and on Pay as you go while past due), at 80% and at 100% of a unit's free usage,
  for the units that have some; `billing_cap` (80 or 100): on Pay as you go, at 80% of the cap and at 100% exactly when
  the cap refuses the next request (none without a cap; a cap of $0 shows 100% once free usage of requests is used
  up); `payment_failed`: while past due, first, with no link (a read asks Polar for nothing more than the card on
  file). The panel opens Polar's customer portal through `POST /billing/portal` when an org owner follows the notice,
  and tells admins who are not owners to ask an owner, since only owners may change the payment method.
  `PATCH /billing {"billing_cap": <dollars> | null}` sets or removes the cap and answers the overview: `400` for
  another shape, `422 invalid_billing_cap` for an amount below 0 or in fractions of a cent. It is for org owners only
  (Billing's `accessRules`, `PATCH` only) and works on any Commissary Cloud stage (it needs no billing provider).
  `POST /billing/checkout`, `POST /billing/portal` and
  `POST /billing/plan {"plan":"free"}` are for org owners (Billing's `accessRules`, which the app Worker's role table
  lists) and exist only with a billing provider (see below), else they answer 404 like an unknown path.
- **Pay as you go through Polar** (`billing/provider.ts`, `providers.ts`, `polar.ts`, #237). Polar is the merchant of
  record (ADR 0042) behind a small adapter, `BillingProvider` (create customer, start checkout, portal link, payment
  method on file, send meter events, cancel subscription, verify and read a webhook), so Stripe direct stays possible.
  `BillingProviders`, a `Context.Reference`, picks the provider of an invocation from its bindings: Polar when the stage
  is Commissary Cloud and has `POLAR_ACCESS_TOKEN` and `POLAR_PRODUCT_ID`, none otherwise; tests provide a fake
  (`@commissary/billing/testing` `fakeBillingProvider`). Only the app Worker takes webhooks, so only it is given
  `POLAR_WEBHOOK_SECRET`; without it the provider has no webhook check and `POST /webhooks/polar` does not exist (the
  API Worker, which only sends usage, does without it). A stage still sets all three or none (`infra/settings.ts`). Polar's REST API is called with `fetch` (no
  SDK), on `https://api.polar.sh` where `POLAR_SERVER=production` (the `cloud` stage) and `https://sandbox-api.polar.sh`
  elsewhere. Polar's host is fixed by the code, not supplied by anyone, so these calls do not go through the outbound
  guard.
  - **Customer**: each org is one Polar customer, created by its first `POST /billing/checkout` (`external_id` the org
    id, email the owner who started it, name the org's) and recorded in `billing_account`. Polar requires customers'
    emails to be unique, so a person can be the billing email of one org: a second org's checkout by them answers
    `409 billing_email_taken`. This is a known limit: someone who pays for several orgs needs another email for each
    (Polar's team customers would lift it, at the cost of a Polar member per org member who may open the portal). Polar's customer portal (`POST /billing/portal`, a customer session) handles invoices,
    receipts, the payment method and a tax ID. The checkout's success and return URLs are the org's billing page on the
    host the request came to (`/o/<slug>/billing`).
  - **Product**: one recurring Pay-as-you-go product with three metered prices, one per unit, whose meters sum
    `metadata.units` of the events named `commissary_requests`, `commissary_browser_hours` and
    `commissary_computer_hours` (`polar.ts` `METER_EVENT_NAMES`), at ADR 0042's rates, with no minimum. Its id is a
    deployment setting (`POLAR_PRODUCT_ID`); the meters and prices are set up in Polar and the code needs no id of
    theirs (`docs/DEPLOY.md` "Polar"). **Whether Polar accepts a $0 fixed price beside the metered prices has not been
    tested in Polar's sandbox yet** (it needs a Polar account); until it is, the product has only metered prices, the
    fallback ADR 0042 names. To be checked in the sandbox: #274.
  - **Free usage is excluded by sending only what is above it**: for each month and unit, the usage above free usage
    minus what was already sent (`billing_meter_sent`). Polar bills every unit it receives, so its prices need no free
    tier or credits benefit, and an org that never goes over free usage sends nothing.
  - **Webhooks** (`billing/webhook.ts`): `POST /webhooks/polar` on the app host, public (the `public` zone; the
    signature is the credential), mounted by the app Worker outside the Access gate. Standard Webhooks signatures
    (`webhook-id`, `webhook-timestamp` within 5 minutes, `webhook-signature` `v1,<base64 HMAC-SHA256>` keyed by
    `POLAR_WEBHOOK_SECRET`'s bytes, compared with `crypto.subtle.verify`); unsigned or wrongly signed: `401`. The
    body is parsed only once its signature is verified. Every
    `subscription.*` event of the Pay-as-you-go product is read from the subscription it carries: `active`/`trialing`
    → Pay as you go, payments `ok` (upgrades take effect at once); `past_due` → Pay as you go flagged `past_due`, held to
    Free's limits until a payment succeeds; `canceled`, `unpaid`, `paused`, or `active` set to cancel at the period's end
    → Free. The org is the customer's `external_id`, confirmed by the Platform registry (an org that no longer exists is
    acknowledged and ignored). `applySubscription` ignores a change older than the last one applied (Polar's
    `modified_at`), the end of a subscription other than the current one, and any change but becoming active again
    about the subscription that ended last (`billing_account.ended_subscription_id`: one cancelled at the end of its
    period still reports its last invoice, `past_due` if unpaid, after the org went to Free), so Polar's unordered,
    repeated deliveries come to the same state; the handler answers `200` once the part stored it, `503` when it cannot (Polar delivers
    again). Nothing is deleted or suspended for non-payment: a revoked org is on Free with its data.
  - **Plan changes and caches**: the code that switches a plan (the webhook, `POST /billing/plan`) calls
    `forgetBilling(org)`, so the isolate that made the change sees it at once; every other isolate (the API Worker's
    rate ceiling and plan-limit refusals) sees it within the 30 seconds it caches billing (`billing/cache.ts`). This is
    what ADR 0042's "upgrading takes effect at once" means in practice.
  - **Switching to Free** (`POST /billing/plan`): sends the usage not sent yet, cancels the subscription in Polar at the
    end of its period (`PATCH /v1/subscriptions/{id}` with `cancel_at_period_end`), then puts the org on Free at once
    (`endSubscription`, which also makes later webhooks about the old subscription change nothing but its becoming
    active again). Cancelling at the period's end, not revoking at once, is what makes the usage already sent appear on
    the period's invoice under ADR 0042, whatever Polar does with metered usage when a subscription is revoked. A 403
    from Polar counts as already cancelled only when Polar says so (`AlreadyCanceledSubscription`,
    `InactiveSubscription`); any other (a token without the scope) is a failure. A failure before the last step answers
    `502` and changes nothing. Upgrading back goes through checkout.
  - **Leaving Pay as you go** (switching to Free, Polar ending the subscription, org deletion): what the org owes until
    then, above free usage and unsent, becomes its last batch, which the cron still sends (none after a switch to Free,
    which sends it first); after that an org on Free sends nothing. Usage on Free is never billed: going back to Pay as
    you go counts what came before as sent.
  - **Meter events** (`billing/scheduled-tasks.ts`, `send-usage.ts`): the API Worker's cron runner runs
    `billing-meter-events` for every org (previews have no crons). An org with a Polar customer gets a batch from its
    part (`meterBatch`): the one on its way, or a new one with what is above free usage and unsent, one event per unit
    and month, each with an `external_id` of `<batch uuid>:<month start>:<unit>`. It goes to Polar's batch ingest and,
    once Polar took it, is recorded as sent (`meterBatchSent`); a batch that failed is sent again, same ids, so Polar's
    deduplication keeps a retried batch from counting twice. After each batch the task pauses 120 ms, so the runner,
    which runs orgs one after another, stays under Polar's 500 requests a minute. Polar files events into the period it receives them (ADR 0042), so the last hours of a month can
    land on the next invoice.
- **Unbilled orgs and raised ceilings** (#240, `billing/routes.ts` `PUT /billing/unbilled`, `PATCH /billing/ceilings`;
  the org chooser's Billing button, `apps/web/src/pages/OrgsBilling.tsx`): platform admins only (the handlers ask,
  `403 platform_admin_required`), reached from the org list at `/orgs/<slug>/billing/...`, with or without Polar.
  `setUnbilled` makes `plan()` and `limitsPlan()` answer Pay as you go (past due or not) whatever the stored plan, which
  Polar's webhooks keep updating underneath: unmarked, the org is back on that plan, Free without a subscription.
  Marking it closes the usage it owed on a subscription into the batch on its way (as leaving Pay as you go does);
  while it is unbilled every new batch writes its usage off instead of sending it, and unmarking writes off what is
  left, so nothing used while unbilled is ever billed. Its owners get `409 unbilled` on checkout and on switching to
  Free. The billing cap does not apply to an unbilled org (`admit` checks `unbilled()`), and it gets no billing
  notices (`billingNotices` answers none). `raiseCeilings` stores, per ceiling, a raise over the plan's
  (`null`: the plan's); `ceilings()` answers each as the larger of the plan's (`PLAN_CEILINGS`, of the plan whose
  limits apply) and the raise, for #241's concurrency ceilings to read.
  `GET /billing` adds `ceilings` for platform admins (each one's `plan` value, of the plan whose limits apply, and
  `raised`; the maximum raise is `MAX_RAISED_CEILING` in `@commissary/contract/billing`); `unbilled` is for every
  reader.
- **Panel** (#239, `apps/web/src/pages/Billing.tsx`, `components/PlanNotices.tsx`, model in `apps/web/src/lib/billing.ts`):
  **Billing** (`/billing`, the address `plan_limit_reached` links to; in the sidebar's Org group on Commissary Cloud
  only, for org admins; a self-hosted panel answers Not found there, and plain members are refused by the shell's
  gate) shows the plan, each unit's use this month against its free usage with Pay as you go's rate above it (`GET
  /billing`'s `rates`), and on Pay as you go the bill so far against the billing cap. Org owners upgrade (`POST /billing/checkout`, then the browser goes to
  Polar; back on the page, which Polar returns to before its webhook may have arrived, it reads the billing again
  every 5 seconds for a minute while the org still reads Free, for up to an hour after the checkout started), switch
  to Free after a confirmation that it takes effect at once, set or remove the cap (`PATCH /billing`) and open the
  customer portal (`POST /billing/portal`); other org admins read the same without the controls. An unbilled org shows
  "Pay as you go, unbilled" with no checkout, switch or cap. The **plan notices** (`GET /billing`'s `notices`) show
  over every other page of the org for its owners and admins on Commissary Cloud, most urgent first (the red trail mark for
  100% and a failed payment, the white-red-white band at 80%), with a link to the Billing page; a failed payment
  offers an owner the portal and tells other admins to ask an owner. The page and the notices say only what the server
  does today: requests are counted and refused (tool calls, browser and computer hours are not counted yet).
- **Org deletion** (`billing/org-deletion.ts`): with a billing provider, Billing's `OrgDeletionStep` sends the org's
  unsent usage, then cancels its subscription at the end of its period (as switching to Free does, so the usage sent is
  invoiced); deletion does not wait for payment. A failure that may pass (the part cannot be reached; Polar rate limits,
  answers 5xx or does not answer) answers `complete: false` and the step runs again with the next deletion request
  (both calls are safe to repeat). A refusal from Polar that trying again cannot change (a 4xx other than 429: the
  customer or subscription was deleted in Polar by hand, a token without a scope) is logged with the org's id and the
  step answers `complete: true`, so the org can still be deleted; what is left in Polar is for a person to settle. The
  step runs in the request's services (its logger and clock). The part's tables go with `wipeOrg`.

## Provider OAuth logins (`models/oauth/`, `models/management/oauth-routes.ts`)

Port of the management OAuth handlers (`auth_files_provider_oauth.go`, `auth_files_devin_oauth.go`, `oauth_callback.go`,
`oauth_sessions.go`) and `internal/auth/*`. The panel's OAuth page works unchanged: `GET /v9/management/oauth/auth-url?provider=`
(`claude`, `codex`, `antigravity`, `devin`, `xai`, `meta`, `kimi`, `kimi-ai`; `is_webui` ignored) returns `{status,url,state}`
(+ `flow:"device"`, `user_code`, `expires_in` for device logins), `GET /oauth/status?state=` answers `ok|wait|error`,
`DELETE /oauth/session?state=` cancels and `POST /oauth/callback` takes `{provider, redirect_url | state+code}`.

- **Sessions** (`session-store.ts`): a SQLite table in the `ControlPlane` DO with the Go rules (TTL 30 min, completed kept 1 min,
  `SetError` refreshes the TTL, cancel only for pending sessions). Flow secrets (PKCE verifier, device code) stay in the row and are
  wiped when the session ends; replies never contain them. A busy lease (2 min, released in `ensuring`) lets one exchange/poll run
  per session, and the credential is saved only while the session is still pending (a cancel racing the exchange wins).
- **Authorization-code logins** (Claude, Codex, Antigravity, Devin): provider client IDs only allow `localhost`/`127.0.0.1`
  redirect URIs, so the user pastes the redirected URL (`POST /oauth/callback`). The request performs the token exchange itself
  (no waiter goroutine/file hand-off); like Go it answers `{"status":"ok"}` once the callback is accepted and failures show up in
  `/oauth/status` (messages are Go's: `State code error` cannot occur because the state _is_ the session key; `Bad request`,
  `Failed to exchange authorization code for tokens[: cause]`, `Timeout waiting for OAuth callback`, ...). The callback window is
  5 minutes. PKCE (S256, 96 bytes; Devin 64) and states use WebCrypto; authorization URLs use Go's `url.Values.Encode` ordering.
- **Device logins** (Codex `?provider=codex&flow=device`, xAI, Meta, Kimi/Kimi.ai): `auth-url` requests the device code, the panel
  polls `/oauth/status` and each poll performs the upstream poll when `nextPollAt` has passed (xAI immediately, others after one
  interval; `slow_down` +5 s except Kimi), so providers are never polled faster than their interval. Windows: xAI 30 min, Meta/
  Kimi/Codex 15 min (or the device code's `expires_in`). No DO alarms are needed.
- **Credentials** are the Go files (same keys, same names: `claude-<sha8(org|account)>-<email>.json`, `codex-<sha8(account)>-<email>-<plan>.json`,
  `antigravity-<email>.json`, `xai-<email|sub>.json`, `meta-<email>-<sha16>.json`, `kimi[-ai]-<ms>.json`, `devin-<user>.json`, plus
  `disabled`). `record.ts` replays `saveTokenRecord`: same-name user settings are kept (never tokens), a Claude login migrates the
  legacy email/account-named file, then the file is stored through the pool (`importAuthFile` semantics) and is selectable at once.
- **Public browser callbacks** (`/anthropic/callback`, `/codex/callback`, `/antigravity/callback`, `/callback`, `/devin/callback`;
  `public-routes.ts`) exist for users that rewrite the localhost host to the Worker. They are outside the Access admin gate, so
  they only act on the `state` of a pending _callback_ login of the route's provider and answer with a static page (no-store,
  never containing code/state/tokens/errors); everything else is a neutral 400. The state of a login names its org
  (`orgScopedName`: `org.<org>.<hex>`, a bare state is `global`'s), so the callback asks only that org's ControlPlane.

Deviations from Go: the Antigravity login uses the Go fallback client version `2.9.1` (the executor reads the polled Hub version, see
_Antigravity provider_) and project discovery runs inside the login (non-fatal; the executor repeats it when `project_id` is missing); a transport failure or 5xx of one xAI/Kimi poll keeps waiting instead of ending the login; Codex
exchange errors include the (scrubbed) upstream status/body like Go but cap it at 512 chars; device-flow states carry a random
suffix (`xai-<ms>-<hex>`); Kimi stores the normalised `domain`; Claude's uTLS/ordered-header fingerprint cannot be reproduced (see
Claude provider). `POST /v9/management/oauth/import?provider=vertex` (`models/management/oauth-import.ts`, Go `ImportVertexCredential`)
takes a multipart service-account `file` (+ `location`, default `us-central1`), re-encodes the key as an RSA PKCS#1 PEM
(`normalizePrivateKey`, parity with `NormalizeServiceAccountMap` in `packages/models/test/fixtures/session.json`; error texts of invalid keys
differ) and stores `vertex-<project>.json` merged over an existing file. Not ported: plugin logins and the local callback forwarder (`is_webui`). Credential JSON files from the Go
server can still be imported through management.

## Tools (`tools/`, `tools/management/routes.ts`, `tools/mcp/endpoint.ts`)

The Tools area (ADR 0036, ADR 0037, ADR 0038) turns outside sources into **toolkits** and serves them on Commissary's
own MCP endpoint. This version builds four kinds, the remote MCP server (Streamable HTTP), the OpenAPI document (#203,
_OpenAPI toolkits_ below), the GraphQL endpoint (#204, _GraphQL toolkits_ below) and the Google Discovery document
(#205, _Discovery toolkits_ below), each through its driver (`tools/toolkits/kinds.ts`: how its list is built, whether
that needs a credential, how a call reaches the upstream, whether calls keep an upstream session), and offers the
toolkit catalog to add them from (#207, _Toolkit catalog_ below) and the panel's Tools pages (#208, #209, _Panel_ below); grants (#198), prices, usage records and Spend limits of tool calls (#199), approval rules with
pending approvals (#201) and OAuth 2 sign-in to toolkits (#202, around the drivers: a driver gets a credential's secret
already signed in) are here. The package (`@commissary/tools`) is shaped like Models: entry points `./api` (the MCP
endpoint's routes, Commissary's CIMD document, the cron task), `./management`, `./state` and `./testing`, a lint
boundary (`boundaries/tools-imports`) and a ControlPlane part, `ToolsPart`, reached as `stub.tools().x(…)`. Its one
binding of its own is the usage database (and `CACHE`, the deployment's KV namespace, for the toolkit catalog); its state is the ControlPlane's (`TOOLS_TABLES`: `toolkits`,
`toolkit_credentials`, `toolkit_tools`, `tool_overrides`, `toolkit_sessions`, `tool_grants`, `tool_approvals`,
`built_in_toolkits`, `toolkit_documents`, `toolkit_schemas`, and OAuth's `toolkit_oauth_apps`, `toolkit_oauth_clients`
and `toolkit_sign_ins`, the sandbox's `sandbox_sessions` and the browser crawls' `browser_crawls`, dropped by `wipe()`). Its view of `env` (`ToolsBindings`)
adds the Platform registry and the app host (`APP_DOMAIN`) for the endpoint's connect links and the callback its CIMD
document names, the API host (`API_DOMAIN`) where toolkit sign-ins name that document, and `USAGE`, the D1 database its
tool calls' records go into (Models' records go there too); it reaches MCP servers and HTTP APIs from the ControlPlane
through the global `fetch` behind the outbound guard. The part reads the state Worker's env (`ToolsPartEnv`): the
optional Browser Run binding `BROWSER` (`builtInProviders`), which the browser toolkit runs on, with the optional
account and API token of its crawls (`BROWSER_RUN_ACCOUNT_ID`, `BROWSER_RUN_API_TOKEN`, #270) and their cap on pages
(`COMMISSARY_CRAWL_MAX_PAGES`), the Worker Loader
`LOADER` with the `SandboxSession` namespace `SANDBOX_SESSION`, always there, which the sandbox toolkit runs on
(_Built-in toolkits_ below), `OWN_HOSTS`, which its alarm's token refreshes refuse, and `COMMISSARY_MODE` with the
managed OAuth apps' secrets (_Toolkit catalog_ below). Beside it the state Worker
defines and always binds the browser sessions' Durable Object (#213: `BrowserSession`, whose namespace
`BROWSER_SESSIONS` the part reads too), which reads `BROWSER` through its own view (`BrowserSessionEnv`).

- **What Tools shares with Models**: the ownership rules (`Scope`, `FULL_ACCESS`, `accessTo`: who reaches a shared or a
  private thing), which lived in `models/credentials/ownership.ts`. They moved into `@commissary/auth`
  (`auth/ownership.ts`, beside `Viewer`), and Models' module re-exports them with its own selection rule. A shared
  package rather than an RPC to the Models part: the rules are a pure function of the viewer and an owner, with no state
  behind them, so an RPC would add a round trip and a dependency between the areas' parts for nothing. Sealing is the
  org-wide base's already (`core.secrets`). Tools imports nothing of Models (its manifest does not name it, so the lint
  rule refuses it).
- **Toolkits** (`tools/toolkits/store.ts`): a kind (`mcp`; `browser`, `sandbox` and `agents` for the built-in toolkits, below), a source (the MCP server's URL), a name and which
  credentials it accepts (`shared`, `private` or `both`; a private toolkit takes its owner's only). An org admin adds
  org toolkits; any member adds private toolkits (a plain member's toolkit is always private) while the org setting
  `membership.private_toolkits` allows them (#198, ADR 0038). The setting mirrors `private_credentials`: on for
  `global`, off for a new org unless `POST /orgs` chooses it (an org from before it takes its `private_credentials`
  value, so it keeps serving what it served); while it is off adding a private toolkit answers `403
  private_toolkits_unavailable`, and the private toolkits there are kept but not served (they leave the MCP endpoint's
  list, and no longer shadow an org toolkit of their name) until it is on again. A private toolkit's own credential
  follows `private_toolkits` too, not `private_credentials`, which governs members' private credentials on org
  toolkits: the two settings are apart. Reading an org toolkit is for every member, managing it for org admins; a
  private toolkit is its owner's, and an org admin sees only that it exists (`others`: owner and creation time, never
  its name or source) and may remove it, as with private credentials. The source passes the outbound guard when it is
  saved (`422` with the guard's message as `error` and `path: "source"`, as for a provider's `base_url`) and names no
  user or password (`422 invalid`, `path: "source"`); every build passes it again, each request and redirect included. A
  member who only reads an org toolkit sees its source with the values of its query parameters masked (`***`, names
  kept; a parameter without a value is masked whole); org admins and the org export get the whole URL. The host and the
  path are shown as they are, so a key in the path (a Zapier-style `/s/<key>/mcp`) is visible to every member: a key
  belongs in a credential (a `query` one for the query), which is sealed, not in the source. Edits name the toolkit's revision in `If-Match`; an org admin's removal of a member's private toolkit
  names the revision its existence-only view shows.
- **Credentials**: a toolkit holds at most one shared credential and one private credential per member, connected and
  removed under `/toolkits/:id/credentials/{shared,private}`. A static secret (none, a bearer token, an API key in a
  named header or query parameter, basic auth; `tools/toolkits/secret.ts`, a header the MCP client sets itself is
  refused), an OAuth 2 client credentials grant (a shared credential only), the tokens of an OAuth 2 sign-in, which
  is signed in to rather than connected (OAuth 2 sign-in, below), or one of the other credential types (below, #206). The secret is sealed with the org's data key for its
  row (`toolkit_credentials/<toolkit>/<owner>`) and never answered; views show the kind and the header or parameter
  name. Connecting a shared credential (`PUT /toolkits/:id/credentials/shared`, or adding an org toolkit with one) names
  who may use it (`subject`, as a grant names it; `422 invalid` without one, or for a member or team the org does not
  have) and writes that subject's grant of every tool of the toolkit in the same transaction, unless the subject holds a
  grant on the toolkit already (any selection), which stays as it is: rotating a key for a subject already granted
  changes nobody's reach, while naming a subject without one adds its all-tools grant. The answer says which grant
  (`grant: { id, created }`). A private credential names no subject (`422 invalid`). A source that needs no sign-in
  takes a shared credential of kind `none`, so it follows grants like any shared credential: nobody reaches it until
  someone is granted it. Private credentials on org toolkits follow `membership.private_credentials` as in Models: while
  it is off a private credential cannot be connected (`403 private_credentials_unavailable`), shows `active: false` and
  is not used. A private toolkit's credential follows `membership.private_toolkits` the same way (`403
  private_toolkits_unavailable`). Changing what an org toolkit accepts keeps the credentials it no longer accepts: they
  show `active: false` and are not used until it accepts them again, and only their holders remove them (a member's
  private credential stays theirs alone).
- **OAuth 2 sign-in** (`tools/oauth/`, #202): an MCP server that signs clients in with OAuth 2 (the MCP authorization
  spec) gets a credential of kind `oauth`, its tokens sealed like any secret and refreshed by Commissary (_token
  refresh_, GLOSSARY.md).
  - **Starting** (`POST /toolkits/:id/credentials/{shared,private}/sign-in`, `{ subject? }`, `201 { state, url,
    expires_at }`): an org admin signs the shared credential in, naming its `subject` as connecting one does (the grant
    is written when the sign-in completes), a member their private one, under the rules of connecting. The panel opens
    `url` and polls `GET /toolkits/:id/sign-in?state=` (`wait`, `ok`, or `error` with why) until it is done; only the
    sign-in's starter reads it (an org admin any sign-in of the shared credential), others get `404`. Only a member
    starts one (`403 forbidden` for a management key or a service token): only its starter finishes it (below).
  - **The client** (`oauth/flows.ts` `prepareSignIn`), in the MCP spec's order: the toolkit's own **OAuth app**, when
    its managers set one (`PUT /toolkits/:id/oauth-app` `{ client_id, client_secret?, authorize_url, token_url, scopes?,
    issuer? }`, `DELETE` clears it; the secret is sealed and views show `client_secret: true`; the client authenticates
    with `client_secret_post`, or as a public client without a secret, and no `resource` is sent, which an app's server
    may not know; `issuer` is the server's RFC 9207 issuer, which its answers must then name); else Commissary as the
    MCP server's client, after **discovery** (`oauth/discovery.ts`): an unauthenticated `initialize` whose `401` names
    `resource_metadata` in its `WWW-Authenticate` challenge, else the protected resource metadata at its path-inserted
    and root well-known URIs (RFC 9728); its `resource` must be the source's origin and a prefix of its path; its first
    authorization server's metadata at the RFC 8414 and OpenID Connect well-known URIs in the spec's order, whose
    `issuer` must be the one named, and which must offer PKCE S256. Commissary's **CIMD document** is the `client_id`
    where the server takes one (`client_id_metadata_document_supported`) and the deployment serves it (below); else
    **dynamic client registration** (RFC 7591), a public client where the server allows it, kept per toolkit
    (`toolkit_oauth_clients`, with the issuer and redirect URI it was made for, made again when either changes). A new
    registration rides in the sign-in's sealed flow and replaces the toolkit's only once that sign-in completes, so an
    abandoned sign-in never retires the client the toolkit's other credentials refresh their tokens with; a server with
    neither answers `502 sign_in_failed` ("give the toolkit an OAuth app"). A server that refuses the CIMD document at
    its authorization endpoint is not retried with DCR: the browser shows its error.
  - **The authorization request**: PKCE S256, the RFC 8707 `resource`, the scopes of the challenge's `scope` else the
    resource's `scopes_supported` (an app's own), and a `state` of 128 random bits named by its org
    (`org.<org>.<hex>`, `orgScopedName`). The toolkit sign-in (`toolkit_sign_ins`, its flow sealed: the PKCE verifier, a
    new registration) is single-use, has five minutes for the browser to come back and lives 30 minutes (a completed
    one one minute), the values of Models' login sessions.
  - **The callback** (`GET /oauth/toolkits/callback`, `SIGN_IN_CALLBACK_PATH`, the app Worker's
    `SignInCallbackRoutes`): the deployment's one redirect URI, `https://<app host>/oauth/toolkits/callback`, which
    admins enter in their OAuth apps. It asks only the ControlPlane of the org the state names, and only for the member
    who started the sign-in, the shared credential's as a private one's: the app Worker's gate signs the request in (an
    Access sign-in, a Commissary Cloud session) as a member of that org (`authenticateSignInCallback`), and anyone else
    (nobody signed in, a management key, a service token, a person outside the org, another member, an org admin
    included) gets the page of an invalid sign-in, `400` as for an unknown, used, expired or other org's state, and
    leaves the sign-in pending for its starter. So someone who gets a victim to open the callback of the attacker's own
    authorization (a login CSRF) finishes nothing: the state is not the victim's. Unlike Models' callbacks, which act
    on the state alone. When the flow knows the server's issuer (from its metadata, or the OAuth app's `issuer`), the
    answer must name it (`iss`, RFC 9207; required when the server advertises it or the app names one), checked before
    anything else in it, an error included (§2.4); the code is exchanged with the PKCE verifier (and the `resource`),
    and the tokens become the credential (`via`: `cimd`, `dcr` or `app`), with the subject's grant as connecting
    writes it, and the tool list is built if it never was. The page is static (`no-store`, no referrer, not framed)
    and holds no code, state, token or error detail; a failure is the sign-in's, for its starter to read.
  - **Token refresh**: the part's alarm refreshes a token five minutes before it expires (halfway through its life
    when that is shorter), four at a time, through the guard with the deployment's own hosts refused (`OWN_HOSTS`); a
    token within a minute of expiry is refreshed before it is used, and one the upstream refuses (`401`) is
    refreshed once and the request made again; concurrent token refreshes of a credential share one. A token endpoint
    that refuses a refresh (an OAuth error), a sign-in without a refresh token, and a client that is gone (the OAuth
    app's client id changed, the registration was made again) mark the credential `needs_sign_in`: it is not used, a
    build records why, and a call answers that it needs sign-in again (the member's own: the connect link; the shared
    one: that an org admin must sign in again, with no elicitation). A token refresh that may pass (unreachable,
    `5xx`, `429`), or one that throws in the alarm, is tried again by the alarm after five minutes; one credential's
    failure stops neither the others' nor the alarm. Each failure is logged (`toolkit token refresh failed`, with the
    toolkit, the slot, the reason and the server's status and error code, never a token). An OAuth app's secret is
    read at each refresh, so rotating the secret of the same client id needs no new sign-in.
  - **Client credentials** (`kind: "client_credentials"`: `client_id`, `client_secret`, `token_url?`, `scope?`, a
    shared credential only, `422 invalid` as a private one): Commissary mints the token at `token_url`, else at the
    token endpoint of the MCP server's authorization server (discovered as above, naming the `resource`), with HTTP
    Basic unless the server names only `client_secret_post`; on first use, when it expires and once again on a `401`.
    A refused mint marks it `needs_sign_in` until it is connected again. An OpenAPI toolkit has no MCP server to
    discover from, so its grant names `token_url` (and its OAuth 2 sign-in needs the toolkit's OAuth app).
  - **Around the drivers** (`tools/toolkits/kinds.ts`): sign-in and token refresh sit around a kind's driver, which
    gets the credential's secret already signed in; an OAuth credential's is its access token as a `bearer` secret,
    which an OpenAPI call places where the operation's `oauth2`, `openIdConnect` or `http` bearer scheme says
    (`http/call.ts`). A driver reports a `401`: the MCP driver as a failure that says so, the OpenAPI driver as the
    call's result (an `isError` answer with the status); either way the token is refreshed once and the request made
    again.
  - **The guard**: every URL above passes the outbound guard, those an admin enters on save (`422` with the guard's
    message and `path`: `authorize_url`, `token_url`, `credential.token_url` when adding a toolkit) and on use, and
    those metadata names before Commissary fetches them or sends the browser there (`422`, `path`: the metadata's
    field, e.g. `token_endpoint`). Other failures are `502 sign_in_failed` with a short message that quotes no body.
- **The other credential types** (#206; `tools/signing/`, `tools/toolkits/credential-settings.ts`): what a credential
  holds is its secret; how it is used is the toolkit's **credential settings** (`credential_settings`, a JSON column on
  `toolkits`, set by the toolkit's managers on adding it or with `PATCH` (`null` clears it), shown to whoever reads the
  toolkit and kept in its export; nothing in them is secret), so every member's private credential is used the same
  way. Each type is a shared or a private credential; connecting one whose settings are missing, a compound one lacking
  a field the template names, or a JWT exchanged at a token endpoint without its issuer is `422 invalid`, and a
  credential whose settings are removed later is not used (a call says why). Every URL in the settings passes the
  outbound guard on save and on use. The types are integrations.sh's, under its names, so catalog entries map to them:
  - **Signed per request**: `oauth1` (`consumer_key`, `consumer_secret`, `token`, `token_secret`; settings `oauth1:
    { signature_method?: HMAC-SHA1 | HMAC-SHA256, realm? }`), `tba` (NetSuite token-based authentication: OAuth 1.0a
    with HMAC-SHA256 and the account as realm; `consumer_key`, `consumer_secret`, `token_id`, `token_secret`; settings
    `tba: { account_id }`) and `aws_sigv4` (`access_key_id`, `secret_access_key`, `session_token?`; settings
    `aws_sigv4: { region, service }`). Each request is signed as it is sent over its method, its URL as sent and its
    body: `signingClient` wraps the client of an MCP call, listing or session `DELETE` and of an HTTP-API call, so each
    hop of a same-origin redirect is signed anew. OAuth 1.0a signs a form body's parameters. SigV4 sends the path and
    query percent-encoded as RFC 3986 says (a query's space `%20`, a plus `%2B`, which AWS reads as a plus), so what
    AWS reads is what was signed, and signs the path normalized and encoded once more (S3's as it is sent), as AWS's
    test suite does; it hashes the payload, encoding a multipart body first (a raw or streamed body, which toolkits'
    calls do not send, only S3 takes, as `UNSIGNED-PAYLOAD`). HMAC is `node:crypto`'s.
  - **Minted** like client credentials (a token on first use, kept sealed with the credential until a minute before it
    expires, minted again once on a `401`, a refusal marking it `needs_sign_in` until it is connected again; the token
    is kept with a fingerprint of the settings it was minted with, so changing them mints a new one): `jwt`
    (`private_key`, `key_id?`, `issuer?`, `sub?`, `client_id?`, `client_secret?`; settings `jwt: { algorithm (RS,
    PS, HS 256-512, ES256, ES384), token_url?, audience?, scope?, lifetime_seconds? (120 to 3600, the default),
    claims? }`; a JWT signed with WebCrypto from a PEM key (PKCS#8, PKCS#1 RSA or SEC1 EC) or an HMAC secret,
    exchanged at `token_url` with RFC 7523's JWT bearer grant (the JWT names its `iss`; the request sends `scope`,
    which the JWT also carries as Google asks, and the client's id and secret in its body when the credential names
    them, as Box asks), else sent itself as the bearer token), `app` (a GitHub App: `app_id`, `private_key`,
    `installation_id`; settings `app: { api_url? }` for GitHub Enterprise; an RS256 app JWT exchanged for an
    installation token) and `token_exchange` (RFC 8693, which integrations.sh has no type for: `subject_token`,
    `client_id?`, `client_secret?` (HTTP Basic, each part form-encoded); settings `token_exchange: { token_url,
    subject_token_type?, requested_token_type?, audience?, resource?, scope? }`; the answer must name its
    `issued_token_type`). The token is sent as a bearer token, as an OAuth 2 one is.
  - **Compound** (`compound`, `fields`: named secret values; settings `compound: { headers?, query?, base_url? }`):
    templates that place the fields, `{field}` standing for one (integrations.sh's header patterns), e.g. a header
    `DD-API-KEY: {api_key}` beside `DD-APPLICATION-KEY: {app_key}`, or a per-tenant `base_url`
    (`https://{subdomain}.example.com/api`, an OpenAPI toolkit's only, each field percent-encoded, guarded on use).
    Header names are checked as a static secret's are.
  - **OAuth 1.0a sign-in** (three-legged, `tools/oauth/oauth1.ts`): a toolkit's OAuth app with a `request_token_url`
    is an OAuth 1.0a consumer (`client_id` the consumer key, `client_secret` required; `authorize_url` and `token_url`
    the provider's authorize and access token URLs). Signing in gets temporary credentials with `oauth_callback` the
    deployment's callback URL carrying the sign-in's `state` (OAuth 1.0a has no state parameter, and no PKCE), keeps
    them sealed in the sign-in's flow, sends the browser to authorize them, and on the callback, whose `oauth_token`
    must be the sign-in's, trades the `oauth_verifier` for the token credentials, which become an `oauth1` credential
    with the app's consumer, under the callback's rules above.
  - **Commissary's CIMD document** (`GET /oauth/toolkits/client.json`, `TOOLKIT_OAUTH_CLIENT_PATH`): a client API
    path (`CLIENT_API_PREFIXES`), served by the API Worker (`ClientMetadataRoutes`) without an API key (the gate lets
    this path through), on the API host (`https://<API host>/oauth/toolkits/client.json`, the `client_id`) or, on a
    stage with one host, through the app host's zone route and the Access bypass
    (`https://<app host>/oauth/toolkits/client.json`). Its `client_id` is its own URL, its one redirect URI the
    callback on the app host (`APP_DOMAIN`), a public client (`token_endpoint_auth_method: none`), the same on every
    request and cacheable for an hour. A Worker without `APP_DOMAIN` (a preview, `alchemy dev`) serves `404`, and a
    sign-in started on a loopback host, a `workers.dev` host (a preview) or over plain `http:` offers no document, so
    it registers through DCR where the server allows it. **Caveat**: the CIMD draft (§6.1) lets an authorization server
    require the redirect URIs to share the `client_id`'s origin; on a deployment with an API host apart from the app
    host such a server refuses the document (the redirect URI is on the app host), so give the toolkit an OAuth app
    there. A stage with one host serves both on the app host.
- **Tool lists** (`tools/mcp/client.ts`): one list per toolkit, from the server's `tools/list`, built with the shared
  credential or, if the toolkit has none, the private credential of the member who asks (a private toolkit's owner's).
  The client speaks the 2025 handshake (`initialize`, `notifications/initialized`, `tools/list` in the session of
  `Mcp-Session-Id` with the negotiated `MCP-Protocol-Version`, the session deleted afterwards) and, when the server
  refuses `initialize` the way a server of the stateless 2026-07-28 revision does (`400`, `405` or a JSON-RPC error; a
  4xx other than those, `401`/`403` included, is reported as it is), that revision (protocol version in `_meta` and the
  `MCP-Protocol-Version`, `Mcp-Method` and `Mcp-Name` headers). Speaking 2026-07-28 goes beyond #196, which asks for
  Streamable HTTP only: servers are moving to it, and a listing costs no more. It reads JSON or SSE answers up to 4 MiB,
  every page (at most 50), within 60 seconds, cancels the bodies it does not read, and follows only same-origin 307/308
  redirects, so a key in a named header or the query never reaches another origin. Error messages never quote the URL
  or the server's body. A list is built when a toolkit is added with a credential or its first credential is connected,
  on `POST /toolkits/:id/refresh`, and by the cron task `tool-list-refresh` (every org; an org toolkit with private
  credentials only is skipped, as no member asks). The cron builds an org's toolkits four at a time, each within 20
  seconds rather than an interactive refresh's 60, so one slow server holds neither the others nor the invocation.
  A failed build keeps the last list and records why (`tool_list.error`). A tool that disappears upstream drops out; one
  already known keeps the build that first listed it (`first_seen`, a counter across builds, not a time). Each tool
  keeps its upstream name, description, input schema and annotations.
- **OpenAPI toolkits** (`tools/openapi/`, `tools/http/call.ts`, #203): kind `openapi`, from an OpenAPI document given by
  URL (`source`) or uploaded (`document` on `POST /toolkits`; `PUT /toolkits/:id/document` replaces it, at its revision,
  and `GET` reads it back, both for the toolkit's managers only: a document may describe more of an API than its tools
  show). OpenAPI 3.0 and Swagger 2.0 documents are brought to 3.1 by Scalar's upgrader (`@scalar/openapi-upgrader`,
  MIT, plain JavaScript that runs in the Workers runtime; it also turns 3.0's `nullable` into type arrays and Swagger's
  body and form parameters into a request body); 3.2 is read as 3.1. YAML is read by js-yaml with its core schema
  (plain JSON values), and its aliases may expand to at most 2,000,000 values (js-yaml shares an alias's value, so a
  "billion laughs" document is small in memory but not to walk). **Sizes**: a document is at most 8 MiB in JSON and 4
  MiB in YAML (a fetch reads at most 8 MiB; a larger YAML one is refused once it is known not to be JSON; the upload
  route reads a body of up to twice 8 MiB, a JSON string escaping the document's quotes and newlines). The limits come
  from the least Node.js heap that parses a synthetic Swagger 2.0 document, upgrades it and builds its tools (beyond
  about 26 MB for Node.js itself): JSON of 4.65, 9.32 and 13.98 MB needs about 25, 52 and 80 MB (5.5 times the text),
  js-yaml's YAML of 4.18, 8.37 and 12.56 MB about 35, 76 and 113 MB (9 times); the `yaml` package's document model
  needed 155 MB for the 4.18 MB YAML (37 times), more than the ControlPlane's 128 MB isolate, which is why js-yaml
  reads YAML. At the limits a build holds at most about 46 MB, under half the isolate. The number of operations is not
  limited (ADR 0037: no hard cap on a toolkit's tools). The document is read when the toolkit is added, needing no
  credential (none is sent to the document's host); a URL is fetched again on refresh and by the cron task, an uploaded
  document is read again only when it is replaced (an on-demand refresh rebuilds from the kept copy; the cron skips
  it). An uploaded document is kept in the ControlPlane, in 1 MiB chunks (`toolkit_documents`), so a document of
  several MB never meets SQLite's 2 MB limit on one value; a fetched one is not kept. The org's export says a toolkit is
  `uploaded` but does not hold its document, which its managers download on its own route. R2 was the other place to
  keep documents: it would need R2 enabled on the Cloudflare account (a setup step for every deployment) and a shared
  bucket keyed by org, where the ControlPlane's rows are the org's by construction. Each operation is one tool: its
  upstream name is its `operationId`, or the method and path (`GET /pets/{petId}`); its input schema joins the path,
  query, header and cookie parameters by name (a name two locations share takes the location as a prefix, `query_id`;
  names are made ones model APIs take, `[A-Za-z0-9_.-]`, at most 64) and the request body as `body` (JSON preferred,
  then form, multipart, text), local `$ref`s resolved (a recursive one ends in `{}`; keywords beside a `$ref`, a
  description most often, apply too), keywords that only document dropped and a request body's read-only properties
  left out, cut at a shallower depth until it fits 16 KiB; its description is the summary and the description, at most
  2,048 characters. `GET` and `HEAD` are `read`, every other method `write`. A `deprecated` operation is listed,
  flagged `deprecated` and hidden by default; an override with `hidden: false` shows it (`tool_overrides.shown`, in the
  export as `shown: true`; on any other tool `hidden: false` sets nothing). What a call needs (method, path, server,
  parameters with their style, body media type, security alternatives) is stored with the tool
  (`toolkit_tools.operation`), so a call never reads the document. **Calls** go to the toolkit's `base_url` (its
  managers', `PATCH /toolkits/:id`; `null` clears it) or else the server the document names for the operation
  (variables at their defaults, relative ones against the document's URL; an uploaded document's relative server needs
  a base URL). A build checks each distinct server the operations name against the outbound guard: while the toolkit
  has no base URL, operations that name none, or one the guard refuses, are counted in `tool_list.error` ("set the
  toolkit's base URL"; the tools are listed all the same), and setting or clearing the base URL updates it. The
  credential goes where the document's security schemes say: an API key in a header, the query or a cookie, HTTP
  bearer and basic, OAuth 2 and OpenID Connect as a bearer token (a bearer token; #202's sign-in tokens will use this
  path); the first alternative the credential fits, one of its own kind first (a `header` key named as the scheme's
  header, a `bearer` token for a bearer scheme), then any token for a scheme of one value; an operation with
  `security: []` gets none; a document whose schemes fit none of its credential, or that defines none, gets the
  credential as it was connected. A document that defines schemes but requires none takes each as an alternative. Form
  bodies nest in brackets (`metadata[key]`, `items[0][price]`), as Stripe reads them. **The shared HTTP-call module**
  (`http/call.ts`, which GraphQL #204 and Discovery #205 reuse) applies the credential, sends every request through the
  outbound guard (documents, base URLs and calls; a document fetch lets the guard follow redirects, a call follows only
  same-origin ones, through the guard's `executeSameOriginRedirects`, so a key never reaches another origin, and a
  redirect elsewhere is the answer, naming only the origin and path it leads to), and shapes the answer: JSON
  pretty-printed as text, other text as it is, binary described, at most 64 KiB with a note saying it was cut, and a
  `4xx`/`5xx` an `isError` result with the status and the body. A call takes at most 240 seconds, as an MCP tool call
  does (`TOOL_CALL_TIMEOUT`); a document fetch has the build's budget (60 seconds, a cron build's 20
  seconds). A missing required argument or no server to call fails the call before anything is sent. A document URL or
  base URL the guard refuses is refused on save (`422`, `path: "source"` or `"base_url"`).
- **GraphQL toolkits** (`tools/graphql/`, `tools/http/call.ts`, #204): kind `graphql`, whose source is the endpoint's
  `https:` URL (the outbound guard on save, `422`, `path: "source"`, and on every request; no base URL, `422 invalid`).
  graphql-js (`graphql`, MIT, plain JavaScript that runs in the Workers runtime) reads the schema, from the endpoint's
  answer to its introspection query, sent with the toolkit's credential, so the list is built when a credential is
  connected, as an MCP server's is; or from an uploaded SDL file (`document` on `POST /toolkits`, replaced and read
  back on `/toolkits/:id/document` as an OpenAPI document is, `uploaded: true`), which needs no credential and is read
  when the toolkit is added. The query asks for descriptions and `@oneOf` input objects (`isOneOf`); an endpoint that
  answers it with a `4xx` (but `401` and `429`) or without a schema is asked again without `isOneOf`, which a server
  older than `@oneOf` does not know. Refresh and the cron task introspect again; an uploaded schema is rebuilt only
  when it is replaced. A toolkit built by introspection takes a first SDL file on `PUT /toolkits/:id/document` too (an
  endpoint that stopped allowing introspection), and is built from uploaded files from then on (`toolkits.uploaded`,
  set when a toolkit is added with a document or takes its first one); switching back means adding the toolkit again.
  A schema is read as valid (`assumeValid`): GitHub's public schema, for one, breaks a rule graphql-js enforces on
  deprecated interface fields. An endpoint that does not answer introspection (an answer without a schema, or a `4xx`
  but `401` and `429`, as Apollo Server and Hasura refuse it) keeps the toolkit with `tool_list.error` saying to upload
  its schema; a `401` lets an OAuth credential's token be refreshed, as for the other kinds. **Tools**: each field of
  the query root, then of the mutation root, is one tool, its upstream name the root and the field (`query.issues`,
  `mutation.createIssue`); subscriptions are skipped. Its input schema has one property per argument: `Int` an
  integer, `Float` a number, `String` and `ID` strings, `Boolean` a boolean, a custom scalar any value (described by
  its name), an enum its values (deprecated ones left out), a list an array, an input object an object of its fields
  without other properties (a `@oneOf` one with exactly one), a non-null argument or field without a default required,
  and defaults as `default`; recursive input objects are cut at a shallower depth until the schema fits 16 KiB, as
  OpenAPI's are (`tools/toolkits/input-schema.ts` holds the bounds both kinds keep). Its description is the field's (at
  most 2,048 characters). A query field is `read`, a mutation field `write`. A deprecated field is listed, flagged
  `deprecated` and hidden by default, shown by an override as a deprecated operation is. A root field whose result is
  a list or a connection, with an optional `Int` argument `first` or `limit` the schema gives no default, sends 10 for
  it when a call leaves it out (`default: 10` in the input schema), so a call that names no page size does not ask for
  the whole list. What a call needs (the root, the field, each argument's type and default, the default selection) is
  stored with the tool (`toolkit_tools.graphql`), and the schema itself as SDL (`toolkit_schemas`, in 1 MiB chunks
  like documents), which a call reads only to check a caller's selection. **The default selection** of a field whose
  result is an object, an interface or a union is a breadth-first walk of the result: each type's scalar and enum
  fields (not deprecated, without required arguments), the result's own first, then those of the objects it links to,
  level by level, at most 3 levels and 50 fields. A field below the result that is a list or a Relay connection (an
  object named `...Connection` with `nodes` or `edges`) is capped at 10 items through its `first` or `limit` argument,
  and left out when it has neither; a connection selects `pageInfo { hasNextPage endCursor }`, `totalCount` and its
  `nodes` (or `edges { node }`) at its own level. An interface or a union adds `__typename`, a union each member's
  fields in an inline fragment, and a result with nothing to take selects `{ __typename }`. Fields of one name in a
  union's fragments must select the same (graphql-js's `OverlappingFieldsCanBeMerged`): a member's field that another
  member selects under its name with another type or arguments is aliased `<Member>_<field>` (GitHub's
  `descriptionHTML`, `HTML!` on one owner and `String` on another; 16 of its 309 tools). Each tool's default is
  checked against the schema when the list is built, and one that does not check out is `{ __typename }` (none of
  GitHub's). The tool also takes `selection` (or `selection_2`, ... when an argument has that name): a selection set in
  place of the default (`{ id title }`, braces optional, at most 16 KiB), which the call checks against the stored
  schema with graphql-js's validation (and that it is still one operation selecting one field) and refuses before
  anything is sent, naming what does not check out. **Calls** go through the shared HTTP-call module: one `POST` to
  the endpoint of `{ query, variables }`, the operation declaring a variable of the argument's type for each argument
  the call gives (a missing required one fails the call before it is sent), the credential as it was connected (a
  GraphQL endpoint names no security schemes). The answer is shown whole (`data`, `errors`, `extensions`); one with
  `errors` and no `data` is an `isError` result, one with partial data and errors a result holding both, and an HTTP
  `4xx`/`5xx` an `isError` result as for any HTTP answer. An answer cut above 64 KiB is shown as text and not read, so
  one of errors alone that long is not an `isError` result unless its status says so. **Sizes**: an introspection
  answer is read up to 8 MiB, an uploaded SDL file is at most 4 MiB (`413 body_too_large` above, on `POST` and on
  `PUT .../document`). graphql-js's syntax tree of SDL is far larger than the schema an introspection answer builds:
  the least Node.js heap beyond about 22 MB for Node.js itself that reads a synthetic schema (types of 30 described
  fields) and builds its tools is about 12, 23 and 36 MB for introspection answers of 4.45, 8.89 and 13.3 MB (2.6 times
  the text), and 16, 32 and 47 MB for SDL of 1.67, 3.34 and 5.01 MB (9.5 times, read without locations, which take
  three quarters more); GitHub's public schema, 1.56 MB of SDL and 3.34 MB as an introspection answer (309 tools),
  takes 20 and 11 MB, and about 260 ms to build its tools from SDL. At the limits a build holds about 23 MB
  (introspection) or 40 MB (SDL), under half the ControlPlane's 128 MB isolate. The cron task runs four builds at once
  in an org, but a build is synchronous once its source is read, so only one is built at a time while up to three
  more answers (at most 8 MiB each) wait: about 23 + 3 × 8 MB at worst, and an uploaded schema is never built by the
  cron. A call with a selection checks it against the stored schema built again from its SDL (about 16 MB and 60 ms
  for GitHub's, 26 MB for the schema of an 8.9 MB introspection answer); the part keeps the last one built in memory
  (`SchemaCache`, one toolkit's, for the list built at the time), so a run of such calls on one toolkit builds it
  once, and forgets it when the toolkit's list is stored again or the toolkit is removed.
- **Discovery toolkits** (`tools/discovery/tools.ts`, #205): kind `discovery`, from a Google Discovery document (the
  REST description Google's APIs publish, `https://gmail.googleapis.com/$discovery/rest?version=v1`) given by URL or
  uploaded (JSON), kept, fetched again and replaced as an OpenAPI document is, within the same 8 MiB. Each method,
  those of nested resources included, is made into an OpenAPI operation and built by the OpenAPI toolkits' code
  (`openapi/tools.ts`), so its tool follows their rules: its upstream name is the method's `id`
  (`gmail.users.messages.list`, so most full names are long and many are shortened, ADR 0037); its input schema joins
  the method's path and query parameters (a `repeated` one an array) and its request body as `body`, the `$ref`s to
  the document's `schemas` resolved, with Discovery's keywords made JSON Schema's (a property's `required: true` its
  object's `required`, `type: "any"` no type, the strings of `default`, `minimum` and `maximum` the values their type
  reads; `id`, `annotations` and the like dropped); its description is the method's; `GET` is `read`, every other
  method `write`; a `deprecated` method is hidden by default. The document's global parameters (`alt`, `fields`,
  `key`, ...) are not offered. A method whose only input is a media upload (`supportsMediaUpload` without a request
  body) is not listed; one that takes a JSON body besides is, as a JSON call (Commissary does not use the upload
  protocol), and a media download answered by the plain request (`files.export`) is listed, its answer shaped as any
  (text shown, binary described). Batch requests are not offered. **Calls** go through the shared HTTP-call module to
  the method's `path` under `rootUrl` and `servicePath`, a `{+name}` parameter expanded with its reserved characters
  kept (RFC 6570; such a path's `flatPath` names other parameters than the method's, so `path` is used throughout). A
  path argument never leaves the method's path: one that is or holds a `.` or `..` segment (`%2e` counts as a dot, as
  URLs read it) is refused, as an OpenAPI path argument that is `.` or `..` is, and a `{+name}` one must match the
  parameter's `pattern` (`^projects/[^/]+$`); otherwise a caller could reach another endpoint with the toolkit's
  credential, past that endpoint's tool's grants and approval rules. A
  Discovery toolkit takes no base URL (`422 invalid`, `path: "base_url"`). The credential is an API key, which goes in
  the `key` query parameter whatever its connected name, or an OAuth 2 token (a bearer token, or #202's sign-in, for
  which Google needs the toolkit's own OAuth app, ADR 0036) as a bearer token. The OAuth 2 scopes the methods name are
  kept with each tool and reported on the toolkit (`scopes`, sorted, each once), so an admin knows what its OAuth app
  must ask for; a sign-in through a toolkit's OAuth app that sets no scopes asks for these (on any toolkit whose tools
  name scopes). The default name is the API's (`gmail`), as Google's hosts name the service poorly
  (`www.googleapis.com`). **The outbound guard** checks the document's URL on save and on every fetch, as for OpenAPI,
  and the `rootUrl` on every build: a build from a document whose `rootUrl` it refuses fails, and adding a toolkit with
  it, or replacing an uploaded document with it, is refused as a URL typed in is (`422` with the guard's message as
  `error` and `path: "rootUrl"`, nothing saved), where an OpenAPI document's unreachable servers only warn, since a
  Discovery toolkit has no base URL to set instead. **Sizes**: the largest Discovery documents Google publishes,
  Compute Engine's (6.4 MB for `v1` with 1,018 methods, 7.6 MB for `alpha` with 1,212), build in about 13 and 15 MB of
  Node.js heap beyond what Node.js itself takes (the least `--max-old-space-size` that parses the document and builds
  its tools), well within the ControlPlane's 128 MB isolate.
- **Toolkit catalog** (`tools/catalog/`, `tools/management/catalog-routes.ts`, #207, ADR 0036): the services an org's
  members add toolkits from, the same for every org, built from [integrations.sh](https://integrations.sh) (MIT,
  UsefulSoftwareCo; NOTICE) and Commissary's own additions.
  - _integrations.sh's data_: its one bulk export is the index `https://integrations.sh/api.json` (`{ version: 1,
    generatedAt, data }`, ≈2.8 MB, one record per _surface_ of a service): `kind` (`mcp`, `openapi`, `graphql`, `cli`),
    `slug` (the surface's stable id), `name`, `description`, `icon`, `domain` (the service), `categories`, `feeds` (where
    it learned of it: curated, the Claude and OpenAI connector directories, APIs.guru, discovered, …), `connectUrl` (what
    a client connects to: the MCP server's URL, the OpenAPI document's, the GraphQL endpoint; none for a REST API without
    a document), `auth` on curated records only (`kind`: `none`, `oauth`, `api_key`, `token`, `mixed`, and the header a
    key goes in, `Authorization: Bearer {token}`), `scopes`, `standalone` (a product of its own on a shared domain:
    Outlook Mail on `graph.microsoft.com`) and `popularity`. Per domain it serves the richer discovery model v3
    (`/api/<domain>/surface`): a registry of credentials by id (`type`: `api_key`, `basic`, `bearer`, `oauth2`,
    `oauth2_cc`, `oauth1`, `jwt`, `app`, `two_step`, `signature`, `aws_sigv4`, `tba`, `compound`, `custom`, with how to
    get one) and surfaces (`http` with its `spec`, `graphql`, `mcp`, `cli`), each with its `basis` (detected,
    discovered or declared by the owner's `/.well-known/integrations.json`) and its `auth`: any one of several entries,
    each entry the credentials used together with where each goes (`http`: a header, the query, the body; `spec`: a
    security scheme of the document; `well-known`/`metadata`: OAuth discovered from the server). `detect`
    (`/api/<domain>/detect`, seconds) probes the domain's well-known manifests (`integrations.json`, API catalog,
    OpenAPI, MCP server card, OAuth protected resource metadata); `discover` (`/api/<domain>/discover`, up to a minute,
    3 a minute) has an agent read the service's docs, and answers v3.
  - _The registry_ (`catalog/integrations-sh.ts`): the index trimmed to what Commissary can build, MCP servers, OpenAPI
    documents and GraphQL endpoints with a public `https:` locator (no CLI, no stdio command, no placeholder host), and
    the fields it reads, sorted (≈3,700 sources); an icon is kept only at an `https:` URL (the panel shows it as an
    image the browser loads; an icon proxy, if one comes, fetches it through the outbound guard). The snapshot ships as
    `catalog/integrations-sh.json` (`pnpm toolkits:sync`), read through the same trim as a refreshed copy, so a snapshot
    that does not decode fails loudly rather than being cast; the cron task `toolkit-catalog-refresh` (deployment-wide,
    every 3 hours with the others) and `POST /toolkit-catalog/refresh` (org admins) fetch the index again through the
    outbound guard (30 s, at most 8 MiB), trim it and keep it in KV `CACHE` (`DeploymentKv`,
    `toolkit-catalog/integrations-sh.json`, `catalog/stored.ts`), one at a time under the Platform registry's lease
    `toolkit_catalog_refresh` (`withPlatformLease`, `@commissary/state`, which the model catalog's refresh takes its
    lease with too). A fetch that fails, a document that is not the index or keeps fewer than 1,000 sources, or a KV
    write that fails keeps what is stored (a `200` with `status: "failed"` and a fixed message, at most 200 characters,
    for the panel); each attempt is recorded (`toolkit-catalog/refresh-status.json`), and `GET /toolkit-catalog/status`
    tells which copy is in use, when it was last confirmed current and how the last attempt went. A catalog request never
    fetches. Each isolate builds the catalog once from the stored text (re-read every minute, sooner after a refresh in
    the same isolate; the snapshot while nothing is stored or the text does not read). The refresh imports neither the
    snapshot nor the catalog (`stored.ts` holds the KV keys and the isolate's catalog generation), so the API Worker,
    which runs the cron task, does not bundle them; the app Worker does (≈1.6 MB of its bundle, ≈340 KiB gzipped).
  - _Services_ (`catalog/catalog.ts`): a domain's sources make one service, a `standalone` product its own. A service's
    id is its catalog slug, the default name of a toolkit added from it: the domain's own label as a toolkit's default
    name reads a host (`linear.app` → `linear`), a standalone product's name (`outlook_mail`); of services whose slugs
    clash, the one with the shortest domain keeps it and the others take their whole domain's (`linear_com`). Listing
    puts the additions' featured services first, in their order, then by popularity; `q` matches every word in a
    service's slug, name, domain, description and categories, `kind` keeps those with a source of that kind.
  - _Credentials_: a source's ways to sign in are toolkit credential kinds, any one of them (`credentials`): from the
    index, `oauth` is a sign-in, `api_key` and `token` a key in the header its pattern names, with what comes before the
    placeholder as prefix (`Authorization: Bearer {token}` is `bearer`, `Authorization: Basic …` `basic`), `mixed` a
    sign-in or that key, `none` none; from v3, `api_key` is a `header` or `query` key, `oauth2` a sign-in
    (`oauth`), `oauth2_cc` a client credentials grant, `two_step` a token exchange, and `basic`, `bearer`, `oauth1`,
    `tba`, `jwt`, `app`, `aws_sigv4`, `compound` the kinds of the same names (#206); `signature` and `custom`, and an
    entry that needs several credentials at once, have no kind and are left out. An OpenAPI document says how to sign in
    itself, so its source may list none. The index notes how to sign in on curated records only, so `pnpm toolkits:sync`
    also reads each kept domain's v3 document (`/api/<domain>/surface`: integrations.sh does not rate-limit it; four at
    a time, retried, cached under `node_modules/.cache/integrations-sh/` so a stopped run resumes) and matches each
    source to the surface of its kind at its URL (or a `specAlternates` twin); what that surface says ships as
    `catalog/integrations-sh-credentials.json` by the index's slug (≈1,900 of ≈3,700 sources) and wins over the index's
    note. The cron refresh does not fetch the documents (one request per domain): a source it adds has the index's note
    until the next sync.
  - _Document fixes_: integrations.sh records RFC 6902 JSON Patch fixes for some OpenAPI documents (`specOverrides`: a
    wrong authorization URL, cookie schemes beside the real key); the registry keeps them, a toolkit added from such a
    source keeps them (`spec_patch`), and each build of its list applies them to the document as it is, before it is
    brought to OpenAPI 3.1 (`openapi/patch.ts`). Fixes that no longer apply (the document changed) leave it as it is,
    and the list says so in its error.
  - _The additions_ (`catalog/additions.json`, `additions.ts`; by hand): `featured`; `services`, filling what the
    registry lacks (Google's Discovery documents for Gmail, Calendar, Drive, Docs, Sheets, Slides, Tasks, People and
    YouTube; the registry wins where it has the same source); `corrections`, which unlike model catalog additions win
    over the registry (a wrong URL, kind or auth method, missing credential settings), each with its `reason` and where
    it was offered upstream (`upstream`, an integrations.sh issue or pull request), since integrations.sh reads much of
    it from docs with an agent; `managed_apps`; and `tool_overrides` by `<service>/<source>` and upstream tool name
    (hidden, renamed, described, classed), which a toolkit added from that source gets as overrides by `catalog` (an
    org admin changes or clears them as any other; until the list is built they show as `missing`).
  - _Adding from the catalog_: `POST /toolkits` with `catalog: { service, source }` takes the source's kind, URL and
    credential settings and the service's slug as the name, for what the body leaves out (a `kind` or `source` given
    must be the source's: `422 invalid`, as an unknown service or source is, with `path: "catalog"`); the source passes
    the outbound guard on save as any source does. A plain member adds a private toolkit this way, as by URL. The
    toolkit keeps the link (`catalog` in its view, the `catalog` column) and the source's way to sign in it was added
    with (`catalog.credential`: `catalog.credential` in the body names its kind, by default the kind of the credential
    connected with it): a `header` or `query` key connected without a `name`, then or later, goes where it says, with
    the header's prefix (`Token`) before it unless it has it; on a toolkit whose source does not say, a key without a
    `name` is `422 invalid` (`path: "name"`).
  - _Managed OAuth apps_ (`catalog/managed-apps.ts`): on Commissary Cloud (`COMMISSARY_MODE=cloud`) a toolkit added from a
    service's entry signs in with Commissary Cloud's own OAuth app with that service (`managed_apps` in the additions:
    client id, endpoints, scopes, and the name of the Worker binding with its secret, `TOOLKIT_OAUTH_<NAME>`), unless
    the org gives the toolkit an OAuth app of its own, which wins (`managed_oauth_app: true` in the views says so; the
    secret is never shown). An app whose secret the deployment does not bind is not offered, so each is optional, and
    a self-hosted Commissary never has one: its toolkits sign in through the org's OAuth app or as Commissary (CIMD,
    dynamic registration). Only the state Worker binds and reads the secrets (`managedAppsOf(env)`, read by the names
    the additions give: the one exception to declaring each binding, AGENTS.md); the app Worker asks the org's
    ControlPlane whether a service has an app (`hasManagedApp`), for the catalog's views. None ships yet (DEPLOY.md,
    "Managed OAuth apps").
  - _Domains_ (`catalog/lookup.ts`): `GET /toolkit-catalog/domains/:domain` answers the catalog's service of the domain
    or of the nearest domain above it (`mcp.linear.app` → `linear`), else integrations.sh's `detect`;
    `POST …/discover` asks `discover` (`429 lookup_rate_limited` when integrations.sh asks to wait, `502 lookup_failed`
    when it cannot be read). The org's ControlPlane throttles them (`catalog/lookup-throttle.ts`, `takeCatalogLookup`):
    one `discover` a minute for the whole org (integrations.sh allows three a minute for everyone), ten `detect`s a
    minute for each member, each in a fixed window kept in the object's memory; past it, `429 lookup_rate_limited`
    saying how long to wait, without asking. A domain the catalog has is never counted. The domain passes the outbound guard as `https://<domain>/` before anything is asked
    (`422` with the guard's message as `error` and `path: "domain"`), every source URL of the answer passes it too (one
    it refuses is left out and named in `refused`), and the requests to integrations.sh go through the guarded client.
    The answer fills one toolkit (a service with the domain's slug) and is never kept: the catalog does not change.
    Adding a domain the catalog lacks is that lookup: the client (the panel's toolkit pages, #208) copies a source of
    the answer into `POST /toolkits` (by `source`, `kind` and `name`, without `catalog`), where it passes the outbound
    guard again.
- **Names** (`tools/toolkits/names.ts`, ADR 0037): a full name is `<toolkit>_<tool>` in `[a-z0-9_]` (the upstream name
  lowercased, every other character `_`); above 46 characters it is cut to 41 and ends in `_` and the first four hex
  characters of the SHA-256 of the whole name, flagged `shortened`. A toolkit's name is lowercase words of `[a-z0-9]`
  joined by single underscores, at most 32 characters (a decision of #196, so a full name keeps room for the tool's);
  the default is the slug of the source's host (`mcp.linear.app` → `linear`), or the catalog service's slug for a toolkit
  added from the toolkit catalog (#207, which picks slugs the same way). Org toolkit
  names are unique in the org; a private toolkit's must not clash with an org toolkit or its owner's other private
  toolkits, while an org toolkit may take a name a member uses privately.
- **The flat list** (`tools/toolkits/resolve.ts`): who looks decides the set, the org's toolkits for the org's names, or
  the org's and one member's private toolkits for that member (`servedTools`; the MCP endpoint serves what of it the
  member reaches). A member's private toolkit wins over an org toolkit of its name for them alone (the org toolkit is
  `shadowed` for them, the private one `rename_suggested`). Uniqueness is checked on the full name, so `github_rest` +
  `create_issue` and `github` + `rest_create_issue` cannot both hold `github_rest_create_issue`: a renamed tool wins (an
  admin's rename stands against a tool a refresh brings later), then the tool seen first; the others are hidden and
  flagged `clash`. A rename to a full name a served tool of the set holds is refused (`409 name_taken`).
- **Stable ids and overrides**: a tool's stable id is its toolkit's id and its upstream name (`<toolkit id>:<upstream
  name>`), not the name shown. An org admin may hide, rename, re-describe or reclassify a tool of an org toolkit, a
  member one of their private toolkits (`PUT /toolkits/:id/overrides`, the whole override at its revision, `0` when the
  tool has none). One that sets nothing clears it but keeps its row and revision (a tombstone), so revisions never go
  back and a write based on the override before the clear is refused. Overrides are keyed by stable id, so they survive
  renames of the toolkit and refreshes; an override of a tool its source no longer lists is shown flagged `missing`,
  and clearing it answers `{ id, removed: true }`, as the tool then leaves the list.
- **Tool class** (ADR 0038): an MCP tool is `read` when its annotations say `readOnlyHint: true`, an OpenAPI tool when
  its method is `GET` or `HEAD`, a GraphQL tool when it is a query field, else `write`; an override's class wins.
- **Prices** (`tools/toolkits/price.ts`, #199, ADR 0038): an org admin prices a call of an org toolkit's tools in
  micro-USD, on the toolkit (`PATCH /toolkits/:id` `price_micros`; `null` clears it) or per tool in its override
  (`price_micros`, which wins, so `0` makes one tool of a priced toolkit free; the override is written whole, so one
  that leaves the price out clears it). A whole number from 0 to 10^12 (US$1,000,000), else `422 invalid`; a private
  toolkit takes none (`422 invalid`): a member may not price the tools of their own. A tool without a price costs
  nothing and, unlike a model without one, is not flagged: most tools are free. Prices are columns of `toolkits` and
  `tool_overrides` (`price_micros`, added by `ALTER TABLE` to a ControlPlane from before them, so nothing is priced
  after an upgrade). Views show the toolkit's price, the override's and each tool's effective price; the org export
  carries the toolkit's and the override's. A call is priced in the ControlPlane when it is called, so a later price
  change prices later calls only.
- **Usage and Spend of tool calls** (#199): each call that reaches a tool leaves a usage record (_Usage accounting
  and observability_, "Tool calls"), written by the endpoint off the response path; a priced call is checked against
  the caller's Spend limits before the upstream is reached and charged on a result (_Spend limits_, "Tool calls"). A
  toolkit's shared credential may carry Spend limits of its own (`POST /spend/limits`, `kind: "toolkit_credential"`, `subject`
  the toolkit's id); they go when the toolkit is removed or its shared credential disconnected.
- **The MCP endpoint** (`tools/mcp/endpoint.ts`, `tools/mcp/protocol.ts`, #197): `POST /mcp` on the API host (a client
  API path, `CLIENT_API_PREFIXES`; on a Commissary Cloud stage with one host also the zone route `/mcp*`), behind the
  API Worker's client gate like the model routes: a member's API key in any form the gate reads, the cross-site checks (a foreign
  `Origin` is `403`, the transport's DNS-rebinding rule) and, on Commissary Cloud, the org's request-rate ceiling. A
  `401` there carries `WWW-Authenticate: Bearer`, with `resource_metadata` on Commissary Cloud (its OAuth server, below).
  A key's tool scope (_API keys_) narrows what the endpoint lists and calls.
  **Behind Access** (#251, ADR 0045): a self-hosted Commissary's app Worker mounts the same routes on the app host at
  `/mcp` for `global` and `/o/<slug>/mcp` for another org (Tools' `mcpRoutesAt`, from `@commissary/tools/management`;
  `apps/app/src/http/mcp.ts`), in a zone of their own (`management/zones.ts` `mcp`, classified before the panel pages),
  for MCP clients that Access signs in: through Managed OAuth when it is on, else with a `cloudflared` token or a
  service token. Its Access gate verifies the `Cf-Access-Jwt-Assertion` as for the panel (a person, or a service token
  as its registered role's principal), needs any role in the org the path addresses (`403` otherwise; every `/o/<segment>/mcp` is this zone, and one whose segment is no slug is `403` for everybody), and applies the
  management zone's cross-site checks (no foreign `Origin` or cross-site fetch, JSON bodies); API keys and
  `access_clients` play no part there, and a management key is refused before the management gate would take it
  (`access/authenticate.ts` `authenticateMcp`): every `401` says `Sign in through Access` with
  `WWW-Authenticate: Bearer`. The member's whole reach is served, narrowed by `?toolkits=`; no tool scope applies.
  Service tokens are callers without a member, so they share the one upstream session per credential of such callers
  (_Upstream sessions_ below). On a stage with one host the API Worker gets no `/mcp*` zone route and the bypass
  application leaves `/mcp` out (`infra/access-config.ts` `zoneRoutedPrefixes`, `CLIENT_API_PATHS`), so the app host's `/mcp` is this endpoint and the
  API-key one needs an API host. Commissary Cloud's app Worker answers `/mcp` `404` like the client API; its MCP
  clients use the API Worker's with Commissary's own OAuth (_Commissary Cloud_, "OAuth for MCP clients"). Commissary speaks the protocol itself
  rather than through the MCP TypeScript SDK or Cloudflare's `createMcpHandler` (neither is a dependency): it serves
  five methods with one JSON answer each, and the area's client already speaks both eras by hand. Effect's own
  `McpServer` (`effect/ai`) does not fit either: its HTTP layer (`layerHttpRequestScoped`) is sessionless only, so it
  has no 2025 era; it registers tools once on a server shared by every request, where this list is each member's; and it
  is an unstable API. Each POST is one JSON-RPC message answered with one JSON object (never an SSE stream); a
  notification is `202` (`400 UnsupportedProtocolVersion` under a revision neither era speaks); `GET` and `DELETE` are
  `405`, as the 2026-07-28 revision's backward compatibility asks of a server without sessions. **Both eras per
  request**: one that names its revision in `params._meta` (or `2026-…` in `MCP-Protocol-Version`) is served statelessly
  by 2026-07-28 (`server/discover`; the `MCP-Protocol-Version`, `Mcp-Method` and `Mcp-Name` headers must match the body,
  `400 HeaderMismatch`, `-32020`; a revision it does not speak is `400 UnsupportedProtocolVersion`, `-32022`, with the
  supported list; an unknown method `404`; results carry `resultType` and the server's name in `_meta`); anything else
  is a 2025 client (`initialize` answers 2025-11-25, 2025-06-18 or 2025-03-26 as asked, else the latest; no
  `Mcp-Session-Id` is minted, which Streamable HTTP allows, so the requests after it need nothing of it; their
  `MCP-Protocol-Version`, when they send one, must be one of those or 2024-11-05, else
  `400 UnsupportedProtocolVersion`). In either era an upstream result's `io.modelcontextprotocol/*` `_meta` keys are
  left out (they speak of the upstream's revision and server); its other keys pass. Methods: `initialize`,
  `server/discover`, `ping`, `tools/list`, `tools/call`; no resources, prompts or `subscriptions/listen`.
  - **The list** (`ToolsPart.clientTools`): one page, sorted by full name (deterministic whatever order a source lists
    in), each tool with its full name, description (overrides applied) and upstream input schema (`{type: "object"}`
    without one); read tools carry `readOnlyHint: true` and `destructiveHint: false`, write tools no annotations, and
    upstream annotations never pass. A modern answer says `ttlMs: 0` and `cacheScope: "private"` (the list is the
    member's, and an override shows at once). `?toolkits=a,b` narrows the list, and the calls, to those toolkits by the
    names the member sees (case-insensitive); an unknown name narrows to nothing.
  - **Reach** (`ToolsPart.#reachable`, `tools/grants/reach.ts`, ADR 0038): a member uses, as themselves, every served
    tool of their own private toolkits (while the org allows private toolkits) and of every org toolkit that takes
    private credentials, while the org lets members hold private credentials (otherwise none could be connected); and
    the served tools of org toolkits' shared credentials their tool grants give (_Grants_ above), where the toolkit
    accepts a shared credential and has one. A grant never gates an org toolkit whatever the credential (ADR 0038's
    rejected option), and nothing is granted by default. A tool outside reach is not listed, and calling it answers what
    an unknown tool does (`-32602 Unknown tool`). A request without a member is named only by grants for everyone.
  - **Calls** (`ToolsPart.callTool`): the full name is resolved in the ControlPlane, where the secrets are, to its
    toolkit and upstream name, and called on the member's private credential when they reach the tool as themselves
    and hold one (it wins over a granted shared one; a call never uses another member's), else on the shared
    credential a grant gives them; reaching it as themselves without either asks them to connect theirs. Upstream
    sessions are the calling member's, on a shared credential too (_Upstream sessions_). The upstream result passes
    through as it is, `isError` included; an upstream or transport failure is a tool result with `isError` and the
    client's short message (`McpError`: no URL, no body), logged as a warning with the toolkit's id and the error's
    reason and status only. An upstream call (`callUpstreamTool`, `mcp/client.ts`) speaks the era the upstream does,
    with the stateless revision's `Mcp-Name` and the `Mcp-Param-*` headers its input schema's `x-mcp-header` asks for,
    within 240 seconds; an upstream that asks for input (`InputRequiredResult`) is a failure, as Commissary relays none
    of an upstream's requests (its own approval form, below, is Commissary's, not the upstream's).
  - **Missing private credential** (ADR 0036): a tool that needs the member's private credential, without one, answers a
    link to the panel's connect page, `https://<app host>/o/<org slug>/tools/<toolkit id>/connect` (`panelPageUrl`,
    `@commissary/state`, as Billing's link to the billing page). The API Worker gets `APP_DOMAIN` on every deployed
    stage, one host or split; without it (a preview, `alchemy dev`), or when the Platform registry cannot name the org's
    slug, the words "the toolkit's page in the panel" stand in, and nothing is elicited. The page is the panel's
    `/tools/$toolkitId/connect` (`tools` is in `PANEL_SECTIONS`, `apps/app/src/management/zones.ts`; _Panel_ below).
    A 2026-07-28 client that declares URL elicitation
    (`clientCapabilities.elicitation.url`) gets an `InputRequiredResult` (MRTR) whose `connect_<toolkit>` input request
    is a URL-mode `elicitation/create`, again on each retry until the credential is there; a declined or dismissed
    elicitation, and every other client, get the link in a tool result with `isError`. **A 2025 client never gets an
    elicitation**: it would need the request's SSE stream and a session to send the request on and wait for the answer,
    which this endpoint keeps neither of, so it gets the tool result (approvals follow this choice: a 2025 client gets a
    pending approval's link, _Approvals_ below).
  - **Upstream sessions** (`toolkit_sessions`, ADR 0038): what a call learned of an upstream is kept per toolkit,
    credential and calling member (a request without a member is one caller), for that caller's next call on it, so
    members sharing a credential never share an upstream session's state (#198; sessions kept from before, per toolkit
    and credential only, are dropped on upgrade): a 2025 server's revision and `Mcp-Session-Id`, or a stateless
    server's revision (so its calls skip the handshake). A session is kept seven days from when it opened at most:
    past that the next call opens a new one, and the part's alarm deletes it. A server that answers `400` or `404` in a
    kept session lost it (a 2025 session it ended, or an upstream that changed eras): it gets a new handshake and the
    call once again. Any failed call deletes the session it was made in (unless the credential changed meanwhile, or
    another call already replaced it), so the next call starts afresh; connecting or removing the credential, removing
    the toolkit and the member's leaving delete it too. Every caller without a member (service tokens, org API keys)
    is one caller, so they share one upstream session per credential: accepted for now, as all of them act for the
    org; keying their sessions by principal is a possible follow-up.
- **Approvals** (`tools/approvals/`, `tools/management/routes.ts` `/approvals`, #201, ADR 0038): an approval rule makes
  calls of some of a toolkit's tools wait for an approver. A toolkit's rules (`approval_rules`, a JSON column of
  `toolkits`, added by `ALTER TABLE` to a ControlPlane from before them, so nothing waits after an upgrade) are the
  toolkit-wide "write tools require approval" switch (`writes`), which follows each tool's resolved class, so a
  reclassified tool changes at once whether it waits, and marks on single tools by stable id (`tools`; a mark wins
  over `writes`, so a marked tool waits for its mark's approver whatever its class). Each names its approver: the
  caller (the default), a team or a list of members; of a team or a list any member but the caller decides, even when
  the caller is in it (teams are read when someone decides). Rules apply to every call on the toolkit, whatever the
  credential, and to the built-in toolkits' tools too (stored apart, _Built-in toolkits_). An org admin sets them on
  an org toolkit and a member on their own private toolkit, written whole with the toolkit at its revision (`PATCH /toolkits/:id`, `approval_rules`, `null` clears them; `422 invalid` for a mark of
  another toolkit's tool, a tool marked twice, an empty list, or a team or member the org does not have); views show
  them to whoever reads the toolkit, and the org export with approvers by team name and email. A member who leaves
  leaves every list (a list may end up empty: nobody decides its calls); a deleted team's rules stay, and nobody
  decides their calls until an admin names another approver: a rule fails closed. A toolkit's view flags such a rule
  `nobody_decides: true` (a team the org no longer has, a list none of whose members is left), and the panel words a
  warning for it (`apps/web` `lib/approvals.ts`: `approvalRulesWarnings` for the rules editor, #209, and on an
  approval's page, whose approver then has no team name or no member emails).
  - **A change of the rules** (`ToolsPart.#dropOrphanedApprovals`, after `PATCH /toolkits/:id` and after an override
    is written): every pending approval (and form) of the toolkit whose tool's rule no longer names the approver it
    stored, compared as canonical JSON, is deleted: the rule was removed or narrowed, its approver changed, or the tool
    was reclassified out of it (or is gone). An approval never outlives its rule, so restoring the rule brings none
    back: the identical call waits anew.
  - **Order of checks** (`ToolsPart.callTool`): reach, the credential (a missing private one answers its connect link),
    the Spend check, then the approval, then the upstream. The approved call is the one made again, so it passes reach
    and the Spend check again before it goes upstream; approving makes no call.
  - **The caller as approver, on a form**: a 2026-07-28 client that declares form-mode elicitation
    (`clientCapabilities.elicitation.form`, or an `elicitation` naming neither mode) gets an `InputRequiredResult`
    (MRTR) whose `approval` input request is a form-mode `elicitation/create`: the message shows the tool, its toolkit
    and the arguments as indented JSON, and the form has no field (`properties: {}`), so accepting approves and
    declining or dismissing denies. The result carries a `requestState` that binds the answer to this call: the id of a
    **form** row in `tool_approvals` (`form = 1`, no arguments, the caller, tool and arguments' hash, an hour to live)
    and, sealed with the org's data key for it (`tool_approvals/<id>/form`), that id, the tool's stable id and the hash.
    The call made again with `inputResponses.approval` and that `requestState` finishes in that call: accepted, it goes
    upstream (`approved_elicitation`); otherwise it answers a tool error (`denied`). The answer counts only when the
    state opens, names its row, matches the call's tool and hash, and the row is unanswered, of the same caller and
    within its hour; it is then settled, so a form is answered once. An answer without such a state (sent unasked, with
    other arguments, by another caller, again, or late) is no answer: the caller is asked again, with a new form. Forms
    are not pending approvals: never listed, shown or matched by a repeated call. A 2025 client never gets a form (the
    connect link's reason above), nor does a client without form elicitation: they take the pending path, where the
    caller decides in the panel.
  - **Pending** (`approvals/store.ts`, the `tool_approvals` table): every other call that waits answers a tool result
    that is not an error (`isError: false`: the call is not refused, it waits) saying it waits, for whom, and until
    when, with the link to its approval page, `https://<app host>/o/<org slug>/approvals/<id>` (`panelPageUrl`; "the
    approvals page in the panel" without an app host), and creates a **pending approval**: the caller (their member, or the principal of a caller without one),
    the tool's stable id and full name, the credential slot, the approver the rule named then, the hash of the
    arguments and the arguments themselves, **sealed with the org's data key** for the row (`tool_approvals/<id>`):
    the one place Commissary keeps a tool call's content. A repeat of the same call (same member, tool and hash) while
    it is undecided answers the same approval rather than another. Once an approver approves it, the same call goes
    through **once** (`approved_panel`) and only until the approval's hour, counted from the call, is over: approving
    starts no new hour. The approval is then settled, so a third identical call asks anew, as does one with other
    arguments; a repeat after a denial answers that it was denied (`denied`) and settles it. A repeat after the hour
    finds no approval (it expired, and is gone) and waits for a new one. A caller without a member (a service token)
    under a rule of the caller, without a form, is answered a tool error that no one can approve it (`not_approved`,
    reason `no_approver`, recorded `denied`): no member could decide it in the panel.
  - **The hash**: SHA-256 (hex) of the arguments in the JSON Canonicalization Scheme's form (RFC 8785) for what
    arguments hold: object keys sorted by UTF-16 code units at every depth, arrays in order, no whitespace, strings and
    numbers as `JSON.stringify` writes them; absent arguments are `{}` (`approvals/hash.ts`).
  - **Expiry** deletes an approval (or form) an hour after its call, arguments and all, enforced both lazily and by the
    alarm: every read ignores a row whose `expires_at` has passed, so an expired approval is never listed, shown
    (`404`), decided or used, and the part's alarm (the earliest of the sessions' next time and the approvals'
    `MIN(expires_at)`) deletes the rows. A decision deletes the arguments at once. Nothing says "expired": the approval
    is gone, there is no `expired` status, reason or record value. The part reads the time from a `Clock`
    (`ToolsPart.useClock`, the live one by default) so tests drive the hour with `TestClock`. Pending approvals are
    not part of the org export.
  - **Deciding** (`GET /approvals`, `GET /approvals/:id`, `POST /approvals/:id/decision` with `{decision: "approve" |
    "deny"}`, a member route): an approval shows to its eligible approvers, with its arguments while it waits, and to
    its caller, without them unless the caller is its approver; anyone else, org admins included, gets `404`. Only an
    eligible approver decides (`403 forbidden` for the caller under a team or list rule), once (`409 conflict`) and
    within its hour (`404` after). An approval's `status` is `pending`, `approved`, `used` (approved, and its call went
    through once: beyond the issue's words, so the page can say so) or `denied`. The pending list holds the undecided approvals the member may decide or made; the panel groups it
    by approver set (`apps/web` `/approvals`, and each approval's page at `/approvals/<id>`, the link's target). No email
    or Slack notices.
  - **Records**: a call that waits writes its usage record when it ends: when it answers pending (`tool_outcome`
    `approval_pending`, `approval` `pending`), is not approved (`not_approved`, `denied`: denied on its form or page,
    or `no_approver`), or goes upstream (its outcome, `approved_elicitation` or `approved_panel`); a call no rule holds
    records `none`. The form's first round (`InputRequiredResult`) writes none. Records never hold the arguments. The
    outcomes `approval_pending` and `not_approved` are beyond #199's list, so usage tells a held call from a failed one.
  - **Members**: a member who leaves takes the pending approvals (and forms) of their calls, arguments and all.
  - **Rollout** (docs/DEVELOPMENT.md, "State RPC: expand, then contract"): `ToolsPart.callTool` returns the approval
    outcomes (`approve`, `pending`, `not_approved`) only to a call with `approvalOutcomes: true`, which the endpoint
    sends. An API Worker from before approvals sends a call without it (and without `approvalForm`, so it is never
    asked to show a form) and gets those as `failed`, an outcome it knows, with words saying the call waits for
    approval (with its id) or was not approved; it records them `upstream_failure` until it is replaced. The flag goes
    once no deployed endpoint lacks it.
- **Who a call is**: on the app host a call is the member's Access principal (`user:<email>`), as a panel request is,
  so what records calls (usage, logs) shows the member, not the MCP client; Access's tokens carry no client. A static API
  key on the API host is the key and its member.
- **Built-in toolkits** (`tools/toolkits/built-in.ts`, #212, #222, #229, ADR 0039, ADR 0041): toolkits Commissary
  provides itself, the **browser toolkit**, the **sandbox toolkit** and the **agents toolkit**. The agents toolkit
  (kind `agents`, source `commissary`) is the exception to most of what follows: the state Worker gives it with the
  Agents part where the Agents area is (`LOADER`), it takes no grant (who may run which agent comes from the agents),
  the MCP endpoint's Worker makes its calls, and the part shows it only to callers that ask for it (_The agents toolkit
  and child runs_ under Agents). One exists exactly when the deployment has what it runs
  on: the state Worker's composition hands the Tools part the providers its env's bindings give (`new ToolsPart(ctx,
  core, builtInProviders(env))`; a `browser` binding gives Browser Run, and the Worker Loader with the sessions'
  namespace, which every deployment has (ADR 0043), gives Cloudflare's sandbox). Without its binding
  (`COMMISSARY_BROWSER=off`, ADR 0043) the browser toolkit is missing everywhere: not in toolkit lists, the MCP endpoint's list or calls (an unknown tool),
  the export or the grants list, and a grant naming it is refused like one of a toolkit the org lacks; nothing else
  changes. A built-in toolkit is not stored: the part lists it
  beside the stored toolkits as an org toolkit with a fixed id, its name (`browser` or `sandbox`, never a `tk_…` id),
  its kind (`browser` or `sandbox`), source its provider (`browser-run` or `cloudflare`), `accepts: "shared"`, `built_in: true`, revision 1 and the epoch as its
  times, and a tool list from code (a `BuiltInToolkit`, `tools/toolkits/toolkit.ts`, beside the rows' `StoredToolkit`
  of kind `mcp`; what only a stored one takes goes through the part's one resolver, `#stored`). Its shared credential is Commissary's own binding, shown as kind `none`, so tool
  grants decide who reaches it, and there is no default grant: an org admin grants it like any org toolkit (all tools,
  read tools or named ones, stable ids `browser:<tool>` and `sandbox:<tool>`). A call is recorded in usage like any tool call (#199, on the
  shared credential) and charged a tool override's price, if an org admin set one (and the browser toolkit's browser
  time at its price per browser hour, #214, and the sandbox toolkit's computer time at its price per computer hour,
  #224). Overrides (hide, rename, re-describe, reclassify) and grants on it are stored by its id in the usual tables,
  kept while the binding is absent and applied again when it is back. So are its approval rules (#201), which apply as
  any toolkit's: `PATCH /toolkits/browser` with `approval_rules` only, at its revision, stored in `built_in_toolkits`
  (its revision, rules, the sandbox's network, its price per hour (the browser's per browser hour or the sandbox's per
  computer hour, one column) and last change: it has no `toolkits` row), so its revision moves on from 1 with each
  change of its rules. The sandbox toolkit also takes `network`, its ceiling (below); a network on the browser toolkit
  answers `403 built_in`, on a stored one `422 invalid`. The browser toolkit also takes `browser_hour_price_micros`
  (#214), its price per browser hour (below), a whole number of micro-USD from 0 to 10^12 (`null` clears it; `422
  invalid` otherwise), shown on its view and carried by the org export; the sandbox toolkit takes
  `computer_hour_price_micros` (#224), its price per computer hour (_Spend limits_, "Computer time"), the same way. Each
  answers `403 built_in` on the other built-in toolkit and `422 invalid` on a stored one (`HOUR_PRICES`,
  `tools/toolkits/price.ts`). Renaming it, changing what it accepts, connecting or removing a credential, refreshing its
  list and removing it answer `403 built_in`; while it exists its name is taken (`409 name_taken`) for org and private
  toolkits alike, so a member cannot add a private copy (and adding a toolkit takes an MCP URL anyway). A stored
  toolkit, org or private, named `browser` (or `sandbox`) from before the deployment had the binding is renamed once
  when the part starts with it, to the first `browser_<n>` (`sandbox_<n>`) from 2 that no toolkit of the org has, by
  `commissary` (its revision moves on). Its tools hold their full names against a stored toolkit's (they count as seen
  first). API keys' tool scopes (ADR 0036) do not exist yet; `?toolkits=browser` narrows to it as to any toolkit.
  - **The browser toolkit's tools** (`tools/browser/toolkit.ts`): Browser Run's stateless Quick Actions, all of class
    `read` (Commissary sets its own tools' class: `readOnlyHint`): `browser_markdown`, `browser_html`,
    `browser_screenshot`, `browser_pdf`, `browser_links`, `browser_scrape` and `browser_accessibility_tree`. Each takes a
    URL (`http` or `https`; the browser reaches the open web, ADR 0044, so no outbound guard) and the Browser Run options
    that make sense for a client, under Browser Run's names (`waitUntil`, `timeout`, `waitForSelector`,
    `waitForTimeout`, `viewport`, `userAgent`, `rejectResourceTypes`, `javaScriptEnabled`, and per action the
    screenshot's `selector`, `fullPage`, `type`, `quality`, the PDF's `format` (`letter`, `legal`, `tabloid`,
    `ledger`, `a0` to `a6`), `landscape`, `printBackground`, `scale`,
    `pageRanges`, the links' `visibleLinksOnly`, `excludeExternalLinks`, the scrape's `selectors`, the tree's `root`,
    `interestingOnly`); each is one record of `QUICK_ACTIONS` (its description and the Effect schema of its arguments,
    which is the tool's input schema, `Schema.toJsonSchemaDocument`). Left out:
    what would run script in the page (`addScriptTag`, ADR 0039), carry sign-ins (`cookies`, `authenticate`, extra
    headers: logins are browser profiles' and handoff's, below), render given HTML, pick a backend, and the cache (`cacheTTL` is always
    `0`). A result is a text content (Markdown, HTML, or JSON for links, scraped elements and the tree), an `image` (a
    screenshot) or an embedded `resource` with a `blob` (a PDF, its `uri` the page's URL), at most 10 MiB (a larger
    declared length is refused unread; a body is read in chunks and cancelled as soon as it passes the limit), and is
    kept nowhere. Invalid arguments and Browser Run's refusals (its own `errors` messages, at most 500 characters) are tool
    results with `isError`, logged as a warning with the provider, action and status only. Browser Run's `/json` (an AI
    model under the deployment's account) is left out (#212). Browser time in usage records and its price: below.
  - **Crawls** (`tools/browser/crawl-tools.ts`, `browser-run-crawls.ts`, `crawls.ts`, #270): `browser_crawl_start`
    (`write`) starts crawling a site from a URL and answers the crawl's id at once (text, and `structuredContent`
    `{crawlId}`); `browser_crawl_result` (`read`) answers the crawl as JSON: its `status` (`running`, `completed`,
    `errored`, `cancelled_by_user`, `cancelled_due_to_timeout`, `cancelled_due_to_limits`), `total`, `finished`,
    `skipped`, its pages (`records`, each Browser Run's: URL, status, content in the formats asked, metadata) and a
    `cursor` while there are more, `limit` pages at a time (default 5, at most 20), optionally of one page `status`; an
    answer over 1 MiB (`MAX_CRAWL_RESULT_BYTES`) is refused unread, telling the caller to ask for fewer from the same
    cursor, so a few large pages fill neither the ControlPlane's memory nor the model's context; `browser_crawl_cancel`
    (`write`) cancels it, its pages staying readable. Browser Run's `/crawl` is on its REST API only, not the binding:
    the adapter calls `https://api.cloudflare.com/client/v4/accounts/<account>/browser-run/crawl` (`POST`, `GET /<id>`,
    `DELETE /<id>`) with the deployment's optional API token (held `Redacted`, unwrapped only to send it), so the crawl
    tools are listed only on a deployment with the binding and `BROWSER_RUN_API_TOKEN` (a provider's `crawls`, a
    capability like `sessions`); without it nothing changes. Cloudflare's API reference still names the path by the
    product's old name, `/browser-rendering/crawl`: it is the one to fall back to should `/browser-run/` stop answering.
    Each request is aborted after a minute (the timeout aborts the `fetch`'s signal); one race is left, a `POST` Browser
    Run accepted whose answer was lost, whose crawl is logged for no one and ends by itself at its page limit or after
    seven days. A crawl takes Browser Run's own options under its names (`limit`, `depth`, `source`, `formats` (`html`,
    `markdown`), `render`, `modifiedSince`, `options` (`includeExternalLinks`, `includeSubdomains`, `includePatterns`,
    `excludePatterns`), `crawlPurposes`, `contentUse`, and the page's `waitUntil`, `timeout`, `waitForSelector`,
    `rejectResourceTypes`); `limit` is at most the deployment's cap (`COMMISSARY_CRAWL_MAX_PAGES`, default 1000, Browser
    Run's own ceiling being 100000), and `depth` at most 100 links deep, as each page's browser time lands on the
    deployment's account. Left out are sign-ins (`cookies`, `authenticate`, extra headers), Browser Run's cache
    (`maxAge`), as for the Quick Actions, and the `json` format, which runs Workers AI under the deployment's account,
    as `/json` is. Unlike a Quick Action's, the crawl's starting URL is guarded (ADR 0044): `https:` only, no private
    address, none of the deployment's own hosts (`checkOutboundUrl` with the call's policy), refused as `Invalid
    arguments: Commissary only reaches public HTTPS addresses` before Browser Run is asked; the pages the crawl then
    follows are Browser Run's to fetch, from its network. Browser Run's crawl ids are account-wide, so a crawl belongs
    to the member and principal that started it, like a session: the Tools part logs each one it starts
    (`browser_crawls`: id, toolkit, member, principal, start; the member null for a caller that is no member), and a
    result or cancel of an id not logged for the caller answers `There is no crawl <id>.`, as an id never started,
    without asking Browser Run (a call without a principal is refused). The part forgets a crawl 21 days after its start
    (`CRAWL_KEPT_MS`: Browser Run's longest run, seven days, and the 14 days it keeps the pages, from the part's alarm).
    A member's leaving first asks Browser Run to cancel their crawls that may still be running (started less than seven
    days before), as far as it answers, then forgets them all; the org's deletion cancels the org's the same way, in
    Tools' org-deletion step (`purgeBrowserCrawls`, 20 a call within the deletion's budget), since `wipe()` is
    synchronous and cannot call Browser Run. Commissary keeps nothing of the pages; Browser Run keeps them 14 days after
    a crawl ends. Browser Run's refusals (a site whose Content Signals refuse the crawl's purposes answers 400) are tool
    results with `isError` in its own words.
  - **Browser time** (#214, ADR 0039): Browser Run's binding reports the browser time an action used in its
    `X-Browser-Ms-Used` header (on a refusal of the page too, below status 500), which the adapter answers with the
    result or the failure; the call's usage outcome carries it (`CallUsage.browserMs`) and its record holds it
    (`browser_ms`, `migrations/usage/0012_usage_browser_time.sql`). A session's browser time is metered by its object
    (below) and recorded once, when it closes. An org admin may set a price per browser hour on the toolkit
    (`browser_hour_price_micros`, above): browser time then costs it, prorated by the millisecond, on top of any price
    per call of the tool (a tool override's), toward the Spend limits (_Spend limits_, "Browser time"). Without one
    browser time is recorded and costs nothing. No record holds a URL, page content or a screenshot. Crawls (#270)
    are not metered yet: Browser Run reports a crawl job's `browserSecondsUsed`, and recording and pricing it is a
    follow-up.
  - **Browser sessions** (`tools/browser/session-tools.ts`, `session.ts`, `session-object.ts`, #213, ADR 0039): an
    interactive browser, on the same toolkit after the Quick Actions, with Playwright MCP's tool set as Commissary's own
    code on `@cloudflare/playwright` (`@cloudflare/playwright-mcp` is archived): `browser_open` (optionally at a URL)
    answers the session's id (`bs_` and 32 hex digits), which every other tool takes as `sessionId`, as MCP calls are
    stateless: `browser_navigate`, `browser_navigate_back`, `browser_navigate_forward`, `browser_snapshot` (the current
    tab's accessibility snapshot, Playwright's YAML for a model, whose `[ref=e3]` references the actions take),
    `browser_click`, `browser_type` (fills a field, `submit` presses Enter), `browser_press_key`,
    `browser_select_option`, `browser_hover`, `browser_wait_for` (a text or a CSS selector, at most 60 s; below),
    `browser_take_screenshot`, `browser_tab_list`, `browser_tab_new`, `browser_tab_select`, `browser_ask_human` (a
    handoff, below) and `browser_close`, and `browser_profile_list` (the browser profiles the caller may open a session from, below; it takes no session). The
    snapshot, the screenshot, the tab list and the profile list are `read` (`readOnlyHint`); the rest are `write`. An action answers the
    page's URL and title afterwards; invalid arguments and the provider's failures (a ref that names nothing, a
    timeout: Playwright's message's first line, at most 500 characters) are tool results with `isError`, and the
    session stays open. No tool evaluates JavaScript in the page or returns an element's value beyond the masked
    snapshot, and there is no CDP endpoint. The session tools are listed while the deployment has the binding and the
    namespace and the provider has sessions (`BrowserProvider.sessions`, a capability flag). A session belongs to the
    call's principal, so a call without one (`principalId` unset) is refused with a tool error. `browser_wait_for`'s
    selector (and the handoff's selectors to mask) are CSS only, sent to Playwright as `css=`: a `>>` chain, another
    engine's prefix (`xpath=`, `text=`, `internal:…=`), a CSS escape or comment is refused; so are, for a wait, an
    attribute selector on `value` and any attribute selector on an input or a text area, as a wait answers whether its
    selector matched and `input[value^="a"]` would read a masked field one character at a time.
    - **The Durable Object** (`BrowserSession`, in the state Worker beside the ControlPlane, ADR 0030): one per
      session, named `<org>:<id>` and reached only by its org's Tools part (`browserSessions`), so the same id from
      another org reaches another, empty object. It keeps its owner (the org, the member and the call's principal:
      `key:<id>` for an API key, `user:<email>` for a person through Access, so another member, another API key of the
      same member or the same member through Access answers `Unknown browser session <id>`, exactly as an id never
      opened; a hosted agent's run, #232, will be a principal of its own), the provider it opened on (the toolkit's
      source, from which it finds the provider's browsers again: `sessionProviderOf`) and the provider's id of the
      browser, the id of the browser profile it opened from, whether its browser was reached again on a new connection,
      the current tab's index, the fields to mask and its times,
      nothing of the pages (nor of the profile's state); what it stored is
      decoded with a schema. Its calls and its alarm run one at a time (a promise chain): a Durable Object takes
      another call while one waits on the browser. Its alarm closes it after 10 minutes (`IDLE_TIMEOUT_MS`)
      without a call (each call moves it), ending the browser at the provider; `browser_close` does at once; a browser
      the provider ended itself (Browser Run on a release of its own) closes it too. A closed session answers `Browser
      session <id> is closed (<why>)` with `isError` for a day, then forgets everything and answers as unknown. A
      connection the object holds is reused while it lives; one that dropped, or an object that restarted, reaches the
      browser again by its id, in the same current tab, and only a browser the provider no longer has ends the
      session. No caps on sessions per org or member (ADR 0039's amendment): Browser Run's refusal at the
      account's limit (429: its concurrent browsers or new browsers per second) answers `browser_open` with a tool error
      that says so.
    - **Browser profiles** (`tools/browser/profiles.ts`, the part's profile methods, #215, ADR 0039, GLOSSARY "Browser
      profile"): saved logins and site data a session can start from: a Playwright storage state (cookies and each
      origin's local storage; not IndexedDB), the provider-neutral `StorageState` of `provider.ts`. A profile is created
      empty and named (`POST /browser-profiles`), renamed (`PATCH`) and removed (`DELETE`, with its grants) at its
      revision (`If-Match`); it is kept until removed, its member's private ones until they leave the org. It is not a
      credential: one holds logins to many sites. Stored in the ControlPlane's SQLite (`browser_profiles`, one row per
      profile, and `browser_profile_grants`; the part's `wipe` drops them, and they are not keyed by a toolkit), its
      state sealed with the org's data key for its row (`browser_profiles/<id>`, `enc:v1:`), `NULL` until a session
      saves into it. Only the Tools part opens it, to hand it to the session's object over RPC; the object keeps the
      profile's id only. Who may do what:
      - A **shared** profile is an org admin's to create, rename and remove; the profile grants
        (`/grants/profiles`, `BrowserProfileGrantsGroup`: a member, a team or everyone, as the other grants; org admins
        only) decide who may use it, and there is no default grant, so an org admin needs one too. Only an org admin
        saves into it, so a member with a grant cannot replace the org's login with their own.
      - A **private** profile is one member's (a plain member's profile always is; an org admin's when it says so),
        needs no grant and is saved into only by its member. An org admin sees only that it exists (`others`: its member
        and dates, not its name, as for private toolkits) and may remove it. It follows the org's `private_toolkits`
        setting: while it is off, no private profile is created (`403 private_toolkits_unavailable`), opened or saved
        into, and the ones there are kept.
      - **Names** are 1-64 of `[a-z0-9_-]`, scoped as toolkits' are: a shared profile's unique among the shared ones, a
        private one's among its member's and the shared ones; a shared profile added later with a private one's name
        is shadowed by it for that member.
      - **Opening**: `browser_open`'s `profile` names one the caller may use (their private ones while the setting
        allows them, and the shared ones a profile grant gives them); any other name, whether it does not exist, is
        another member's or another org's (the part resolves it among its own org's only) or lacks a grant, answers the
        same tool error, `Unknown browser profile <name>`, and opens nothing. The session starts from the state the
        profile holds (Browser Run's adapter loads it into the browser's default context, below).
        `browser_profile_list` lists the usable ones by name; `browser_open`'s description points at it (one static
        description per tool, as the tool list and its overrides are not per caller).
      - **Saving** is explicit: `browser_close` with `save: true` reads the browser's state, closes the session, then
        saves the state into the profile the session opened from, replacing it whole (two sessions saving into one
        profile: the later save wins), and moves its `saved_at` (not its revision). A save into a shared profile by
        anyone but an org admin, into a private profile by anyone but its member (or while the setting is off), into a
        profile removed meanwhile, from a session opened without a profile, or that storage refuses (SQLite's 2 MB per
        value: no quota of Commissary's own) answers a tool error that says why, and the session is closed all the
        same. A save over a browser reached again since the session opened keeps its cookies but misses the local
        storage of the sites visited before, and says so (Browser Run's sessions, below). A stored state that does not
        open (sealed for another row or org) answers `browser_open` with `The browser profile <name> could not be
        read.`, and opens nothing. The usual way to log in is to open an empty profile, use a handoff (#216), and close with `save`.
      - **Isolation**: a profile lives in its org's ControlPlane, so it opens only in its own org, and a private one
        only for its member; a grant naming another org's profile id is refused (`422 invalid`). The cross-org suite
        has a case for it (`controlplane: browser profiles`). The management API answers whether or not the deployment
        has the browser toolkit: a profile is org data, kept while the binding is absent, like the toolkit's grants.
    - **Its browser time** (#214): the object meters it from asking the provider for the browser to closing the
      session (for a browser the provider ended itself, to when the session learnt so). Each call passes the toolkit's
      price per browser hour (`SessionMetering`) and answers, with its result, the time since the call before and what
      it cost at the price in force since then (`SessionAnswer`), which the Tools part charges with the call; the
      call's own record carries only its price per call. The stretch is committed with the call's last storage write,
      after everything that can fail, so a call that fails before it leaves the stretch to the next call (one whose
      answer is lost after that write, in transit, is the one stretch the record holds and no limit counted). When the
      session closes, however it closes, the object writes its usage record (`insertBrowserSessionRecord`, into
      `USAGE`, which the state Worker binds for it): `request_id` the session's id (so it is written once), the toolkit,
      no tool and no outcome, its principal (which names the API key) and member, the browser profile it opened from
      (`browser_profile_id`, #215), `browser_ms` from opening to closing and `cost_micros` the sum of what it was
      charged. Its alarm has no call to charge the last stretch with, so it reports the close with that stretch's cost
      to the org's ControlPlane (`stub.tools().browserSessionClosed(id, costMicros)`), which charges it to the limits of
      the session's opener as the part logged it (a session it did not log, or a cost that is not a whole number of
      micro-USD from 0, charges nothing). The close is stored first, with what is left to do (`unrecorded`, `owed`); a
      record write or a report that fails is tried again from the alarm every minute (`SETTLE_RETRY_MS`) until the
      closed session is forgotten a day on, and each is done once. The Tools part logs the org's open sessions
      (`browser_sessions`, `tools/browser/session-log.ts`: id, toolkit, member, principal, opening, the browser profile it
      opened from and until when a handoff waits, #216, which the Browser sessions page lists), forgetting one a
      call closes or whose alarm's close it hears of; the org's deletion deletes each logged session's object at once,
      without a record or a report (`ToolsPart.purgeBrowserSessions`, 20 a call, `BrowserSession.purge`), so no alarm
      of a deleted org's writes a usage row or wakes its wiped ControlPlane. A session opened before metering keeps
      working: it counts as the browser toolkit's, metered from its opening, free so far, and is not logged (it closes
      within its idle minutes).
    - **Deploys** (docs/DEVELOPMENT.md, "State RPC: expand, then contract"): the metering is an optional last argument
      of the object's `open`, `operate` and `close`. A Tools part from before #214 passes none and gets the bare tool
      result it expects; its calls meter nothing (their stretch is the next metered call's, or free at its close). A
      part from #214 on takes an object from before's bare answer as one that used no browser time (`browserSessions`),
      so during a deploy no call fails, and only time no one metered goes unpriced.
    - **Masking** (`session.ts`): Playwright's snapshot copies every input's value as the element's text, password
      fields' included and whatever the input's role (`<input type="password" role="button">` too), so the session
      masks the snapshot before anyone sees it. The masked selectors are `input[type="password" i]` plus the fields a
      handoff filled (#216, below: the object adds them through the same hook as `BrowserSession.maskFields(caller,
      selectors)`). It first counts the elements
      that match them in every frame; a page without any is shown as it is. Otherwise every element of the snapshot
      that shows a value, on its line or in its `- text:` lines, is asked about in one batch (by its ref), and the
      value of each that matches, of each the browser gave no ref (not interactable) and of each whose element cannot
      be found is replaced by `••••••••` (fails closed; on such a page a text without a ref is masked too). The session
      never reads a field's value. Screenshots paint the same selectors over in every frame (Playwright's `mask`).
      A sign-in form sent with GET puts its fields, the password included, in the next page's URL, which the session
      shows (the action's answer, the snapshot, `browser_tab_list`): once a handoff marked fields, every URL the
      session shows has its query's values masked (`?user=••••••••`); before that, a password a client typed into such
      a form shows in the URL, as the client typed it. The masking reads Playwright's rendering of its snapshot for a
      model (`renderAriaTree`, internal to Playwright) and the snapshot method itself (`_snapshotForAI`): that is why
      `@cloudflare/playwright` is pinned exactly and Dependabot leaves it out. A bump needs a manual check: capture a
      sign-in page's snapshot with the new version against the golden fixtures
      (`packages/tools/test/fixtures/sign-in-snapshot-1.3.6*.yaml`, written by hand from 1.3.6's
      `renderAriaTree`: a password field with and without a placeholder, an iframe, a field without a ref) and run the
      workerd canary
      (`packages/tools/test/browser-run-sessions.test.ts`), which checks the client page still has `_snapshotForAI`.
    - **Handoff and Live View** (#216, ADR 0039, ADR 0044, GLOSSARY "Handoff"): `browser_ask_human(sessionId,
      reason)` (`write`) asks the session's member to act in its current tab themselves, to type a password or solve a
      CAPTCHA, so the secret never reaches the model or Commissary. Its first call starts Browser Run's handoff
      (`Cloudflare.handoff` on the tab's CDP session, the reason as its instructions, 30 minutes, Browser Run's
      longest: `HANDOFF_TIMEOUT_MS`) and answers at once, the way an approval does (#201): to a 2026-07-28 client that
      declares URL elicitation, an `InputRequiredResult` whose `handoff` request is a URL-mode elicitation of the
      session's page in the panel (`tools/sessions/<id>`, `panelPageUrl`), whose retry with `accept` waits and with
      anything else declines (ends the handoff with `Cloudflare.handoffComplete` `success: false`); to any other
      client, a tool result (not an error) with the page's link, saying to call again with the same `sessionId` to wait
      (`tools/mcp/handoff.ts`). The call made again waits, outside the object's chain of calls so a Live View can still
      be minted meanwhile, for at most 45 seconds (`HANDOFF_WAIT_MS`: no client request, nor the Workers carrying it,
      waits half an hour): until the person clicks Done or Failed in the Live View (`Cloudflare.handoffComplete`, heard
      on the tab's CDP session) or the 30 minutes are up, and it answers which (`done`, `failed`, `timed_out`, or the
      session closed); else it answers, not as an error, that the person is still asked until when, and to call again
      with the same `sessionId`. While it waits it polls `Cloudflare.getHandoffState` every 15 seconds (`Clock`, so the
      tests drive it with `TestClock`) in case the event was lost, and an inactive answer at least 15 seconds after a
      first one ends it; nothing polls once it answered. Each listener for the provider's end is bound to the handoff it
      was set for (`startedAt`), and a wait that runs out times out only the handoff it waited on. An ended handoff's
      outcome wakes every call waiting on it, each answered alike, and stays in the session's storage with which handoff
      it ended (`startedAt`) and when a call first took it (`takenAt`): a call within the next 2 minutes
      (`OUTCOME_KEPT_MS`, a client's retry) gets the same answer, after which `browser_ask_human` asks anew; another
      tool acting on the page drops it at once. A woken call that answers after a newer handoff started stamps nothing
      on it. What the person was asked is dropped when the handoff ends. Each call writes its usage record as any tool
      call does, the one that started the handoff with the outcome `success`. An approval rule holds only the call that
      starts a handoff: before its approvals the Tools part asks the session's object whether the caller has a handoff
      there, waiting or with its outcome kept (`hasHandoff`), and a call that waits on it, answers how it ended or
      carries the person's decline goes through (only when a rule holds the call). Such a call may start no handoff
      (`askHuman`'s `mayStart: false`, decided in the object's turn): if the handoff went meanwhile (another tool
      dropped it, its outcome no longer kept), it answers that none waits, and the next call is approved first. While a
      handoff is active the session's other tools answer that it waits for a person (no snapshot of what they type),
      except `browser_close`; the alarm keeps the session open while it lasts and checks it every minute. The log keeps
      until when a handoff waits, for the Browser sessions page; a call that ends or drops it clears it, and the list
      asks the object of every handoff the log says waits, forgetting one that ended unheard (the person clicked Done,
      the client has not called since).
      - **What the person typed** is masked from then on (`page-scripts.ts`, Commissary's own fixed, argument-free
        scripts, which answer selectors only, never a value). At the handoff's start the session installs, in every
        frame, a capturing `input` listener that marks the target of each trusted (`isTrusted`) input event with
        `data-commissary-typed`, and keeps it in new documents with `Page.addScriptToEvaluateOnNewDocument` while the
        handoff lasts (each poll installs it again, as an object that restarted lost it). At its end `filledFields`
        asks every frame of every tab of the session for the fields marked as typed into, and those whose value
        differs from their default; a controlled input, whose page keeps its value at its default, is caught by its
        mark. A frame without the listener (another tab, or a frame it never reached) answers every text field that is
        not empty, and so does every frame when the listener could not be installed; and the answer must be a list of
        at most 64 strings of at most 256 characters each, every one a bare CSS selector (`filledSelectorsOf`,
        `notCss`): anything else, or any failure, masks every field that takes text, so masking fails closed. The
        fields are added to the masked selectors, and from then on the session masks the query of every URL it shows.
        From the first watch on (a handoff, or a Live View) the masks also hold `[data-commissary-typed]`, which
        snapshots and screenshots check when they read the page, so typing while a call runs is masked in that call
        (a frame without the listener keeps that gap until the next call's filled-field step). A session masks at
        most 256 selectors (`MAX_MASKS`); past that it masks every field that takes text instead.
      - **The Live View** (`Cloudflare.getLiveView`, tab mode, the only mode a handoff works in) is a bearer link to
        the browser: it is minted only for whom may watch the session, on their request from the panel (`POST
        /browser-sessions/:id/live-view`, `Cache-Control: no-store`), with Browser Run's shortest lifetime (60 seconds
        to start the connection: `LIVE_VIEW_EXPIRES_MS`), and no tool result, log line or other route carries it; a
        failed mint answers fixed words, as the provider's could quote the link. Its watcher can type in it outside a
        handoff, and the open frame outlives its link, so minting one installs the same listener and marks the
        session `watched` for the rest of its life: every later call masks the fields filled since the call before
        (as at a handoff's end) before it acts, and installs the listener again. Fields the model fills itself after a
        Live View are masked too, as they cannot be told apart from the person's. The scripts run in the page's own
        world, so a hostile page can defeat the marks: masking keeps typed values from the model, not from the page,
        which holds them already (an isolated world would not change that). Watching moves the session's idle timer.
        Who may watch is one method of the Tools part (`#mayWatch`, the session's member today), which the page's
        `watchable` reflects, apart from `own` (the caller is its member): a hosted agent's run will name its watchers
        there (#232), which needs a watchers port that answers at once, or watchers read before the list is made, as
        the list asks it of every session.
      - **The Browser sessions routes** (`/v9/management/browser-sessions`, `BrowserSessionsGroup`,
        `tools/management/browser-session-routes.ts`, every member): `GET` lists the caller's open sessions (with the
        handoff that waits for them) and, for an org admin, every other session of the org (its member, when it
        opened, its browser profile, named unless it is another member's private one); `GET /:id` is one, with what
        its handoff asks; `POST /:id/live-view` mints a Live View for the session's member only (an org admin gets
        `403 forbidden` on another's); `DELETE /:id` ends a session (its member, or any org admin) as `browser_close`
        would, and its tools then answer that it is closed (`ended`), a waiting `browser_ask_human` too. A session the
        caller may not see, or that closed, is `404 not_found`; a provider that fails to mint is `502 browser_failed`.
      - **Deploys** (expand, then contract): a call reaches the part with `ToolCall.handoffOutcomes`, set by an
        endpoint that knows the `handoff` outcome; an endpoint from before gets the started handoff as a plain text
        result without the link. The object's new methods (`askHuman`, `awaitHandoff`, `declineHandoff`, `watch`,
        `liveView`, `end`) are called only by a part that has them, and the log's new columns are added in place
        (`ALTER TABLE`). Rolling the State Worker back after this deploy is not clean for the sessions open meanwhile:
        the older code fails to decode one closed as `ended` (it answers as unknown), and decodes one that stores a
        handoff, `watched` or `maskUrls` without them, so it neither waits on that handoff nor masks the queries of the
        session's addresses (the masked fields stay).
    - **Browser Run's sessions** (`tools/browser/browser-run-sessions.ts`): a browser is acquired with a `keep_alive` of
      20 minutes (Browser Run's longest: Cloudflare's limits and its Playwright and Puppeteer pages allow up to 20
      minutes; the comment in `@cloudflare/playwright` 1.3.6's types, 10 s to 10 min, predates that) and reached again
      by its id with `connect()` (Browser Run's session reuse). The `keep_alive` counts from the browser's last command,
      about the session's last call, so the session's 10 idle minutes end it first. The tabs are the pages of its
      default context, which outlives a connection; closing sends CDP's `Browser.close`. A browser opened from a
      browser profile gets its state in that default context (a new context would not outlive the connection:
      Playwright creates it with `disposeOnDetach`): its cookies with `addCookies`, then each origin's local storage in a
      page of its own whose requests all answer an empty document (no request reaches a site) and which is closed
      afterwards, as Playwright's own `setStorageState` does (its client offers that for a new context only). A save
      reads Playwright's `storageState()`: every cookie, and the local storage of the origins Playwright saw on the
      connection that reads it (the restored ones, and those the session's tabs visited), so the local storage of an
      origin visited only before the browser was reached again (an object that restarted, a dropped connection) is
      not in the save; cookies always are. The session's object keeps that its browser was reached again
      (`reconnected`), and such a save answers that its cookies were saved but not the local storage of the sites
      visited before. A profile's state that fails to load answers a fixed message, and the log has the error's name
      only (Playwright's message can quote the script, which holds the profile's entries). A browser acquired but not
      reached (its connection failed) is ended again by its id, as far as it can be. A refused connection is the
      browser gone when Browser Run no longer lists the session (`sessions()`), else a failure. The snapshot is
      Playwright's `_snapshotForAI` (internal, as Playwright MCP uses it; its refs are what `aria-ref=` locators
      resolve, frames' too). Each operation is bounded by Playwright's 30 s timeouts and two minutes overall. Like the
      Quick Actions it has no local emulation: the tests run the object over a fake provider's browsers
      (`FakeBrowserSession`, `@commissary/tools/testing`), and the adapter over a fake binding's `fetch`, which
      `@cloudflare/playwright` reaches Browser Run with (429 on a new browser, a session no longer listed).
    - **Playwright in the state Worker's bundle**: `@cloudflare/playwright` is imported on a session's first call
      (`import()` in `open` and `connect`), not when the Worker starts. Measured on the state Worker's bundle (esbuild,
      minified, the tokenizer ranks' `Data` modules left out) and its local startup in workerd (Miniflare: start and
      first request, the median of 15): without Playwright 1.7 MB (0.50 MB gzipped), ~160 ms; with it imported
      statically 3.6 MB (1.00 MB gzipped), ~228 ms; imported lazily 3.6 MB (1.00 MB gzipped), ~207 ms. The import is
      still in the bundle and compiled at startup (`infra/bundle.ts`): the lazy import saves its evaluation, about a
      third of its startup cost, not its size or its compilation. Both stay well within the limits (3 MiB gzipped on
      the free plan; 1 s of startup).
  - **Browser providers** (`tools/browser/provider.ts`, ADR 0041): the toolkit reaches its browser only through the
    `BrowserProvider` interface, one method so far, `quickAction(request)`, whose request is the action and its decoded
    arguments (provider-neutral) and whose answer is text, JSON or a file, or a `BrowserProviderError` whose message is
    told to the model, either with the browser time the action used when the provider reports it (#214). Browser Run (`tools/browser/browser-run.ts`, `browserRun(binding)`) is the one adapter: each
    action is one `quickAction()` call of the binding (no API token), within three minutes, from one record per Quick
    Action keyed like `QUICK_ACTIONS` (the binding's action, its options built from the arguments, its answer's
    decoder). A later provider
    (Browserbase, Kernel) is another adapter plus a catalog entry: a stored toolkit of kind `browser` whose source names
    the provider and whose shared (or a member's private) credential is the org's key for it, serving the same tools;
    none is built. A provider that has browsers for sessions says so (`sessions: true`); its browsers are a
    `BrowserSessionProvider` (open, connect by id, and a browser's tabs, driven by snapshot refs and masked by CSS
    selectors; opened from a browser profile's state, which a save reads back with `storageState`, #215), which the session's object finds by the provider's id it stored when the session opened
    (`sessionProviderOf(source, env)`): Browser Run's are `browserRunSessions` (above), over the binding; a later
    provider is another case there, and its sessions need no migration. The sandbox toolkit's sandbox provider (#222)
    follows the pattern. The tests run the toolkit over a fake binding and over a fake second provider, which serves
    the same tools.
  - **The sandbox toolkit's tools** (`tools/sandbox/toolkit.ts`, #222, ADR 0041): a shell and a filesystem in a
    session, shaped after pi's coding tools (bash, read, write, edit, ls) so a hosted agent's tools map onto them one
    to one (#230). MCP calls are stateless, so `sandbox_open` (write) answers a session id (`sbx_` and 32 hex digits)
    and the network it got, and the others take it: `sandbox_bash` (write; a command run with just-bash in
    `/workspace`, `timeout` in seconds, 120 by default and at most 600), `sandbox_read` (read; `offset` and `limit` in
    lines), `sandbox_write` (write; creates parent directories), `sandbox_edit` (write; exact replacements, each
    `oldText` unique and not overlapping, applied together: a read and a write through the provider),
    `sandbox_list` (read) and `sandbox_close` (write). Output is cut as pi cuts it (`tools/sandbox/truncate.ts`): at
    2,000 lines or 50 KB, a command's stdout and stderr each from its end and a file's from its start, and the cut is
    stated as pi's bash tool states it (`[Showing lines X-Y of Z.]`, with `(50.0KB limit)` when bytes cut it, and
    `[Showing last N of line Z.]` when one line alone passes it), whether the toolkit or the provider cut it (the
    provider says how: `OutputCut`, its limit and whether the kept part starts within a line); a cut command's whole
    output is kept as a file in the session (where `@cloudflare/computer` puts it), which the note names. Invalid
    arguments, a network above the org's ceiling, an unknown or closed session, a failed command (`Command exited
    with code N`, with its output) and the provider's failures are results with `isError`; so is any call that names
    no principal (an endpoint from before calls carried one): a session must have an owner.
  - **Sessions**: a session is its principal's alone (`SandboxOwner`: the org and the call's principal, `user:<email>`
    on the app host, `key:<id>` for an API key, `run:<id>` for an agent run, #230): a call with another principal's
    id, in the same org or another, is answered as an unknown session. It ends on `sandbox_close` or after a day
    without a call, its files deleted at once (a command still running is killed and the Workspace closed first, so
    nothing writes its files back); for a week after, its owner's calls answer that it is closed, and after that week
    that it is unknown. Commissary sets no size limit of its own: the Durable Object's storage limit applies (a write
    past it answers that the storage is full and the file was not written). The ControlPlane keeps the org's open
    sessions (`sandbox_sessions`, `tools/sandbox/sessions.ts`: id, toolkit, member, principal, the shared agent whose
    run opened it (`agent`, #228, which the close's charge goes to), opened and last used): every call goes through the
    Tools part, which adds a session when it opens, marks it on each use (a call the sandbox failed is one too: the
    session's object counted it), and drops it when the call closed it or the session's alarm reports its close (#224,
    below). A session a call found closed is kept, as its close's report is
    still to come. One whose close was never heard of is forgotten from the part's alarm `SESSION_IDLE_MS` +
    `CLOSE_REPORT_MS` (a day and a week) after its last use, so a session whose report keeps failing stays listed up to
    eight days. A member who leaves takes their sessions at once (`memberLeft`: each used within the day is purged,
    settled first as a close is, its last stretch of computer time charged and its usage record written (#224), then
    deleted with its files and no note; an older one is closed already, its files gone, and left to report its close),
    and the org's deletion purges every one (Tools' org-deletion step, `purgeSandboxSessions`, a page of 20 at a time
    within the deletion's budget, before `wipeOrg` drops the table). An agent run's own session is the exception to
    the day without a call: the one its harness opens (`sandbox_open` with `_meta["commissary/run-session"]`,
    `RUN_SESSION_META`, honoured for a run's call only; another session a run opens ends after its idle day as a
    member's) lasts until the run is deleted, which purges it, settled first as a member's leaving settles theirs
    (`purgeRunSandboxSessions`, "Agent runs"), and the part's forgetting skips a run's sessions; the run's coding
    tools reach its session through gated calls ("Agent runs", "Sandbox"), and only a session the part keeps as that
    run's (`SandboxSessionStore.owns`). Calls are recorded and priced as any tool call.
  - **Computer time** (#224, `tools/sandbox/cloudflare/computer-time.ts`): a session's object meters its computer
    (`ComputerMetering`, kept with the session): the time from the command that starts it to the container's idle
    minutes after its last command, or to when the session stops it (closing, or a Spend limit with no room), a command
    still running keeping it running; a run whose command could not start the computer is dropped. Each call passes the
    price per computer hour and whether a limit has no room (`SessionMetering`, an optional last argument; opening, who
    opens too: toolkit, member and agent run, `SessionOpener`) and answers the time since the call before and its cost
    (`SessionReply.computerTime`, which the provider hands on as `Metered.computerTime`, or a failure's
    `SandboxError.computerTime`), which the part charges. The object's alarm is set for the sooner of the session's
    idle day and the computer's end (`computerEndsAt`: its last use plus its idle minutes): at the computer's end it
    meters the run that ended and reports its cost to the org's ControlPlane (`sandboxComputerTime(id, cost, false)`);
    a report that fails is kept (`ComputerMetering.owed`) and answered by the next call or reported again from the
    alarm soon after (`SETTLE_RETRY_MS`), so each stretch is charged once. With a limit's room gone a call stops a
    running computer quietly and goes on (`computerStopped`), and only a command for the computer is refused. When
    the session closes it writes its one usage record (`insertSessionRecord`, _Usage_, "Computer time"); when its alarm
    closed it, it reports the close with what no call or report charged to the org's ControlPlane
    (`sandboxComputerTime(id, cost, true)`), which charges it and forgets the session; a purge for a member's leaving
    settles the same way, by the part's call (`purge(org, settle)`); one its alarm closed already is left to its alarm,
    and the part keeps it until its close is reported. A close or a member's leaving waits for the alarm's report in
    flight (`#reporting`), so the part still keeps the session the report names, and what that report could not report
    is in what the close charges. A record or report that fails is kept in the closed note and tried again from the
    alarm (`usage/session-close.ts`, shared with the browser sessions) until the note goes, `CLOSE_REPORT_MS` (a week)
    after the close. An agent run's session (#230), which has no idle day and may outlive any, writes a record each
    time its computer stops, of that stretch, and none when it closes ("Agent runs", "Sandbox"); its gated calls pass
    the metering their gate set, as any call does.
  - **Networks** (`tools/sandbox/network.ts`, ADR 0041, ADR 0044): `none` (the default), `hosts` (DNS names or `*.` and a
    name, plus the `package_registries` preset: npm, PyPI, GitHub and mise's download hosts), or `open`. The sandbox
    toolkit's `network` is the org's ceiling, set by org admins (`PATCH /toolkits/sandbox`, shown in its view and the
    export), `none` until set; `sandbox_open` asks for one within it (a host list the ceiling covers, `open` only
    under `open`), and the session keeps it for its life, whatever the ceiling becomes later.
  - **Sandbox providers** (`tools/sandbox/provider.ts`, ADR 0041): the toolkit reaches its sandbox only through the
    `SandboxProvider` interface (open, bash, read, write, list, close, each as an owner, with the call's `ComputerMeter`
    (#224), and purge and `stopComputer`, for the ControlPlane; a `SandboxError` with a reason the toolkit words).
    Cloudflare's sandbox (`tools/sandbox/cloudflare/`, source `cloudflare`) is the one adapter, and the only code that
    imports `@cloudflare/computer` or just-bash (lint: `no-restricted-imports` in `.oxlintrc.json`; pinned at 0.5.1,
    with just-bash pinned at 3.2.0 by a workspace override, upgraded together in a Dependabot group of their own once
    the sandbox tests pass): each session is a `SandboxSession` Durable Object in the state Worker, named
    `<org>:<session id>`, holding the session's `@cloudflare/computer` Workspace (its files, in the object's SQLite)
    and running commands with its worker-shell backend, just-bash in a Dynamic Worker loaded through `LOADER`. That
    Worker gets nothing but its files: the loader is wrapped (`cloudflare/loader.ts`) so that its one binding is the
    Workspace's proxy (`HOST`, `WorkspaceServiceProxy`, `cloudflare/proxy.ts`: Commissary's own, offering no
    Artifacts) and its `globalOutbound` is always `SandboxEgress`
    (`cloudflare/egress.ts`), the one egress point, whose props carry the session's network and the outbound guard's
    policy. It checks every request (the network first, then the guard, so an address the guard refuses stays refused
    on an `open` network), fails a refused one (the command's `curl` fails) and forwards an allowed one without
    following redirects, so each hop comes back to it (a redirect to an address the network or the guard refuses
    fails without reaching it). The Workspace's `git`, `assets` and `artifacts` stay unconfigured and no command but
    `curl` is added: they would fetch from the session's object with the state Worker's own `fetch`, not through
    `SandboxEgress`, so `git clone` reaches nothing, even on a host the network allows (a test holds this). No
    credential, secret or environment variable enters a sandbox. `@cloudflare/computer` is a preview: its API may
    change, so the pins move only with a test run; the state Worker needs no `experimental` compatibility flag for it.
    It and just-bash are loaded with a dynamic import when a session first needs its Workspace, never at module load:
    the state Worker hosts every ControlPlane, and a cold start of one should not evaluate them (they are still
    compiled, as every module of the bundle is). The state Worker's bundle and startup, from `wrangler deploy
    --dry-run` and then `wrangler check startup` on the bundle (the median active startup of 9 local runs, interleaved
    within each series; the Playwright note above was measured another way, and its numbers don't compare with these):

    | Series | State Worker                                             | Gzipped   | Startup |
    | ------ | -------------------------------------------------------- | --------- | ------- |
    | 1      | before the browser sessions and the sandbox (9188dc98)   | 2,300 KiB | 51.6 ms |
    | 1      | with the sandbox imported at module load                 | 3,096 KiB | 64.1 ms |
    | 1      | with the sandbox loaded lazily                           | 3,245 KiB | 58.4 ms |
    | 2      | with the browser sessions (#213, 26af3df1)               | 2,976 KiB | 59.5 ms |
    | 2      | with the browser sessions and the sandbox, loaded lazily | 3,922 KiB | 72.0 ms |

    Each series ran on its own, so compare rows within one. All stay within Workers Paid's 10 MiB, which a
    self-hosted Commissary needs anyway (ADR 0043), and far from the 1 s startup limit. Another provider (Daytona, E2B,
    Modal, Vercel Sandbox) is another adapter, a stored toolkit of kind `sandbox` whose credential is the org's key
    for it. The workerd tests run real sessions over Miniflare's Worker Loader, and the toolkit over a fake second
    provider.

  - **The computer** (`tools/sandbox/cloudflare/computer.ts`, `fallback.ts`, #223, ADR 0041): on a deployment with
    `COMMISSARY_COMPUTER=on`, a Cloudflare Container (the `Computer` image, `infra/computer/`: computerd, mise and what
    mise needs to download and unpack, no runtime preinstalled) attached to the `SandboxSession` class, one per session
    object, as the Workspace's second backend: `@cloudflare/computer`'s container backend, computerd's FUSE mount of the
    same files at `/workspace`. The sandbox toolkit's "may use the computer" (`computer`, the org's ceiling, set by org
    admins like the network, off by default, refused on a deployment without it) lets `sandbox_open` ask for it
    (`computer: true`); a session keeps what it opened with. **The fallback rule** is Commissary's
    (`@cloudflare/computer` has none), and is decided before a line runs, from just-bash's own parser (`Bash.transform`,
    whose AST is what `exec` runs) and lookup (`type -t`): a line goes to the computer only when just-bash's parser
    rejects it (or holds a syntax error for a later part) or it names a command just-bash lacks (a literal word in
    command position anywhere in it, or run by a wrapper among them: `env`, `xargs`, `timeout`, `nice`, `nohup`,
    `time`, `command`, `exec`, `sudo`, `find -exec` and its kin, and the script of `bash -c`/`sh -c`; not a function
    it defines, unknown to just-bash with the session shell's commands; a path and `git` count as lacking, a name only
    known at run time, `$tool`, does not). Everything else runs on just-bash, and **a line just-bash ran is never run
    again**, whatever it exited with: a run's exit code or output can't tell "could not run" from "ran and failed", and
    a line may have done part of its work before failing. In a session without the computer such a line runs on
    just-bash, and when it fails its result ends with a note that the computer is off (and why: the session, or the
    deployment). The rule asks the just-bash the package imports, the shell runs the one `@cloudflare/computer`
    bundled: the `just-bash` override in `pnpm-workspace.yaml` keeps them one version, and a unit test
    (`test/unit/sandbox-fallback.test.ts`) fails when they differ. The computer starts at a
    session's first fallback and stops after 10 idle minutes (the container's inactivity timeout, set after every
    start); the files stay in the object, so the next fallback starts a fresh computer on them. Its running time is
    metered and may have a price per computer hour (#224, "Computer time" above). mise keeps its data,
    cache, config and state in `/workspace/.mise`, its shims first on the commands' `PATH`, so `mise use node@22`
    lasts the session and survives the computer stopping. **Its one way out** (ADR 0044) is the same `SandboxEgress`:
    `enableInternet` is always `false`, set explicitly by Commissary's guard over the container host whatever the
    backend asks, and every outbound HTTP and HTTPS request is intercepted (`interceptAllOutboundHttp`) to the session
    object, through `WorkspaceProxy` (`cloudflare/proxy.ts`, exported by the state Worker), whose `fetch` hands it to
    the backend and on to `SandboxEgress` with the session's network and the guard. HTTPS is intercepted under
    Cloudflare's containers CA, which the image's entrypoint adds to the system's trust store (and the commands'
    environment points Node.js, Python and pip at). **No credential enters it**: its environment is computerd's port,
    mount point and shell and mise's variables only (the guard refuses any other); beneath it `@cloudflare/computer`
    adds a random per-container `RPC_CLIENT_SECRET` that authorizes the session object and computerd to each other.
    computerd keeps it from the commands' environment, but the commands run as root (computerd cannot run them as
    another user, and its FUSE mount admits its own user only), so a command can read it from `/proc`; it reaches only
    this session's own computerd channel, the files and commands the command has already. A start Cloudflare refuses at
    the account's container limit answers that in words. One instance size per deployment
    (`COMMISSARY_COMPUTER_INSTANCE`: `basic`, `standard-1` (the default: computerd holds its copy of the files in
    memory, and a runtime from mise is 100 to 200 MB unpacked) to `standard-4`). The image pins its two bases by digest
    (Dependabot's `docker` updates), computerd's to the `@cloudflare/computer` version (`tools/check-computerd.sh`,
    run by `pnpm lint`). Cold start, `mise use node@22` and the per-session cost are not measured yet: they need a
    deployed stage with the computer. The workerd tests run real sessions with a fake computer in the container's
    place (`test/support/fake-computer.ts`) over a fake `ctx.container` (`test/support/fake-container.ts`), through
    `@cloudflare/computer`'s own launch (`WorkspaceContainerAPI`) and the real egress path (`WorkspaceProxy` to the
    session's `fetch` to `SandboxEgress`).
- **Members and orgs**: a member who leaves takes their private toolkits, their private credentials on org toolkits, the
  upstream sessions of those, the sign-ins they started, the tool grants that named them, the pending approvals of their
  calls, their open sandbox sessions and their browser crawls, and leaves every list of approvers (`memberLeft`); a
  deleted team takes its tool grants (`teamDeleted`), and a removed toolkit its own and its pending approvals
  (`tool_grants` and `tool_approvals` are keyed by `toolkit_id` like the other tables) and its Spend limits; org
  deletion drops the tables (`wipe()`), and Tools' org-deletion step first deletes the org's open sandbox sessions (each
  a Durable Object of its own), then cancels the org's browser crawls that may still be running at Browser Run
  (`purgeBrowserCrawls`), then the org's OAuth sign-ins of MCP clients on Commissary Cloud (grants and tokens in
  `OAUTH_KV`, the one thing Tools keeps in KV; the per-isolate cache of OAuth servers in `oauth/server.ts` holds no org
  data): its usage records go with Models' step, which deletes every usage row of the org. The cross-org suite
  (`apps/app/test/org-isolation.test.ts`) checks that one org's toolkits are neither listed nor reached by id from
  another, that its tool grants and OAuth apps are its own, that a sign-in's state reads only in its org, that a call
  goes on in its own org's upstream session, that a member finds only their own org's pending approvals, and that a
  browser session id opened in each org by the same member and key reaches only its own org's session, as a sandbox
  session and the sandbox's network ceiling are reached from their own org only. A member who leaves keeps no reach to
  their browser sessions (their calls are refused before the tools), which close when idle. The org export lists the
  toolkits the caller reaches with their credentials' kinds, their overrides and their approval
  rules, never a secret, and for an org admin each org toolkit's tool grants (subjects by email or team name, as
  Models' grants; tools `all`, `read` or the named tools' upstream names; `updated_at`).
- **Panel** (#208, `apps/web/src/pages/Tools.tsx`, `ToolkitAdd.tsx`, `Toolkit.tsx` with `ToolkitCredential.tsx`,
  `ToolkitTools.tsx` and `ToolkitSettings.tsx`, `ToolkitConnect.tsx`, `McpEndpoint.tsx`; models in
  `apps/web/src/lib/toolkits.ts`, `toolkit-add.ts`, `toolkit-credentials.ts`, `tool-list.ts`, `mcp-endpoint.ts`):
  **Tools** (`/tools`, every member's, in the sidebar's Providers group) lists what `GET /toolkits` gives the caller,
  each toolkit with its kind and source, its sign-ins (shared, the caller's own), its tool count and what needs
  attention (a failed refresh, a credential that needs sign-in again or is not used, a private toolkit shadowed or asked
  to rename), those first; an org admin also sees the other members' private toolkits, existence only, and can remove
  one. **Add a toolkit** (`/tools/add`; org admins, and members where the org allows private toolkits, whose toolkit is
  always private) picks a catalog service and one of its sources, a domain's lookup (integrations.sh's `discover` only
  on "Look deeper"), a URL as typed, or an uploaded document, then the name, whose it is, what an org toolkit accepts
  and the source's way to sign in; the catalog shows no icons, as the panel's CSP loads images from its own origin
  only. A **toolkit's page** (`/tools/$toolkitId`; read from the list, as there is no read of one toolkit) shows its
  facts and flags, its sign-in slots (the shared credential for org admins, the caller's own where the toolkit and the
  org take one): a form for every credential type the API takes (the type's settings, its managers', in the same form), and an OAuth sign-in opened in a new tab while the page asks
  `GET /toolkits/:id/sign-in` every 3 seconds until it is done, failed or expired. A shared credential's form names
  who may use it, everyone at first; replacing one names a subject that already holds a grant on the toolkit (everyone
  first), so a key rotation keeps everyone's reach (#198). Its tool list shows each tool's full name, class, price and
  flags; its managers edit an override in place (hidden, name, description, class; the whole override is sent with
  its revision, carrying the price an org admin set) or reset it, and list the tools again now. Its managers' settings:
  name, what an org toolkit accepts, an OpenAPI toolkit's base URL (`PATCH` with `If-Match`), the OAuth app (replaced
  whole, so its secret is typed again) and removal. The **connect page** (`/tools/$toolkitId/connect`, the link a call
  without the member's own credential answers) is that toolkit's own-credential slot alone, then says to make the call
  again; it says why when the toolkit or the org takes none. The **endpoint URL builder** (`/tools/endpoint`) shows
  the MCP endpoint's URLs on this deployment (Commissary Cloud: its one endpoint; self-hosted: the app host's
  `/o/<slug>/mcp` behind Access and, with an API host, the API host's for API keys; with one host the first only, saying
  why), narrowed with `?toolkits=` to picked toolkits, how many tools each gives (`GET /tools`, narrowed by the picked
  toolkits and, for a key's URL, a picked API key's tool scope), a suggestion to narrow above 100 tools, and setup
  snippets for Claude, Claude Code, Cursor, Codex and pi that read a key from `COMMISSARY_API_KEY`, never showing one.
  The **Browser sessions pages** (#216; where the deployment has the browser toolkit, `me.deployment.browser`, else Not
  found and no link on the Tools page): **Browser sessions** (`/tools/sessions`) lists the caller's open sessions, those
  waiting for them first, and for an org admin every other session (whose, when, which profile), each with End; a
  **session's page** (`/tools/sessions/$sessionId`, the link a handoff answers) shows its facts, the handoff's request
  and deadline, and, for its member only, the Live View in a frame, minted when the page opens and again on Reconnect
  (the link lives in the page's state only; the panel's CSP allows frames from `https://live.browser.run` and nothing
  else), with End session (confirmed). Both read again every 15 seconds while open.
  The **Browser profiles page** (#217, `/tools/profiles`, `apps/web/src/pages/BrowserProfiles.tsx` and `lib/browser-profiles.ts`;
  hidden like the sessions pages) lists what `GET /browser-profiles` returns the caller: an org admin's **Shared
  profiles** (each with who may use it, from `GET /grants/profiles`, and Rename, Who may use it and Delete) and their own
  private ones, plus the other members' private profiles as existence only (`PrivateRows`, with Remove); a plain member
  gets their own private profiles and no control of the shared ones (the route gives them none and they never read the
  grants). The **New profile** form takes a name (1-64 of `[a-z0-9_-]`, checked against the list as the server does)
  and, for a shared profile, who may use it: a checklist of everyone, teams and members with **nothing preselected**,
  refused while empty (`validateDraft`). It creates the profile, then one profile grant per subject; a grant the server
  refuses deletes the profile again (best effort), so no shared profile is left that no one may use. Who may use an
  existing profile is edited in its row as a diff (grants added first, then those dropped, each at its revision). The
  page ends with how to log into a profile: open it in a session (`browser_open` with `profile`), ask for a handoff
  (`browser_ask_human`, answered with a link to the Browser sessions page), close with save (`browser_close` with `save`).
  The browser toolkit's own page gains a link to both pages beside its **Prices**, which already hold the price per
  browser hour (#209). **Usage**'s tool-call view words browser time: a column in the breakdown where a row used some,
  under a record's tool in the log ("2.3 s of browser time", a Quick Action's or a session closing's) and in the totals
  and a record's facts. A browser session's record (no tool) has no latency and reads "Closed", and its facts name the
  profile it opened from where the caller manages that profile. Where the deployment has no browser
  (`me.deployment.browser` false, ADR 0043) the figures of browser time are hidden, but historical session records stay
  in the log, labelled "Browser session" with their cost: they are records of what happened. An org admin whose members
  and teams (or grants) could not be read still gets the lists; only the "Who may use it" column and editor and the
  shared option of the form wait for them. Deletes go through `deleteProfile` at the revision of the row they were read
  at, and the other members' rows are looked up by id first, so no write is sent at a revision that was never read.
- **Panel, grants, prices, approvals and usage** (#209; models in `apps/web/src/lib/tool-grants.ts`, `tool-id.ts`,
  `my-tools.ts`, `tool-prices.ts`, `approval-rules.ts`, `usage-tools.ts`). The **Grants** page (`/grants`) has a Models
  | Tools switch (`?area=tools`): the tool grants (`GrantsTools.tsx`) read by member, team or toolkit, a form for the
  subject, an org toolkit (not a private one, nor one that takes private credentials only, nor the agents toolkit) and
  all, read or named tools picked from the toolkit's tool list (named tools shown by their current names, a vanished one
  marked missing), and a note on the toolkits that hold a shared credential and no grant. **My tools** (`/my-tools`,
  every member) lists the tools the caller may use by toolkit with the reasons `GET /tools` gives. A toolkit's page adds
  **Prices** (org admins: a price per call, or per browser or computer hour on those toolkits, and a tool's own price in
  its editor; an empty price is free and not flagged) and **Approvals** (org admins on any toolkit, a member on their
  own private toolkit: the write switch, marks on tools and each rule's approver, the caller, a team or members, written
  whole with the toolkit's `If-Match`; a plain member names only the caller, as the panel has no member or team list for
  them, and sees a rule an API call gave a team or members as a disabled "set elsewhere" choice; a rule's team or
  members the org no longer has start unchosen, and a rule nobody can approve under is flagged), with a link to the
  Approvals page. The Limits page offers a toolkit's shared credential as a subject (`toolkit_credential`). **Usage**
  has an Area switch (`area=tools`): the tool calls' totals, a breakdown by toolkit, tool, member, team, API key or
  user, and the log with each call's outcome, approval outcome, latency, cost and credential, filterable by toolkit and
  tool; it shows no arguments or results (sizes only), a private call is its caller's alone, as every record is, and
  "not completed" counts every outcome but `success`, as the server's `failed` does, and is not painted as failing.
  **Members** has a switch for private toolkits beside the private credentials one.

## Agents (`agents/`, `agents/management/routes.ts`, `src/management/agent-routes.ts`, `apps/api/src/http/run-gateway.ts`)

The Agents area (ADR 0040) holds **hosted agents**: an agent's definition saved in Commissary (name, description,
instructions, one model with an optional thinking level, a tool scope), its **runs** (GLOSSARY "Agent run", "Turn") on
pi-durable, and its calls as tools of the agents toolkit (#229). It saves definitions, private and shared, the
grants on shared agents and their watchers (#226), runs them as their starter asks, one turn at a time (#227),
starts runs from the schedules and webhooks configured on them (#231), and serves them to clients and runs through the
agents toolkit, whose calls from a run start child runs (#229), and gives a run whose definition names a sandbox pi's
coding tools on a sandbox session of its own (#230); the panel's Agents pages (#233) manage them; watchers acting in runs and the panel's chat come later (#232,
#234). The package (`@commissary/agents`) is shaped like Tools: entry
points `./api`, `./management`, `./state` and `./testing`, a lint boundary (`boundaries/agents-imports`) and a
ControlPlane part, `AgentsPart`, reached as `stub.agents().x(…)`. Its state is the ControlPlane's (`AGENTS_TABLES`:
`agents`, `agent_grants`, `agent_runs` and `agent_triggers`, dropped by `wipe()`); its view of `env` (`AgentsBindings`) is the ControlPlane namespace and
the deployment's Dynamic Workers binding `LOADER`.

- **Presence** (ADR 0043): the area exists exactly when `LOADER` is bound (`agentsPresent`), on the app Worker, which
  serves the area's routes, runs' included (the runs' objects themselves need no `LOADER`: a run's sandbox is the state
  Worker's `SandboxSession` object, #230). Without it every Agents route answers `404 not_found` and `/me` says
  `deployment.agents: false`; the definitions are kept. Every deployment binds it (`alchemy.run.ts`), and the app's tests
  bind it too (`workerLoaders` in `vitest.config.ts`), but for one harness that passes `LOADER: undefined`.
- **Definitions** (`CreateAgent`, `UpdateAgent` in `@commissary/contract/agents`; `agents/agents/definition.ts`): a
  name of 1 to 64 of `[a-z0-9_]`, unique in the org across private and shared agents (it is the agents toolkit's
  `agent` argument, so one name must mean one agent whoever calls; a deliberate choice: `409 name_taken` can reveal a
  name used by an agent the caller cannot see), a description of at most 1,000 characters, instructions of at most 65,536, a model as clients name
  it, a thinking level, and a tool scope as an API key's (`ToolScope`), whose agents toolkit entry may also name agents
  by id (`agents`). There are no versions: an edit replaces what it names. Edits and removals name the agent's revision
  in `If-Match` (`409 conflict`).
- **Private and shared**: a private agent is one member's; a plain member's agents are always private, and an org admin
  creates a private one by saying so. Private agents follow the org setting `membership.private_agents` as private
  toolkits follow `private_toolkits` (`403 private_agents_unavailable` when off; turning it off keeps them but none is
  usable). Only its member sees and edits it in full; an org admin sees that it exists (`others`, as for private
  toolkits) and may disable or remove it. A shared agent is an org admin's to create and edit; it names who may use it
  on creation (`subject`, written at once as its grant: there is no default grant), and further grants are
  `/grants/agents`, one per subject and agent, for org admins only. `GET /agents/mine` lists what the caller may use:
  their private agents (while the setting is on) and the enabled shared agents a grant gives them.
- **Watchers** (GLOSSARY "Watcher"): a shared agent names members and teams who watch it (the creating admin by default);
  once none is left (a member who leaves, a deleted team), its org admins watch it (`admins_watch`). They act in runs
  (steering, approvals, handoffs) with #232; `agentWatchers` already resolves them to members.
- **What a definition names** (the seam): the model and the toolkits must exist where the agent runs: in the org (its
  shared credentials, its toolkits) for a shared agent; for a private agent, the models its member may use and the
  toolkits the member can see (the org's and their private ones), tools outside their grants being narrowed at run time
  (#227) (`422 unknown_model`, `422 unknown_toolkit`, with `path`). Agents imports neither Models nor Tools: its
  routes take an `AgentReferences` (`agents/management/references.ts`), which the app Worker fills
  (`src/management/agent-routes.ts`) from Models' `servedModelCheck` (over the isolate's `ModelRegistry`, aliases and
  prefixes applied, `RegistrySnapshot.shared()` or `visibleTo(member)`) and Tools' `toolkitIds` (over the Tools part's
  toolkit list). The routes run the checks and hand what they found to the part as data (`ReferenceCheck`), so the part
  decides the order of refusals (permission, setting, references, the rest) and Agents' own tests need no Models or
  Tools. The agents a tool scope names are Agents' own: a private agent's must be usable by its member, a shared agent's
  shared (`422 unknown_agent`). A model or toolkit removed later stays named, as in an API key's scope; a run's calls
  then fail as for an unknown model or toolkit.
- **Tool scope entry for agents**: an API key's tool scope (`ToolScopeEntry.agents`, on the entry of toolkit `agents`
  only, `AGENTS_TOOLKIT`) may name agents by id, which the agents toolkit honours (#229, below); the base stores and
  normalizes it like the rest of the scope.
- **Spend limits**: a shared agent is a Spend subject (`agent`, `/spend/limits`), listed by the part's `spendAgents`
  hook; removing the agent deletes its limits (`spend.forget`). Its runs' usage counts toward them (#228, "Agent
  runs").
- **Members and orgs**: a member who leaves takes their private agents, their runs and every run they started, and
  leaves the grants and watcher lists that named them (`memberLeft`; the runs: "Agent runs"); a deleted team leaves the grants and watcher lists (`teamDeleted`); org deletion drops the tables
  (`wipe()`), after Agents' org-deletion step deleted each run's object (below). The org export lists the
  agents the caller manages, a shared agent with its watchers and grants (members by email, teams by name). The
  cross-org suite checks that one org's agents are not listed in another (`controlplane: agents`).
- **The sandbox** a definition may name (`sandbox`, `AgentSandbox`, #230, ADR 0041): the sandbox toolkit its runs work
  in (`toolkit`, the built-in `sandbox`), and the network and computer their sessions ask for, as `sandbox_open` takes
  them. It must be a sandbox toolkit the agent's owner can see, and within that toolkit's ceiling as it stands
  (`422 invalid_sandbox`, `path: "sandbox"`; `AgentReferences.sandboxRefusal`, which the app Worker fills from Tools'
  `sandboxRefusal`, `tools/sandbox/agent-sandbox.ts`); `sandbox: null` in an edit removes it. A ceiling lowered later
  leaves it named: the run's `sandbox_open` is refused then, as a client's would be. A run's session opened before an
  edit or a ceiling narrowed is left at its next turn ("Agent runs", "Sandbox"). The export lists it.

### Agent runs (#227)

- **The run's object** (`agents/runs/run-object.ts`, `AgentRunObject`): one Durable Object per run, named
  `<org>:<run>` (`agentRunName`), holding the run's pi-durable harness on its own SQLite: its transcript and its turns.
  It lives in the API Worker (class `AgentRun`, `apps/api/src/http/run-gateway.ts`, which wires Agents' class with its
  loopback, below; ADR 0030's amendment), and the app Worker binds it as `AGENT_RUN` by the API Worker's script name,
  which is why the API Worker deploys before the app Worker on every stage (`docs/DEPLOY.md`). Agents' tests wire the
  class with a gateway that answers `404` (a status the model client does not retry). A start names the run (org and id), and the object takes it only when that
  is its own name; under `alchemy dev` only, where the dev registry drops `ctx.id.name`, the dev entry lets it through.
- **The org's index** (`agents/runs/store.ts`, table `agent_runs` of `AGENTS_TABLES`, dropped by `wipe()`): one row per
  run with its agent, trigger kind (`chat`, `schedule`, `webhook`, or `mcp` for the agents toolkit's) and trigger
  (`trigger_id`, none for `chat` and `mcp`), starter (a member, the run that started a child run, or none for a run no
  one started, below; two columns), the API key a start through the agents toolkit came with (`api_key_id`, added in
  place to an older table, as `trigger_id`), idempotency key, state as its object last reported it
  (`runStateChanged`; an ended run stays ended) and the definition its latest turn read (`turn_definition`). It lists a
  member's runs, finds the run an idempotency key already started and resolves a run's principal without reaching the
  run. The cross-org suite checks it (`controlplane: agent runs`) and the runs' objects (`agent runs' objects`).
- **Turns**: a message to an idle run starts a turn (`beginTurn`), which reads the agent's definition as it stands then
  and keeps that reading as the turn's reach (no versions: an edit, a disable or a revoked grant applies from the next
  turn). The next turn ends the run when the agent was disabled or removed, the private agent's member left, the org
  stopped serving private agents, or the starter may no longer use the agent (their grant revoked). A message while a
  turn runs joins it as steering (pi-durable's `turn.steering` submissions), and the turn takes it before its next model
  call. Cancelling aborts the running turn; the run stays open for the next message (a harness that does not settle
  within 10 s is closed, the turn recorded as cancelled). A start or message resubmitted with the same idempotency key
  finds the turn it started instead of starting another. A start whose call of the object fails ends the run it created
  (`abandonRun`), as the object may or may not have taken it. The object's calls that change the run run one at a time;
  waiting for a turn and showing the run do not wait for them.
- **Resume**: while a turn runs, the object's alarm wakes it every 60 s (`HEARTBEAT_MS`). After an eviction or a deploy
  of the API Worker (every merge) the alarm reopens the harness and the turn goes on (`resume()`): a tool call that
  finished is never made again, one cut off answers the model as interrupted, and a model call cut off is made again
  (and billed again). A storage failure closes the harness; the next event reopens it.
- **The run's principal** (`@commissary/auth`'s `run` kind, `agents/runs/principal.ts`): the run, its agent, its
  starter, whom it acts as (a private agent's member, or a shared agent itself, `isSharedAgentRun`) and its reach (the
  model and tool scope its latest turn read). The gate resolves it on every request from the org's ControlPlane
  (`runPrincipal` over the part's `turnContext`), never from the request: an unknown or ended run, one with no turn
  yet, one acting as a private agent's member who left the org, and one whose starter left it are refused (`401`, like
  a revoked key); an edit or a disable during a turn changes nothing until the next turn. On Commissary Cloud
  `authenticateRun` checks on every request, as for a key (the same cached standing), that the org, the run's starter
  and the member a private agent's run acts as are in good standing: a suspended starter's runs, shared agents'
  included, are refused at once (`403 Suspended`). The plan's request-rate ceiling applies.
- **The trust boundary** is the Cloudflare account, as for the Durable Objects. Every request of the harness (a model
  call to `/v1/...`, a tool listing or call to `/mcp`) goes to the run gateway, `AgentRunGateway`, a named entrypoint
  of the API Worker that the object calls over `ctx.exports`. The internet reaches only the default `fetch` handler,
  and no Worker of the deployment binds the entrypoint, but any Worker deployed to the same account could. Within the
  deployment, the object keeps the gateway in a private field (wired by its constructor), which no RPC method exposes:
  the app Worker, which binds the object, reaches the run, never the gateway, and cannot make the object act as
  another run (a start must name the object's own run). The gateway marks the request with the run (`PresentedRun`,
  `apps/api/src/http/presented-run.ts`), which only it sets; the public `fetch` handler's context has none, so no
  header, path or body makes a request a run's. From there the request is any client's: grants, reach, tool scope,
  spend limits, prices, approval rules and usage records apply unchanged.
- **Reach** (`models/registry/caller-view.ts`): models: only the definition's model (`runModelFilter`: the same base
  name whatever the thinking suffix, which the run sends from the definition's thinking level; `auto` names none), for
  routing and for the model lists (`/v1/models`, `/v1beta/models`) alike; a private agent's run uses the models its
  member may use, a shared agent's the org's shared credentials whatever the grants (`callerView`:
  `RegistrySnapshot.shared()`, and `ALLOW_ALL` as the pool's reach for a caller with an `agentId`). Tools
  (`RunToolReach` in `tools/control-plane-part.ts`), listed and called alike: the definition's tool scope narrows them
  as an API key's would; a private agent's run acts as its member, a shared agent's as the agent (`asAgent`: every org
  toolkit with a shared credential, whatever the tool grants).
- **Spend**: a spend limit's refusal ends the turn with the refusal as its answer, and the run stays open: a model
  call's (`429 spend_limit_reached`, which the object turns into a `403` so the model client does not retry it) and a
  tool call's (a tool error whose `_meta` carries the refusal, `SPEND_REFUSAL_META`, given to runs only; the object
  then aborts the turn). The refusal is kept in the object's storage until the turn settles, so an eviction keeps it.
  A shared agent's run counts toward the agent's own Spend limits and the org's (#228, `SpendCaller.agentId`; the
  pool's caller, `RunToolReach.usage` for tool calls and the browser and sandbox session logs' `agent` column for
  browser and computer time charged when an idle session closes), never its starter's; a private agent's run counts as
  its member's traffic. A tool call from an API Worker that predates #228 sends no `usage`, so the agent's limits do not
  see it.
- **Approvals**: the run's starter is the caller of its tool calls' approvals (ADR 0040; `RunToolReach.starterMember`;
  a child run's: the member who started the run at the head of its chain), for a shared agent's run too, which has no member of its own. Under a rule of the caller the starter decides (in the
  panel), and under a team's or members' rule they do not; the model gets the
  approval's link text and may call again once it is decided. Watchers answering approvals in runs come with #232.
- **Sandbox** (#230, ADR 0041, `agents/runs/pi-sandbox.ts`): a turn whose definition names a sandbox gets pi-durable's
  coding tools `bash`, `read`, `write` and `edit` (their names, parameters, argument repair and output, as models know
  them) in place of the sandbox toolkit's own tools, which its model is not offered (opening and closing sessions
  among them). pi's own tools run, with an `ExecutionEnv` of the run's over its sandbox session
  (`agents/runs/sandbox-env.ts`, after cloudpid's `ComputerExecutionEnv`), each call gated first:
  - **The gate**: the call is the sandbox tool of the same name (`sandbox_bash`, …) through the MCP endpoint, as the
    run's principal, on the run's session, with `_meta["commissary/run-executes"]` (`@commissary/contract/sandbox-env`),
    so the sandbox toolkit's grants, the tool scope (the turn's scope gains the sandbox toolkit, all its tools, when it
    has no entry of it; one it has narrows them, a read-only one leaving `read` alone), approval rules, Spend limits and
    price apply to it as to that tool. Once every gate passed, the Tools part charges the price, marks the session's row
    used (its last use; the daily forgetting skips a run's rows, which go with the run) and, instead of making the call, keeps a **ticket** (`tools/sandbox/run-calls.ts`, the `sandbox_run_calls`
    table) bound to the run's principal, the session and the tool, with the call's spender (`spenderOf`: its member,
    API key, and the shared agent a shared agent's run charges as, #228) and its computer metering (below), answered as
    `outcome: "gated"` and in the result's `_meta["commissary/run-ticket"]`; the endpoint writes no record for it. Only
    a run's call is gated so (an API key's marker is ignored). A call that does not pass is answered as the sandbox
    tool's, its text naming pi's tools (a call waiting for approval says to call `bash` again).
  - **The operations**: pi's tool then runs, and each operation it makes on the environment (a command, what a path is,
    a byte range of a file, a file's text, a file written) goes over the run gateway's RPC (`sandboxOperation`) to the
    org's ControlPlane, whose Tools part runs it on the session through the sandbox provider (`runSandboxOperation`,
    `sandbox/run-operations.ts`) only with the call's live ticket, for its run, and only the operations its tool makes
    (`bash`: a command; `read`: what a path is and its bytes; `write`: a file written; `edit`: what a path is, its text,
    the file written), so one call of pi's `edit` is one gate and one record however many operations it makes. A
    command runs as `sandbox_bash`'s does (the fallback rule, the computer, ten minutes at most, its output cut to its
    tail and saved whole in the session, which is the call's `spillPath`); the rest of the interface answers
    `not_supported`. The run holds no binding or stub of the session: the `SANDBOX_SESSION` stub stays in the state
    Worker, behind the ControlPlane, and no Dynamic Worker gets anything new (the session's just-bash is the same
    Dynamic Worker with its files only, ADR 0044).
  - **The record**: once pi's tool answered, the run settles the ticket (`settleToolCall`): the Tools part ends its
    operations and answers its fields (`settleRunSandboxCall`), and the API Worker writes the call's one usage record
    under the ticket's id (`request_id`; outcome `success` or `tool_error`, or `refused` for a command refused the
    computer, below; latency from gate to the first settling, the answer's bytes, the cost the gate charged), naming
    the sandbox tool, as the run's principal, before it answers: a record it could not write fails the settling. A
    ticket's operations live five minutes past its last sign of life (its gate, and the start of each operation plus
    the command's timeout, and its end), so a slow command never outlives it; an expired or settled one, or another
    run's, runs nothing. Its settling is not bound by that: within a day of the gate (`SETTLE_GRACE_MS`) it answers the
    same each time, so a retried settling writes the same record once; the part forgets tickets past that day at its
    next gate. The run keeps each ticket in its storage (`sandbox-call:<ticket>`) from the gate until its settling went
    through: a run stopped between gate and settling (evicted, its harness closed) settles it as `upstream_failure`
    when its harness opens again, the call's charge staying; a settling that failed keeps its report (how the call
    ended, `PendingSettle`) and is tried again from the object's alarm once due (`retryAt`), backing off as a child
    run's delivery of its result does (#229, `deliveryBackoff`: 30 s, doubling, at most an hour), at most
    `MAX_DELIVERY_ATTEMPTS` times, one try of a ticket at a time, so a call that succeeded is recorded as one. One
    never settled within the day writes no record, the charge staying.
  - **Computer time** (#224), as the sandbox toolkit's own calls have it: the gate sets the call's metering (the price
    per computer hour, and whether a Spend limit its time counts toward has no room, checked as for `sandbox_bash`),
    which the ticket keeps and every operation passes to the session (`ComputerMeter`). The session's computer time each
    operation answers is charged at once to the call's spender's limits; the call's record holds its price only, as a
    `sandbox_bash` call's does, and the computer's time is the session's records' (below). With no room, an operation
    that meets the running computer stops it quietly and goes on, its answer carrying a note (`SandboxEnvReply.note`)
    that the run adds to pi's tool's answer as a warning (`diagnostics`); only a command that needs the computer is
    refused: the operation fails, the ticket keeps the limit's refusal, and settling it answers its words
    (`RunToolSettled.refusal`, as `refusedText` words a refused `sandbox_bash`), which end the turn as any Spend
    limit's refusal does.

  The session is opened at the run's first such call (`sandbox_open` with exactly the definition's network and computer,
  marked as the run's own, `RUN_SESSION_META`, a call and record of its own) and kept in the object's storage with its
  toolkit and those settings, so every later turn works in the same files. A gate names the session in its arguments,
  and the Tools part gates it only when the session is one it keeps as the run's (`SandboxSessionStore.owns`): another
  run's or member's session, or one it forgot, is answered as an unknown session and charged nothing. **Narrowing**:
  each turn hands the settings its session was opened with to `beginTurn`, which asks the Tools part whether they still
  fit the definition's sandbox and the toolkit's ceiling now (`RunSandboxes.fits`, `agentSandboxFits`); a session that
  no longer fits (a network or the computer narrowed, the sandbox removed or another toolkit named) is left
  (`sandboxNarrowed`), and the next call opens a new one, telling the model why and that the files are not there (a
  `sandbox_session` warning). It is not narrowed in place: its network is its Workspace's, set as it opens. The left
  session goes with the run. A definition or ceiling widened since changes nothing: the session keeps what it has. A
  session the sandbox lost (unknown or closed, an operation's `lost`, or the sandbox tool's `structuredContent.reason`)
  is replaced once, and the model is told its files are gone. A run's session does not end after a day without use
  (`OpenSandbox.untilPurged`, for the run's own session only): it lasts as long as the run, and goes when the run is
  deleted (below), with its tickets. As it may outlive any day, it writes no usage record when it closes: it writes one
  **each time its computer stops** (`SandboxSession.#recordStretch`), of that stretch's computer time and cost (a
  session record, `tool_id` null, under `<session id>:<stretch start>`, naming the run, its agent and starter): its
  object's alarm, which wakes when the computer's idle minutes are over as for any session, meters the run, reports what
  no call charged (`sandboxComputerTime`) and records the stretch; a call records one that stopped for want of room, or
  that ended before the call came (so a command that starts the computer again starts a stretch of its own); and the
  run's deletion records the last, as its purge settles the session as a member's leaving does (charging and recording a
  computer still running). A record that fails is kept with the session and tried again from its alarm a minute on
  (`SETTLE_RETRY_MS`), and the purge keeps one still unwritten in the closed note, as a close does. A run's session's
  object has no alarm while it has nothing to do.

- **Usage records** (migration `usage/0011_usage_agent_runs.sql`): a model attempt or tool call of a run names the
  agent (`agent_id`), the run (`run_id`) and its starter (`starter`: `member:<id>`, or `run:<id>` for a child run); its principal is `run:<run id>`, and
  `member_id` is the member a private agent's run acts as. A browser session a run opens names the run too
  (`StoredSession.run`), so its browser time's records do, and a sandbox session's computer time record (#224) too. The
  usage reads filter by agent and run (#228, "Usage accounting"), and a private agent's run's records are its member's
  alone.
- **Org deletion** (`agents/org-deletion.ts`): the app Worker's step deletes each run's object (`purge`: its alarm and
  all its storage), twenty at a time within the deletion's budget, and forgets them in the index (`runsPage`,
  `forgetRuns`), before `wipeOrg` drops the index, the queue of deleted runs below included.
- **Deletion** (#228, ADR 0027, `agents/runs/store.ts`, `agents/runs/retention.ts`): removing an agent deletes all its
  runs, whoever started them; a member who leaves takes their private agents' runs and every run they started,
  shared agents' included. Each goes with the child runs it started (`starter_kind` `run`) and theirs. A run leaves
  the index at once (`RunStore.discard`, in the same transaction as the deletion): it then answers like an unknown run
  and its principal is refused. Its object is the API Worker's, which the ControlPlane cannot reach, so its id waits in
  `agent_run_purges` (`deletedRuns`) until a Worker deletes the object (`purge`) and forgets it (`forgetRuns`): the app
  Worker's routes right after the deletion (`sweepDeletedRuns`: agent removal, member removal, account deletion; three
  pages of twenty, best effort) and the cron task below for what they leave. Both, and the org's deletion, page with
  one loop (`sweepObjects`, `agents/org-deletion.ts`): each object is deleted on its own (`Promise.allSettled`), those
  deleted are forgotten, and one that fails stays queued and ends that sweep, so it never holds up the others. The
  cross-org suite checks the queue (`controlplane: deleted agent runs`).
- **Purge** (`AgentRunObject.purge`): the object closes its harness first, aborting a running turn, for at most 5 s,
  then deletes its alarm and all its storage; a harness still closing then deletes the storage again once it closed
  (`waitUntil`), and from the purge on the instance opens no harness and writes nothing (`#purged`), so nothing it had
  running writes the run back. A later instance starts empty and answers like an unknown run. The run's sandbox
  session (#230) is the Tools part's: forgetting the run (`forgetRuns`) has the Tools part of the same ControlPlane
  purge it first (`RunSandboxes`, wired by the state Worker's composition, `purgeRunSandboxSessions`), and a run whose
  session could not be purged stays queued for the next sweep. The purge settles the session first, so its last
  stretch of computer time is charged and recorded (above).
- **Retention** (#228): each org keeps its agent runs `run_retention_days` after their last activity (a column of the
  Platform registry's `orgs` table, `PATCH /org` and the panel's Settings, Retention; `null` keeps them; every org
  starts at 30, `global` and those from before included). The last activity is the index's `updated_at`: the run's start
  and every state its object reports (a turn starting, settling or ending the run; a message to an idle run starts a
  turn, and one to a running turn joins it, which stays running until it settles). The API Worker's deployment-wide
  cron task `agent-run-retention` (`pruneExpiredRuns`) deletes, per org, the runs idle longer (`expireRuns`, as a
  deletion above) but never one the index holds as running, and each on its own last activity: a child run is not
  pruned with its parent, unlike a deletion. It then deletes the objects of the org's deleted runs, ten pages at most
  per org, within 400 calls per run of the task across all orgs (`RETENTION_BUDGET`; an invocation's subrequests are
  limited), starting at an org that moves on every hour, so the orgs a spent budget left out come first later. One
  org's failure does not stop the next. A run whose object never reports the end of its turn (the report failed) stays
  `running` in the index and is kept until it reports again.
- **Export**: the org export's agents section carries each agent's runs' metadata (`Runs.exported`): who started each
  (a member by email, a run by id), its trigger, state and times, never a transcript.
- **Management routes** (`agents/management/run-routes.ts`, `AgentRunsGroup` in `@commissary/contract/agent-runs`):
  `POST /agents/:id/runs` (start, as the asking member, trigger `chat`), `GET /agent-runs`, `GET /agent-runs/:run`,
  `POST /agent-runs/:run/messages`, `POST /agent-runs/:run/wait` (default 30 s) and `POST /agent-runs/:run/cancel`.
  Only a run's starter sees it for now (watchers and org admins with #232); any other run answers like an unknown one,
  so a shared agent's triggered runs, which no one started, are seen by no one until #232, and a child run is seen
  through the agents toolkit only, by the run that started it.
- **pi packages**: `@earendil-works/*` 1.3.0, pinned exactly (their APIs are experimental), imported only by
  `agents/runs/pi.ts` and the run's sandbox tools it installs (`agents/runs/pi-sandbox.ts`,
  `agents/runs/sandbox-env.ts`), all imported statically: the object imports the adapter, as the adapter imports pi-ai's
  OpenAI-compatible provider module (`@earendil-works/pi-ai/api/openai-completions`, not its lazy `import()` wrapper). A
  lazy import would be shared by the run objects of one isolate: when several start at once, all but one await the
  import another object began and resume in that object's I/O context, which workerd refuses ("Cannot perform I/O on
  behalf of a different Durable Object"), failing the turn and leaving its harness open (its deletion then never
  finished). `agents/test/run-isolate.test.ts` starts an isolate's first runs at once and fails with pi-ai's lazy
  import. So both Workers that bundle the Agents area (the API Worker, which runs the objects, and the app Worker,
  through `@commissary/agents/api`) load the pi packages at startup. The adapter gives pi-ai one OpenAI-compatible
  provider (`commissary`) whose `fetch` is the run gateway, and installs the tools the MCP endpoint lists for the run
  (`@earendil-works/pi-mcp` over the same `fetch`). The cost, measured with `wrangler deploy --dry-run` and `wrangler
  check startup` (median of nine) when the adapter was loaded lazily: the API Worker is 3,041 KiB gzipped with a 68.8 ms
  startup, against 2,665 KiB and 64.4 ms with the pi packages stubbed out; loaded at startup, the startup time includes
  them.

### Triggers (#231)

- **The model** (`agents/triggers/`, table `agent_triggers` of `AGENTS_TABLES`): a trigger is configured on one agent:
  its kind (`schedule` or `webhook`), a name, whether it is enabled, an input (a schedule's first message, required; a
  webhook's template, optional), the kind's own fields (a schedule's cron expression and time zone) and a revision.
  Every kind ends in `Runs.startTriggered`, which records the run's kind and trigger, keys it by the delivery's
  idempotency key and decides its starter; runs, the run's principal and usage records know nothing else of kinds.
  Starting a run through a trigger needs nothing but the trigger: no member is present. The part's runs and triggers
  read one clock (`useClock` puts a test's `TestClock` in its place).
- **Starters**: a private agent's triggered run counts as started by its member (it acts as them, as their chat runs
  do; refused while the org serves no private agents or the member left). A shared agent's triggered run has **no
  starter** (ADR 0040: a run records its starter "if anyone did"), and so, until #232, **no one sees it, cancels it or
  answers its approvals**: the run routes show a run to its starter only, and under an approval rule of the caller its
  tool calls wait for an approver that only #232's watchers will be. Its turns check no starter (its agent's state
  alone decides), Commissary Cloud checks no starter's standing, and its usage records' `starter` is `NULL` (not a
  member, so no filter by member or starter matches it). The panel's notice that an unattended agent acts with no one
  present (ADR 0044) is the panel's (#233, _The panel_ below).
- **Schedules** (`triggers/schedule.ts`, `triggers/schedule-object.ts`): a five-field cron expression (minute to day of
  week, no seconds) in an IANA time zone, through Effect's `Cron`; one that matches no date is refused. Each schedule
  has a Durable Object of its own, `AgentSchedule` (`<org>:<trigger>`, `agentScheduleName`), whose alarm is its next
  tick. It lives in the API Worker beside the runs' objects, not in the state Worker, because a tick starts a run's
  object, which the state Worker cannot bind (the API Worker binds the state Worker's objects: a binding back would be
  a cycle no fresh stage could deploy); the app Worker binds it by the API Worker's script name, as `AGENT_RUN`. The
  management routes arm it (`arm`: it asks the ControlPlane for the next tick and sets the alarm) when a schedule is
  added, enabled or edited. At the alarm it first asks the Platform registry whether the org still exists (a deleted
  org's object deletes itself without reaching the org's ControlPlane, which would be created again, empty), then
  fires the tick (the part's `fireSchedule`), which starts the tick's run keyed by the tick, so a retried alarm finds
  that run; it starts the run's object with the schedule's input (a run this attempt created whose object cannot be
  reached is ended, and the schedule goes on), then sets the next tick. A ControlPlane that cannot be reached is asked
  again a minute later for the same tick. A tick while the agent is disabled starts nothing and is not caught up; a
  disabled schedule has no alarm until it is armed again.
- **Gone schedules' objects** (`agent_schedule_objects`): the ControlPlane cannot reach the objects, so it
  lists every schedule whose object may exist, from its creation until its object was deleted, apart from the
  triggers' rows. A schedule removed (by its route), with its agent (the agent's route) or with its member (the app
  Worker's member removal and account deletion) leaves its row there, and the route then sweeps the org's gone
  schedules' objects (`sweepRetiredSchedules`, best effort, three pages of twenty); one the sweep missed deletes itself
  at its next alarm, when it finds its schedule gone, and org deletion deletes every listed object.
- **Webhooks** (`triggers/webhook.ts`, `triggers/webhook-route.ts`): `POST /agent-webhooks/<org>/<trigger>` on the
  API Worker (not `/webhooks`, whose `/webhooks/polar` is the app Worker's), a client API path
  (`AGENT_WEBHOOK_PREFIX` in `CLIENT_API_PREFIXES`, so the app host's zone routes and the Access bypass cover it) that
  the gate lets through (`isPublic`): it proves itself with the trigger's secret, not a key. A secret is
  `whsec_` and 32 random bytes, sealed in the ControlPlane (`agent_triggers/<id>`), shown once on creation and on
  rotation (`POST .../secret`, the old one stops at once); the URL is always shown. The route, in this order: a
  malformed address answers `401` before the body is read; the Platform registry must know the org (as for an API
  key, so a made-up org id never instantiates a ControlPlane), else `401`; on Commissary Cloud every delivery to a
  known org, proven or not, counts against the org's webhook bucket (`limitWebhookAttempts`: key `webhook:<org>` in
  the plan's rate-limiting binding, as many a minute as the org's ceiling, Pay as you go's binding for a raised one)
  before the org's ControlPlane is asked anything, so a flood of unproven deliveries is refused there (`429`) instead
  of loading it, and never uses up the ceiling the org's API keys count against; the body is at most 1 MiB (`413
  body_too_large`); then the ControlPlane checks the proof in constant time, so the secret never leaves it; a proven
  delivery then counts against the org's request-rate ceiling (`limitClientRate`), as an API key's request does. A
  delivery proves itself with `Authorization: Bearer <secret>`, or with a signature, Standard Webhooks' scheme under
  Commissary's header names: `X-Commissary-Delivery: <id>`, `X-Commissary-Timestamp: <unix seconds>` and
  `X-Commissary-Signature: sha256=<hex>`, an HMAC-SHA256 under the secret of `<id>.<timestamp>.<raw body>`, whose
  timestamp must be within five minutes of the ControlPlane's clock (Standard Webhooks' tolerance, as Polar's
  webhooks, `billing/polar.ts`). A captured signed delivery cannot be replayed later, and within the five minutes a
  replay either names the signed id, which finds the run that id started, or proves nothing. An unknown trigger and a
  wrong or stale proof answer the same `401`, after the same work. Its run is keyed by its delivery id
  (`X-Commissary-Delivery`, which a signature signs, else Standard Webhooks' `Webhook-Id`), else, for a bearer
  delivery without one, by the body's SHA-256 and the minute: senders should send `X-Commissary-Delivery`, since
  without it identical bodies within a minute are one delivery (one run) and a retry that crosses a minute's boundary
  starts a second run. The first turn is the template with each
  `{{body}}` replaced by the body, or the body alone (`422` when that is empty). The route answers `202 {run}` once the
  run's object took that turn, never waiting for the answer; a disabled trigger or agent answers `409`.
- **What a new kind adds** (the extension point): its literal and fields in the contract (`ConfiguredTriggerKind`,
  `CreateTrigger`, `TriggerView`), its stored config (`TriggerConfig`), its row in the kinds' table (`triggers/kinds.ts`,
  `TRIGGER_KINDS`: whether its input is required, whether it has a secret or an object of its own, its config from a
  creation or an edit, its fields in a view and in the export), and its own way in (an alarm, a route, a queue) that
  ends in `Runs.startTriggered` with an idempotency key of its own.
- **Members, agents and orgs**: removing an agent, or its member leaving, deletes its triggers (and sweeps their
  schedules' objects, above). Org deletion's Agents step deletes every listed schedule's object first (its alarm
  would start runs), then each run's, twenty at a time (`scheduleObjectsPage`, `forgetScheduleObjects`). The org
  export lists each agent's triggers (kind, name, enabled, input or template, a schedule's cron expression and time
  zone; never a secret, a webhook's id or its URL). The cross-org suite checks that one org's triggers are not listed in
  another (`controlplane: agent triggers`) and that one org's schedules' objects answer nothing for another's
  (`agent schedules' objects`); the API Worker's tests check that one org's webhook trigger or secret proves nothing
  at another existing org's address.
- **Management routes** (`agents/management/trigger-routes.ts`, `AgentTriggersGroup` in
  `@commissary/contract/agent-triggers`): `GET` and `POST /agents/:id/triggers`, `PATCH` and `DELETE
  /agents/:id/triggers/:trigger` (`If-Match` names the revision) and `POST /agents/:id/triggers/:trigger/secret`
  (rotation), for the agent's manager only (a private agent's member, an org admin for a shared agent; an org admin
  seeing a member's private agent gets `403`). The part takes each call as one request (`TriggersRequest`,
  `TriggerRequest`: viewer, agent, the client API's origin, who asks, and a trigger and its revision). A schedule
  whose object cannot be armed is not added (`502`); an edit whose arming fails is kept and answers `502
  schedule_not_armed`, to be armed by the next edit. A webhook's URL is on the API host (`API_DOMAIN`), else on the
  request's host (zone routes; under `alchemy dev` without an API host, the app's origin, which is fine for local
  development: nothing outside reaches it there).

### The panel (#233)

- **Panel** (`apps/web/src/pages/Agents.tsx`, `AgentNew.tsx`, `Agent.tsx`; components `AgentEditor.tsx` with
  `AgentFields.tsx`, `AgentScopeEditor.tsx`, `AgentSandboxEditor.tsx`, `AgentShared.tsx`, `AgentTriggers.tsx`,
  `AgentTriggerForm.tsx`, `AgentGrants.tsx`, `AgentSpend.tsx` and `UnattendedNotice.tsx`; models in
  `apps/web/src/lib/agents.ts`, `agent-form.ts`, `agent-triggers.ts` and `agent-notice.ts`): **Agents** (`/agents`,
  every member's, in the sidebar's Providers group, only where `/me` says `deployment.agents`; `agents` is in
  `PANEL_SECTIONS`) lists the agents the caller manages, with their model, tools and whether each is enabled, the
  shared agents granted to the caller, and for an org admin the other members' private agents as existence only, to
  disable or remove. **New agent** (`/agents/new`) is private for a member where the org allows private agents
  (`Me.private_agents`, an org setting a switch on Members sets) and shared for an org admin, who names who may use
  it (the grant is required, so the form blocks without one), its watchers and optionally a spend limit, created
  after the agent through `/spend/limits` (a refusal there leaves the agent and says so). The model is a free-text
  field with the caller's reachable models as suggestions; the server validates it. The tool scope has its own
  pickers (toolkits the caller reaches, a toolkit's tools read lazily from `GET /toolkits/:id/tools`, and the agents
  toolkit's usable agents); the sandbox part names a sandbox toolkit and settings within its ceiling (#230; a refusal is `422 invalid_sandbox`). An **agent's page**
  (`/agents/$agentId`) edits the definition with its `If-Match` revision, enables or disables it, and carries its
  triggers (schedule and webhook: a schedule's cron is previewed in words and as its next three runs in its time
  zone, parsed with the same `Cron` the server uses; a webhook's secret is shown once, on creation or rotation, in a
  notice that stays until dismissed), and for a shared agent its grants and spend limit; removal asks to confirm.
  The **unattended notice** (ADR 0044) heads the page, over the saved agent, when an enabled schedule or webhook trigger
  meets a write tool in its tool scope with no approval rule on it: nothing asks anyone before such a call, and no one
  watches when the run starts, so a steered run could make it unchecked. The form counts the same tools beside each
  toolkit as its tool scope is edited. Disabled triggers do not count; hidden, missing and clashing tools are left out;
  a toolkit whose tool list cannot be read is said, as its write tools go unchecked.

### The agents toolkit and child runs (#229)

- **The toolkit** (`tools/agents/toolkit.ts`; the tools' names, classes and arguments in
  `@commissary/contract/agents-toolkit`): a built-in toolkit (_Built-in toolkits_ under Tools) named `agents` (kind
  `agents`, source `commissary`, credential kind `none`), whose tools have the shape of pi's subagent tools with the
  agent as an argument: `agents_start` (write: `agent`, `input`; answers the run's id, its first turn's and its status
  at once), `agents_message` (write: steers the running turn, or starts a turn on an idle run; answers the turn and
  `disposition`, `steering` or `turn`), `agents_wait` (read: `run`, optional `turn` and `timeout` in seconds, 30 by
  default and at most 300; below), `agents_status` (read: the caller's runs, or one run's state, turns and recent
  activity) and `agents_cancel` (write: aborts the running turn; the run stays, and so do the child runs it started).
  There is no delete tool. Starts and messages take an optional idempotency key (stored as `mcp:<api key>:<key>`, so
  two keys never share one). Every answer is a tool result whose text is JSON; a refusal is a tool error, so a model can
  correct itself.
- **Where it exists**: where the Agents area is (`LOADER`, ADR 0043), as the rest of the area. The state Worker's
  composition (`apps/state/src/control-plane.ts`) gives the Tools part the agents toolkit only with `LOADER` bound, and
  then a reader of the Agents part of the same object (`AgentDirectory`, over the part's `runnableAgents`; Tools
  imports nothing of Agents, and a part missing from the composition fails the call rather than hiding the toolkit).
  Without it the toolkit is in no list, export or grant check, and its name is not reserved (a stored toolkit named
  `agents` keeps its name). The MCP endpoint serves it only where its Worker provides `AgentsToolkitPort`: the API
  Worker and the app Worker each do where `LOADER` is bound (the API Worker binds it for this alone), filling it from
  Agents' `agentsToolkitCalls` (`agents/toolkit/calls.ts`). Where the ControlPlane has it, a stored toolkit named `agents` from
  before is renamed once, as for the other built-in toolkits.
- **Who reaches it** comes from the agents, never from tool grants (a grant naming the toolkit is refused): a caller
  reaches its tools as soon as they may run an agent, and the toolkit is listed only then. A member may run their
  private agents (while the org serves them) and the enabled shared agents a grant gives them (#226); a private agent's
  run, any agent its member may use; a shared agent's run, the org's enabled shared agents; never a run's own agent,
  which `agents_start`'s list leaves out (it would be a cycle, below). A tool scope's entry for the toolkit narrows that
  to the agents it names (`ToolScopeEntry.agents`, read by `agentsInScope`; the entry alone: every agent within reach),
  and its tool classes apply as to any toolkit's, so a read-only scope may watch runs (`agents_status`, `agents_wait`)
  but not start or steer them. `agents_start`'s description lists the agents the caller may run, by name and
  description, and is rebuilt on every list. Usage, Spend limits, tool overrides' prices and approval rules apply to its
  calls as to any built-in toolkit's.
- **Who makes its calls**: a run lives in the API Worker's `AgentRun` objects, which the state Worker cannot bind, so
  the part only decides that the caller reaches the tool, charges it, and answers `delegated` (with the agents the
  caller's scope names) to an endpoint that says it makes the calls (`ToolCall.agentsToolkit`; a `DelegatedBuiltIn`,
  beside the browser and sandbox toolkits' `CalledBuiltIn`); the endpoint hands the call to its Worker's port.
- **Deploys** (DEVELOPMENT.md, "State RPC: expand, then contract"): the part lists, calls and exports the toolkit, whose
  kind an older Worker cannot decode, only to a caller that asks for it (`agentsToolkit` on `clientTools`, `callTool`,
  `listToolkits`, `listTools` and `exportToolkits`, which the management routes and the endpoint pass); the panel's
  scope editor and keys' tool counts, which show no kind, count it. The run's principal names its head member
  (`starterMember`), which a ControlPlane from before child runs leaves out (the starter, a member, then stands in).
- **Which runs a caller sees** (`ToolkitCaller`, `agents/runs/runs.ts`): an API key, the runs it started (the index
  keeps the key, `api_key_id`; a second key of the same member gets an unknown run); a member signed in (a request
  through Access, without a key), every run they started, through a key or not; a run, the
  child runs it started. Any other run answers like an unknown one. In the panel (`/agent-runs`) only runs a member
  started show, so a child run is seen through the agents toolkit only, by the run that started it, until #232.
- **Child runs**: a run's `agents_start` starts a child run of the agent it names, acting as that agent (a private
  agent's member, or the shared agent itself), started by the calling run (starter kind `run`) and trigger `mcp`. A
  run may run only enabled agents: a disabled one answers like an unknown one, so nothing tells a run of an agent it
  may not run. The chain of runs is at most three deep (`MAX_CHAIN`: a run, its child, its grandchild), an agent already
  in the chain is refused (`a → b → a` as `a → a`), and a run has at most eight child runs running at once
  (`MAX_ACTIVE_CHILDREN`: a child counts as running from its start until it reports a turn done); each is a tool
  error. A child run's turns check, besides #227's checks, that the run that started it is still there and may still
  run its agent; its tool calls' approvals are the member's at the head of its chain (a chain no one started, from a
  shared agent's trigger, has none, as #231's runs). A child run of a run that ended is refused at its next request.
- **Ending**: a run that ends (its object reports `ended`: its agent disabled or removed, its member or its starter gone)
  ends its child runs and theirs in the index at once (`Runs.stateChanged`, so their next request through the
  gateway is refused), and its object stops their objects (`AgentRunObject.stop`: the running turn aborted and recorded
  as cancelled, the run ended), so whoever stops the head of a chain stops the tree. Cancelling a turn ends nothing.
- **Claims and deliveries** (`agents/runs/run-object.ts`): `agents_wait` claims a turn's result for its caller (a
  `Claimant`: `run:<id>`, `key:<id>` or `member:<id>`): the named turn's, or the oldest finished turn that caller has
  not claimed yet, or else the running turn's once it finishes. On timeout it answers the running turn with its latest
  activity and cancels nothing; with nothing left it says whether the results were claimed or delivered. A child run
  hands each finished turn its parent did not claim to the parent: it delivers it as a message (`[agents] Run … (agent
  …), which you started, finished its turn …` with the answer), which steers the parent's running turn or starts a
  turn on an idle parent. The parent takes it only from its own child runs (the index says so) and each child turn once
  (its idempotency key, `child:<run>:<turn>`); one it refuses for good (it ended) is dropped. A delivery that cannot
  reach the parent is kept and tried again from the child's alarm, after 30 s and then twice as long each time (at most
  an hour), ten tries in all (`MAX_DELIVERY_ATTEMPTS`, about three hours), after which it is dropped and logged; a parent
  claiming a result still to be delivered takes it from the deliveries. The panel's wait (`POST /agent-runs/:run/wait`)
  claims nothing, until watchers (#232) align the two.
- **Deletion** (#228, "Agent runs"): a run deleted with its agent or its member takes its child runs and theirs
  (`RunStore.discard` follows `starter_kind` `run` down the tree), whatever agent they run, and the sweeps delete their
  objects like any run's; a run pruned past the org's retention period goes alone, each child on its own last
  activity. Org deletion deletes every run's object, child runs included (they are rows of the index like any run).
