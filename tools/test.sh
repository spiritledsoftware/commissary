#!/bin/sh
# `pnpm run test`: every package's `test` script through Vite Task (`vp run`), with a local budget (docs/DEVELOPMENT.md,
# "Tests"). The root is left out (its own `test` script is this one). The packages are source-only, so their tests
# need nothing of each other's and run in any order (`--parallel`). Locally only COMMISSARY_TEST_PACKAGES packages
# (default 2) test at once, and each package's Vitest gets about the cores divided by that many workers
# (tools/vitest/test-workers.ts; COMMISSARY_TEST_WORKERS sets it outright): a run uses about the machine's cores, not
# 10 packages times Vitest's cores - 1. With CI set (GitHub Actions) 10 packages test at once and Vitest keeps its
# default workers. Arguments (CI's --shard=N/3) go on to every package's run. The scripts are not cached: a cached task
# runs in a cleaned environment, without those variables.
# Usage: pnpm run test [<vitest arguments>]
set -eu
cd "$(dirname "$0")/.."
if [ -n "${CI:-}" ]; then
  packages=10
else
  COMMISSARY_TEST_PACKAGES="${COMMISSARY_TEST_PACKAGES:-2}"
  export COMMISSARY_TEST_PACKAGES
  packages="$COMMISSARY_TEST_PACKAGES"
fi
exec pnpm exec vp run --filter "./apps/*" --filter "./packages/*" --parallel --concurrency-limit "$packages" test "$@"
