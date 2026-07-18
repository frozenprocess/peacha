# The layered posture: all four policy types together

You've climbed the whole ladder - from the policy your cluster already supports
to Calico's cluster-wide controls. This page is a read-only recap: it loads no
policy, so it won't disturb whatever you have in the editor. Use it to lock in
*which tool for which job* and *how they resolve together*.

## The four types at a glance

| Type | Scope | Deny? | Order? | Owner | Reach for it when... |
|---|---|---|---|---|---|
| **Kubernetes NetworkPolicy** | namespaced | no (allow-only) | no | app team | you want portable, allow-list rules inside one namespace |
| **ClusterNetworkPolicy** | cluster | yes | `priority` + tiers | platform team | you need cluster-wide guardrails app teams can't override, with `Pass` delegation |
| **Calico NetworkPolicy** | namespaced | yes | `order` | app team | you need a namespaced rule with `Deny` and explicit ordering |
| **GlobalNetworkPolicy** | cluster | yes | `order` | platform team | you need one rule across every namespace, or to govern non-pod endpoints |

## How a single flow is decided

A flow isn't judged by one policy - it's judged by the **whole stack**, and the
**first decision wins**:

1. **Tiers, top to bottom.** The Network Policy API's `Admin` tier goes first
   (its `Accept`/`Deny` is final; `Pass` delegates), then the default tier
   (Kubernetes + Calico `NetworkPolicy` and `GlobalNetworkPolicy`), then the
   `Baseline` floor.
2. **Within a tier, by `order`/`priority`** - lower is evaluated first.
3. **Ties** break by policy **name**, alphabetically.
4. **Within a policy**, rules run top to bottom; the first match is the verdict
   (and remember `Log` is *not* a verdict - it falls through).
5. If nothing matched, the tier's default action applies - and a default-deny
   baseline means the flow is dropped.

> Calico ranks every Kubernetes NetworkPolicy at `order: 1000`, which is how the
> upstream and Calico kinds coexist in the same tier.

## The posture you built

Across the track you assembled a defense-in-depth stack: a Kubernetes
NetworkPolicy default-deny inside a namespace → cluster guardrails with
ClusterNetworkPolicy → namespaced `Deny`/`order` with Calico NetworkPolicy →
tier microsegmentation → a cluster-wide default-deny with the DNS carve-out →
precise port/protocol matching → an egress allowlist against exfiltration →
control-plane containment → and a safe, staged rollout.

```quiz
{
  "question": "A flow is Passed by an Admin ClusterNetworkPolicy, allowed by a Calico GlobalNetworkPolicy in the default tier, and would be denied by the Baseline floor. What happens?",
  "options": [
    "Denied - the Baseline floor always has the final say",
    "Allowed - Admin Pass delegates downward, the default tier's Allow decides, and the Baseline floor is never reached",
    "Dropped - the verdicts conflict"
  ],
  "answer": 1,
  "explain": "Pass hands the decision to the next tier down. The default tier's Allow is a verdict, so evaluation stops there and the Baseline floor never runs."
}
```

```quiz
{
  "question": "You need a cluster-wide rule that DENIES a source and must not be overridable by an app team's NetworkPolicy. Which type fits best?",
  "options": [
    "Kubernetes NetworkPolicy",
    "Calico NetworkPolicy",
    "An Admin-tier ClusterNetworkPolicy (or a GlobalNetworkPolicy at a low order)"
  ],
  "answer": 2,
  "explain": "KNP can't deny at all. A namespaced Calico NetworkPolicy can deny but is namespace-scoped. A cluster-wide, high-precedence control - an Admin CNP whose Deny is final, or a low-order GlobalNetworkPolicy - is what enforces a boundary app teams can't undo."
}
```

## Where to go next

- Re-open any lesson and **edit** the policy in place - change a selector, swap
  `Allow` for `Deny`, watch the matrix and graph react.
- Try composing two lessons at once (e.g. the cluster default-deny *plus* the
  DNS carve-out) to see precedence resolve a real stack.

That's the whole toolkit - from your cluster's first policy to a layered,
zero-trust posture. Go break things safely.
