# Guard the front door: preDNAT and doNotTrack

Lesson 83 firewalled forwarded traffic *inside* the cluster. Now aim the host
firewall at the **outside world**. Two more `GlobalNetworkPolicy` switches exist
for exactly this, and both matter because external clients have **no Calico
identity** - you can't select them by pod label, only by their **source CIDR**.
The clever part: a source CIDR survives kube-proxy's address translation
untouched, so it's a discriminator the host firewall and the dataplane always
agree on.

## What you'll learn

- **`preDNAT`** - block a source at the node's edge *before* kube-proxy rewrites
  the destination, so you match the real external client, not a Service VIP.
- **`doNotTrack`** - a stateless (conntrack-free) firewall for host-networked
  servers, and why it behaves differently from every other policy.
- Why external rules match on **`source.nets`** (CIDRs), not selectors.

## preDNAT: match before the address is rewritten

When an outside client hits a NodePort or LoadBalancer, **kube-proxy DNATs** the
packet - it rewrites the destination from `node-IP:port` to a backend
`pod-IP:port`. Normal policy runs *after* that rewrite, so by the time it sees
the packet the original destination is gone. `preDNAT: true` runs the rule
**before** DNAT, on the node the traffic enters - the one place the *original*
external source is still visible and unambiguous.

`preDNAT` has two hard requirements: it implies **`applyOnForward`**, and it may
only carry **`Ingress`** rules. The scenario loaded on the right blocks one
external source CIDR and lets everything else through:

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
  name: prednat-block-external-cidr
spec:
  selector: role == 'forward-firewall'
  preDNAT: true
  applyOnForward: true
  types:
    - Ingress
  ingress:
    - action: Deny
      source:
        nets: ["203.0.113.5/32"]
    - action: Allow
---
apiVersion: projectcalico.org/v3
kind: GlobalNetworkPolicy
metadata:
  name: prednat-allow-forward
spec:
  selector: role == 'forward-firewall'
  applyOnForward: true
  types:
    - Ingress
    - Egress
  ingress:
    - action: Allow
  egress:
    - action: Allow
```

### What to observe

- `world/blocked → prod/backend` and `world/blocked → prod/database` - **denied**.
  `world/blocked` is `203.0.113.5`, the CIDR the preDNAT rule drops at the edge.
- `world/allowed → prod/backend` - **allowed**. A different source CIDR
  (`198.51.100.7`), so it clears the preDNAT hook and the companion
  `prednat-allow-forward` carries it to the pod.
- `prod/frontend → prod/backend` - **allowed**. Internal pod traffic isn't an
  external source, so the block never applies.

The second GNP, `prednat-allow-forward`, is load-bearing: a wildcard
HostEndpoint defaults to drop, so without an explicit forward-allow the *allowed*
client's traffic would clear preDNAT and then die at the host's default deny.

## doNotTrack: a stateless firewall for the host itself

`doNotTrack: true` places the rule in the iptables **raw table**, which runs
before conntrack - the packet is **NOTRACK**, never entered into the connection
table. That makes it the fastest possible host firewall, built for
**host-networked servers** taking a flood of short-lived external connections.
It comes with three sharp edges:

1. **It guards the host, not a pod.** The destination is a `host/<name>` row -
   the node's own listening service - not a workload behind it.
2. **It needs a named interface.** Calico **silently ignores `doNotTrack` on an
   all-interfaces (`interfaceName: "*"`) HostEndpoint** - you must name the real
   NIC, e.g. `eth0`. Load it on a `"*"` HEP and the editor will warn you and drop
   the rule, matching the dataplane.
3. **It's stateless.** With no conntrack there's no automatic reply, so the
   egress side must explicitly allow the server's return traffic, and a normal
   (tracked) companion policy is needed because the packet still traverses the
   filter table afterward.

Paste this to see it in action - `world/blocked → host/host-worker` flips to
**deny** while `world/allowed → host/host-worker` stays **allow**:

```yaml,copy
apiVersion: projectcalico.org/v3
kind: HostEndpoint
metadata:
  name: host-worker
  labels:
    role: untracked-fw
spec:
  node: policy-llm-worker
  interfaceName: eth0
  expectedIPs: ["172.18.0.3"]
---
apiVersion: projectcalico.org/v3
kind: GlobalNetworkPolicy
metadata:
  name: dnt-host-accelerator
spec:
  selector: role == 'untracked-fw'
  doNotTrack: true
  applyOnForward: true
  types:
    - Ingress
    - Egress
  ingress:
    - action: Deny
      source:
        nets: ["203.0.113.5/32"]
    - action: Allow
      protocol: TCP
      destination:
        ports: [8080]
  egress:
    - action: Allow
---
apiVersion: projectcalico.org/v3
kind: GlobalNetworkPolicy
metadata:
  name: dnt-normal-companion
spec:
  selector: role == 'untracked-fw'
  types:
    - Ingress
    - Egress
  ingress:
    - action: Allow
  egress:
    - action: Allow
```

```quiz
{
  "question": "Why does an external firewall rule match on source.nets (a CIDR) instead of a source selector?",
  "options": [
    "Selectors are slower to evaluate",
    "An off-cluster client has no Calico workload identity or labels, so a CIDR is the only thing that identifies it - and a source CIDR also survives kube-proxy DNAT unchanged, so preDNAT and the dataplane agree on it",
    "GlobalNetworkPolicy doesn't support selectors"
  ],
  "answer": 1,
  "explain": "External clients aren't workloads - they have no labels to select. Their source IP/CIDR is the only handle, and because DNAT rewrites the destination (not the source), that handle stays valid before and after translation."
}
```

## Recap

`preDNAT` and `doNotTrack` are the host firewall pointed outward.
`preDNAT` catches an external source at the node's edge *before* the destination
is rewritten - the only place to match the real client of a NodePort/LoadBalancer
service. `doNotTrack` is a stateless raw-table firewall for host-networked
servers - fast, but it guards the host itself, needs a named interface, and
carries no conntrack. Both lean on the **source CIDR**, the one identifier an
outside client always has. That closes the host-firewall arc; next is rolling
any of this out safely with **staged policy**.
