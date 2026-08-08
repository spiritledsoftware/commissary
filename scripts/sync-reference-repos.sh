#!/bin/sh

set -eu

repo_root=$(git rev-parse --show-toplevel)
reference_root="$repo_root/.repos"

mkdir -p "$reference_root"

sync_repo() {
  name=$1
  url=$2
  reference=$3
  path="$reference_root/$name"

  if [ ! -e "$path" ]; then
    printf 'Cloning %s reference repository...\n' "$name"
    git clone --quiet --depth 1 --no-checkout "$url" "$path"
    git -C "$path" fetch --quiet --depth 1 origin "$reference"
    git -C "$path" checkout --quiet --detach FETCH_HEAD
    return
  fi

  if ! actual_url=$(git -C "$path" remote get-url origin 2>/dev/null); then
    printf 'error: %s exists but is not a Git repository with an origin remote\n' "$path" >&2
    return 1
  fi

  if [ "$actual_url" != "$url" ]; then
    printf 'error: %s has unexpected origin %s (expected %s)\n' "$path" "$actual_url" "$url" >&2
    return 1
  fi

  if [ -n "$(git -C "$path" status --porcelain)" ]; then
    printf 'error: %s has local changes; preserve or discard before syncing\n' "$path" >&2
    return 1
  fi

  printf 'Updating %s reference repository...\n' "$name"
  git -C "$path" fetch --quiet --prune origin "$reference"
  git -C "$path" checkout --quiet --detach FETCH_HEAD
}

sync_repo effect https://github.com/Effect-TS/effect.git main
sync_repo opencode https://github.com/anomalyco/opencode.git dev
sync_repo better-auth https://github.com/better-auth/better-auth.git main
sync_repo drizzle-orm https://github.com/drizzle-team/drizzle-orm.git main
sync_repo pi-mono https://github.com/badlogic/pi-mono.git main
sync_repo vercel-ai https://github.com/vercel/ai.git main
sync_repo tanstack-ai https://github.com/TanStack/ai.git main
sync_repo hermes-agent https://github.com/NousResearch/hermes-agent.git main
sync_repo hono https://github.com/honojs/hono.git main
sync_repo flue https://github.com/withastro/flue.git main
sync_repo eve https://github.com/vercel/eve.git main
sync_repo agents https://github.com/cloudflare/agents.git main
