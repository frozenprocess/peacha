package server

import (
	"net/http"
	"regexp"
	"strings"

	"github.com/frozenprocess/telepathy/provider/calico"
)

// GradeRequest is the wire-shape posted to POST /v1/exams/{name}/grade. Only
// the learner's policies and tiers are trusted from the client; the topology is
// reconstructed server-side from the baseline + the exam's own scenario, so a
// submission can't be graded against a tampered endpoint set. Provider picks
// which baseline snapshot set to grade against (defaults to the server's
// default provider when empty/unknown), matching the SPA's selected provider so
// the live matrix the learner sees lines up with what's graded.
type GradeRequest struct {
	Provider string               `json:"provider,omitempty"`
	Policies []calico.PolicyInput `json:"policies"`
	Tiers    []TierInput          `json:"tiers,omitempty"`
}

// CheckResult is one line of the grade report: a flow that had to hold or a
// guardrail constraint, with whether it passed and a human-readable detail when
// it didn't.
type CheckResult struct {
	Kind        string `json:"kind"` // "flow" | "constraint"
	Description string `json:"description"`
	Passed      bool   `json:"passed"`
	Detail      string `json:"detail,omitempty"`
}

// GradeResult is the response: the overall verdict, the per-check breakdown, any
// engine/policy-parse errors (which fail grading outright), and whether a pass
// was persisted (only when auth is configured and the caller is signed in).
type GradeResult struct {
	Exam     string        `json:"exam"`
	Passed   bool          `json:"passed"`
	Checks   []CheckResult `json:"checks"`
	Errors   []string      `json:"errors,omitempty"`
	Recorded bool          `json:"recorded"`
}

// defaultExternalEndpoints mirrors the SPA's DEFAULT_EXTERNAL_ENDPOINTS (and
// harness.py): a single off-cluster "world/internet" destination on an RFC 5737
// documentation address that can't collide with a real pod/cluster IP. Used
// when an exam doesn't override its own external endpoints, so internet-egress
// exams grade the same way the editor renders them.
var defaultExternalEndpoints = []ExternalEndpointInput{
	{ID: "world/internet", IP: "203.0.113.1", Labels: map[string]string{"scope": "internet"}},
}

// gradeExam runs a learner's policy submission against an exam's answer key and
// returns the per-check verdict. Registered as POST /v1/exams/{name}/grade.
//
// When Slack auth is configured the route is gated: an unauthenticated caller
// gets 401, since a pass is meaningless without an identity to record it under.
// When auth is NOT configured (dev), grading runs anonymously and nothing is
// persisted (Recorded=false).
func (h *Handler) gradeExam(w http.ResponseWriter, r *http.Request) {
	name := r.PathValue("name")
	ex := h.examByName(name)
	if ex == nil {
		http.Error(w, "no such exam", http.StatusNotFound)
		return
	}

	// Auth gate (exam-only): when configured, a valid session is required.
	user, _ := h.auth.user(r)
	if h.auth.enabled() && user == nil {
		writeJSONStatus(w, http.StatusUnauthorized, map[string]string{"error": "login required"})
		return
	}

	var req GradeRequest
	if !decodeJSON(w, r, &req) {
		return
	}

	er := h.examEvalRequest(ex, req.Provider, req.Policies, req.Tiers)
	resp := h.run(er)

	result := GradeResult{Exam: ex.Name, Errors: resp.Errors}

	// A policy that doesn't parse can't pass - surface the engine errors and
	// short-circuit the flow/constraint checks (they'd be misleading against a
	// matrix built from a broken bundle).
	if len(resp.Errors) > 0 {
		result.Passed = false
		writeJSON(w, &result)
		return
	}

	allPassed := true
	// Flow checks: every expected matrix cell must match.
	defaultProbeName := ""
	if len(er.Probes) > 0 {
		defaultProbeName = er.Probes[0].Name
	}
	for _, f := range ex.Expect {
		probe := f.Probe
		if probe == "" {
			probe = defaultProbeName
		}
		c := CheckResult{
			Kind:        "flow",
			Description: flowDescription(probe, f),
		}
		m := resp.Matrices[probe]
		if m == nil {
			c.Passed = false
			c.Detail = "no such probe: " + probe
		} else if got, ok := m[f.Src+"->"+f.Dst]; !ok {
			c.Passed = false
			c.Detail = "no such flow in the topology (check endpoint names)"
		} else if got != f.Want {
			c.Passed = false
			c.Detail = "expected " + f.Want + ", got " + got
		} else {
			c.Passed = true
		}
		allPassed = allPassed && c.Passed
		result.Checks = append(result.Checks, c)
	}

	// Constraint checks: regexp guardrails on the concatenated submitted policy
	// YAML (the learner's documents only - not the baseline or scenario resources).
	policyText := concatPolicies(req.Policies)
	for _, con := range ex.Constraints {
		c := CheckResult{Kind: "constraint", Description: con.Description, Passed: true}
		if con.RequireMatch != "" {
			if re, err := regexp.Compile(con.RequireMatch); err != nil {
				c.Passed, c.Detail = false, "bad requireMatch pattern: "+err.Error()
			} else if !re.MatchString(policyText) {
				c.Passed, c.Detail = false, "required pattern not found"
			}
		}
		if c.Passed && con.ForbidMatch != "" {
			if re, err := regexp.Compile(con.ForbidMatch); err != nil {
				c.Passed, c.Detail = false, "bad forbidMatch pattern: "+err.Error()
			} else if re.MatchString(policyText) {
				c.Passed, c.Detail = false, "forbidden pattern present"
			}
		}
		allPassed = allPassed && c.Passed
		result.Checks = append(result.Checks, c)
	}

	result.Passed = allPassed && len(ex.Expect)+len(ex.Constraints) > 0

	// Persist the pass under the signed-in identity. We store only the opaque
	// `sub` (no name/email) - GDPR data-minimisation; a sub is resolved to a
	// person out of band via org/workspace admin access at badge time. Dev (auth
	// off) records nothing - there's no identity to attribute it to.
	if result.Passed && user != nil {
		if err := h.results.record(PassRecord{
			Sub:       user.Sub,
			Provider:  user.Provider,
			Exam:      ex.Name,
			ExamTitle: ex.Title,
		}); err == nil {
			result.Recorded = true
		}
	}

	writeJSON(w, &result)
}

