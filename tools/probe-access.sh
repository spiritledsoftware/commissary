#!/usr/bin/env bash
# Throwaway diagnostic: does re-saving pr-469's Access application (unchanged) put Access back in front of its Worker?
set -uo pipefail
api="https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID"
auth=(-H "Authorization: Bearer $CLOUDFLARE_API_TOKEN")
url=https://commissary-commissary-pr-469-mqvvomiq7of4bwrt.ian-g-pascoe.workers.dev/
echo "before: $(curl -sS -o /dev/null -w '%{http_code}' "$url")"
app="$(curl -sS "${auth[@]}" "$api/access/apps?per_page=200" | jq '.result[] | select(.name | startswith("commissary-Access-pr-469"))')"
id="$(jq -r .id <<<"$app")"
body="$(jq '{type, name, destinations, session_duration, app_launcher_visible, allowed_idps, auto_redirect_to_identity, same_site_cookie_attribute, http_only_cookie_attribute, tags, policies: [.policies[] | {id, precedence}]}' <<<"$app")"
curl -sS -X PUT "${auth[@]}" -H 'Content-Type: application/json' "$api/access/apps/$id" --data "$body" | jq -c '{success, errors, destinations: .result.destinations, updated_at: .result.updated_at}'
for i in 1 2 3 4 5 6 7 8 9 10 11 12; do sleep 10; echo "after ${i}0s: $(curl -sS -o /dev/null -w '%{http_code}' "$url")"; done
