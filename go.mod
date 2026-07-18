// The editor server is a small HTTP front-end for the in-process
// calico-engine. It lives in its own module so its third-party dependencies
// (LRU cache only, for now) don't leak into the engine module. The repo-root
// go.work stitches this module together with the two submodules under
// third_party/ (the telepathy engine + the untouched Calico source).
module github.com/frozenprocess/peacha

go 1.26.4

require (
	github.com/frozenprocess/telepathy v0.0.0-00010101000000-000000000000
	github.com/frozenprocess/telepathy/api v0.0.0-20260701161240-d4d1bba981c3
	github.com/lib/pq v1.12.3
	github.com/yuin/goldmark v1.4.13
	modernc.org/sqlite v1.51.0
)

replace github.com/frozenprocess/telepathy => ./third_party/telepathy

// telepathy/api is a nested module (its own go.mod), so the parent telepathy
// replace above does NOT cover it. Point it at the local checkout too, or the
// build pulls api from the network instead of third_party/.
replace github.com/frozenprocess/telepathy/api => ./third_party/telepathy/api

replace github.com/frozenprocess/calico => ./third_party/calico

require (
	github.com/projectcalico/calico v0.0.0-00010101000000-000000000000 // indirect
	github.com/sirupsen/logrus v1.9.4
	sigs.k8s.io/yaml v1.6.0
)

