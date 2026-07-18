# GlobalNetworkPolicy: one default-deny for the whole cluster

The namespaced policies so far each guarded a single namespace. A
**`GlobalNetworkPolicy`** is cluster-scoped: one object can flip **every**
namespaced pod - `prod` and `dev` together - to default-deny, then hand back the
flows you trust. This is the zero-trust baseline every later lesson tightens.

## What you'll learn

- The canonical "every pod in the cluster" selector,
  `has(projectcalico.org/name)`.
- Why an allowed connection usually needs **both** an egress and an ingress
  rule.
- Why you build the baseline first and carve back, not the other way around.

## What is a GlobalNetworkPolicy?

A `GlobalNetworkPolicy` (`projectcalico.org/v3`) is the **cluster-scoped** sibling
of the Calico `NetworkPolicy`. It carries the *same* rule grammar - same actions,
selectors, ports, L7 - but drops the namespace boundary and adds a few fields
that only make sense cluster-wide:

| | Calico NetworkPolicy | GlobalNetworkPolicy |
|---|---|---|
| **Scope** | one namespace | **whole cluster** (no `metadata.namespace`) |
| **Namespace targeting** | implicit (its own ns) | **`spec.namespaceSelector`** - pick which namespaces' pods it governs |
| **Can apply to host interfaces?** | no | **yes** - it can select `HostEndpoint`s, not just pods |
| **Host/dataplane modifiers** | — | **`doNotTrack`, `preDNAT`, `applyOnForward`** |

The additions:

- **cluster scope** - one object governs every namespace at once;
  `has(projectcalico.org/name)` is the canonical "every namespaced pod" selector.
- **`spec.namespaceSelector`** - scope the policy to a subset of namespaces by
  label (instead of being pinned to one).
- **`doNotTrack` / `preDNAT` / `applyOnForward`** (booleans) - host-protection
  modifiers used with `HostEndpoint` policy: evaluate before conntrack, before
  DNAT, and on forwarded traffic respectively. (HostEndpoints arrive in lesson 82.)

Everything else - `order`, `tier`, `serviceAccountSelector`, the whole rule
grammar - is identical to the Calico `NetworkPolicy` you already know.

## The policy

```yaml,copy,exec
apiVersion: projectcalico.org/v3
kind: GlobalNetworkPolicy
metadata:
  name: cluster-default-deny-allow-web-to-app
spec:
  order: 1001
  namespaceSelector: has(projectcalico.org/name)
  types:
    - Ingress
    - Egress
  ingress:
    - action: Allow
      protocol: TCP
      source:
        selector: tier == 'web'
      destination:
        selector: tier == 'app'
        ports: [8080]
  egress:
    - action: Allow
      protocol: TCP
      source:
        selector: tier == 'web'
      destination:
        selector: tier == 'app'
        ports: [8080]
```

- **`namespaceSelector: has(projectcalico.org/name)`** matches every namespaced
  pod - all of `prod` and `dev`.
- **`types: [Ingress, Egress]`** with only the web→app carve-out means
  everything else, both directions, hits default-deny.
- **Two rules for one path:** Calico checks both ends. The frontend's *egress*
  must permit sending **and** the backend's *ingress* must permit receiving -
  and both pods are selected by this same policy, so you need both.

## Why default-deny first

It's tempting to "deny the bad stuff," but you can't enumerate everything bad.
Flip the whole cluster to deny, then justify each flow you add back - now an
omission fails *closed*, not open.

> **Safe rollout tip:** the first cluster-wide deny is the scariest change you'll
> make. In production you'd preview it as a *staged* policy before enforcing -
> that's lesson 85.

## What to observe

**Allowed**

- `prod/frontend → prod/backend:8080` and `dev/frontend → dev/backend:8080` -
  the web→app carve-out, in both namespaces from one policy.

**Denied**

- `prod/frontend → prod/database`, `prod/backend → prod/database`, any UDP, any
  other port - all default-denied.

> **The trap:** this carve-out keys on `tier`, not `env`, so `dev/frontend →
> prod/backend` is **also allowed** - the policy never said the two ends must
> share an environment. Cluster-wide selectors are powerful and easy to make too
> broad. Tightening the prod/dev boundary is a job for sharper selectors (and the
> next few lessons).

## Recap

One `GlobalNetworkPolicy` is a cluster-wide default-deny with a carve-out - the
foundation of zero trust. But a real default-deny breaks one thing immediately:
name resolution. Next, the one egress every pod still needs - **DNS**.
