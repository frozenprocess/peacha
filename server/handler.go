package server

import (
	"fmt"
	"log"
	"net/http"
	"strconv"
	"strings"
	"sync"

	engineapi "github.com/frozenprocess/telepathy/api"
	"github.com/frozenprocess/telepathy/provider/calico"
)

// Handler bundles the per-process state the HTTP routes need: a serializing
// mutex around calico.Evaluate (Felix's calc graph uses package-level
// singletons and is not safe to call concurrently), an LRU response cache,
// the bundled-examples slice, and the embedded baseline topology served
// via GET /v1/topology.
type Handler struct {
	mu        sync.Mutex
	cache     *lruCache
	tutorials []Tutorial
	exams     []Exam
	baseline  Baseline
	cors      string
	auth      *Authenticator
	results   *Results
	links     *Links
	versions  Versions
	// examAutoAdvance, surfaced to the SPA via /v1/auth/config, tells the exam
	// pane whether to auto-advance to the next exam after a pass (admin-set).
	examAutoAdvance bool
}

// Config groups the knobs main() exposes as flags.
type Config struct {
	CacheSize            int        // entries in the LRU; <= 0 disables caching
	CORS                 string     // comma-separated origins, or "*"
	Auth                 AuthConfig // Slack OIDC credentials; empty ClientID disables login
	ResultsFile          string     // SQLite file path or postgres:// URL for pass store; empty disables persistence
	ResultsRetentionDays int        // delete pass/feedback records older than this many days; 0 = keep forever
	ShareFile            string     // SQLite file path or postgres:// URL for share-link store; empty disables short links
	ShareRetentionDays   int        // delete share short links older than this many days; 0 = keep forever
	ExamAutoAdvance      bool       // auto-advance the learner to the next exam after a pass
	ExamsDisabled        bool       // hard off-switch: serve no exams even if the embed tree has them
	Versions             Versions   // build-stamped component versions (served at /v1/version)
}

// Versions carries the build-stamped component versions surfaced at
// GET /v1/version and in the SPA's capabilities drawer. main() fills these from
// its -ldflags-injected vars (see the Makefile / deploy/Dockerfile).
type Versions struct {
	Editor string `json:"editor"`
	Engine string `json:"engine"`
	Calico string `json:"calico"`
}

// NewHandler parses the baseline topology (system pods from snapshots +
// workloads from topology.yaml). Baseline-parse errors are logged but
// non-fatal: the API stays usable with empty layers and the SPA copes.
func NewHandler(cfg Config) *Handler {
	bl, err := LoadBaseline()
	if err != nil {
		log.Printf("baseline: %v", err)
	}
	// ExamsDisabled empties the catalogue: examByName returns nil so every
	// grade/solution/asset route 404s, and the SPA hides the exams tab - the
	// same inert state as an empty embed tree. Kept non-nil so /v1/exams still
	// marshals as a JSON array.
	exams := builtinExams()
	if cfg.ExamsDisabled {
		exams = []Exam{}
	}
	return &Handler{
		cache:     newLRU(cfg.CacheSize),
		tutorials: builtinTutorials(),
		exams:     exams,
		baseline:  bl,
		cors:      cfg.CORS,
		auth:      newAuthenticator(cfg.Auth),
		results:   newResults(cfg.ResultsFile, cfg.ResultsRetentionDays),
		links:     newLinks(cfg.ShareFile, cfg.ShareRetentionDays), // own DB, decoupled from exam data
		versions:  cfg.Versions,

		examAutoAdvance: cfg.ExamAutoAdvance,
	}
}

