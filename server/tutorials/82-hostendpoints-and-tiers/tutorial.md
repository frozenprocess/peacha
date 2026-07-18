# Firewall the nodes: HostEndpoints and a custom Tier

Lesson 80 locked down a control-plane *pod*. But the deepest blast radius is the
**node itself** - its kubelet, its SSH, its host-network services. A pod's
interface is a `WorkloadEndpoint`; a node's interface is a **`HostEndpoint`**,
and the moment you define one, the host becomes a policy target you can
firewall. This is also the clearest demonstration of *why Calico exists
alongside the Kubernetes APIs*: a node lives in no namespace, so the Network
Policy API can never touch it - only a Calico policy can.

## What you'll learn

- How a **`HostEndpoint`** turns a node's own interface into a policy target (a
  `host/<name>` row in the matrix).
- How a custom **`kind: Tier`** with its own **`defaultAction`** holds the
  host-firewall policy.
- Why the host firewall works even **below** the entire Network Policy API
  stack - the interop boundary between Kubernetes APIs and Calico.

## What are HostEndpoints and Tiers?

This lesson introduces two new `projectcalico.org/v3` resources that aren't
policies themselves but change what policy can do.

**`HostEndpoint`** makes a node's own network interface a policy target - a pod's
interface is a `WorkloadEndpoint`, and this is the host equivalent. Its fields:

| Field | Purpose |
|---|---|
| `spec.node` | which node this interface belongs to |
| `spec.interfaceName` | the interface to guard (`"*"` = all, or e.g. `eth0`) |
| `spec.expectedIPs` | the IPs the host presents - how the engine ties flows to this endpoint |
| `spec.ports` | named host ports that rules can reference |
| `spec.profiles` | profiles applied to the endpoint |

It carries **labels** (in `metadata`), and policies select it exactly like a pod
- it appears as a `host/<name>` row in the matrix.

**`Tier`** is the top-level grouping that orders whole *groups* of policies:

| Field | Purpose |
|---|---|
| `spec.order` | where this tier sits relative to others (lower = evaluated first) |
| `spec.defaultAction` | what happens to a packet a policy in the tier **selects** but no rule **matches**: `Deny` ends it here; `Pass` delegates to the next tier |

A Calico policy joins a tier via `spec.tier`. Tiers are how you place the host
firewall *below* everything else and still have it govern host traffic - the
structure this lesson builds.

## The policy

```yaml,copy,exec
apiVersion: projectcalico.org/v3
kind: Tier
metadata:
  name: host-firewall
spec:
  order: 1000000
  defaultAction: Deny
---
apiVersion: projectcalico.org/v3
kind: HostEndpoint
metadata:
  name: node-control-plane
  labels:
    role: node
spec:
  node: policy-llm-control-plane
  interfaceName: "*"
  expectedIPs: ["172.18.0.2"]
---
apiVersion: projectcalico.org/v3
kind: HostEndpoint
metadata:
  name: node-worker
  labels:
    role: node
spec:
  node: policy-llm-worker
  interfaceName: "*"
  expectedIPs: ["172.18.0.3"]
---
apiVersion: projectcalico.org/v3
kind: GlobalNetworkPolicy
metadata:
  name: node-host-firewall
spec:
  tier: host-firewall
  order: 100
  selector: role == 'node'
  types:
    - Ingress
  ingress:
    - action: Allow
      source:
        selector: role == 'node' || has(k8s-app) || tier == 'control-plane'
```

## Reading the pieces

- **Two `HostEndpoint`s** - one per node (`policy-llm-control-plane` /
  `policy-llm-worker`), both labelled `role: node`. Defining them by hand is the
  manual version of Calico's *automatic host endpoints*. Each appears as a
  `host/<name>` row.
- **`kind: Tier` `host-firewall`** - a tier of its own. Its `defaultAction:
  Deny` is what happens to a packet the tier *selects* but no rule *matches*; a
  high `order` places it below the default tier.
- **The firewall GNP** - selects `role == 'node'` and admits ingress only from
  other nodes, `has(k8s-app)` add-ons, or the `control-plane`. No catch-all, so
  app pods fall to the tier's `Deny`.

## What to observe

**Allowed**

- `host/node-control-plane → host/node-worker` - node-to-node (`role == 'node'`).
- `calico-system/calico-node → host/node-worker` - infrastructure (`has(k8s-app)`).
- `kube-system/kube-apiserver → host/node-control-plane` - the control plane.

**Denied**

- `prod/backend → host/node-worker` - an app pod has no business on the host.
- `dev/frontend → host/node-control-plane` - same, on the other node.

> **The trap is `selector: all()` on the firewall** (or allowing the app
> namespaces): the `host/<app>` deny cells turn green and a compromised pod can
> reach the node. Allow only `role: node` plus infrastructure.

## The interop boundary

This is the one thing **only Calico** can do. A `ClusterNetworkPolicy` subject
is `namespaces`/pods; a Kubernetes `NetworkPolicy` is namespaced. A
`HostEndpoint` belongs to **no namespace**, so neither API can ever select it -
even an `Admin`-tier `Deny` simply never matches host traffic. Place this Calico
tier *below* the entire NPA stack and it still governs the nodes, because the
pod/namespace tiers above never matched them. Where the Kubernetes APIs end,
Calico keeps going.

```quiz
{
  "question": "Why can't a ClusterNetworkPolicy (the Network Policy API) firewall a node's HostEndpoint?",
  "options": [
    "HostEndpoints are read-only",
    "Its subject is namespaces/pods, but a HostEndpoint lives in no namespace, so no NPA subject can ever select it - only a Calico policy can",
    "You must enable a feature gate first"
  ],
  "answer": 1,
  "explain": "The upstream APIs are pod/namespace-scoped. A node's own interface has no namespace to put in a subject, so it falls outside the NPA entirely - a Calico GlobalNetworkPolicy is the only thing that can govern it."
}
```

## Recap

A `HostEndpoint` extends policy from pods to the **nodes**, and a custom `Tier`
with its own `defaultAction` gives the host firewall a home - one that keeps
working even beneath the whole Network Policy API, because hosts are exactly the
traffic the NPA can't see. That's the floor of your defense in depth. Next, the
operational finish: rolling all of this out safely with **staged policy**.
