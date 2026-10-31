#!/bin/sh
# Boots the stack under `alchemy dev` (local emulators, local state, no Cloudflare login) and checks that the bundled
# Workers start and answer: the CI replacement for a deploy dry run. It reads each Worker's ready line (ADR 0030): the
# app Worker (`Commissary`) serves the panel and the management API, the API Worker (`Api`) the client API and the cron
# jobs, and the state Worker (`State`), which defines the Durable Objects, serves no requests itself. Under `alchemy dev`
# the other Workers reach the state Worker's objects over its dev-only bridge (apps/state/src/dev.ts, docs/DEVELOPMENT.md
# "Infrastructure"). Self-hosted (the default), it ends with the journey across the Workers: an API key issued on the
# app Worker is taken by the API Worker, and refused there once revoked. With `COMMISSARY_MODE=cloud` (Commissary Cloud,
# ADR 0026) the auth Worker (`Auth`) starts too, and the checks end with the sign-in across the Workers: the auth host's
# routes and CORS, and the app Worker asking the auth Worker about a session. Builds the control panel first so `/` is
# served.
# Usage: bun run smoke, or COMMISSARY_MODE=cloud bun run smoke
set -eu
cd "$(dirname "$0")/.."
mode="${COMMISSARY_MODE:-self-hosted}"
if [ "$mode" = cloud ]; then
  # A GitHub client nobody signs in with, so the sign-in options offer a provider (Turnstile defaults to its
  # always-passing test keys under `alchemy dev`, infra/settings.ts).
  export SIGN_IN_GITHUB_CLIENT_ID="${SIGN_IN_GITHUB_CLIENT_ID:-smoke-github-client}"
  export SIGN_IN_GITHUB_CLIENT_SECRET="${SIGN_IN_GITHUB_CLIENT_SECRET:-smoke-github-secret}"
fi
bunx turbo run build --filter=@commissary/web --output-logs=errors-only
log=$(mktemp)
ALCHEMY_STATE=local bunx alchemy dev --stage smoke >"$log" 2>&1 &
pid=$!
cleanup() {
  kill "$pid" 2>/dev/null || true
  wait "$pid" 2>/dev/null || true
  rm -rf .alchemy/state/commissary/smoke .alchemy/local
}
trap cleanup EXIT INT TERM

# The URL a Worker's ready line (`[<logical id>] ready at <url>`) names, once it is printed.
ready() {
  sed -n "s/.*\\[$1\\] ready at \\(http[^ ]*\\).*/\\1/p" "$log" | tail -n 1
}

url=""
api_url=""
state_url=""
auth_url=""
# The auth Worker runs on Commissary Cloud only.
auth_up() {
  [ "$mode" != cloud ] || { [ -n "$auth_url" ] && curl -fsS "$auth_url/healthz" >/dev/null 2>&1; }
}
up() {
  [ -n "$url" ] && [ -n "$api_url" ] && [ -n "$state_url" ] &&
    curl -fsS "$url/healthz" >/dev/null 2>&1 && curl -fsS "$api_url/healthz" >/dev/null 2>&1 && auth_up
}
i=0
while [ "$i" -lt 180 ]; do
  url=$(ready Commissary)
  api_url=$(ready Api)
  state_url=$(ready State)
  auth_url=$(ready Auth)
  if up; then break; fi
  if ! kill -0 "$pid" 2>/dev/null; then cat "$log"; echo "alchemy dev exited" >&2; exit 1; fi
  i=$((i + 1))
  sleep 1
done
if ! up; then
  cat "$log"
  echo "the Workers did not become ready (app: ${url:-no ready line}, API: ${api_url:-no ready line}, state: ${state_url:-no ready line}, auth: ${auth_url:-no ready line})" >&2
  exit 1
fi

# expect <status> <curl arguments>
expect() {
  want=$1
  shift
  status=$(curl -s -o /dev/null -w '%{http_code}' "$@")
  echo "$status $*"
  [ "$status" = "$want" ] || { cat "$log"; exit 1; }
}
check() { expect 200 "$@"; }
# The state Worker has no routes.
expect 404 "$state_url/"
check "$url/healthz"

