package server

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"regexp"
	"strings"
	"testing"

	"github.com/frozenprocess/telepathy/provider/calico"
)

var (
	docSep         = regexp.MustCompile(`(?m)^---\s*$`)
	apiVersionLine = regexp.MustCompile(`(?m)^apiVersion:\s*(\S+)`)
)

// splitSolutionPolicies mirrors the SPA's splitPolicies (App.tsx): each YAML
// document in the editor becomes one PolicyInput verbatim - resource kinds
// (HostEndpoint, NetworkSet, …) included, not routed out - with the flavor
// derived from apiVersion. Grading must see exactly what a learner would submit,
// including those resource docs (an exam constraint can require `kind:
// HostEndpoint` in the submitted text).
func splitSolutionPolicies(text string) []calico.PolicyInput {
	var out []calico.PolicyInput
	for _, raw := range docSep.Split(text, -1) {
		y := strings.TrimSpace(raw)
		if y == "" {
			continue
		}
		flavor := "calico"
		if m := apiVersionLine.FindStringSubmatch(y); m != nil && strings.HasPrefix(m[1], "networking.k8s.io") {
			flavor = "k8s"
		}
		out = append(out, calico.PolicyInput{YAML: y, Flavor: flavor})
	}
	return out
}

// TestExamSolutionsPass is the guardrail on the extracted solution.yaml files:
// every bundled exam must ship a solution, and grading that solution against the
// exam's own answer key must pass. This catches an exam whose solution drifts
// from its expect/constraints (edit one without the other and this goes red),
// and proves each reference answer in exams/<dir>/solution.yaml is actually
// correct. It drives the real grade handler, so it exercises the same path the
// dev "Show solution" button + Check-my-answer flow use.
func TestExamSolutionsPass(t *testing.T) {
	// Empty Config => auth disabled (dev) and no results store, so grading runs
	// anonymously and the login gate is off - exactly the dev path.
	h := NewHandler(Config{})
	if len(h.exams) == 0 {
		if os.Getenv("REQUIRE_EXAMS") == "true" {
			t.Fatal("private exam validation requested but no exams loaded - run make exams-sync")
		}
		t.Skip("optional private exams absent - run make exams-sync to validate them")
	}

	for _, ex := range h.exams {
		t.Run(ex.Name, func(t *testing.T) {
			if ex.Solution == "" {
				t.Fatalf("exam %q has no solution.yaml", ex.Name)
			}
			// Split the solution exactly as the SPA would submit it.
			policies := splitSolutionPolicies(ex.Solution)
			if len(policies) == 0 {
				t.Fatalf("exam %q solution parsed to zero policies", ex.Name)
			}

			body, _ := json.Marshal(GradeRequest{Policies: policies})
			req := httptest.NewRequest(http.MethodPost, "/v1/exams/"+ex.Name+"/grade", bytes.NewReader(body))
			req.SetPathValue("name", ex.Name)
			w := httptest.NewRecorder()
			h.gradeExam(w, req)

			if w.Code != http.StatusOK {
				t.Fatalf("grade returned %d: %s", w.Code, w.Body.String())
			}
			var res GradeResult
			if err := json.Unmarshal(w.Body.Bytes(), &res); err != nil {
				t.Fatalf("decode grade result: %v", err)
			}
			if !res.Passed {
				for _, c := range res.Checks {
					if !c.Passed {
						t.Errorf("failed check: %s - %s", c.Description, c.Detail)
					}
				}
				for _, e := range res.Errors {
					t.Errorf("engine error: %s", e)
				}
				t.Fatalf("exam %q solution did not pass", ex.Name)
			}
		})
	}
}
