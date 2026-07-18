# Calico NetworkPolicy: a real Deny and an order field

We've crossed from the upstream APIs into **Calico's own** kinds. The first is
the namespaced Calico `NetworkPolicy` - it lives in one namespace and selects
pods there, exactly like the Kubernetes NetworkPolicy from lesson 10. What's new
is the two capabilities lesson 20 told you KNP was missing: an explicit **`Deny`
action** and a **`spec.order`** that ranks policies. To make the point, we run a
Calico policy and a plain Kubernetes one side by side in `prod`.

## What you'll learn

- That a Calico `NetworkPolicy` is namespaced (same scope as KNP) but adds
  `Deny` and `order`.
- How **lower `order` is evaluated first**, so a `Deny` can shadow a later
  `Allow`.
- The interop rule: Calico ranks every **Kubernetes** NetworkPolicy at a fixed
  **`order: 1000`**.

## What is a Calico NetworkPolicy?

The Calico `NetworkPolicy` (`projectcalico.org/v3`) is **namespaced just like the
Kubernetes one** - same scope - but it trades the minimal upstream grammar for
Calico's full rule language. Here is what it adds on top of a Kubernetes
NetworkPolicy:

| | Kubernetes NetworkPolicy | Calico NetworkPolicy |
|---|---|---|
| **Actions** | allow-only | **`Allow`, `Deny`, `Log`, `Pass`** |
| **Ordering** | none | **`spec.order`** (lower = evaluated first) |
| **Tiers** | none | **`spec.tier`** (any custom tier; defaults to `default`) |
| **Selectors** | `matchLabels`/`matchExpressions` | Calico selector strings (`==`, `!=`, `has()`, `in {}`, `&&`, `\|\|`) + **`spec.serviceAccountSelector`** |
| **Match grammar** | protocol + port | adds `icmp`/`notICMP`, `http` (L7 methods/paths), `ipVersion`, `nets`/`notNets`, `notSelector`/`notPorts`/`notProtocol`, `services`, `serviceAccounts` |

The headline additions, field by field:

- **`spec.order`** (number) - ranks this policy against the others in its tier;
  lower is evaluated first. The Kubernetes NetworkPolicy had no way to express
  precedence at all.
- **`spec.tier`** - which tier the policy lives in. The cluster-wide tiering you
  met in the ClusterNetworkPolicy lessons, now available to a namespaced policy.
- **rule `action`** - the big one: an explicit **`Deny`**, plus **`Log`**
  (annotate and continue) and **`Pass`** (delegate to the next tier).
- **richer selectors and matches** - Calico's selector strings and
  `serviceAccountSelector`, plus L7 (`http`), ICMP type/code, negated matches
  (`notSelector`, `notPorts`, …), `ipVersion`, and rules that target `services`
  or `serviceAccounts`.

It is still **namespaced** - to govern the whole cluster in one object you reach
for the `GlobalNetworkPolicy`, a few lessons on.

## The policies

```yaml,copy,exec
apiVersion: projectcalico.org/v3
kind: NetworkPolicy
metadata:
  name: backend-deny-from-database
  namespace: prod
spec:
  order: 100
  selector: app == 'backend'
  types:
    - Ingress
  ingress:
    - action: Deny
      source:
        selector: app == 'database'
---
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
```

## How they cooperate

Both policies govern `prod/backend`. Calico evaluates them in **ascending
order**:

- **`order: 100`** (the Calico `Deny`) is consulted **first**. A `database`
  source matches → denied, terminally. The KNP never runs for that flow.
- A non-database source (like `frontend`) **misses** the Deny's rule and falls
  through to the next policy: the KNP, which Calico ranks at **`order: 1000`** →
  its `Allow` admits `frontend`.

The Calico `Deny` has **no catch-all**, so it only acts on `database`;
everything else continues down the order.

## What to observe

**Allowed**

- `prod/frontend → prod/backend` - misses the order-100 Deny, caught by the
  KNP's Allow at 1000.

**Denied**

- `prod/database → prod/backend` - the order-100 `Deny` fires first and is final.

> **The trap is order.** Bump the Calico policy to `order: 1001` and it now sits
> *below* the KNP. A `database → backend` flow would hit the KNP first - which
> only knows how to *allow* `frontend`, so `database` falls to the tier's
> default-deny anyway here, but in a cluster with a broad allow the Deny would
> become dead code. Put your denials at a low order.

## Recap

The Calico `NetworkPolicy` keeps KNP's namespaced scope but adds `Deny` and
`order`, and it interoperates with Kubernetes NetworkPolicies by ranking them at
1000. Ordering is now doing real work - so the next lesson goes deep on
precedence: what happens when orders **tie**, and the one action (`Log`) that
quietly changes how a policy is read.
