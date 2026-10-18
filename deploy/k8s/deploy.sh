#!/usr/bin/env bash
set -euo pipefail
# Explicit deployment only; publishing never changes the cluster.
image=${1:?Usage: deploy/k8s/deploy.sh registry/image@sha256:digest}
[[ "$image" =~ ^[a-z0-9][a-z0-9./:_-]*@sha256:[a-f0-9]{64}$ ]] || {
  echo 'Supply a fully qualified image pinned to a sha256 digest.' >&2
  exit 1
}
root=$(cd "$(dirname "$0")" && pwd)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
cp "$root"/*.yaml "$work/"
cat >> "$work/kustomization.yaml" <<YAML
images:
  - name: ghcr.io/frozenprocess/peacha-editor
    newName: ${image%@*}
    digest: ${image#*@}
YAML
if [[ "${2:-}" == --dry-run ]]; then
  kubectl kustomize "$work"
  exit 0
fi
[[ $# == 1 ]] || { echo "Unknown argument: $2" >&2; exit 1; }
kubectl apply -k "$work"
kubectl -n peacha rollout status deployment/peacha-editor --timeout=180s
kubectl -n peacha get pods -l app.kubernetes.io/name=peacha -o wide