// Routes returns an *http.ServeMux pre-wired with /v1/* and /healthz. The
// caller is expected to mount additional handlers for static assets at "/"
// (see static.go).
func (h *Handler) Routes() *http.ServeMux {
	mux := http.NewServeMux()
	mux.HandleFunc("/v1/evaluate", h.withCORS(requireMethod(http.MethodPost, h.evaluate)))
	mux.HandleFunc("/v1/bpf", h.withCORS(requireMethod(http.MethodPost, h.bpf)))
	mux.HandleFunc("/v1/iptables", h.withCORS(requireMethod(http.MethodPost, h.iptables)))
	mux.HandleFunc("/v1/hns", h.withCORS(requireMethod(http.MethodPost, h.hns)))
	mux.HandleFunc("/v1/tiers", h.withCORS(requireMethod(http.MethodPost, h.tiers)))
	mux.HandleFunc("/v1/tutorials", h.withCORS(requireMethod(http.MethodGet, h.listTutorials)))
	// Per-page feedback submission (read-along testimonies). More specific +
	// method-qualified than the "/v1/tutorials/" asset subtree below, so ServeMux
	// prefers it for this exact path - the same precedence the exam grade route
	// relies on over "/v1/exams/".
	mux.HandleFunc("/v1/tutorials/{name}/feedback", h.withCORS(requireMethod(http.MethodPost, h.submitFeedback)))
	// Subtree (trailing slash): /v1/tutorials/<dir>/<file> serves lesson assets.
	// Go's ServeMux prefers the exact "/v1/tutorials" for the JSON list.
	mux.HandleFunc("/v1/tutorials/", h.withCORS(requireMethod(http.MethodGet, h.tutorialAsset)))
	// Feedback has no HTTP read path by design: submissions are write-only over
	// the wire, and the stored testimonies are exported offline via the
	// --dump-feedback CLI (server.DumpFeedback). This keeps the feedback read
	// surface at the same trust boundary as the DB file itself - no token to leak,
	// no route to forge.
	// Mint a tiny share link for a relative URL (POST body { target }). Falls back
	// to the long self-contained #fragment link when the store is disabled.
	mux.HandleFunc("/v1/links", h.withCORS(requireMethod(http.MethodPost, h.createLink)))
	mux.HandleFunc("/v1/topology", h.withCORS(requireMethod(http.MethodGet, h.getTopology)))
	mux.HandleFunc("/v1/capabilities", h.withCORS(requireMethod(http.MethodGet, h.getCapabilities)))
	mux.HandleFunc("/v1/version", h.withCORS(requireMethod(http.MethodGet, h.getVersion)))
	// Exams: the JSON catalogue, the (most-specific) grade + results routes, and
	// the asset subtree. Go's ServeMux prefers the exact / method-qualified
	// patterns over the "/v1/exams/" subtree, so the grade POST and results GET
	// never fall through to the asset server.
	mux.HandleFunc("/v1/exams", h.withCORS(requireMethod(http.MethodGet, h.listExams)))
	mux.HandleFunc("/v1/exams/{name}/grade", h.withCORS(requireMethod(http.MethodPost, h.gradeExam)))
	// Dev-only reference solution (404s when login is configured). More specific
	// than the asset subtree, so it's preferred for this exact path.
	mux.HandleFunc("/v1/exams/{name}/solution", h.withCORS(requireMethod(http.MethodGet, h.examSolution)))
	mux.HandleFunc("/v1/exams/results/me", h.withCORS(requireMethod(http.MethodGet, h.resultsMe)))
	mux.HandleFunc("/v1/exams/", h.withCORS(requireMethod(http.MethodGet, h.examAsset)))
	// Slack OIDC auth (exam-only gate).
	mux.HandleFunc("/v1/auth/config", h.withCORS(h.authConfig))
	mux.HandleFunc("/v1/auth/me", h.withCORS(h.authMe))
	mux.HandleFunc("/v1/auth/login/{provider}", h.withCORS(h.authLogin))
	mux.HandleFunc("/v1/auth/callback/{provider}", h.withCORS(h.authCallback))
	mux.HandleFunc("/v1/auth/logout", h.withCORS(h.authLogout))
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok"))
	})
	return mux
}

func (h *Handler) withCORS(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if h.cors != "" {
			// "*" passes through verbatim; a comma list is reflected back if the
			// request's Origin is in it (browsers reject "*" with credentials,
			// but the editor doesn't send credentials so either works).
			origin := r.Header.Get("Origin")
			if h.cors == "*" {
				w.Header().Set("Access-Control-Allow-Origin", "*")
			} else if origin != "" {
				for _, o := range strings.Split(h.cors, ",") {
					if strings.TrimSpace(o) == origin {
						w.Header().Set("Access-Control-Allow-Origin", origin)
						w.Header().Set("Vary", "Origin")
						break
					}
				}
			}
			w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
			w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
		}
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next(w, r)
	}
}

func (h *Handler) evaluate(w http.ResponseWriter, r *http.Request) {
	var req EditorRequest
	if !decodeJSON(w, r, &req) {
		return
	}
	defaultProbe(&req) // empty Probes -> the default per-protocol set so callers can omit it

	key, _ := requestKey(&req)
	if key != "" {
		if hit, ok := h.cache.Get(key); ok {
			writeJSON(w, hit)
			return
		}
	}

	resp := h.run(&req)
	if key != "" {
		h.cache.Set(key, resp)
	}
	writeJSON(w, resp)
}

