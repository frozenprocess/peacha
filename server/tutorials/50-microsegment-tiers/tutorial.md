# Microsegment the tiers: web → app → data, and no skipping

A three-tier app has exactly two legitimate internal hops: the web tier calls
the app tier, and the app tier calls the data tier. Everything else - the web
tier reaching straight into the database, the database calling back into the
app - is either a bug or an attacker moving laterally. This lesson encodes that
shape with **one** Calico `NetworkPolicy` in `prod`.

## What you'll learn

- How `selector: all()` + `types: [Ingress]` puts every pod in a namespace
  behind default-deny in a single object.
- How pinning **both** `source` and `destination` selectors turns an allow rule
  into one directed edge of your tier graph.
- Why "no tier skipping" falls out for free from the implicit default-deny.

## The policy

```yaml,copy,exec
apiVersion: projectcalico.org/v3
kind: NetworkPolicy
metadata:
  name: prod-tier-microsegmentation
  namespace: prod
spec:
  selector: all()
  types:
    - Ingress
  ingress:
    - action: Allow
      protocol: TCP
      source:
        selector: tier == 'web'
      destination:
        selector: tier == 'app'
        ports: [8080]
    - action: Allow
      protocol: TCP
      source:
        selector: tier == 'app'
      destination:
        selector: tier == 'data'
        ports: [8080]
```

- **`selector: all()`** in namespace `prod` → every prod pod is governed and
  default-denied for ingress.
- **Rule 1** allows only `tier=web → tier=app` (frontend → backend).
- **Rule 2** allows only `tier=app → tier=data` (backend → database).
- No rule mentions any other pairing, so the default-deny closes them.

## What to observe

**Allowed**

- `prod/frontend → prod/backend:8080` - the web→app edge.
- `prod/backend → prod/database:8080` - the app→data edge.

**Denied**

- `prod/frontend → prod/database` - a **tier skip** (web straight to data).
- `prod/database → prod/backend` - **backwards** (data to app).
- anything **→ `prod/frontend`** - nothing is allowed to initiate to the web
  tier internally.

**Untouched**

- All of `dev` - this is a *namespaced* policy, so `dev` keeps its prior
  behaviour. (A `GlobalNetworkPolicy` would cover both; that's coming up.)

```quiz
{
  "question": "Why is `prod/frontend → prod/database` denied even though both rules use Allow?",
  "options": [
    "Because frontend is in the web tier and neither rule allows web→data, so it hits the default-deny",
    "Because Allow rules only work on backend pods",
    "Because the database is in a different namespace"
  ],
  "answer": 0,
  "explain": "Rule 1 is web→app and rule 2 is app→data. A web→data flow matches neither, so the implicit default-deny from selector all()+types:[Ingress] drops it. Tier-skipping is blocked by omission, not by an explicit Deny."
}
```

## Recap

One namespaced policy, two pinned edges, and tier-skipping disappears - that's
microsegmentation. But it only covered `prod`. To enforce a baseline across
**every** namespace at once we need the cluster-wide Calico kind. Next: the
`GlobalNetworkPolicy` and a cluster-wide default-deny.
