# Ship it safely: staged policy and avoiding lockout

You've built a full posture. The last skill is operational: how do you *deploy*
a default-deny without causing the outage you're trying to prevent? The first
`Deny` in production is the scariest change in networking - one wrong selector
and traffic stops. Calico's answer is the **staged** policy: a dry run that
matches exactly like the real thing but enforces nothing.

## What you'll learn

- That a `StagedGlobalNetworkPolicy` runs through the same matching machinery
  but is **observe-only** - it changes the matrix by **nothing**.
- How you **promote** it to enforcement by deleting one word.
- The **allow-first safe-mode** habit that stops you locking yourself out.

## What is a StagedGlobalNetworkPolicy?

A `StagedGlobalNetworkPolicy` is a `GlobalNetworkPolicy` in a dry-run costume. Its
spec is the **entire `GlobalNetworkPolicy` schema** - same `selector`, `order`,
`tier`, `types`, and rules - with one behavioural difference: the dataplane treats
every verdict as **observe-only**. It matches exactly like the enforced policy but
never drops or allows a packet, so adding one changes the connectivity matrix by
nothing.

| | GlobalNetworkPolicy | StagedGlobalNetworkPolicy |
|---|---|---|
| **Schema** | full rule grammar | **identical** |
| **Enforcement** | live - drops/allows packets | **observe-only** (logged, never enforced) |
| **Extra field** | — | **`spec.stagedAction`** (`Set`/`Delete`/`Learn`/`Ignore`) - the staged lifecycle marker |

You preview a change as a `StagedGlobalNetworkPolicy`, read its would-be effect
from flow logs, then promote it to the enforced `GlobalNetworkPolicy`. (There are
staged variants of the other kinds too - `StagedNetworkPolicy`,
`StagedKubernetesNetworkPolicy` - same idea.)

## The policies

```yaml,copy,exec
apiVersion: projectcalico.org/v3
kind: GlobalNetworkPolicy
metadata:
  name: database-allow-from-backend
spec:
  selector: env == 'prod' && app == 'database'
  types:
    - Ingress
  ingress:
    - action: Allow
      protocol: TCP
      source:
        selector: env == 'prod' && app == 'backend'
      destination:
        ports: [8080]
---
apiVersion: projectcalico.org/v3
kind: StagedGlobalNetworkPolicy
metadata:
  name: backend-lockdown-staged
spec:
  selector: env == 'prod' && app == 'backend'
  types:
    - Ingress
```

The first object is **enforced** and live: `prod/database` accepts ingress only
from `prod/backend`. The second is **staged**: it would default-deny the
backend's ingress - but because it's staged, it only *previews* that.

## What to observe

**Allowed (unchanged)**

- `prod/backend → prod/database:8080` - the enforced policy is doing real work.
- `prod/frontend → prod/backend` - the staged lockdown does **not** block this;
  it's observe-only.

The staged policy adds **zero** changes to the connectivity matrix. That's the
whole point: you ship it, watch its would-be verdicts in flow logs, confirm it
only denies what you intend, *then* enforce.

> **Promote it by deleting one word.** Change `kind:
> StagedGlobalNetworkPolicy` to `kind: GlobalNetworkPolicy` and the same rules
> start enforcing. Stage → observe → promote is the safe rollout loop.

## Avoiding lockout (safe-mode)

When you experiment with denies on infrastructure you can lock *yourself* out
(SSH, the API server, the dataplane). The habit that prevents it: apply an
explicit allow-everything **first**, layer your denials, confirm the cluster is
healthy, and remove the allow-all **last**.

```yaml
# Apply this BEFORE experimenting with denies; remove it LAST.
apiVersion: projectcalico.org/v3
kind: GlobalNetworkPolicy
metadata:
  name: zzz-final-allow-everything
spec:
  order: 100000          # very high -> evaluated last -> a safety net, not a shield
  types: [Ingress, Egress]
  ingress:
    - action: Allow
  egress:
    - action: Allow
```

Its high `order` means every real policy is consulted first; it only catches
flows nothing else decided - so it can't mask a misconfiguration, but it *can*
keep you reachable while you iterate. (Calico also ships built-in failsafe ports
for exactly this reason.)

```quiz
{
  "question": "You add a StagedGlobalNetworkPolicy that default-denies a pod's ingress. What happens to that pod's live traffic?",
  "options": [
    "It is immediately denied, just like an enforced policy",
    "Nothing changes - staged policies are observe-only; you read the would-be effect from flow logs",
    "Only new connections are denied; existing ones continue"
  ],
  "answer": 1,
  "explain": "A staged policy matches exactly like the enforced version but never drops or allows a packet, so it changes the connectivity matrix by nothing. You promote it by changing the kind to the non-staged form."
}
```

## Recap

Staged policy lets you preview a `Deny` with zero risk, and the allow-first
habit keeps you from locking yourself out while you work. That completes the
toolkit. The final lesson steps back and looks at all four policy types working
together.
