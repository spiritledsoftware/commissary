#!/bin/sh
# `bun run test`: Turborepo's `test` task over every package, with a local budget (docs/DEVELOPMENT.md, "Tests").
# Locally only COMMISSARY_TEST_PACKAGES packages (default 2) test at once, and each package's Vitest gets about the
# cores divided by that many workers (tools/vitest/test-workers.ts; COMMISSARY_TEST_WORKERS sets it outright): a run
# uses about the machine's cores, not turbo's 10 packages times Vitest's cores - 1. With CI set (GitHub Actions) turbo
# keeps its default concurrency and Vitest its default workers. Arguments (CI's --shard=N/3) go on to every package's
# run.
# Usage: bun run test [<vitest arguments>]
set -eu
cd "$(dirname "$0")/.."
if [ -n "${CI:-}" ]; then
  exec bunx turbo run test -- "$@"
fi
COMMISSARY_TEST_PACKAGES="${COMMISSARY_TEST_PACKAGES:-2}"
export COMMISSARY_TEST_PACKAGES
exec bunx turbo run test --concurrency="$COMMISSARY_TEST_PACKAGES" -- "$@"