require (
	cel.dev/expr v0.25.1 // indirect
	github.com/Microsoft/go-winio v0.6.2 // indirect
	github.com/Microsoft/hcsshim v0.14.1 // indirect
	github.com/antlr4-go/antlr/v4 v4.13.1 // indirect
	github.com/beorn7/perks v1.0.1 // indirect
	github.com/bits-and-blooms/bitset v1.24.5 // indirect
	github.com/blang/semver/v4 v4.0.0 // indirect
	github.com/cespare/xxhash/v2 v2.3.0 // indirect
	github.com/clipperhouse/uax29/v2 v2.6.0 // indirect
	github.com/cncf/xds/go v0.0.0-20260202195803-dba9d589def2 // indirect
	github.com/containerd/cgroups/v3 v3.1.2 // indirect
	github.com/containerd/errdefs v1.0.0 // indirect
	github.com/containerd/errdefs/pkg v0.3.0 // indirect
	github.com/containerd/typeurl/v2 v2.2.3 // indirect
	github.com/coreos/go-semver v0.3.1 // indirect
	github.com/coreos/go-systemd/v22 v22.7.0 // indirect
	github.com/davecgh/go-spew v1.1.2-0.20180830191138-d8f796af33cc // indirect
	github.com/dustin/go-humanize v1.0.1 // indirect
	github.com/emicklei/go-restful/v3 v3.13.0 // indirect
	github.com/envoyproxy/go-control-plane/envoy v1.37.0 // indirect
	github.com/envoyproxy/protoc-gen-validate v1.3.3 // indirect
	github.com/fxamacker/cbor/v2 v2.9.0 // indirect
	github.com/go-ini/ini v1.67.0 // indirect
	github.com/go-kit/log v0.2.1 // indirect
	github.com/go-logfmt/logfmt v0.6.1 // indirect
	github.com/go-logr/logr v1.4.3 // indirect
	github.com/go-openapi/jsonpointer v0.22.4 // indirect
	github.com/go-openapi/jsonreference v0.21.4 // indirect
	github.com/go-openapi/swag v0.23.1 // indirect
	github.com/go-openapi/swag/jsonname v0.25.4 // indirect
	github.com/go-playground/locales v0.14.1 // indirect
	github.com/go-playground/universal-translator v0.18.1 // indirect
	github.com/gogo/protobuf v1.3.2 // indirect
	github.com/golang/groupcache v0.0.0-20210331224755-41bb18bfe9da // indirect
	github.com/golang/protobuf v1.5.4 // indirect
	github.com/golang/snappy v1.0.0 // indirect
	github.com/google/btree v1.1.3 // indirect
	github.com/google/cel-go v0.26.0 // indirect
	github.com/google/gnostic-models v0.7.0 // indirect
	github.com/google/go-cmp v0.7.0 // indirect
	github.com/google/uuid v1.6.0 // indirect
	github.com/gorilla/websocket v1.5.4-0.20250319132907-e064f32e3674 // indirect
	github.com/grpc-ecosystem/grpc-gateway/v2 v2.28.0 // indirect
	github.com/inconshreveable/mousetrap v1.1.0 // indirect
	github.com/jinzhu/copier v0.4.0 // indirect
	github.com/josharian/intern v1.0.0 // indirect
	github.com/josharian/native v1.1.0 // indirect
	github.com/json-iterator/go v1.1.12 // indirect
	github.com/kardianos/osext v0.0.0-20190222173326-2bc1f35cddc0 // indirect
	github.com/kelseyhightower/envconfig v1.4.0 // indirect
	github.com/leodido/go-urn v1.4.0 // indirect
	github.com/mailru/easyjson v0.9.1 // indirect
	github.com/mattn/go-isatty v0.0.20 // indirect
	github.com/mattn/go-runewidth v0.0.19 // indirect
	github.com/mdlayher/genetlink v1.3.2 // indirect
	github.com/mdlayher/netlink v1.7.2 // indirect
	github.com/mdlayher/socket v0.5.1 // indirect
	github.com/mipearson/rfw v0.0.0-20170619235010-6f0a6f3266ba // indirect
	github.com/modern-go/concurrent v0.0.0-20180306012644-bacd9c7ef1dd // indirect
	github.com/modern-go/reflect2 v1.0.3-0.20250322232337-35a7c28c31ee // indirect
	github.com/munnerz/goautoneg v0.0.0-20191010083416-a7dc8b61c822 // indirect
	github.com/ncruces/go-strftime v1.0.0 // indirect
	github.com/olekukonko/tablewriter v0.0.5 // indirect
	github.com/onsi/gomega v1.42.0 // indirect
	github.com/openshift/custom-resource-status v1.1.2 // indirect
	github.com/pkg/errors v0.9.1 // indirect
	github.com/planetscale/vtprotobuf v0.6.1-0.20240319094008-0393e58bdf10 // indirect
	github.com/pmezard/go-difflib v1.0.1-0.20181226105442-5d4384ee4fb2 // indirect
	github.com/projectcalico/api v0.0.0-20260303210141-543421943355 // indirect
	github.com/projectcalico/calico/lib/std v0.0.0-00010101000000-000000000000 // indirect
	github.com/prometheus/client_golang v1.23.2 // indirect
	github.com/prometheus/client_model v0.6.2 // indirect
	github.com/prometheus/common v0.68.1 // indirect
	github.com/prometheus/procfs v0.20.1 // indirect
	github.com/remyoudompheng/bigfft v0.0.0-20230129092748-24d4a6f8daec // indirect
	github.com/spf13/cobra v1.10.2 // indirect
	github.com/spf13/pflag v1.0.10 // indirect
	github.com/stoewer/go-strcase v1.3.1 // indirect
	github.com/tchap/go-patricia/v2 v2.3.3 // indirect
	github.com/vishvananda/netlink v1.3.1 // indirect
	github.com/vishvananda/netns v0.0.5 // indirect
	github.com/x448/float16 v0.8.4 // indirect
	go.etcd.io/etcd/api/v3 v3.6.12 // indirect
	go.etcd.io/etcd/client/pkg/v3 v3.6.12 // indirect
	go.etcd.io/etcd/client/v3 v3.6.12 // indirect
	go.opencensus.io v0.24.0 // indirect
	go.opentelemetry.io/otel v1.43.0 // indirect
	go.opentelemetry.io/otel/trace v1.43.0 // indirect
	go.uber.org/multierr v1.11.0 // indirect
	go.uber.org/zap v1.27.1 // indirect
	go.yaml.in/yaml/v2 v2.4.4 // indirect
	go.yaml.in/yaml/v3 v3.0.4 // indirect
	golang.org/x/crypto v0.54.0 // indirect
	golang.org/x/exp v0.0.0-20251219203646-944ab1f22d93 // indirect
	golang.org/x/net v0.57.0 // indirect
	golang.org/x/oauth2 v0.36.0 // indirect
	golang.org/x/sync v0.22.0 // indirect
	golang.org/x/sys v0.47.0 // indirect
	golang.org/x/term v0.45.0 // indirect
	golang.org/x/text v0.40.0 // indirect
	golang.org/x/time v0.15.0 // indirect
	golang.zx2c4.com/wireguard v0.0.0-20231211153847-12269c276173 // indirect
	golang.zx2c4.com/wireguard/wgctrl v0.0.0-20241231184526-a9ab2273dd10 // indirect
	google.golang.org/genproto/googleapis/api v0.0.0-20260401024825-9d38bb4040a9 // indirect
	google.golang.org/genproto/googleapis/rpc v0.0.0-20260615183401-62b3387ff324 // indirect
	google.golang.org/grpc v1.81.1 // indirect
	google.golang.org/protobuf v1.36.12-0.20260120151049-f2248ac996af // indirect
	gopkg.in/evanphx/json-patch.v4 v4.13.0 // indirect
	gopkg.in/go-playground/assert.v1 v1.2.1 // indirect
	gopkg.in/go-playground/validator.v9 v9.31.0 // indirect
	gopkg.in/inf.v0 v0.9.1 // indirect
	gopkg.in/yaml.v3 v3.0.1 // indirect
	k8s.io/api v0.36.2 // indirect
	k8s.io/apiextensions-apiserver v0.36.2 // indirect
	k8s.io/apimachinery v0.36.2 // indirect
	k8s.io/apiserver v0.36.2 // indirect
	k8s.io/client-go v0.36.2 // indirect
	k8s.io/component-base v0.36.2 // indirect
	k8s.io/component-helpers v0.36.2 // indirect
	k8s.io/controller-manager v0.36.2 // indirect
	k8s.io/klog/v2 v2.140.0 // indirect
	k8s.io/kube-openapi v0.31.0 // indirect
	k8s.io/kubernetes v1.36.2 // indirect
	k8s.io/utils v0.0.0-20260210185600-b8788abfbbc2 // indirect
	kubevirt.io/api v1.8.3 // indirect
	kubevirt.io/client-go v1.8.3 // indirect
	kubevirt.io/containerized-data-importer-api v1.64.0 // indirect
	kubevirt.io/controller-lifecycle-operator-sdk/api v0.2.4 // indirect
	modernc.org/libc v1.72.3 // indirect
	modernc.org/mathutil v1.7.1 // indirect
	modernc.org/memory v1.11.0 // indirect
	sigs.k8s.io/json v0.0.0-20250730193827-2d320260d730 // indirect
	sigs.k8s.io/knftables v0.0.21 // indirect
	sigs.k8s.io/network-policy-api v0.2.0 // indirect
	sigs.k8s.io/randfill v1.0.0 // indirect
	sigs.k8s.io/structured-merge-diff/v6 v6.4.0 // indirect
)