// examEvalRequest reconstructs the canonical evaluation request for an exam:
// the baseline system + workloads layers (merged exactly as the SPA's `merged`
// memo does - endpoints by ID, namespaces by name, unioned resources + DNS),
// plus the exam's own scenario resources and external endpoints, plus the
// learner's submitted policies/tiers, evaluated over the exam's fixed probes.
// Because topology comes from the server (not the request body), grading is
// authoritative and identical for a given policy regardless of what the learner
// did to the editor's topology pane.
func (h *Handler) examEvalRequest(ex *Exam, provider string, policies []calico.PolicyInput, tiers []TierInput) *EditorRequest {
	topo := h.baseline.Topology(provider)

	// Merge namespaces (by name) and endpoints (by ID): workloads override
	// system on a collision, mirroring the SPA's map-insert order.
	nsByName := map[string]calico.NamespaceInput{}
	var nsOrder []string
	addNS := func(list []calico.NamespaceInput) {
		for _, n := range list {
			if _, seen := nsByName[n.Name]; !seen {
				nsOrder = append(nsOrder, n.Name)
			}
			nsByName[n.Name] = n
		}
	}
	addNS(topo.System.Namespaces)
	addNS(topo.Workloads.Namespaces)

	epByID := map[string]calico.Endpoint{}
	var epOrder []string
	addEP := func(list []calico.Endpoint) {
		for _, e := range list {
			if _, seen := epByID[e.ID]; !seen {
				epOrder = append(epOrder, e.ID)
			}
			epByID[e.ID] = e
		}
	}
	addEP(topo.System.Endpoints)
	addEP(topo.Workloads.Endpoints)

	// External (off-cluster) endpoints expand into unpoliced engine endpoints -
	// same as the SPA. The exam may override the default world/internet.
	exts := ex.ExternalEndpoints
	if len(exts) == 0 {
		exts = defaultExternalEndpoints
	}
	for _, x := range exts {
		ns, name := "world", x.ID
		if i := strings.Index(x.ID, "/"); i >= 0 {
			ns, name = x.ID[:i], x.ID[i+1:]
		}
		if ns == "" {
			ns = "world"
		}
		if _, seen := epByID[x.ID]; !seen {
			epOrder = append(epOrder, x.ID)
		}
		epByID[x.ID] = calico.Endpoint{
			ID:        x.ID,
			Namespace: ns,
			Name:      name,
			IP:        x.IP,
			Labels:    x.Labels,
			Unpoliced: true,
			Role:      "external",
		}
	}

	req := &EditorRequest{
		Policies: policies,
		Tiers:    tiers,
		Probes:   ex.Probes,
		DNS:      topo.DNS,
	}
	if len(req.Probes) == 0 {
		req.Probes = defaultProbes()
	}
	for _, name := range nsOrder {
		req.Namespaces = append(req.Namespaces, nsByName[name])
	}
	for _, id := range epOrder {
		req.Endpoints = append(req.Endpoints, epByID[id])
	}

	// Union the layer resources, then layer the exam's scenario resources on top.
	res := mergeResources(pickLayerResources(topo.System), pickLayerResources(topo.Workloads))
	res = mergeResources(res, Resources{
		GlobalNetworkSets: ex.GlobalNetworkSets,
		NetworkSets:       ex.NetworkSets,
		HostEndpoints:     ex.HostEndpoints,
		Services:          ex.Services,
		ServiceAccounts:   ex.ServiceAccounts,
		EndpointSlices:    ex.EndpointSlices,
	})
	applyResources(req, res)
	return req
}

// pickLayerResources lifts a Layer's embedded Resources out as a value so it can
// be merged independent of the rest of the layer.
func pickLayerResources(l Layer) Resources { return l.Resources }

// applyResources copies a merged Resources bundle onto an EditorRequest's
// like-named fields.
func applyResources(req *EditorRequest, res Resources) {
	req.ServiceAccounts = res.ServiceAccounts
	req.HostEndpoints = res.HostEndpoints
	req.NetworkSets = res.NetworkSets
	req.GlobalNetworkSets = res.GlobalNetworkSets
	req.Services = res.Services
	req.EndpointSlices = res.EndpointSlices
}

func flowDescription(probe string, f ExpectFlow) string {
	verb := "must reach"
	if f.Want == "deny" {
		verb = "must NOT reach"
	}
	return f.Src + " " + verb + " " + f.Dst + " (" + probe + ")"
}

// concatPolicies joins the submitted policy documents into one blob for regexp
// constraint matching, separated by the standard YAML document marker.
func concatPolicies(policies []calico.PolicyInput) string {
	parts := make([]string, 0, len(policies))
	for _, p := range policies {
		parts = append(parts, p.YAML)
	}
	return strings.Join(parts, "\n---\n")
}
