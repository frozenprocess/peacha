package server

import (
	"embed"
	"encoding/json"
	"fmt"
	"io/fs"
	"sort"
	"strings"

	"sigs.k8s.io/yaml"

	"github.com/frozenprocess/telepathy/provider/calico"
)

// baselineFS holds the committed provider snapshots in ./baseline/ -
// <provider>_<plugin>-snapshot.json (one or more per provider, e.g. kind_k8s-,
// kind_calico-, gke_calico-…) plus topology.yaml. These files are committed
// directly in the package tree (embed paths can't reach outside it). A
// .placeholder lives in the dir so the embed succeeds even if the snapshots
// are ever removed.
//
//go:embed baseline
var baselineFS embed.FS

// Layer is one slice of a Topology: a set of namespaces, the endpoints that
// live in them, and any Calico resources (host endpoints, network sets,
// service accounts, services) scoped to that slice. Two layers - system
// (always-on, from cluster snapshots) and workloads (user-editable, seeded
// from baseline/topology.yaml). Resources is embedded so each layer carries
// its full evaluable shape; the SPA merges both layers before evaluating.
type Layer struct {
	Namespaces []calico.NamespaceInput `json:"namespaces"`
	Endpoints  []calico.Endpoint       `json:"endpoints"`
	// Nodes lists the cluster's Kubernetes nodes, so the SPA's node-grouped
	// graph view can draw a box per node - including nodes that host no
	// sampled endpoint (e.g. a control-plane running only host-network pods).
	// Display only; never fed to the calico.
	Nodes []NodeInfo `json:"nodes,omitempty"`
	Resources
}

// NodeInfo is one Kubernetes node as captured by snapshot-cni.py's nodes[]
// block. Name is the only field the graph needs to box a node; ip / labels
// ride along for tooltips and future use.
type NodeInfo struct {
	Name          string            `json:"name"`
	IP            string            `json:"ip,omitempty"`
	InterfaceName string            `json:"interfaceName,omitempty"`
	Labels        map[string]string `json:"labels,omitempty"`
}

// Resources groups the optional engine input lists a layer (or snapshot) can
// carry beyond namespaces + endpoints. Mirrors the like-named calico.Request
// fields; all optional so a snapshot that omits them behaves as before.
type Resources struct {
	ServiceAccounts   []calico.ServiceAccountInput   `json:"serviceAccounts,omitempty"`
	HostEndpoints     []calico.HostEndpointInput     `json:"hostEndpoints,omitempty"`
	NetworkSets       []calico.NetworkSetInput       `json:"networkSets,omitempty"`
	GlobalNetworkSets []calico.GlobalNetworkSetInput `json:"globalNetworkSets,omitempty"`
	Services          []calico.ServiceInput          `json:"services,omitempty"`
	EndpointSlices    []calico.EndpointSliceInput    `json:"endpointSlices,omitempty"`
}

// Topology is what GET /v1/topology returns. The SPA uses System as a fixed
// baseline (rendered but not editable) and Workloads as the initial value
// of the topology pane. Both layers are merged before evaluation so policies
// see the union. DNS is a global stub resolver seeded from the snapshots.
//
// Provider names which cluster snapshot set this topology was built from
// (e.g. "kind", "gke"); Providers lists every provider the server discovered,
// so the SPA can render a switcher. Both are populated at serve time from the
// Baseline - they're response metadata, not part of the embedded data.
type Topology struct {
	System    Layer               `json:"system"`
	Workloads Layer               `json:"workloads"`
	Probes    []Probe             `json:"probes"`
	DNS       map[string][]string `json:"dns,omitempty"`
	Provider  string              `json:"provider,omitempty"`
	Providers []string            `json:"providers,omitempty"`
}

// Baseline is the full set of per-provider topologies discovered from the
// embedded snapshots. The workloads layer (from topology.yaml) is provider-
// independent and shared across every entry. Topologies is keyed by provider
// name; Providers is the same names sorted for stable display; Default is the
// provider served when the request names none (or an unknown one).
type Baseline struct {
	Topologies map[string]Topology
	Providers  []string
	Default    string
}

