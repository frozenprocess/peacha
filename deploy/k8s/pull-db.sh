#!/usr/bin/env bash
# Download a SQLite store (default: the short-link db) from the k8s deployment.
#
#   deploy/k8s/pull-db.sh [db-file] [out-dir]
#   deploy/k8s/pull-db.sh                                  # share-links.db -> ./k8s-db/
#   deploy/k8s/pull-db.sh exam-results.db ./backup
#   deploy/k8s/pull-db.sh all                              # every *.db on the PVC
#
# The editor image is scratch (no shell, no tar), so `kubectl cp` can't read
# from it. Instead this starts a throwaway busybox pod on the editor's node
# that mounts the peacha-data PVC read-only, tars <db-file> (or every *.db for
# "all") plus the -wal/-shm sidecars out of it, then deletes the pod. RWO
# volumes are per-node, so the helper can share the mount with the running
# editor on the same node.
#
# The WAL sidecars are copied alongside the db; SQLite replays them the first
# time the local copy is opened, so recent writes are not lost.
#
# Honors KUBECONFIG / kubectl context as usual. Override NAMESPACE, PVC,
# HELPER_IMAGE via env.
set -euo pipefail

DB="${1:-share-links.db}"
OUT="${2:-./k8s-db}"
NAMESPACE="${NAMESPACE:-peacha}"
PVC="${PVC:-peacha-data}"
HELPER_IMAGE="${HELPER_IMAGE:-busybox:1.36}"
POD="peacha-db-pull-$$"
SELECTOR="app.kubernetes.io/name=peacha,app.kubernetes.io/component=editor"

k() { kubectl -n "$NAMESPACE" "$@"; }

node=$(k get pod -l "$SELECTOR" -o jsonpath='{.items[0].spec.nodeName}')
[ -n "$node" ] || { echo "no running editor pod found in namespace $NAMESPACE" >&2; exit 1; }

cleanup() { k delete pod "$POD" --ignore-not-found --wait=false >/dev/null; }
trap cleanup EXIT

echo ">> starting helper pod $POD on node $node (PVC $PVC read-only)"
k run "$POD" --image="$HELPER_IMAGE" --restart=Never --overrides="$(cat <<EOF
{
  "apiVersion": "v1",
  "spec": {
    "nodeName": "$node",
    "securityContext": {
      "runAsNonRoot": true, "runAsUser": 65534, "runAsGroup": 65534,
      "seccompProfile": {"type": "RuntimeDefault"}
    },
    "containers": [{
      "name": "pull",
      "image": "$HELPER_IMAGE",
      "command": ["sleep", "600"],
      "securityContext": {
        "allowPrivilegeEscalation": false,
        "readOnlyRootFilesystem": true,
        "capabilities": {"drop": ["ALL"]}
      },
      "volumeMounts": [{"name": "data", "mountPath": "/data", "readOnly": true}]
    }],
    "volumes": [{"name": "data", "persistentVolumeClaim": {"claimName": "$PVC", "readOnly": true}}]
  }
}
EOF
)" >/dev/null
k wait --for=condition=Ready "pod/$POD" --timeout=120s >/dev/null

mkdir -p "$OUT"
[ "$DB" = all ] && what="*.db" || what="$DB*"
echo ">> copying /data/$what -> $OUT/"
# Single tar stream so each db and its WAL are captured together; sidecars are
# optional (absent after a clean checkpoint).
k exec "$POD" -- sh -c '
  cd /data
  if [ "$1" = all ]; then set -- $(ls *.db 2>/dev/null); else set -- "$1"; fi
  [ $# -gt 0 ] || { echo "no *.db found on PVC" >&2; exit 1; }
  files=""
  for db in "$@"; do
    [ -f "$db" ] || { echo "/data/$db not found on PVC" >&2; exit 1; }
    files="$files $db $(ls "$db-wal" "$db-shm" 2>/dev/null)"
  done
  tar cf - $files
' sh "$DB" | tar xvf - -C "$OUT"

echo ">> done: $OUT/"