// run executes the engine once per probe, sharing the (Endpoints, Namespaces,
// Policies) inputs. Serialised by h.mu because calico.Evaluate is not
// goroutine-safe - see calico-engine/engine/eval.go.
func (h *Handler) run(req *EditorRequest) *EditorResponse {
	h.mu.Lock()
	defer h.mu.Unlock()

	resp := &EditorResponse{Matrices: map[string]map[string]string{}}
	seenErr := map[string]bool{}
	seenWarn := map[string]bool{}
	for _, p := range req.Probes {
		er := baseEngineRequest(req)
		// Per-probe knobs.
		er.Port = p.Port
		er.Protocol = p.Protocol
		er.SrcPort = p.SrcPort
		er.HTTPMethod = p.HTTPMethod
		er.HTTPPath = p.HTTPPath
		er.ICMPType = p.ICMPType
		er.ICMPCode = p.ICMPCode

		out := calico.Evaluate(er)
		resp.Matrices[p.Name] = out.Matrix
		// The typed actor directory is probe-independent (same endpoint set every
		// probe), so the first probe's is canonical; later probes would only
		// differ in Actor.Internet, which the SPA recomputes anyway.
		if resp.Actors == nil {
			resp.Actors = out.Actors
		}
		// Policy-parse errors and lint warnings are identical across probes
		// (same Policies slice); only surface each once.
		for _, e := range out.Errors {
			if !seenErr[e] {
				seenErr[e] = true
				resp.Errors = append(resp.Errors, e)
			}
		}
		for _, w := range out.Warnings {
			if !seenWarn[w] {
				seenWarn[w] = true
				resp.Warnings = append(resp.Warnings, w)
			}
		}
	}
	// Policy-efficiency cost, one weight per dataplane the view tabs can show.
	// Kept out of the probe loop above: the matrix eval must never render (a
	// felix renderer can panic on odd-but-valid policies, e.g. a port match with
	// no protocol crashes the nftables builder), so cost is a separate,
	// panic-isolated pass - a renderer bug drops that one dataplane's weight
	// instead of 500ing the whole request. Structural/hygiene/headline are
	// dataplane-independent (from iptables); the map keys are the values we ask
	// for, so the SPA maps view->key directly (bpf's response Kind is "ebpf").
	// ponytail: one Evaluate per dataplane, each rebuilds the calc graph. Fine at
	// tutorial scale; make it lazy per active view if topologies grow large.
	if len(req.Policies) > 0 {
		if base := h.costFor(req, "iptables"); base != nil {
			resp.Cost = base
			resp.Dataplanes = map[string]*engineapi.DataplaneWeight{}
			if base.Dataplane != nil {
				resp.Dataplanes["iptables"] = base.Dataplane
			}
			for _, dp := range []string{"nftables", "bpf", "hns"} {
				if c := h.costFor(req, dp); c != nil && c.Dataplane != nil {
					resp.Dataplanes[dp] = c.Dataplane
				}
			}
		}
	}
	return resp
}

// costFor computes the policy-efficiency cost for one dataplane. It recovers
// from renderer panics (felix's iptables/nftables/bpf/hns builders can panic on
// odd policies) so a single dataplane's bug degrades to a missing weight rather
// than a failed evaluate.
func (h *Handler) costFor(req *EditorRequest, dataplane string) (cr *engineapi.CostReport) {
	defer func() {
		if r := recover(); r != nil {
			log.Printf("cost: %s dataplane render panicked, skipping: %v", dataplane, r)
			cr = nil
		}
	}()
	er := baseEngineRequest(req)
	er.Cost = true
	er.CostDataplane = dataplane
	// Cost is probe-independent, but the renderers need a valid protocol (the
	// nftables builder panics without one), so carry the first probe's
	// port/protocol - defaultProbe guarantees at least the tcp:8080 one.
	if len(req.Probes) > 0 {
		er.Port = req.Probes[0].Port
		er.Protocol = req.Probes[0].Protocol
	}
	return calico.Evaluate(er).Cost
}

// baseEngineRequest maps the topology + policies + resources + flags shared by
// every backend (evaluate, iptables, bpf) into an calico.Request. Probe- and
// render-specific fields (Port/Protocol/ICMP/…) are layered on by the caller.
func baseEngineRequest(req *EditorRequest) calico.Request {
	return calico.Request{
		Endpoints:         req.Endpoints,
		Namespaces:        req.Namespaces,
		Policies:          withTiers(req.Tiers, req.Policies),
		ServiceAccounts:   req.ServiceAccounts,
		HostEndpoints:     req.HostEndpoints,
		NetworkSets:       req.NetworkSets,
		GlobalNetworkSets: req.GlobalNetworkSets,
		Services:          req.Services,
		EndpointSlices:    req.EndpointSlices,
		DNS:               req.DNS,
		EvaluateStaged:    req.EvaluateStaged,
		StrictLint:        req.StrictLint,
	}
}

