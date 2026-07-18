# Firewall forwarded traffic: applyOnForward

Lesson 82 made a node's *own* interface a policy target and firewalled traffic
**to and from the host**. But a node does more than send and receive its own
packets - it **forwards** everyone else's: a pod on one node reaching a pod on
another, or an outside client reaching a pod, transits a node's forward path.
By default a `HostEndpoint`'s policy ignores that forwarded traffic. Flip
**`applyOnForward: true`** and the host firewall now polices it too - so a single
`GlobalNetworkPolicy` can quarantine an entire class of pods cluster-wide,
sitting *beneath* every `NetworkPolicy`.

## What you'll learn

- What **`applyOnForward`** changes: from "traffic to/from this host" to "traffic
  this host forwards" as well.
- How one wildcard `HostEndpoint` + one GNP firewalls a **whole label class**
  (`app == 'database'`) across every node and namespace at once.
- Why this catches flows a `NetworkPolicy` never could - it isn't scoped to a
  pod or a namespace, it's the node's forward path.

## What is applyOnForward?

A `HostEndpoint` policy, by default, only sees traffic whose source or
destination **is the host itself**. Most traffic isn't that - it's *forwarded*:
the node is just a transit hop between two workloads, or between the outside
world and a workload. `applyOnForward: true` extends the policy's rules to that
forwarded traffic.

| Traffic | Policed without `applyOnForward`? | With it? |
|---|---|---|
| Outside client → **the host** | ✅ yes | ✅ yes |
| Pod on node A → pod on node B (transits a host) | ❌ no | ✅ yes |
| Outside client → a pod (forwarded by the entry node) | ❌ no | ✅ yes |

Because the rule lives on a **wildcard (`interfaceName: "*"`) HostEndpoint on
every node**, and selects by the *destination* workload's labels, it becomes a
cluster-wide quarantine for anything matching `app == 'database'` - regardless of
which namespace or node the database pod lives in.

## The policy

```yaml,copy,exec
apiVersion: projectcalico.org/v3
kind: HostEndpoint
metadata:
  name: fw-control-plane
  labels:
    role: forward-firewall
spec:
  node: policy-llm-control-plane
  interfaceName: "*"
  expectedIPs: ["172.18.0.2"]
---
apiVersion: projectcalico.org/v3
kind: HostEndpoint
metadata:
  name: fw-worker
  labels:
    role: forward-firewall
spec:
  node: policy-llm-worker
  interfaceName: "*"
  expectedIPs: ["172.18.0.3"]
---
apiVersion: projectcalico.org/v3
kind: GlobalNetworkPolicy
metadata:
  name: forward-firewall-deny-database
spec:
  selector: role == 'forward-firewall'
  applyOnForward: true
  types:
    - Ingress
    - Egress
  ingress:
    - action: Deny
      destination:
        selector: app == 'database'
    - action: Allow
  egress:
    - action: Deny
      destination:
        selector: app == 'database'
    - action: Allow
```

## Reading the pieces

- **Two wildcard `HostEndpoint`s** - one per node
  (`policy-llm-control-plane` / `policy-llm-worker`), both labelled
  `role: forward-firewall`. `interfaceName: "*"` means *every* interface, which
  is what lets the policy see forwarded traffic on either side of a hop.
- **`applyOnForward: true`** - the switch. Without it, the two `Deny` rules would
  only bite traffic aimed at the *host*, and the database pods would be
  untouched.
- **`Deny` to `app == 'database'`, then `Allow`** - on both `Ingress` and
  `Egress`, so the deny fires whether the packet is inspected as it leaves the
  source node or arrives at the destination node. Everything not headed for a
  database pod hits the trailing `Allow` and is forwarded normally.

## What to observe

**Denied** - every flow *to* a database pod, no matter the source:

- `prod/frontend → prod/database` - a cross-node forward (frontend rides the
  control-plane, database the worker).
- `prod/backend → prod/database` - even **same-node** and **same-namespace**:
  the host forwards it, so the firewall catches it. A `NetworkPolicy` scoped to
  `prod` could never express this.
- `world/observer → prod/database` - an outside client forwarded to the pod.

**Allowed** - everything else:

- `prod/frontend → prod/backend` and `world/observer → prod/backend` - not a
  database destination, so the trailing `Allow` forwards them.
- `prod/database → prod/backend` - the database's *own* egress isn't blocked;
  only traffic **to** `app == 'database'` is.

> **The trap is forgetting the trailing `Allow`.** A wildcard HostEndpoint
> defaults to drop. With only the `Deny` rule, every forwarded flow - not just
> the database ones - goes dark, and you've firewalled the whole cluster off
> itself.

```quiz
{
  "question": "Why does `prod/backend → prod/database` get denied even though both pods are in the same namespace on the same node?",
  "options": [
    "The NetworkPolicy API blocks same-namespace traffic by default",
    "applyOnForward polices the traffic the node forwards - it isn't scoped to a namespace or pod, so it catches the flow the moment the host forwards it toward an app == 'database' pod",
    "Same-node pods can never reach each other in Calico"
  ],
  "answer": 1,
  "explain": "This is the whole point of a host forward firewall: it operates on the node's forward path, not on pod/namespace identity. Any flow the node forwards toward a database pod is subject to the rule, regardless of where the source sits."
}
```

## Recap

`applyOnForward` promotes a HostEndpoint policy from "guard the host's own
traffic" to "guard everything the host forwards." Put it on a wildcard
HostEndpoint on every node and select by destination labels, and one
`GlobalNetworkPolicy` quarantines a whole class of pods cluster-wide - the kind
of blast-radius control the namespace-scoped Network Policy API can't reach.
Next: the same host firewall, but aimed at the outside world - **preDNAT** and
**doNotTrack**.
