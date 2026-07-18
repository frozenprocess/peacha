// JSON Schemas for the policy editor's supported document kinds. These drive
// monaco-yaml's completion / hover / validation.
//
// Two sources:
//   - The seven projectcalico.org/v3 kinds (NetworkPolicy, GlobalNetworkPolicy,
//     the three Staged*, Tier, HostEndpoint) are GENERATED from the upstream
//     Calico CRD manifest by scripts/gen-policy-schema.ts and imported from
//     ./generatedPolicySchemas. Their structure + enums come straight from the
//     CRD (so they can't structurally drift); field descriptions and the few
//     intentional divergences (enriched protocol enum, editor-only `domains`,
//     the stagedAction subset) come from ./policySchemaOverlay. Regenerate with
//     `npm run gen:crd` after a Calico bump.
//   - networking.k8s.io/v1 NetworkPolicy and policy.networking.k8s.io
//     ClusterNetworkPolicy (NPA / KEP-2091) are NOT in the Calico manifest, so
//     they stay hand-written below.
//
// The editor is a single multi-document (`---` separated) YAML model, so the
// root schema is a `oneOf` over the kinds discriminated by apiVersion/kind:
// yaml-language-server validates each document independently and picks the
// branch whose consts match.

// .ts extension so the Node-run tooling (scripts/check-crd-drift.ts,
// gen-policy-schema.ts) that imports this module can resolve it natively.
import { generatedSchemas } from './generatedPolicySchemas.ts';

// --- shared Kubernetes building blocks (for the two hand-written kinds) ------

const labelSelector = {
  type: 'object',
  additionalProperties: false,
  title: 'Label selector',
  description: 'A Kubernetes label selector. Empty selects everything in scope.',
  properties: {
    matchLabels: {
      type: 'object',
      additionalProperties: { type: 'string' },
      description: 'Map of {key: value}; all must match (AND).',
    },
    matchExpressions: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['key', 'operator'],
        properties: {
          key: { type: 'string' },
          operator: { enum: ['In', 'NotIn', 'Exists', 'DoesNotExist'] },
          values: { type: 'array', items: { type: 'string' } },
        },
      },
    },
  },
} as const;

const objectMeta = (namespaced: boolean) =>
  ({
    type: 'object',
    additionalProperties: false,
    required: ['name'],
    properties: {
      name: { type: 'string', description: 'Resource name (DNS-1123 subdomain).' },
      ...(namespaced
        ? { namespace: { type: 'string', description: 'Namespace this policy applies in.' } }
        : {}),
      labels: { type: 'object', additionalProperties: { type: 'string' } },
      annotations: { type: 'object', additionalProperties: { type: 'string' } },
    },
  }) as const;

// --- k8s NetworkPolicy -------------------------------------------------------

const k8sPeer = {
  type: 'object',
  additionalProperties: false,
  description: 'A source/destination peer. Provide at least one of the fields.',
  properties: {
    podSelector: labelSelector,
    namespaceSelector: labelSelector,
    ipBlock: {
      type: 'object',
      additionalProperties: false,
      required: ['cidr'],
      properties: {
        cidr: { type: 'string', description: 'CIDR, e.g. 10.0.0.0/16.' },
        except: { type: 'array', items: { type: 'string' } },
      },
    },
  },
} as const;

const k8sPorts = {
  type: 'array',
  items: {
    type: 'object',
    additionalProperties: false,
    properties: {
      protocol: { enum: ['TCP', 'UDP', 'SCTP'], description: 'Defaults to TCP.' },
      port: {
        anyOf: [{ type: 'integer' }, { type: 'string' }],
        description: 'Numeric port or named port from the pod spec.',
      },
      endPort: { type: 'integer', description: 'End of a port range (with port as start).' },
    },
  },
} as const;