// withTiers renders each user-defined Tier into a `kind: Tier` document and
// returns a new slice with those docs prepended to the policies, so the engine
// feeds tiers before any policy that references them (feedPolicy switches on
// the YAML's kind, so a Tier doc in the Policies list is processed by the Tier
// branch - see calico-engine/engine/feed.go). A fresh slice is built so the
// caller's req.Policies backing array is never mutated. Tiers with an empty
// name are skipped (nothing to reference).
func withTiers(tiers []TierInput, policies []calico.PolicyInput) []calico.PolicyInput {
	if len(tiers) == 0 {
		return policies
	}
	out := make([]calico.PolicyInput, 0, len(tiers)+len(policies))
	for _, t := range tiers {
		if strings.TrimSpace(t.Name) == "" {
			continue
		}
		out = append(out, calico.PolicyInput{Flavor: "calico", YAML: tierYAML(t)})
	}
	return append(out, policies...)
}

// tierYAML renders a TierInput as a Calico v3 Tier manifest. DefaultAction
// defaults to Deny (Calico's CRD default) when unset.
func tierYAML(t TierInput) string {
	action := t.DefaultAction
	if action == "" {
		action = "Deny"
	}
	order := strconv.FormatFloat(t.Order, 'f', -1, 64)
	return fmt.Sprintf(`apiVersion: projectcalico.org/v3
kind: Tier
metadata:
  name: %s
spec:
  order: %s
  defaultAction: %s
`, t.Name, order, action)
}

// bpf renders the eBPF policy programs Felix would JIT-assemble for the given
// topology + policies. Like evaluate it serialises on h.mu (calico.RenderBPF
// builds the same non-goroutine-safe calc graph) and shares the LRU cache.
func (h *Handler) bpf(w http.ResponseWriter, r *http.Request) {
	var req BPFRequest
	if !decodeJSON(w, r, &req) {
		return
	}
	// Not cached (unlike /v1/evaluate): the bpf view is opened on demand, not
	// re-rendered on every keystroke, so a per-request render is fine.
	writeJSON(w, h.runBPF(&req))
}

func (h *Handler) runBPF(req *BPFRequest) *calico.BPFResponse {
	h.mu.Lock()
	defer h.mu.Unlock()

	opts := calico.BPFOptions{Verbose: req.Verbose}
	if req.Endpoint != "" {
		opts.Endpoints = []string{req.Endpoint}
	}
	switch req.Direction {
	case "ingress", "egress":
		opts.Directions = []string{req.Direction}
	default: // "", "both"
		opts.Directions = []string{"ingress", "egress"}
	}
	switch req.IPVersion {
	case "4":
		opts.IPVersions = []int{4}
	case "6":
		opts.IPVersions = []int{6}
	case "both":
		opts.IPVersions = []int{4, 6}
	default: // "" -> inferred from endpoints
	}

	resp := calico.RenderBPF(baseEngineRequest(&req.EditorRequest), opts)
	return &resp
}

// iptables renders the iptables/nftables filter-table chains Felix would
// program for the topology + policies. Serialised on h.mu (shared calc graph),
// uncached - opened on demand like /v1/bpf.
func (h *Handler) iptables(w http.ResponseWriter, r *http.Request) {
	var req IptablesRequest
	if !decodeJSON(w, r, &req) {
		return
	}
	writeJSON(w, h.runIptables(&req))
}

func (h *Handler) runIptables(req *IptablesRequest) *calico.IptablesResponse {
	h.mu.Lock()
	defer h.mu.Unlock()

	opts := calico.IptablesOptions{IncludeStatic: req.IncludeStatic}
	if req.Endpoint != "" {
		opts.Endpoints = []string{req.Endpoint}
	}
	switch req.Backend {
	case "nftables":
		opts.Backends = []string{"nftables"}
	case "both":
		opts.Backends = []string{"iptables", "nftables"}
	default: // "", "iptables"
		opts.Backends = []string{"iptables"}
	}
	switch req.IPVersion {
	case "4":
		opts.IPVersions = []int{4}
	case "6":
		opts.IPVersions = []int{6}
	case "both":
		opts.IPVersions = []int{4, 6}
	default: // "" -> inferred from endpoints
	}

	resp := calico.RenderIptables(baseEngineRequest(&req.EditorRequest), opts)
	return &resp
}

