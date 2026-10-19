# Cloudflare Access setup

Cloudflare Access signs people in for the control panel and the management API (ADR 0022): it authenticates the caller
(identity provider login or a service token), then forwards the request with a signed `Cf-Access-Jwt-Assertion` header
that the Worker verifies. The Worker never sees their passwords. Clients of the client API (`/v1*`, `/openai/v1*`,
`/backend-api/codex*` and the unprefixed aliases) are not behind Access: they send an **API key** Commissary issued to a
member, which the Worker checks itself (§4, "API keys" below, [CLIENTS.md](CLIENTS.md)). Scripts on the management API
may send a **management key** instead of an Access service token ("Management keys" below).

This is a self-hosted Commissary, the default. **Commissary Cloud** (`COMMISSARY_MODE=cloud`, ADR 0026) has no Access application
and signs people in itself: see [Commissary Cloud](#commissary-cloud) at the end.

## 1. What the deploy creates

`pnpm run deploy` (`alchemy.run.ts`, `infra/access.ts`) provisions Access together with the Worker, from the
settings in `.env` (template: `.env.example`):

| Setting                                                  | Creates / sets                                                                                                                        |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `COMMISSARY_APP_DOMAIN`, by default `COMMISSARY_DOMAIN`  | A **self-hosted application** on the app host (empty path: the whole hostname), and the app Worker's custom domain                    |
| `COMMISSARY_API_DOMAIN` (optional)                       | The API Worker's custom domain, the API host, which serves the client API and has no Access application (below)                       |
| (without `COMMISSARY_API_DOMAIN`)                        | Zone routes of the client API paths to the API Worker, and a second application on them with a **Bypass** policy for everyone (below) |
| `ACCESS_ALLOW_EMAILS`, `ACCESS_ALLOW_EMAIL_DOMAINS`      | A reusable **Allow** policy (interactive login with your identity providers)                                                          |
| `ACCESS_SERVICE_TOKENS` (names)                          | One **service token** per name and a **Service Auth** policy that admits exactly those tokens                                         |
| `ACCESS_ALLOW_SERVICE_TOKEN_IDS`                         | Adds service tokens managed elsewhere (by token ID, e.g. CI's) to the **Service Auth** policy                                         |
| `ACCESS_SESSION_DURATION`                                | Session duration of the application (default `24h`)                                                                                   |
| `ACCESS_SERVICE_TOKEN_HEADER`                            | Optional single-header service tokens (section 5)                                                                                     |
| `ACCESS_TEAM_DOMAIN`                                     | Worker variable (issuer and JWKS host); your Zero Trust team name                                                                     |
| `PLATFORM_ADMIN_EMAILS`, `PLATFORM_ADMIN_SERVICE_TOKENS` | Worker variables: platform admins (token names from `ACCESS_SERVICE_TOKENS` are replaced by their Client IDs)                         |

The application's **AUD tag** is passed to the Worker as `ACCESS_AUD` automatically. The deploy also sets the application's
cookie to **SameSite=Lax** and **HTTP Only**, so the `CF_Authorization` session cookie is not sent with cross-site
subrequests (the first line of defence against cross-site request forgery on the panel; see "Browser sessions" below). The
Alchemy application resource does not manage these fields and its updates are PUT-style, so a follow-up step re-applies them
after every change of the application: do not edit them in the dashboard.

**The client API leaves Access.** The client API is the API Worker's (ADR 0030), which no Access application protects; the app
Worker serves everything else (the panel, the management API, the OAuth callbacks), each with a `404` naming where the
other's paths are (`apps/app/src/http/hosts.ts`, `apps/api/src/http/hosts.ts`). With an API host
(`COMMISSARY_API_DOMAIN`, ADR 0028) the API Worker answers there, and no Access application covers that hostname. A
client that signs in through Access sends the token of the app host's application (`cloudflared access token
-app=https://<app host>`) in `cf-access-token` to the API host; the API Worker checks it against `ACCESS_AUD`
itself. Without an API host, zone routes send the client API paths of the app host to the API Worker, and the
bypass application (`infra/access.ts` `provisionClientApiBypass`) covers `/v1`, `/v1beta`, `/v1internal`, `/openai/v1`,
`/backend-api/codex`, `/chat/completions`, `/completions` and `/responses` with their sub-paths. Access applies the most
specific application to a request, so these paths reach the API Worker without a sign-in while every other path stays
behind the main application. The API Worker is then the only gate of the client API: it answers `401` to a request
without a valid API key (§4).

The production Workers have no `workers.dev` or preview URLs, so the custom domains are the only way in. Pull-request
preview stages (`pr-<number>`, see [DEPLOY.md](DEPLOY.md)) instead serve their app Worker's `workers.dev` URL behind
their own application, which the app Worker enrolls into, and their API Worker on its own `workers.dev` URL, outside
Access, with no bypass application. Service token credentials:

- The Client IDs are printed in the deploy outputs (`serviceTokens`).
- The Client Secrets are returned by Cloudflare only on creation; the deploy writes them to
  `.alchemy/access-service-tokens.json` (mode 0600, git-ignored) as ready-to-use header pairs on the deploying
  machine. They are also kept in the Alchemy state (encrypted at rest in the Cloudflare state store; plain JSON under
  `.alchemy/state` with `ALCHEMY_STATE=local`). Copy them into your clients, then delete the file if you like.
- Tokens are valid for one year. Rotate one by deleting its name from `ACCESS_SERVICE_TOKENS`, deploying, and adding it back
  (or add a new name first for a seamless switch). Use one token per client/machine so usage records (`principal`) and
  revocation are per client.

**Bring your own application.** Set `ACCESS_AUD` to the AUD tag(s) of an Access application you manage yourself (dashboard
or other tooling) and the deploy creates no Access resources; `ACCESS_ALLOW_*`/`ACCESS_SERVICE_TOKENS` must then be empty.
The application must cover the Worker's whole hostname, with an Allow policy for people and a Service Auth policy for tokens
(an Allow policy does not match service tokens). Set SameSite=Lax on its cookie yourself, and add the bypass application for
the client API paths above (a self-hosted application on `<host>/v1`, `<host>/v1beta`, ... with a Bypass policy that includes
everyone); without it clients need Access in front of their API key.

## 2. Policies

| Who                                 | Policy action    | Selector                   | Notes                                                  |
| ----------------------------------- | ---------------- | -------------------------- | ------------------------------------------------------ |
| People using the panel / browsers   | **Allow**        | Emails, email domain       | Interactive login                                      |
| Management automation (scripts, CI) | **Service Auth** | The stack's service tokens | Non-interactive; an Allow policy does not match tokens |
| Clients of the client API           | **Bypass**       | Everyone                   | The Worker checks their API key instead                |

Need IdP groups, device posture or other rules? Extend the policies in `infra/access.ts` (Alchemy's
`Cloudflare.Access.Policy` accepts every Cloudflare rule shape).

## 3. Worker variables

Set by the deploy from the settings above (Alchemy binds them as plain-text variables):

| Variable                        | Meaning                                                                                               |
| ------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `ACCESS_TEAM_DOMAIN`            | `myteam`, `myteam.cloudflareaccess.com` or `https://myteam.cloudflareaccess.com` (issuer + JWKS host) |
| `ACCESS_AUD`                    | AUD tag(s) of the application(s), comma separated                                                     |
| `PLATFORM_ADMIN_EMAILS`         | Platform admins: manage every org and create orgs (comma/space separated, case-insensitive)           |
| `PLATFORM_ADMIN_SERVICE_TOKENS` | Service token **Client IDs** that are platform admins (the full `….access` id)                        |
| `ACCESS_DEV_BYPASS`             | Set only by `alchemy dev` (local development); empty on deployed Workers                              |
| `AUTH_INDEX_KEY`                | Secret (`secret_text`) HMAC key of `auth_index`: minted by the deploy, not a setting (below)          |

Empty `ACCESS_TEAM_DOMAIN` or `ACCESS_AUD` fails closed: protected routes answer 500. Past Access, what a principal may do
depends on its role in the org it reaches ("Members, roles and teams" below): a principal with no role there gets 403.

### Platform admins and orgs

The deployment serves one or more **orgs** (ADR 0021). The Platform registry (a Durable Object) lists them; the first, `global`,
exists from the start with the slug `default` and holds everything the deployment stored before orgs existed. Each org has a
**slug** (1-63 lowercase letters, digits and inner hyphens) that addresses it:

| What              | Address                                                                   |
| ----------------- | ------------------------------------------------------------------------- |
| Panel of an org   | `/o/<slug>/` (`/o/<slug>/accounts`, `/keys`, `/models`, ...)              |
| Management API    | `/v9/management/orgs/<slug>/<route>` (every route below `/v9/management`) |
| Org list, create  | `GET`/`POST /v9/management/orgs`                                          |
| Rename an org     | `PATCH /v9/management/orgs/<slug>` (name and/or slug)                     |
| Who am I, my orgs | `GET /v9/management/me`                                                   |
| Delete my account | `DELETE /v9/management/me` with `{"email": "<your email>"}`               |
| The org itself    | `GET`/`PATCH`/`DELETE /v9/management/orgs/<slug>/org`, `.../export`       |

A **platform admin** (`PLATFORM_ADMIN_*`) manages every org through these addresses and is the only one who may list, create and
rename orgs: anyone else gets `403 {"error":"platform_admin_required"}`. An org the registry does not list answers `404` to a
platform admin and `403` to anyone else. The unscoped addresses (`/v9/management/credentials`, `/accounts`, ...) keep working
and mean `global`, so existing scripts and bookmarks are unchanged. `/` opens the panel of the only org the caller belongs to
and asks which one to open when there are several (`/?choose` always asks, to create an org). A person's login and API keys
are unaffected: clients reach their org with their key, not with the address.

A rename of an org's slug breaks the old address, not the org's data (stored under its permanent id).

### Members, roles and teams

Everyone else reaches an org as one of its **members** (ADR 0022). A member holds one **role** in the org: **org owner**,
**org admin** or **plain member**; a person can be a member of several orgs with a role in each. A platform admin is an org
owner of every org without being stored as a member. Members, teams and service tokens live in the org's ControlPlane, which
the Worker asks on every request: a removed member, or a member whose role was lowered, is refused on their next request.

| Who may                                                                                        |   Plain member    | Org admin |          Org owner           | Platform admin |
| ---------------------------------------------------------------------------------------------- | :---------------: | :-------: | :--------------------------: | :------------: |
| Use the client API endpoints of the org                                                        |         ✓         |     ✓     |              ✓               |       ✓        |
| Open the org's panel; read usage (`GET /observability/usage/records`, `/summary`, `/series`)   | own requests only |     ✓     |              ✓               |       ✓        |
| Connect, list, disable and remove their **own private** accounts and provider keys (see below) |  ✓ where allowed  |     ✓     |              ✓               |       ✓        |
| Every other management route of the org (credentials, keys, models, settings, prices, ...)     |                   |     ✓     |              ✓               |       ✓        |
| List members, teams and service tokens; manage teams                                           |                   |     ✓     |              ✓               |       ✓        |
| Add or remove plain members; register or remove member service tokens                          |                   |     ✓     |              ✓               |       ✓        |
| Add or remove org admins and owners; change any role                                           |                   |           |              ✓               |       ✓        |
| Read the org's single sign-on settings (Commissary Cloud, `/sso`)                              |                   |     ✓     |              ✓               |       ✓        |
| Change single sign-on: identity provider, domains, requiring it (not with a management key)    |                   |           |              ✓               |       ✓        |
| Read the models they may use (`GET /models/mine`, the panel's My models)                       |         ✓         |     ✓     |              ✓               |       ✓        |
| Read, add, edit and remove grants (`/grants`, the panel's Grants page)                         |                   |     ✓     |              ✓               |       ✓        |
| Read the Spend limits that bind them and limit their own API keys (`/spend`, `/spend/limits`)  |         ✓         |     ✓     |              ✓               |       ✓        |
| Set any Spend limit and the org's calendar (`/spend/limits`, `/spend/settings`)                |                   |     ✓     |              ✓               |       ✓        |
| Read the org's plan and this month's usage against free usage (Commissary Cloud, `/billing`)   |                   |     ✓     |              ✓               |       ✓        |
| Create API keys for themselves; list and revoke their own (`/api-keys`)                        |         ✓         |     ✓     |              ✓               | if a member ¹  |
| List and revoke every API key of the org                                                       |                   |     ✓     |              ✓               |       ✓        |
| Turn auto-join, or Access sign-ins for clients in `global`, on or off (`PATCH /membership`)    |                   |           |              ✓               |       ✓        |
| Allow or stop private credentials (`PATCH /membership`, `private_credentials`)                 |                   |     ✓     |              ✓               |       ✓        |
| Give a service token a role above plain member; download a credential                          |                   |           | owner **service token** only |       ✓        |
| List, create and rename orgs                                                                   |                   |           |                              |       ✓        |
| Read the org and its retention period (`GET /org`)                                             |                   |     ✓     |              ✓               |       ✓        |
| Set the usage retention period (`PATCH /org`); download the org's export (`GET /export`)       |                   |     ✓     |              ✓               |       ✓        |
| Delete the org (`DELETE /org`, retyping its name; people only)                                 |                   |           |              ✓               |       ✓        |
| Delete their own account (`DELETE /me`)                                                        |  ✓ (people only)  |     ✓     |              ✓               |       ✓        |

¹ API keys are issued to members: a platform admin who is not a member of the org, or a service token, gets
`403 member_required` when creating one.

- **Grants** (ADR 0023): a member uses a shared credential only through a grant (a member, a team or everyone; one
  account, every account of a provider or all of them; model patterns). Access is the union of the grants that name the
  member; there is no deny. Every org starts with the grant "everyone, all
  shared credentials, every model": delete it and add narrower ones to restrict. A model a member has no grant for answers
  `400 model_not_found`, like an unknown model, and is left out of their model lists; a request without a member (a service
  token) is served by the grants for everyone only. Private credentials are never granted: they are their owner's alone.
- **Spend limits** (ADR 0024): an org admin caps what a member, a team, the org, a shared credential or an API key may spend
  (API-equivalent Cost) in a day, week or month of the org's time zone (the Limits page). A plain member sees the limits that
  bind them and may cap their own API keys, never above a limit an org admin set on that key (`422
  exceeds_admin_limit`); `PATCH /spend/settings` is for org admins. A request that meets a limit with no room is refused
  with `429 spend_limit_reached` and `Retry-After` until the period ends; no account is put in cooldown. A member,
  team or org limit does not count what a member's **private** accounts serve (and does not stop them), an API key's limit
  counts everything the key does. An org starts with no limits, `global` included.
- **Adding a member** (`POST /members` with an email and a role) takes effect the next time the person signs in through Access;
  no email is sent, and Access must still admit them (§2). Removing a member takes them off every team, and they are refused
  from their next request on, even where auto-join is on: a person or service token an org admin removed does not join by
  themselves again until an org admin adds (or registers) them back.
- **Auto-join** (`GET`/`PATCH /membership`, `{"auto_join": true}`): with it on, a person Access admits who is not a member of
  the org joins it as a plain member on their first request. It is on for `global`, so a self-hosted deployment keeps admitting
  everyone its Access policies admit, and off for every new org, where only added members get in (`403` for anyone else, the
  client API endpoints included).
- **Shared and private credentials** (ADR 0023): every account and provider key belongs to the org (**shared**, managed by org admins,
  as before) or to one member (**private**). A private credential is used only for its owner's requests, never for an org
  admin's, another member's or a service token's. Its owner manages it through the same routes as an org admin manages a shared
  one (`/credentials*`, `/oauth/*`, `/provider-keys*`; what a plain member creates is always private); an org admin sees that it
  exists (provider, owner, label, whether it is disabled) in `GET /credentials` and `GET /provider-keys` (`others`), may disable
  or remove it, and reaches nothing else about it: no models, quota, usage or file, and `404` for any other operation. Its
  download is refused to everyone but its owner (`403 private_credential`, also for an owner service token). Private traffic
  is left out of org-wide usage summaries, series, listings and exports; only the owner reads it. `private_credentials` of
  `/membership` is the org setting: on for `global` and for a new org only when `POST /orgs` asks; turning it off disables
  every private credential of the org (kept, not deleted) and refuses new ones (`403`) until it is turned on again. Everything
  that existed before is shared.
- **Service tokens** (`/service-tokens`) are registered to one org by their Client ID with a role (`409 service_token_taken`
  when another org has the token, also when two orgs register it at once: the one the registry indexes first keeps it). With
  auto-join on, an unregistered token is admitted as a plain member without being stored,
  so existing clients of `global` keep working; register it to give it a role.
- **Teams** (`/teams`) are named groups of members within an org; an org admin filters usage by member (`member=<id>`) or team
  (`team=<id>`) and groups a summary by member (`group_by=member`).
- An org with members keeps at least one owner: lowering or removing the last owner answers `409 last_owner`.
- **ADR 0006 per org**: giving a service token a role above plain member, and downloading a credential (§4), need a service
  token that is an owner of the org, or a platform admin. A person's browser session is the credential most exposed to theft
  and cannot grant itself those powers: a person who is an org owner registers only plain-member tokens
  (`403 service_token_owner_required` otherwise).

### API keys

An **API key** (ADR 0022) is how a client authenticates on the client API: `cms_<org id>_<key id>_<secret>`, with 288
random bits of secret. Any member creates keys for themselves in the panel (**API keys**) or with
`POST /v9/management/api-keys {"name": "laptop", "expires_at": "<ISO time, optional>"}`; the answer carries the whole
key once (`key`), and the org's ControlPlane stores only its SHA-256, a visible prefix (`cms_<org id>_<key id>_<4
characters>`), its member, its name and when it was created, last used (to the minute) and expires.

- A key names its org by the org's permanent id, so the Worker asks that org's ControlPlane and no other (after the Platform
  registry confirms that the org exists). The presented key's hash is compared with the stored one in
  constant time.
- A request with a key acts as the key's member in the key's org, with their role there: usage records store the key
  (`principal` `key:<key id>`) and the member (`member_id`), and the caller scope of session state is the member's, so one
  member's tools share it. A key is never a platform admin.
- `GET /api-keys` lists the caller's keys (an org admin's: every key of the org, with `member_email`); `DELETE
  /api-keys/<id>` revokes one (`404 api_key_not_found` for another member's key unless an org admin asks). A revoked
  key is **deleted** (the answer still says when it was revoked), and a revoked key may keep working for up to 30 seconds
  (each isolate of each Worker trusts a verified key for at most 30 seconds, and never past its expiry; revocation does
  not clear those caches). An expired key is deleted too: by the next listing or new key of the org, by a request that
  presents it, and by a scheduled sweep for an org nobody opens. Removing a member deletes their keys (which may keep working for up to 30 seconds), private
  accounts, private provider key groups and unfinished sign-ins (ADR 0027). A member holds at most 100 keys; revoking or
  waiting out one frees its place.
- API keys are never accepted on the management API or the panel: those stay behind Access.

### Management keys

A **management key** (ADR 0026) is how a script calls the management API without a person's session:
`cmsm_<org id>_<key id>_<secret>`, sent as `Authorization: Bearer cmsm_…`. Org admins issue them in the panel (**Management
keys**) or with `POST /v9/management/orgs/<slug>/management-keys {"name": "ci", "role": "admin"}`;
the answer carries the whole key once, and the org's ControlPlane stores only its SHA-256 and a visible prefix. `GET`
lists the org's keys and `DELETE /management-keys/<id>` revokes one (only a caller holding at least the key's role
revokes it, `403 role_too_high` otherwise).

- A key acts in its own org only, with its role there (no higher than its issuer's), and is never a platform admin. An
  unscoped management URL means the key's org; another org's URL answers 403.
- It never holds the sensitive powers: it cannot download a credential (`403 download_requires_service_token`), register
  or re-role a service token, or issue a management key (`403 management_key_forbidden`).
- It is accepted on the management API only; client API routes take API keys, and a `cms_` key is never accepted on the
  management API. Revocation applies at once in the isolate that revoked it and within 30 seconds everywhere.
- On a self-hosted Commissary the request must still pass Access, whose application covers the management API: send the
  key together with a service token, or put the management paths a script calls behind your own Access policy. On a
  Commissary Cloud nothing sits in front of the Worker.

**Access sign-ins for clients** (`GET`/`PATCH /membership`, `{"access_clients": true}`): clients set up before API keys
signed in through Access on the client API. While this org setting is on, a client API route still takes an Access JWT,
which the Worker verifies itself from `Cf-Access-Jwt-Assertion` or from the `cf-access-token` header `cloudflared access`
sends (Access no longer adds the former there); the sign-in is admitted like on the management API. An Access sign-in
names no org, so on a client API route it always reaches `global`: the setting exists there only (on by default, so an
upgraded deployment's `cloudflared` clients keep working), `GET /membership` of another org has no `access_clients`, and
setting it there answers `422 access_clients_global_only`. Every other org takes API keys only. An API key always wins: a request with a key is judged by the key alone. Moving clients:
[MIGRATION.md](MIGRATION.md#5-move-clients-to-api-keys).

**Platform admins in `global`.** The first time `global` is used, the emails in `PLATFORM_ADMIN_EMAILS` become org owners of
it, so a platform admin has a member id there (API keys, private credentials) without adding themselves. Taking an email out
of `PLATFORM_ADMIN_EMAILS` later ends its platform admin rights but not its `global` membership, which an org owner removes
on the Members page (`DELETE /members/<id>`).

`ACCESS_DEV_BYPASS` only applies to requests whose host is `localhost`, `127.0.0.1` or `[::1]`, and is refused (with a logged
warning) whenever `ACCESS_TEAM_DOMAIN` or `ACCESS_AUD` is set: a Worker wired to Access never skips it.

`AUTH_INDEX_KEY` is the one secret binding: 32 random bytes each stage mints on its first deploy and keeps in the Alchemy
state, so there is nothing to set (management security below, [DEPLOY.md](DEPLOY.md) "Operations"). Like the dev bypass,
a Worker with `ACCESS_TEAM_DOMAIN` or `ACCESS_AUD` set refuses the fixed `alchemy dev` key and any key shorter than 64
characters; a missing key is refused everywhere.

## 4. How the Worker validates requests

1. The path is classified (`apps/app/src/management/zones.ts`): `/v1*` (incl. `/v1beta`, `/v1internal`), `/openai/v1*`, `/backend-api/codex*` and the unprefixed
   aliases `/chat/completions`, `/completions`, `/responses` are the client API and need a
   principal; `/v9/management*` (also `/v9/management/orgs/<slug>/...`), the control panel (`/`, `/accounts`, `/keys`, `/models`, `/usage`, `/members`, `/api-keys`, `/limits`, `/settings` with their
   sub-paths, the same pages under `/o/<slug>/`, `/assets/*`) and `/management.html` (the upstream panel's old address, a redirect to `/`) form the management zone;
   everything else (`/healthz`, the OAuth browser callbacks `/anthropic/callback`, `/codex/callback`,
   `/antigravity/callback`, `/callback`, `/devin/callback`) is public to the Worker.
   Matching is case-, slash- and percent-encoding-insensitive, so odd spellings cannot dodge the gate.
2. On a client API route, an API key wins (`packages/auth/src/api-key.ts`): the first credential starting with `cms_` in
   `Authorization: Bearer`, `x-goog-api-key`, `x-api-key`, `?key=` or `?auth_token=` (the Go server's order) is checked
   against its org's ControlPlane ("API keys" above), and the request runs as its member in its org. A malformed, unknown,
   wrong, revoked or expired key answers 401 `Invalid API key`, whatever else the request carries. Without a key, the
   client API route takes an Access JWT (from `Cf-Access-Jwt-Assertion` or `cf-access-token`) only while the org's `access_clients`
   setting is on; other credentials (a dummy provider key) are ignored.
3. `Cf-Access-Jwt-Assertion` is verified with `jose`: RS256 signature against the JWKS at
   `https://<team>.cloudflareaccess.com/cdn-cgi/access/certs` (cached per isolate, refetched on an unknown `kid` at most every
   30 s), `iss` = the team domain, `aud` contains one of `ACCESS_AUD`, `exp` required and `exp`/`nbf` valid (30 s clock skew).
4. The principal is the `email` claim (users) or `common_name` (service token Client ID). It is recorded in usage records and
   scopes session state per caller.
5. The org's ControlPlane admits the principal (`packages/auth/src/admission.ts`, auto-joining it where that is on) and the route's
   policy (`apps/app/src/management/policy.ts`) names the role it needs: a member role for the client API endpoints, the org's panel pages and the
   usage reads, org admin for every other management route. Who the caller is (`/v9/management/me`), the org list
   (`/v9/management/orgs*`, whose handlers ask for a platform admin), the panel pages without an org, `/assets/*` and
   `/management.html` need no role. A principal without the role gets 403 `Forbidden`.
6. A missing header answers 401 `Missing API key`; an invalid token 401 `Invalid API key` (Go wording, so existing clients
   show familiar errors). On a client API route of an org that takes API keys only, an Access sign-in alone answers 401
   `Missing API key` too (`Invalid API key` when another credential came with it).

Outside the client API the Worker trusts only the signed JWT, so requests that skip Access (e.g. a `workers.dev` URL enabled
by hand) are rejected.

### Browser sessions (CSRF and WebSocket hijacking)

Browsers attach the Access session cookie automatically, so without further checks a page on another site could drive an
admin's session. Before authentication the gate (`packages/auth/src/csrf.ts`) refuses, with 403 `Cross-site request rejected`:

- state-changing requests (anything but `GET`/`HEAD`/`OPTIONS`) to `/v1*`, `/openai/v1*`, `/backend-api/codex*`, the
  unprefixed `/chat/completions`, `/completions`, `/responses` and the
  management zone when `Sec-Fetch-Site` is `cross-site`/`same-site` or `Origin` names another host;
- any management request (`/v9/management*`, the panel paths) with a foreign `Origin` or a cross-site `Sec-Fetch-Site`,
  except a top-level document navigation (`GET`/`HEAD` with `Sec-Fetch-Mode: navigate` and `Sec-Fetch-Dest: document`)
  to a panel page (`/`, `/accounts`, `/keys`, `/models`, `/usage`, `/members`, `/api-keys`, `/limits`, `/settings` and their sub-paths) or
  `/management.html`: a link to a panel page still opens it, while frames (clickjacking), `/assets/*` and every
  `/v9/management*` request are refused (OAuth providers redirect to the public callback paths, never there);
- WebSocket upgrades (`GET /v1/responses`, `/backend-api/codex/responses`) whose `Origin` is not the Worker's own host
  (403 `Cross-origin WebSocket rejected`).

Management writes must also carry `Content-Type: application/json` (`multipart/form-data` for `POST /credentials`,
`application/yaml`/`text/yaml` for `POST /settings/import`) or have no body; other types answer 415. The management zone never sends
CORS headers, so other origins cannot pass a preflight or read a management response. Client API routes keep
`Access-Control-Allow-Origin: *` for reads.

Non-browser clients (curl, SDKs, Claude Code, Codex) send neither `Origin` nor `Sec-Fetch-*` and are not affected; the panel
is served by the Worker itself and is same-origin. Browser applications on other origins cannot call the client API's POST routes;
put a server-side client in between.

### Management API security

- Go's `POST /requests/api-call` (substitutes `$TOKEN$` into a request to any host the caller names, the upstream
  panel's quota probe) is not ported. Quota checks (`POST /credentials/quota`) call the auth file's own provider usage
  endpoint. Key tests (`POST /provider-keys/probe`) send a config key to the `base-url` stored with it, and an admin can
  change that `base-url` while keeping the key (`PUT /provider-keys/groups`, or a config import): an org admin can still direct a stored key to a host of their choice, and a plain member the same for their own private key groups
  (only their own key can be sent there). The replies carry no
  token.
- No route reads a secret back. Provider keys, API keys, header values and URL credentials are stored as config
  entries (ADR 0025) and never leave the Worker: `GET /provider-keys` shows a `[redacted]…abcd` preview, `GET /settings` carries
  no secret, and the routes that returned the whole document (`/config*`, `/config.yaml`, `/settings/config`) and the raw
  editor are gone. So there are no masked placeholders to restore and nothing to refuse on write. A secret is replaced by
  typing a new one into its key group, or by importing a Go config document (`POST /settings/import`). Config error messages
  never quote a written value (YAML errors are a fixed sentence per error code with line and column; schema errors an
  expectation and a path) and are not scrubbed: they name at most keys the caller wrote, so a refused write reads the same
  whether a typed value, key or alias name equals a stored secret or not.
- Credential downloads (`GET /v9/management/credentials/download?name=<file>`) are the one way to read a stored token:
  the auth file verbatim, refresh token included, for moving an account to another deployment. Only a **service
  token** that is an owner of the org (§3 "Members, roles and teams") or a platform admin may call it; any other org admin or
  owner, and every management key, gets `403 {"error":"download_requires_service_token","message":…}` before the file is
  looked up, and a plain member the gate's `403 Forbidden`. Commissary Cloud has no service tokens: there only platform
  admins download (`403 download_requires_platform_admin` for everyone else, a private credential's owner included). A person's browser session is the credential most
  exposed to theft, so the tokens are handed only to a client that was set up for automation (curl with
  `CF-Access-Client-Id`/`-Secret`, [MIGRATION.md](MIGRATION.md) §2). The panel never calls it. A private credential is downloaded
  by its owner alone (their own session may, it is their own token); any other caller gets `403 private_credential`. This narrows who can read a
  token; it does not make tokens unreachable to an email admin, who can still point a stored key at a host of their
  choice (above). Treat org admin access as access to every stored token: keep the org's admins few and prefer service tokens scoped to automation.
- No response publishes a hash of a stored key. The handle of a credential (`auth_index`, also in panel URLs
  `/accounts/<auth_index>` and usage exports) is an HMAC under the per-deployment secret `AUTH_INDEX_KEY`, so it reveals
  nothing about the key (Go's unsalted index of a config key's id, itself an unsalted hash of the key, let anyone holding
  it test guesses offline). Config credential ids (`claude:apikey:<hash>`) are never sent: not in `GET /provider-keys`, usage
  summaries and series (`group_by=auth` keys are `auth_index` values), `routing/models` or client API responses, whose
  `X-CPA-TRACE-ID` is a random request id for every client. Lookups by `name` match auth files only, so a guessed id is
  not confirmed either; address a config key by its `auth_index`.
- Writes never confirm a guessed secret: the reply does not confirm a guess, the next read does. A typed provider key
  equal to a key stored in another group of its family (gemini, interactions, vertex: the families whose keys are unique
  across groups) is answered like any other new key: `PUT /provider-keys/groups` drops the typed copy silently and still
  advances the version. The same goes for header values, a `proxy-url` or a `base-url` written for a key kept by
  `auth_index`: they are typed too, so trying them never produces a different reply. The stored key always wins, so a typed
  copy never deletes a stored key (or its group); a group left with no key is stored but not shown. The config import
  replaces every entry, so its reply confirms nothing and Go's first-wins deduplication applies inside the imported
  document. A key whose secret a stored key of its family has keeps that key's credential id, so the next read shows the
  same `auth_index` (the next read confirms, as above); a wrong guess has replaced every stored key with the document's. Configuration error messages never quote a value.

### Zero data retention (ADR 0027)

Commissary keeps as little as it can and deletes at once; there is no grace period, no soft delete and no restore.

- **Usage records** keep an upstream failure's status, type and code but not its body, and are pruned after the org's
  **retention period** (`usage_retention_days`, in days; `null` keeps them). A new org starts at 90 days; `global` keeps records until an org admin sets a period. The cron
  task `usage-retention` applies each org's period.
- **Removing a member** (`DELETE /members/<id>`) deletes their API keys, private accounts and provider key groups, the
  OAuth logins they started in that org, and their Spend limits and counters and those of their API keys.
- **API keys** are deleted when revoked and when they expire (an expired key is purged when keys are listed or created,
  when one is checked, and by the cron task `api-key-expiry`); a deleted key's Spend limits and counters go with it.
- **Deleting an org** (`DELETE /org` with `{"name": "<the org's name>"}`; a person who is an org owner or a platform admin, never a service
  token: `403 person_required`) removes its usage
  records, replay state, cached keys, credentials, config, members, API keys and registry entry and frees the
  slug (its API keys may keep working for up to 30 seconds). `global` is never deleted. A big org may answer `503 deletion_incomplete`: send the request again. Download the
  export first (`GET /export`: settings, shared config, price overrides, credential summaries, grants, members, teams and
  service tokens, every secret as a preview; usage records come from the usage routes).
- **Deleting an account** (`DELETE /me` with the caller's own email; people only) removes the person from every org with
  their data there, deletes the orgs they were the only member of, and keeps no removal note, so the address can start
  over. It is refused with `409 sole_owner` (and the org slugs) while they are the only owner of an org with other members:
  hand it over first. On a self-hosted Commissary Access signs the person in again on their next request, which creates a new,
  empty membership. On Commissary Cloud the sign-in account goes too (Better Auth's user, its sessions and its linked
  GitHub/Google accounts): the person is signed out at once, and signing in again is a new sign-up with a new Personal org.
- **Replay state** that thinking and continuity depend on stays, bounded by its expiry of at most seven days; stale state of
  a deleted org that was not registered expires on its own within that time.

### Logs and personal data

Every proxied request produces one structured log line (Workers Logs) whose `principal` field is the caller:
`key:<key id>` for an API key, `mkey:<key id>` for a management key, `user:<email>` for people, `service:<client id>` for
service tokens. Usage records in D1 store the same id. Emails are
personal data: restrict who can read Workers Logs and the D1 database, and set the retention you need (each org's usage
retention period, `PATCH /org` with `usage_retention_days`, and Workers Logs retention). Tokens, API keys, provider keys, JWTs, request bodies, headers and query strings are never
logged; scheduled-job failures are logged as a one-line summary with URL queries removed.

## 5. Optional: single-header service token

Some tools can only send one custom header. Access can read the service token from a header of your choice, as a JSON value.
Set `ACCESS_SERVICE_TOKEN_HEADER` (e.g. `x-api-key`) and deploy; the deploy sets the application's
`read_service_tokens_from_header`. Clients then send:

```
x-api-key: {"cf-access-client-id": "<CLIENT_ID>", "cf-access-client-secret": "<CLIENT_SECRET>"}
```

This is handled entirely by Access; the Worker still only sees the resulting JWT. It applies where Access sits, so to the
management API, not to the client API (clients send an API key there). The header name is your choice
(`Authorization` is the Cloudflare docs' example, but then the client's own bearer token cannot carry anything else); `x-api-key`
suits the Anthropic SDK, where the key is that header. The two-header form keeps working alongside it. If your organisation
enables _strict service token authentication_, only Service Auth policies authorise token requests. With a bring-your-own
application (`ACCESS_AUD`), configure the setting on that application with the Cloudflare API.

## 6. WARP note

The panel and the management API need the Access JWT regardless of how the client reaches the hostname. A WARP-enrolled
device still passes through Access; satisfy it with an Allow policy that matches the user's identity (or device posture)
or, for scripts, use a service token, which does not depend on the device. Clients of Commissary send an API key and are not
affected. Check the Cloudflare WARP/Access docs for the current options.

## Commissary Cloud

Commissary Cloud (`COMMISSARY_MODE=cloud`, ADR 0026; deploy settings in [DEPLOY.md](DEPLOY.md#commissary-cloud)) has no Access
application. Everything in §1-§2 and the service tokens of §3 do not apply; members, roles, teams, grants, API keys and
management keys work as above. What changes:

- **Sign-in.** People sign in at `/sign-in` with GitHub or Google (Better Auth, in the auth Worker on the auth host,
  `auth.<base domain>` by default, ADR 0030, ADR 0031), behind a Cloudflare Turnstile challenge (a token solved on
  another hostname is refused). The auth Worker keeps the verified email and a session in its own D1 database
  (`SignIn`), never the provider's tokens; the session cookie is scoped to the base domain (`COMMISSARY_DOMAIN`), so the
  app host under it receives it and asks the auth Worker whose it is (every other host under the base domain receives it
  too); Better Auth's session cookie is `HttpOnly` and `SameSite=Lax` (and `Secure` over HTTPS). The panel signs out
  with **Sign out** in the shell's account menu. Without a session the management API answers `401 Not signed in` and a
  panel page redirects to `/sign-in?next=<page>`.
- **Who is who.** The signed-in email is the principal, like Access's `email` claim, so a member invited by email signs
  in with a provider account whose verified email matches. Access JWTs and Access service tokens are accepted nowhere.
  Platform admins are the emails in `PLATFORM_ADMIN_EMAILS`; `PLATFORM_ADMIN_SERVICE_TOKENS` means nothing.
- **Sign-up.** Anyone may sign up. A person signing in for the first time who is not a member anywhere gets a Personal
  org they own; an invited person gets none. Nobody joins `global` by signing in, even where its
  auto-join is still on from a self-hosted past.
- **Owning orgs.** Everyone signed in may create orgs and owns the ones they create, up to `OWNED_ORG_LIMIT` (default
  3; platform admins have no limit). A platform admin raises one person's limit with `PATCH /v9/management/people/<email>
  {"org_limit": 10}` (`null` restores the default), or on the panel's **People** page.
- **Suspension.** A platform admin suspends a person (`PATCH /people/<email> {"suspended": true}`) or an org (`PATCH
  /v9/management/orgs/<slug> {"suspended": true}`, or the org chooser). A suspended person is signed out and their
  sessions, API keys and management keys are refused; in a suspended org every member, API key and management key
  is, except platform admins, who lift it. A suspension applies at once in the isolate that made it and within 30
  seconds everywhere.
- **Rate limit.** Each org's requests on the client API are counted by a Workers rate limit keyed by org, one per plan:
  60 a minute on Free and 600 on Pay as you go (constants, ADR 0042; the org's plan picks the binding). Past it requests
  answer `429` with `Retry-After: 60`. The management API has none.
- **Plans and free usage** (ADR 0042). Every org holds a plan, `free` (every org starts on it) or `payg`, and gets the same
  free usage each calendar month (UTC) on either: 25,000 requests and tool calls, 1 browser hour, no computer hours.
  Each request to a model counts once when Commissary makes its first upstream attempt for it, whatever credential
  serves it and however it ends. Token counting, video status polls and requests refused before any work
  (authentication, the rate ceiling, a spend limit, a plan limit, an unknown model, no credential) do not count. A plan
  change reaches every isolate within 30 seconds (per-isolate caches, like suspension). A Free org
  over its free usage is refused with `429 plan_limit_reached` and `Retry-After` until the first of the next month UTC;
  work in flight finishes. `GET /billing` (org admins) answers the plan and the month's usage against free usage; on a
  self-hosted Commissary there are no plans and it answers 404. Switching plans, the billing cap and invoices come with
  Polar (#237, #238).
- **Scripts** use management keys; credential downloads are for platform admins only (§4 "Management API security").
- **Browser protections.** The cross-site checks of §4 apply unchanged, Better Auth checks the origin of its own
  requests, and the sign-in routes (`/api/auth/*`, `/api/sign-in-options`, `/sign-in`) exist only on Commissary Cloud.

### Single sign-on for an org

On Commissary Cloud an org can sign its people in with its own identity provider (OIDC or SAML), on the panel's
**Single sign-on** page or under `/v9/management/orgs/<slug>/sso`. Org admins see the settings; only the org owner
changes them. A self-hosted Commissary has none of this: Access is where its identity providers are configured.

1. **Prove a domain.** The owner adds an email domain (`example.com`); Commissary shows a TXT record to publish:
   `_commissary-challenge.example.com` holding `commissary-domain-verification=<token>`. **Verify** looks it up
   through Cloudflare's DNS over HTTPS resolver. Only that exact domain is proved (a subdomain is a domain of its own),
   and one org holds a domain at a time: another org can verify it once the first removes it.
2. **Set the identity provider.** One per org:
   - **OIDC**: the issuer URL, and a client registered there with the redirect URI the page shows
     (`https://<host>/api/auth/sso/callback/sso-<org id>`), its client id and secret. Commissary reads the issuer's
     discovery document when the provider is saved; the secret is sealed with the org's data key and never shown
     again (leave it blank to keep it). Sign-in uses PKCE and asks for `openid email profile`.
   - **SAML**: the identity provider's sign-in URL (HTTP-Redirect binding), its entity id and its signing
     certificate (PEM). Register Commissary as a service provider with the entity id, assertion consumer service URL
     (HTTP-POST) and metadata URL the page shows. Assertions must be signed, answer a request Commissary made, and are
     accepted once.

   **Test** asks the identity provider again (discovery document and signing keys, or the certificate's validity) without
   signing anyone in.

3. **Sign in.** On `/sign-in` a person enters their work email; when an org verified its domain and set an identity provider,
   the browser goes to that provider. The email the identity provider returns must be at one of the org's verified domains. A
   person signing in this way becomes a `member` of the org (no Personal org), unless an org admin removed them: they
   are refused (`sso_removed`) until an admin adds them again.
4. **Require single sign-on** (per verified domain, with an identity provider set). GitHub and Google are then refused for
   emails of that domain (`sso_required`), and every session of a person at the domain ends at once, so everyone signs
   in again through the identity provider. The identity provider cannot be removed while a domain requires it.

## Troubleshooting

| Symptom                                | Cause                                                                                                    |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| 302 to `cloudflareaccess.com` in a CLI | Service token headers missing/wrong, or no Service Auth policy for the token                             |
| 403 from Access (before the Worker)    | Token not in the Service Auth policy (name missing from `ACCESS_SERVICE_TOKENS`)                         |
| 500 `Authentication service error`     | `ACCESS_TEAM_DOMAIN` wrong (check the team name) or `ACCESS_AUD` empty                                   |
| 401 `Missing API key`                  | No API key (client API routes), or the request reached the Worker without Access (management)            |
| 401 `Invalid API key`                  | Wrong, revoked or expired API key; AUD/issuer mismatch, expired JWT                                      |
| 401 with a working `cloudflared` token | `global` takes API keys only (`access_clients` off): create an API key                                   |
| 403 `member_required`                  | API keys are issued to members of the org: add yourself as a member                                      |
| 403 `Forbidden`                        | No role in the org (add the member, or turn auto-join on), or a plain member on a route for org admins   |
| 403 `owner_required`                   | Adding or removing an org admin or owner, changing a role, or changing single sign-on needs an org owner |
| 403 `service_token_owner_required`     | A service token role above member needs an owner service token of the org, or a platform admin           |
| 409 `last_owner`                       | The change would leave an org with members but no owner: make someone else an owner first                |
| 403 `platform_admin_required`          | Listing, creating or renaming orgs needs a platform admin                                                |
| 404 on `/o/<slug>/...`                 | No org has that slug (a platform admin sees 404; others 403)                                             |
| 403 `private_credential`               | Download of a member's private credential by anyone but its owner                                        |
| 403 `private_credentials_unavailable`  | Adding a private provider key group where the org does not let members hold private credentials          |
| 403 `download_requires_service_token`  | Credential download called by a person: use a service token that is an owner of the org                  |
| 403 `Cross-site request rejected`      | Browser request from another origin (or a client API POST from a web app)                                |
| 415 `Unsupported Content-Type`         | Management write without `content-type: application/json` (or YAML/multipart)                            |
| 422 `record_not_found`                 | Single sign-on: the domain's TXT record is not published yet (or not visible to DNS yet): retry later    |
| 409 `domain_taken`                     | Single sign-on: another org verified the domain; it must remove it first                                 |
| `/sign-in?error=sso_required`          | The person's domain requires single sign-on: sign in with the work email instead of GitHub or Google     |
| `/sign-in?error=sso_removed`           | An org admin removed the person from the org that holds their domain: an admin adds them again           |
