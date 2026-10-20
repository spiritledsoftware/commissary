#!/usr/bin/env bash
# The sandbox's computer runs computerd from the image infra/computer/Dockerfile names, and the SandboxSession talks to
# it through the `@cloudflare/computer` packages/tools pins: one protocol, so both must name the same version. Run by
# `pnpm lint` (package.json, "lint:root"), so a bump of one alone does not pass CI.
set -euo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
DOCKERFILE="$ROOT/infra/computer/Dockerfile"
PACKAGE="$ROOT/packages/tools/package.json"

image="$(sed -nE 's#^FROM ghcr\.io/cloudflare/computer-computerd-linux-x64:([^@[:space:]]+)@sha256:.*#\1#p' "$DOCKERFILE")"
package="$(sed -nE 's#^[[:space:]]*"@cloudflare/computer":[[:space:]]*"([^"]+)".*#\1#p' "$PACKAGE")"

if [[ -z "$image" ]]; then
  echo "check-computerd: no 'FROM ghcr.io/cloudflare/computer-computerd-linux-x64:<version>@sha256:<digest>' in" \
    "infra/computer/Dockerfile" >&2
  exit 1
fi
if [[ ! "$package" =~ ^[0-9]+\.[0-9]+\.[0-9]+([-.+][0-9A-Za-z.-]+)?$ ]]; then
  echo "check-computerd: packages/tools/package.json must pin @cloudflare/computer to an exact version" \
    "(found '${package}')" >&2
  exit 1
fi
if [[ "$image" != "$package" ]]; then
  echo "check-computerd: infra/computer/Dockerfile runs computerd $image, but packages/tools pins" \
    "@cloudflare/computer $package. Move both to the same version (the image by digest, its tag in the comment)." >&2
  exit 1
fi
