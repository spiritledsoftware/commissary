# Connecting clients

All examples use `https://commissary.example.com` as the Worker's hostname and an **API key**: a key Commissary issues to a
member of an org (ADR 0022). Create one in the control panel under **API keys** (any member can); it is shown once, so
copy it then. A key looks like `cms_<org id>_<key id>_<secret>`: it names its org, so Commissary serves the request from
that org's accounts, and it acts as the member who created it (usage is recorded against the key and its member, and
one member's keys share session state). Export it once; never commit it:

```bash
export COMMISSARY_API_KEY='cms_…'
```

Send the key wherever the client sends a provider key: `Authorization: Bearer <key>` (OpenAI, Codex, Claude Code's auth
token, MCP clients), `x-api-key` (Anthropic), `x-goog-api-key` or `?key=` (Gemini). The client API (`/v1*`,
`/openai/v1*`, `/backend-api/codex*`, the unprefixed `/chat/completions`, `/completions`, `/responses`, and the MCP
endpoint `/mcp` on the API host) is not behind Cloudflare Access, so no Access headers are needed. A missing key answers
`401 {"error":"Missing API key"}`; a wrong, revoked or expired key `401 {"error":"Invalid API key"}`. Revoking a key in
the panel takes effect within 30 seconds. List the model ids you can use with `GET /v1/models`.

