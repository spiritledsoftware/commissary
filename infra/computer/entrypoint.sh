#!/bin/sh
# The computer's entrypoint (infra/computer/Dockerfile): trusts the CA Cloudflare Containers sign intercepted HTTPS
# with, then runs computerd. Every outbound request of the computer is intercepted to its session object, which sends
# it through the sandbox's egress point (ADR 0044); for HTTPS that means a certificate of this CA, which the platform
# places in the container after it starts. Waits for it a short while; without it, HTTPS fails and plain HTTP is
# refused by the egress anyway.
set -eu

CA=/etc/cloudflare/certs/cloudflare-containers-ca.crt

for _ in $(seq 1 50); do
  [ -s "$CA" ] && break
  sleep 0.1
done

if [ -s "$CA" ]; then
  cp "$CA" /usr/local/share/ca-certificates/cloudflare-containers-ca.crt
  update-ca-certificates >/dev/null 2>&1 || echo "computer: could not add the interception CA" >&2
else
  echo "computer: no interception CA at $CA; HTTPS from the computer will fail" >&2
fi

exec /usr/local/bin/computerd "$@"
