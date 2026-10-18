# Kubernetes deployment

The manifests target namespace `peacha`, hostname `peacha.frozenspace.eu`, and
HTTP listener `http` on Gateway `ice-stuff/postiz-gateway`. TLS terminates at
Cloudflare; these manifests do not create a Certificate or HTTPS listener.
Adjust `httproute.yaml` for another installation. Configure DNS and the edge
proxy for your gateway's reachable address before deploying.

The Deployment uses one replica, a non-root scratch image, a read-only root
filesystem, and a writable PVC for SQLite. Its `Recreate` strategy stops the old
pod before starting the new writer; upgrades have a brief outage. ReadWriteOnce
alone does not prevent multiple pods on the same node from using the volume.

## Initial setup

Select the intended kubectl context. Provision a Gateway with the named HTTP
listener and permission to accept routes from the `peacha` namespace, plus a
default StorageClass for `pvc.yaml`.

```sh
kubectl apply -f deploy/k8s/namespace.yaml
# Required only for a private GHCR package. Supply your read:packages token.
kubectl -n peacha create secret docker-registry ghcr-pull \
  --docker-server=ghcr.io --docker-username=YOUR_USER \
  --docker-password=YOUR_TOKEN
```

Create optional OAuth credentials using the shape in `secret.example.yaml`.
They are deliberately excluded from Kustomize. Set non-secret auth settings in
ConfigMap `peacha-config`: `auth-base-url`, `slack-team`, `slack-workspace-url`,
`github-org`, and optionally `exams-disabled`. The deployment documents each key.
Create Secret `peacha-session` with key `session-secret` to preserve sessions
across restarts. Missing OAuth credentials disable their providers.

## Release and rollback

Copy the image digest from the successful publish job's summary. The base
manifest deliberately uses `:release-required`; always deploy through this
command, which renders a digest-pinned image and waits for readiness:

```sh
bash deploy/k8s/deploy.sh ghcr.io/frozenprocess/peacha-editor@sha256:YOUR_DIGEST
curl --fail https://peacha.frozenspace.eu/healthz
curl --fail https://peacha.frozenspace.eu/v1/version
```

Append `--dry-run` to render the exact manifests without accessing the cluster.

Record the deployed digest. To roll back, run the same command with the prior
known-good digest. Check database compatibility before rolling back a release
that changes stored data. Image publication does not deploy or restart pods.
The rollout command reports failures; inspect pod logs/events before proceeding.

## Storage

By default `RESULTS_FILE` and `SHARE_FILE` point to SQLite files under `/data`.
For PostgreSQL, put both DSNs in a Secret, change those environment variables to
Secret references, and remove the PVC volume and mount. You can then configure
multiple replicas and a rolling strategy; keep `SESSION_SECRET` consistent.

```sh
make pull-db
make pull-links-db
```

These helpers copy the SQLite files and sidecars using a temporary pod because
scratch contains no shell or tar. For a consistent backup, stop writes or use a
SQLite-aware backup procedure; copying active database files is not a snapshot.