if [ "$mode" = cloud ]; then
  url="${url%/}"
  auth_url="${auth_url%/}"
  body=$(mktemp)
  # contains <text> <curl arguments>: a 200 whose body contains <text>.
  contains() {
    text=$1
    shift
    status=$(curl -s -o "$body" -w '%{http_code}' "$@")
    echo "$status $* (expecting $text)"
    [ "$status" = 200 ] && grep -Fq "$text" "$body" || { cat "$body" "$log"; exit 1; }
  }
  # preflight <origin>: the status of a CORS preflight of a sign-in on the auth host from <origin>; its headers go to
  # $headers.
  headers=$(mktemp)
  preflight() {
    curl -s -o /dev/null -D "$headers" -w '%{http_code}' -X OPTIONS -H "Origin: $1" \
      -H 'Access-Control-Request-Method: POST' "$auth_url/api/auth/sign-in/social"
  }
  # The auth host: the sign-in options (the GitHub client above), Better Auth's health check (its secret and the SignIn
  # database), CORS for the app origin only, and none of the app's routes.
  check "$auth_url/healthz"
  contains '"providers":["github"' "$auth_url/api/sign-in-options"
  contains '"ok":true' "$auth_url/api/auth/ok"
  status=$(preflight "$url")
  echo "$status preflight from $url"
  [ "$status" = 204 ] && grep -Fiq "access-control-allow-origin: $url" "$headers" || { cat "$headers" "$log"; exit 1; }
  status=$(preflight "https://elsewhere.invalid")
  echo "$status preflight from elsewhere"
  [ "$status" = 403 ] && ! grep -iq '^access-control-allow-origin:' "$headers" || { cat "$headers" "$log"; exit 1; }
  expect 404 "$auth_url/v9/management/me"
  # The app host: the sign-in page names the auth host, the panel sends a browser there, and a cookie the auth Worker
  # does not know is no session. The 401 is the auth Worker's answer over the app Worker's service binding: a lookup
  # that fails (no binding, a broken auth Worker) answers 500.
  contains "<meta name=\"commissary-auth-origin\" content=\"$auth_url\">" "$url/sign-in"
  expect 302 "$url/"
  expect 404 "$url/api/sign-in-options"
  status=$(curl -s -o "$body" -w '%{http_code}' -H "Origin: $url" -H 'Sec-Fetch-Site: same-origin' \
    -H 'Cookie: __Secure-better-auth.session_token=forged' "$url/v9/management/me")
  echo "$status $url/v9/management/me with a forged session"
  [ "$status" = 401 ] && grep -q '"Not signed in"' "$body" || { cat "$body" "$log"; exit 1; }
  # The API Worker takes API keys only.
  expect 401 "$api_url/v1/models"
  rm -f "$body" "$headers"
  echo "smoke ok (Commissary Cloud): $url (auth Worker at $auth_url, API Worker at $api_url, state Worker at $state_url)"
  exit 0
fi
# An address without an org redirects to the caller's only org.
check -L "$url/"
check -L "$url/accounts"
check "$url/o/default/"
check "$url/o/default/accounts"
check "$url/v9/management/settings"
check "$url/v9/management/observability/usage/summary"
check "$url/v9/management/me"
check "$url/v9/management/orgs"
check "$url/v9/management/orgs/default/settings"
# Each Worker serves its own paths only.
expect 404 "$url/v1/models"
expect 404 "$api_url/v9/management/me"
check "$api_url/healthz"
check "$api_url/v1/models"
check "$api_url/cdn-cgi/handler/scheduled?cron=0+*/3+*+*+*"

# The self-hosted journey across the Workers, as the dev admin (the dev bypass): join `default` (409 when already a
# member: API keys are issued to members), issue an API key on the app Worker, use it on the API Worker, revoke it on
# the app Worker, and wait until the API Worker refuses it (its verified-key cache keeps a key for up to 30 s,
# packages/auth's VERIFIED_KEY_TTL_MS). The key is never printed.
body=$(mktemp)
json() { curl -s -o "$body" -w '%{http_code}' -H 'content-type: application/json' "$@"; }
org="$url/v9/management/orgs/default"
# The dev admin: ACCESS_DEV_BYPASS from the environment or .env, as infra/settings.ts reads it.
dev_email="${ACCESS_DEV_BYPASS:-$(sed -n "s/^ACCESS_DEV_BYPASS=[\"']*\([^\"']*\).*/\1/p" .env 2>/dev/null | tail -n 1)}"
status=$(json -X POST -d "{\"email\":\"${dev_email:-dev@example.com}\",\"role\":\"member\"}" "$org/members")
echo "$status POST $org/members"
case "$status" in 201 | 409) ;; *) cat "$body" "$log"; exit 1 ;; esac
status=$(json -X POST -d '{"name":"smoke"}' "$org/api-keys")
echo "$status POST $org/api-keys"
[ "$status" = 201 ] || { cat "$body" "$log"; exit 1; }
key=$(sed -n 's/.*"key":"\([^"]*\)".*/\1/p' "$body")
id=$(sed -n 's/.*"id":"\([^"]*\)".*/\1/p' "$body")
[ -n "$key" ] && [ -n "$id" ] || { echo "no key or id in the answer" >&2; exit 1; }
with_key() { curl -s -o /dev/null -w '%{http_code}' -H "authorization: Bearer $key" "$api_url/v1/models"; }
status=$(with_key)
echo "$status $api_url/v1/models with the key"
[ "$status" = 200 ] || { cat "$log"; exit 1; }
expect 200 -X DELETE "$org/api-keys/$id"
i=0
until [ "$(with_key)" = 401 ]; do
  i=$((i + 1))
  [ "$i" -lt 65 ] || { cat "$log"; echo "the API Worker still takes the revoked key" >&2; exit 1; }
  sleep 1
done
echo "401 $api_url/v1/models with the revoked key, after ${i}s"
rm -f "$body"
echo "smoke ok: $url (API Worker at $api_url, state Worker at $state_url)"