replace github.com/projectcalico/calico => ./third_party/calico

// `go mod tidy` operates on this module in isolation: it ignores go.work and
// does NOT inherit replace directives from third_party/calico/go.mod (replaces
// are not transitive). The block below mirrors Calico's own replaces so tidy
// can resolve Calico's transitive deps. The three local-path entries are
// rewritten to point under ./third_party/calico/; the version pins are copied
// verbatim. Keep in sync with third_party/calico/go.mod when bumping Calico.
replace (
	github.com/projectcalico/api => ./third_party/calico/api
	github.com/projectcalico/calico/lib/httpmachinery => ./third_party/calico/lib/httpmachinery
	github.com/projectcalico/calico/lib/std => ./third_party/calico/lib/std

	k8s.io/api => k8s.io/api v0.36.1
	k8s.io/apiextensions-apiserver => k8s.io/apiextensions-apiserver v0.36.1
	k8s.io/apimachinery => k8s.io/apimachinery v0.36.1
	k8s.io/apiserver => k8s.io/apiserver v0.36.1
	k8s.io/cli-runtime => k8s.io/cli-runtime v0.36.1
	k8s.io/client-go => k8s.io/client-go v0.36.1
	k8s.io/cloud-provider => k8s.io/cloud-provider v0.36.1
	k8s.io/cluster-bootstrap => k8s.io/cluster-bootstrap v0.36.1
	k8s.io/code-generator => k8s.io/code-generator v0.36.1
	k8s.io/component-base => k8s.io/component-base v0.36.1
	k8s.io/component-helpers => k8s.io/component-helpers v0.36.1
	k8s.io/controller-manager => k8s.io/controller-manager v0.36.1
	k8s.io/cri-api => k8s.io/cri-api v0.36.1
	k8s.io/cri-streaming => k8s.io/cri-streaming v0.36.1
	k8s.io/csi-translation-lib => k8s.io/csi-translation-lib v0.36.1
	k8s.io/endpointslice => k8s.io/endpointslice v0.36.1
	k8s.io/externaljwt => k8s.io/externaljwt v0.36.1
	k8s.io/kube-aggregator => k8s.io/kube-aggregator v0.36.1
	k8s.io/kube-controller-manager => k8s.io/kube-controller-manager v0.36.1

	// kubevirt.io/client-go requires a tagged kube-openapi version that doesn't
	// exist; pin to the pseudo-version used by the rest of our k8s dependencies.
	k8s.io/kube-openapi => k8s.io/kube-openapi v0.0.0-20260317180543-43fb72c5454a
	k8s.io/kube-proxy => k8s.io/kube-proxy v0.36.1
	k8s.io/kube-scheduler => k8s.io/kube-scheduler v0.36.1
	k8s.io/kubectl => k8s.io/kubectl v0.36.1
	k8s.io/kubelet => k8s.io/kubelet v0.36.1
	k8s.io/metrics => k8s.io/metrics v0.36.1
	k8s.io/mount-utils => k8s.io/mount-utils v0.36.1
	k8s.io/pod-security-admission => k8s.io/pod-security-admission v0.36.1
	k8s.io/sample-apiserver => k8s.io/sample-apiserver v0.36.1

	kubevirt.io/client-go => github.com/tigera/kubevirt-client-go v1.7.0-tigera1
)
