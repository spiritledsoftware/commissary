#!/usr/bin/env bash
# Throwaway diagnostic: the stage's Access applications and Workers, non-secret fields only.
set -uo pipefail
api="https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID"
auth=(-H "Authorization: Bearer $CLOUDFLARE_API_TOKEN")
echo "== access apps matching $STAGE"
curl -sS "${auth[@]}" "$api/access/apps?per_page=200" | jq --arg s "$STAGE" '.success, (.result[] | select((.name // "") | test($s)) | {id, name, type, domain, self_hosted_domains, destinations, aud, updated_at, policies: [.policies[]? | {id, name, decision}]})'
echo "== all apps with worker destinations (names + destinations)"
curl -sS "${auth[@]}" "$api/access/apps?per_page=200" | jq '[.result[] | select(any(.destinations[]?; (.type // "") | test("worker"))) | {name, destinations}] | length, .[0:5]'
for S in pr-469 pr-470; do echo "== workers $S"; curl -sS "${auth[@]}" "$api/workers/workers?per_page=100" | jq -c --arg s "$S" '.result[]? | select((.name // "") | test($s)) | {id, name, created_on, updated_on}'; done
echo "== workers matching $STAGE"
curl -sS "${auth[@]}" "$api/workers/workers?per_page=100" | jq --arg s "$STAGE" '.success, .errors, (.result[]? | select((.name // "") | test($s)) | {id, name, subdomain, created_on, updated_on})'
for w in $(curl -sS "${auth[@]}" "$api/workers/scripts" | jq -r --arg s "$STAGE" '.result[] | select(.id | test($s)) | .id'); do
  echo "== script $w subdomain"; curl -sS "${auth[@]}" "$api/workers/scripts/$w/subdomain" | jq -c '.result, .errors'
done