const k8sNetworkPolicy = {
  type: 'object',
  additionalProperties: false,
  required: ['apiVersion', 'kind', 'metadata', 'spec'],
  title: 'Kubernetes NetworkPolicy',
  properties: {
    apiVersion: { const: 'networking.k8s.io/v1' },
    kind: { const: 'NetworkPolicy' },
    metadata: objectMeta(true),
    spec: {
      type: 'object',
      additionalProperties: false,
      required: ['podSelector'],
      properties: {
        podSelector: {
          ...labelSelector,
          description: 'Pods this policy applies to. Empty {} selects all pods in the namespace.',
        },
        policyTypes: {
          type: 'array',
          items: { enum: ['Ingress', 'Egress'] },
          description: 'Which directions this policy governs. Inferred if omitted.',
        },
        ingress: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              from: { type: 'array', items: k8sPeer },
              ports: k8sPorts,
            },
          },
        },
        egress: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              to: { type: 'array', items: k8sPeer },
              ports: k8sPorts,
            },
          },
        },
      },
    },
  },
} as const;

// --- Kubernetes ClusterNetworkPolicy (NPA / KEP-2091, v1alpha2) --------------
//
// Cluster-scoped Kubernetes-native policy (short name `cnp`); the engine
// converts it to a Calico GlobalNetworkPolicy in the Admin/Baseline tier. It is
// deliberately NOT the same shape as the others: actions are Accept|Deny|Pass
// (no "Allow"), ports live under `protocols`, and peers/subject use
// namespace/pod label selectors rather than Calico selector strings. Mirrors
// sigs.k8s.io/network-policy-api/apis/v1alpha2 ClusterNetworkPolicy.

const npaNamespacedPod = {
  type: 'object',
  additionalProperties: false,
  required: ['podSelector'],
  description: 'Pods in selected namespaces.',
  properties: {
    namespaceSelector: { ...labelSelector, description: 'Namespaces to select; empty selects all.' },
    podSelector: { ...labelSelector, description: 'Pods within those namespaces; empty selects all.' },
  },
} as const;

const npaIngressPeer = {
  type: 'object',
  additionalProperties: false,
  minProperties: 1,
  maxProperties: 1,
  description: 'A source peer. Set exactly one of namespaces / pods.',
  properties: {
    namespaces: { ...labelSelector, description: 'Select whole namespaces by label.' },
    pods: npaNamespacedPod,
  },
} as const;

const npaEgressPeer = {
  type: 'object',
  additionalProperties: false,
  minProperties: 1,
  maxProperties: 1,
  description: 'A destination peer. Set exactly one field.',
  properties: {
    namespaces: { ...labelSelector, description: 'Select whole namespaces by label.' },
    pods: npaNamespacedPod,
    nodes: { ...labelSelector, description: 'Select cluster nodes by label (experimental).' },
    networks: {
      type: 'array',
      items: { type: 'string' },
      description: 'External CIDRs, e.g. 10.0.0.0/8 (experimental).',
    },
    domainNames: {
      type: 'array',
      items: { type: 'string' },
      description: 'FQDNs/wildcards; Accept rules only (experimental).',
    },
  },
} as const;

const npaPort = {
  type: 'object',
  additionalProperties: false,
  minProperties: 1,
  maxProperties: 1,
  properties: {
    number: { type: 'integer', minimum: 1, maximum: 65535 },
    range: {
      type: 'object',
      additionalProperties: false,
      required: ['start', 'end'],
      properties: {
        start: { type: 'integer', minimum: 1, maximum: 65535 },
        end: { type: 'integer', minimum: 1, maximum: 65535 },
      },
    },
  },
} as const;

const npaProtocolPort = {
  type: 'object',
  additionalProperties: false,
  properties: { destinationPort: npaPort },
} as const;

const npaProtocol = {
  type: 'object',
  additionalProperties: false,
  minProperties: 1,
  maxProperties: 1,
  description: 'Protocol-specific match. Set exactly one field.',
  properties: {
    tcp: npaProtocolPort,
    udp: npaProtocolPort,
    sctp: npaProtocolPort,
    destinationNamedPort: { type: 'string' },
  },
} as const;

const npaAction = {
  enum: ['Accept', 'Deny', 'Pass'],
  description: 'Accept | Deny | Pass - note: NOT "Allow" (that is Calico). Accept/Deny are final.',
} as const;