// hns renders the Windows HNS (Host Networking Service) ACL policy lists Felix
// would install on a Windows node for the topology + policies. Like /v1/bpf
// it's per-endpoint × direction and opened on demand (uncached), serialised on
// h.mu (shared calc graph).
func (h *Handler) hns(w http.ResponseWriter, r *http.Request) {
	var req HNSRequest
	if !decodeJSON(w, r, &req) {
		return
	}
	writeJSON(w, h.runHNS(&req))
}

func (h *Handler) runHNS(req *HNSRequest) (resp *calico.HNSResponse) {
	h.mu.Lock()
	defer h.mu.Unlock()

	// The felix HNS renderer Panics on an unknown rule action (policysets.go:359)
	// - it assumes apiserver admission already validated the action, which the
	// editor doesn't. Recover so a bad action shows as a tab error, not a 500.
	defer func() {
		if r := recover(); r != nil {
			resp = &calico.HNSResponse{Errors: []string{fmt.Sprintf("HNS render failed: %v", r)}}
		}
	}()

	opts := calico.HNSOptions{}
	if req.Endpoint != "" {
		opts.Endpoints = []string{req.Endpoint}
	}
	switch req.Direction {
	case "ingress", "egress":
		opts.Directions = []string{req.Direction}
	default: // "", "both"
		opts.Directions = []string{"ingress", "egress"}
	}
	switch req.IPVersion {
	case "4":
		opts.IPVersions = []int{4}
	case "6":
		opts.IPVersions = []int{6}
	case "both":
		opts.IPVersions = []int{4, 6}
	default: // "" -> HNS defaults to IPv4
	}

	r := calico.RenderHNS(baseEngineRequest(&req.EditorRequest), opts)
	return &r
}

// tiers resolves, per endpoint, which tiers and policies select it - the
// authoritative mapping the editor's tier view uses to highlight a selected
// endpoint's policies + tiers. Serialised on h.mu (shared calc graph),
// uncached - opened on demand like /v1/bpf and /v1/iptables.
func (h *Handler) tiers(w http.ResponseWriter, r *http.Request) {
	var req EditorRequest
	if !decodeJSON(w, r, &req) {
		return
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	resp := calico.ResolveTierMatches(baseEngineRequest(&req))
	writeJSON(w, &resp)
}

// defaultProbes is the probe set applied when a request (or baseline/exam)
// declares none: one per protocol family so a fresh topology exercises TCP,
// UDP, ICMP and SCTP reachability out of the box. Callers must copy it before
// mutating (it's shared).
func defaultProbes() []Probe {
	return []Probe{
		{Name: "tcp", Port: 8080, Protocol: "tcp"},
		{Name: "udp", Port: 53, Protocol: "udp"},
		{Name: "icmp", Protocol: "icmp"},
		{Name: "sctp", Protocol: "sctp"},
	}
}

func defaultProbe(req *EditorRequest) {
	if len(req.Probes) > 0 {
		return
	}
	req.Probes = defaultProbes()
}

// listTutorials serves the ordered read-along learning track (GET /v1/tutorials).
func (h *Handler) listTutorials(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, h.tutorials)
}

// getTopology serves the embedded baseline for a provider: system pods (from
// that provider's cluster snapshots) + the seed workloads (from topology.yaml)
// + the default probe. The provider is chosen by ?provider=<name>; an empty or
// unknown value falls back to the default. The response carries the chosen
// provider and the full provider list so the SPA can render a switcher. The
// SPA fetches this on mount and renders the system layer as a fixed backdrop,
// with the workloads layer as the user-editable surface.
func (h *Handler) getTopology(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, h.baseline.Topology(r.URL.Query().Get("provider")))
}

// getCapabilities serves calico.Capabilities() - the engine's self-described
// feature/support list. The SPA fetches this once on mount to label which
// policy features are honoured (and surface the caveats in Notes) so users
// aren't misled by a green matrix for a feature the engine silently ignores.
func (h *Handler) getCapabilities(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, calico.Capabilities())
}

// getVersion serves the build-stamped component versions (editor, engine,
// Calico) that main() injected via -ldflags. The SPA shows them in the
// capabilities drawer so users can tell which engine / Calico build is backing
// the evaluation.
func (h *Handler) getVersion(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, h.versions)
}
