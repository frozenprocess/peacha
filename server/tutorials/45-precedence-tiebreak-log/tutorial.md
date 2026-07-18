# Precedence deep-dive: ties and the Log action

`order` decides which policy wins - until two policies have the **same** order,
or none at all. Then Calico needs a tiebreaker, and the answer surprises people:
it compares **policy names**. This lesson shows that tiebreaker live, then
covers the one action that quietly bends how a policy is read: `Log`.

## What you'll learn

- That an unset `order` means **infinity**, so unordered policies all tie.
- That ties are broken by **policy name, alphabetically** - and why that's a
  footgun for policies that disagree.
- That **`Log` is non-terminal**: it logs and falls through, so the rule
  *after* it is the real decision.

## The tie

```yaml,copy,exec
apiVersion: projectcalico.org/v3
kind: GlobalNetworkPolicy
metadata:
  name: aaa-allow-frontend
spec:
  selector: env == 'prod' && app == 'backend'
  types:
    - Ingress
  ingress:
    - action: Allow
      source:
        selector: app == 'frontend'
---
apiVersion: projectcalico.org/v3
kind: GlobalNetworkPolicy
metadata:
  name: zzz-deny-frontend
spec:
  selector: env == 'prod' && app == 'backend'
  types:
    - Ingress
  ingress:
    - action: Deny
      source:
        selector: app == 'frontend'
```

Both select `prod/backend`. Both match `frontend → backend`. One allows, one
denies. Neither sets `order`, so both are at infinity - a tie. Calico compares
names: `aaa-allow-frontend` sorts before `zzz-deny-frontend`, so the **Allow is
evaluated first and wins**.

## What to observe

**Allowed**

- `prod/frontend → prod/backend` - `aaa-allow-frontend` wins the name tiebreak.

> **The trap:** this verdict hangs entirely on a string comparison. Rename the
> deny to `aaa-deny-frontend` (or give it `order: 100`) and the **same flow
> flips to denied**. Two policies that disagree should *never* rely on the name
> tiebreaker - set an explicit `order`.

## The Log action

`Log` writes a log line for matching packets - and then **keeps going**. It is
*not* a verdict. Whatever rule comes next is what actually decides the flow:

```yaml
apiVersion: projectcalico.org/v3
kind: GlobalNetworkPolicy
metadata:
  name: log-then-decide
spec:
  order: 50
  selector: app == 'backend'
  types:
    - Ingress
  ingress:
    - action: Log              # logs, then falls through - NOT a decision
      source:
        selector: app == 'database'
    - action: Deny             # THIS is what actually happens to database
      source:
        selector: app == 'database'
```

Because `Log` falls through, the `Deny` immediately after it is the real
verdict. If you forget that second rule, the flow isn't denied - it just gets
logged and continues down the order to whatever matches next. Treat a `Log` as
"annotate and continue," and always pair it with the rule you actually mean.

```quiz
{
  "question": "Two Calico policies both omit spec.order and disagree on a flow. What decides it?",
  "options": [
    "The one created most recently wins",
    "Both must agree or the flow is dropped",
    "Calico compares the policy names alphabetically; the earlier name is evaluated first"
  ],
  "answer": 2,
  "explain": "No order means order=infinity for both - a tie - so Calico falls back to comparing names alphabetically. Set an explicit order whenever the verdict matters."
}
```

## Recap

Precedence is `order` first (lower wins), then **name** as the tiebreaker, then
rule order within a policy - and `Log` sits outside all of that as a
non-terminal annotation. With precedence fully understood, we can now build
real structure. Next: using Calico `NetworkPolicy` to **microsegment the tiers**
of an app so traffic can only flow web → app → data.
