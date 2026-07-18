// Pure transform: (endpoints, response, ui-filters) -> (nodes, edges) for
// React Flow. No layout positions yet - useElkLayout assigns those.
//
// Two grouping modes (groupBy):
//   - 'namespace' (default): one "nsGroup" box per namespace; pods parented to
//     it. Hosts and external endpoints are NOT namespaced, so they render in
//     zone boxes ("cluster hosts" with HEP bands / "internet"), reusing node
//     mode's chrome.
//   - 'node': one "nodeGroup" box per k8s node; pods parented to their node (or
//     an `unscheduled` box). HEPs render as a firewall "hepNode" band on their
//     node; external endpoints get a dedicated internet zone.
//
// Decluttering: a default-allow cluster's matrix is ~N² allows - a hairball.
// Three levers tame it (all via GraphInput):
//   - edgeMode 'select' (default): draw edges only for the focused node (click
//     to pin, hover to peek); 'all' = every flow; 'off' = none.
//   - hideSystem: drop the dimmed baseline pods (the biggest fan-out source).
//   - emphasizeNonDefault: fade plain allows to hairlines and surface the
//     signal - denies (red), cross-node + external (amber).
//
// LAYOUT vs RENDER edges are separate. ELK lays out using a STABLE skeleton
// (all allows among visible nodes), independent of selection/hover/edgeMode, so
// focusing a node never relayouts the graph. The rendered edge set is the
// filtered/styled subset. Only mixed pairs are labelled and animate (marching
// ants) to flag "probes disagree"; everything else is static (perf).

import { MarkerType, type Edge, type Node } from '@xyflow/react';
import { ACTION_COLOR } from '../actionColors';
import { EditorResponse, Endpoint, HostEndpointInput, NodeInfo, PolicyInput, Probe, TierInput, TierMatchResponse } from '../api';
import { portStatusFor, probeIndex } from '../impact';
import { GroupBy, EdgeMode } from '../state';
import { Access } from './nodes/Globe';
import { buildTierGraph } from './tiers';

// Allow/deny edge colours come from the single action palette (actionColors.ts)
// so the graph, the tier policy-card borders, and the tier footer all agree.
// Cross-node/external amber is NOT an action - it's a topology signal - so it
// stays local.
export const ALLOW_COLOR = ACTION_COLOR.allow;
export const CROSS_NODE_COLOR = '#b07400';
export const DENY_COLOR = ACTION_COLOR.deny;
// Flows leaving the cluster (egress to the internet) - blue, dashed. Distinct
// from topology amber so "this left the cluster" reads at a glance.
export const EXTERNAL_COLOR = '#1a73e8';

// SINGLE SOURCE OF TRUTH for every edge's visual identity. Both edge builders
// below and the graph legend (Graph.tsx <Legend>) read from here, so the key
// can never drift from what's actually drawn. color/dash/animated define the
// arrow's look; label/title feed the legend. Widths/opacity stay in the
// builders - they're layout tuning the legend doesn't show.
export const EDGE_STYLES = {
  allow: { color: ALLOW_COLOR, label: 'allow', title: 'allowed flow' },
  deny: { color: DENY_COLOR, label: 'deny', title: "explicitly denied flow (shown when 'emphasize' is on)" },
  mixed: {
    color: DENY_COLOR, // arrowhead + n/m label (the LINE is the bicolor pair below)
    colors: [ALLOW_COLOR, DENY_COLOR], // interleaved green (allow) + red (deny) marching dashes
    dash: '6 6', // equal dash/gap so the two colours tile without overlap
    label: 'mixed',
    title: 'probes disagree on this pair - interleaved green/red marching dashes; the n/m label is how many of the visible probes allowed',
  },
  crossNode: { color: CROSS_NODE_COLOR, label: 'cross-node', title: 'amber solid = host↔host traffic (both ends are host endpoints)' },
  external: { color: EXTERNAL_COLOR, dash: '5 3', label: 'internet', title: 'blue dashed = a flow leaving the cluster' },
} as const;

