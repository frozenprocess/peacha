# ClusterNetworkPolicy: the Baseline tier (the default-deny floor)

The `Admin` tier set hard boundaries and delegated the rest with `Pass`. But the
last lesson ended on a gap: traffic Admin passes that **no NetworkPolicy covers**
falls through to a default *allow*. The **`Baseline`** tier is the fix - the
cluster-wide **default-deny floor** that sits beneath every NetworkPolicy and
catches whatever nothing else decided.

## What you'll learn

- Where the **`Baseline`** tier sits: **below** the developer `NetworkPolicy`,
  evaluated last.
- How one Baseline policy becomes the **cluster-wide default-deny floor**.
- Why a floor makes "forgot to write a policy" fail **closed** instead of open.

## Where the Baseline tier sits

Tiers are evaluated **`Admin → NetworkPolicy → Baseline`**, and the first to
decide wins. The Admin lesson covered the top. `Baseline` is the bottom: a policy
here only gets a vote on flows that the `Admin` tier `Pass`ed **and** no
`NetworkPolicy` accepted or denied. That makes it the natural home for a single
rule - **deny everything** - so anything left uncovered fails closed.

Because it's the lowest tier, a Baseline deny **can't** override an app team's
`Accept`: by the time a flow would reach the floor, a higher tier has usually
already decided it. The floor only catches the leftovers.

## The policies

All three tiers together now: the app team's NetworkPolicy, the `Admin` guardrail
from the last lesson, and the new `Baseline` floor. The ▶ button loads all three.

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
---
apiVersion: policy.networking.k8s.io/v1alpha2
kind: ClusterNetworkPolicy
metadata:
  name: cluster-baseline-deny-ingress
spec:
  tier: Baseline
  priority: 1000
  subject:
    namespaces: {}
  ingress:
    - name: deny-all
      action: Deny
      from:
        - namespaces: {}
```

## How a flow is decided

1. **Admin** - `Pass` intra-prod traffic, `Deny` the rest (final).
2. **NetworkPolicy** - the app team's allow: `prod/frontend → prod/backend`.
3. **Baseline** - the floor. Anything Admin passed and no NetworkPolicy accepted
   lands here on the deny-all.

## What to observe

**Allowed**

- `prod/frontend → prod/backend` - Admin `Pass` → app NetworkPolicy `Accept`. The
  floor never runs for it; a higher tier already said yes.

**Denied**

- `prod/frontend → prod/database` - **the gap from the last lesson, now closed.**
  Admin passes it, no NetworkPolicy covers `database`, so the `Baseline` floor
  denies it. (In the Admin-only lesson this same flow was *allowed*.)
- `dev/frontend → dev/backend` - the floor is cluster-wide
  (`subject: namespaces {}`), so it locks down `dev` too, not just `prod`.
- `dev/frontend → prod/backend` - still the Admin tier's final `Deny`.
- `prod/database → prod/backend` - still the app NetworkPolicy's own default-deny.

> **The trap:** a Baseline deny-all *looks* like it should block everything,
> including `prod/frontend → prod/backend`. It doesn't - the `NetworkPolicy` tier
> sits **above** Baseline and already accepted that flow, so evaluation stops
> before the floor is ever consulted. Baseline only decides what the tiers above
> it left undecided.

```quiz
{
  "question": "A Baseline deny-all and a NetworkPolicy that accepts frontend→backend are both loaded. Why is frontend→backend still allowed?",
  "options": [
    "Baseline rules only apply to egress",
    "The NetworkPolicy tier is evaluated before Baseline and accepts the flow, so the floor never runs for it",
    "A priority of 1000 is too low for the Baseline rule to take effect"
  ],
  "answer": 1,
  "explain": "Tiers run Admin → NetworkPolicy → Baseline. The NetworkPolicy accepts frontend→backend - a verdict - so evaluation stops there. Baseline only decides flows nothing above it did."
}
```

## The ceiling: where Kubernetes-native policy stops

You've now seen the entire Kubernetes-*native* policy stack - the namespaced
`NetworkPolicy` and the cluster-scoped `ClusterNetworkPolicy` (`Admin` +
`Baseline`). It's portable and standardized, and for in-cluster, pod-to-pod
segmentation it's enough. But it was designed as a *lowest common denominator*,
and you reach its ceiling quickly. Comparing the CRDs, here is what the upstream
API simply **cannot** express - and which Calico kind picks up each one:

| Limit of Kubernetes / ClusterNetworkPolicy | Why it bites | Calico answer |
|---|---|---|
| **Only two tiers** - `Admin` and `Baseline` (a fixed enum) | No room for an org → team → app layering | **`Tier`** - unlimited custom tiers, each with its own `order` and `defaultAction` |
| **No host firewall** - `subject` and peers are `namespaces`, `pods`, `networks` only; there is *no node concept anywhere in the API* | You can't protect the node itself - kubelet, SSH, host-network services | **`HostEndpoint`** + **`GlobalNetworkPolicy`** - make a node's interface a policy target |
| **Three actions** - `Accept`, `Deny`, `Pass` | No way to audit a match without changing the verdict | adds **`Log`** |


The limitation that matters most for a security team: **a Kubernetes or
ClusterNetworkPolicy can never be a host firewall.** Its entire world is pods and
namespaces - a node's own interface lives in neither, so there is no field
anywhere in the upstream API that can select it. The moment you need to firewall
the **nodes**, the **control plane**, or anything **off-cluster** with the same
engine - or you simply outgrow two tiers and 1000 priorities - you've left what
Kubernetes-native policy can do. That is exactly the territory the rest of this
track covers, with Calico's `NetworkPolicy`, `GlobalNetworkPolicy`, `Tier`, and
`HostEndpoint`.

## Recap

The `Baseline` tier is the cluster-wide default-deny floor: evaluated last, it
denies anything the Admin tier passed and no NetworkPolicy allowed, so an
un-covered workload fails closed. Together, `Admin` (hard boundaries +
delegation) and `Baseline` (the floor) are the platform team's two halves of the
Network Policy API. Next we cross into **Calico's own** kinds - starting with the
namespaced Calico `NetworkPolicy`, which brings `order` and `Deny` down to the
app-team level.
