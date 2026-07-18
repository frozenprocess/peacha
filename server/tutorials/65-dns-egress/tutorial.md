# Don't forget DNS: the one egress every pod needs

The cluster-wide default-deny from the last lesson is correct - and it just
broke almost every app. The moment egress is denied, pods can't reach CoreDNS,
so every hostname lookup fails. The app doesn't log "blocked by policy"; it logs
"connection to *some-name* timed out" and looks randomly broken. DNS is the one
egress essentially every workload needs, so it's the first carve-out you add.

## What you'll learn

- Why a default-deny breaks apps in a confusing, indirect way (failed name
  resolution, not an obvious block).
- How to allow egress to **CoreDNS** on port 53 for every workload.
- Why CoreDNS needs **both UDP and TCP**, and why the **system namespaces**
  must stay out of the lockdown.

## The policy

```yaml,copy,exec
apiVersion: projectcalico.org/v3
kind: GlobalNetworkPolicy
metadata:
  name: allow-dns-egress
spec:
  order: 900
  namespaceSelector: kubernetes.io/metadata.name not in {"calico-system", "kube-system", "kube-public", "tigera-operator"}
  types:
    - Egress
  egress:
    - action: Allow
      protocol: UDP
      destination:
        selector: k8s-app == "kube-dns"
        ports: [53]
    - action: Allow
      protocol: TCP
      destination:
        selector: k8s-app == "kube-dns"
        ports: [53]
```

- **`k8s-app == "kube-dns"`** is CoreDNS's well-known label - the destination of
  every cluster DNS query.
- **Both protocols:** UDP/53 handles the common short answer; TCP/53 handles
  large responses (and zone transfers). Allow only UDP and big lookups fail
  intermittently - a nasty bug to chase.
- **The `namespaceSelector` excludes the system namespaces** so this policy
  governs *workloads*, not CoreDNS itself. Default-denying the DNS plane would
  defeat the carve-out you're writing.

## What to observe

**Allowed**

- `prod/backend → kube-system/coredns:53` (UDP and TCP) - and the same from every
  prod/dev pod.

**Denied**

- `prod/backend →` anything else on egress - DNS is the only hole this policy
  opens.

> **The trap is allowing DNS by port alone.** A rule that allows "UDP/53 to
> anywhere" lets a compromised pod tunnel data out over port 53 to an attacker's
> resolver. Pin the **destination selector** to CoreDNS so only the real DNS
> service is reachable.

```quiz
{
  "question": "Why does this policy exclude kube-system and the other system namespaces from its subject?",
  "options": [
    "System namespaces can't run network policy",
    "So the default-deny doesn't apply to CoreDNS itself - otherwise you'd block the DNS service you're trying to allow access to",
    "Because CoreDNS uses port 53 and system namespaces use a different port"
  ],
  "answer": 1,
  "explain": "The carve-out is for workloads reaching DNS. If the lockdown also covered the DNS pods, you'd cut off the very service every pod is trying to reach."
}
```

## Recap

DNS is the universal exception: allow egress to CoreDNS on UDP **and** TCP 53,
pinned to its label, and keep the system plane out of your lockdown. Allowing
the right traffic also means matching it precisely - which protocol, which
port. That's the next lesson: **ports and protocols**.