// Stacking layers: group boxes UNDER edges UNDER pods/HEP bands. Edges above
// the (translucent) group boxes so a flow crossing the inter-pod space reads
// clearly; below the endpoints so an arc tucks beneath the IN/OUT connector
// boxes (part of the pod/HEP node) rather than painting over them. Selected
// nodes get React Flow's +1000 elevation, so they still sit above edges.
const Z_GROUP = 0;
const Z_EDGE = 1;
const Z_ENDPOINT = 2;

// Sentinel group keys ('#'-prefixed; can't appear in a DNS-1123 node name).
const UNSCHEDULED = '#unscheduled';
const EXTERNAL = '#external';

export interface GraphInput {
  endpoints: Endpoint[];
  systemIds: Set<string>;        // baseline pods - dimmed, hidable
  externalIds: Set<string>;      // off-cluster endpoints - tagged [EXT]
  hostIds: Set<string>;          // host endpoints (HEP or unpoliced host) - bands
  unprotectedIds: Set<string>;   // host endpoints with no HEP (unpoliced, [HOST])
  response: EditorResponse | null;
  probes: Probe[];               // probe defs - maps a declared port to its
                                 // matrix so a pod can show per-port open/closed
  selected: string | null;       // pinned node (selection ring)
  edgeFocus: string | null;      // node whose edges to show in 'select' mode
                                 // (= selected, or hovered when nothing pinned)
  visibleProbes: Set<string>;    // legend toggles
  groupBy: GroupBy;
  edgeMode: EdgeMode;            // all | select | off
  hideSystem: boolean;
  emphasizeNonDefault: boolean;
  nodes: NodeInfo[];             // known k8s nodes (incl. pod-less ones)
  hostEndpoints: HostEndpointInput[]; // HEP -> node mapping + identity
  hostNodeIds: Map<string, string>; // node name -> synthesized unpoliced host id
  policies: PolicyInput[];       // raw policy docs - tier view parses these
  tiers: TierInput[];            // user-defined tiers (name/order/defaultAction)
  tierMatches: TierMatchResponse | null; // engine per-endpoint matches (tier view)
}

export interface BuiltGraph {
  nodes: Node[];
  edges: Edge[];        // rendered (filtered + styled)
  layoutEdges: Edge[];  // stable skeleton for ELK only
}

export function buildGraph(input: GraphInput): BuiltGraph {
  if (input.groupBy === 'tier')
    return buildTierGraph(
      input.policies,
      input.tiers,
      input.selected,
      input.tierMatches,
      // Endpoint id -> labels, so tier tooltips can show "prod/backend
      // (app=backend)" - the SPA already holds the labels it sent the engine.
      new Map(
        [...input.endpoints, ...input.hostEndpoints].map((e) => [e.id, e.labels ?? {}]),
      ),
    );
  const g = input.groupBy === 'node' ? buildByNode(input) : buildByNamespace(input);
  // Stamp the node stacking layer in one place: endpoints above edges, group
  // boxes below. (Edges carry Z_EDGE in buildEdges/routed.)
  for (const n of g.nodes) {
    n.zIndex = n.type === 'podNode' || n.type === 'hepNode' ? Z_ENDPOINT : Z_GROUP;
  }
  return g;
}

// --- internet access -------------------------------------------------------

// internetAccess maps each non-external endpoint id to whether it can egress to
// ANY external endpoint on a currently-visible probe (matrix src→ext == allow).
// Empty when there are no external endpoints - then no globe is shown at all.
function internetAccess(input: GraphInput): Map<string, boolean> {
  const { response, visibleProbes, externalIds } = input;
  const m = new Map<string, boolean>();
  if (!response || externalIds.size === 0) return m;
  for (const [probe, matrix] of Object.entries(response.matrices)) {
    if (!visibleProbes.has(probe)) continue;
    for (const [pair, result] of Object.entries(matrix)) {
      const [src, dst] = pair.split('->');
      if (!externalIds.has(dst) || externalIds.has(src)) continue;
      if (!m.has(src)) m.set(src, false);
      if (result === 'allow') m.set(src, true);
    }
  }
  return m;
}

