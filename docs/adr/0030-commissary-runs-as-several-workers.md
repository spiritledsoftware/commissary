---
status: partly superseded by ADR-0031, amended below (#227: the agent runs' Durable Object lives in the API Worker)
---

# Commissary runs as several Workers

Commissary runs as several Workers declared in the one root Alchemy stack, with the same stages as before:

- The **app Worker** serves the control panel and the management API on the app host (ADR 0028). It is today's `Commissary` Worker under the same logical id, so it keeps the domain.
- The **API Worker** serves the client API on the API host. With no API host, zone routes send the client API paths on the app host to it, in front of the app Worker. It also runs the crons.
- The **auth Worker**, on Commissary Cloud only, holds all of Better Auth (ADR 0026): sign-in with GitHub and Google, Turnstile, single sign-on, issuing and verifying sessions. It answers on its own auth host, `auth.<app host>` by default (`COMMISSARY_AUTH_DOMAIN`; the deploy refuses a host outside the app host), and its session cookie is scoped to the app host. ADR 0031 moved both to the base domain: the auth host is under it and the cookie is scoped to it. The sign-in page stays on the app host and calls the auth host. The app Worker asks it who a session belongs to over an RPC service binding. `BETTER_AUTH_SECRET` and the sign-in secrets live only there. Better Auth's tables are in a D1 database bound only by the auth Worker, decided in [#130](https://github.com/spiritledsoftware/commissary/issues/130).
- The **state Worker** has no routes. It defines the Durable Objects (`ControlPlane`, `SessionState` and `Platform`), and the other Workers bind them by `scriptName`. Deploying a Worker restarts the Durable Objects it defines, and Alchemy re-uploads a Worker only when its bundle changes, so the Durable Objects restart only when their own code changes, not on every client API or panel change. ControlPlane's refresh alarm runs here.

The API Worker never sees sessions: it resolves its principal locally from API keys, management keys and Access tokens. Self-hosted Commissary deploys the app, API and state Workers; Access signs people in (ADR 0022).

The reasons are independent deploys, a smaller blast radius, and sign-in secrets (`BETTER_AUTH_SECRET`, the GitHub and Google secrets, Turnstile) held by one Worker. Separate CPU budgets are a bonus. The detailed decisions are in the resolutions of [#127](https://github.com/spiritledsoftware/commissary/issues/127) (which Workers), [#128](https://github.com/spiritledsoftware/commissary/issues/128) (where the Durable Objects live) and [#133](https://github.com/spiritledsoftware/commissary/issues/133) (deploys, previews and checks; it replaced #127's path routes for the auth Worker, which cannot work on `workers.dev` previews).

This replaces ADR 0028's statement that one Worker answers on both hostnames. Its host split stands.

## Considered Options

- One Worker, as today. Simplest, but every change restarts the Durable Objects and every secret is reachable from all the code.
- The auth Worker authenticating every request, so clients pass through it. One place for authentication, but a hop on every client API request.
- The auth Worker owning identity storage. It would split ControlPlane's state, against ADR 0007 (superseded, but its reason holds in ADR 0021): people, orgs and standing stay in the ControlPlanes.
- One Worker per area (models, tools, browser, agents). Areas share authentication, orgs and members, and the split would cost more than it isolates; area code is separate packages instead.
- The Durable Objects in the API Worker (every translator or executor change restarts ControlPlane), in the app Worker (panel changes restart the client API's state), or SessionState alone in the API Worker (two host Workers to keep in sync).

## Consequences

- One `alchemy deploy` per stage deploys in dependency order: the state Worker, then the auth Worker, then the app and API Workers.
- State RPC changes are expand-then-contract: add a method or field, switch the callers, remove the old one a release later. Callers retry once when a code update resets a Durable Object. The auth Worker's RPC is expand-then-contract too.
- Prod and cloud move their existing Durable Objects from the `Commissary` Worker to the state Worker with Alchemy's `transferredFrom`, on the first split deploy; self-hosters transfer when they upgrade, and previews start fresh. The move is rehearsed by hand on a throwaway stage before the split merges.
- Each `pr-<n>` preview deploys several Workers, each with its own `workers.dev` URL (the state Worker has none).
- Only the app Worker sits under Access. The API Worker never does.
- Each app's test Worker re-exports its handler plus the composed Durable Objects from `apps/state`, so tests run in one isolate with no auxiliary Workers. Behaviour across Workers is checked by the smokes: on self-hosted, creating, using and revoking an API key; on Cloud, `/api/auth/ok` and an anonymous panel request turned away through the RPC (#135).
- Service-binding and RPC calls cost no extra request but count toward the subrequest limits (50 per request on the Free plan) and the cap of 32 invocations per request. Self-hosted Commissary has no service-binding hop; the app-to-auth hop is Cloud-only.
- Self-hosted Commissary now runs three Workers, which count against the account's Worker limit and share the daily request quota.
- Commissary Cloud's people sign in once more after the move, because the session cookie and Better Auth's tables are new.

## Amendment: the agent runs' Durable Object lives in the API Worker

Hosted agents' runs (#227, ADR 0040) are one Durable Object each, `AgentRun`, and it is defined by the API Worker, not the state Worker. A run reaches models through the client API and tools through the MCP endpoint, so its object must call the API Worker. From the state Worker that would take a service binding to the API Worker, which already binds the state Worker's Durable Objects: each Worker would need the other to exist first, and no fresh stage (every `pr-<n>` preview, a new self-hosted deployment) could deploy. In the API Worker, a run calls the client API through the Worker's own loopback entrypoint (`ctx.exports`), a named entrypoint that the internet cannot reach and no Worker of the deployment binds. The trust boundary for the run's principal is therefore the Cloudflare account, as for the Durable Objects (any Worker deployed to the account could bind the entrypoint); within the deployment, the run's object keeps the gateway out of its RPC methods and takes a start only for the run its name says it is, and the principal is always resolved from the org's ControlPlane.

- The app Worker binds `AGENT_RUN` by the API Worker's `scriptName`, so on every stage the API Worker deploys before the app Worker: the state Worker, then the API Worker, then the auth Worker, then the app Worker.
- Deploying the API Worker restarts the runs' objects, and every merge deploys it. A run resumes from its storage: a finished tool call is never made again, but a model call that was cut off is made again.
