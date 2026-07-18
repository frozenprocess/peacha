// Description + curation overlay for the generated Calico policy schemas.
//
// The CRD manifest gives structure and enums but no field descriptions for the
// policy kinds, and the editor intentionally diverges in a few spots. This
// overlay is deep-merged onto the generated tree by scripts/gen-policy-schema.ts.
//
// Keyed by CRD kind, then by dotted resource path (property keys extend the
// path; arrays collapse - e.g. spec.ingress.source.selector). A string value
// sets `.description`; an object value is deep-merged (adds a field, or
// overrides enum/anyOf/title). "" targets the resource root.
//
// Bootstrapped from the old hand-written schema via `node scripts/gen-policy-schema.ts --seed`.
// Curate by hand thereafter; run `npm run gen:crd` to apply.

export const overlay: Record<string, Record<string, string | object>> = {
  "NetworkPolicy": {
    "spec.order": "Lower order = higher precedence.",
    "spec.selector": "Endpoints this policy applies to, e.g. all() or app == 'db'.",
    "spec.types": "Directions governed. Inferred from ingress/egress if omitted.",
    "spec.ingress.action": "What to do with matching traffic.",
    "spec.ingress.protocol": {
      "description": "Protocol name or IP protocol number.",
      "anyOf": [
        {
          "enum": [
            "TCP",
            "UDP",
            "ICMP",
            "ICMPv6",
            "SCTP",
            "UDPLite"
          ]
        },
        {
          "type": "integer",
          "minimum": 0,
          "maximum": 255
        }
      ]
    },
    "spec.ingress.notProtocol": {
      "description": "Protocol name or IP protocol number.",
      "anyOf": [
        {
          "enum": [
            "TCP",
            "UDP",
            "ICMP",
            "ICMPv6",
            "SCTP",
            "UDPLite"
          ]
        },
        {
          "type": "integer",
          "minimum": 0,
          "maximum": 255
        }
      ]
    },
    "spec.ingress.icmp": "Match specific ICMP type/code (requires protocol ICMP or ICMPv6).",
    "spec.ingress.ipVersion": "Restrict the rule to IPv4 (4) or IPv6 (6) traffic only.",
    "spec.ingress.source": "Match criteria for the source or destination of traffic.",
    "spec.ingress.source.selector": "Calico selector, e.g. app == 'frontend'.",
    "spec.ingress.source.namespaceSelector": "Selector over namespace labels.",
    "spec.ingress.source.nets": "CIDRs to match.",
    "spec.ingress.source.ports": "Ports: numbers, ranges (\"8080:8090\"), or named ports.",
    "spec.ingress.source.notPorts": "Ports: numbers, ranges (\"8080:8090\"), or named ports.",
    "spec.ingress.source.domains": {
      "type": "array",
      "items": {
        "type": "string"
      },
      "description": "FQDNs/wildcards (egress destination only)."
    },
    "spec.ingress.destination": "Match criteria for the source or destination of traffic.",
    "spec.ingress.destination.selector": "Calico selector, e.g. app == 'frontend'.",
    "spec.ingress.destination.namespaceSelector": "Selector over namespace labels.",
    "spec.ingress.destination.nets": "CIDRs to match.",
    "spec.ingress.destination.ports": "Ports: numbers, ranges (\"8080:8090\"), or named ports.",
    "spec.ingress.destination.notPorts": "Ports: numbers, ranges (\"8080:8090\"), or named ports.",
    "spec.ingress.destination.domains": {
      "type": "array",
      "items": {
        "type": "string"
      },
      "description": "FQDNs/wildcards (egress destination only)."
    },
    "spec.ingress.http": "HTTP match clause (ingress only).",
    "spec.ingress.metadata": "Per-rule metadata (does not affect matching).",
    "spec.ingress.metadata.annotations": "Free-form annotations attached to this rule.",
    "spec.egress.action": "What to do with matching traffic.",
    "spec.egress.protocol": {
      "description": "Protocol name or IP protocol number.",
      "anyOf": [
        {
          "enum": [
            "TCP",
            "UDP",
            "ICMP",
            "ICMPv6",
            "SCTP",
            "UDPLite"
          ]
        },
        {
          "type": "integer",
          "minimum": 0,
          "maximum": 255
        }
      ]
    },
    "spec.egress.notProtocol": {
      "description": "Protocol name or IP protocol number.",
      "anyOf": [
        {
          "enum": [
            "TCP",
            "UDP",
            "ICMP",
            "ICMPv6",
            "SCTP",
            "UDPLite"
          ]
        },
        {
          "type": "integer",
          "minimum": 0,
          "maximum": 255
        }
      ]
    },
    "spec.egress.icmp": "Match specific ICMP type/code (requires protocol ICMP or ICMPv6).",
    "spec.egress.ipVersion": "Restrict the rule to IPv4 (4) or IPv6 (6) traffic only.",
    "spec.egress.source": "Match criteria for the source or destination of traffic.",
    "spec.egress.source.selector": "Calico selector, e.g. app == 'frontend'.",
    "spec.egress.source.namespaceSelector": "Selector over namespace labels.",
    "spec.egress.source.nets": "CIDRs to match.",
    "spec.egress.source.ports": "Ports: numbers, ranges (\"8080:8090\"), or named ports.",
    "spec.egress.source.notPorts": "Ports: numbers, ranges (\"8080:8090\"), or named ports.",
    "spec.egress.source.domains": {
      "type": "array",
      "items": {
        "type": "string"
      },
      "description": "FQDNs/wildcards (egress destination only)."
    },
    "spec.egress.destination": "Match criteria for the source or destination of traffic.",
    "spec.egress.destination.selector": "Calico selector, e.g. app == 'frontend'.",
    "spec.egress.destination.namespaceSelector": "Selector over namespace labels.",
    "spec.egress.destination.nets": "CIDRs to match.",
    "spec.egress.destination.ports": "Ports: numbers, ranges (\"8080:8090\"), or named ports.",
    "spec.egress.destination.notPorts": "Ports: numbers, ranges (\"8080:8090\"), or named ports.",
    "spec.egress.destination.domains": {
      "type": "array",
      "items": {
        "type": "string"
      },
      "description": "FQDNs/wildcards (egress destination only)."
    },
    "spec.egress.http": "HTTP match clause (ingress only).",
    "spec.egress.metadata": "Per-rule metadata (does not affect matching).",
    "spec.egress.metadata.annotations": "Free-form annotations attached to this rule.",
    "spec.performanceHints": "Opt-in performance tweaks. AssumeNeededOnEveryNode programs the policy on every node even if no local endpoint matches yet."
  },
  "GlobalNetworkPolicy": {
    "spec.order": "Lower order = higher precedence.",
    "spec.selector": "Endpoints this policy applies to, e.g. all() or app == 'db'.",
    "spec.types": "Directions governed. Inferred from ingress/egress if omitted.",
    "spec.ingress.action": "What to do with matching traffic.",
    "spec.ingress.protocol": {
      "description": "Protocol name or IP protocol number.",
      "anyOf": [
        {
          "enum": [
            "TCP",
            "UDP",
            "ICMP",
            "ICMPv6",
            "SCTP",
            "UDPLite"
          ]
        },
        {
          "type": "integer",
          "minimum": 0,
          "maximum": 255
        }
      ]
    },
    "spec.ingress.notProtocol": {
      "description": "Protocol name or IP protocol number.",
      "anyOf": [
        {
          "enum": [
            "TCP",
            "UDP",
            "ICMP",
            "ICMPv6",
            "SCTP",
            "UDPLite"
          ]
        },
        {
          "type": "integer",
          "minimum": 0,
          "maximum": 255
        }
      ]
    },
    "spec.ingress.icmp": "Match specific ICMP type/code (requires protocol ICMP or ICMPv6).",
    "spec.ingress.ipVersion": "Restrict the rule to IPv4 (4) or IPv6 (6) traffic only.",
    "spec.ingress.source": "Match criteria for the source or destination of traffic.",
    "spec.ingress.source.selector": "Calico selector, e.g. app == 'frontend'.",
    "spec.ingress.source.namespaceSelector": "Selector over namespace labels.",
    "spec.ingress.source.nets": "CIDRs to match.",
    "spec.ingress.source.ports": "Ports: numbers, ranges (\"8080:8090\"), or named ports.",
    "spec.ingress.source.notPorts": "Ports: numbers, ranges (\"8080:8090\"), or named ports.",
    "spec.ingress.source.domains": {
      "type": "array",
      "items": {
        "type": "string"
      },
      "description": "FQDNs/wildcards (egress destination only)."
    },
    "spec.ingress.destination": "Match criteria for the source or destination of traffic.",
    "spec.ingress.destination.selector": "Calico selector, e.g. app == 'frontend'.",
    "spec.ingress.destination.namespaceSelector": "Selector over namespace labels.",
    "spec.ingress.destination.nets": "CIDRs to match.",
    "spec.ingress.destination.ports": "Ports: numbers, ranges (\"8080:8090\"), or named ports.",
    "spec.ingress.destination.notPorts": "Ports: numbers, ranges (\"8080:8090\"), or named ports.",
    "spec.ingress.destination.domains": {
      "type": "array",
      "items": {
        "type": "string"
      },
      "description": "FQDNs/wildcards (egress destination only)."
    },
    "spec.ingress.http": "HTTP match clause (ingress only).",
    "spec.ingress.metadata": "Per-rule metadata (does not affect matching).",
    "spec.ingress.metadata.annotations": "Free-form annotations attached to this rule.",
    "spec.egress.action": "What to do with matching traffic.",
    "spec.egress.protocol": {
      "description": "Protocol name or IP protocol number.",
      "anyOf": [
        {
          "enum": [
            "TCP",
            "UDP",
            "ICMP",
            "ICMPv6",
            "SCTP",
            "UDPLite"
          ]
        },
        {
          "type": "integer",
          "minimum": 0,
          "maximum": 255
        }
      ]
    },
    "spec.egress.notProtocol": {
      "description": "Protocol name or IP protocol number.",
      "anyOf": [
        {
          "enum": [
            "TCP",
            "UDP",
            "ICMP",
            "ICMPv6",
            "SCTP",
            "UDPLite"
          ]
        },
        {
          "type": "integer",
          "minimum": 0,
          "maximum": 255
        }
      ]
    },
    "spec.egress.icmp": "Match specific ICMP type/code (requires protocol ICMP or ICMPv6).",
    "spec.egress.ipVersion": "Restrict the rule to IPv4 (4) or IPv6 (6) traffic only.",
    "spec.egress.source": "Match criteria for the source or destination of traffic.",
    "spec.egress.source.selector": "Calico selector, e.g. app == 'frontend'.",
    "spec.egress.source.namespaceSelector": "Selector over namespace labels.",
    "spec.egress.source.nets": "CIDRs to match.",
    "spec.egress.source.ports": "Ports: numbers, ranges (\"8080:8090\"), or named ports.",
    "spec.egress.source.notPorts": "Ports: numbers, ranges (\"8080:8090\"), or named ports.",
    "spec.egress.source.domains": {
      "type": "array",
      "items": {
        "type": "string"
      },
      "description": "FQDNs/wildcards (egress destination only)."
    },
    "spec.egress.destination": "Match criteria for the source or destination of traffic.",
    "spec.egress.destination.selector": "Calico selector, e.g. app == 'frontend'.",
    "spec.egress.destination.namespaceSelector": "Selector over namespace labels.",
    "spec.egress.destination.nets": "CIDRs to match.",
    "spec.egress.destination.ports": "Ports: numbers, ranges (\"8080:8090\"), or named ports.",
    "spec.egress.destination.notPorts": "Ports: numbers, ranges (\"8080:8090\"), or named ports.",
    "spec.egress.destination.domains": {
      "type": "array",
      "items": {
        "type": "string"
      },
      "description": "FQDNs/wildcards (egress destination only)."
    },
    "spec.egress.http": "HTTP match clause (ingress only).",
    "spec.egress.metadata": "Per-rule metadata (does not affect matching).",
    "spec.egress.metadata.annotations": "Free-form annotations attached to this rule.",
    "spec.performanceHints": "Opt-in performance tweaks. AssumeNeededOnEveryNode programs the policy on every node even if no local endpoint matches yet.",
    "spec.namespaceSelector": "Restrict which namespaces this applies to.",
    "spec.applyOnForward": "Apply to forwarded traffic (host endpoints)."
  },
  "StagedNetworkPolicy": {
    "spec.stagedAction": {
      "description": "Set (preview this policy) or Delete (preview removing it). Defaults to Set.",
      "enum": [
        "Set",
        "Delete"
      ]
    },
    "spec.order": "Lower order = higher precedence.",
    "spec.selector": "Endpoints this policy applies to, e.g. all() or app == 'db'.",
    "spec.types": "Directions governed. Inferred from ingress/egress if omitted.",
    "spec.ingress.action": "What to do with matching traffic.",
    "spec.ingress.protocol": {
      "description": "Protocol name or IP protocol number.",
      "anyOf": [
        {
          "enum": [
            "TCP",
            "UDP",
            "ICMP",
            "ICMPv6",
            "SCTP",
            "UDPLite"
          ]
        },
        {
          "type": "integer",
          "minimum": 0,
          "maximum": 255
        }
      ]
    },
    "spec.ingress.notProtocol": {
      "description": "Protocol name or IP protocol number.",
      "anyOf": [
        {
          "enum": [
            "TCP",
            "UDP",
            "ICMP",
            "ICMPv6",
            "SCTP",
            "UDPLite"
          ]
        },
        {
          "type": "integer",
          "minimum": 0,
          "maximum": 255
        }
      ]
    },
    "spec.ingress.icmp": "Match specific ICMP type/code (requires protocol ICMP or ICMPv6).",
    "spec.ingress.ipVersion": "Restrict the rule to IPv4 (4) or IPv6 (6) traffic only.",
    "spec.ingress.source": "Match criteria for the source or destination of traffic.",
    "spec.ingress.source.selector": "Calico selector, e.g. app == 'frontend'.",
    "spec.ingress.source.namespaceSelector": "Selector over namespace labels.",
    "spec.ingress.source.nets": "CIDRs to match.",
    "spec.ingress.source.ports": "Ports: numbers, ranges (\"8080:8090\"), or named ports.",
    "spec.ingress.source.notPorts": "Ports: numbers, ranges (\"8080:8090\"), or named ports.",
    "spec.ingress.source.domains": {
      "type": "array",
      "items": {
        "type": "string"
      },
      "description": "FQDNs/wildcards (egress destination only)."
    },
    "spec.ingress.destination": "Match criteria for the source or destination of traffic.",
    "spec.ingress.destination.selector": "Calico selector, e.g. app == 'frontend'.",
    "spec.ingress.destination.namespaceSelector": "Selector over namespace labels.",
    "spec.ingress.destination.nets": "CIDRs to match.",
    "spec.ingress.destination.ports": "Ports: numbers, ranges (\"8080:8090\"), or named ports.",
    "spec.ingress.destination.notPorts": "Ports: numbers, ranges (\"8080:8090\"), or named ports.",
    "spec.ingress.destination.domains": {
      "type": "array",
      "items": {
        "type": "string"
      },
      "description": "FQDNs/wildcards (egress destination only)."
    },
    "spec.ingress.http": "HTTP match clause (ingress only).",
    "spec.ingress.metadata": "Per-rule metadata (does not affect matching).",
    "spec.ingress.metadata.annotations": "Free-form annotations attached to this rule.",
    "spec.egress.action": "What to do with matching traffic.",
    "spec.egress.protocol": {
      "description": "Protocol name or IP protocol number.",
      "anyOf": [
        {
          "enum": [
            "TCP",
            "UDP",
            "ICMP",
            "ICMPv6",
            "SCTP",
            "UDPLite"
          ]
        },
        {
          "type": "integer",
          "minimum": 0,
          "maximum": 255
        }
      ]
    },
    "spec.egress.notProtocol": {
      "description": "Protocol name or IP protocol number.",
      "anyOf": [
        {
          "enum": [
            "TCP",
            "UDP",
            "ICMP",
            "ICMPv6",
            "SCTP",
            "UDPLite"
          ]
        },
        {
          "type": "integer",
          "minimum": 0,
          "maximum": 255
        }
      ]
    },
    "spec.egress.icmp": "Match specific ICMP type/code (requires protocol ICMP or ICMPv6).",
    "spec.egress.ipVersion": "Restrict the rule to IPv4 (4) or IPv6 (6) traffic only.",
    "spec.egress.source": "Match criteria for the source or destination of traffic.",
    "spec.egress.source.selector": "Calico selector, e.g. app == 'frontend'.",
    "spec.egress.source.namespaceSelector": "Selector over namespace labels.",
    "spec.egress.source.nets": "CIDRs to match.",
    "spec.egress.source.ports": "Ports: numbers, ranges (\"8080:8090\"), or named ports.",
    "spec.egress.source.notPorts": "Ports: numbers, ranges (\"8080:8090\"), or named ports.",
    "spec.egress.source.domains": {
      "type": "array",
      "items": {
        "type": "string"
      },
      "description": "FQDNs/wildcards (egress destination only)."
    },
    "spec.egress.destination": "Match criteria for the source or destination of traffic.",
    "spec.egress.destination.selector": "Calico selector, e.g. app == 'frontend'.",
    "spec.egress.destination.namespaceSelector": "Selector over namespace labels.",
    "spec.egress.destination.nets": "CIDRs to match.",
    "spec.egress.destination.ports": "Ports: numbers, ranges (\"8080:8090\"), or named ports.",
    "spec.egress.destination.notPorts": "Ports: numbers, ranges (\"8080:8090\"), or named ports.",
    "spec.egress.destination.domains": {
      "type": "array",
      "items": {
        "type": "string"
      },
      "description": "FQDNs/wildcards (egress destination only)."
    },
    "spec.egress.http": "HTTP match clause (ingress only).",
    "spec.egress.metadata": "Per-rule metadata (does not affect matching).",
    "spec.egress.metadata.annotations": "Free-form annotations attached to this rule.",
    "spec.performanceHints": "Opt-in performance tweaks. AssumeNeededOnEveryNode programs the policy on every node even if no local endpoint matches yet."
  },
  "StagedGlobalNetworkPolicy": {
    "spec.stagedAction": {
      "description": "Set (preview this policy) or Delete (preview removing it). Defaults to Set.",
      "enum": [
        "Set",
        "Delete"
      ]
    },
    "spec.order": "Lower order = higher precedence.",
    "spec.selector": "Endpoints this policy applies to, e.g. all() or app == 'db'.",
    "spec.types": "Directions governed. Inferred from ingress/egress if omitted.",
    "spec.ingress.action": "What to do with matching traffic.",
    "spec.ingress.protocol": {
      "description": "Protocol name or IP protocol number.",
      "anyOf": [
        {
          "enum": [
            "TCP",
            "UDP",
            "ICMP",
            "ICMPv6",
            "SCTP",
            "UDPLite"
          ]
        },
        {
          "type": "integer",
          "minimum": 0,
          "maximum": 255
        }
      ]
    },
    "spec.ingress.notProtocol": {
      "description": "Protocol name or IP protocol number.",
      "anyOf": [
        {
          "enum": [
            "TCP",
            "UDP",
            "ICMP",
            "ICMPv6",
            "SCTP",
            "UDPLite"
          ]
        },
        {
          "type": "integer",
          "minimum": 0,
          "maximum": 255
        }
      ]
    },
    "spec.ingress.icmp": "Match specific ICMP type/code (requires protocol ICMP or ICMPv6).",
    "spec.ingress.ipVersion": "Restrict the rule to IPv4 (4) or IPv6 (6) traffic only.",
    "spec.ingress.source": "Match criteria for the source or destination of traffic.",
    "spec.ingress.source.selector": "Calico selector, e.g. app == 'frontend'.",
    "spec.ingress.source.namespaceSelector": "Selector over namespace labels.",
    "spec.ingress.source.nets": "CIDRs to match.",
    "spec.ingress.source.ports": "Ports: numbers, ranges (\"8080:8090\"), or named ports.",
    "spec.ingress.source.notPorts": "Ports: numbers, ranges (\"8080:8090\"), or named ports.",
    "spec.ingress.source.domains": {
      "type": "array",
      "items": {
        "type": "string"
      },
      "description": "FQDNs/wildcards (egress destination only)."
    },
    "spec.ingress.destination": "Match criteria for the source or destination of traffic.",
    "spec.ingress.destination.selector": "Calico selector, e.g. app == 'frontend'.",
    "spec.ingress.destination.namespaceSelector": "Selector over namespace labels.",
    "spec.ingress.destination.nets": "CIDRs to match.",
    "spec.ingress.destination.ports": "Ports: numbers, ranges (\"8080:8090\"), or named ports.",
    "spec.ingress.destination.notPorts": "Ports: numbers, ranges (\"8080:8090\"), or named ports.",
    "spec.ingress.destination.domains": {
      "type": "array",
      "items": {
        "type": "string"
      },
      "description": "FQDNs/wildcards (egress destination only)."
    },
    "spec.ingress.http": "HTTP match clause (ingress only).",
    "spec.ingress.metadata": "Per-rule metadata (does not affect matching).",
    "spec.ingress.metadata.annotations": "Free-form annotations attached to this rule.",
    "spec.egress.action": "What to do with matching traffic.",
    "spec.egress.protocol": {
      "description": "Protocol name or IP protocol number.",
      "anyOf": [
        {
          "enum": [
            "TCP",
            "UDP",
            "ICMP",
            "ICMPv6",
            "SCTP",
            "UDPLite"
          ]
        },
        {
          "type": "integer",
          "minimum": 0,
          "maximum": 255
        }
      ]
    },
    "spec.egress.notProtocol": {
      "description": "Protocol name or IP protocol number.",
      "anyOf": [
        {
          "enum": [
            "TCP",
            "UDP",
            "ICMP",
            "ICMPv6",
            "SCTP",
            "UDPLite"
          ]
        },
        {
          "type": "integer",
          "minimum": 0,
          "maximum": 255
        }
      ]
    },
    "spec.egress.icmp": "Match specific ICMP type/code (requires protocol ICMP or ICMPv6).",
    "spec.egress.ipVersion": "Restrict the rule to IPv4 (4) or IPv6 (6) traffic only.",
    "spec.egress.source": "Match criteria for the source or destination of traffic.",
    "spec.egress.source.selector": "Calico selector, e.g. app == 'frontend'.",
    "spec.egress.source.namespaceSelector": "Selector over namespace labels.",
    "spec.egress.source.nets": "CIDRs to match.",
    "spec.egress.source.ports": "Ports: numbers, ranges (\"8080:8090\"), or named ports.",
    "spec.egress.source.notPorts": "Ports: numbers, ranges (\"8080:8090\"), or named ports.",
    "spec.egress.source.domains": {
      "type": "array",
      "items": {
        "type": "string"
      },
      "description": "FQDNs/wildcards (egress destination only)."
    },
    "spec.egress.destination": "Match criteria for the source or destination of traffic.",
    "spec.egress.destination.selector": "Calico selector, e.g. app == 'frontend'.",
    "spec.egress.destination.namespaceSelector": "Selector over namespace labels.",
    "spec.egress.destination.nets": "CIDRs to match.",
    "spec.egress.destination.ports": "Ports: numbers, ranges (\"8080:8090\"), or named ports.",
    "spec.egress.destination.notPorts": "Ports: numbers, ranges (\"8080:8090\"), or named ports.",
    "spec.egress.destination.domains": {
      "type": "array",
      "items": {
        "type": "string"
      },
      "description": "FQDNs/wildcards (egress destination only)."
    },
    "spec.egress.http": "HTTP match clause (ingress only).",
    "spec.egress.metadata": "Per-rule metadata (does not affect matching).",
    "spec.egress.metadata.annotations": "Free-form annotations attached to this rule.",
    "spec.performanceHints": "Opt-in performance tweaks. AssumeNeededOnEveryNode programs the policy on every node even if no local endpoint matches yet.",
    "spec.namespaceSelector": "Restrict which namespaces this applies to.",
    "spec.applyOnForward": "Apply to forwarded traffic (host endpoints)."
  },
  "StagedKubernetesNetworkPolicy": {
    "spec.stagedAction": {
      "description": "Set (preview this policy) or Delete (preview removing it). Defaults to Set.",
      "enum": [
        "Set",
        "Delete"
      ]
    },
    "spec.podSelector": {
      "title": "Label selector",
      "description": "Pods this policy applies to. Empty {} selects all pods in the namespace."
    },
    "spec.podSelector.matchLabels": "Map of {key: value}; all must match (AND).",
    "spec.podSelector.matchExpressions.operator": {
      "enum": [
        "In",
        "NotIn",
        "Exists",
        "DoesNotExist"
      ]
    },
    "spec.policyTypes": "Which directions this policy governs. Inferred if omitted.",
    "spec.ingress.from.podSelector": {
      "title": "Label selector",
      "description": "A Kubernetes label selector. Empty selects everything in scope."
    },
    "spec.ingress.from.podSelector.matchLabels": "Map of {key: value}; all must match (AND).",
    "spec.ingress.from.podSelector.matchExpressions.operator": {
      "enum": [
        "In",
        "NotIn",
        "Exists",
        "DoesNotExist"
      ]
    },
    "spec.ingress.from.namespaceSelector": {
      "title": "Label selector",
      "description": "A Kubernetes label selector. Empty selects everything in scope."
    },
    "spec.ingress.from.namespaceSelector.matchLabels": "Map of {key: value}; all must match (AND).",
    "spec.ingress.from.namespaceSelector.matchExpressions.operator": {
      "enum": [
        "In",
        "NotIn",
        "Exists",
        "DoesNotExist"
      ]
    },
    "spec.ingress.from.ipBlock.cidr": "CIDR, e.g. 10.0.0.0/16.",
    "spec.ingress.ports.protocol": {
      "description": "Defaults to TCP.",
      "enum": [
        "TCP",
        "UDP",
        "SCTP"
      ]
    },
    "spec.ingress.ports.port": "Numeric port or named port from the pod spec.",
    "spec.ingress.ports.endPort": "End of a port range (with port as start).",
    "spec.egress.to.podSelector": {
      "title": "Label selector",
      "description": "A Kubernetes label selector. Empty selects everything in scope."
    },
    "spec.egress.to.podSelector.matchLabels": "Map of {key: value}; all must match (AND).",
    "spec.egress.to.podSelector.matchExpressions.operator": {
      "enum": [
        "In",
        "NotIn",
        "Exists",
        "DoesNotExist"
      ]
    },
    "spec.egress.to.namespaceSelector": {
      "title": "Label selector",
      "description": "A Kubernetes label selector. Empty selects everything in scope."
    },
    "spec.egress.to.namespaceSelector.matchLabels": "Map of {key: value}; all must match (AND).",
    "spec.egress.to.namespaceSelector.matchExpressions.operator": {
      "enum": [
        "In",
        "NotIn",
        "Exists",
        "DoesNotExist"
      ]
    },
    "spec.egress.to.ipBlock.cidr": "CIDR, e.g. 10.0.0.0/16.",
    "spec.egress.ports.protocol": {
      "description": "Defaults to TCP.",
      "enum": [
        "TCP",
        "UDP",
        "SCTP"
      ]
    },
    "spec.egress.ports.port": "Numeric port or named port from the pod spec.",
    "spec.egress.ports.endPort": "End of a port range (with port as start)."
  },
  "Tier": {
    "spec.order": "Tier precedence; lower = higher precedence.",
    "spec.defaultAction": {
      "description": "Action for traffic not matched by any policy in this tier (default: Deny).",
      "enum": [
        "Deny",
        "Pass"
      ]
    }
  },
  "HostEndpoint": {
    "spec.node": "Name of the node this host endpoint is on.",
    "spec.interfaceName": "Host interface name (e.g. eth0), or '*' for all interfaces.",
    "spec.expectedIPs": "IPs expected on this interface; used to match traffic.",
    "spec.profiles": "Profiles applied to this endpoint.",
    "spec.ports": "Named ports exposed on this endpoint.",
    "spec.ports.protocol": {
      "enum": [
        "TCP",
        "UDP",
        "SCTP"
      ]
    }
  }
};
