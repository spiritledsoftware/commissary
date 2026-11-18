#!/usr/bin/env bash
# Saves a preview's Access application again, unchanged, once `alchemy deploy` has finished (tools/deploy-stage.sh).
# A preview's app Worker enrolls into the application as a `worker` destination (docs/DEPLOY.md), and Cloudflare did not
# always enforce the application on it: the application listed the Worker, yet its workers.dev URL served without Access
# (the Worker's own 401 where Access answers 302) until the application was saved again after the deploy. Inside the
# deploy the save cannot be ordered after the Worker's last upload, which comes when its Access binding converges.
# The application is read and written back as Cloudflare returns it, less its read-only fields and its SCIM settings
# (whose secret a read masks; the stack sets none); its policies by id. A failed save is tried once more.
# Usage: CLOUDFLARE_API_TOKEN=… CLOUDFLARE_ACCOUNT_ID=… tools/resave-access-application.sh <application id>
set -euo pipefail

id="${1:?usage: resave-access-application.sh <application id>}"
: "${CLOUDFLARE_API_TOKEN:?CLOUDFLARE_API_TOKEN is required}"
: "${CLOUDFLARE_ACCOUNT_ID:?CLOUDFLARE_ACCOUNT_ID is required}"

url="https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/access/apps/$id"
auth=(-H "Authorization: Bearer $CLOUDFLARE_API_TOKEN")

# Reads the application and writes it back; prints Cloudflare's answer to the write, or fails with the answer it got.
resave() {
  local app body
  app="$(curl -sS --max-time 30 "${auth[@]}" "$url")"
  if [ "$(jq -r '.success' <<<"$app" 2>/dev/null)" != true ]; then
    echo "$app"
    return 1
  fi
  body="$(jq '.result | del(.id, .uid, .aud, .created_at, .updated_at, .scim_config) | .policies |= map({id, precedence})' <<<"$app")"
  curl -sS --max-time 30 -X PUT "${auth[@]}" -H 'Content-Type: application/json' --data "$body" "$url"
}

for attempt in 1 2; do
  answer="$(resave || true)"
  if [ "$(jq -r '.success' <<<"$answer" 2>/dev/null)" = true ]; then
    echo "Access application $id saved again ($(jq -c '[.result.destinations[]?.type]' <<<"$answer"))"
    exit 0
  fi
  echo "saving the Access application $id again failed (attempt $attempt/2): $(jq -c '.errors' <<<"$answer" 2>/dev/null || head -c 300 <<<"$answer")"
  sleep 5
done

echo "::error::the Access application $id could not be saved again" >&2
exit 1
