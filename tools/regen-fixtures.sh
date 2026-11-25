#!/usr/bin/env bash
# Regenerates golden fixtures from the reference CLIProxyAPI at a pinned commit: the port target
# (tools/fixturegen/PORT_TARGET) while a port is in progress, else tools/fixturegen/UPSTREAM_COMMIT. Never from the
# shared .repos/CLIProxyAPI checkout, which `pnpm install` fast-forwards. The generators run against a detached worktree
# of the reference clone at that commit, kept in a cache directory and reused, through a throwaway go.work, so the
# shared checkout's HEAD and working tree never move. Writes the fixtures to the same paths as
# `go run ./tools/fixturegen/<name>` (docs/DEVELOPMENT.md, "Golden fixtures").
# The generators run on Linux: Go's Devin executor writes runtime.GOOS into its requests, and Commissary sends "linux".
# On another OS they run in a golang container (Docker), at go.work's Go version.
# Usage: tools/regen-fixtures.sh [--commit <sha>] [<generator>...]   (no generator: all of tools/fixturegen/*/)
# COMMISSARY_REFERENCE_CACHE sets the cache directory (default ${XDG_CACHE_HOME:-~/.cache}/commissary/reference).
set -euo pipefail

# Hooks export GIT_DIR and friends; clear them so nested git calls are clean.
# shellcheck disable=SC2046 # one name per word
unset $(git rev-parse --local-env-vars)
root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"

pin=tools/fixturegen/UPSTREAM_COMMIT
if [[ -f tools/fixturegen/PORT_TARGET ]]; then pin=tools/fixturegen/PORT_TARGET; fi
commit="$(tr -d '[:space:]' <"$pin")"
generators=()
while (($#)); do
  case "$1" in
  --commit)
    commit="${2:?--commit needs a commit}"
    shift 2
    ;;
  -h | --help)
    awk 'NR == 1 { next } !/^#/ { exit } { sub(/^# ?/, ""); print }' "$0"
    exit 0
    ;;
  -*)
    echo "error: unknown option $1" >&2
    exit 2
    ;;
  *)
    generators+=("${1%/}")
    shift
    ;;
  esac
done
if ((${#generators[@]} == 0)); then
  for dir in tools/fixturegen/*/; do
    generators+=("$(basename "$dir")")
  done
fi
for name in "${generators[@]}"; do
  if [[ ! -f "tools/fixturegen/$name/main.go" ]]; then
    echo "error: no generator tools/fixturegen/$name" >&2
    exit 2
  fi
done

# The shared clone (resolving the worktree symlink): only its object store and worktree list are touched.
reference="$(cd .repos/CLIProxyAPI && pwd -P)"
if ! sha="$(git -C "$reference" rev-parse --verify --quiet "$commit^{commit}")"; then
  # Not fetched yet: fetching adds objects and moves no branch, HEAD or file.
  git -C "$reference" fetch --quiet origin "$commit"
  sha="$(git -C "$reference" rev-parse --verify "$commit^{commit}")"
fi

cache="${COMMISSARY_REFERENCE_CACHE:-${XDG_CACHE_HOME:-$HOME/.cache}/commissary/reference}"
pinned="$cache/CLIProxyAPI-$sha"
lock="$cache/.lock.d"
work=""
locked=""
cleanup() {
  if [[ -n "$locked" ]]; then rm -rf "$lock"; fi
  if [[ -n "$work" ]]; then rm -rf "$work"; fi
}
trap cleanup EXIT
mkdir -p "$cache"

# Lanes may regenerate at the same time: one creates the worktree, the others wait and reuse it. mkdir is atomic, so
# the lock works without flock (stock macOS); a lock left by a killed run is taken over once its process is gone.
until mkdir "$lock" 2>/dev/null; do
  holder="$(cat "$lock/pid" 2>/dev/null || true)"
  if [[ -n "$holder" ]] && ! kill -0 "$holder" 2>/dev/null; then
    rm -rf "$lock"
    continue
  fi
  sleep 1
done
locked=1
echo $$ >"$lock/pid"
if [[ "$(git -C "$pinned" rev-parse HEAD 2>/dev/null)" != "$sha" ]]; then
  rm -rf "$pinned"
  git -C "$reference" worktree prune
  git -C "$reference" worktree add --quiet --detach "$pinned" "$sha"
fi
if [[ -n "$(git -C "$pinned" status --porcelain)" ]]; then
  echo "error: $pinned has local changes; remove it to recreate it" >&2
  exit 1
fi
rm -rf "$lock"
locked=""

# The root go.work, with the pinned worktree in place of .repos/CLIProxyAPI. The replace overrides the one in
# tools/fixturegen/go.mod, which points at the shared checkout: without it, Go still reads that checkout's go.mod and
# its requirements can raise the dependency versions the pinned commit builds with.
work="$(mktemp -d)"
go_version="$(awk '$1 == "go" { print $2; exit }' go.work)"
cat >"$work/go.work" <<EOF
go $go_version

use (
	"$pinned"
	"$root/tools/fixturegen"
)

replace github.com/router-for-me/CLIProxyAPI/v8 v8.0.0 => "$pinned"
EOF

echo "Regenerating from CLIProxyAPI ${sha:0:8}: ${generators[*]}"
# The translator fixtures format timestamps in the local zone (TZ=UTC). $name expands in the inner shell.
# shellcheck disable=SC2016
run='set -e; for name; do go run "./tools/fixturegen/$name" >/dev/null; done'
if [[ "$(uname -s)" == Linux ]]; then
  GOWORK="$work/go.work" TZ=UTC bash -c "$run" generate "${generators[@]}"
else
  if ! command -v docker >/dev/null 2>&1; then
    echo "error: the generators need Linux (runtime.GOOS); install Docker to run them in a container" >&2
    exit 1
  fi
  # The same absolute paths inside the container, so go.work and the generators' output paths resolve unchanged.
  docker run --rm \
    -v "$root:$root" -v "$pinned:$pinned:ro" -v "$work:$work" -w "$root" \
    -v commissary-fixturegen-go:/go -e GOCACHE=/go/cache -e GOWORK="$work/go.work" -e TZ=UTC -e GOFLAGS=-buildvcs=false \
    "golang:$go_version" bash -c "$run" generate "${generators[@]}"
fi
