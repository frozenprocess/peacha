package server

import (
	"embed"
	"encoding/json"
	"io/fs"
	"net/http"
	"sort"
	"strings"

	"sigs.k8s.io/yaml"

	"github.com/frozenprocess/telepathy/provider/calico"
)

// tutorialsFS holds a copy of the repo-root tutorials/ tree. Embed can't reach
// outside the package, so the editor Makefile (`make tutorials-sync`) copies it
// into ./tutorials/ before `go build`; a .placeholder keeps the embed valid when
// the copy hasn't run (then no tutorials load).
//
//go:embed tutorials
var tutorialsFS embed.FS

// Tutorial is a read-along lesson: an Example (the loadable scenario - policies,
// resources, external endpoints) plus the prose and ordering metadata the
// learning track needs. The embedded Example flattens into the same JSON shape
// the SPA's loadExample consumes, so selecting a tutorial loads its scenario
// like any other policy bundle.
type Tutorial struct {
	Example
	Title   string `json:"title"`
	Track   string `json:"track,omitempty"`
	Order   int    `json:"order"`
	Summary string `json:"summary,omitempty"`
	// Dir is the tutorial's embed folder name (e.g. "00-getting-started"). The
	// SPA uses it to build asset URLs - GET /v1/tutorials/<dir>/<file> - for
	// images a lesson references relative to itself. It can differ from Name
	// (the meta.json slug), so it's exposed separately.
	Dir string `json:"dir"`
	// Doc is the rendered-on-the-client markdown lesson body (tutorial.md).
	Doc string `json:"doc"`
	// Feedback opts this page into the read-along feedback widget (meta.json
	// "feedback": true). Only opted-in pages render the widget and accept a
	// POST /v1/tutorials/<name>/feedback - used to gather GA-graduation
	// testimonies on the ClusterNetworkPolicy track. See feedback.go.
	Feedback bool `json:"feedback,omitempty"`
	// Playground marks the page as the free-form sandbox doc (meta.json
	// "playground": true) rather than a track lesson. The SPA pulls it out of the
	// tutorials list and renders it under the standalone Playground tab (served at
	// "/"), where the editor is freely editable and state mirrors into the share
	// fragment. Exactly one tutorial should set this.
	Playground bool `json:"playground,omitempty"`
}

// scenarioMeta is the subset of a tutorial's meta.json that describes its
// loadable scenario. The resource lists reuse the engine input types (the JSON
// shapes match), and external_endpoints overrides the editor's default
// world/internet.
type scenarioMeta struct {
	Name              string                         `json:"name"`
	Flavor            string                         `json:"flavor"`
	GlobalNetworkSets []calico.GlobalNetworkSetInput `json:"global_network_sets"`
	Services          []calico.ServiceInput          `json:"services"`
	ExternalEndpoints []ExternalEndpointInput        `json:"external_endpoints"`
}

// tutorialMeta extends the scenario meta with the lesson fields.
type tutorialMeta struct {
	scenarioMeta
	Title      string `json:"title"`
	Track      string `json:"track"`
	Order      int    `json:"order"`
	Summary    string `json:"summary"`
	Feedback   bool   `json:"feedback"`
	Playground bool   `json:"playground"`
}

