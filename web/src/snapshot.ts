// Snapshot-file ingestion. The harness's snapshot-cni.py emits topology
// dumps in the shape stored under ../../workloads/{calico,k8s}-snapshot.json:
//
//   {
//     "_meta":     { plugin, context, generated_at, regenerate_with },
//     "namespaces": [{ name, labels }],
//     "endpoints":  [{ id, namespace, app, pod, ip, labels, probe_source? }]
//   }
//
// The editor's Endpoint shape uses `name` rather than `app`, doesn't track
// `pod` / `probe_source`, and ignores `_meta`. parseSnapshot bridges the two
// so the user can drop one of those files (or any export in the same shape)
// straight into the editor and see how their policies behave against the
// real cluster's topology.

import { Endpoint, EndpointPort, NamespaceInput, NodeInfo, Resources } from './api';

interface SnapshotEndpoint {
  id?: string;
  namespace?: string;
  // Either may be set; the snapshot uses app for the user-friendly short
  // name and pod for the actual k8s pod (with the replicaset hash). The
  // editor's `name` is conceptually the short name, so app wins when both
  // are present.
  app?: string;
  pod?: string;
  name?: string;       // tolerated for editor-native exports
  ip?: string;
  labels?: Record<string, string>;
  // Optional engine extensions - carried through verbatim when present.
  ports?: EndpointPort[];
  serviceAccountName?: string;
  node?: string;
  // unpoliced marks an unprotected host node (no HostEndpoint); the harness
  // sets it on host stubs so the engine leaves their own traffic unconditionally
  // allowed. Carried through verbatim so a dropped snapshot keeps that posture.
  unpoliced?: boolean;
  // probe_source is a harness-side hint about whether the pod can be exec'd
  // into for cluster-mode probes. The editor doesn't run real probes, so we
  // just drop it.
  probe_source?: boolean;
}

interface SnapshotNamespace {
  name?: string;
  labels?: Record<string, string>;
}

export interface ParsedSnapshot {
  namespaces: NamespaceInput[];
  endpoints: Endpoint[];
  /** Optional engine resources carried by the snapshot (host endpoints,
   *  network sets, …). Empty when the snapshot only has pods. */
  resources: Resources;
  /** k8s nodes the snapshot captured (top-level nodes[]). Lets the node-grouped
   *  graph box pod-less nodes; empty when the snapshot omits them. */
  nodes: NodeInfo[];
  dns?: Record<string, string[]>;
  /** Free-form summary for the toolbar status line. */
  summary: string;
}

export function parseSnapshot(text: string): ParsedSnapshot {
  const blob = JSON.parse(text);
  if (typeof blob !== 'object' || blob === null) {
    throw new Error('snapshot must be a JSON object');
  }
  const rawNs: SnapshotNamespace[] = Array.isArray(blob.namespaces) ? blob.namespaces : [];
  const rawEp: SnapshotEndpoint[] = Array.isArray(blob.endpoints) ? blob.endpoints : [];

  if (rawNs.length === 0 && rawEp.length === 0) {
    throw new Error('snapshot has no namespaces or endpoints');
  }

  const namespaces: NamespaceInput[] = rawNs
    .map((n) => ({ name: (n.name ?? '').trim(), labels: n.labels ?? {} }))
    .filter((n) => n.name);

  let skipped = 0;
  const endpoints: Endpoint[] = [];
  for (const e of rawEp) {
    const namespace = (e.namespace ?? '').trim();
    const name = (e.name ?? e.app ?? e.pod ?? '').trim();
    const ip = (e.ip ?? '').trim();
    if (!namespace || !name || !ip) {
      skipped++;
      continue;
    }
    endpoints.push({
      id: e.id?.trim() || `${namespace}/${name}`,
      namespace,
      name,
      ip,
      labels: e.labels ?? {},
      ...(e.ports ? { ports: e.ports } : {}),
      ...(e.serviceAccountName ? { serviceAccountName: e.serviceAccountName } : {}),
      ...(e.node ? { node: e.node } : {}),
      ...(e.unpoliced ? { unpoliced: true } : {}),
    });
  }

  // Auto-derive any namespace that's referenced by an endpoint but missing
  // from the snapshot's namespaces[] - k8s-snapshot.json sometimes omits
  // system-pod namespaces. We give them just kubernetes.io/metadata.name so
  // namespaceSelector rules in the policies still resolve.
  const haveNs = new Set(namespaces.map((n) => n.name));
  for (const ep of endpoints) {
    if (!haveNs.has(ep.namespace)) {
      namespaces.push({
        name: ep.namespace,
        labels: { 'kubernetes.io/metadata.name': ep.namespace },
      });
      haveNs.add(ep.namespace);
    }
  }

  // Carry through any optional resources the snapshot includes (the harness
  // and the editor's own /v1/topology emit these alongside endpoints).
  const resources: Resources = {};
  const resourceKeys: (keyof Resources)[] = [
    'serviceAccounts',
    'hostEndpoints',
    'networkSets',
    'globalNetworkSets',
    'services',
    'endpointSlices',
  ];
  let resourceCount = 0;
  for (const k of resourceKeys) {
    const v = (blob as Record<string, unknown>)[k];
    if (Array.isArray(v) && v.length) {
      (resources as Record<string, unknown>)[k] = v;
      resourceCount += v.length;
    }
  }
  // Top-level nodes[] - keep only entries with a name; the rest is optional.
  const nodes: NodeInfo[] = (Array.isArray(blob.nodes) ? blob.nodes : [])
    .map((n: Partial<NodeInfo>) => ({
      name: (n.name ?? '').trim(),
      ...(n.ip ? { ip: n.ip } : {}),
      ...(n.interfaceName ? { interfaceName: n.interfaceName } : {}),
      ...(n.labels ? { labels: n.labels } : {}),
    }))
    .filter((n: NodeInfo) => n.name);

  const dns =
    blob.dns && typeof blob.dns === 'object'
      ? (blob.dns as Record<string, string[]>)
      : undefined;

  const meta = (blob._meta ?? {}) as { plugin?: string; context?: string };
  const parts: string[] = [];
  if (meta.plugin) parts.push(`${meta.plugin}`);
  if (meta.context) parts.push(meta.context);
  parts.push(`${namespaces.length} ns`, `${endpoints.length} pods`);
  if (resourceCount) parts.push(`${resourceCount} resources`);
  if (nodes.length) parts.push(`${nodes.length} nodes`);
  if (skipped) parts.push(`${skipped} skipped`);

  return { namespaces, endpoints, resources, nodes, dns, summary: parts.join(' · ') };
}
