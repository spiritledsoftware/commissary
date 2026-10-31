#!/usr/bin/env bash
# CI deploy of one stage (.github/workflows/ci.yml): runs `alchemy deploy` with the settings in the environment and
# writes the app Worker's URL to the step output `url` and the URL of the client API to `api_url` (ADR 0028, ADR 0030:
# the API host, a preview's API Worker workers.dev URL, or the same URL, whose client API paths zone routes send to the
# API Worker), and on Commissary Cloud the auth host's to `auth_url` (empty on a self-hosted stage). The control panel
# must be built first (`bun run build`).
# Usage: tools/deploy-stage.sh <stage>
set -euo pipefail

stage="${1:?usage: deploy-stage.sh <stage>}"
log="${RUNNER_TEMP:-/tmp}/deploy-$stage.log"

bun run deploy --stage "$stage" --no-input --yes | tee "$log"

# The deploy ends by printing the stack outputs: `url: 'https://…'` on a line of its own, or inline when the outputs are
# short (`{ url: 'https://…', accessAud: '', … }`).
url="$(sed -nE "s/^.*[{ ]url: '(https:[^']+)'.*$/\1/p" "$log" | tail -n 1)"
api_url="$(sed -nE "s/^.*[{ ]apiUrl: '(https:[^']+)'.*$/\1/p" "$log" | tail -n 1)"
auth_url="$(sed -nE "s/^.*[{ ]authUrl: '(https:[^']+)'.*$/\1/p" "$log" | tail -n 1)"

if [ -z "$url" ]; then
  echo "::error::the deploy printed no url output" >&2
  exit 1
fi

echo "url=$url" >>"${GITHUB_OUTPUT:-/dev/stdout}"
echo "api_url=${api_url:-$url}" >>"${GITHUB_OUTPUT:-/dev/stdout}"
echo "auth_url=$auth_url" >>"${GITHUB_OUTPUT:-/dev/stdout}"
