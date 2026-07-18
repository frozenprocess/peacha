# Peacha editor - Kubernetes deploy (Gateway API)

Exposes `ghcr.io/frozenprocess/peacha-editor:dev` on **https://peacha.frozenspace.eu**.

This is a **single-node k3s** cluster using klipper servicelb (host-port based),
so there can only be ONE Gateway holding ports 80/443. Every app therefore
shares the existing **`postiz-gateway`** (`ice-stuff`, `192.168.200.10`) and is
distinguished by hostname. peacha follows that pattern.

| File | Purpose |
|------|---------|
| `namespace.yaml`   | `peacha` namespace, labeled `shared-gateway-access=true` so its routes are admitted by the shared gateway |
| `deployment.yaml`  | editor Deployment (2 replicas, scratch image, locked-down securityContext) |
| `service.yaml`     | ClusterIP `peacha-editor:8080` |
| `certificate.yaml` | cert-manager Certificate → Secret `peacha-tls` **in ice-stuff** (listener can only ref Secrets in the gateway's namespace) |
| `httproute.yaml`   | HTTPS route on `postiz-gateway` + HTTP→HTTPS redirect, both for `peacha.frozenspace.eu` |

## Storage modes

| Mode | How | Replicas |
|------|-----|----------|
| **SQLite** (default) | `RESULTS_FILE=/data/exam-results.db`, `SHARE_FILE=/data/share-links.db` on the `peacha-data` PVC | 1 (ReadWriteOnce) |
| **PostgreSQL** | Set both env vars to `postgres://user:pass@host/db` DSNs; remove the volumeMount + volume from the Deployment | Unlimited |

To switch to PostgreSQL: store the DSN in a Secret (`peacha-db`), swap the `value:` fields in `deployment.yaml` for `valueFrom: secretKeyRef:` entries, and remove the `data` volumeMount and PVC volume stanza. The PVC can then be deleted.

## Prerequisites (one-time, NOT in kustomize)

### 1. Push the image + GHCR pull secret (private package)

```bash
docker push ghcr.io/frozenprocess/peacha-editor:dev   # if not pushed yet

export KUBECONFIG=~/.kube/config-ovh
kubectl create namespace peacha --dry-run=client -o yaml | kubectl apply -f -
kubectl create secret docker-registry ghcr-pull \
  --namespace peacha \
  --docker-server=ghcr.io \
  --docker-username=frozenprocess \
  --docker-password='<GHCR_TOKEN_with_read:packages>' \
  --docker-email=reza@tigera.io
```

### 2. OAuth credentials secret (exam certification gate)

Login is gated to a GitHub org / Slack workspace; the app credentials live in a
`peacha-oauth` Secret created out-of-band (the Deployment references it with
`optional: true`, so it applies fine before the secret exists - a missing
credential just disables that provider). See `secret.example.yaml` for the shape.

```bash
kubectl -n peacha create secret generic peacha-oauth \
  --from-literal=slack-client-id='<SLACK_CLIENT_ID>' \
  --from-literal=slack-client-secret='<SLACK_CLIENT_SECRET>' \
  --from-literal=github-client-id='<GITHUB_CLIENT_ID>' \
  --from-literal=github-client-secret='<GITHUB_CLIENT_SECRET>'
```

Then set the **non-secret** gate values in `deployment.yaml`: `AUTH_BASE_URL`
(public HTTPS origin - must match each provider app's redirect URI
`<AUTH_BASE_URL>/v1/auth/callback/{slack,github}`), `SLACK_TEAM`, and
`GITHUB_ORG`. Rotate credentials by recreating the secret and restarting:
`kubectl -n peacha rollout restart deploy/peacha-editor`.

### 3. DNS

Point an A record at the shared gateway IP:

```
peacha.frozenspace.eu   A   192.168.200.10
```

### 4. Fix the cluster's ACME issuer (required for ANY cert to issue)

The `letsencrypt` ClusterIssuer's http-01 solver references a gateway that no
longer exists (`calico-demo-gw/default`), so cert issuance is currently broken
cluster-wide (the existing `secure-demo-cert` is expired). Repoint the solver at
the live shared gateway:

```bash
kubectl patch clusterissuer letsencrypt --type=json -p='[
  {"op":"replace","path":"/spec/acme/solvers/0/http01/gatewayHTTPRoute/parentRefs",
   "value":[{"group":"gateway.networking.k8s.io","kind":"Gateway","name":"postiz-gateway","namespace":"ice-stuff"}]}
]'
```

### 5. Add the peacha cert to the shared gateway's HTTPS listener

The listener serves certs by SNI; append `peacha-tls` to its `certificateRefs`:

```bash
kubectl -n ice-stuff patch gateway postiz-gateway --type=json -p='[
  {"op":"add","path":"/spec/listeners/1/tls/certificateRefs/-",
   "value":{"group":"","kind":"Secret","name":"peacha-tls"}}
]'
# (listener index 1 = the https listener; verify with:
#  kubectl -n ice-stuff get gateway postiz-gateway -o jsonpath='{.spec.listeners[*].name}')
```

## Deploy

```bash
export KUBECONFIG=~/.kube/config-ovh
kubectl apply -k deploy/k8s
```

## Verify

```bash
kubectl -n peacha get pods,svc,httproute
kubectl -n ice-stuff get certificate peacha-tls          # want Ready=True
kubectl -n ice-stuff get gateway postiz-gateway          # PROGRAMMED=True
curl -I https://peacha.frozenspace.eu/healthz            # -> 200, body "ok"
curl -I http://peacha.frozenspace.eu/                    # -> 301 to https
```