// groupAccess aggregates a group's members: all reach → true, none reach →
// false, a mix → 'partial'. undefined when no member has a known value (so the
// group shows no globe).
function groupAccess(ids: string[], access: Map<string, boolean>): Access | undefined {
  const vals = ids.map((id) => access.get(id)).filter((v): v is boolean => v !== undefined);
  if (vals.length === 0) return undefined;
  if (vals.every((v) => v)) return true;
  if (vals.every((v) => !v)) return false;
  return 'partial';
}

// --- shared scaffolding ------------------------------------------------------

// Everything BOTH grouping modes must derive identically: endpoint visibility,
// endpoint→node placement, cross-node detection, internet access, and the
// pod/HEP React Flow `data` payloads. The views consume this instead of
// re-deriving any of it, so a pod or HEP band can't show different badges,
// colours, or cross-node state depending on the view.
function scaffolding(input: GraphInput) {
  const { systemIds, externalIds, unprotectedIds, selected, hideSystem } = input;
  const endpoints = visibleEndpoints(input.endpoints, systemIds, hideSystem);
  const access = internetAccess(input);
  const probeByKey = probeIndex(input.probes);
  // node-of-id for EVERY engine endpoint (incl. hidden system / unpoliced
  // hosts) so cross-node detection is accurate regardless of hideSystem.
  // HEPs resolve via their HostEndpoint's node.
  const hepNode = new Map(input.hostEndpoints.map((h) => [h.id, h.node ?? '']));
  const nodeById = new Map(
    input.endpoints.map((ep) => [ep.id, hepNode.get(ep.id) ?? ep.node ?? '']),
  );
  const crossNode = (src: string, dst: string): boolean => {
    const a = nodeById.get(src);
    const b = nodeById.get(dst);
    return !!a && !!b && a !== b;
  };
  const peersOf = crossPeersOf(input, nodeById);
  const podData = (ep: Endpoint) => ({
    label: ep.name,
    labels: ep.labels,
    selected: ep.id === selected,
    system: systemIds.has(ep.id),
    external: externalIds.has(ep.id),
    internet: access.get(ep.id),
    crossNodes: peersOf(ep.id),
    ports: portStatusFor(input.response, ep, probeByKey),
  });
  const hepData = (ep: Endpoint) => ({
    label: ep.name,
    selected: ep.id === selected,
    system: systemIds.has(ep.id),
    unprotected: unprotectedIds.has(ep.id),
    internet: access.get(ep.id),
    crossNodes: peersOf(ep.id),
  });
  return { endpoints, access, nodeById, crossNode, podData, hepData };
}

// --- namespace mode --------------------------------------------------------

