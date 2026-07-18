// Package server is the HTTP front-end for ../../calico-engine/calico. It
// exposes a small JSON API the SPA in ../web posts to on every keystroke
// (debounced). All policy semantics live in the engine; this package is
// just request shaping, caching, and serving the embedded UI.
package server

import (
	engineapi "github.com/frozenprocess/telepathy/api"
	"github.com/frozenprocess/telepathy/provider/calico"
)

// Probe is one evaluation profile. The editor sends a list of these per
// request; the server runs the engine once per probe and returns one matrix
// each, so the UI can render different connectivity views (e.g. "tcp" vs "udp"
// vs "icmp" vs "GET /admin") without N round-trips.
//
// Beyond the original (name, port, protocol) tuple, each probe can now carry
// the engine's per-evaluation knobs: a source port, an HTTP method/path (for
// rule.http matchers, ingress-only), and an ICMP type/code (pointers so the
// "unset" case - don't filter on ICMP type/code - is distinguishable from 0).
// Protocol widens beyond tcp/udp to whatever calico.protocolNumber accepts
// (tcp/udp/icmp/icmpv6/sctp/udplite + numeric).
type Probe struct {
	Name       string `json:"name"`
	Port       int    `json:"port"`
	Protocol   string `json:"protocol"`
	SrcPort    int    `json:"srcPort,omitempty"`
	HTTPMethod string `json:"httpMethod,omitempty"`
	HTTPPath   string `json:"httpPath,omitempty"`
	ICMPType   *int   `json:"icmpType,omitempty"`
	ICMPCode   *int   `json:"icmpCode,omitempty"`
}

// EditorRequest is the wire-shape posted by the SPA. The Endpoints,
// Namespaces and Policies fields pass straight through to calico.Evaluate;
// Probes is the editor-only extension that batches multiple (port, proto)
// evaluations into one HTTP call. The resource lists and flags mirror the
// like-named calico.Request fields verbatim and are shared across every probe
// in the batch (they don't vary per (port, proto)).
type EditorRequest struct {
	Endpoints  []calico.Endpoint       `json:"endpoints"`
	Namespaces []calico.NamespaceInput `json:"namespaces"`
	Policies   []calico.PolicyInput    `json:"policies"`
	Probes     []Probe                 `json:"probes"`

	// User-defined Calico Tiers. The engine pre-creates the three reserved
	// tiers (default/kube-admin/kube-baseline); these are extra tiers the
	// editor lets users add so a policy's `spec.tier: <name>` resolves. They
	// don't map to a like-named calico.Request field - the server renders each
	// into a `kind: Tier` document and prepends it to Policies (tiers must be
	// fed before any policy that lives in them; see baseEngineRequest).
	Tiers []TierInput `json:"tiers,omitempty"`

	// Optional topology + resource extensions, forwarded straight into
	// calico.Request. Empty slices/maps preserve the original behaviour.
	ServiceAccounts   []calico.ServiceAccountInput   `json:"serviceAccounts,omitempty"`
	HostEndpoints     []calico.HostEndpointInput     `json:"hostEndpoints,omitempty"`
	NetworkSets       []calico.NetworkSetInput       `json:"networkSets,omitempty"`
	GlobalNetworkSets []calico.GlobalNetworkSetInput `json:"globalNetworkSets,omitempty"`
	Services          []calico.ServiceInput          `json:"services,omitempty"`
	EndpointSlices    []calico.EndpointSliceInput    `json:"endpointSlices,omitempty"`
	DNS               map[string][]string            `json:"dns,omitempty"`

	EvaluateStaged bool `json:"evaluateStaged,omitempty"`
	StrictLint     bool `json:"strictLint,omitempty"`
}

// TierInput is one user-defined Calico Tier. Name is the tier name policies
// reference via spec.tier; Order sets precedence (lower order applies first);
// DefaultAction is what happens to a packet selected by a policy in the tier
// but matched by no rule (Pass falls through to the next tier; Deny drops it).
// Empty DefaultAction defaults to Deny, mirroring Calico's CRD default.
type TierInput struct {
	Name          string  `json:"name"`
	Order         float64 `json:"order"`
	DefaultAction string  `json:"defaultAction,omitempty"` // Pass | Deny
}

// BPFRequest is the wire-shape posted to /v1/bpf: the same topology + policies
// + resources as an EditorRequest (Probes is ignored - eBPF programs aren't
// probe-driven), plus the BPF render filters. The handler maps these to
// calico.BPFOptions. Empty Direction means both; empty IPVersion infers from
// the endpoints; empty Endpoint renders all.
type BPFRequest struct {
	EditorRequest
	Endpoint  string `json:"endpoint,omitempty"`
	Direction string `json:"direction,omitempty"` // ingress | egress | both
	IPVersion string `json:"ipVersion,omitempty"` // 4 | 6 | both
	// Verbose requests the full eBPF disassembly instead of the concise
	// tier→policy→rule tree (mirrors `calico-node bpf policy dump --asm`).
	Verbose bool `json:"verbose,omitempty"`
}

