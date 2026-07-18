# Kubernetes NetworkPolicy across namespaces - and its ceiling

A bare `podSelector` only sees pods in the policy's own namespace. Real apps
span namespaces, so you need a `namespaceSelector` - and the moment you combine
the two, you meet the single most misread rule in the whole API: how peers AND
and OR. We'll protect `prod/database`, admit two specific backends, and then
name the three things this API can't do.

## What you'll learn

- How a `namespaceSelector` lets a rule reach pods in **other** namespaces.
- The **AND-within-a-peer, OR-across-peers** rule - the classic footgun.
- `matchExpressions` set logic (`In`/`NotIn`/`Exists`/`DoesNotExist`).
- The **three hard limits** of a Kubernetes NetworkPolicy.

## The policy

```yaml,copy,exec
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: database-allow-backends
  namespace: prod
spec:
  podSelector:
    matchExpressions:
      - key: app
        operator: In
        values: [database]
  policyTypes:
    - Ingress
  ingress:
    - from:
        - podSelector:
            matchLabels:
              app: backend
        - namespaceSelector:
            matchLabels:
              env: dev
          podSelector:
            matchLabels:
              app: backend
      ports:
        - protocol: TCP
          port: 8080
```

## Reading the `from` list

`from` is a **list of peers**. The rule is:

- **One `-` item** → its selectors are **ANDed**.
- **Separate `-` items** → they are **ORed**.

So here:

- Peer 1 (`podSelector: app=backend`, no `namespaceSelector`) → backends **in
  this namespace**, i.e. `prod/backend`.
- Peer 2 (`namespaceSelector: env=dev` **and** `podSelector: app=backend` in the
  *same* item) → "a backend pod that is also in a dev namespace" = `dev/backend`
  **only**.

`spec.podSelector` uses `matchExpressions` just to show the form: `app In
[backend... ]` equals `matchLabels: {app: database}` here, but `In`/`NotIn`/
`Exists` are how you express what `matchLabels` (exact equality, ANDed) cannot.

## What to observe

**Allowed**

- `prod/backend → prod/database:8080` - peer 1.
- `dev/backend → prod/database:8080` - peer 2, reached across the namespace.

**Denied**

- `dev/frontend → prod/database` - in `dev`, but not a `backend`; peer 2's two
  selectors are ANDed.
- `prod/frontend → prod/database` - not a backend at all.

> **The trap:** split peer 2 onto two `-` items and the meaning explodes from
> "dev/backend only" to "**any** backend **OR every** dev pod" - `dev/frontend`
> would silently gain access. One indentation level is the whole security
> boundary.

```quiz
{
  "question": "In an ingress `from:` block, a namespaceSelector and a podSelector listed under the SAME `-` item match...",
  "options": [
    "pods matching the podSelector OR pods in the matched namespaces (union)",
    "only pods that match the podSelector AND live in a matched namespace (intersection)",
    "every pod in the matched namespaces, ignoring the podSelector"
  ],
  "answer": 1,
  "explain": "Selectors inside one peer item are ANDed (intersection); separate `-` items are ORed. That one distinction decides who gets in."
}
```

## The ceiling

This policy is useful but boxed in. A Kubernetes NetworkPolicy **cannot**:

1. **Express a `Deny`** - you may only enumerate allowed sources; there's no way
   to say "everyone except X."
2. **Order policies** - there's no priority field; you can't make one policy
   win over another.
3. **Leave the namespace** - it can never govern cluster-scoped guardrails or a
   node's own interface.

## Recap

`namespaceSelector` crosses namespaces; AND-within-a-peer vs OR-across-peers
decides exactly who. But there's no `Deny`, no ordering, and no reach beyond a
namespace. The next lesson climbs to the **ClusterNetworkPolicy** - a
cluster-scoped layer that platform teams use to set guardrails the app team's
NetworkPolicy can't override.
