# Your first policy: Kubernetes NetworkPolicy

Kubernetes has a flat network architecture where by default every resource within a cluster can talk to every internal and external resources within their rechable network. This means one compromised workload can reach everything within your network and compromise everybit of your environment, to fix this vulnerability platform engineers use network policy resources.

There are multiple Network policy resources some standard (shipped with Kubernetes), some upcoming changes to network policy model (Kubernetes network policy API group), and some dependant on your policy engine. However, the most important thing to note is that Kubernetes on its own doesn't enforce any of these security policies and it delegates the responsibility to your CNI.

the upstream **Kubernetes NetworkPolicy** (KNP) (`networking.k8s.io/v1`).

## What you'll learn

- That KNP is **namespaced** and picks the pods it
  governs with `spec.podSelector`.
- How selecting a pod with a `policyTypes: [Ingress]` policy flips it to
  **default-deny** - no `Deny` rule required.
- That only the pods you select change; everything else stays open.

## What is a Kubernetes NetworkPolicy?

KNP is a network security resource shipped with every Kubernetes cluster, this is the most wiedly supported network security feature in Kubernetes.

KNP is **namespaced** and is similar to an **allow-list**: as you can't write an explicit deny, as you can only name what's permitted, and the act of selecting a pod flips it to default-deny.

The anatomy of KNP:

| Field | Purpose |
|---|---|
| `spec.podSelector` | which pods *in this namespace* the policy governs (`matchLabels`/`matchExpressions`); empty selects every pod in the namespace |
| `spec.policyTypes` | `Ingress`, `Egress`, or both - the directions this policy default-denies |
| `spec.ingress[].from` / `spec.egress[].to` | the allowed peers: `podSelector`, `namespaceSelector`, or `ipBlock` (a CIDR) |
| `spec.ingress[].ports` / `egress[].ports` | allowed `protocol` + `port` (plus `endPort` for a range) |

While a Kubernetes NetworkPolicy (KNP) can reference resources in other namespaces using a `namespaceSelector`, its traffic-filtering effects are strictly confined to the single namespace defined in its metadata header. A KNP cannot enforce or influence networking behavior inside foreign namespaces.

> **Note:** In case of ommiting the namespace from your policy, it will change to `default` or the default namespace set in your `kubectl` command. 

## The policy

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
      ports:
        - protocol: TCP
          port: 8080
```

- **`metadata.namespace: prod`** - a KNP only ever acts inside its own
  namespace. `dev` is a different world, untouched by this object.
- **`podSelector: {app: backend}`** - the policy governs the `prod/backend`
  pod and nothing else.
- **`ingress.from.podSelector: {app: frontend}`** - the one admitted source.
- Because a policy now selects `prod/backend`, that pod is **default-deny**:
  every inbound connection is refused unless this rule allows it.

## What to observe

**Allowed**

- `prod/frontend → prod/backend:8080` - the one path the rule names.

**Denied**

- `prod/database → prod/backend` - a real pod, but not `app == frontend`.
- `dev/frontend → prod/backend` - `podSelector` is namespace-local; this
  `frontend` lives in `dev`, so it isn't matched (more on crossing namespaces in
  the next lesson).

**Untouched (still open)**

- `prod/frontend → prod/database` - `database` is selected by no policy, so it
  keeps the default-allow behaviour.

> **The trap is thinking you "denied" the database.** You didn't. A KNP only
> constrains the pods its `podSelector` matches. Until something selects
> `prod/database`, it accepts everyone. Default-deny is per-selected-pod, not
> per-namespace.

## Recap

A KNP is namespaced, selects pods by label, and the act of
selecting flips those pods to default-deny - you then add back the flows you
trust.

Next: reaching **across namespaces**, and the limits that make you want a
bigger tool.