// IptablesRequest is the wire-shape posted to /v1/iptables: the same topology
// + policies + resources as an EditorRequest (Probes ignored - chains aren't
// probe-driven), plus the render filters. Mapped to calico.IptablesOptions.
// Empty Backend means iptables; empty IPVersion infers from the endpoints.
type IptablesRequest struct {
	EditorRequest
	Backend       string `json:"backend,omitempty"`   // iptables | nftables | both
	IPVersion     string `json:"ipVersion,omitempty"` // 4 | 6 | both
	IncludeStatic bool   `json:"includeStatic,omitempty"`
	// Endpoint, when set, restricts output to the chains involved in enforcing
	// endpoints whose ID contains this substring (mirrors BPFRequest.Endpoint).
	Endpoint string `json:"endpoint,omitempty"`
}

// HNSRequest is the wire-shape posted to /v1/hns: the same topology + policies
// + resources as an EditorRequest (Probes ignored - HNS ACL lists aren't
// probe-driven), plus the render filters. Mapped to calico.HNSOptions. Empty
// Direction means both; empty IPVersion defaults to IPv4 (HNS is IPv4-only);
// empty Endpoint renders all.
type HNSRequest struct {
	EditorRequest
	Endpoint  string `json:"endpoint,omitempty"`
	Direction string `json:"direction,omitempty"` // ingress | egress | both
	IPVersion string `json:"ipVersion,omitempty"` // 4 | 6 | both
}

// EditorResponse is matrices keyed by probe name. Errors and Warnings collect
// the union of calico.Response.Errors / .Warnings across all probe
// evaluations; the policy-parse errors and lint warnings are the same for
// every probe (same Policies slice), so we dedupe.
type EditorResponse struct {
	Matrices map[string]map[string]string `json:"matrices"`
	Errors   []string                     `json:"errors,omitempty"`
	Warnings []string                     `json:"warnings,omitempty"`
	// Actors is the typed row/col directory (calico.Response.Actors), the single
	// source of endpoint typing the SPA renders from instead of re-deriving
	// [EXT]/[HEP]/[HOST] itself. Kind/Node are probe-independent so we take them
	// from one probe; the Actor.Internet carried here reflects that single
	// probe - the SPA recomputes internet posture across its visible-probe set.
	Actors []calico.Actor `json:"actors,omitempty"`
	// Cost is the policy-efficiency report for the whole policy set. It's
	// probe-independent (same Policies every probe), so run() asks the engine
	// for it once (first probe only - it's expensive, rebuilding the calc graph
	// via RenderIptables). nil when there are no policies.
	Cost *engineapi.CostReport `json:"cost,omitempty"`
	// Dataplanes is Cost's per-dataplane weight for every dataplane the view
	// tabs can show, keyed "iptables"|"nftables"|"bpf"|"hns". The SPA swaps the
	// cost bar's weight line to match the active view. Cost.Dataplane holds the
	// iptables one; this map carries the rest.
	Dataplanes map[string]*engineapi.DataplaneWeight `json:"dataplanes,omitempty"`
}

// Example is one bundled scenario. Policies always replace the Monaco editor's
// text. The optional Probes / Resources / DNS / EvaluateStaged fields let an
// example demonstrate a feature that needs more than policy YAML to light up
// (an ICMP probe, a NetworkSet to select against, …): when present, the SPA
// merges them into the current request so the matrix reflects the feature. An
// example that leaves them empty behaves like before - topology untouched.
type Example struct {
	Name        string               `json:"name"`
	Description string               `json:"description"`
	Policies    []calico.PolicyInput `json:"policies"`

	Probes []Probe `json:"probes,omitempty"`
	Resources
	// ExternalEndpoints overrides the editor's default world/internet for this
	// example (e.g. a testcase whose external target sits inside a NetworkSet's
	// CIDR). Editor-only: the SPA expands these into unpoliced engine endpoints.
	ExternalEndpoints []ExternalEndpointInput `json:"externalEndpoints,omitempty"`
	DNS               map[string][]string     `json:"dns,omitempty"`
	EvaluateStaged    bool                    `json:"evaluateStaged,omitempty"`
}

// ExternalEndpointInput is an off-cluster destination (mirrors the web
// ExternalEndpointInput and harness meta.json external_endpoints). id is a
// free-form "<ns>/<name>" (e.g. "world/internet"); ip is matched by egress rules.
type ExternalEndpointInput struct {
	ID     string            `json:"id"`
	IP     string            `json:"ip"`
	Labels map[string]string `json:"labels,omitempty"`
}
