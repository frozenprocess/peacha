# Ports & protocols: match the wire, not just the pod

Every probe so far was TCP on 8080, so the **selector** was the only thing that
decided a flow. Real traffic also has a **protocol** and a **port**, and a rule
matches only when all three line up. Each pod here actually runs two servers - a
TCP/HTTP server on `8080` and a UDP echo server on `8081` - which lets us watch a
rule admit one and refuse the other.

## What you'll learn

- That a rule fires only when **selector AND protocol AND port** all match.
- How a missing `protocol` or `ports` field silently **widens** a rule.
- The three port forms: a single value, a list, and an inclusive **range**
  (`"8080:8090"`).

## The policy

```yaml,copy,exec
apiVersion: projectcalico.org/v3
kind: GlobalNetworkPolicy
metadata:
  name: backend-tcp-http-only
spec:
  selector: env == 'prod' && app == 'backend'
  types:
    - Ingress
  ingress:
    - action: Allow
      protocol: TCP
      destination:
        ports:
          - "8080:8090"
```

- **`selector`** picks the governed pod: `prod/backend`.
- **`protocol: TCP`** - this rule ignores UDP, ICMP, everything else.
- **`ports: ["8080:8090"]`** - an inclusive range, as a string. The backend's
  HTTP port 8080 is inside it.

## What to observe

**Allowed**

- `prod/frontend → prod/backend:8080/TCP` - selector, protocol, and port all
  match.

**Denied**

- `prod/frontend → prod/backend:8081/UDP` - the UDP echo server. Wrong protocol
  *and* wrong port; the rule never matches, so default-deny closes it.
- `prod/frontend → prod/backend:9090/TCP` - right protocol, port outside the
  range.

> **The trap is the empty field.** Drop `protocol` and the rule would match the
> UDP echo port too; drop `ports` and it would match every TCP port on the
> backend. Each field you omit is a door you left open. Spell out exactly the
> wire you mean. (`protocol: ICMP` is also valid, for ping-style reachability -
> it carries a type/code rather than a port.)

```quiz
{
  "question": "An ingress rule sets `protocol: TCP` but lists no `ports`. Which traffic does it match?",
  "options": [
    "Only TCP port 80",
    "Every TCP port on the selected pods",
    "No traffic until you add a ports field"
  ],
  "answer": 1,
  "explain": "Omitting `ports` matches every port on that protocol. The selector and protocol still constrain it, but the port dimension is wide open."
}
```

## Recap

A rule is a conjunction: who (selector) **and** what (protocol + ports). Empty
dimensions match everything, so name them deliberately. So far every
destination has been a pod; next we point egress at destinations that **aren't**
pods - an external CIDR set and a Kubernetes Service - to control where data can
leave to.
