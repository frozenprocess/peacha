# ClusterNetworkPolicy: the Admin tier

Earlier tutorials left us with a Kubernetes NetworkPolicy that can't explicitly
deny, can't order, and can't reach past its namespace. The
**ClusterNetworkPolicy** fixes all three: it gives the *platform* team a
cluster-wide layer **above** every app team's NetworkPolicy. This lesson covers
its top tier, **`Admin`** - where platform teams set boundaries a namespace owner
can't override, and delegate everything else.

## What you'll learn

- What the cluster-scoped **Network Policy API** adds over a NetworkPolicy.
- How an **`Admin`** policy's `Accept`/`Deny` is **final** - a boundary app teams
  can't undo.
- How **`Pass`** delegates a decision down to the developer's `NetworkPolicy`.

## What is Cluster Network Policy?

Cluster network policy is the upcoming community effort to bridge the gap that was left by NetworkPolicy. This unique resource changes the flat security design of Kubernetes and split it into a multi layer security enforcement posture.

It comes from the upstream **Network Policy API** (`policy.networking.k8s.io/v1alpha2`), a different API group from the `networking.k8s.io` NetworkPolicy you've used so far. In `v0.2` that API folds the admin and baseline layers into a **single `ClusterNetworkPolicy` kind** with a `tier` field that decides which layer a policy belongs to. Before you meet the YAML, here is everything it adds on top of a namespaced `NetworkPolicy`:

| | NetworkPolicy | ClusterNetworkPolicy |
|---|---|---|
| **Scope** | one namespace | **cluster-wide** |
| **What it governs** | `spec.podSelector` (local pods) | **`spec.subject`** — `namespaces` or `pods`, anywhere |
| **Layering** | flat, single tier | **`spec.tier: Admin` or `Baseline`** |
| **Ordering** | none | **`spec.priority`** within the tier |
| **Actions** | allow-only | **`Accept`, `Deny`, `Pass`** |
| **Rules** | anonymous | **named** (`name:` per rule) |
| **Peers** | `podSelector` / `ipBlock` | `namespaces`, `pods`, and egress-only **`networks`** (CIDRs) |

The additions, field by field:

- **`spec.subject`** — who the policy governs, cluster-wide. Either `namespaces` (a label selector over namespaces) or `pods` (a `namespaceSelector` + `podSelector` pair). Both use Kubernetes `matchLabels` / `matchExpressions`, so this is the same selector grammar as a NetworkPolicy, lifted to cluster scope.
- **`spec.tier`** — `Admin` or `Baseline`, the only two values. Tiers are evaluated **`Admin → NetworkPolicy → Baseline`**: an `Admin` policy outranks every developer `NetworkPolicy`, and a `Baseline` policy sits beneath them as the floor.
- **`spec.priority`** — orders policies *within* a tier. An integer from **0 to 1000 where lower means higher precedence** (checked first). If two policies in a tier share a priority and both match, which one wins is undefined - so keep priorities unique.
- **rule `action`** — `Accept` (this API's spelling of *allow*), `Deny`, and the new one, **`Pass`**: abstain and hand the decision to the next tier down. `Pass` is what lets an `Admin` policy delegate to the app team's `NetworkPolicy`.
- **named rules** — every `ingress`/`egress` entry carries a `name`, so each rule is self-documenting and addressable.
- **peers (`from` / `to`)** — selected by `namespaces` or `pods` label selectors; an egress `to` can additionally list raw **`networks`** (CIDRs) to reach destinations outside the cluster.

Because it's the portable upstream API, `ClusterNetworkPolicy` keeps the rule grammar deliberately small - TCP/UDP/SCTP ports only. Calico's richer matches (`Log`, ICMP, L7/HTTP, negated selectors, service accounts) stay in the `NetworkPolicy` and `GlobalNetworkPolicy` layers you'll meet next.

## The policies

Two objects: the app team's NetworkPolicy and the platform team's `Admin`
guardrail. The ▶ button loads both.

```yaml,copy,exec
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: backend-allow-frontend
  namespace: prod
spec:
  podSelector:
    matchLabels:
      app: backend
  policyTypes:
    - Ingress
  ingress:
    - from:
        - podSelector:
            matchLabels:
              app: frontend
---
apiVersion: policy.networking.k8s.io/v1alpha2
kind: ClusterNetworkPolicy
metadata:
  name: prod-admin-pass-prod-deny-rest
spec:
  tier: Admin
  priority: 10
  subject:
    namespaces:
      matchLabels:
        env: prod
  ingress:
    - name: pass-from-prod
      action: Pass
      from:
        - namespaces:
            matchLabels:
              env: prod
    - name: deny-everything-else
      action: Deny
      from:
        - namespaces: {}
```

## How a flow is decided

Each flow walks the tiers top to bottom; the **first tier with a verdict stops
the walk**. With only the `Admin` tier and the app NetworkPolicy in play:

1. **Admin** - if the source is in a `prod` namespace, the rule is `Pass`: Admin
   abstains and hands the decision down. Any other source hits the final `Deny`
   and is dropped right here.
2. **NetworkPolicy** - the app team decides. `prod/backend` admits
   `prod/frontend`, and because it's now selected by a policy it default-denies
   every other source itself.

## What to observe

**Allowed**

- `prod/frontend → prod/backend` - Admin `Pass` → app NetworkPolicy `Accept`.

**Denied**

- `dev/frontend → prod/backend` - Admin's final `Deny`; the app team never gets
  a say.
- `prod/database → prod/backend` - Admin `Pass`, but the app NetworkPolicy that
  selects `backend` doesn't admit `database`, so its own default-deny drops it.

> **The trap is using `Accept` where you mean `Pass`.** An Admin `Accept` from
> `prod` would force the traffic through and **rob the app team of the ability
> to deny it**. `Pass` is "not my call" - it's what makes delegation possible.

> **A gap to notice:** `prod/frontend → prod/database` is **allowed** right now.
> Admin passes it (same namespace) and `database` is covered by *no*
> NetworkPolicy, so it defaults to allow. "Forgot to write a policy" currently
> fails *open*. The next lesson's `Baseline` floor closes exactly this gap.

```quiz
{
  "question": "An Admin-tier rule with action Pass does what to a matching flow?",
  "options": [
    "Permanently allows it, overriding any lower tier",
    "Drops it immediately",
    "Delegates the decision to the next tier down (NetworkPolicy, then Baseline)"
  ],
  "answer": 2,
  "explain": "Accept and Deny are final at the Admin tier; Pass abstains and lets the lower tiers decide - the mechanism platform teams use to delegate to app teams."
}
```

## Recap

The `Admin` tier is the platform team's hard boundary: `Accept`/`Deny` are final,
and `Pass` delegates to the app team's `NetworkPolicy`. But anything Admin passes
that no NetworkPolicy covers still slips through. Next: the **`Baseline`** tier -
the cluster-wide default-deny floor that catches it.