// Topology returns the topology for the named provider (falling back to the
// default when name is empty or unknown), with Provider/Providers metadata
// filled in so the SPA can render the switcher and remember the selection.
func (b Baseline) Topology(name string) Topology {
	t, ok := b.Topologies[name]
	if !ok {
		t = b.Topologies[b.Default]
		name = b.Default
	}
	t.Provider = name
	t.Providers = b.Providers
	return t
}

// snapshotFile mirrors the JSON snapshot-cni.py emits - see
// baseline/*_{calico,k8s}-snapshot.json. We unmarshal directly into
// it and convert to calico.Endpoint, normalising the `app`/`pod` distinction
// down to a single `name` field. Endpoints may carry named ports, a service
// account, and a node; the file may also carry the optional Resources lists
// and a DNS map, all of which pass straight through when present.
type snapshotFile struct {
	Namespaces []calico.NamespaceInput `json:"namespaces"`
	Endpoints  []struct {
		ID                 string                `json:"id"`
		Namespace          string                `json:"namespace"`
		App                string                `json:"app"`
		Pod                string                `json:"pod"`
		IP                 string                `json:"ip"`
		Labels             map[string]string     `json:"labels"`
		Ports              []calico.EndpointPort `json:"ports"`
		ServiceAccountName string                `json:"serviceAccountName"`
		Node               string                `json:"node"`
	} `json:"endpoints"`
	Nodes []NodeInfo `json:"nodes"`
	Resources
	DNS map[string][]string `json:"dns,omitempty"`
}

// kubeDoc is a partial schema for the Namespace + Deployment kinds we read
// out of baseline/topology.yaml. Just the fields we need; sigs.k8s.io/yaml
// ignores the rest.
type kubeDoc struct {
	APIVersion string `json:"apiVersion"`
	Kind       string `json:"kind"`
	Metadata   struct {
		Name      string            `json:"name"`
		Namespace string            `json:"namespace"`
		Labels    map[string]string `json:"labels"`
	} `json:"metadata"`
	Spec struct {
		Template struct {
			Metadata struct {
				Labels map[string]string `json:"labels"`
			} `json:"metadata"`
			// nodeName places the pod on a node, mirrored into Endpoint.Node so
			// the node-grouped graph view can box it. Optional.
			Spec struct {
				NodeName string `json:"nodeName"`
			} `json:"spec"`
		} `json:"template"`
		// Calico HostEndpoint / NetworkSet / GlobalNetworkSet fields. Only
		// the ones we project into the engine input types; the rest are
		// ignored by sigs.k8s.io/yaml.
		Node          string   `json:"node"`
		InterfaceName string   `json:"interfaceName"`
		ExpectedIPs   []string `json:"expectedIPs"`
		Nets          []string `json:"nets"`
	} `json:"spec"`
}

// LoadBaseline parses the embedded files once. Called from NewHandler at
// server startup; the result is cached for the process lifetime. Snapshots are
// grouped into one topology per provider (the filename prefix); the workloads
// layer from topology.yaml is provider-independent and shared. Missing baseline
// files are non-fatal - the editor still works, just without the system layer
// pre-populated (a synthetic "default" provider is offered in that case).
func LoadBaseline() (Baseline, error) {
	workloads, wlErr := loadWorkloadsLayer()
	probes := defaultProbes()

	bl := Baseline{Topologies: map[string]Topology{}}
	var firstErr error
	for provider, files := range discoverSnapshots() {
		system, dns, err := loadSystemLayerFiles(files)
		if err != nil && firstErr == nil {
			firstErr = fmt.Errorf("system layer (%s): %w", provider, err)
		}
		bl.Topologies[provider] = Topology{
			System:    system,
			Workloads: workloads,
			Probes:    probes,
			DNS:       dns,
		}
	}
	// Always offer at least one provider so the editor works even with no
	// snapshots embedded (the .placeholder-only case): empty system + workloads.
	if len(bl.Topologies) == 0 {
		bl.Topologies["default"] = Topology{Workloads: workloads, Probes: probes}
	}
	for p := range bl.Topologies {
		bl.Providers = append(bl.Providers, p)
	}
	sort.Strings(bl.Providers)
	bl.Default = bl.Providers[0]
	for _, p := range bl.Providers {
		if p == "kind" { // prefer the bundled reference cluster when present
			bl.Default = "kind"
			break
		}
	}
	if wlErr != nil && firstErr == nil {
		firstErr = fmt.Errorf("workloads layer: %w", wlErr)
	}
	return bl, firstErr
}

