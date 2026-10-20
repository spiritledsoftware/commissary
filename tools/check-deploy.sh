#!/usr/bin/env bash
# Post-deploy check of where Cloudflare Access sits (ADR 0022) and which Worker serves what (ADR 0028, ADR 0030: the app
# Worker the panel and the management API, the API Worker the client API). Retries while a new workers.dev hostname or
# Access application propagates.
# - /healthz answers 200 through Access with a service token;
# - the management API answers 200 through Access with a service token (which proves the Worker accepts the Access
#   JWT, i.e. ACCESS_AUD and the team domain are wired);
# - a client API route without credentials reaches the API Worker, which answers 401 `Missing API key` itself (the
#   client API is out of Access: clients send API keys; on one host, the zone routes reach the API Worker, where the
#   app Worker would answer 404);
# - a client the way `cloudflared access` clients (pi) send it, an Access JWT in `cf-access-token` and a dummy key in
#   `Authorization`, is served on a client API route (200): the first deploy with the bypass must not break them, since
#   `global` keeps Access sign-ins for clients on by default. The JWT is the `CF_Authorization` cookie Access sets for
#   the service token, which is issued for the main application, like a `cloudflared access login` token;
# - the control panel without credentials is stopped by Access (anything but 200);
# - the app host's MCP endpoint is the app Worker's, behind Access (ADR 0045): through Access with the service token it
#   answers a GET 405 (no stream), or 403 `Forbidden` where the token holds no role in `global`; the API Worker would
#   answer 401 `Missing API key` (on one host, a `/mcp*` zone route or bypass left over);
# - with Managed OAuth on (`ACCESS_MANAGED_OAUTH=true`), Access answers the app host's MCP endpoint for a non-browser
#   client without a sign-in 401 with `resource_metadata` in `WWW-Authenticate`, where MCP clients find its OAuth server;
# - when the client API has a host of its own (an API host, or a preview's API Worker workers.dev URL): /healthz answers
#   200 there, the client API answers 404 on the app host (through Access, from the app Worker) and the management API
#   404 there (from the API Worker).
# Usage: CF_ACCESS_CLIENT_ID=… CF_ACCESS_CLIENT_SECRET=… tools/check-deploy.sh <base-url> [<api-url>]
# `<api-url>` is where the client API is served (default: `<base-url>`).
set -euo pipefail

base="${1:?usage: check-deploy.sh <base-url> [<api-url>]}"
base="${base%/}"
api="${2:-$base}"
api="${api%/}"
: "${CF_ACCESS_CLIENT_ID:?CF_ACCESS_CLIENT_ID is required}"
: "${CF_ACCESS_CLIENT_SECRET:?CF_ACCESS_CLIENT_SECRET is required}"

body="$(mktemp)"
headers="$(mktemp)"
trap 'rm -f "$body" "$headers"' EXIT

# The Access JWT a `cloudflared`-style client sends (set by `access_jwt`).
jwt=""

# Prints the status of `$1$2` with the credentials `$3`: `token` goes through Access with the service token,
# `cloudflared` sends `$jwt` in `cf-access-token` with a dummy API key, `none` sends nothing, and `client` nothing but
# `Accept: application/json`, as a non-browser client without a sign-in does. Redirects are not followed,
# so an Access sign-in page shows as 302. The response headers land in `$headers`.
status() {
  local auth=()
  case "${3:-none}" in
  token)
    auth=(-H "CF-Access-Client-Id: $CF_ACCESS_CLIENT_ID" -H "CF-Access-Client-Secret: $CF_ACCESS_CLIENT_SECRET")
    ;;
  cloudflared) auth=(-H "cf-access-token: $jwt" -H "Authorization: Bearer sk-dummy") ;;
  client) auth=(-H "Accept: application/json") ;;
  esac
  curl -sS -o "$body" -D "$headers" -w '%{http_code}' --max-time 20 "${auth[@]}" "$1$2" || echo 000
}

# Waits until `check <code>` succeeds for `<host><path>` with `<credentials>`; `describe` names the expectation.
expect() {
  local host="$1" path="$2" credentials="$3" describe="$4" check="$5" code
  for attempt in $(seq 1 30); do
    code="$(status "$host" "$path" "$credentials")"
    if "$check" "$code"; then
      echo "$host$path: $code ($describe)"
      return 0
    fi
    echo "$host$path: $code, expected $describe (attempt $attempt/30)"
    sleep 10
  done
  echo "::error::$host$path did not answer $describe" >&2
  exit 1
}

ok() { [ "$1" = 200 ]; }
worker_401() { [ "$1" = 401 ] && grep -q '"Missing API key"' "$body"; }
worker_404() { [ "$1" = 404 ] && grep -q '"Not found: ' "$body"; }
not_ok() { [ "$1" != 200 ] && [ "$1" != 000 ]; }
app_mcp() { [ "$1" = 405 ] || { [ "$1" = 403 ] && grep -q '"Forbidden"' "$body"; }; }
oauth_challenge() { [ "$1" = 401 ] && grep -qiE '^www-authenticate:.*resource_metadata' "$headers"; }

expect "$base" /healthz token "200 through Access" ok
expect "$base" /v9/management/me token "200 through Access" ok

# The `CF_Authorization` cookie of the last answer through Access with the service token.
jwt="$(sed -nE 's/^[Ss]et-[Cc]ookie: *CF_Authorization=([^;[:space:]]+).*/\1/p' "$headers" | tail -n 1)"
if [ -z "$jwt" ]; then
  echo "::error::Access set no CF_Authorization cookie for the service token" >&2
  exit 1
fi

expect "$api" /v1/models cloudflared "200 with cf-access-token and a dummy key" ok
expect "$api" /v1/models none "401 Missing API key from the Worker" worker_401
expect "$api" /v1beta/models none "401 Missing API key from the Worker" worker_401
expect "$base" / none "no 200 without Access" not_ok
expect "$base" /mcp token "405 (or 403) from the app Worker's MCP endpoint behind Access" app_mcp

if [ "$(echo "${ACCESS_MANAGED_OAUTH:-}" | tr '[:upper:]' '[:lower:]' | tr -d '[:space:]')" = true ]; then
  expect "$base" /mcp client "401 from Access with resource_metadata (Managed OAuth)" oauth_challenge
fi

if [ "$api" != "$base" ]; then
  expect "$api" /healthz none "200 without Access" ok
  expect "$base" /v1/models token "404 from the Worker: the client API is on the API host" worker_404
  expect "$api" /v9/management/me none "404 from the Worker: the management API is on the app host" worker_404
fi
