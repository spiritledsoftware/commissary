#!/usr/bin/env bash
# oxlint with tsrslint (`@maschwenk/tsrslint`, tsgolint's rules ported to Rust on tsrs) as its type-aware backend in
# place of oxlint-tsgolint, until tsrs ships a backend of its own (oxc-project/tsrs#378; ADR 0047). oxlint runs the
# backend OXLINT_TSGOLINT_PATH names, which `tsrslint-path` prints. Run by `bun run lint` (package.json, "lint:root")
# and lint-staged; arguments pass through to oxlint.
set -euo pipefail

BIN="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)/node_modules/.bin"

OXLINT_TSGOLINT_PATH="$("$BIN/tsrslint-path")"
export OXLINT_TSGOLINT_PATH
exec "$BIN/oxlint" "$@"