const npaIngressRule = {
  type: 'object',
  additionalProperties: false,
  required: ['action', 'from'],
  properties: {
    name: { type: 'string', maxLength: 100 },
    action: npaAction,
    from: { type: 'array', minItems: 1, items: npaIngressPeer, description: 'Sources (at least one).' },
    protocols: { type: 'array', items: npaProtocol, description: 'Optional port/protocol matches.' },
  },
} as const;

const npaEgressRule = {
  type: 'object',
  additionalProperties: false,
  required: ['action', 'to'],
  properties: {
    name: { type: 'string', maxLength: 100 },
    action: npaAction,
    to: { type: 'array', minItems: 1, items: npaEgressPeer, description: 'Destinations (at least one).' },
    protocols: { type: 'array', items: npaProtocol, description: 'Optional port/protocol matches.' },
  },
} as const;

const k8sClusterNetworkPolicy = {
  type: 'object',
  additionalProperties: false,
  required: ['apiVersion', 'kind', 'metadata', 'spec'],
  title: 'Kubernetes ClusterNetworkPolicy (NPA v1alpha2)',
  properties: {
    apiVersion: { const: 'policy.networking.k8s.io/v1alpha2' },
    kind: { const: 'ClusterNetworkPolicy' },
    metadata: objectMeta(false), // cluster-scoped: no namespace
    spec: {
      type: 'object',
      additionalProperties: false,
      required: ['tier', 'priority', 'subject'],
      properties: {
        tier: { enum: ['Admin', 'Baseline'], description: 'Admin (highest precedence) or Baseline (overridable by NetworkPolicy).' },
        priority: { type: 'integer', minimum: 0, maximum: 1000, description: 'Lower = higher precedence within the tier.' },
        subject: {
          type: 'object',
          additionalProperties: false,
          minProperties: 1,
          maxProperties: 1,
          description: 'Pods this policy applies to. Set exactly one of namespaces / pods.',
          properties: {
            namespaces: { ...labelSelector, description: 'Apply to whole namespaces by label.' },
            pods: npaNamespacedPod,
          },
        },
        ingress: { type: 'array', items: npaIngressRule, maxItems: 25 },
        egress: { type: 'array', items: npaEgressRule, maxItems: 25 },
      },
    },
  },
} as const;

// withTier injects a spec.tier property into a Calico (Global)NetworkPolicy
// branch. The CRD models spec.tier as a free string; this overrides it with the
// live tier enum (when tier names are known) so a typo'd / non-existent tier
// gets flagged as you type. An empty list leaves it a free-form string (e.g.
// before the topology has loaded).
function withTier<T extends { properties: { spec: { properties: object } } }>(
  policy: T,
  tierNames: string[],
): object {
  const tier = {
    type: 'string',
    description:
      'Calico tier this policy lives in (default: "default"). Add tiers in the topology "tiers" tab.',
    ...(tierNames.length ? { enum: tierNames } : {}),
  };
  return {
    ...policy,
    properties: {
      ...policy.properties,
      spec: {
        ...policy.properties.spec,
        properties: { ...policy.properties.spec.properties, tier },
      },
    },
  };
}

// buildPolicySchema assembles the root schema: one of the supported document
// kinds. yaml-language-server matches each `---` document against the branch
// whose apiVersion/kind consts fit. tierNames parameterises the Calico spec.tier
// enum so completion/validation tracks the live tier list (see monacoSetup's
// updatePolicyTiers). Defaults to just ['default'] for the initial mount.
export function buildPolicySchema(tierNames: string[] = ['default']) {
  const g = generatedSchemas;
  return {
    $schema: 'http://json-schema.org/draft-07/schema#',
    title: 'Network policy (Kubernetes or Calico)',
    oneOf: [
      k8sNetworkPolicy,
      withTier(g.NetworkPolicy, tierNames),
      withTier(g.GlobalNetworkPolicy, tierNames),
      withTier(g.StagedNetworkPolicy, tierNames),
      withTier(g.StagedGlobalNetworkPolicy, tierNames),
      g.StagedKubernetesNetworkPolicy,
      g.Tier,
      g.HostEndpoint,
      k8sClusterNetworkPolicy,
    ],
  };
}
