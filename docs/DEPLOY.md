# Continuous deployment

`.github/workflows/ci.yml` checks every pull request and push to `main`, then deploys with Alchemy:

| Event                                    | Stage         | Where                                                         |
| ---------------------------------------- | ------------- | ------------------------------------------------------------- |
| Push to `main`                           | `prod`        | its app host, GitHub environment `production`                 |
| Push to `main`                           | `cloud`       | its own domain, GitHub environment `cloud` (once set up)      |
| Pull request from a branch of this repo  | `pr-<number>` | the Workers' `workers.dev` URLs, GitHub environment `preview` |
| That pull request closed (merged or not) | `pr-<number>` | destroyed                                                     |

A preview is a Commissary Cloud deploy (`COMMISSARY_MODE=cloud`) while its pull request has the label `cloud-preview` (adding or removing the label
redeploys it in the other mode); production is one when the `production` environment sets `COMMISSARY_MODE=cloud`
([Commissary Cloud](#commissary-cloud)); the `cloud` stage always is ([The Commissary Cloud stage](#the-commissary-cloud-stage)). Everything
else in this file describes a self-hosted Commissary, the default. A preview has the sandbox's computer
(`COMMISSARY_COMPUTER=on`) while its pull request has the label `preview-computer` (adding or removing it redeploys
it); `prod` and `cloud` have it (ADR 0043) through their deployer settings: `.env` (for `prod`) and `.env.cloud` set
`COMMISSARY_COMPUTER=on`, in effect once `pnpm ci:setup` has written it into their environments
([Optional pieces](#optional-pieces)).

Deploys run only after typecheck, lint, workflow lint (actionlint, zizmor), the test shards and the smoke test pass.
Fork and Dependabot pull requests get the checks but no preview (they receive no deploy secrets). A manual run
(`workflow_dispatch`) on `main` redeploys production. A pull request or push that changes documentation only (Markdown
files anywhere, everything under `docs/`) runs neither checks nor deploys (`tools/ci-changes.sh`); its preview, if
earlier commits deployed one, is still destroyed on close.

After each deploy, `tools/check-deploy.sh` checks where Access sits (ADR 0022): `/healthz` and `/v9/management/me`
answer 200 through Access with the CI service token (the second proves that the Worker accepts the Access JWT: team
domain and AUD wired); `/v1/models` and `/v1beta/models` without credentials reach the API Worker, which answers
`401 Missing API key` itself (the client API is outside Access, behind API keys); `/v1/models` with an Access JWT
in `cf-access-token` and a dummy `Authorization` key, the way `cloudflared access` clients call it, answers 200 (the
JWT is the `CF_Authorization` cookie Access set for the service token); and `/` without credentials is stopped by
Access. A Commissary Cloud deploy is checked by `tools/check-cloud-deploy.sh` instead: `/healthz` answers 200 on the app
host and on the auth host (the deploy's `authUrl` output), the auth host's `/api/sign-in-options` offers a provider and
Better Auth's `/api/auth/ok` answers 200, a CORS preflight from the app origin is allowed and one from elsewhere refused,
`/v9/management/me` answers `401 Not signed in` from the Worker, `/` redirects to `/sign-in`, and the client API answers
`401 Missing API key`. Both scripts send the client API to the deploy's
`apiUrl` output ([The Workers](#the-workers)): with an API host ([API host](#api-host)) or on a preview, where the
client API has a host of its own, they also check that each host refuses the other's paths with its Worker's `404`.
The deploy job then shows the URL on the run, and previews get a pull request comment (`tools/preview-comment.sh`),
with the app and the client API URLs, that is updated on every push.

## Preview stages

A stage named `pr-<number>` is a preview (`infra/settings.ts`):

- Its own app Worker on `workers.dev`, protected by its own Access application, its own API Worker on another
  `workers.dev` URL, outside Access (clients send API keys there), and its own state Worker, which has no URL
  ([The Workers](#the-workers)). The app Worker enrolls into the Access application (Alchemy's Worker `access` prop),
  so Access covers its `workers.dev` URL; no custom hostname is needed, and no bypass application either: the client
  API is on the API Worker's URL, which the panel names (`GET /me` `api_url`).
- Same policies as production: `ACCESS_ALLOW_*` for people, `ACCESS_ALLOW_SERVICE_TOKEN_IDS` for the CI token. Same
  platform admins (`PLATFORM_ADMIN_EMAILS`).
- Empty KV, D1 and Durable Objects, and no cron trigger. A preview has no provider credentials, so it serves the panel,
  the management API and the routes but cannot serve real requests. Add credentials through its panel if you need to.
- `COMMISSARY_DOMAIN`, `COMMISSARY_APP_DOMAIN`, `COMMISSARY_API_DOMAIN`, `COMMISSARY_AUTH_DOMAIN`, `ACCESS_AUD` and
  `ACCESS_SERVICE_TOKENS` are ignored.

Any machine with the deploy settings can deploy a preview by hand: `pnpm run deploy --stage pr-123`, and remove it with
`pnpm run destroy --stage pr-123`.

## The Workers

A stage deploys three Workers (ADR 0030) from the one stack, and a fourth on Commissary Cloud, the auth Worker
([Commissary Cloud](#commissary-cloud)). On every stage they deploy in this order: the state Worker, the API Worker, the
auth Worker, the app Worker.

1. **`State`** (`apps/state`) defines the Durable Objects `ControlPlane`, `SessionState`, `Platform`,
   `BrowserSession` (one per browser session of the browser toolkit) and `SandboxSession` (one per sandbox session of
   the sandbox toolkit): every org's state and the Platform registry. It has no routes, no domain and no `workers.dev`
   URL, and binds only what those classes read: the Worker Loader (`LOADER`, Dynamic Workers, which run the sandboxes'
   shells), the usage database (`USAGE`, which a browser session writes its record of browser time into), the secrets
   keys, the `auth_index` key, `META_MINT_URL`, `OWN_HOSTS`, the platform admins, the mode and the
   Access settings that mark a deployed stage, and Browser Run unless `COMMISSARY_BROWSER=off`
   ([Optional pieces](#optional-pieces)).
2. **`Commissary`** (`apps/app`), the app Worker: the control panel (with Commissary Cloud's sign-in page) and the
   management API, on the stage's
   domain (the app host) or `workers.dev` URL, behind Access on a self-hosted stage. It answers the client API paths
   `404` with the address of the client API, except, on a self-hosted stage, the MCP endpoint `/mcp` (and `/o/<slug>/mcp`), which
   it serves behind Access to MCP clients Access signs in (ADR 0045). It binds the state Worker's Durable Objects by script name, which is also
   why Alchemy deploys it after the state Worker, the API Worker's `AgentRun` (the agent runs, #227) and
   `AgentSchedule` (agents' schedule triggers, #231) by script name, which is why it deploys after the API Worker, and no secrets keys, which only the ControlPlane reads.
3. **`Api`** (`apps/api`), the API Worker: the client API (`/v1`, `/v1beta`, `/v1internal`, `/openai/v1`,
   `/backend-api/codex`, `/chat/completions`, `/completions`, `/responses`, the MCP endpoint `/mcp`, toolkits' CIMD
   document `/oauth/toolkits/client.json` and hosted agents' webhook triggers `/agent-webhooks`), `/healthz` and the cron trigger, under no Access
   application of its own: clients send API keys. It binds the Durable Objects by script name too, and the per-org rate limit
   on Commissary Cloud. It defines two Durable Objects of its own: `AgentRun`, one per run of a hosted agent (#227, ADR
   0030's amendment), and `AgentSchedule`, one per schedule trigger of a hosted agent, whose alarm starts its runs
   (#231). A run reaches the client API and the MCP endpoint through this Worker's own loopback entrypoint
   (`ctx.exports`), which no Worker of the deployment binds (the trust boundary is the Cloudflare account, as for the
   Durable Objects). Where it answers:
   - on the API host when there is one ([API host](#api-host)), as its custom domain;
   - else on the app host, through **zone routes** `<app host>/v1*`, `/openai/v1*`, `/backend-api/codex*`,
     `/chat/completions*`, `/completions*`, `/responses*`, `/agent-webhooks*` (hosted agents' webhook triggers, #231)
     and `/oauth/toolkits/client.json*`, and on Commissary Cloud
     `/mcp*` (a route runs in front of
     the app Worker's custom domain on the same hostname); the bypass application of the client API paths takes them
     out of the app host's Access application ([Operations](#operations)). A self-hosted stage with one host has no
     route for `/mcp`, which stays the app Worker's behind Access, so its MCP endpoint for API keys needs an
     [API host](#api-host);
   - on a preview, on its own `workers.dev` URL.

   The deploy's `apiUrl` output names where clients send API keys (`tools/deploy-stage.sh` passes it to the checks).
   It is the same URL as before the API Worker on every stage but a preview, so clients change nothing.

Deploying a Worker restarts the Durable Objects it defines, and Alchemy uploads a Worker again only when its bundle
changes, so the Durable Objects restart only on a deploy that changes their code, not on every panel or client API
change. When they restart, the requests in flight fail with "Durable Object reset because its code was updated"; the
app and the API Worker send each such call once more (`retryOnCodeUpdate`). Because a deploy can run the new state
Worker with the old app and API Workers for a moment, state RPC changes are expand-then-contract
(`docs/DEVELOPMENT.md`, "State RPC: expand, then contract"). The agent runs' objects are the API Worker's, so they
restart on every deploy of it (every merge, in CI): a run that was working resumes on its own within a minute (its
heartbeat alarm), without making a finished tool call again; a model call it was waiting on is made again. The
schedule triggers' objects are the API Worker's too: a restart keeps their alarms, and a tick whose alarm fails is
fired again without starting a second run.

**Revocation and suspension** made on the app Worker reach the API Worker's isolates within the same windows as
before (30 s for a verified API key, 30 s for a suspension's standing), since the API Worker is another isolate.

**The move.** Until this split, the `Commissary` Worker defined the three classes itself. The state Worker declares
each with `transferredFrom: "Commissary"`, so the first deploy of a stage that still holds them there moves each
namespace, with every stored object (all orgs, members, credentials, API keys, config, the Platform registry), to the
state Worker: Cloudflare's data-preserving transfer, not a copy. In the same deploy the app Worker drops the classes and
binds them on the state Worker instead; nothing is deleted. Production and `cloud` move on their first deploy after the
merge; a new stage (every preview) creates the classes on the state Worker directly, and the setting does nothing
there or once a stage has moved, so it stays in `alchemy.run.ts`.

**Upgrading a self-hosted Commissary.** Deploy as usual (`pnpm run deploy --stage <stage>`, or CI): the stack gains the
state Worker and the move happens on that deploy, with no setting or manual step. Expect:

- a new Worker, `commissary-state-<stage>-<suffix>` (Alchemy names it from the stack, the logical ID `State` and the
  stage), with no URL, and the API Worker `commissary-api-<stage>-<suffix>` (logical ID `Api`) with the zone routes or
  the API host ([The Workers](#the-workers)): the account's Worker count grows by two;
- the requests in flight during the deploy may fail once while the Durable Objects restart, as on any deploy that
  changed their code;
- no change to URLs, API keys, management keys, sessions or stored data. The client API may answer `404` for a few
  seconds within the deploy: on one host, the new app Worker may refuse the client API paths before the zone routes
  exist.

**A stage with an API host that skipped the split.** Since the agent runs (#227) the API Worker deploys before the app
Worker on every stage ([The Workers](#the-workers)). A stage still on a release before the split (#172) with an API host
has that hostname on its app Worker (as an alias), so the API Worker, deployed first, cannot take it. Deploy an
intermediate release first (one after the split and before the agent runs): its deploy moves the hostname to the API
Worker. Then deploy the current release. A stage on one host, or one already past the split, deploys the current
release directly.

**Before merging the split** a person rehearses the move on a throwaway stage `pr-0`, self-hosted and Commissary Cloud
(#152): deploy `main`, seed an org, a member, a credential and an API key, deploy the split onto the same stage, check
that everything survived and the API key works, destroy the stage. A pull request's own preview starts empty and
proves nothing about the move.

## Base domain and app host

`COMMISSARY_DOMAIN` is the **base domain** (ADR 0031): the app host and Commissary Cloud's auth host are under it (the
API host may be elsewhere), it is where a landing page may live, and on Commissary Cloud it scopes the session cookie.
`COMMISSARY_APP_DOMAIN` (optional) is the **app host**, the app Worker's custom domain: the control panel, the sign-in
page and the management API, on a self-hosted Commissary the hostname of the Access application, and, without an [API
host](#api-host), the hostname of the client API's zone routes. It is the base domain itself or a host under it, and by
default the base domain, so a `.env` that sets `COMMISSARY_DOMAIN` alone serves everything there as before.

| Layout                     | `COMMISSARY_DOMAIN` | `COMMISSARY_APP_DOMAIN` | `COMMISSARY_API_DOMAIN` | Auth host (Cloud)      |
| -------------------------- | ------------------- | ----------------------- | ----------------------- | ---------------------- |
| one hostname (the default) | `llm.example.com`   | (unset)                 | (unset)                 | `auth.llm.example.com` |
| a landing page on the base | `example.com`       | `app.example.com`       | `api.example.com`       | `auth.example.com`     |

- **Moving the app host** (setting `COMMISSARY_APP_DOMAIN` to a host other than the base domain) moves the app Worker's
  custom domain, the Access application and the zone routes: the old hostname stops answering, so point people and
  clients at the new one. The app host must be on a zone of the account; `pnpm ci:setup` writes the variable into the
  environment and extends the deploy token to its zone.
- **Commissary Cloud's session cookie** is scoped to the base domain, so every host under it receives it: a landing
  page, and the API host when it is under the base domain (ADR 0031). While the base domain is the app host the cookie
  keeps Better Auth's name; once the base domain is above the app host it is named `__Secure-commissary.session_token`,
  so a cookie still scoped to the app host from before is ignored instead of shadowing it: everyone signs in once more
  after the switch.

## API host

`COMMISSARY_API_DOMAIN` (optional, ADR 0028) gives a deployment a second hostname, the **API host**: the API Worker's
custom domain, which serves the client API (`/v1`, `/v1beta`, `/v1internal`, `/openai/v1`, `/backend-api/codex`,
`/chat/completions`, `/completions`, `/responses`, `/mcp`, `/oauth/toolkits/client.json`) and `/healthz`, and nothing
else. The **app host** ([Base
domain and app host](#base-domain-and-app-host)) is the app Worker's: the control panel, sign-in and the management API,
and no client API route, with no zone routes. A path on the wrong host answers `404` with the host that serves it
(`apps/app/src/http/hosts.ts`, `apps/api/src/http/hosts.ts`). The panel's API keys page tells clients the API host
(`GET /me` `api_url`).

- **Self-hosted:** Access covers the app host only; the API host has no Access application and the bypass application
  of the client API paths is not created (an existing one is deleted). Clients that sign in through Access send the app
  application's token (`cloudflared access token -app=https://<app host>`) to the API host in `cf-access-token`. The
  API host's `/mcp` takes API keys (headless MCP clients and scripts), the app host's `/mcp` MCP clients Access signs
  in (ADR 0045).
- **Commissary Cloud:** the Turnstile hostname is the app host, where the sign-in page shows the widget; the OAuth
  callbacks are on the auth host ([Commissary Cloud](#commissary-cloud)), which an API host does not change.
- **Moving to an API host** changes the address of every client: point them at the API host when the deploy finishes
  (their old base URL answers `404`). Unsetting the variable moves everything back to one host. The API host differs
  from the app host and the auth host; it need not be under the base domain.
- Both hostnames must be in zones of the account; `pnpm ci:setup` writes the variable into the environment and extends
  the deploy token to the API host's zone.

## Optional pieces

A self-hosted Commissary needs Workers Paid (Workers Free isn't supported, ADR 0043) and then has every area. Two pieces
depend on an extra binding the deployment chooses (the computer's is a container attached to a Durable Object class,
with a marker variable beside it, since the container itself has no binding in a Worker's `env`). `GET /v9/management/me` reports whether each is present in its
`deployment` object (`browser`, `computer`); the panel decides what to show from it. The browser toolkit's crawl tools
also need an optional API token ([Crawls](#crawls) below); `/me` does not report them, as the toolkit lists its tools.

| Piece                                   | Deploy setting                                                                                                  | Binding                                                                                                                                                           | What its absence removes                                                                                                                                                                                                                                                                               | Cost                                                                                                                                                                                                                                                                                                                                               |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The browser toolkit (ADR 0039, #212)    | `COMMISSARY_BROWSER`: `on` (default) or `off`                                                                   | Browser Run (`browser`, as `BROWSER`) on the `State` and app (`Commissary`) Workers                                                                               | The whole toolkit: it is not on the MCP endpoint, in toolkit lists or in tool grants, and `deployment.browser` is `false`. Nothing else changes                                                                                                                                                        | Browser Run includes 10 browser hours a month on Workers Paid, then $0.09 an hour, on the deployment's Cloudflare account                                                                                                                                                                                                                          |
| The browser's crawl tools (#270)        | `BROWSER_RUN_API_TOKEN` ([Crawls](#crawls))                                                                     | None: an API token, on the `State` Worker                                                                                                                         | `browser_crawl_start`, `browser_crawl_result` and `browser_crawl_cancel`. Nothing else changes                                                                                                                                                                                                         | Browser time, as above                                                                                                                                                                                                                                                                                                                             |
| The sandbox's computer (ADR 0041, #223) | `COMMISSARY_COMPUTER`: `on` or `off` (default); `COMMISSARY_COMPUTER_INSTANCE`: its size (default `standard-1`) | The `Computer` container (`infra/computer/`) attached to the `State` Worker's `SandboxSession` class, and the marker `COMPUTER=on` on the `State` and app Workers | "May use the computer" stays off on the sandbox toolkit (an org admin cannot turn it on, and `sandbox_open` refuses `computer: true`): sandbox sessions run every command with just-bash, and a command it cannot run says the computer is off. `deployment.computer` is `false`. Nothing else changes | Containers' running time on the deployment's Cloudflare account (Workers Paid includes 25 GiB-hours of memory, 375 vCPU-minutes and 200 GB-hours of disk a month, then $0.0000025 per GiB-second, $0.000020 per vCPU-second and $0.00000007 per GB-second); each computer stops after 10 idle minutes. The deploy needs Docker, to build the image |

**The sandbox.** The sandbox toolkit (#222) is not optional: every deployment has it, since it runs on Durable Objects
and Dynamic Workers (the Worker Loader binding), which Workers Paid includes. There is nothing to configure, no account
setup and no API token (Dynamic Workers are in open beta for every Workers Paid account); the deploy binds the loader
and the `SandboxSession` namespace on the `State` Worker. Each session is one Dynamic Worker (Workers Paid includes
1,000 unique Dynamic Workers a month, then $0.002 per Dynamic Worker per day it runs, beside the usual requests and CPU
time) and one Durable Object with its files; both land on the deployment's account, whoever's org used them; an
org reaches the toolkit only once an org admin grants it (there is no default grant), and its sessions have no network
until an org admin sets the toolkit's network ceiling.

**The computer.** With `COMMISSARY_COMPUTER=on` the deploy builds the `Computer` image (`infra/computer/Dockerfile`:
computerd, mise and what mise needs; no runtime preinstalled) with Docker on the deploying machine (CI's runners have it),
pushes it to Cloudflare's registry and attaches it to the `SandboxSession` class as a Durable Object-managed container,
one per sandbox session that uses it; the deploy token needs **Workers Containers Write** (`pnpm ci:setup` grants it). An
org admin then allows it on the sandbox toolkit ("may use the computer", off by default), and a session opened with
`computer: true` runs there whatever just-bash cannot run at all (`node`, `python`, `git`, other binaries; the model
installs runtimes with `mise use node@22`, kept in the session's files). It reaches the network only through the
sandbox's egress point, within the session's network. It is off unless the deployer turns it on: a local deploy reads
`COMMISSARY_COMPUTER=on` (and `COMMISSARY_COMPUTER_INSTANCE`, if not the default) from `.env`; deploying through CI, set
them in `.env` (or `.env.cloud` for the `cloud` stage) and re-run `pnpm ci:setup`, which writes them into the
`production` (or `cloud`) environment, or set the GitHub variables there yourself. This repository's own `prod` and
`cloud` have it on that way (ADR 0043), once `pnpm ci:setup` is re-run with the setting; the code's default, for any
other deployer, stays off. `off`, or unset, deploys no container and needs no Docker. Turning it off later detaches the container; sessions keep their files and run just-bash only. Previews have it
only with the `preview-computer` label. `alchemy dev` never attaches it (it would build and run the image with Docker).
The account's container limits apply: when Cloudflare has no container for a session, its command answers that the
account is at its limit.

**The browser.** Browser Run needs no account setup beyond Workers Paid (on Workers Free it is capped at 10 minutes a day,
too little to be useful) and no API token: the deploy binds it, and the toolkit calls its Quick Actions through the
binding. Commissary Cloud, `prod` and previews keep the default, `on`. A self-hosted Commissary has the toolkit only with
the binding; set `COMMISSARY_BROWSER=off` to deploy without it (no other change). `alchemy dev` never binds it, since
Browser Run's Quick Actions have no local emulation. Browser time lands on the deployment's account, whoever's org used
it; an org reaches the toolkit only once an org admin grants it (there is no default grant).

### Crawls

Browser Run's `/crawl` is on its REST API only, not the binding, so the crawl tools need an API token
(#270); without one the browser toolkit has every other tool and nothing changes. To turn them on:

1. In the Cloudflare dashboard (My Profile or Manage Account, API Tokens), create a custom token with the account
   permission **Browser Run - Edit** (shown as "Browser Rendering - Edit" on older dashboards), for the account the
   deployment runs on.
2. Set it as `BROWSER_RUN_API_TOKEN`: in `.env` for a local deploy, and for CI as a secret of the GitHub environments
   `production` and `cloud` (and `preview`, for previews' crawl tools); `pnpm ci:setup` writes it to `production` and
   `preview` when `.env` sets it, and to `cloud` when `.env.cloud` does. `BROWSER_RUN_ACCOUNT_ID` names the token's
   account if it is not the deploy's own (`CLOUDFLARE_ACCOUNT_ID`, which CI sets); a token without either is refused.
3. Optionally cap the pages of one crawl with `COMMISSARY_CRAWL_MAX_PAGES` (default 1000, at most Browser Run's own
   100000; a GitHub variable for CI, which `pnpm ci:setup` writes like `BROWSER_RUN_ACCOUNT_ID`): a crawl asking for
   more is refused. Each page is browser time on the deployment's account.
4. Deploy: the state Worker gets `BROWSER_RUN_ACCOUNT_ID`, `COMMISSARY_CRAWL_MAX_PAGES` and the token (a secret). With
   `COMMISSARY_BROWSER=off` the token is ignored, with a warning. Remove the secret and deploy again to take the tools
   away.

Crawls run under that account: their browser time lands on it like the Quick Actions'. Browser Run keeps a crawl's
pages 14 days after it ends; Commissary keeps none of them, and forgets which member started a crawl after 21 days.
When a member leaves, or the org is deleted, Commissary asks Browser Run to cancel their crawls that may still be
running, as far as Browser Run answers; a crawl it could not cancel ends by itself at its page limit or after seven
days.

## Commissary Cloud only

What Commissary Cloud has that a self-hosted Commissary doesn't is the list below (ADR 0043). **Nothing else
differs**: the areas, toolkits and settings are the same.

- Sign-up and sign-in through Commissary itself (ADR 0026, ADR 0030). A self-hosted Commissary signs people in through
  Cloudflare Access.
- Plans, billing (Pay as you go through Polar, [Polar](#polar)), ceilings and unbilled orgs (ADR 0042).
- The per-org request rate limit.
- Commissary-owned OAuth apps for catalog toolkits (ADR 0036, #207, [Managed OAuth apps](#managed-oauth-apps)). A
  self-hosted Commissary uses its own apps.
- Suspending people, and owned-org limits.
- Commissary's own OAuth sign-in for MCP clients (#200), with its KV namespace `OAuth`. A self-hosted Commissary signs
  its MCP clients in through Access (ADR 0045).

## Commissary Cloud

Commissary Cloud (ADR 0029; the mode of ADR 0026, `COMMISSARY_MODE=cloud`) has no Access application: people sign in with
GitHub and/or Google (Better Auth), anyone may sign up, and each new person gets a Personal org they own. Platform admins
are the people in `PLATFORM_ADMIN_EMAILS` signed in with that email verified by the provider;
`PLATFORM_ADMIN_SERVICE_TOKENS` and every `ACCESS_*` setting are ignored, and scripts use management keys
([ACCESS.md](ACCESS.md#commissary-cloud)).

Sign-in has a Worker of its own (ADR 0030): **`Auth`** (`apps/auth`), the auth Worker, on the **auth host**
(`COMMISSARY_AUTH_DOMAIN`, by default `auth.<COMMISSARY_DOMAIN>`), with Better Auth's database `SignIn` (D1, schema in
`migrations/sign-in/`), which no other Worker binds. The sign-in page stays on the app host and calls the auth host,
which answers the app host's origin only (CORS) and returns people there; the session cookie is scoped to the base
domain ([Base domain and app host](#base-domain-and-app-host)), so the app host gets it, and the app Worker asks the
auth Worker over a service binding whose session it is. The auth host must be a subdomain of the base domain other
than the app host and the API host (the deploy refuses another one), on a zone of the account. A self-hosted
Commissary has neither the auth Worker nor the `SignIn` database.

| Setting                                                    | Kind        | Meaning                                                                 |
| ---------------------------------------------------------- | ----------- | ----------------------------------------------------------------------- |
| `COMMISSARY_MODE`                                          | variable    | `cloud`; unset or `self-hosted` for a self-hosted Commissary            |
| `COMMISSARY_AUTH_DOMAIN`                                   | variable    | the auth host, under `COMMISSARY_DOMAIN` (default `auth.<base domain>`) |
| `SIGN_IN_GITHUB_CLIENT_ID`, `SIGN_IN_GITHUB_CLIENT_SECRET` | var, secret | a GitHub OAuth app (or GitHub App); offered when both are set           |
| `SIGN_IN_GOOGLE_CLIENT_ID`, `SIGN_IN_GOOGLE_CLIENT_SECRET` | var, secret | a Google OAuth client (web application); offered when both are set      |
| `TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET_KEY`               | var, secret | a Cloudflare Turnstile widget for the app host (required)               |
| `OWNED_ORG_LIMIT`                                          | variable    | orgs a person may own unless a platform admin raises it (default 3)     |
| `ORG_RATE_LIMIT_NAMESPACE_ID`                              | variable    | the Free plan's Workers rate-limit namespace, a positive integer (7201) |
| `ORG_RATE_LIMIT_PAYG_NAMESPACE_ID`                         | variable    | Pay as you go's, another one (default: the Free plan's plus one)        |
| `POLAR_ACCESS_TOKEN`, `POLAR_WEBHOOK_SECRET`               | secret      | Pay as you go through Polar ([Polar](#polar)); optional, with the next  |
| `POLAR_PRODUCT_ID`                                         | variable    | the Pay-as-you-go product in Polar; all three or none                   |

The request-rate ceilings of the client API are per org and per plan: 60 a minute on Free and 600 on Pay as you go
(ADR 0042). They are constants in the code (`packages/billing/src/plan.ts`), not settings, and each plan has a Workers
rate-limiting binding of its own on the API Worker (`FREE_RATE_LIMIT`, `PAYG_RATE_LIMIT`), in the namespace its variable
names. `ORG_RATE_LIMIT` is gone; an environment that still sets it is not affected (the variable is ignored).

At least one provider and the Turnstile keys are required: the deploy refuses a Commissary Cloud stage without them.
`BETTER_AUTH_SECRET` is minted like the `auth_index` key (an Alchemy `Random`, resource `BetterAuthSecret`); nothing to
set. Replacing it signs everyone out.

1. **OAuth apps.** Register the callback `https://<auth host>/api/auth/callback/github` (GitHub) and
   `https://<auth host>/api/auth/callback/google` (Google, "Authorized redirect URIs"). The auth Worker reads the
   verified email and stores no provider token. A GitHub OAuth app takes a single callback host, so use one app per
   hostname; a GitHub App takes up to ten callback URLs and Google any number.
2. **Turnstile.** Create a widget (Cloudflare dashboard, Turnstile) for the app host, managed mode.
3. **Settings.** Put them in `.env` (`.env.example` lists them) for local deploys. For CI, `pnpm ci:setup` writes the
   ones `.env` sets into both GitHub environments (the ids and limits as variables, the client secrets and the
   Turnstile secret as secrets), and `COMMISSARY_MODE=cloud` into `production` when `.env` sets it. Set them by hand in
   the GitHub environments otherwise.
4. **Deploy.** The deploy creates the `SignIn` database and applies its migrations, and the auth Worker on the auth
   host. It also creates the KV namespace `OAuth` of the OAuth server for MCP clients and binds it to the app and API
   Workers (`OAUTH_KV`, with `MCP_OAUTH_ISSUER` = the app host and `MCP_OAUTH_RESOURCE` = `/mcp` on the API host, or on
   the app host without one); nothing to set. A Cloud preview gets none (its MCP clients use API keys). The Platform
   registry and each ControlPlane add their new tables and columns on first use.

**Moving sign-in to the auth host** (the first deploy of a Commissary Cloud stage with the auth Worker): sign-in starts
fresh. The people, sessions and linked accounts Better Auth kept in the usage database (the `auth_*` tables of
`migrations/usage/0008_hosted_auth.sql`) are not moved to `SignIn`: `migrations/usage/0009_drop_hosted_auth.sql` drops
them, so the usage database holds usage records only. Everyone signs in again, and their first sign-in creates their
sign-in account anew, under the same verified email. Orgs, memberships, roles, API
keys, management keys and the Platform registry live in the Durable Objects and stay as they were; a person who
already signed up gets no second Personal org. Register the auth host's callbacks before the deploy, or sign-in fails
until they are.

**Single sign-on.** Orgs set up their own identity providers on the panel ([ACCESS.md](ACCESS.md#single-sign-on-for-an-org));
the deploy needs nothing for it: no setting, binding or D1 migration (the providers and domains live in each org's
ControlPlane and the domain index in the Platform registry, created on first use). The identity providers send people
back to the auth host, whose URLs the org's settings show. The app Worker reaches `cloudflare-dns.com` (domain proof) and
the providers' discovery documents with `fetch`, and the auth Worker the providers themselves.

**Commissary Cloud previews.** A preview with the `cloud-preview` label uses the `preview` environment's sign-in settings and
serves `workers.dev` URLs: its auth Worker's (the `authUrl` output, in the pull request comment) and its app Worker's,
which has the explicit name `commissary-app-<stage>` so the auth Worker knows its origin before it exists
(`infra/preview-origin.ts`). A sign-in completes only after the auth Worker's callbacks are registered with the provider
and the app Worker's hostname is added to the Turnstile widget. Every Worker of the account shares its workers.dev
subdomain, which a preview's session cookie is scoped to; each preview names its cookie apart
(`commissary-<stage>` prefix), so previews keep separate sessions. The prefix only names cookies apart: every
Worker on that subdomain receives every preview's session cookie, so deploy nothing untrusted on the account's
workers.dev subdomain (prod and `cloud` scope theirs to their base domain). Previews share the rate-limit namespaces
with each other, and with production when the environments set the same `ORG_RATE_LIMIT_NAMESPACE_ID` (or
`ORG_RATE_LIMIT_PAYG_NAMESPACE_ID`, one above it unless set): the org `global` exists on every stage under the same id,
so give `preview` its own namespaces.

### Polar

Commissary Cloud bills Pay as you go through [Polar](https://polar.sh), its merchant of record (ADR 0042;
docs/ARCHITECTURE.md "Billing"). Polar is optional for a stage: without its three settings nothing is billed, the
checkout, portal and plan routes and the webhook answer 404, and every org stays on its plan (Free unless set
otherwise); the rest of Commissary Cloud, plan limits included, works as before. A self-hosted Commissary never bills.
The deploy refuses a stage that sets only some of the three.

| Stage                      | Polar                                | Settings from                            |
| -------------------------- | ------------------------------------ | ---------------------------------------- |
| `cloud`                    | production (`api.polar.sh`)          | `.env.cloud`, GitHub environment `cloud` |
| `pr-<n>` (`cloud-preview`) | the sandbox (`sandbox-api.polar.sh`) | `.env`, GitHub environment `preview`     |
| any other Cloud stage      | the sandbox                          | its environment                          |
| `prod`, self-hosted        | none                                 | (ignored)                                |

Set up each Polar organization (production for `cloud`, a sandbox one for previews) once:

1. **Meters.** Three meters, each filtering events by name and summing the `units` metadata property:
   `commissary_requests` (requests and tool calls), `commissary_browser_hours`, `commissary_computer_hours`.
2. **Product.** One recurring (monthly) product, "Pay as you go", with a metered price on each meter at ADR 0042's
   rates and no minimum: $0.000005 per request (that is, $0.50 per 100,000), $0.15 per browser hour, $0.15 per
   computer hour. These must equal `PAYG_RATE_MICROS` (`packages/billing/src/bill.ts`), from which Commissary
   computes the month's bill that the billing cap stops: a Polar price that differs bills orgs past their cap or short
   of it. Commissary sends only the usage above free usage, so the prices have no free tier and no credits
   benefit. Whether Polar accepts a $0 fixed price beside the metered prices is still to be tested in the sandbox;
   until then the product has only the metered prices (to be checked in the sandbox: #274). Its id
   is `POLAR_PRODUCT_ID`.
3. **Access token.** An organization access token with the scopes `customers:read`, `customers:write`,
   `customer_sessions:write`, `checkouts:write`, `events:write`, `subscriptions:write` and `payment_methods:read`
   (whichever of these Polar offers): `POLAR_ACCESS_TOKEN`.
4. **Webhook.** An endpoint at `https://<app host>/webhooks/polar` (a preview's: its app Worker's workers.dev URL,
   in the pull request comment) with the `subscription.*` events (created, active, updated, canceled, uncanceled,
   past_due, revoked); its secret is `POLAR_WEBHOOK_SECRET`, which the deploy binds on the app Worker only (the one
   that takes webhooks). A preview needs its own endpoint in the sandbox.
5. **Customer portal.** Let customers update their payment method and tax ID and see invoices; Commissary sends
   owners there (`POST /billing/portal`).
6. **Settings.** `.env.cloud` (production) and `.env` (sandbox, for previews); `pnpm ci:setup` writes them into the
   GitHub environments (`POLAR_PRODUCT_ID` as a variable, the token and the webhook secret as secrets).

The API Worker's cron (every three hours) sends each org's usage above free usage to Polar; previews have no cron, so
a preview tests checkout, the portal and webhooks but sends no usage. Polar allows 500 requests a minute; the cron
sends at most one batch per 120 ms. Each org is one Polar customer, billed to the owner who first started a checkout,
and Polar requires customers' emails to be unique: one person can be the billing email of one org only.

### Managed OAuth apps

A toolkit added from the toolkit catalog (#207) signs in on Commissary Cloud with Commissary Cloud's own OAuth app with
the service, unless the org gives the toolkit an app of its own (docs/ARCHITECTURE.md, "Toolkit catalog"). Each app is
an entry of `managed_apps` in `packages/tools/src/catalog/additions.json` (client id, endpoints, scopes) naming the
Worker binding that holds its client secret, `TOOLKIT_OAUTH_<NAME>`. Every one is optional: an app whose secret is not
bound is not offered, and its toolkits sign in as on a self-hosted Commissary (the org's app, Commissary's CIMD
document, dynamic registration). A self-hosted stage never uses them, bound or not.

None ships yet, so a deploy binds none and needs nothing. Adding the first one takes, besides its entry: registering the
app with the service (callback `https://<app host>/oauth/toolkits/callback`), its secret in the `cloud` GitHub
environment and `.env.cloud`, and its binding on the `State` Worker only (whose Tools part signs in and refreshes tokens
with it), in its `env` in `alchemy.run.ts` on a Commissary Cloud stage only. The app Worker binds none: it asks the
org's ControlPlane whether a service has an app, for the catalog's views.

The secrets are the one exception to declaring each binding in the Worker's `env.d.ts` and its package's view
(AGENTS.md): their names come from the additions, and the part reads each one by the name its entry gives (a non-empty
string, or the app is not offered). Keep that in mind when looking for a binding in `apps/state/src/env.d.ts`: a
`TOOLKIT_OAUTH_*` one is not there.

### The Commissary Cloud stage

Next to `prod`, which stays self-hosted behind Access, CI deploys Commissary Cloud from `main`: the stage `cloud` (the Commissary Cloud stage), with
its own hostname, Worker, storage and users. The two share nothing but the code: an org, account or API key of one
does not exist on the other. The stage is always Commissary Cloud; the deploy refuses it without `COMMISSARY_MODE=cloud`, so it can
never take the self-hosted Commissary's hostname from `.env`.

Its settings live in `.env.cloud` (copy `.env.cloud.example`), never in `.env`, which keeps the self-hosted Commissary's
and the Commissary Cloud previews'. Set them up once:

1. **Hostnames.** Pick a base domain (`COMMISSARY_DOMAIN`) in a zone of the account, other than `.env`'s, an app host
   under it (`COMMISSARY_APP_DOMAIN`, by default the base domain; [Base domain and app host](#base-domain-and-app-host)),
   and optionally an API host (`COMMISSARY_API_DOMAIN`, [API host](#api-host)).
2. **OAuth apps.** A GitHub OAuth app for its auth host (`auth.<base domain>` unless `COMMISSARY_AUTH_DOMAIN` names
   another subdomain; a GitHub OAuth app takes one callback host, so not the previews' app) with the callback
   `https://<auth host>/api/auth/callback/github`; for Google, add `https://<auth host>/api/auth/callback/google` to
   the client's redirect URIs.
3. **Turnstile.** Add the app host to a widget (or create one) and put its keys in `.env.cloud`.
4. **Rate-limit namespaces.** An `ORG_RATE_LIMIT_NAMESPACE_ID` that the previews' environment does not use; Pay as you go's
   (`ORG_RATE_LIMIT_PAYG_NAMESPACE_ID`) is the next integer unless you set it, so leave that one free as well.
5. **CI.** `pnpm ci:setup` creates the GitHub environment `cloud` (deployments from `main` only) with the settings of
   `.env.cloud`, and extends the deploy token to the zones of its hostnames. Until then the `deploy cloud` job of a push
   to `main` only notes that it is not set up.

The next push to `main` (or a manual run) deploys it and checks it with `tools/check-cloud-deploy.sh`. Whoever signs in with an
email of `PLATFORM_ADMIN_EMAILS` (verified by the provider) is a platform admin. By hand, `pnpm deploy:cloud`
deploys the stage from `.env.cloud` alone (`alchemy deploy --stage cloud --env-file .env.cloud`).

**Switching a stage.** Turning a self-hosted stage into a Commissary Cloud one deletes its Access applications, policies and
service tokens on the next deploy, and scripts with Access service tokens stop working: issue management keys first.
Members keep their orgs and roles, and sign in with a provider account whose verified email is their membership email.
`global`'s auto-join stops admitting anyone (on Commissary Cloud nobody joins `global` by signing in), so add the people
who should stay in it as members first.

## Setup

There are two Alchemy stacks. `commissary` (`alchemy.run.ts`) is Commissary itself, with the stages `prod`, `cloud` and
`pr-<number>`; its Workers' logical IDs are `Commissary` (the app Worker), `Api` (the API Worker) and `State` ([The Workers](#the-workers)). CI's credentials are code: `commissary-github`
(`stacks/github.ts`, stage `ci`) is the second stack, which creates them and writes them into GitHub.
It manages:

- the GitHub environments `production` (deployments from `main` only, no reviewers: a green push deploys) and
  `preview`, and `cloud` (like `production`) when `.env.cloud` exists ([The Commissary Cloud stage](#the-commissary-cloud-stage));
- `commissary-ci-deploy`, an account-owned Cloudflare API token limited to what `alchemy.run.ts` deploys: Workers Scripts,
  Workers KV Storage, D1, Secrets Store (Alchemy's state store), Workers Containers (the sandbox's computer) and Access:
  Apps and Policies (Write), Account Settings (Read), and Zone Read, DNS Write and Workers Routes Write on the zones of the app host, the API host and Commissary
  Cloud's auth host (and of the `cloud` stage's);
- `commissary-ci-check`, the Access service token of the post-deploy check;
- in both environments, the secrets `CLOUDFLARE_API_TOKEN`, `CF_ACCESS_CLIENT_ID`, `CF_ACCESS_CLIENT_SECRET` and the
  variables `CLOUDFLARE_ACCOUNT_ID`, `ACCESS_*` (from `.env`) and `ACCESS_ALLOW_SERVICE_TOKEN_IDS` (the check token's
  ID); in `production` also `COMMISSARY_DOMAIN`, `COMMISSARY_APP_DOMAIN`, `COMMISSARY_API_DOMAIN` and, when `.env`
  turns the computer on, `COMMISSARY_COMPUTER=on` and a `COMMISSARY_COMPUTER_INSTANCE` other than the default
  ([Optional pieces](#optional-pieces)); and Commissary Cloud's settings where `.env` sets them
  ([Commissary Cloud](#commissary-cloud));
- in `cloud`, the secret `CLOUDFLARE_API_TOKEN` and the settings of `.env.cloud`, the computer's included (no Access
  settings or check token).

Raw secrets never leave Alchemy: Cloudflare returns them once, they go to the encrypted state store and are encrypted
again for GitHub.

### 1. An `admin` profile (once)

Creating API tokens needs more than the everyday OAuth login, so the stack deploys with a separate Alchemy profile:

```bash
pnpm exec alchemy profile create admin
pnpm exec alchemy profile edit --profile admin
```

For Cloudflare, use the **Global API Key** (with your email), or an API token with **Account → API Tokens: Write** and
**Account → Access: Service Tokens: Write**. For GitHub, choose `gh` (GitHub CLI, needs repository admin). Treat this
profile like root: use it only for this stack.

### 2. Deploy the CI stack

```bash
pnpm ci:setup
```

It runs `alchemy deploy --config stacks/github.ts --stage ci --profile admin` and prints the outputs. Copy
`checkServiceTokenId` into `ACCESS_ALLOW_SERVICE_TOKEN_IDS` in your local `.env`: a local deploy of `prod` without it
removes the CI token from the production policy and the next CI check fails.

Re-run `pnpm ci:setup` to apply changed permissions or `.env` values. To rotate the deploy token, destroy and redeploy
the stack (`pnpm exec alchemy destroy --config stacks/github.ts --stage ci --profile admin`, then `pnpm ci:setup`).

## Operations

- **Control panel.** CI builds the control panel from `apps/web` (`pnpm build`, into `apps/web/dist/`) before each
  deploy.
- **API keys.** On a stage with one host, the deploy adds, after the API Worker and its zone routes (the bypass depends
  on the API Worker's output, so the client API never leaves Access while a Worker that only reads the Access edge's JWT
  serves it), an Access application with a Bypass policy on the client API paths (`/v1*`, `/v1beta*`, `/v1internal*`,
  `/openai/v1*`, `/backend-api/codex*`, `/chat/completions`, `/completions`, `/responses`,
  `/oauth/toolkits/client.json`; not `/mcp`), so clients reach the
  API Worker with an API key and no Access sign-in; an API host or a preview needs none
  ([ACCESS.md](ACCESS.md#api-keys)). From that deploy on, clients that send Access service token headers to those paths
  are refused: move them to API keys first ([MIGRATION.md](MIGRATION.md#5-move-clients-to-api-keys)).
  `cloudflared access` tokens (`cf-access-token`) keep working in `global` while its `access_clients` setting is on. The
  keys live in each org's ControlPlane (tables created on first use): no migration to run. With your own application
  (`ACCESS_AUD`) the deploy creates no bypass; add one yourself, `/oauth/toolkits/client.json` included.
- **MCP endpoint.** The client API gains `/mcp` (Tools, #197): API keys on the API host (a preview: the API Worker's
  URL), and no binding, secret or migration (upstream sessions live in each org's ControlPlane, a table created on
  first use).
- **Toolkits' OAuth sign-ins** (#202): no binding, secret or migration (apps, registrations and sign-ins live in each
  org's ControlPlane, tables and columns created on first use). Commissary's Client ID Metadata Document is
  `https://<API host>/oauth/toolkits/client.json`, or `https://<app host>/oauth/toolkits/client.json` on a stage with
  one host (a new zone route and bypass path, which the deploy adds; with your own Access application add the path to
  your bypass). The redirect URI to enter in a toolkit's own OAuth app is `https://<app host>/oauth/toolkits/callback`.
  Previews and `alchemy dev` serve no document, so their sign-ins use dynamic registration or an OAuth app. On a
  deployment with an API host, an authorization server that requires the redirect URI on the `client_id`'s origin
  refuses the document: give such toolkits an OAuth app (docs/ARCHITECTURE.md, Tools).
- **MCP clients through Access** (#251, ADR 0045). On a self-hosted stage the app Worker serves the app host's `/mcp`
  (another org's at `/o/<slug>/mcp`) behind Access, for `cloudflared` tokens and service tokens, and
  `tools/check-deploy.sh` checks that the app host's `/mcp` is the app Worker's. **Managed OAuth**, with which MCP
  clients sign their person in by themselves, is a setting, `ACCESS_MANAGED_OAUTH` (and `ACCESS_OAUTH_REDIRECT_URIS`,
  `ACCESS_OAUTH_LOOPBACK_CLIENTS`, [ACCESS.md](ACCESS.md#1-what-the-deploy-creates)), **off by default**: Cloudflare has
  it in open beta, and with it on Access answers every non-browser request to the app host without a sign-in `401`
  (with a `WWW-Authenticate` pointing at its OAuth metadata) instead of redirecting to its login page, which may break
  `cloudflared access login`/`token` for the management API until a stage confirms it does not (#267); browsers and
  service tokens are unaffected. Set it to `true` (in CI: the production environment's `ACCESS_MANAGED_OAUTH` variable; previews do not get it yet) to turn
  it on; the deploy re-applies it after every change of the application like its cookie settings, fails if Cloudflare
  answers with Managed OAuth off, and `tools/check-deploy.sh` then checks that the app host's `/mcp` answers `401`
  with Access's `resource_metadata`. **On a stage with one host** the deploy
  drops the `/mcp*` zone route and takes `/mcp` out of the bypass application (after the API Worker's routes change; in
  between the app Worker, which verifies the Access JWT itself, refuses a request without one), so the app host's
  `/mcp` takes Access sign-ins and service tokens only: an MCP client that used an API key there needs an
  [API host](#api-host), or signs in through Access. Commissary Cloud is unchanged: its app Worker answers `/mcp` `404`,
  and a Cloud stage with one host keeps the `/mcp*` zone route to the API Worker's endpoint for API keys.
  With your own application (`ACCESS_AUD`), see [below](#your-own-access-application-and-mcp-clients).

- **Platform registry and orgs.** The `Platform` Durable Object (the list of orgs, ADR 0021) is a new class that the
  next deploy adds; its tables are created on first use, so there is no migration to run, and the org `global` (slug
  `default`) exists from the start with everything the deployment stored before. The addresses of the
  panel and the management API without an org keep meaning `global`; the panel at `/` then redirects to `/o/default/`
  (see [ACCESS.md](ACCESS.md#platform-admins-and-orgs)).
- **Outbound guard.** Every Worker runs with the `global_fetch_strictly_public` compatibility flag, and a provider's
  `base_url`, a Vertex service account's `token_uri` and a custom `models.catalog` source must be public `https:`
  addresses (ADR 0044, [ARCHITECTURE.md](ARCHITECTURE.md#outbound-guard-coreoutbound)). From the deploy that brings the
  guard, a key group or auth file whose `base_url` is `http:`, an IP literal in a private, loopback, link-local or other
  non-public range, or one of the stage's own hosts stops working: its requests answer `400` "Commissary only reaches
  public HTTPS addresses" and the other providers serve the request. A Vertex credential with such a `token_uri` fails
  its token refresh, and such a catalog source fails the catalog refresh (the stored catalog stays). There is no
  setting to allow it; change the URL (see [MIGRATION.md](MIGRATION.md#1-config)). The deploy sets `OWN_HOSTS`
  (the base, app, API and auth hosts) on the app, API and state Workers from the existing settings: nothing to
  configure.
- **State.** Deploys use the Alchemy state store in the account (`Cloudflare.state()`), shared by CI and local
  machines; `deploy --yes` also upgrades the state store when Alchemy needs a newer version.
- **Concurrency.** One deploy per stage at a time, never cancelled midway; a newer push to `main` waits for the
  running production deploy.
- **Stale previews.** If a destroy fails, rerun the job, or run `pnpm run destroy --stage pr-<number>` locally.
- **`auth_index` key.** `AUTH_INDEX_KEY` (the HMAC key of the credential handle `auth_index`,
  `packages/models/src/management/auth-index.ts`) is an Alchemy `Random` in `alchemy.run.ts`: minted on a stage's first deploy, kept in
  the (encrypted) state store and bound as a secret of both Workers on every deploy. No GitHub secret or manual step is needed.
  `alchemy dev` uses a fixed key (`DEV_AUTH_INDEX_KEY`), the tests the one in `apps/app/vitest.config.ts`. A Worker with Access
  configured refuses that dev key and any key shorter than 64 characters, and logs the refusal: management calls that
  need an index fail (500), while serving requests keeps working (its request log lines then carry no `authIndex`).
- **Secrets key.** Every org's stored secrets (auth files and config entries, see ARCHITECTURE.md _Stored secrets_) are
  encrypted with the org's data key, which is stored wrapped by the stage's `SECRETS_KEY`. Like the `auth_index` key it
  is an Alchemy `Random` in `alchemy.run.ts` (resource `SecretsKey`, one per generation), minted on the stage's first
  deploy and bound as a secret of the state Worker, the only one that reads it; no GitHub secret or manual step is needed. `alchemy dev` uses
  `DEV_SECRETS_KEY`, the tests the keys in `apps/app/vitest.config.ts`; a Worker with Access configured refuses that dev key and
  any key shorter than 64 characters. Without a working key no ControlPlane starts: model traffic and management calls of
  every org fail (500) and the Worker logs `the ControlPlane cannot open the org's data key` with the reason, until a
  deploy binds the right key. **Losing the key loses every stored secret**: do not destroy the stage's state or its
  `SecretsKey` resource while the stage is in use.
- **Back up `SECRETS_KEY`.** Losing it loses every secret of every org on the stage (provider keys and logins,
  config entries, private key groups, the SSO secret, toolkit sign-ins, browser profiles, webhook secrets; every sealed
  secret in [THREAT-MODEL.md](THREAT-MODEL.md)): an org's data key opens only through it, and no one, Cloudflare
  and Commissary's maintainers included, can recover it. Alchemy keeps it in the stage's state store, as the
  `SecretsKey` resource (`SecretsKey2`, … after a rotation), in the Cloudflare account (`Cloudflare.state()`), or in
  `.alchemy/` with `ALCHEMY_STATE=local`; Cloudflare does not show a Worker's secrets again, so the Worker's binding is
  not a copy. Keep a copy somewhere you control and apart from the account, such as a password manager: read it with
  `pnpm exec alchemy state read commissary/<stage>/SecretsKey` from the repository root, with the stage's deploy
  environment (add `--env-file .env.cloud` for Commissary Cloud, prefix `ALCHEMY_STATE=local` for local state;
  `pnpm exec alchemy state list commissary/<stage>` shows the `SecretsKey…` paths). It prints the resource's record as
  JSON: the key is the `attr.text.__redacted__` field (64 hex characters). Store the value of every generation still
  in use. Take the copy after each rotation too, and treat it like the key itself:
  whoever holds it and a copy of the stored data can unseal every org's secrets.
- **A self-hosted Commissary has no rate limits or caps.** Nothing bounds a member's usage except what you set: within
  their grants, a member can run up the Cloudflare bill of the account that runs Commissary (Workers, Durable Objects,
  Containers, Browser Run) and the provider bills behind the credentials. Set **spend limits** on members, keys and
  shared agents, and grant only what each member needs ([THREAT-MODEL.md](THREAT-MODEL.md#running-up-costs-and-exhausting-resources);
  ADR 0041). Commissary Cloud's plan limits, billing cap and request-rate ceiling do not exist on a
  self-hosted deployment.
- **What the operator is trusted with.** Whoever runs a Commissary (you, on a self-hosted one) is fully trusted: they
  hold `SECRETS_KEY`, which unwraps every org's data key, so they can unseal every org's secrets, and they can read
  content (transcripts, sandbox files) that is not sealed. A self-hosted Commissary that serves several orgs
  (ADR 0021) gives its orgs no protection from you, and Cloudflare account access is access to all of it. The threat
  model lists this and the other accepted risks ([THREAT-MODEL.md](THREAT-MODEL.md#accepted-risks)); report a
  vulnerability as [SECURITY.md](../SECURITY.md) says.
- **First deploy with encryption.** Each org's ControlPlane encrypts what it stored in plain text on its first start
  after the deploy (a Durable Object SQLite migration, in one transaction; there is no D1 migration) and logs
  `created the org's data key and sealed its stored secrets`. **There is no rollback after that start**: an earlier
  version reads the sealed values as broken JSON. To go back, deploy a fix forward.
- **Rotating the secrets key.** Set `SECRETS_KEY_GENERATION` to the next number (it starts at 1) and
  `SECRETS_KEY_PREVIOUS_GENERATION` to the current one, in `.env` and as GitHub variables for CI, then deploy: the
  deploy mints the new key and binds the old one as `SECRETS_KEY_PREVIOUS`. Each ControlPlane, on its next start, wraps
  its data key under the new key (`wrapped the org's data key under the new SECRETS_KEY`); nothing else is encrypted
  again. Keep the previous generation set until every org has started (the cron trigger, every 3 hours, runs
  per-org tasks on every org's ControlPlane, so one full cron run after the deploy is enough), then unset
  `SECRETS_KEY_PREVIOUS_GENERATION` and deploy again. An org that had not started by then fails until the previous
  generation is set again. Every generation up to `SECRETS_KEY_GENERATION` stays declared in the stack (`SecretsKey`,
  `SecretsKey2`, …), so an old key is never deleted: **never lower `SECRETS_KEY_GENERATION`**, which would delete the
  newer keys from the state and, with them, every secret they protect. With `ALCHEMY_STATE=local` the keys sit in plain
  text under `.alchemy/`, like the `auth_index` key below.
- **`auth_index` values change once.** Indexes are computed on read, never stored, so the first deploy with the keyed
  index (or a new key: destroying a stage, replacing its `AuthIndexKey` resource, or a state entry that fails to
  decrypt, after which the next deploy mints a new key) changes every `auth_index` at once. With
  `ALCHEMY_STATE=local` the key sits in plain text under `.alchemy/` on that machine: protect that directory like the
  key itself, and expect a new key (and new indexes) when it is deleted or another machine deploys with its own local
  state. Nothing stored needs migrating, but bookmarked panel links `/accounts/<auth_index>`, `/usage?account=…`
  addresses and `auth_index` values saved by usage collectors from earlier exports stop matching; open the account
  from the Accounts page again. Clients that filtered usage with `auth_id` must switch to `auth_index` (the old
  parameter answers 400).

### Your own Access application and MCP clients

With `ACCESS_AUD` the deploy changes nothing in Access. The app host's `/mcp` takes `cloudflared` tokens and service
tokens as it is. For MCP clients to sign in there through Managed OAuth (why it is off by default: [above](#operations)):

1. In the Cloudflare dashboard, **Zero Trust** > **Access controls** > **Applications**, edit your application for the
   app host, open **Advanced settings** and turn on **Managed OAuth**.
2. Under its settings, add the redirect URIs of your hosted clients to **Allowed redirect URIs**
   (`https://claude.ai/api/mcp/auth_callback`, `https://www.cursor.com/agents/mcp/oauth/callback`, the stack's
   defaults), and turn on **Allow localhost clients** and **Allow loopback clients** for clients on people's machines
   (Claude Code, Codex, Cursor's desktop app, pi). Keep the **Access token lifetime** short (the default 15 minutes).
   Save. (API: `PUT /accounts/<account>/access/apps/<app>` with the whole application and
   `oauth_configuration: {enabled: true, dynamic_client_registration: {enabled: true, allowed_uris: [...],
   allow_any_on_localhost: true, allow_any_on_loopback: true}}`.)
3. On a stage with one host, remove `/mcp` from your bypass application of the client API paths, if you added it for
   #197: the app host's `/mcp` must stay behind Access. The deploy already dropped the `/mcp*` zone route.

`ACCESS_MANAGED_OAUTH`, `ACCESS_OAUTH_REDIRECT_URIS` and `ACCESS_OAUTH_LOOPBACK_CLIENTS` are refused with `ACCESS_AUD`:
set them on your application instead.

## Cutover to the Commissary stacks

The rename to Commissary (issue #122) changes every deployed and stored name: the stacks (`commissary`,
`commissary-github`), the Worker's logical ID (`Commissary`), the Commissary Cloud stage (`cloud`, settings in
`.env.cloud`), the settings (`COMMISSARY_*`, `COMMISSARY_MODE=self-hosted|cloud`), the preview label
(`cloud-preview`), the key prefixes (`cms_` for API keys, `cmsm_` for management keys), the ControlPlane tables and the
secrets-key salt. Nothing migrates: every stage starts fresh with empty storage, old keys stop working, and the old
stacks are destroyed first. A person with the `admin` profile runs it (issue #123):

1. **Save what you will re-create**, from `main` before the merge: each org's Go config (`GET /v9/management/export`),
   its members, teams, grants, spend limits and SSO settings, and the OAuth credentials to log in to again.
2. **Destroy the old stacks**, still on the code before the rename: let every open pull request with a live preview
   close, then `pnpm run destroy --stage prod`, `pnpm run destroy --stage hosted --env-file .env.hosted` and the CI stack
   (`pnpm exec alchemy destroy --config stacks/github.ts --stage ci --profile admin`). The old and new CI stacks manage
   the same GitHub environments and secrets, so the old one goes before `pnpm ci:setup` runs from the new code.
3. **Bring up the new stacks**: rename `.env.hosted` to `.env.cloud` and the settings to their `COMMISSARY_*` names
   (`.env.example`, `.env.cloud.example`), rename the label (`gh label edit hosted-preview --name cloud-preview`), run
   `pnpm ci:setup` (environments `production`, `preview` and `cloud`), then merge: CI deploys `prod` and `cloud`.
4. **Re-create and reconnect**: sign in, re-create the orgs and import their configs, log in to the OAuth credentials
   again, mint new API keys and management keys, and update every client.
