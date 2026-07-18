# Contain the blast radius: keep pods away from the control plane

Every lesson so far secured traffic *between apps*. But the most damaging thing
a compromised pod can do is reach the **control plane** - and the crown jewel
there is **etcd**, which holds the entire cluster's API state. Anything that can
talk to etcd can read or rewrite everything. No application pod has any reason
to. This lesson locks etcd down to its one legitimate client with an ordinary
`GlobalNetworkPolicy`.

## What you'll learn

- How to identify control-plane components by label (`tier == 'control-plane'`,
  `component: <name>`).
- How a single GNP makes etcd reachable by the **kube-apiserver and nothing
  else**.
- Where `HostEndpoint`s take this further - firewalling the **nodes**
  themselves.

## The policy

```yaml,copy,exec
apiVersion: projectcalico.org/v3
kind: GlobalNetworkPolicy
metadata:
  name: etcd-allow-apiserver-only
spec:
  selector: component == 'etcd'
  types:
    - Ingress
  ingress:
    - action: Allow
      source:
        selector: component == 'kube-apiserver'
```

- **`selector: component == 'etcd'`** targets the datastore pod.
- The single `Allow` admits only `component == 'kube-apiserver'`.
- **No catch-all**, so every other source - app pods *and* ordinary add-ons -
  hits the implicit default-deny.

etcd's only legitimate client is the kube-apiserver; the scheduler,
controller-manager and add-ons all go *through* the apiserver, never straight to
the datastore.

## What to observe

**Allowed**

- `kube-system/kube-apiserver → kube-system/etcd` - the control plane keeps
  working.

**Denied**

- `prod/backend → kube-system/etcd` - an app pod must never reach the datastore.
- `dev/database → kube-system/etcd` - nor any other workload.
- `calico-system/calico-typha → kube-system/etcd` - even ordinary add-ons don't
  need etcd; only the apiserver does.

> **The trap is scoping the allow too broadly.** `source.selector: all()`, or
> allowing the whole `tier == 'control-plane'`, turns those deny cells green and
> hands the datastore to far more than needs it. Allow exactly the one client.

## Beyond pods: HostEndpoints

This GNP protects a control-plane *pod*. To stop a pod from reaching a **node's
own interface** (kubelet, SSH, host-network services), you make that interface a
policy target with a **`HostEndpoint`** - it then appears in the matrix as a
`host/<name>` row, and a `GlobalNetworkPolicy` can firewall it just like a pod.
That's the deepest layer of blast-radius containment; locking etcd to the
apiserver, as here, is the highest-value first step.

## Recap

The infrastructure layer deserves policy too: lock etcd to the kube-apiserver
and a single pod compromise can't become a cluster takeover. That secured a
control-plane *pod* - next we go one layer deeper and firewall the **nodes
themselves** with `HostEndpoint`s and a custom `Tier`.
