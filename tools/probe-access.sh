#!/usr/bin/env bash
# Throwaway diagnostic: the Access applications and Workers of two stages, non-secret fields only.
set -uo pipefail
api="https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID"
auth=(-H "Authorization: Bearer $CLOUDFLARE_API_TOKEN")
apps="$(curl -sS "${auth[@]}" "$api/access/apps?per_page=200")"
workers="$(curl -sS "${auth[@]}" "$api/workers/workers?per_page=100")"
for S in pr-469 "$STAGE"; do
  echo "== app $S"
  jq -S --arg s "commissary-Access-$S" '.result[] | select((.name // "") | startswith($s))' <<<"$apps"
  for w in $(jq -r --arg s "commissary-commissary-$S" '.result[] | select(.name | startswith($s)) | .name' <<<"$workers"); do
    echo "== worker $w"
    jq -S --arg n "$w" '.result[] | select(.name == $n)' <<<"$workers"
    curl -sS "${auth[@]}" "$api/workers/scripts/$w/settings" | jq -S -c '.result | del(.bindings)'
    curl -sS "${auth[@]}" "$api/workers/scripts/$w/subdomain" | jq -S -c '.result'
    curl -sS "${auth[@]}" "$api/workers/scripts/$w/deployments" | jq -S -c '.result.deployments[0] // .result'
  done
done
