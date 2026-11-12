#!/usr/bin/env bash
# `vp lint` (Vite+'s oxlint, configured by `lint` in vite.config.ts) with tsrslint (`@maschwenk/tsrslint`, tsgolint's
# rules ported to Rust on tsrs) as its type-aware backend in place of the oxlint-tsgolint Vite+ bundles, until tsrs
# ships a backend of its own (oxc-project/tsrs#378; ADR 0047, ADR 0049). oxlint runs the backend OXLINT_TSGOLINT_PATH
# names, which `tsrslint-path` prints; Vite+ sets the variable only when the caller has not. Run by `pnpm run lint`
# (package.json, "lint") and `vp staged`; arguments pass through to `vp lint`.
set -euo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"

if ! OXLINT_TSGOLINT_PATH="$("$ROOT/node_modules/.bin/tsrslint-path")"; then
  echo "oxlint.sh: no tsrslint binary; run \`pnpm install\`. tsrslint ships for macOS arm64 and glibc Linux on x64 and" \
    "arm64 only (docs/DEVELOPMENT.md, \"Lint and format\")" >&2
  exit 1
fi
export OXLINT_TSGOLINT_PATH
exec "$ROOT/node_modules/.bin/vp" lint "$@"