function buildByNamespace(input: GraphInput): BuiltGraph {
  const { systemIds, externalIds, hostIds, unprotectedIds } = input;
  const { endpoints, access, crossNode, podData, hepData } = scaffolding(input);
  // Hosts and external endpoints are NOT namespaced - rendering them in a
  // namespace box misstates the model. They get the same zone chrome node
  // mode uses: HEP bands in a "cluster hosts" box, pods in an "internet" box.
  const podEps = endpoints.filter((e) => !hostIds.has(e.id) && !externalIds.has(e.id));
  const hostEps = endpoints.filter((e) => hostIds.has(e.id));
  const extEps = endpoints.filter((e) => externalIds.has(e.id) && !hostIds.has(e.id));
  const namespaces = Array.from(new Set(podEps.map((e) => e.namespace)));
  const systemNamespaces = new Set(
    podEps.filter((e) => systemIds.has(e.id)).map((e) => e.namespace),
  );

  const groups: Node[] = namespaces.map((ns) => ({
    id: `ns:${ns}`,
    type: 'nsGroup',
    data: {
      label: ns,
      system: systemNamespaces.has(ns),
      external: false,
      internet: groupAccess(
        podEps.filter((e) => e.namespace === ns).map((e) => e.id),
        access,
      ),
    },
    position: { x: 0, y: 0 },
    style: { width: 240, height: 160 },
    selectable: false,
    draggable: false,
  }));
  if (hostEps.length > 0) {
    groups.push({
      id: 'zone:hosts',
      type: 'nodeGroup',
      data: {
        zone: 'hosts',
        label: 'cluster hosts',
        heps: hostEps
          .filter((e) => !unprotectedIds.has(e.id))
          .map((e) => ({ id: e.id, name: e.name, system: systemIds.has(e.id) })),
        unprotected: hostEps.some((e) => unprotectedIds.has(e.id)),
        unscheduled: false,
        external: false,
        system: hostEps.every((e) => systemIds.has(e.id)),
        internet: groupAccess(hostEps.map((e) => e.id), access),
      },
      position: { x: 0, y: 0 },
      style: { width: 240, height: 160 },
      selectable: false,
      draggable: false,
    });
  }
  if (extEps.length > 0) {
    groups.push({
      id: 'zone:internet',
      type: 'nodeGroup',
      data: {
        label: 'internet',
        heps: [],
        unprotected: false,
        unscheduled: false,
        external: true,
        system: false,
      },
      position: { x: 0, y: 0 },
      style: { width: 240, height: 160 },
      selectable: false,
      draggable: false,
    });
  }

  const pods: Node[] = [
    ...hostEps.map((ep) => ({
      id: ep.id,
      type: 'hepNode',
      parentId: 'zone:hosts',
      extent: 'parent' as const,
      position: { x: 0, y: 0 },
      data: hepData(ep),
    })),
    ...[...podEps, ...extEps].map((ep) => ({
      id: ep.id,
      type: 'podNode',
      parentId: externalIds.has(ep.id) ? 'zone:internet' : `ns:${ep.namespace}`,
      extent: 'parent' as const,
      position: { x: 0, y: 0 },
      data: podData(ep),
    })),
  ];

  const { render, layout } = buildEdges(input, new Set(endpoints.map((e) => e.id)), crossNode);
  return { nodes: [...groups, ...pods], edges: render, layoutEdges: layout };
}

// --- node mode -------------------------------------------------------------

