# Windows limitations: when a policy doesn't survive HNS

The last lesson showed the happy path: a clean policy renders on Windows exactly
as on Linux. This one shows the trap. The HNS dataplane **cannot express every
Calico rule**. When Felix hits a rule HNS can't represent, it doesn't error - it
**silently drops the rule** from the ACL list. And the direction of that drop
decides whether you get an inconvenience or a breach:

- A dropped **Deny** → traffic Linux blocks is **allowed** on Windows → a
  **security hole**.
- A dropped **Allow** → traffic Linux permits is **denied** on Windows → merely
  more restrictive (annoying, not dangerous).

## What you'll learn

- The **negated-match drop**, the most dangerous divergence, seen live in the
  Windows (HNS) tab.
- The three other Windows caveats that change how you author policy for a mixed
  cluster.
- The habit that keeps you safe: **preview Windows endpoints on the HNS tab
  before you trust a Deny.**

## See a Deny vanish

Load the policy. It locks frontend egress down to **only** the backend, written
as a `Deny` to everything that is *not* the backend - using a **negated match**
(`notSelector`):

```yaml,copy,exec
apiVersion: projectcalico.org/v3
kind: GlobalNetworkPolicy
metadata:
  name: frontend-egress-lockdown
spec:
  order: 100
  selector: 'app == "frontend"'
  types: [Egress]
  egress:
    - action: Deny
      destination:
        notSelector: 'app == "backend"'
```

On Linux this is exactly what it says: `prod/frontend → prod/database` is
**denied**. The matrix (which shows the engine's Linux verdict) confirms it -
the frontend→database cell is red.

Now open the **Windows (HNS)** tab, set `dir` to `egress`, and filter to
`frontend`. **The Deny rule is not there.** HNS can't render a negated match, so
Felix dropped the whole rule. With nothing left to deny it, on a real Windows
node `frontend → database` would be **allowed**. Same YAML, opposite verdict -
and Windows is the *open* one.

```quiz
{
  "question": "Your GlobalNetworkPolicy uses a Deny with `notSelector`. It works on Linux. What happens on a Windows node?",
  "options": [
    "Felix rejects the policy at admission",
    "HNS can't express the negated match, so Felix silently drops the Deny - the blocked traffic is now allowed (a security hole)",
    "It's enforced identically to Linux"
  ],
  "answer": 1,
  "explain": "Negated matches (notSelector/notPorts/notNets/notProtocol), ICMP type/code, and named ports can't be rendered to HNS. The rule is dropped, not errored - and a dropped Deny opens the traffic it was meant to block."
}
```

## Which rules get dropped

Any rule using a construct HNS can't represent vanishes. The ones to watch:

| Construct | Example |
|---|---|
| **Negated selector** | `source.notSelector`, `destination.notSelector` |
| **Negated ports / nets / protocol** | `notPorts`, `notNets`, `notProtocol` |
| **ICMP type/code match** | `icmp: { type: 8 }` |
| **Named ports** | `ports: ["http"]` (by name, not number) |

The fix is not "avoid Deny" - it's **avoid these constructs in rules that must
enforce on Windows**, and re-express the intent positively (allow-list the
things you *do* want, rather than deny the negation).

## Three more caveats

**1. IPv4 only.** There is no IPv6 ACL dataplane on Windows Calico. Any IPv6
half of a rule is dropped; the HNS tab has no IPv6 knob for this reason. A
policy that relies on IPv6 CIDRs does nothing on a Windows node.

**2. HostEndpoint policy is Linux-only.** Remember lesson 82's node firewall? On
Windows, Felix emits **zero** HNS rules for `HostEndpoint`s - `applyOnForward`,
`doNotTrack`, and `preDNAT` host policy simply don't apply. Your node firewall
protects Linux nodes only.

**3. A trailing-tier `Pass` becomes `Block`.** On Linux, a `Pass` matched in the
*last* tier falls through to the namespace profile (typically allow). Windows
flattens tiers and rewrites that trailing `Pass` to `Block`, and never appends
the profile - so the same flow is **denied**. If you rely on end-of-stack
`Pass`→profile fall-through, it flips closed on Windows.

## What to observe

With the policy loaded, hold the two views side by side:

- **matrix / iptables tab** (Linux verdict): `prod/frontend → prod/database`
  **denied**.
- **Windows (HNS) tab**, frontend egress: the `Deny` rule is **absent** → the
  same flow would be **allowed** on Windows.

That divergence - visible before you ever touch a Windows node - is the whole
point of previewing the HNS tab.

## Recap

The HNS dataplane silently drops rules it can't express, and a dropped **Deny**
is a hole. Negated matches, ICMP type/code, named ports, IPv6, HostEndpoint
policy, and trailing-tier `Pass` all behave differently - or not at all - on
Windows. When you author policy for a mixed cluster, **check the Windows (HNS)
tab for every endpoint whose security depends on a Deny**, and re-express
negated denies as positive allow-lists. Write once, but verify on both
dataplanes.
