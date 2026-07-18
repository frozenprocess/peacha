# Egress to named destinations: stop the data exfil path

Ingress rules decide who can reach a pod. **Egress** rules decide where a pod
can send - and that's the direction that matters once a workload is
compromised, because exfiltration and command-and-control are outbound. Here we
default-deny the frontend's egress and allow exactly two destinations, neither
of them a hard-coded IP: an approved external network and an in-cluster Service.

## What you'll learn

- How a **`GlobalNetworkSet`** lets an egress rule name an external CIDR by
  **label** instead of a literal address.
- How **`destination.services`** targets a Kubernetes Service, following its
  pods as they scale.
- Why an egress allowlist is your last line against data exfiltration.

## The policy

```yaml,copy,exec
apiVersion: projectcalico.org/v3
kind: GlobalNetworkPolicy
metadata:
  name: frontend-egress-allowlist
spec:
  selector: env == 'prod' && app == 'frontend'
  types:
    - Egress
  egress:
    - action: Allow
      destination:
        selector: scope == 'approved-egress'
    - action: Allow
      protocol: TCP
      destination:
        services:
          name: backend-svc
          namespace: prod
```

- **Rule 1 → a GlobalNetworkSet.** The set `approved-egress` carries CIDR
  `203.0.113.0/24` and the label `scope: approved-egress`. The rule allows egress
  to `scope == 'approved-egress'`, which resolves to that CIDR. Add a network to
  the set later and every rule that names it updates at once.
- **Rule 2 → a Service.** `backend-svc` resolves to the live backend pod IPs, so
  the rule tracks the backend without naming pods or addresses.
- **`types: [Egress]`** with no catch-all means every other destination is
  default-denied.

## What to observe

**Allowed**

- `prod/frontend → world/approved-api` (`203.0.113.10`) - inside the set's CIDR.
- `prod/frontend → backend-svc` (the prod backend pods) - via the Service.

**Denied**

- `prod/frontend → world/attacker` (`198.51.100.66`, `scope: internet`) - not in
  the approved set. This is the exfil attempt the policy stops.
- `prod/frontend → prod/database` - never on the allowlist.

> **The trap is a bare `nets:` rule with a wide CIDR** (or worse, `0.0.0.0/0`).
> It "works" today and quietly permits exfiltration to anywhere in that range.
> Name a labelled set instead: the allowlist becomes explicit, auditable, and
> editable in one place.

## Recap

Egress allowlisting - to a labelled CIDR set and to Services - is how you decide
where data may leave to, the control that bites during a breach. We've now
secured the apps from every angle. Next we protect the layer underneath them:
the **cluster infrastructure**, so a popped pod can't reach the control plane.
