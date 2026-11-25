#!/usr/bin/env bash
# The pre-push hook's targeted checks (.vite-hooks/pre-push, docs/DEVELOPMENT.md "Git hooks"): format and lint the files
# the pushed branch changes, and typecheck the packages it touches. Several agents share a machine, so nothing here is
# repo-wide: CI runs the full typecheck, lint, tests and smoke test on every pull request.
# Reads git's pre-push lines (<local ref> <local sha> <remote ref> <remote sha>) on stdin and checks the files that differ
# between each pushed commit and its merge base with the default branch. The checks read the working tree, so a pushed
# commit other than HEAD is left to CI.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

zero="0000000000000000000000000000000000000000"
default="$(git symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null || echo origin/main)"
head="$(git rev-parse HEAD)"

changed=()
while read -r _local_ref local_sha _remote_ref _remote_sha; do
  # A deleted branch pushes nothing to check.
  [[ "$local_sha" == "$zero" ]] && continue
  if [[ "$local_sha" != "$head" ]]; then
    echo "pre-push: ${local_sha:0:8} is not the checked-out HEAD; its checks are left to CI" >&2
    continue
  fi
  if ! base="$(git merge-base "$local_sha" "$default" 2>/dev/null)"; then
    echo "pre-push: no merge base with $default; its checks are left to CI" >&2
    continue
  fi
  diff="$(git diff --name-only --diff-filter=ACMRD "$base" "$local_sha")"
  while IFS= read -r file; do
    [[ -n "$file" ]] && changed+=("$file")
  done <<<"$diff"
done
if ((${#changed[@]} == 0)); then
  exit 0
fi
if [[ -n "$(git status --porcelain -- "${changed[@]}")" ]]; then
  echo "pre-push: uncommitted changes in the pushed files; checking the working tree as it is" >&2
fi

# Deduplicated without mapfile, which macOS's bash 3.2 lacks. Deleted files still count towards their package's
# typecheck; only files that exist are formatted and linted.
files=()
present=()
scripts=()
while IFS= read -r file; do
  files+=("$file")
  [[ -f "$file" ]] || continue
  present+=("$file")
  case "$file" in
  *.ts | *.tsx | *.mts | *.cts | *.js | *.jsx | *.mjs | *.cjs) scripts+=("$file") ;;
  esac
done < <(printf '%s\n' "${changed[@]}" | sort -u)

if ((${#present[@]} > 0)); then
  pnpm exec vp fmt --check --no-error-on-unmatched-pattern "${present[@]}"
fi
if ((${#scripts[@]} > 0)); then
  pnpm exec vp lint --quiet --no-error-on-unmatched-pattern "${scripts[@]}"
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
    if node -e 'process.exit(require(process.argv[1]).scripts?.typecheck ? 0 : 1)' "$PWD/$dir/package.json"; then
      echo "pre-push: typecheck $dir"
      pnpm --dir "$dir" run --silent typecheck
    fi
  done < <(printf '%s\n' "${packages[@]}" | sort -u)
fi
if [[ -n "$infra" ]]; then
  echo "pre-push: typecheck the deploy code"
  pnpm exec vp run --cache typecheck:root
fi
