# Policies on Windows: read the HNS tab

Everything you've written so far is portable: the same Calico policy YAML
applies whether a pod lands on a Linux node or a Windows one. What changes is the
**dataplane underneath**. On Linux, Felix programs iptables (or nftables, or
eBPF). On **Windows** there is no iptables - Felix hands the OS's **Host
Networking Service (HNS)** a flat list of **ACL rules**, one list per endpoint
per direction. This lesson loads a plain policy and teaches you to read that
list in the **Windows (HNS)** tab.

## What you'll learn

- That a Calico policy is written once and enforced on Windows nodes too - via
  a *different* dataplane.
- Where the **Windows (HNS)** tab is and how to drive its filters.
- How to read an HNS ACL rule: the flattened, priority-ordered, **IPv4-only**
  list Felix installs, with addresses **inlined** (HNS has no named IP sets).

## The policy

A deliberately simple one so the ACL list is easy to read - a cluster-wide
default-deny with a single allow: `frontend → backend` on TCP 8080. It uses no
negated matches, no named ports, no ICMP, so it renders on Windows exactly as it
does on Linux (lesson 94 is where that stops being true).

```yaml,copy,exec
apiVersion: projectcalico.org/v3
kind: GlobalNetworkPolicy
metadata:
  name: frontend-to-backend
spec:
  order: 100
  namespaceSelector: has(projectcalico.org/name)
  types: [Ingress, Egress]
  ingress:
    - action: Allow
      protocol: TCP
      source:
        selector: 'app == "frontend"'
      destination:
        selector: 'app == "backend"'
        ports: [8080]
  egress:
    - action: Allow
      protocol: TCP
      destination:
        selector: 'app == "backend"'
        ports: [8080]
```

## Open the Windows (HNS) tab

The view switcher across the top has one tab per dataplane -
`matrix`, `graph`, then the dataplane renders. The **Windows** one is marked with
the **Windows logo** (hover it: *"Windows HNS"*). Click it.

Unlike the matrix and graph, the dataplane tabs render **on demand**: the HNS tab
POSTs your topology to the engine and shows the ACL lists Felix *would* install
on a Windows node. Its controls:

- **`dir`** - filter to `ingress`, `egress`, or leave it on `both`.
- **endpoint filter** - type a substring (e.g. `backend`) to show only endpoints
  whose id contains it. Selecting a pod in the matrix/graph seeds this for you.
- **ⓘ HNS ACL render** - hover for the one-line reminder of what you're looking
  at.

Notice there is **no IP-version knob** here (the other dataplane tabs have one):
**HNS is IPv4-only**, so it's omitted. Request IPv6 and the engine just warns.

## Read a rule

Each endpoint is a collapsible block headed like:

```
egress  prod/backend   <interface> · IPv4 · 3 rules
```

- **direction** and the **endpoint id** (`<ns>/<app>`),
- the **interface**, the **IP version** (always 4), and the **rule count**.

Inside, every rule is one compact `Key=value` line - the literal ACL blob Felix
gives HNS, in field order. The keys you'll see most:

| Key | Meaning |
|---|---|
| `Action` | `Allow` or `Block` (HNS's word for deny) |
| `Direction` | `In` / `Out` |
| `Priority` | lower runs first; Felix rewrites these when actions change |
| `Protocol` | IP proto number - and **`256` renders as `any`** |
| `RemoteAddresses` | the **inlined** peer CIDRs (no named IP set - HNS can't reference one) |
| `RemotePorts` / `LocalPorts` | the port match |

For our policy, filter to `backend`: you'll see an **`Allow`** rule for TCP 8080
from the frontend's inlined address(es), and a trailing **`Block`** that catches
everything else - the default-deny, made concrete.

```quiz
{
  "question": "Why does the Windows (HNS) tab have no IPv6 option when the other dataplane tabs do?",
  "options": [
    "IPv6 is configured elsewhere",
    "Calico's Windows HNS dataplane is IPv4-only - there is no IPv6 ACL support, so the knob is omitted",
    "The tab hasn't implemented it yet"
  ],
  "answer": 1,
  "explain": "The HNS policysets renderer hard-codes IPv4. Windows Calico has no IPv6 dataplane, so an IPv6 request affects no traffic - the tab drops the knob and the engine warns."
}
```

## What to observe

Flip between the **iptables** tab and the **Windows (HNS)** tab with this policy
loaded. Different syntax, **same verdict**: `prod/frontend → prod/backend:8080`
allowed, everything else denied, on both. That's the happy path - a portable
policy enforced identically on either OS.

## Recap

A Calico policy is authored once; on a Windows node Felix renders it to an **HNS
ACL list** instead of iptables - flat, priority-ordered, address-inlined, and
IPv4-only. You can preview exactly that list in the **Windows (HNS)** tab. For a
clean policy the verdict matches Linux. But some rules *don't* survive the trip -
next lesson covers the divergences, including one that quietly opens a hole.