// discoverSnapshots lists the embedded *-snapshot.json files and groups them by
// provider - the filename prefix before the first '_' (kind_k8s-snapshot.json
// -> "kind"). A file with no '_' is grouped under "default". Each group's files
// are sorted so the dedup-on-merge precedence in loadSystemLayerFiles is
// deterministic (alphabetically, calico wins over k8s - as it did when the list
// was hardcoded ["calico-snapshot.json", "k8s-snapshot.json"]).
func discoverSnapshots() map[string][]string {
	groups := map[string][]string{}
	entries, err := fs.ReadDir(baselineFS, "baseline")
	if err != nil {
		return groups
	}
	for _, e := range entries {
		name := e.Name()
		if e.IsDir() || !strings.HasSuffix(name, "-snapshot.json") {
			continue
		}
		stem := strings.TrimSuffix(name, "-snapshot.json")
		provider := "default"
		if i := strings.Index(stem, "_"); i > 0 {
			provider = stem[:i]
		}
		groups[provider] = append(groups[provider], name)
	}
	for _, files := range groups {
		sort.Strings(files)
	}
	return groups
}

// loadSystemLayerFiles unions the given snapshot files into one Layer.
// Namespaces and endpoints are deduped by name / ID - when the same namespace
// appears in more than one snapshot (e.g. kube-system across a provider's k8s
// and calico snapshots), the first occurrence wins to avoid label conflicts.
// Resources (host endpoints, network sets, …) and the DNS map are unioned
// across the files; the DNS map is returned separately because it's a global
// resolver rather than a layer-scoped resource.
func loadSystemLayerFiles(files []string) (Layer, map[string][]string, error) {
	out := Layer{}
	var dns map[string][]string
	seenNs := map[string]bool{}
	seenEp := map[string]bool{}
	seenNode := map[string]bool{}
	for _, name := range files {
		b, err := baselineFS.ReadFile("baseline/" + name)
		if err != nil {
			// Tolerate missing files individually; one snapshot still gives
			// a usable system layer.
			continue
		}
		var s snapshotFile
		if err := json.Unmarshal(b, &s); err != nil {
			return out, dns, fmt.Errorf("parse %s: %w", name, err)
		}
		for _, ns := range s.Namespaces {
			if seenNs[ns.Name] {
				continue
			}
			seenNs[ns.Name] = true
			out.Namespaces = append(out.Namespaces, ns)
		}
		for _, ep := range s.Endpoints {
			if seenEp[ep.ID] {
				continue
			}
			seenEp[ep.ID] = true
			n := ep.App
			if n == "" {
				n = ep.Pod
			}
			out.Endpoints = append(out.Endpoints, calico.Endpoint{
				ID:                 ep.ID,
				Namespace:          ep.Namespace,
				Name:               n,
				IP:                 ep.IP,
				Labels:             ep.Labels,
				Ports:              ep.Ports,
				ServiceAccountName: ep.ServiceAccountName,
				Node:               ep.Node,
			})
		}
		for _, n := range s.Nodes {
			if n.Name == "" || seenNode[n.Name] {
				continue
			}
			seenNode[n.Name] = true
			out.Nodes = append(out.Nodes, n)
		}
		out.Resources = mergeResources(out.Resources, s.Resources)
		for host, ips := range s.DNS {
			if dns == nil {
				dns = map[string][]string{}
			}
			if _, ok := dns[host]; !ok {
				dns[host] = ips
			}
		}
	}
	return out, dns, nil
}

