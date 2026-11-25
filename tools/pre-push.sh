#!/usr/bin/env bash
# The pre-push hook's targeted checks (.vite-hooks/pre-push, docs/DEVELOPMENT.md "Git hooks"): format and lint the files
# the pushed branch changes, and typecheck the packages it touches. Several agents share a machine, so nothing here is
# repo-wide: CI runs the full typecheck, lint, tests and smoke test on every pull request.
# Reads git's pre-push lines (<local ref> <local sha> <remote ref> <remote sha>) on stdin and checks every file that
# differs between each pushed commit and its merge base with the default branch, as the working tree has it.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

zero="0000000000000000000000000000000000000000"
default="$(git symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null || echo origin/main)"

files=()
while read -r _local_ref local_sha _remote_ref _remote_sha; do
  # A deleted branch pushes nothing to check.
  [[ "$local_sha" == "$zero" ]] && continue
  base="$(git merge-base "$local_sha" "$default" 2>/dev/null || true)"
  [[ -z "$base" ]] && continue
  while IFS= read -r file; do
    [[ -f "$file" ]] && files+=("$file")
  done < <(git diff --name-only --diff-filter=ACMR "$base" "$local_sha")
done
if ((${#files[@]} == 0)); then
  exit 0
fi
# Deduplicated without mapfile, which macOS's bash 3.2 lacks.
unique=()
while IFS= read -r file; do
  unique+=("$file")
done < <(printf '%s\n' "${files[@]}" | sort -u)
files=("${unique[@]}")

pnpm exec vp fmt --check --no-error-on-unmatched-pattern "${files[@]}"

scripts=()
for file in "${files[@]}"; do
  case "$file" in
  *.ts | *.tsx | *.mts | *.cts | *.js | *.jsx | *.mjs | *.cjs) scripts+=("$file") ;;
  esac
done
if ((${#scripts[@]} > 0)); then
  pnpm exec vp lint --quiet "${scripts[@]}"
fi

# The workspace packages the files belong to (apps/<name>, packages/<name>), and the root's deploy code
# (tsconfig.infra.json's program).
packages=()
infra=""
for file in "${files[@]}"; do
  case "$file" in
  apps/*/* | packages/*/*)
    dir="$(cut -d/ -f1-2 <<<"$file")"
    [[ -f "$dir/package.json" ]] && packages+=("$dir")
    ;;
  alchemy.run.ts | infra/* | stacks/* | tools/sync-*.ts | tools/oxlint/boundaries/* | tools/vitest/* | tsconfig*.json)
    infra=1
    ;;
  esac
done
if ((${#packages[@]} > 0)); then
  while IFS= read -r dir; do
    if jq -e '.scripts.typecheck' "$dir/package.json" >/dev/null; then
      echo "typecheck $dir"
      pnpm --dir "$dir" run --silent typecheck
    fi
  done < <(printf '%s\n' "${packages[@]}" | sort -u)
fi
if [[ -n "$infra" ]]; then
  echo "typecheck the deploy code"
  pnpm exec vp run --cache typecheck:root
fi
