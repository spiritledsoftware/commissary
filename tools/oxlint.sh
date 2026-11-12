#!/usr/bin/env bash
# `vp lint` (Vite+'s oxlint, configured by `lint` in vite.config.ts) with tsrs's own type-aware backend, `tsrs-lint`
# (`tsrs --lint`, shipped in the `tsrs` package), in place of the oxlint-tsgolint Vite+ bundles (ADR 0047, ADR 0049,
# ADR 0050). oxlint runs the backend OXLINT_TSGOLINT_PATH names; Vite+ sets the variable only when the caller has not.
# Run by `pnpm run lint` (package.json, "lint") and `vp staged`; arguments pass through to `vp lint`.
set -euo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"

OXLINT_TSGOLINT_PATH="$ROOT/node_modules/.bin/tsrs-lint"
if [ ! -x "$OXLINT_TSGOLINT_PATH" ]; then
  echo "oxlint.sh: no tsrs-lint in node_modules/.bin; run \`pnpm install\`" >&2
  exit 1
fi
export OXLINT_TSGOLINT_PATH
exec "$ROOT/node_modules/.bin/vp" lint "$@"
