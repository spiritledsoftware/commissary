# Commissary

**One service through which an org reaches models, tools, a browser and hosted agents.** Today its Models area is the
most complete: it pools your Claude, ChatGPT/Codex, Gemini/Vertex, Antigravity, xAI, Kimi and other accounts and
provider keys behind one endpoint that speaks the OpenAI, Anthropic and Gemini APIs, with clients on API keys and a
built-in control panel behind Cloudflare Access. Tools (among them the hosted browser and sandbox) and Agents share the
same org, API key and control panel.

Commissary comes in two forms: a **self-hosted Commissary**, which you deploy to your own Cloudflare account and whose
people sign in through Cloudflare Access (this README), and **Commissary Cloud**, the paid service run for anyone, with
sign-up and personal orgs ([DEPLOY.md](docs/DEPLOY.md#commissary-cloud); [what only Cloud has](docs/DEPLOY.md#commissary-cloud-only)). A member's clients send an **API key**; the
secrets Commissary holds for outside services are **credentials**, and a model provider's secret is a **provider key**.

- **One endpoint, every client.** Claude Code, Codex CLI, the OpenAI/Anthropic/Gemini SDKs and anything else that
  speaks those APIs (the client API); requests are translated between protocols, so Claude Code can run on a GPT model
  and vice versa.
- **Use the subscriptions you already pay for.** Log in with OAuth (Claude, Codex, Antigravity, xAI, Kimi, Devin, …) or
  add provider keys; credentials rotate round-robin with cooldowns on rate limits and automatic token refresh.
- **Nothing to run.** Three Workers (the app Worker for the panel and the management API, the API Worker for the client API, and the state Worker that holds the Durable Objects), KV and D1. No servers, no containers, and it scales to zero.
- **Zero-trust by default.** People sign in to the control panel and management API through Cloudflare Access with
  your identity provider; tools send an API key each member creates in the panel, stored only as a hash and
  revocable (a revoked key stops working within 30 seconds); scripts use management keys or Access service tokens. The Worker stores no client passwords.
- **Or run it for others.** With `COMMISSARY_MODE=cloud` Commissary signs people in itself with GitHub or Google (an auth Worker on its own auth host), anyone
  may sign up and gets a Personal org, and platform admins limit and suspend people and orgs: this is Commissary Cloud
  ([DEPLOY.md](docs/DEPLOY.md#commissary-cloud)).
- **Control panel.** Connect accounts, manage provider keys, watch quotas and usage, shape model routing and edit the
  config at `/`.
- **Infrastructure as code.** The Worker, storage, Access application, policies and service tokens are declared in
  [`alchemy.run.ts`](alchemy.run.ts) and deployed with one command.

```text
 Claude Code / Codex / SDKs ──────(API key)──────► Commissary Worker ──► Claude, OpenAI, Gemini, xAI, …
 Browser (control panel) ──► Cloudflare Access ──►  (translate, pick an    (your OAuth logins and
                            (your IdP + tokens)      account, refresh)      provider keys)
```

## Contents

- [Deploy](#deploy)
- [Connect a client](#connect-a-client)
- [Configuration](#configuration)
- [Updating and removing](#updating-and-removing)
- [Troubleshooting](#troubleshooting)
- [Provider support](#provider-support)
- [Known limitations](#known-limitations)
- [Local development](#local-development)
- [Documentation](#documentation)
- [Security](#security)
- [Acknowledgements](#acknowledgements)

## Deploy

### Prerequisites

- A Cloudflare account on the **Workers Paid** plan, which is required: Workers Free isn't supported (requests may use
  up to 300 s of CPU; see `COMMISSARY_CPU_MS`).
- A domain (zone) in that account. Commissary gets its own hostname on it, e.g. `llm.example.com`.
- **Zero Trust** enabled on the account, with an identity provider (the built-in one-time PIN works). Note your team
  name: `<team>.cloudflareaccess.com`.
- Node.js 22+ and pnpm 12 (the version pinned in `package.json` `devEngines`).
- Optional, and possibly billed extra by Cloudflare: the browser toolkit and the sandbox's computer. Without them
  everything else works; see [Optional pieces](docs/DEPLOY.md#optional-pieces).

### 1. Clone and install

```bash
git clone https://github.com/spiritledsoftware/commissary.git
cd commissary
pnpm install
```

`pnpm install` also clones the upstream Go server into `.repos/` (a read-only reference for development; the deploy
does not use it).

### 2. Log in to Cloudflare

```bash
pnpm exec alchemy profile edit --add Cloudflare
```

Choose browser OAuth or paste an API token. The profile is stored in `~/.alchemy/profiles.json`.

### 3. Configure

```bash
cp .env.example .env
```

Fill in at least these (`.env` is git-ignored; shell variables override it):

| Variable                                          | Example           | Purpose                                                                                                           |
| ------------------------------------------------- | ----------------- | ----------------------------------------------------------------------------------------------------------------- |
| `COMMISSARY_DOMAIN`                               | `llm.example.com` | Hostname (base domain) of Commissary; its zone must be in the account                                             |
| `ACCESS_TEAM_DOMAIN`                              | `myteam`          | Your Zero Trust team name                                                                                         |
| `ACCESS_ALLOW_EMAILS` / `_EMAIL_DOMAINS`          | `you@example.com` | Who may sign in through the browser                                                                               |
| `ACCESS_SERVICE_TOKENS`                           | `laptop,ci`       | One Access service token is created per name, for scripts that use the management API                             |
| `PLATFORM_ADMIN_EMAILS` / `_ADMIN_SERVICE_TOKENS` | `you@example.com` | Platform admins: who may open the control panel and management API, and create orgs (emails, service token names) |

Every other setting is optional; see [Configuration](#configuration). The Worker needs **no provider secrets** in
`.env`: accounts and provider keys are added later through the control panel and stored in a Durable Object.

### 4. Build and deploy

```bash
pnpm build                      # build the control panel into apps/web/dist/
pnpm run deploy --stage prod    # shows the plan, asks for confirmation, deploys
```

The first deploy asks to bootstrap Alchemy's state store (a small Worker and Secrets Store in your account that keeps
the deploy state, shared by every machine that deploys; set `ALCHEMY_STATE=local` to keep it in `.alchemy/` instead).
Use the same `--stage` for every later deploy (`pnpm plan --stage prod` previews changes).

The deploy prints the URL, the Access AUD tag and each service token's Client ID. Cloudflare returns the Client
Secrets only once: they are written to `.alchemy/access-service-tokens.json` (mode 0600) on the deploying machine.

### 5. Verify

```bash
export CF_ACCESS_CLIENT_ID='<id>.access'          # from .alchemy/access-service-tokens.json
export CF_ACCESS_CLIENT_SECRET='<secret>'

curl https://llm.example.com/healthz \
  -H "CF-Access-Client-Id: $CF_ACCESS_CLIENT_ID" -H "CF-Access-Client-Secret: $CF_ACCESS_CLIENT_SECRET"
# {"status":"ok"}
```

### 6. Add accounts

Open `https://llm.example.com/` and sign in through Access with an admin email. Then:

- **Connect account** (top bar) logs in to Claude, Codex, Antigravity, xAI, Kimi, … or uploads existing auth files;
- **Provider keys** adds (Claude, OpenAI-compatible upstreams, Gemini, Vertex, OpenCode Zen/Go, TypeSafe and SubQ for
  System One models, …);
- **API keys** creates the key your clients send (shown once: copy it).

Commissary refuses no credential: any provider key or account can be connected, as a shared or a private
credential ([ADR 0034](docs/adr/0034-commissary-refuses-no-credential.md)). Providers' terms vary: most bar, or don't
address, use through a gateway or hosted service, and they forbid sharing a subscription. The panel warns when you
connect such an account and when it becomes a shared credential, and never blocks it. Use is at your org's own risk.
Claude is the sharpest case: Anthropic's Usage Policy (effective 2026-11-12) bars "resell, proxy, or otherwise provide
access to Claude through unauthorized means, including services that route requests through consumer subscriptions or
misrepresent the product or client being used", and Commissary's cloaking of requests on a Claude account as Claude
Code's own (fully by default, or minimally with Settings › Providers › Claude cloak level,
`upstream.claude.cloak-level: minimal`) misrepresents the client. Details:
[ARCHITECTURE.md](docs/ARCHITECTURE.md#claude-provider-modelsexecutorclaude-translationtranslatorclaude).

Coming from the Go CLIProxyAPI server? [MIGRATION.md](docs/MIGRATION.md) imports your config and auth files.

## Connect a client

Clients send an API key (control panel, **API keys**) where they send a provider key: `Authorization: Bearer`,
`x-api-key` or `x-goog-api-key`/`?key=`. The client API is not behind Access, so no Access headers are needed.

```bash
export COMMISSARY_API_KEY='cms_…'
H=(-H "Authorization: Bearer $COMMISSARY_API_KEY")

curl "${H[@]}" https://llm.example.com/v1/models
curl "${H[@]}" https://llm.example.com/v1/chat/completions -H 'content-type: application/json' \
  -d '{"model":"<model id from /v1/models>","messages":[{"role":"user","content":"hi"}]}'
```

**Claude Code:**

```bash
export ANTHROPIC_BASE_URL=https://llm.example.com
export ANTHROPIC_AUTH_TOKEN="$COMMISSARY_API_KEY"
claude
```

[CLIENTS.md](docs/CLIENTS.md) covers Codex CLI, the OpenAI, Anthropic and Gemini SDKs and browser use. Clients that
signed in through Access before API keys: [MIGRATION.md](docs/MIGRATION.md#5-move-clients-to-api-keys).

**Endpoints.** `POST /v1/chat/completions`, `/v1/completions`, `/v1/messages`, `/v1/messages/count_tokens`,
`/v1/responses` (+ `/compact`, and a `GET` WebSocket upgrade), `GET /v1/models`, `/v1beta/models/*`
(`:generateContent`, `:streamGenerateContent`, …), `POST /v1beta/interactions`, images, videos and speech under `/v1`,
plus `/openai/v1/videos` and `/backend-api/codex/{responses,responses/compact,alpha/search}`. `/chat/completions`,
`/completions` and `/responses` are also served without `/v1`, so one base URL fits clients that append
`/v1/messages` for Anthropic models and `/chat/completions` for OpenAI models.

## Configuration

Deploy settings live in `.env` (template with comments: [`.env.example`](.env.example)). Runtime settings (routing,
model aliases, retries, …) are edited in the control panel and stored in the Worker as config entries; a Go `config.yaml`
(payload rules included) is imported with `POST /v9/management/settings/import` ([docs/MIGRATION.md](docs/MIGRATION.md)).

| Variable                         | Default        | Purpose                                                                                                                          |
| -------------------------------- | -------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `COMMISSARY_DOMAIN`              | (required)     | Base domain, the app host is under it; the app host itself unless `COMMISSARY_APP_DOMAIN` is set                                 |
| `COMMISSARY_APP_DOMAIN`          | (base)         | App host: the app Worker's and Access's hostname ([docs/DEPLOY.md](docs/DEPLOY.md#base-domain-and-app-host))                     |
| `COMMISSARY_API_DOMAIN`          |                | A second hostname that alone serves the client API, outside Access ([docs/DEPLOY.md](docs/DEPLOY.md#api-host))                   |
| `ACCESS_TEAM_DOMAIN`             | (required)     | Zero Trust team name or `<team>.cloudflareaccess.com`                                                                            |
| `ACCESS_ALLOW_EMAILS`            |                | Emails allowed to sign in (comma separated)                                                                                      |
| `ACCESS_ALLOW_EMAIL_DOMAINS`     |                | Email domains allowed to sign in                                                                                                 |
| `ACCESS_SERVICE_TOKENS`          |                | Names of the service tokens to create, one per script or machine using the management API                                        |
| `ACCESS_ALLOW_SERVICE_TOKEN_IDS` |                | Service tokens managed elsewhere (by token ID) to admit as well, e.g. CI's                                                       |
| `PLATFORM_ADMIN_EMAILS`          |                | Platform admins of the control panel and management API                                                                          |
| `PLATFORM_ADMIN_SERVICE_TOKENS`  |                | Service token names (from `ACCESS_SERVICE_TOKENS`) or Client IDs that are platform admins                                        |
| `ACCESS_SESSION_DURATION`        | `24h`          | Access session length for browser sign-ins                                                                                       |
| `ACCESS_SERVICE_TOKEN_HEADER`    |                | Accept service tokens as JSON in one header (e.g. `x-api-key`) for management scripts without custom headers                     |
| `ACCESS_MANAGED_OAUTH`           | `false`        | `true`: MCP clients sign in through Access at the app host's `/mcp` ([docs/ACCESS.md](docs/ACCESS.md#1-what-the-deploy-creates)) |
| `ACCESS_OAUTH_REDIRECT_URIS`     | Claude, Cursor | With Managed OAuth: the redirect URIs clients may register                                                                       |
| `ACCESS_OAUTH_LOOPBACK_CLIENTS`  | `true`         | With Managed OAuth: whether clients on `localhost`/`127.0.0.1` may register                                                      |
| `ACCESS_AUD`                     |                | Use an Access application you manage yourself instead of creating one                                                            |
| `COMMISSARY_CPU_MS`              | `300000`       | CPU limit per request in ms; lower it on plans with smaller limits                                                               |
| `COMMISSARY_MODE`                |                | `cloud` for Commissary Cloud (own sign-in, no Access; its settings: [DEPLOY.md](docs/DEPLOY.md#commissary-cloud))                |

[ACCESS.md](docs/ACCESS.md) explains what each Access setting creates, how the Worker validates requests, and how to
extend the policies (IdP groups, device posture).

## Updating and removing

```bash
git pull && pnpm install && pnpm build && pnpm run deploy --stage prod   # update
pnpm logs --stage prod --tail                                               # stream Worker logs
pnpm destroy --stage prod                                                   # remove everything
```

D1 migrations run on every deploy. `destroy` deletes the Durable Objects holding your credentials and the usage
history: export accounts from the panel first if you want to keep them.

A cron trigger (`0 */3 * * *`) refreshes the model catalog from [models.dev](https://models.dev) (also on demand from
the Models page), prunes old usage rows and re-arms credential refresh alarms.

**Continuous deployment.** `.github/workflows/ci.yml` deploys `main` to production and, once set up, to Commissary Cloud on
its own domain (stage `cloud`), and every pull request to its own preview stage on `workers.dev`. The CI credentials are code too (`stacks/github.ts`, `pnpm ci:setup`); see
[DEPLOY.md](docs/DEPLOY.md).

## Troubleshooting

| Symptom                                     | Fix                                                                                                  |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Deploy fails on the custom domain           | The app host (`COMMISSARY_APP_DOMAIN`, else `COMMISSARY_DOMAIN`) must be on a zone of the account    |
| Client gets 401 `Missing API key`           | Send an API key (`Authorization: Bearer cms_…`, `x-api-key` or `x-goog-api-key`)                     |
| Client gets 401 `Invalid API key`           | The API key is wrong, revoked or expired: create a new one on the API keys page                      |
| Client gets a 302 to `cloudflareaccess.com` | Its path is not part of the client API, or the deploy's bypass application is missing (`ACCESS_AUD`) |
| Client gets 404 `Not found: …`              | With `COMMISSARY_API_DOMAIN` set, send the client API to the API host the message names              |
| 500 `Authentication service error`          | `ACCESS_TEAM_DOMAIN` is wrong                                                                        |
| 403 `Forbidden` on the control panel        | Your email or token is not in `PLATFORM_ADMIN_EMAILS` / `PLATFORM_ADMIN_SERVICE_TOKENS`              |
| A model is missing from `/v1/models`        | No connected account or provider key serves it; check the Accounts and Models pages                  |
| Responses WebSocket closes with 1011/1012   | It hit the Worker CPU limit; clients reconnect, or use HTTP/SSE                                      |

More Access-specific answers: [ACCESS.md#troubleshooting](docs/ACCESS.md#troubleshooting).

## Provider support

| Provider (credential)                                                | Client protocols served                                  | Notes                                                                                                      |
| -------------------------------------------------------------------- | -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Claude (OAuth login, provider key)                                   | OpenAI, Responses, Claude, Gemini, Interactions          | Claude Code cloaking and body signing; no uTLS (see limitations)                                           |
| Codex / ChatGPT (OAuth browser or device, provider key)              | OpenAI, Responses (HTTP + WebSocket), Claude, Gemini     | `/backend-api/codex/*` aliases; no Codex live/realtime                                                     |
| Gemini (provider key), Vertex (provider key, service account upload) | OpenAI, Claude, Gemini, Responses, Interactions          | No Gemini OAuth: Gemini-CLI auth files are rejected on import                                              |
| Antigravity (OAuth)                                                  | OpenAI, Claude, Gemini, Interactions                     |                                                                                                            |
| xAI (device login, provider key)                                     | OpenAI, Responses (HTTP + WebSocket), images, video, TTS |                                                                                                            |
| Kimi / Kimi.ai (device login), Meta, Devin                           | OpenAI, Claude, Responses                                | Devin: authorization-code login                                                                            |
| OpenCode Zen / OpenCode Go (provider key)                            | every client protocol                                    | Chat, Responses, Messages (and Zen Gemini) per model; Go keys show their usage quotas on the Accounts page |
| OpenAI-compatible upstreams (provider key)                           | every client protocol                                    | Configured as `api-keys.openai-compatibility` groups                                                       |
| TypeSafe, SubQ (provider key)                                        | System One (`POST /v1/systemone`, TypeSafe's API)        | System One models (Jev, SubQ Snap); SubQ takes at most 4 images and no Box questions                       |

The matrix is indicative: which (client protocol, provider) pairs work follows the registered translators in
`packages/translation/src/translator/builtin.ts`; an unsupported pair answers with a 4xx/501 error.

## Known limitations

- **No TLS fingerprint impersonation.** Workers `fetch` cannot control the TLS ClientHello or HTTP/2 settings, so
  `wire-policy`/`tls-fingerprint` settings are ignored. Claude Code header and body cloaking still applies; providers
  that fingerprint TLS may treat the traffic differently.
- **Egress IPs are Cloudflare's.** Requests leave from Cloudflare data-centre addresses, not your own IP, and cannot be
  pinned. Providers that bind sessions to an IP or block cloud ranges may reject or challenge them.
- **No outbound proxies.** `proxy-url` (global, per credential, per key group) is read but not applied.
- **WebSocket CPU limit.** A Responses WebSocket lives in the invocation that accepted it and is bounded by the CPU
  limit (`COMMISSARY_CPU_MS`). There are no ping keep-alives (`streaming.keepalive-seconds` is ignored).
- **Not supported:** plugins, TUI, mDNS discovery, pprof, git/Postgres/object-store config backends, request-log files,
  Codex live/realtime (WebRTC/SIP), the AI Studio `wsrelay` gateway, `/v0/management` and the Go server's client API keys
  (API keys replace them). `/v1/responses/compact` answers 501 for Gemini/Vertex credentials.

Per-provider details: [ARCHITECTURE.md](docs/ARCHITECTURE.md); config keys without effect:
[MIGRATION.md](docs/MIGRATION.md).

## Local development

```bash
pnpm install
pnpm build                         # or `pnpm --filter @commissary/web dev` for the panel with hot reload on :5173
ALCHEMY_STATE=local pnpm dev       # panel on http://localhost:1337, client API on :1339, hot reload
```

`alchemy dev` runs the Workers in local workerd with emulated KV, D1 and Durable Objects. No Cloudflare resources are
created, and with `ALCHEMY_STATE=local` no Cloudflare login is needed. Access is not provisioned in dev: every request
to a loopback host is treated as the admin `dev@example.com` (override with `ACCESS_DEV_BYPASS`). The bypass is ignored
for any other host, refused whenever `ACCESS_TEAM_DOMAIN` or `ACCESS_AUD` is set, and never reaches a deployed Worker.

Open `http://localhost:1337/`, connect an account, then:

```bash
curl localhost:1339/v1/models
curl 'localhost:1339/cdn-cgi/handler/scheduled?cron=0+*/3+*+*+*'   # run the cron jobs
```

Before sending a change: `pnpm typecheck && pnpm lint && pnpm test && pnpm smoke`. Scripts, module layout and
conventions are in [DEVELOPMENT.md](docs/DEVELOPMENT.md).

## Documentation

| Guide                                   | Contents                                                                                                |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| [ACCESS.md](docs/ACCESS.md)             | Access application, policies, service tokens, management keys, Commissary Cloud sign-in, security model |
| [CLIENTS.md](docs/CLIENTS.md)           | Claude Code, Codex CLI, SDKs, curl                                                                      |
| [DEPLOY.md](docs/DEPLOY.md)             | CI deploys, preview stages, Commissary Cloud, operations                                                |
| [MIGRATION.md](docs/MIGRATION.md)       | Moving from the Go CLIProxyAPI server                                                                   |
| [DEVELOPMENT.md](docs/DEVELOPMENT.md)   | Scripts, module layout, conventions                                                                     |
| [ARCHITECTURE.md](docs/ARCHITECTURE.md) | Design decisions and per-subsystem behaviour                                                            |
| [THREAT-MODEL.md](docs/THREAT-MODEL.md) | What Commissary defends, whom it trusts and the risks it accepts                                        |
| [SECURITY.md](SECURITY.md)              | Reporting a vulnerability, supported versions                                                           |
| [GLOSSARY.md](GLOSSARY.md)              | Domain terms                                                                                            |

## Security

To report a vulnerability, follow [SECURITY.md](SECURITY.md). What Commissary defends, whom it trusts and which risks it
accepts: [THREAT-MODEL.md](docs/THREAT-MODEL.md).

## Acknowledgements

Commissary began as a TypeScript + [Effect](https://effect.website) port of
[CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) by Router-For.ME, and still uses it as the reference for
translators, thinking, payload rules and provider behaviour. Thanks to its authors and contributors.

## License

Commissary is licensed under [FSL-1.1-ALv2](LICENSE) (the Functional Source License with an Apache-2.0 future
license), © Spirit-Led Software LLC. In plain words: you may use, change and self-host it for anything except a
competing product or service, and each version becomes Apache-2.0 two years after it is released.

Portions derived from CLIProxyAPI stay under its MIT license; [NOTICE](NOTICE) holds that notice and every other
third-party one. Commits published before the switch remain available under MIT. The decision is recorded in
[ADR 0035](docs/adr/0035-commissary-ships-under-the-functional-source-license.md).

Contributions need a signed [CLA](CLA.md); see [CONTRIBUTING.md](CONTRIBUTING.md).