function buildByNode(input: GraphInput): BuiltGraph {
  const { systemIds, externalIds, hostIds, nodes, hostEndpoints, hostNodeIds } = input;
  const { endpoints, access, nodeById, crossNode, podData, hepData } = scaffolding(input);

  // A node's internet posture is the HOST's, not its pods': the HEP(s) on the
  // node, or - when there's no HEP - the synthesized unpoliced host/<node>
  // endpoint (engine-evaluated, so a pod-only deny-all leaves it green). The
  // host ids resolve against the matrix-derived access map.
  const hostAccessForNode = (name: string): Access | undefined => {
    const onNode = hostEndpoints.filter((h) => (h.node ?? '') === name).map((h) => h.id);
    const syn = hostNodeIds.get(name);
    if (syn) onNode.push(syn);
    return groupAccess(onNode, access);
  };

  const nodeOf = (ep: Endpoint): string => nodeById.get(ep.id) ?? '';
  const groupOf = (ep: Endpoint): string =>
    externalIds.has(ep.id) ? EXTERNAL : nodeOf(ep) || UNSCHEDULED;

  const nodeNames = new Set<string>();
  for (const n of nodes) if (n.name) nodeNames.add(n.name);
  for (const ep of endpoints) {
    if (externalIds.has(ep.id)) continue;
    const n = nodeOf(ep);
    if (n) nodeNames.add(n);
  }
  const hasUnscheduled = endpoints.some((ep) => !externalIds.has(ep.id) && !nodeOf(ep));
  const hasExternal = endpoints.some((ep) => externalIds.has(ep.id));

  const hepNodes = new Set<string>();
  for (const h of hostEndpoints) if (h.node) hepNodes.add(h.node);

  const groupNames = [...nodeNames];
  if (hasUnscheduled) groupNames.push(UNSCHEDULED);
  if (hasExternal) groupNames.push(EXTERNAL);

  const groups: Node[] = groupNames.map((name) => {
    const unscheduled = name === UNSCHEDULED;
    const external = name === EXTERNAL;
    const real = !unscheduled && !external;
    const heps = real
      ? hostEndpoints
          .filter((h) => (h.node ?? '') === name)
          .map((h) => ({ id: h.id, name: h.name, system: systemIds.has(h.id) }))
      : [];
    const epsHere = endpoints.filter((e) => groupOf(e) === name);
    const allSystem = real && epsHere.length > 0 && epsHere.every((e) => systemIds.has(e.id));
    return {
      id: `node:${name}`,
      type: 'nodeGroup',
      data: {
        label: external ? 'internet' : unscheduled ? 'unscheduled' : name,
        heps,
        unprotected: real && !hepNodes.has(name),
        unscheduled,
        external,
        system: allSystem,
        // Real node: the host's posture (HEP / unpoliced host). Unscheduled box:
        // the pod aggregate (no host there). External zone: none.
        internet: real
          ? hostAccessForNode(name)
          : unscheduled
            ? groupAccess(epsHere.map((e) => e.id), access)
            : undefined,
      },
      position: { x: 0, y: 0 },
      style: { width: 240, height: 160 },
      selectable: false,
      draggable: false,
    };
  });

  // Namespace sub-groups: within each node box, pods nest by namespace
  // (node → namespace → pod) so the namespace reads as a box, not a chip. HEP
  // bands stay at the node level (host-scoped, not namespaced). The sub-group id
  // is keyed by (group, namespace) because a namespace spans multiple nodes.
  // Host endpoints (HEP pseudo-endpoints + synthesized unpoliced hosts) render
  // as node-level bands; everything else is a pod (nested by namespace).
  const pods = endpoints.filter((ep) => !hostIds.has(ep.id));
  const heps = endpoints.filter((ep) => hostIds.has(ep.id));
  const nsKey = (groupKey: string, ns: string) => `nsg:${groupKey}::${ns}`;

  const subSeen = new Set<string>();
  const subGroups: Node[] = [];
  for (const ep of pods) {
    const groupKey = groupOf(ep);
    const id = nsKey(groupKey, ep.namespace);
    if (subSeen.has(id)) continue;
    subSeen.add(id);
    const epsHere = pods.filter((e) => groupOf(e) === groupKey && e.namespace === ep.namespace);
    subGroups.push({
      id,
      type: 'nsGroup',
      parentId: `node:${groupKey}`,
      extent: 'parent',
      data: {
        label: ep.namespace,
        system: epsHere.every((e) => systemIds.has(e.id)),
        external: epsHere.every((e) => externalIds.has(e.id)),
        nested: true,
        internet: groupAccess(epsHere.map((e) => e.id), access),
      },
      position: { x: 0, y: 0 },
      style: { width: 180, height: 100 },
      selectable: false,
      draggable: false,
    });
  }

  const children: Node[] = [
    ...heps.map((ep) => ({
      id: ep.id,
      type: 'hepNode',
      parentId: `node:${groupOf(ep)}`,
      extent: 'parent' as const,
      position: { x: 0, y: 0 },
      data: hepData(ep),
    })),
    ...pods.map((ep) => ({
      id: ep.id,
      type: 'podNode',
      parentId: nsKey(groupOf(ep), ep.namespace),
      extent: 'parent' as const,
      position: { x: 0, y: 0 },
      data: podData(ep),
    })),
  ];

  const visibleIds = new Set(endpoints.map((e) => e.id));
  const { render, layout } = buildEdges(input, visibleIds, crossNode, true);

  // On focus in 'select' mode, draw the focused endpoint's ROUTED path instead
  // of a direct cross-node/external line: pod → its node's HEP → peer node's HEP
  // → peer (and HEP → internet). This mirrors Calico's real forward path -
  // verified against the engine - where cross-node + internet traffic transits
  // the node HEPs. The host band for a node is its HEP, or the synthesized
  // unpoliced host when it has none.
  const routed: Edge[] = [];
  if (input.edgeMode === 'select' && input.edgeFocus && input.response) {
    const focus = input.edgeFocus;
    const hostIdForNode = (n: string): string | undefined => {
      const hep = hostEndpoints.find((h) => (h.node ?? '') === n);
      const id = hep ? hep.id : hostNodeIds.get(n);
      return id && visibleIds.has(id) ? id : undefined;
    };
    const seen = new Set<string>();
    // A denied flow is dropped AT the host firewall, so its routed path reads as
    // red (matches the matrix deny cell); an allowed flow transits in amber. Deny
    // paths honour the same emphasizeNonDefault gate as buildEdges - without it,
    // a cross-node/external deny (e.g. an applyOnForward/preDNAT host firewall)
    // would be invisible in node mode: it draws no direct line (see buildEdges)
    // and isn't an allow, so nothing represented the block at all.
    const seg = (s: string, t: string, kind: 'spoke' | 'trunk' | 'ext', allow: boolean) => {
      const id = `R:${kind}:${s}>${t}`;
      if (s === t || seen.has(id) || !visibleIds.has(s) || !visibleIds.has(t)) return;
      seen.add(id);
      // Match buildEdges' topology vocabulary so a flow keeps its look across
      // views: trunk (HEP → HEP) = amber solid; ext (hop to the internet) = blue
      // dashed. A pod↔host spoke is ordinary traffic → green.
      const color = !allow
        ? EDGE_STYLES.deny.color
        : kind === 'spoke'
          ? EDGE_STYLES.allow.color
          : kind === 'ext'
            ? EDGE_STYLES.external.color
            : EDGE_STYLES.crossNode.color;
      routed.push({
        id,
        source: s,
        target: t,
        zIndex: Z_EDGE, // match buildEdges - routed paths layer the same way
        style: {
          stroke: color,
          strokeWidth: kind === 'trunk' ? 2.5 : 1.5,
          strokeOpacity: 0.9,
          ...(kind === 'ext' ? { strokeDasharray: EDGE_STYLES.external.dash } : {}),
        },
        markerEnd: { type: MarkerType.ArrowClosed, color, width: 14, height: 14 },
      });
    };
    for (const [probe, matrix] of Object.entries(input.response.matrices)) {
      if (!input.visibleProbes.has(probe)) continue;
      for (const [pair, result] of Object.entries(matrix)) {
        const allow = result === 'allow';
        if (!allow && !input.emphasizeNonDefault) continue;
        const [src, dst] = pair.split('->');
        if (src !== focus && dst !== focus) continue;
        const sExt = externalIds.has(src);
        const dExt = externalIds.has(dst);
        const sNode = nodeById.get(src);
        const dNode = nodeById.get(dst);
        if (dExt && !sExt && sNode) {
          const h = hostIdForNode(sNode);
          if (h) {
            seg(src, h, 'spoke', allow);
            seg(h, dst, 'ext', allow);
          }
        } else if (sExt && !dExt && dNode) {
          const h = hostIdForNode(dNode);
          if (h) {
            seg(src, h, 'ext', allow);
            seg(h, dst, 'spoke', allow);
          }
        } else if (sNode && dNode && sNode !== dNode) {
          const hs = hostIdForNode(sNode);
          const hd = hostIdForNode(dNode);
          if (hs && hd) {
            seg(src, hs, 'spoke', allow);
            seg(hs, hd, 'trunk', allow);
            seg(hd, dst, 'spoke', allow);
          }
        }
      }
    }
  }

  // Order matters for React Flow: a parent must precede its children. node
  // boxes → namespace sub-boxes → pods/HEP bands.
  return { nodes: [...groups, ...subGroups, ...children], edges: [...render, ...routed], layoutEdges: layout };
}

