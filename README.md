# Peacha, The Online Policy Playground

> In Gilaki, Peacha means a Cat.

<img src="web/src/assets/logo.png" width="120"/>

Peacha is a browser-based playground for learning and testing Kubernetes `NetworkPolicy`, `ClusterNetworkPolicy` and [Calico](https://www.projectcalico.org/) network policy for both `Calico NetworkPolicy`/`GlobalNetworkPolicy`, tiers, and HostEndpoints, without a cluster.

Write a policy, drop in some pods/namespaces/endpoints, and see exactly which connections it allows or denies, evaluated by the real Calico policy engine.

Try it: **https://peacha.frozenspace.eu**

## What it does

- **YAML editor with real schema validation.** Monaco + monaco-yaml, backed by policy schemas generated from the vendored Calico CRDs, so autocomplete and validation match the actual API.
- **Real evaluation, not a simulation.** Policies are run through [Telepathy](https://github.com/frozenprocess/telepathy), an in-process build of Calico's own policy engine, so results reflect how Felix would actually program the dataplane, iptables, nftables, eBPF, and Windows HNS are all supported render targets.
- **Visual connectivity graph.** See allowed/denied traffic between workloads as a graph, not just a verdict.
- **Guided tutorials.** A built-in curriculum (`server/tutorials/`) walks from Kubernetes `NetworkPolicy` basics through Calico-specific concepts: tiers, precedence, staged policies, DNS egress, HostEndpoints, `applyOnForward`, `doNotTrack`, and Windows-specific behavior.
- **Graded exams (optional).** If configured with a private exam repository, Peacha can grade submitted policies against an answer key and track results per signed-in user.
- **Shareable links.** Save a scenario and share it with a short link.
- **Optional OAuth login** (GitHub/Google/Slack) for saving exam results, the playground itself works fully anonymously.

## What to expect

- Peacha is a **teaching and testing tool**, not a policy management system, it doesn't talk to a live cluster or apply anything anywhere.
- It's a **single deployable binary**: a Go server that serves the compiled React/TypeScript SPA and evaluates policies in-process. No external policy-engine service to run.
- Some features (private exams, OAuth login) degrade gracefully when unconfigured: the build succeeds with zero exams and login simply isn't offered.

## Project layout

```
cmd/editor/       entrypoint for the Go binary
server/           HTTP API, policy evaluation glue, tutorials + exams content
web/              React/TypeScript single-page app (the editor UI)
third_party/      git submodules: telepathy (policy engine) + calico (upstream source/CRDs)
deploy/           Dockerfile + Kubernetes manifests
```

## Getting started

Requires Go and Node installed locally.

```sh
git clone --recurse-submodules https://github.com/frozenprocess/peacha.git
cd peacha
make submodules   # fetch third_party/ (engine + Calico), if not already cloned recursively
make dev          # runs the Go server (:8080) and Vite dev server (:5173) together
```

Then open http://localhost:5173.

Other useful targets, run `make` (or `make help`) for the full list:

- `make build`, build the SPA and Go binary into one deployable artifact
- `make test`, run the Go test suite
- `make dev-auth`, like `make dev`, with OAuth login enabled (copy `.env.auth.example` to `.env.auth` first)
- `make image` / `make publish`, build the Docker image (see `deploy/`)

## Releases

See [release workflow and local publishing](docs/releases.md) and
[digest-pinned Kubernetes deployment](deploy/k8s/README.md).

## License

See [LICENSE](LICENSE).

## Credits

Peacha uses [Telepathy](http://github.com/frozenprocess/telepathy), and [Project Calico](https://github.com/projectcalico/calico/) to simulate and visualize the impact of each policy.