Clients set up before API keys that sign in through Access (a `cloudflared access` token in the `cf-access-token`
header) keep working in the first org (`global`) while its owner leaves **Access sign-ins for clients** on (the
`access_clients` setting, on by default); they never reach another org. See [MIGRATION.md](MIGRATION.md#5-move-clients-to-api-keys).
Access service token headers (`CF-Access-Client-Id`/`-Secret`) are not accepted on the client API any more.

## curl

```bash
H=(-H "Authorization: Bearer $COMMISSARY_API_KEY")
curl "${H[@]}" https://commissary.example.com/v1/models

# OpenAI chat completions
curl "${H[@]}" https://commissary.example.com/v1/chat/completions -H 'content-type: application/json' \
  -d '{"model":"gpt-5","messages":[{"role":"user","content":"hi"}]}'

# Anthropic messages
curl -H "x-api-key: $COMMISSARY_API_KEY" https://commissary.example.com/v1/messages -H 'content-type: application/json' \
  -H 'anthropic-version: 2023-06-01' \
  -d '{"model":"claude-sonnet-4-5","max_tokens":256,"messages":[{"role":"user","content":"hi"}]}'

# Gemini
curl -H "x-goog-api-key: $COMMISSARY_API_KEY" 'https://commissary.example.com/v1beta/models/gemini-2.5-pro:generateContent' \
  -H 'content-type: application/json' -d '{"contents":[{"role":"user","parts":[{"text":"hi"}]}]}'
```

Replace the model ids with ones from `/v1/models`.

## Claude Code

Claude Code reads these environment variables (see the
[environment variable reference](https://code.claude.com/docs/en/env-vars)):

```bash
export ANTHROPIC_BASE_URL=https://commissary.example.com
export ANTHROPIC_AUTH_TOKEN="$COMMISSARY_API_KEY"   # sent as "Authorization: Bearer <key>"
claude
```

Set `ANTHROPIC_API_KEY="$COMMISSARY_API_KEY"` instead of `ANTHROPIC_AUTH_TOKEN` if you prefer the `x-api-key` header; a login
from `claude login` can interfere, so log out or use a clean `CLAUDE_CONFIG_DIR`. Pick a model served
by your credentials with `ANTHROPIC_MODEL` (and `ANTHROPIC_DEFAULT_SONNET_MODEL` etc.); Commissary also accepts
non-Claude models, translated to the Claude Code protocol.

Persistent alternative, `~/.claude/settings.json`:

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "https://commissary.example.com",
    "ANTHROPIC_AUTH_TOKEN": "cms_…"
  }
}
```

## Codex CLI

Define a custom provider in `~/.codex/config.toml` (see the
[config reference](https://developers.openai.com/codex/config-reference)):

```toml
model_provider = "commissary"
model = "gpt-5-codex" # any model id from /v1/models

[model_providers.commissary]
name = "commissary"
base_url = "https://commissary.example.com/v1"
wire_api = "responses" # the only supported value
env_key = "COMMISSARY_API_KEY" # sent as "Authorization: Bearer <key>"
# supports_websockets = true     # optional: Responses over WebSocket (see the CPU-limit caveat in the README)
```

Run `codex` with `COMMISSARY_API_KEY` exported. Codex sends `/v1/responses` (HTTP/SSE, or the WebSocket upgrade on the same path)
and `/v1/responses/compact`.

The Worker also serves the ChatGPT-backend paths `/backend-api/codex/responses`, `/responses/compact` and `/alpha/search`
for tools that hard-code them; they take the key the same way.

## OpenAI SDKs

```python
import os
from openai import OpenAI

client = OpenAI(base_url="https://commissary.example.com/v1", api_key=os.environ["COMMISSARY_API_KEY"])
print(client.chat.completions.create(model="gpt-5", messages=[{"role": "user", "content": "hi"}]))
```

```ts
import OpenAI from "openai";

const client = new OpenAI({
  baseURL: "https://commissary.example.com/v1",
  apiKey: process.env.COMMISSARY_API_KEY!,
});
```

## Anthropic SDKs

The SDK appends `/v1/messages` itself: the base URL has **no** `/v1`.

```python
import os
from anthropic import Anthropic

client = Anthropic(base_url="https://commissary.example.com", api_key=os.environ["COMMISSARY_API_KEY"])
```

```ts
import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic({
  baseURL: "https://commissary.example.com",
  apiKey: process.env.COMMISSARY_API_KEY!,
});
```

## Gemini SDKs (`google-genai`)

The base URL is the host; the SDK adds `/v1beta`.

```python
import os
from google import genai
from google.genai import types

client = genai.Client(
    api_key=os.environ["COMMISSARY_API_KEY"],
    http_options=types.HttpOptions(base_url="https://commissary.example.com"),
)
```

```ts
import { GoogleGenAI } from "@google/genai";

const ai = new GoogleGenAI({
  apiKey: process.env.COMMISSARY_API_KEY!,
  httpOptions: { baseUrl: "https://commissary.example.com" },
});
```

## MCP clients (tools)

Commissary's MCP endpoint serves the tools of the toolkits you may use as one MCP server (Streamable HTTP; clients of
the 2026-07-28 revision and of the 2025 handshake alike). Its tools are named `<toolkit>_<tool>`: every tool of your own
private toolkits, and of the org's toolkits that take your own credential. A toolkit's shared credential needs a grant
from an org admin (not there yet), so its tools are not listed. Narrow the list to some toolkits with `?toolkits=`, by
the names the panel shows: `…/mcp?toolkits=github,linear` (an unknown name narrows to nothing; a tool left out answers
as an unknown tool). When a tool needs your own credential for its toolkit and you have not connected one, the call
answers with a link to the panel's connect page instead: a client of the 2026-07-28 revision that supports URL
elicitation offers to open it, any other client shows it in the tool's result. Connect, then call the tool again.

A self-hosted Commissary serves the endpoint at two addresses (ADR 0045):

- **Signed in through Access**, for clients a person uses: `https://commissary.example.com/mcp` on the **app host** (the
  panel's address). The client signs in through Cloudflare Access's OAuth (Managed OAuth): it opens your browser on
  the Access login, then acts as you, with every tool you may use in the org `global` (the first org; a member of
  another org uses an API key). Nothing to copy or rotate; your Access session's policy is checked again every 15
  minutes, and removing you from Access cuts the client off. Usage shows you, not the client, and there is no tool
  scope: for a narrower client, use a key. Access service tokens (`CF-Access-Client-Id`/`-Secret` headers) work there
  too, as the token's role in the org. A client that registers only through Client ID Metadata Documents (CIMD), which
  Access does not document yet, cannot sign in this way: give it a key.
- **With an API key**, for headless clients and scripts: `https://api.example.com/mcp` on the **API host**, with the same
  key as the rest of the client API as a static bearer header. Without a valid key it answers `401` with
  `WWW-Authenticate: Bearer`; it offers no OAuth sign-in, so a client that starts one has no key configured. A
  deployment with one host (no API host) has no API-key MCP endpoint: its `/mcp` is the one behind Access.

On Commissary Cloud the endpoint is on the API host only, with API keys.

### Signed in through Access (app host)

**Claude** (claude.ai, Desktop): **Settings** > **Connectors** > **Add custom connector**, URL
`https://commissary.example.com/mcp`, then **Connect** and sign in through Access. Claude's callback
(`https://claude.ai/api/mcp/auth_callback`) is one the deploy allows by default.

**Claude Code**:

```bash
claude mcp add --transport http commissary https://commissary.example.com/mcp
```

Then `/mcp` in Claude Code and **Authenticate**: it opens the Access login in your browser and listens on `localhost`.

**Cursor** (`~/.cursor/mcp.json`, or `.cursor/mcp.json` in a project): add the server without headers, then **Connect**
in Cursor's MCP settings to sign in.

```json
{ "mcpServers": { "commissary": { "url": "https://commissary.example.com/mcp" } } }
```

**Codex** (`~/.codex/config.toml`), then `codex mcp login commissary` to sign in (Codex listens on `127.0.0.1`):

```toml
[mcp_servers.commissary]
url = "https://commissary.example.com/mcp"
```

Loopback clients (Claude Code, Codex, Cursor's desktop app, pi) need `ACCESS_OAUTH_LOOPBACK_CLIENTS` on, the default; a
hosted client whose callback is not in `ACCESS_OAUTH_REDIRECT_URIS` is refused by Access
([ACCESS.md](ACCESS.md#1-what-the-deploy-creates)).

### With an API key (API host)

**Claude Code**:

```bash
claude mcp add --transport http commissary https://api.example.com/mcp \
  --header "Authorization: Bearer $COMMISSARY_API_KEY"
```

**Cursor**:

```json
{
  "mcpServers": {
    "commissary": {
      "url": "https://api.example.com/mcp",
      "headers": { "Authorization": "Bearer ${env:COMMISSARY_API_KEY}" }
    }
  }
}
```

**Codex** (Codex sends the variable's value as the bearer token):

```toml
[mcp_servers.commissary]
url = "https://api.example.com/mcp"
bearer_token_env_var = "COMMISSARY_API_KEY"
```

**pi** (`~/.pi/agent/mcp.json`, or `pi mcp add commissary --url https://api.example.com/mcp
--bearer-token-env-var COMMISSARY_API_KEY`):

```json
{
  "mcpServers": {
    "commissary": {
      "url": "https://api.example.com/mcp",
      "headers": { "Authorization": "Bearer ${COMMISSARY_API_KEY}" }
    }
  }
}
```

## Browser users

Anyone allowed by an Access Allow policy who is a member of an org (added by an org admin, or joined through auto-join,
which is on for the first org) can open the control panel at `https://commissary.example.com/`: a plain member sees their own
usage and manages their own API keys, an org admin also manages credentials and every key of the org
([ACCESS.md](ACCESS.md#members-roles-and-teams)).

The client API does not read the Access session cookie, so a web page on another origin cannot spend a signed-in user's
access: it would need an API key, which browsers never attach on their own. Call Commissary from a backend with an API
key.
