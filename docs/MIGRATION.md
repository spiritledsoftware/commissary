# Migrating from the Go server

The Workers port reads the Go `config.yaml` and the Go auth files (`*.json`), so migration is: deploy
([README](../README.md#deploy)), then import both through the management API.

## 0. Management access from a terminal

The management API needs an **org admin** (or a platform admin). For scripts, add a service token name to
`ACCESS_SERVICE_TOKENS` and to `PLATFORM_ADMIN_SERVICE_TOKENS` in `.env` and deploy (see [ACCESS.md](ACCESS.md); its
credentials land in `.alchemy/access-service-tokens.json`), or register its Client ID to the org with a role
(`POST /v9/management/service-tokens`, the Members page) once a platform admin has set it up, then:

```bash
M=https://commissary.example.com/v9/management
H=(-H "CF-Access-Client-Id: $CF_ACCESS_CLIENT_ID" -H "CF-Access-Client-Secret: $CF_ACCESS_CLIENT_SECRET")
```

The unscoped address is the `global` org's. To migrate into another org (ADR 0021), use
`M=https://commissary.example.com/v9/management/orgs/<slug>`; every command below works the same there.

Alternatively use the control panel (`/`) as an admin user: _Accounts_ → _Connect account_ uploads auth files, and Settings and the Provider keys
page edit what the import stored. The panel has no UI for the config import yet, so that step is `curl`.

## 1. Config

Import your Go `config.yaml` as-is (the keys the Workers port ignores are named in the answer and not stored):

```bash
curl "${H[@]}" -X POST "$M/settings/import" -H 'content-type: application/yaml' --data-binary @config.yaml
# {"status":"ok","version":1,"not_applied":["requests.proxy-url","access.api-keys"]}
```

- The import **replaces every config entry of the org** with the document (settings, provider key groups and keys, model
  aliases and exclusions, payload rules): what the document does not set goes back to its default. It is the only
  whole-configuration write, and the body is at most 512 KiB. Run it once for the first deployment; afterwards edit single
  settings, key groups and model rules in the panel, or script `PATCH /settings`.
- There is no export route and no route that reads secrets back. Keep your `config.yaml` as the source of truth (or as the
  file copy) and import it again to reset everything to it.
- Legacy top-level keys (`claude-api-key`, `codex-api-key`, `gemini-api-key`, `openai-compatibility`, `request-retry`, …) are
  migrated to the v8 layout on import; unknown or inapplicable keys are dropped. A malformed document answers 422
  `invalid_config` with a message (`line` and `column` for invalid YAML, `path` for a value that does not fit the schema);
  nothing is stored.
- **Secrets in `config.yaml`** (provider keys) are stored in the `ControlPlane` Durable Object, not in your repo. Every
  setting, provider key group, provider key, model alias or exclusion list and payload rule is stored as an entry of its own with a
  revision, so later edits to different entries never conflict.
- **Existing deployments** that stored a config document before entries (ADR 0025) need no step: the first time the
  `ControlPlane` starts it turns the stored document into entries in one transaction (same configuration, same credential
  ids and so the same `auth_index` values, so panel links and usage history keep working). The old document row is kept.
- `PATCH $M/settings` takes `{"revisions": {…}, "patch": {…}}` for scripted edits of single settings: `revisions` names the
  revision of each setting you change (read it from `GET $M/settings`; absent means not stored, 0), and a stale one answers
  409 `conflict`. Provider key groups and model rules have their own routes (see [ARCHITECTURE.md](ARCHITECTURE.md) "Management API").
- Management writes need a `content-type` (`application/json`; `application/yaml` for the import; multipart for uploads):
  curl's default `application/x-www-form-urlencoded` answers 415 (cross-site request forgery protection, see ACCESS.md).
- Dropped on import (no effect on Workers): `host`/`port`/`tls`, `remote-management.*` (Access replaces it), `auth-dir`, `pprof`,
  logging to files, `wire-policy`/TLS fingerprint, plugins, Home, Postgres/git/object store settings.

### Not applied on Workers

These keys are accepted by the import but have no effect on Workers, so they are **not stored**: the import answer lists them
under `not_applied`, and nothing else shows them:

| Key                                                          | Why                                                                                                                 |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| `access.api-keys` (legacy top-level `api-keys`)              | Clients authenticate with Cloudflare Access, see [CLIENTS.md](CLIENTS.md)                                           |
| `requests.proxy-url`, per-group/per-key `proxy-url`          | Workers `fetch` cannot use outbound proxies                                                                         |
| `api-keys.claude[].keys[].experimental-cch-signing`          | Kept for compatibility (also in Go); signing follows the credential type                                            |
| `observability.logs.debug`, `observability.logs.request-log` | No debug/request-log files; Workers Logs carry one structured line per request                                      |
| `observability.usage.usage-statistics-enabled`               | Usage persistence is always on when the `USAGE` D1 binding exists                                                   |
| `observability.usage.redis-usage-queue-retention-seconds`    | The queue lives in D1 (`/observability/usage/queue`), retention is each org's `usage_retention_days` (`PATCH /org`) |
| `models.codex-catalog`, `models.devin-catalog`               | The Codex client catalog is bundled and Devin models are catalog additions, [ARCHITECTURE.md](ARCHITECTURE.md)      |
| `routing.cooldown.save-cooldown-status`                      | Cooldowns always persist: the Durable Object is evicted when idle, which is not a restart                           |

`requests.streaming.keepalive-seconds` applies to SSE responses but not to the Responses WebSocket (no ping frames).

- The client `api-keys:` list is **not enforced**: every client must now present an Access identity ([CLIENTS.md](CLIENTS.md)).
  Give each client its own service token instead of a shared key.

### OpenCode Zen / OpenCode Go

Go reaches OpenCode only as an `openai-compatibility` entry (`base-url: https://opencode.ai/zen/v1` or `.../zen/go/v1`), which
sends every model to `/chat/completions`; models the gateway serves on another endpoint answer 400
`ModelProtocolUnsupported`. The Worker has dedicated providers: move the key to `api-keys.opencode-zen` (Zen) or
`api-keys.opencode-go` (Go) and drop the compat entry.

```yaml
api-keys:
  opencode-go:
    - keys:
        - api-key: sk-…
      # Optional: without `models`, every non-deprecated catalog model is registered (Zen: without its free models).
      models:
        - name: minimax-m3
        - name: deepseek-v4-flash
          alias: ds-flash
          protocol: chat # chat | responses | messages | gemini (Zen only); overrides the catalog
```

`base-url` is optional (defaults to the gateway). Each model is posted to its own endpoint (from the OpenCode catalog, refreshed
by the cron) with the gateway's session header; see ARCHITECTURE.md "OpenCode Zen and OpenCode Go". Model ids are the same as
in the compat entry, so clients keep their model names; compat `prefix`/`alias` settings carry over as group/model settings.
OpenCode Go keys also appear on the panel's Accounts page with their 5-hour, weekly and monthly usage, and a key over one
of those limits rests until the window resets while other keys take its requests.

### TypeSafe and SubQ (System One)

The Go server has no System One support (ADR 0032), so a Go config has nothing to move. Add TypeSafe and SubQ keys on
the panel's Provider keys page, or in the imported document:

```yaml
api-keys:
  typesafe:
    - keys:
        - api-key: ts-…
  subq:
    - keys:
        - api-key: sk-…
```

Without `models`, a TypeSafe group registers `jev-1.13.0`, `jev-1.14.0`, `jev-latest` and `jev-preview`, and a SubQ group
`subq-snap-preview`. Clients reach them on `POST /v1/systemone` with TypeSafe's SDKs; see ARCHITECTURE.md "System One".

## 2. Auth files (OAuth credentials)

Upload every `*.json` file from the Go `auth-dir` (default `~/.cli-proxy-api`). The file name becomes the credential id:

```bash
curl "${H[@]}" -X POST "$M/credentials" $(for f in ~/.cli-proxy-api/*.json; do printf -- '-F file=@%s ' "$f"; done)
# or a single raw file:
curl "${H[@]}" -X POST "$M/credentials?name=claude-ab12cd34-me@example.com.json" \
  -H 'content-type: application/json' --data-binary @claude-ab12cd34-me@example.com.json
curl "${H[@]}" "$M/credentials"          # list (tokens are redacted)
```

Results: `200 {"status":"ok","uploaded":N,…}`, or `207` with a `failed` list when some files were rejected (`file must be .json`,
`invalid name`). Uploaded credentials are selectable immediately; expired access tokens are refreshed using the stored refresh
token. Vertex service-account files can be uploaded the same way. Disabled flags and per-file settings (`prefix`, `priority`,
`proxy_url` is ignored) are kept.

Caveats:

- Provider refresh tokens are single-use for some providers (Claude, Codex). If the Go server and the Worker both keep refreshing
  the same file, one of them will see `invalid_grant`. **Stop the Go server after importing**, or re-login in the Worker (below).
- Files are bound to the provider's egress IP behaviour only by the provider's own policy; see "Known limitations" in the README.

## 3. OAuth re-login via the panel

Logging in fresh avoids sharing refresh tokens. In the panel → _Accounts_ → _Connect account_ (or `GET $M/oauth/auth-url?provider=<claude|codex|antigravity|devin|xai|meta|kimi|kimi-ai>`):

1. Open the returned authorization URL and sign in with the provider.
2. **Authorization-code providers (Claude, Codex, Antigravity, Devin)**: the provider redirects to `http://localhost:<port>/…callback?code=…&state=…`.
   That page will not load (nothing listens on your machine). Copy the **full redirected URL** from the address bar and paste it into the panel's
   callback field (API: `POST $M/oauth/callback` with `{"provider":"codex","redirect_url":"<url>"}`). The Worker exchanges the code
   itself; poll `GET $M/oauth/status?state=<state>` until `ok`. The window is 5 minutes.
3. **Device-code logins (Codex with `flow=device`, xAI, Meta, Kimi)**: show the code and URL, approve in the browser; the panel polls
   the status. No paste step.

The credential is stored under the same file-name scheme as Go (e.g. `claude-<hash>-<email>.json`); a re-login of the same account
replaces the tokens but keeps your per-file settings.

### Exporting an account (Worker to Worker, or back to files)

A stored auth file, tokens included, can be downloaded to move an account to another deployment. The download is limited to a
**service token that is an owner of the org**, or a platform admin (§0); a person, including in the panel, gets
`403 download_requires_service_token`:

```bash
curl "${H[@]}" "$M/credentials/download?name=claude-ab12cd34-me@example.com.json" -o claude-ab12cd34-me@example.com.json
curl "${H[@]}" -X POST "$M/credentials?name=claude-ab12cd34-me@example.com.json" \
  -H 'content-type: application/json' --data-binary @claude-ab12cd34-me@example.com.json   # against the other deployment
```

The same caveat as §2 applies: two deployments refreshing one single-use refresh token break each other, so retire the source
account afterwards (or log in again on the target, §3, which needs no export). The file is written verbatim, so treat it as a secret.

## 4. Switch clients

Create an API key in the panel (**API keys**) and point each tool at the Worker with it ([CLIENTS.md](CLIENTS.md));
verify `GET /v1/models` lists the models you expect, then retire the Go server. The Go server's client keys
(`access.api-keys`) are not imported as API keys: they are a different kind of key, so every client gets a new one.
Model aliases, prefixes, `excluded-models`, payload rules and routing settings from `config.yaml` carry over. Usage
statistics are not migrated; new usage is recorded in D1 and shown in the panel.

## 5. Move clients to API keys

Before API keys (ADR 0022), clients of a Workers deployment authenticated through Cloudflare Access: with Access
service token headers (`CF-Access-Client-Id`/`-Secret`), or with a `cloudflared access` token in the `cf-access-token`
header. Since then the client API (`/v1*`, `/openai/v1*`, `/backend-api/codex*`, `/chat/completions`, `/completions`,
`/responses`) are outside the Access application: the deploy adds a bypass application for those paths, so Access no
longer turns a service token into a sign-in there, and the Worker answers them itself.

- **Service token headers stop working on the client API** with the deploy that adds the bypass. Move those clients
  first: as a member of the org, create an API key in the panel and replace the two Access headers with the key
  ([CLIENTS.md](CLIENTS.md)). Service tokens keep working on the management API.
- **`cloudflared access` tokens keep working in the first org** (`global`, the org of a deployment from before orgs)
  while its **Access sign-ins for clients** setting is on, which is its default. The Worker verifies the token from the
  `cf-access-token` header itself (and from `Cf-Access-Jwt-Assertion`); a dummy API key sent next to it is ignored. A
  token is issued for the Access application of the whole domain, so renew it with
  `cloudflared access login https://commissary.example.com` (the domain, not a client API path, which Access no longer guards).
- When every client uses an API key, an owner of `global` turns the setting off, on its Members page or with
  `curl "${H[@]}" -X PATCH "$M/membership" -H 'content-type: application/json' -d '{"access_clients":false}'` (`M`
  unscoped). From then on a request to the client API with only an Access sign-in answers `401`. Other orgs have no such
  setting: they take API keys only.

A deployment that brings its own Access application (`ACCESS_AUD`) gets no bypass from the deploy: add a self-hosted
application for the client API paths with a Bypass policy for everyone ([DEPLOY.md](DEPLOY.md)), or its clients keep needing
Access in front of the key.