// --- edges -----------------------------------------------------------------

// buildEdges walks the matrices once and produces two sets:
//   layout - every allow among visible nodes (deduped), unstyled; feeds ELK so
//            the arrangement is stable regardless of what's currently rendered.
//   render - the styled subset the user sees, gated by edgeMode/edgeFocus and
//            (for denies) emphasizeNonDefault.
function buildEdges(
  input: GraphInput,
  visibleIds: Set<string>,
  crossNode?: (src: string, dst: string) => boolean,
  // true in node mode: cross-node/external flows draw no direct line there
  // (they become ⇄/🌐 badges + routed paths through the HEP bands instead).
  routedElsewhere = false,
): { render: Edge[]; layout: Edge[] } {
  const { response, visibleProbes, selected, edgeFocus, edgeMode, emphasizeNonDefault, externalIds } = input;
  const render: Edge[] = [];
  const layout: Edge[] = [];
  if (!response) return { render, layout };

  // Aggregate verdicts across visible probes so each pair draws ONE edge
  // (labelled n/m when probes disagree) instead of one overlapping edge per
  // probe - mirrors the matrix's aggregated cells.
  const agg = new Map<string, { allows: number; total: number }>();
  for (const [probe, matrix] of Object.entries(response.matrices)) {
    if (!visibleProbes.has(probe)) continue;
    for (const [pair, result] of Object.entries(matrix)) {
      const a = agg.get(pair) ?? { allows: 0, total: 0 };
      a.total++;
      if (result === 'allow') a.allows++;
      agg.set(pair, a);
    }
  }

  for (const [pair, { allows, total }] of agg) {
    const [src, dst] = pair.split('->');
    if (src === dst) continue;
    if (!visibleIds.has(src) || !visibleIds.has(dst)) continue;
    const anyAllow = allows > 0;
    const mixed = anyAllow && allows < total;

    // Stable layout skeleton: pairs with at least one allow.
    if (anyAllow) layout.push({ id: `L:${pair}`, source: src, target: dst });

    const external = externalIds.has(src) || externalIds.has(dst);
    const cross = crossNode?.(src, dst) ?? false;

    // Render gating.
    if (edgeMode === 'off') continue;
    if (edgeMode === 'select' && (!edgeFocus || (src !== edgeFocus && dst !== edgeFocus))) continue;
    if (!anyAllow && !emphasizeNonDefault) continue; // all-deny only when emphasizing
    // In NODE mode (routedElsewhere), cross-node + external flows draw no
    // direct line - they're per-endpoint badges (⇄ / 🌐) and, on focus, the
    // routed path through the HEP bands (see routedEdges in buildByNode).
    // NAMESPACE mode has no HEP bands to route through, so those flows draw as
    // direct lines - in the SAME amber the routed paths use, so a flow keeps
    // its colour when the user switches views.
    if (routedElsewhere && (cross || external)) continue;

    let color: string = EDGE_STYLES.allow.color;
    let width = emphasizeNonDefault ? 1 : 1.5;
    let opacity = emphasizeNonDefault ? 0.22 : 0.75;
    let dash: string | undefined;
    if (!anyAllow) {
      color = EDGE_STYLES.deny.color;
      width = 2;
      opacity = 0.9;
    } else if (mixed) {
      // Mixed pairs carry a deny, so they stay surfaced under 'emphasize' too.
      // The line renders as interleaved green/red marching dashes (DistanceArcEdge
      // reads data.mixed); the amber colour here is just the arrowhead + n/m label.
      color = EDGE_STYLES.mixed.color;
      dash = EDGE_STYLES.mixed.dash;
      width = 2; // match deny width - mixed carries a deny
      opacity = 0.75;
    } else if ((input.hostIds.has(src) && input.hostIds.has(dst)) || external) {
      // Topology-signal edges. Host↔host traffic is amber solid; a flow leaving
      // the cluster is blue dashed. A host↔pod or cross-node pod↔pod flow is
      // ordinary traffic - it keeps the normal allow/deny/mixed colours.
      width = 1.5;
      opacity = 0.9;
      if (external) {
        color = EDGE_STYLES.external.color;
        dash = EDGE_STYLES.external.dash;
      } else {
        color = EDGE_STYLES.crossNode.color;
      }
    }
    // In 'all' mode a pinned selection fades the rest; in 'select' mode only
    // the focus node's edges are present, so nothing needs fading.
    if (edgeMode === 'all' && selected && selected !== src && selected !== dst) {
      opacity = Math.min(opacity, 0.07);
    }

    // Deterministic per-pair lateral nudge so opposite directions (A→B vs B→A)
    // and equal-length parallels don't land on the same arc. The arc HEIGHT is
    // distance-driven in the DistanceArcEdge component (positions aren't known
    // here, before layout).
    let h = 0;
    for (let i = 0; i < pair.length; i++) h = (h * 31 + pair.charCodeAt(i)) >>> 0;
    const jitter = ((h % 7) - 3) * 7; // -21 .. 21 px

    render.push({
      id: `E:${pair}`,
      source: src,
      target: dst,
      type: 'distanceArc',
      data: { jitter, mixed },
      zIndex: Z_EDGE, // above group boxes, below pods so arcs tuck under the IN/OUT boxes
      ...(mixed
        ? {
            label: `${allows}/${total}`,
            labelStyle: { fill: color, fontSize: 10, fontWeight: 600 },
            labelBgStyle: { fillOpacity: 0.7 },
          }
        : {}),
      style: { stroke: color, strokeOpacity: opacity, strokeWidth: width, ...(dash ? { strokeDasharray: dash } : {}) },
      markerEnd: { type: MarkerType.ArrowClosed, color, width: 14, height: 14 },
    });
  }
  return { render, layout };
}

