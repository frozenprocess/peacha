# server/exams

This directory is the `//go:embed exams` source for `server/exams.go`. Exam
folders are **not** committed here. `make exams-sync` pulls the private exams
repo (`EXAMS_REPO`) into `third_party/exams` and copies each exam folder in
before `go build`. This README is the only tracked file: it keeps the embed
valid on a public checkout, which then builds with 0 exams. `make clean` and
`make exams-sync` delete everything here except this file.

Every example below is a complete, working exam. Each was graded by the real
handler on both baseline providers (`kind` and `k3d`): its `solution.yaml`
passes, and both its starter and an allow-everything policy fail.

- [How an exam works](#how-an-exam-works)
- [Folder layout](#folder-layout)
- [What you can grade against](#what-you-can-grade-against)
- [`meta.json` reference](#metajson-reference)
- [Example 1: minimal exam, default probes, all files](#example-1-minimal-exam-default-probes-all-files)
- [Example 2: custom probes (ports, HTTP, ICMP, source port, SCTP)](#example-2-custom-probes-ports-http-icmp-source-port-sctp)
- [Example 3: external endpoints, GlobalNetworkSet, NetworkSet, Service](#example-3-external-endpoints-globalnetworkset-networkset-service)
- [Example 4: HostEndpoint and Tier in the starter](#example-4-hostendpoint-and-tier-in-the-starter)
- [Feature index](#feature-index)
- [Testing your exam](#testing-your-exam)
- [Gotchas](#gotchas)

## How an exam works

1. The SPA lists exams from `GET /v1/exams`, sorted by `order` then `title`.
   The response never contains `expect`, `constraints` or `solution.yaml`.
2. Selecting an exam renders `prompt.md`, loads `starter.yaml` into the editor
   and applies the exam's scenario (probes, external endpoints, network sets,
   services).
3. **Check my answer** posts everything in the editor to
   `POST /v1/exams/<name>/grade`. The server rebuilds the topology itself
   (baseline cluster for the learner's selected provider + the exam's
   scenario), evaluates the submission and checks:
   - every `expect` cell against the connectivity matrix, and
   - every `constraints` regex against the submitted YAML text.
4. The exam passes only when every check passes, there are no policy parse
   errors, and there is **at least one** check. An exam with neither
   `expect` nor `constraints` can never be passed.

## Folder layout

One folder per exam. The folder name is free-form (`NN-slug` keeps them
readable); `meta.json`'s `name` is the exam's id.

```
server/exams/
  01-default-deny/
    meta.json        required: scenario + catalogue info + answer key
    prompt.md        optional: markdown shown to the learner
    starter.yaml     optional: what the editor starts with (blank if absent)
    solution.yaml    required by `make test`: the reference answer
    diagram.png      optional: any asset prompt.md references
```

- **`prompt.md`**: GitHub-flavored markdown. Relative image paths
  (`![](diagram.png)`) are served from the exam folder at
  `/v1/exams/<folder>/<file>`. A code fence can add `copy` and/or `exec` after
  the language (```` ```yaml copy exec ````): `exec` adds a button that loads
  the block into the editor. A ```` ```quiz ```` fence renders a self-checked
  quiz (see example 1). Its answer key ships to the browser, so it's for
  practice only and is never graded.
- **`starter.yaml`**: multi-document YAML. Policy kinds (`NetworkPolicy`,
  `GlobalNetworkPolicy`, `Tier`, `ClusterNetworkPolicy`, `Staged*`, ...) load
  into the editor. `HostEndpoint`, `NetworkSet` and `GlobalNetworkSet`
  documents are also added to the topology used for grading.
- **`solution.yaml`**: multi-document YAML graded exactly as if a learner had
  typed it into the editor, so it should include the starter's documents too.
  Served by `GET /v1/exams/<name>/solution` (the **Show solution** button) only
  when login is disabled; with login enabled the route returns 404.

## What you can grade against

Matrix cells are addressed by endpoint id, `src` -> `dst`.

**Baseline workloads.** Same ids, IPs and labels on every provider
(`server/baseline/topology.yaml`):

| id | IP | labels |
|----|----|--------|
| `prod/frontend` | 10.244.0.1 | `app=frontend, tier=web, env=prod` |
| `prod/backend`  | 10.244.0.2 | `app=backend, tier=app, env=prod` |
| `prod/database` | 10.244.0.3 | `app=database, tier=data, env=prod` |
| `dev/frontend`  | 10.244.0.4 | `app=frontend, tier=web, env=dev` |
| `dev/backend`   | 10.244.0.5 | `app=backend, tier=app, env=dev` |
| `dev/database`  | 10.244.0.6 | `app=database, tier=data, env=dev` |

Namespaces `prod` and `dev` carry `env=<name>`, `purpose=policy-eval` and
`kubernetes.io/metadata.name=<name>`.

**Baseline system pods.** These **differ by provider**, so avoid them in
`expect` unless you accept that the exam only works on one provider:

| provider | system pods | nodes |
|----------|-------------|-------|
| `kind` (default) | `kube-system/{coredns,etcd,kube-apiserver,kube-controller-manager,kube-scheduler,kube-proxy}`, `calico-system/{calico-node,calico-typha,calico-kube-controllers,calico-apiserver,csi-node-driver}`, `tigera-operator/tigera-operator`, `local-path-storage/local-path-provisioner` | `policy-llm-control-plane` 172.18.0.2, `policy-llm-worker` 172.18.0.3 |
| `k3d` | `kube-system/coredns`, `calico-system/{calico-node,calico-typha,calico-kube-controllers,calico-apiserver,csi-node-driver,goldmane,whisker}`, `tigera-operator/tigera-operator` | 172.20.0.2, 172.20.0.3 |

**Exam-added endpoints**:

| source | id |
|--------|----|
| `external_endpoints` entry | its `id`, e.g. `world/approved-api` |
| no `external_endpoints` | `world/internet` (203.0.113.1, `scope=internet`) |
| `HostEndpoint` in `starter.yaml` | `host/<metadata.name>` |

**Default probes**, used when `probes` is omitted. The first probe is the
default for any `expect` entry without a `probe`.

| name | protocol | port |
|------|----------|------|
| `tcp`  | tcp  | 8080 |
| `udp`  | udp  | 53 |
| `icmp` | icmp | - |
| `sctp` | sctp | - |

## `meta.json` reference

Note the mixed key styles: scenario keys are snake_case, probe keys are
camelCase. Unknown keys are silently ignored, so a typo just turns a feature off.

| key | type | notes |
|-----|------|-------|
| `name` | string | **Required.** Exam id: used in URLs and recorded passes. Unique. |
| `flavor` | string | **Required, must be `"calico"`**, or the exam is skipped. |
| `title` | string | Catalogue heading. |
| `track` | string | Badge shown above the prompt. |
| `order` | int | Sort key (ascending), then `title`. |
| `summary` | string | One-line catalogue description. |
| `probes` | array | Replaces the default probes. See below. |
| `external_endpoints` | array | `{ "id", "ip", "labels" }`. Replaces `world/internet`. |
| `global_network_sets` | array | `{ "name", "nets": [CIDR], "labels" }` |
| `services` | array | `{ "name", "namespace", "selector": {}, "ports": [...] }` |
| `expect` | array | `{ "probe"?, "src", "dst", "want": "allow" \| "deny" }` |
| `constraints` | array | `{ "description", "requireMatch"?, "forbidMatch"? }` |

**Probe** fields: `name` (required, unique), `protocol` (`tcp`, `udp`, `icmp`,
`icmpv6`, `sctp`, `udplite` or a number), `port`, `srcPort`, `httpMethod` and
`httpPath` (only `rule.http` ingress matchers use these), `icmpType`,
`icmpCode`.

**Service port** fields: `port` (required), `name`, `protocol`, `targetPort`
(a string).

**Constraints** are Go regular expressions
([RE2 syntax](https://github.com/google/re2/wiki/Syntax)) run against all
submitted documents joined with `\n---\n`. `requireMatch` must match;
`forbidMatch` must not. JSON needs every backslash doubled (`\\s`, `\\.`).
Add `(?m)` for `^`/`$` per line and `(?i)` for case-insensitive.

NetworkSets and HostEndpoints can't be declared in `meta.json`; put them in
`starter.yaml` (examples 3 and 4).

## Example 1: minimal exam, default probes, all files

Uses the default probes. `expect` entries without `probe` run on `tcp`; one entry checks `udp` explicitly. The constraints show both `requireMatch` and `forbidMatch`. `prompt.md` shows an image (add `diagram.png` to the folder) and a quiz. The starter is a Kubernetes NetworkPolicy, with no rules yet, for the learner to fill in.


`01-default-deny/meta.json`

```json
{
  "name": "exam-default-deny",
  "flavor": "calico",
  "title": "Lock down the prod database",
  "track": "Fundamentals",
  "order": 10,
  "summary": "Only the prod backend may reach the prod database.",
  "expect": [
    { "src": "prod/backend",  "dst": "prod/database", "want": "allow" },
    { "src": "prod/frontend", "dst": "prod/database", "want": "deny" },
    { "src": "dev/backend",   "dst": "prod/database", "want": "deny" },
    { "probe": "udp", "src": "prod/backend", "dst": "prod/database", "want": "deny" }
  ],
  "constraints": [
    {
      "description": "Use a Kubernetes NetworkPolicy",
      "requireMatch": "apiVersion:\\s*networking\\.k8s\\.io/v1"
    },
    {
      "description": "Don't allow from every pod (empty podSelector in a from clause)",
      "forbidMatch": "-\\s*podSelector:\\s*\\{\\s*\\}"
    }
  ]
}
```

`01-default-deny/prompt.md`

````markdown
# Lock down the prod database

The `prod/database` pod accepts traffic from anything. Write a policy so that
**only `prod/backend`** can reach it, and only on **TCP 8080**.

![The prod namespace](diagram.png)

```quiz
{
  "question": "Which field picks the pods a NetworkPolicy applies to?",
  "options": ["spec.podSelector", "spec.ingress.from", "metadata.labels"],
  "answer": 0,
  "explain": "spec.podSelector selects the policy's subjects."
}
```
````

`01-default-deny/starter.yaml`

```yaml
# Starter: an empty policy for the database - fill in the ingress rules.
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: database-ingress
  namespace: prod
spec:
  podSelector:
    matchLabels:
      app: database
  policyTypes:
    - Ingress
```

`01-default-deny/solution.yaml`

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: database-ingress
  namespace: prod
spec:
  podSelector:
    matchLabels:
      app: database
  policyTypes:
    - Ingress
  ingress:
    - from:
        - podSelector:
            matchLabels:
              app: backend
      ports:
        - protocol: TCP
          port: 8080
```


## Example 2: custom probes (ports, HTTP, ICMP, source port, SCTP)

`probes` replaces the defaults, so the first entry (`http-get-api`) is the default for `expect` entries without `probe`. There's no `starter.yaml`, so the editor starts blank.


`02-ports-and-protocols/meta.json`

```json
{
  "name": "exam-ports-and-protocols",
  "flavor": "calico",
  "title": "Ports, protocols and HTTP",
  "track": "Fundamentals",
  "order": 20,
  "summary": "Allow only HTTP GET /api on 8080 and ping to the prod backend.",
  "probes": [
    { "name": "http-get-api", "protocol": "tcp", "port": 8080, "httpMethod": "GET",  "httpPath": "/api" },
    { "name": "http-post-api", "protocol": "tcp", "port": 8080, "httpMethod": "POST", "httpPath": "/api" },
    { "name": "tcp-9090", "protocol": "tcp", "port": 9090 },
    { "name": "tcp-from-1234", "protocol": "tcp", "port": 8080, "srcPort": 1234 },
    { "name": "udp-dns", "protocol": "udp", "port": 53 },
    { "name": "ping", "protocol": "icmp", "icmpType": 8, "icmpCode": 0 },
    { "name": "sctp", "protocol": "sctp", "port": 9000 }
  ],
  "expect": [
    { "src": "prod/frontend", "dst": "prod/backend", "want": "allow" },
    { "probe": "http-post-api", "src": "prod/frontend", "dst": "prod/backend", "want": "deny" },
    { "probe": "tcp-9090",      "src": "prod/frontend", "dst": "prod/backend", "want": "deny" },
    { "probe": "tcp-from-1234", "src": "prod/frontend", "dst": "prod/backend", "want": "deny" },
    { "probe": "udp-dns",       "src": "prod/frontend", "dst": "prod/backend", "want": "deny" },
    { "probe": "ping",          "src": "prod/frontend", "dst": "prod/backend", "want": "allow" },
    { "probe": "sctp",          "src": "prod/frontend", "dst": "prod/backend", "want": "deny" }
  ],
  "constraints": [
    { "description": "Match on the HTTP method", "requireMatch": "methods:" }
  ]
}
```

`02-ports-and-protocols/prompt.md`

````markdown
# Ports, protocols and HTTP

Allow `prod/frontend` to send **GET /api** (TCP 8080, any source port above 1024 is fine - but not 1234) and to **ping** `prod/backend`. Everything else to the backend is denied.
````

`02-ports-and-protocols/solution.yaml`

```yaml
apiVersion: projectcalico.org/v3
kind: NetworkPolicy
metadata:
  name: backend-ingress
  namespace: prod
spec:
  selector: app == 'backend'
  types:
    - Ingress
  ingress:
    - action: Allow
      protocol: TCP
      source:
        selector: app == 'frontend'
        notPorts: [1234]
      destination:
        ports: [8080]
      http:
        methods: ["GET"]
        paths:
          - exact: /api
    - action: Allow
      protocol: ICMP
      icmp:
        type: 8
        code: 0
      source:
        selector: app == 'frontend'
```


## Example 3: external endpoints, GlobalNetworkSet, NetworkSet, Service

`external_endpoints` replaces `world/internet` with three off-cluster targets. The GlobalNetworkSet (from `meta.json`) covers the approved API. The namespaced NetworkSet (from `starter.yaml`) covers the partner. The Service lets a rule reach the backend by name. The constraints make the learner use each of them rather than hard-coding addresses.


`03-egress-destinations/meta.json`

```json
{
  "name": "exam-egress-destinations",
  "flavor": "calico",
  "title": "Egress only to approved destinations",
  "track": "Egress",
  "order": 30,
  "summary": "The prod frontend may only talk to an approved external API, a partner, and the backend Service.",
  "external_endpoints": [
    { "id": "world/approved-api", "ip": "203.0.113.10", "labels": { "scope": "approved" } },
    { "id": "world/partner",      "ip": "192.0.2.20",    "labels": { "scope": "partner" } },
    { "id": "world/attacker",     "ip": "198.51.100.66", "labels": { "scope": "internet" } }
  ],
  "global_network_sets": [
    { "name": "approved-egress", "nets": ["203.0.113.0/24"], "labels": { "egress": "approved" } }
  ],
  "services": [
    {
      "name": "backend-svc",
      "namespace": "prod",
      "selector": { "app": "backend" },
      "ports": [ { "name": "http", "port": 8080, "protocol": "TCP", "targetPort": "8080" } ]
    }
  ],
  "expect": [
    { "src": "prod/frontend", "dst": "world/approved-api", "want": "allow" },
    { "src": "prod/frontend", "dst": "world/partner",      "want": "allow" },
    { "src": "prod/frontend", "dst": "world/attacker",     "want": "deny" },
    { "src": "prod/frontend", "dst": "prod/backend",       "want": "allow" },
    { "src": "prod/frontend", "dst": "prod/database",      "want": "deny" }
  ],
  "constraints": [
    { "description": "Select the approved CIDRs through the GlobalNetworkSet's labels", "requireMatch": "egress\\s*==\\s*'approved'" },
    { "description": "Select the partner through the NetworkSet's labels", "requireMatch": "partner\\s*==\\s*'true'" },
    { "description": "Reach the backend through its Service", "requireMatch": "services:" }
  ]
}
```

`03-egress-destinations/prompt.md`

````markdown
# Egress only to approved destinations

Restrict `prod/frontend` egress to three destinations:

- the `approved-egress` GlobalNetworkSet (label `egress: approved`)
- the `partner` NetworkSet in `prod` (label `partner: "true"`), defined in the starter
- the `backend-svc` Service
````

`03-egress-destinations/starter.yaml`

```yaml
# The partner's address range, as a namespaced NetworkSet in prod.
apiVersion: projectcalico.org/v3
kind: NetworkSet
metadata:
  name: partner
  namespace: prod
  labels:
    partner: "true"
spec:
  nets: ["192.0.2.0/24"]
```

`03-egress-destinations/solution.yaml`

```yaml
# The partner's address range, as a namespaced NetworkSet in prod.
apiVersion: projectcalico.org/v3
kind: NetworkSet
metadata:
  name: partner
  namespace: prod
  labels:
    partner: "true"
spec:
  nets: ["192.0.2.0/24"]
---
apiVersion: projectcalico.org/v3
kind: NetworkPolicy
metadata:
  name: frontend-egress
  namespace: prod
spec:
  selector: app == 'frontend'
  types:
    - Egress
  egress:
    - action: Allow
      destination:
        selector: egress == 'approved'
        namespaceSelector: global()
    - action: Allow
      destination:
        selector: partner == 'true'
    - action: Allow
      destination:
        services:
          name: backend-svc
          namespace: prod
```


## Example 4: HostEndpoint and Tier in the starter

The starter's HostEndpoint becomes the `host/node-worker` endpoint used in `expect`. Its GlobalNetworkSet is graded the same way as one declared in `meta.json`. The Tier lets the solution's `spec.tier` resolve. An exam can also leave the Tier for the learner to write.


`04-host-firewall/meta.json`

```json
{
  "name": "exam-host-firewall",
  "flavor": "calico",
  "title": "Firewall the nodes",
  "track": "Host protection",
  "order": 40,
  "summary": "Put the worker node's HostEndpoint behind a GlobalNetworkPolicy in its own tier.",
  "external_endpoints": [
    { "id": "world/office",   "ip": "198.51.100.7", "labels": { "scope": "internet" } },
    { "id": "world/attacker", "ip": "203.0.113.5",  "labels": { "scope": "internet" } }
  ],
  "expect": [
    { "src": "world/office",   "dst": "host/node-worker", "want": "allow" },
    { "src": "dev/backend",    "dst": "host/node-worker", "want": "allow" },
    { "src": "world/attacker", "dst": "host/node-worker", "want": "deny" },
    { "src": "prod/frontend",  "dst": "host/node-worker", "want": "deny" }
  ],
  "constraints": [
    { "description": "Put the firewall in the host-firewall tier", "requireMatch": "tier:\\s*host-firewall" },
    { "description": "Admit the office through the office-ips GlobalNetworkSet's label", "requireMatch": "trust\\s*==\\s*'office'" }
  ]
}
```

`04-host-firewall/prompt.md`

````markdown
# Firewall the nodes

The starter defines the worker node's HostEndpoint, an `office-ips`
GlobalNetworkSet (label `trust: office`) and a `host-firewall` Tier. Write a
GlobalNetworkPolicy in that tier so the node accepts traffic only from the
office and from pods in the `dev` namespace.
````

`04-host-firewall/starter.yaml`

```yaml
apiVersion: projectcalico.org/v3
kind: HostEndpoint
metadata:
  name: node-worker
  labels:
    role: node
spec:
  node: policy-llm-worker
  interfaceName: "*"
  expectedIPs: ["172.18.0.3"]
---
apiVersion: projectcalico.org/v3
kind: GlobalNetworkSet
metadata:
  name: office-ips
  labels:
    trust: office
spec:
  nets: ["198.51.100.0/24"]
---
apiVersion: projectcalico.org/v3
kind: Tier
metadata:
  name: host-firewall
spec:
  order: 1000000
  defaultAction: Deny
```

`04-host-firewall/solution.yaml`

```yaml
apiVersion: projectcalico.org/v3
kind: HostEndpoint
metadata:
  name: node-worker
  labels:
    role: node
spec:
  node: policy-llm-worker
  interfaceName: "*"
  expectedIPs: ["172.18.0.3"]
---
apiVersion: projectcalico.org/v3
kind: GlobalNetworkSet
metadata:
  name: office-ips
  labels:
    trust: office
spec:
  nets: ["198.51.100.0/24"]
---
apiVersion: projectcalico.org/v3
kind: Tier
metadata:
  name: host-firewall
spec:
  order: 1000000
  defaultAction: Deny
---
apiVersion: projectcalico.org/v3
kind: GlobalNetworkPolicy
metadata:
  name: node-ingress
spec:
  tier: host-firewall
  order: 100
  selector: role == 'node'
  types:
    - Ingress
  ingress:
    - action: Allow
      source:
        selector: trust == 'office'
    - action: Allow
      source:
        namespaceSelector: env == 'dev'
```


## Feature index

| feature | example |
|---------|---------|
| default probes, `expect` without `probe` | 1 |
| `expect` with an explicit `probe` | 1, 2 |
| `want: "deny"` | 1, 2, 3, 4 |
| `requireMatch` | 1, 2, 3, 4 |
| `forbidMatch` | 1 |
| `track`, `order`, `summary` | all |
| prompt image, quiz | 1 |
| `starter.yaml` with a policy | 1 |
| no `starter.yaml` (blank editor) | 2 |
| custom `probes`: tcp port, HTTP method/path, `srcPort`, UDP, ICMP type/code, SCTP | 2 |
| Kubernetes `NetworkPolicy` | 1 |
| Calico `NetworkPolicy` | 2, 3 |
| `GlobalNetworkPolicy` | 4 |
| `external_endpoints` | 3, 4 |
| `global_network_sets` in `meta.json` | 3 |
| `GlobalNetworkSet` in `starter.yaml` | 4 |
| `NetworkSet` in `starter.yaml` | 3 |
| `services` | 3 |
| `HostEndpoint` (`host/<name>` targets) | 4 |
| `Tier` | 4 |
| ingress / egress | 1, 2, 4 / 3 |

## Testing your exam

```sh
make test        # runs exams-sync, then go test
```

`TestExamSolutionsPass` (`server/solution_test.go`) grades every exam's
`solution.yaml` against the default provider (`kind`). It fails if any exam
has no solution or the solution doesn't pass. To try an exam without the
private repo, put its folder directly in `server/exams/` and run
`go test ./server -run TestExamSolutionsPass`. Don't run `make test` for that,
because `exams-sync` replaces the folder.

Also check that:

- the starter on its own fails,
- a lazy answer fails, for example the starter plus a `GlobalNetworkPolicy`
  with `selector: all()` allowing all ingress and egress, and
- the solution passes with the `k3d` provider selected in the UI too.

If the starter or the lazy answer passes, add `expect` cells or constraints.

## Gotchas

- **Network sets only match external endpoints.** The engine matches
  `NetworkSet`/`GlobalNetworkSet` CIDRs against off-cluster endpoints
  (`external_endpoints`), never against pods, even when a pod's IP is inside
  the CIDR. To allow a group of pods, select them by label or namespace instead.
- **GlobalNetworkSets from a namespaced policy:** a `selector` in a
  `NetworkPolicy` rule only matches its own namespace. Add
  `namespaceSelector: global()` to match a GlobalNetworkSet (example 3). A
  `GlobalNetworkPolicy` matches them without it (example 4).
- **Wrong endpoint ids:** a check fails with "no such flow in the topology".
  A wrong `probe` name fails with "no such probe". Both happen when an exam
  uses a system pod that the learner's provider doesn't have.
- **Constraints see the whole editor:** they don't see the topology, but the
  submission includes the starter's documents. Don't `requireMatch` text the
  starter already contains (it passes for free). Don't `forbidMatch` text the
  starter needs (it can never pass). For example, forbidding `nets:` would
  block a starter NetworkSet.
- **Changing `name` after people have passed** orphans their recorded passes.
