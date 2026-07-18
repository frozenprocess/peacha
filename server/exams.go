package server

import (
	"embed"
	"encoding/json"
	"io/fs"
	"net/http"
	"sort"
)

// examsFS holds a copy of the repo-root exams/ tree. Like tutorialsFS, embed
// can't reach outside the package, so the Makefile (`make exams-sync`) mirrors
// it into ./exams/ before `go build`; a .placeholder keeps the embed valid when
// the copy hasn't run (then no exams load).
//
//go:embed exams
var examsFS embed.FS

// Exam is a graded challenge: an Example (the loadable scenario - starter
// policy, resources, external endpoints) plus the prompt prose and the
// server-side answer key the grader checks a submission against. The embedded
// Example flattens into the same JSON shape the SPA's loadExample consumes, so
// selecting an exam loads its starter scenario like a tutorial does.
//
// Expect and Constraints are the answer key: they're tagged `json:"-"` so they
// never reach the client (the SPA must not be able to read off the expected
// connectivity or the guardrail patterns). Grading happens server-side in
// grade.go against the exam looked up by name.
type Exam struct {
	Example
	Title   string `json:"title"`
	Track   string `json:"track,omitempty"`
	Order   int    `json:"order"`
	Summary string `json:"summary,omitempty"`
	// Dir is the exam's embed folder name (e.g. "01-default-deny"); the SPA uses
	// it to build asset URLs - GET /v1/exams/<dir>/<file> - for images the
	// prompt references relative to itself. May differ from Name (the slug).
	Dir string `json:"dir"`
	// Doc is the client-rendered markdown prompt (prompt.md).
	Doc string `json:"doc"`

	// --- Answer key (server-side only) ---
	Expect      []ExpectFlow `json:"-"`
	Constraints []Constraint `json:"-"`
	// Solution is the reference policy bundle (solution.yaml) that passes the
	// exam. Like the answer key it's tagged json:"-" so it never ships in the
	// catalogue; it's served only in dev (auth disabled) via examSolution, so a
	// learner on a real, login-gated deployment can't read it off.
	Solution string `json:"-"`
}

// ExpectFlow is one required cell of the connectivity matrix: under probe
// Probe, traffic from Src to Dst (endpoint IDs, e.g. "prod/frontend") must
// resolve to Want ("allow" | "deny"). An empty Probe defaults to the exam's
// first probe at grade time. A submission passes the flow checks only when
// every ExpectFlow matches the engine-produced matrix exactly.
type ExpectFlow struct {
	Probe string `json:"probe,omitempty"`
	Src   string `json:"src"`
	Dst   string `json:"dst"`
	Want  string `json:"want"` // allow | deny
}

// Constraint is a guardrail on the submitted policy YAML so a learner can't
// satisfy the matrix the wrong way (e.g. an allow-all rule). RequireMatch is a
// regexp that MUST match the concatenated submitted policy documents;
// ForbidMatch is a regexp that must NOT. Either may be empty. Description is the
// human-readable rule shown in the grade results.
type Constraint struct {
	Description  string `json:"description"`
	RequireMatch string `json:"requireMatch,omitempty"`
	ForbidMatch  string `json:"forbidMatch,omitempty"`
}

// examMeta extends the scenario meta with the prompt/ordering fields plus the
// grading spec (probes + expect + constraints). It's the full shape of an
// exam's meta.json.
type examMeta struct {
	scenarioMeta
	Title       string       `json:"title"`
	Track       string       `json:"track"`
	Order       int          `json:"order"`
	Summary     string       `json:"summary"`
	Probes      []Probe      `json:"probes"`
	Expect      []ExpectFlow `json:"expect"`
	Constraints []Constraint `json:"constraints"`
}