// --- helpers ---------------------------------------------------------------

// Cross-node peers per endpoint: which OTHER nodes it has an allowed flow
// to/from (matrix over visible probes) - drives the ⇄ badge in both views.
function crossPeersOf(
  input: GraphInput,
  nodeById: Map<string, string>,
): (id: string) => string[] | undefined {
  const peers = new Map<string, Set<string>>();
  const add = (id: string, node: string) => {
    const s = peers.get(id) ?? peers.set(id, new Set()).get(id)!;
    s.add(node);
  };
  if (input.response) {
    for (const [probe, matrix] of Object.entries(input.response.matrices)) {
      if (!input.visibleProbes.has(probe)) continue;
      for (const [pair, result] of Object.entries(matrix)) {
        if (result !== 'allow') continue;
        const [src, dst] = pair.split('->');
        const a = nodeById.get(src);
        const b = nodeById.get(dst);
        if (!a || !b || a === b) continue;
        add(src, b);
        add(dst, a);
      }
    }
  }
  return (id) => {
    const s = peers.get(id);
    return s && s.size ? Array.from(s).sort() : undefined;
  };
}

function visibleEndpoints(endpoints: Endpoint[], systemIds: Set<string>, hideSystem: boolean): Endpoint[] {
  return hideSystem ? endpoints.filter((e) => !systemIds.has(e.id)) : endpoints;
}
