# The sandbox's computer (ADR 0041, #223): the image `COMMISSARY_COMPUTER=on` attaches to the `SandboxSession` class
# (alchemy.run.ts). Barebones by design: computerd (`@cloudflare/computer`'s daemon, which mounts the session's
# Workspace at /workspace over FUSE and runs its commands), mise, and what mise needs to download and unpack runtimes.
# No runtime is preinstalled: a session installs what it needs with mise (`mise use node@22`), under /workspace/.mise,
# so it lasts as long as the session's files (packages/tools/src/sandbox/cloudflare/computer.ts).
#
# What is pinned: both images by digest (their tags in the comments; Dependabot's `docker` updates move them), computerd's
# to the `@cloudflare/computer` version in packages/tools/package.json (they speak one protocol: tools/check-computerd.sh,
# run with `bun run lint`, fails when they differ, so a bump of one alone does not pass); mise to a release and its
# checksum. The Debian packages are not pinned one by one: they are what the pinned base's release (trixie) has when the
# image is built.

# ghcr.io/cloudflare/computer-computerd-linux-x64:0.5.1
FROM ghcr.io/cloudflare/computer-computerd-linux-x64:0.5.1@sha256:63b743262f9e854bde861c5d4a08fb57539012997f6b9e7d231cb32667c65c6a AS computerd

# debian:trixie-slim
FROM debian:trixie-slim@sha256:a29215f6a35e51e22adffa17f89e9d2ef06214e64a2bad10d765c46aea49f11f

# FUSE for computerd's mount (fuse3, and libfuse2t64 for its libfuse 2 binding); CA certificates and curl for mise's
# downloads; the unpackers of the runtimes' archives: xz-utils for Node.js's (.tar.xz), gzip for Python's
# (python-build-standalone) and Go's (.tar.gz), unzip for Deno's and Bun's (.zip); mise unpacks its core tools itself,
# but its plugins and the commands themselves (npm, pip) call these. bash, the shell computerd runs commands with
# (`EXEC_SHELL`); git, which just-bash's sandbox lacks (its fetches go through the egress point too).
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      fuse3 libfuse2t64 ca-certificates curl tar gzip xz-utils unzip bash git \
 && rm -rf /var/lib/apt/lists/*

# mise, the static (musl) build, checked against the release's digest.
ARG MISE_VERSION=2026.10.15
ARG MISE_SHA256=5daa5f70c1588bb27ffecb275b46dbafcab0f6fc93a893138ba4d8cae6074b60
RUN curl -fsSL -o /usr/local/bin/mise \
      "https://github.com/jdx/mise/releases/download/v${MISE_VERSION}/mise-v${MISE_VERSION}-linux-x64-musl" \
 && echo "${MISE_SHA256}  /usr/local/bin/mise" | sha256sum -c - \
 && chmod 0755 /usr/local/bin/mise

COPY --from=computerd /usr/local/bin/computerd /usr/local/bin/computerd
COPY entrypoint.sh /usr/local/bin/computer-entrypoint
RUN chmod 0755 /usr/local/bin/computer-entrypoint

# computerd's defaults: HTTP and WebSocket on :8080, the FUSE mount at MOUNT_POINT. FUSE_MOUNT=auto picks real FUSE on
# Cloudflare Containers, which expose /dev/fuse.
ENV PORT=8080
ENV MOUNT_POINT=/workspace
ENV FUSE_MOUNT=auto
EXPOSE 8080

ENTRYPOINT ["/usr/local/bin/computer-entrypoint"]
