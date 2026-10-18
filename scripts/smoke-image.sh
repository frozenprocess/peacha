#!/usr/bin/env bash
set -euo pipefail
image=${1:?Usage: scripts/smoke-image.sh IMAGE}
docker run --rm "$image" --version
container=$(docker run -d -p 127.0.0.1::8080 "$image")
trap 'docker logs "$container"; docker rm -f "$container"' EXIT
address=$(docker port "$container" 8080/tcp)
curl --fail --retry 20 --retry-connrefused --retry-delay 1 "http://$address/healthz"
# Avoid early pipe closure from grep -q on a large response under pipefail.
curl --fail "http://$address/" | grep '<html' >/dev/null
