// Starter skeletons offered as whole-document snippets at the top of a blank
// editor (see policyCompletions §1 - type a few letters of the id/label to
// filter). Each is a minimal but *schema-valid* document: required keys present,
// sensible placeholder values, and `# TODO`/inline hints pointing at what to
// change. Because they validate cleanly against ../policySchemas, the user gets
// no spurious red squiggles on insert - only as they edit values. Completion and
// hover (from monaco-yaml) take over from there.

export interface PolicyTemplate {
  id: string;
  label: string; // button text
  title: string; // button tooltip
  yaml: string;
}

export const POLICY_TEMPLATES: PolicyTemplate[] = [
  {
    id: 'k8s-np',
    label: '+ K8s NetworkPolicy',
    title: 'Kubernetes NetworkPolicy (networking.k8s.io/v1) - namespaced, allow-only',
    yaml: `apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: my-network-policy   # TODO: name this policy
  namespace: default        # TODO: target namespace
spec:
  podSelector:
    matchLabels:
      app: my-app           # TODO: pods this policy protects
  policyTypes:
    - Ingress
  ingress:
    - from:
        - podSelector:
            matchLabels:
              app: client   # TODO: who may connect
      ports:
        - protocol: TCP
          port: 8080
`,
  },
  {
    id: 'calico-np',
    label: '+ Calico NetworkPolicy',
    title: 'Calico NetworkPolicy (projectcalico.org/v3) - namespaced, action-based rules',
    yaml: `apiVersion: projectcalico.org/v3
kind: NetworkPolicy
metadata:
  name: my-calico-policy    # TODO: name this policy
  namespace: default        # TODO: target namespace
spec:
  selector: app == 'my-app' # TODO: endpoints this policy applies to
  types:
    - Ingress
  ingress:
    - action: Allow         # Allow | Deny | Log | Pass
      protocol: TCP
      source:
        selector: app == 'client'   # TODO: who may connect
      destination:
        ports:
          - 8080
`,
  },
  {
    id: 'calico-gnp',
    label: '+ GlobalNetworkPolicy',
    title: 'Calico GlobalNetworkPolicy (projectcalico.org/v3) - cluster-wide, no namespace',
    yaml: `apiVersion: projectcalico.org/v3
kind: GlobalNetworkPolicy
metadata:
  name: my-global-policy    # TODO: name this policy
spec:
  selector: all()           # TODO: endpoints cluster-wide (all() = every workload)
  types:
    - Ingress
    - Egress
  ingress:
    - action: Allow
      source:
        selector: app == 'client'   # TODO: who may connect
  egress:
    - action: Allow
`,
  },
  {
    id: 'k8s-cnp',
    label: '+ ClusterNetworkPolicy',
    title:
      'Kubernetes ClusterNetworkPolicy (policy.networking.k8s.io/v1alpha2) - cluster-scoped NPA; actions are Accept/Deny/Pass',
    yaml: `apiVersion: policy.networking.k8s.io/v1alpha2
kind: ClusterNetworkPolicy
metadata:
  name: my-cluster-policy   # TODO: name this policy
spec:
  tier: Admin               # Admin | Baseline
  priority: 100             # 0-1000; lower = higher precedence
  subject:
    namespaces:
      matchLabels:
        kubernetes.io/metadata.name: prod   # TODO: pods this policy protects
  ingress:
    - name: allow-monitoring
      action: Accept         # Accept | Deny | Pass  (note: NOT "Allow")
      from:
        - namespaces:
            matchLabels:
              kubernetes.io/metadata.name: monitoring   # TODO: who may connect
      protocols:
        - tcp:
            destinationPort:
              number: 8080
`,
  },
  {
    id: 'calico-deny-all',
    label: '+ Calico Default-Deny',
    title:
      'Calico NetworkPolicy (projectcalico.org/v3) - namespaced default-deny: selects all pods, no rules, so all ingress+egress is dropped',
    yaml: `apiVersion: projectcalico.org/v3
kind: NetworkPolicy
metadata:
  name: default-deny           # TODO: name this policy
  namespace: default           # TODO: namespace to lock down
spec:
  selector: all()              # every workload in the namespace
  types:
    - Ingress
    - Egress
  # No ingress/egress rules => all traffic in both directions is denied.
  # Layer allow-policies in a higher-precedence tier (lower order) on top.
`,
  },
  {
    id: 'calico-egress-fqdn',
    label: '+ Calico Egress to FQDN',
    title:
      'Calico NetworkPolicy (projectcalico.org/v3) - egress allow to external domains (FQDN), with the DNS lookup that makes it work',
    yaml: `apiVersion: projectcalico.org/v3
kind: NetworkPolicy
metadata:
  name: allow-egress-fqdn      # TODO: name this policy
  namespace: default           # TODO: target namespace
spec:
  selector: app == 'my-app'    # TODO: endpoints allowed to egress
  types:
    - Egress
  egress:
    # FQDN matching needs DNS resolution, so allow DNS to kube-dns first.
    - action: Allow
      protocol: UDP
      destination:
        selector: k8s-app == 'kube-dns'
        ports:
          - 53
    - action: Allow
      protocol: TCP
      destination:
        domains:               # exact names and *.wildcards
          - www.example.com
          - '*.googleapis.com' # TODO: domains this app may reach
        ports:
          - 443
`,
  },
  {
    id: 'calico-staged-np',
    label: '+ Calico Staged Policy',
    title:
      'Calico StagedNetworkPolicy (projectcalico.org/v3) - preview a policy (counts traffic, enforces nothing) before promoting it',
    yaml: `apiVersion: projectcalico.org/v3
kind: StagedNetworkPolicy
metadata:
  name: my-staged-policy       # TODO: name this policy
  namespace: default           # TODO: target namespace
spec:
  stagedAction: Set            # Set (preview this policy) | Delete (preview removing it)
  selector: app == 'my-app'    # TODO: endpoints this would apply to
  types:
    - Ingress
  ingress:
    - action: Allow
      source:
        selector: app == 'client'   # TODO: who would be allowed
`,
  },
  {
    id: 'calico-tier',
    label: '+ Calico Tier',
    title:
      'Calico Tier (projectcalico.org/v3) - a precedence band that (Global)NetworkPolicies join via spec.tier',
    yaml: `apiVersion: projectcalico.org/v3
kind: Tier
metadata:
  name: platform               # TODO: name this tier; reference it via spec.tier
spec:
  order: 100                   # lower order = evaluated first (higher precedence)
  defaultAction: Pass          # Pass (fall through to next tier) | Deny (drop here)
`,
  },
];