// builtinExams loads every exams/<slug>/ folder (meta.json + optional
// starter.yaml + prompt.md) into an ordered list, sorted by meta.order then
// title, deterministically across builds - same loader shape as builtinTutorials.
func builtinExams() []Exam {
	entries, err := fs.ReadDir(examsFS, "exams")
	if err != nil {
		return []Exam{}
	}
	out := []Exam{} // non-nil so the /v1/exams list always marshals as a JSON array
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		if ex, ok := loadExam(e.Name()); ok {
			out = append(out, ex)
		}
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Order != out[j].Order {
			return out[i].Order < out[j].Order
		}
		return out[i].Title < out[j].Title
	})
	return out
}

func loadExam(dirName string) (Exam, bool) {
	dir := "exams/" + dirName
	metaB, err := examsFS.ReadFile(dir + "/meta.json")
	if err != nil {
		return Exam{}, false
	}
	var meta examMeta
	if json.Unmarshal(metaB, &meta) != nil {
		return Exam{}, false
	}
	// Exams are Calico-only, like tutorials.
	if meta.Flavor != "calico" {
		return Exam{}, false
	}

	ex := Example{
		Name:              meta.Name,
		Description:       meta.Summary,
		ExternalEndpoints: meta.ExternalEndpoints,
		Probes:            meta.Probes,
	}
	ex.GlobalNetworkSets = meta.GlobalNetworkSets
	ex.Services = meta.Services

	// starter.yaml is optional - an exam can start from a blank editor.
	starterB, _ := examsFS.ReadFile(dir + "/starter.yaml")
	loadPolicyBundle(&ex, string(starterB))

	docB, _ := examsFS.ReadFile(dir + "/prompt.md")
	// solution.yaml is optional - the reference policy that passes the exam. It's
	// kept out of the prompt (so it doesn't leak to learners) and served only in
	// dev via examSolution.
	solB, _ := examsFS.ReadFile(dir + "/solution.yaml")

	return Exam{
		Example:     ex,
		Title:       meta.Title,
		Track:       meta.Track,
		Order:       meta.Order,
		Summary:     meta.Summary,
		Dir:         dirName,
		Doc:         string(docB),
		Expect:      meta.Expect,
		Constraints: meta.Constraints,
		Solution:    string(solB),
	}, true
}

// examByName returns a pointer to the loaded exam with the given slug, or nil.
func (h *Handler) examByName(name string) *Exam {
	for i := range h.exams {
		if h.exams[i].Name == name {
			return &h.exams[i]
		}
	}
	return nil
}

// listExams serves the ordered exam catalogue (GET /v1/exams). The answer key
// (Expect/Constraints) is stripped by the json:"-" tags, so the client only
// sees the prompt + loadable starter scenario.
func (h *Handler) listExams(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, h.exams)
}

// examAsset serves a file from an exam's embed folder
// (GET /v1/exams/<dir>/<file>), e.g. an image the prompt references. Mirrors
// tutorialAsset: the path is cleaned and re-rooted under exams/ so it can't
// escape the embed tree. (The grade route is registered separately as the more
// specific POST /v1/exams/{name}/grade, so it never reaches this handler.)
func (h *Handler) examAsset(w http.ResponseWriter, r *http.Request) {
	serveEmbeddedAsset(w, r, examsFS, "/v1/exams/", "exams/")
}

// examSolution serves an exam's reference solution YAML
// (GET /v1/exams/{name}/solution) - but ONLY in dev, i.e. when no login backend
// is configured. On a real, login-gated deployment auth is enabled and this
// route 404s, so a learner can never read the answer off the wire. Registered as
// the more-specific GET /v1/exams/{name}/solution, so it never reaches examAsset.
func (h *Handler) examSolution(w http.ResponseWriter, r *http.Request) {
	// Dev only: when login is configured, pretend the route doesn't exist.
	if h.auth.enabled() {
		http.NotFound(w, r)
		return
	}
	ex := h.examByName(r.PathValue("name"))
	if ex == nil || ex.Solution == "" {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Content-Type", "text/yaml; charset=utf-8")
	_, _ = w.Write([]byte(ex.Solution))
}
