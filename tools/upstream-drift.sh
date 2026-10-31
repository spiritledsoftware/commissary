#!/usr/bin/env bash
# Reports upstream CLIProxyAPI changes not yet ported: syncs the reference checkout, regenerates every golden fixture
# from it, runs the test suite against them and writes a Markdown report (upstream commits since
# tools/fixturegen/UPSTREAM_COMMIT, test files that fail on the new fixtures). Changed fixture files are not listed:
# many contain generated ids that differ on every run (the tests mask them). Exit status 0 = no drift, 10 = drift,
# anything else = error. Leaves the regenerated fixtures in the working tree. Usage: tools/upstream-drift.sh [report.md]
set -euo pipefail
cd "$(dirname "$0")/.."

report="${1:-/dev/stdout}"
reference=.repos/CLIProxyAPI
ported="$(tr -d '[:space:]' <tools/fixturegen/UPSTREAM_COMMIT)"

tools/sync-reference-repos.sh >/dev/null
head="$(git -C "$reference" rev-parse HEAD)"

for generator in tools/fixturegen/*/; do
  # The translator fixtures format timestamps in the local zone.
  TZ=UTC go run "./${generator%/}" >/dev/null
done

commits="$(git -C "$reference" log --no-merges --format='- [`%h`](https://github.com/router-for-me/CLIProxyAPI/commit/%H) %s' "$ported..$head")"
# The packages whose tests read fixtures (tools/fixturegen writes into each of them).
failing=""
for package in packages/json packages/translation apps/app; do
  results="$(mktemp)"
  (cd "$package" && bunx vitest run --reporter=json --outputFile="$results") >/dev/null 2>&1 || true
  failing+="$(jq -r --arg root "$PWD/" '.testResults[] | select(.status != "passed") | "- `" + (.name | ltrimstr($root)) + "`"' "$results")"$'\n'
  rm -f "$results"
done
failing="$(printf '%s' "$failing" | sed '/^$/d')"

if [[ -z "$commits" && -z "$failing" ]]; then
  echo "No upstream drift: the fixtures match ${head:0:8}." >"$report"
  exit 0
fi

{
  echo "Upstream \`main\` is at [\`${head:0:8}\`](https://github.com/router-for-me/CLIProxyAPI/commit/$head);"
  echo "the fixtures were last generated from [\`${ported:0:8}\`](https://github.com/router-for-me/CLIProxyAPI/commit/$ported)."
  echo
  echo "### Commits to review"
  echo
  echo "${commits:-None (fixture changes only).}"
  echo
  echo "### Test files failing on the regenerated fixtures"
  echo
  echo "${failing:-None: the new commits do not change any behaviour covered by the fixtures.}"
  echo
  echo "To port: \`bun run repos:sync\`, regenerate (\`tools/upstream-drift.sh\`), port the Go changes until \`bun run test\`"
  echo "passes with the new fixtures, then set \`tools/fixturegen/UPSTREAM_COMMIT\` to the reference commit."
} >"$report"
exit 10