// mergeResources appends b's lists onto a's. Used to union the optional
// resource lists across the two system snapshots; dedup isn't needed because
// the snapshots don't overlap on these (calico vs k8s objects).
func mergeResources(a, b Resources) Resources {
	a.ServiceAccounts = append(a.ServiceAccounts, b.ServiceAccounts...)
	a.HostEndpoints = append(a.HostEndpoints, b.HostEndpoints...)
	a.NetworkSets = append(a.NetworkSets, b.NetworkSets...)
	a.GlobalNetworkSets = append(a.GlobalNetworkSets, b.GlobalNetworkSets...)
	a.Services = append(a.Services, b.Services...)
	a.EndpointSlices = append(a.EndpointSlices, b.EndpointSlices...)
	return a
}

// loadWorkloadsLayer parses baseline/topology.yaml. Namespaces become
// NamespaceInputs (with kubernetes.io/metadata.name auto-set if absent);
// Deployments become Endpoints, taking labels from the pod template and
// synthesising deterministic IPs from 10.244.0.<n>. The synthetic IPs only
// have to be unique; the engine doesn't care about routing.
func loadWorkloadsLayer() (Layer, error) {
	b, err := baselineFS.ReadFile("baseline/topology.yaml")
	if err != nil {
		return Layer{}, nil
	}
	out := Layer{}
	ipN := 1
	for _, doc := range splitYAMLDocs(string(b)) {
		var d kubeDoc
		if err := yaml.Unmarshal([]byte(doc), &d); err != nil {
			continue
		}
		switch d.Kind {
		case "Namespace":
			labels := d.Metadata.Labels
			if labels == nil {
				labels = map[string]string{}
			}
			if labels["kubernetes.io/metadata.name"] == "" {
				labels["kubernetes.io/metadata.name"] = d.Metadata.Name
			}
			out.Namespaces = append(out.Namespaces, calico.NamespaceInput{
				Name:   d.Metadata.Name,
				Labels: labels,
			})
		case "Deployment":
			labels := d.Spec.Template.Metadata.Labels
			if labels == nil {
				labels = map[string]string{}
			}
			ip := fmt.Sprintf("10.244.0.%d", ipN)
			ipN++
			out.Endpoints = append(out.Endpoints, calico.Endpoint{
				ID:        d.Metadata.Namespace + "/" + d.Metadata.Name,
				Namespace: d.Metadata.Namespace,
				Name:      d.Metadata.Name,
				IP:        ip,
				Labels:    labels,
				Node:      d.Spec.Template.Spec.NodeName,
			})
		case "HostEndpoint":
			out.HostEndpoints = append(out.HostEndpoints, calico.HostEndpointInput{
				ID:            "host/" + d.Metadata.Name,
				Name:          d.Metadata.Name,
				Node:          d.Spec.Node,
				InterfaceName: d.Spec.InterfaceName,
				ExpectedIPs:   d.Spec.ExpectedIPs,
				Labels:        d.Metadata.Labels,
			})
		case "NetworkSet":
			out.NetworkSets = append(out.NetworkSets, calico.NetworkSetInput{
				Name:      d.Metadata.Name,
				Namespace: d.Metadata.Namespace,
				Nets:      d.Spec.Nets,
				Labels:    d.Metadata.Labels,
			})
		case "GlobalNetworkSet":
			out.GlobalNetworkSets = append(out.GlobalNetworkSets, calico.GlobalNetworkSetInput{
				Name:   d.Metadata.Name,
				Nets:   d.Spec.Nets,
				Labels: d.Metadata.Labels,
			})
		}
	}
	return out, nil
}

// splitYAMLDocs splits a multi-doc YAML stream on lines that are just `---`.
// Same shape harness.py's _split_yaml_docs uses - kept here so we don't pull
// a third-party multi-doc parser for ~10 lines of logic.
func splitYAMLDocs(text string) []string {
	var out []string
	var buf strings.Builder
	for _, line := range strings.Split(text, "\n") {
		if strings.TrimSpace(line) == "---" {
			if s := strings.TrimSpace(buf.String()); s != "" {
				out = append(out, s)
			}
			buf.Reset()
			continue
		}
		buf.WriteString(line)
		buf.WriteByte('\n')
	}
	if s := strings.TrimSpace(buf.String()); s != "" {
		out = append(out, s)
	}
	return out
}
