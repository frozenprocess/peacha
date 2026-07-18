// Single source of truth for "which Calico resources exist" - the analogue of
// tierModel.ts, but for the typed engine resources (host endpoints, network
// sets, global network sets, service accounts, services).
//
// A resource can reach the editor two ways: TYPED via the Resources tab
// (request.hostEndpoints, request.networkSets, …) or PASTED as a k8s/Calico
// manifest in the policy editor (which the backend engine reads from the policy
// stream). Before this module the views only knew about the typed fields, so a
// pasted `kind: HostEndpoint` was evaluated by the engine yet rendered nowhere.
// Parsing the pasted docs here and merging them with the typed fields lets every
// surface - the graph, the matrix, the Resources tab - agree on the full set.
//
// Pure data + YAML parsing, no React. Pasted resources are display-only as far
// as the engine request is concerned: they already reach the engine through the
// policy stream, so callers must NOT re-inject them into request.* (that would
// double-feed). Use these helpers to DISPLAY the union, not to build the wire
// request.

import { parse } from 'yaml';
import {
  GlobalNetworkSetInput,
  HostEndpointInput,
  NetworkSetInput,
  PolicyInput,
  ServiceAccountInput,
  ServiceInput,
  ServicePort,
} from './api';

// Resource kinds the engine accepts pasted alongside policies (mirrors the
// switch in calico-engine/engine/feed.go + the ServiceAccount/Service handling
// in applyInlineResources). Tiers are handled separately (tierModel).
export interface PastedResources {
  hostEndpoints: HostEndpointInput[];
  networkSets: NetworkSetInput[];
  globalNetworkSets: GlobalNetworkSetInput[];
  serviceAccounts: ServiceAccountInput[];
  services: ServiceInput[];
}

// parsePastedResources extracts the resource manifests from the policy stream,
// mapping each into the same typed input shape the Resources tab edits - so a
// pasted resource is interchangeable with a typed one for display. Invalid or
// partial docs (mid-edit) and unnamed resources are skipped, mirroring
// tierModel's parsers.
export function parsePastedResources(policies: PolicyInput[]): PastedResources {
  const out: PastedResources = {
    hostEndpoints: [],
    networkSets: [],
    globalNetworkSets: [],
    serviceAccounts: [],
    services: [],
  };
  for (const p of policies) {
    let doc: any;
    try {
      doc = parse(p.yaml);
    } catch {
      continue;
    }
    if (!doc || typeof doc !== 'object') continue;
    const kind: string = typeof doc.kind === 'string' ? doc.kind : '';
    const meta = (doc.metadata ?? {}) as Record<string, any>;
    const spec = (doc.spec ?? {}) as Record<string, any>;
    const name: string = typeof meta.name === 'string' ? meta.name : '';
    if (!name) continue;
    const labels = (meta.labels ?? undefined) as Record<string, string> | undefined;

    switch (kind) {
      case 'HostEndpoint':
        out.hostEndpoints.push({
          id: `host/${name}`,
          name,
          node: typeof spec.node === 'string' ? spec.node : undefined,
          interfaceName: typeof spec.interfaceName === 'string' ? spec.interfaceName : undefined,
          expectedIPs: Array.isArray(spec.expectedIPs) ? spec.expectedIPs.map(String) : [],
          labels,
        });
        break;
      case 'NetworkSet':
        out.networkSets.push({
          name,
          namespace: typeof meta.namespace === 'string' ? meta.namespace : 'default',
          nets: Array.isArray(spec.nets) ? spec.nets.map(String) : [],
          labels,
        });
        break;
      case 'GlobalNetworkSet':
        out.globalNetworkSets.push({
          name,
          nets: Array.isArray(spec.nets) ? spec.nets.map(String) : [],
          labels,
        });
        break;
      case 'ServiceAccount':
        out.serviceAccounts.push({
          name,
          namespace: typeof meta.namespace === 'string' ? meta.namespace : 'default',
          labels,
        });
        break;
      case 'Service':
        out.services.push({
          name,
          namespace: typeof meta.namespace === 'string' ? meta.namespace : 'default',
          selector: (spec.selector ?? undefined) as Record<string, string> | undefined,
          ports: Array.isArray(spec.ports) ? spec.ports.map(toServicePort) : undefined,
        });
        break;
      default:
        break; // policies, tiers, and unknown kinds are not our concern
    }
  }
  return out;
}

function toServicePort(p: any): ServicePort {
  return {
    name: typeof p?.name === 'string' ? p.name : undefined,
    port: typeof p?.port === 'number' ? p.port : Number(p?.port) || 0,
    protocol: typeof p?.protocol === 'string' ? p.protocol : undefined,
    targetPort: p?.targetPort != null ? String(p.targetPort) : undefined,
  };
}

// mergeHostEndpoints unions the typed host endpoints with the pasted ones,
// deduped by id ("host/<name>"); a typed HEP wins a name collision (it's the
// editable one). The result is what the graph/matrix render as host/<name>
// rows/cols, so a pasted HEP shows up exactly like a typed one. Engine-bound
// requests must keep sending only the typed list - pasted HEPs reach the engine
// through the policy stream.
export function mergeHostEndpoints(
  typed: HostEndpointInput[],
  pasted: HostEndpointInput[],
): HostEndpointInput[] {
  const byId = new Map<string, HostEndpointInput>();
  for (const h of pasted) byId.set(h.id, h);
  for (const h of typed) byId.set(h.id, h); // typed wins
  return [...byId.values()];
}
