#!/usr/bin/env bash
set -euo pipefail
image=${1:?Usage: scripts/smoke-image.sh IMAGE}
docker run --rm "$image" --version
container=$(docker run -d -p 127.0.0.1::8080 "$image")
trap 'docker logs "$container"; docker rm -f "$container"' EXIT
address=$(docker port "$container" 8080/tcp)
# Docker can accept the connection before the server starts listening, then
# reset it. Retry all unsuccessful health probes within a bounded startup window.
ready=false
for ((attempt = 1; attempt <= 20; attempt++)); do
  if curl --fail --silent --show-error --connect-timeout 1 --max-time 2 "http://$address/healthz"; then
    ready=true
    break
  fi
  if ((attempt < 20)); then
    sleep 1
  fi
done
if [[ "$ready" != true ]]; then
  echo "Container did not become healthy after 20 probes" >&2
  exit 1
fi
# Avoid early pipe closure from grep -q on a large response under pipefail.
curl --fail --silent --show-error --connect-timeout 1 --max-time 10 "http://$address/" | grep '<html' >/dev/null