// builtinTutorials loads every tutorials/<slug>/ folder (meta.json + optional
// policy.yaml + tutorial.md) into an ordered learning track, sorted by
// meta.order. Folders are read in a fixed order so the result is deterministic
// across builds.
func builtinTutorials() []Tutorial {
	entries, err := fs.ReadDir(tutorialsFS, "tutorials")
	if err != nil {
		return nil
	}
	var out []Tutorial
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		if t, ok := loadTutorial(e.Name()); ok {
			out = append(out, t)
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

func loadTutorial(dirName string) (Tutorial, bool) {
	dir := "tutorials/" + dirName
	metaB, err := tutorialsFS.ReadFile(dir + "/meta.json")
	if err != nil {
		return Tutorial{}, false
	}
	var meta tutorialMeta
	if json.Unmarshal(metaB, &meta) != nil {
		return Tutorial{}, false
	}
	// Tutorials are Calico-only.
	if meta.Flavor != "calico" {
		return Tutorial{}, false
	}

	ex := Example{
		Name:              meta.Name,
		Description:       meta.Summary,
		ExternalEndpoints: meta.ExternalEndpoints,
	}
	ex.GlobalNetworkSets = meta.GlobalNetworkSets
	ex.Services = meta.Services

	// policy.yaml is optional - a read-only lesson (e.g. the intro tour) has none.
	polB, _ := tutorialsFS.ReadFile(dir + "/policy.yaml")
	loadPolicyBundle(&ex, string(polB))

	docB, _ := tutorialsFS.ReadFile(dir + "/tutorial.md")

	return Tutorial{
		Example:    ex,
		Title:      meta.Title,
		Track:      meta.Track,
		Order:      meta.Order,
		Summary:    meta.Summary,
		Feedback:   meta.Feedback,
		Playground: meta.Playground,
		Dir:        dirName,
		Doc:        string(docB),
	}, true
}

// tutorialByName returns a pointer to the loaded tutorial with the given slug,
// or nil. Mirrors examByName.
func (h *Handler) tutorialByName(name string) *Tutorial {
	for i := range h.tutorials {
		if h.tutorials[i].Name == name {
			return &h.tutorials[i]
		}
	}
	return nil
}

// loadPolicyBundle splits a multi-doc policy.yaml and routes each document into
// the right field of ex: policy kinds to the editor's Policies bundle, resource
// kinds (HostEndpoint / NetworkSet / GlobalNetworkSet) to the engine's resource
// inputs - the same split the engine applies to the policy stream.
func loadPolicyBundle(ex *Example, polYAML string) {
	for _, doc := range splitYAMLDocs(polYAML) {
		var d kubeDoc
		if yaml.Unmarshal([]byte(doc), &d) != nil || d.Kind == "" {
			continue
		}
		switch d.Kind {
		case "HostEndpoint":
			ex.HostEndpoints = append(ex.HostEndpoints, calico.HostEndpointInput{
				ID:            "host/" + d.Metadata.Name,
				Name:          d.Metadata.Name,
				Node:          d.Spec.Node,
				InterfaceName: d.Spec.InterfaceName,
				ExpectedIPs:   d.Spec.ExpectedIPs,
				Labels:        d.Metadata.Labels,
			})
		case "NetworkSet":
			ex.NetworkSets = append(ex.NetworkSets, calico.NetworkSetInput{
				Name:      d.Metadata.Name,
				Namespace: d.Metadata.Namespace,
				Nets:      d.Spec.Nets,
				Labels:    d.Metadata.Labels,
			})
		case "GlobalNetworkSet":
			ex.GlobalNetworkSets = append(ex.GlobalNetworkSets, calico.GlobalNetworkSetInput{
				Name:   d.Metadata.Name,
				Nets:   d.Spec.Nets,
				Labels: d.Metadata.Labels,
			})
		default:
			// NetworkPolicy / GlobalNetworkPolicy / ClusterNetworkPolicy / Tier /
			// Staged*. Flavor only disambiguates kind:NetworkPolicy (k8s vs
			// calico); the SPA re-derives it from apiVersion anyway, matching
			// App.tsx splitPolicies.
			flavor := "calico"
			if strings.HasPrefix(d.APIVersion, "networking.k8s.io") {
				flavor = "k8s"
			}
			ex.Policies = append(ex.Policies, calico.PolicyInput{Flavor: flavor, YAML: doc})
		}
	}
}

// tutorialAsset serves a file from a tutorial's embed folder
// (GET /v1/tutorials/<dir>/<file>), e.g. an image a lesson references. The path
// is cleaned and re-rooted under tutorials/ so it can't escape the embed tree.
func (h *Handler) tutorialAsset(w http.ResponseWriter, r *http.Request) {
	serveEmbeddedAsset(w, r, tutorialsFS, "/v1/tutorials/", "tutorials/")
}
