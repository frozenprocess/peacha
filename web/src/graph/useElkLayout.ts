// ELK layered layout, namespace-group aware. Returns nodes with their
// position field filled in; React Flow uses those to place everything.
//
// We don't run layout on every keystroke - only when the topology (nodes) or
// edge set actually changes structurally. The hook compares input identity
// (cheap) and re-runs only on real changes.

import { useEffect, useMemo, useState } from 'react';
import type { Edge, Node } from '@xyflow/react';
import ELK, { ElkNode } from 'elkjs/lib/elk.bundled.js';

type Pos = { x: number; y: number; w?: number; h?: number };

const elk = new ELK();

// We pack rather than flow-layout. A 'layered' direction spreads a tier chain
// (frontend→backend→database) across the whole width and - because our
// cross-group edges reference nested pods (no hierarchyHandling) - stacks the
// group boxes as disconnected components with big vertical gaps. Edges here are
// filtered/focus-driven anyway, so flow direction buys little. 'rectpacking'
// tiles boxes compactly to a target aspect ratio: pods cluster inside each
// group and the group boxes tile together - a tight topology map.
//
// ROOT_OPTIONS arrange the group boxes; GROUP_OPTIONS pack pods inside a group
// (extra top padding leaves room for the group's label band). Bump the spacing
// to loosen, drop it to tighten.
const ROOT_OPTIONS = {
  'elk.algorithm': 'rectpacking',
  'elk.spacing.nodeNode': '18',
  'elk.aspectRatio': '1.6',
  'elk.padding': '[top=8,left=8,bottom=8,right=8]',
};
const GROUP_OPTIONS = {
  'elk.algorithm': 'rectpacking',
  'elk.spacing.nodeNode': '12',
  'elk.aspectRatio': '1.4',
  'elk.padding': '[top=26,left=10,bottom=10,right=10]',
};

const POD_WIDTH = 140;
// A pod's rendered height is content-driven (see PodNode.tsx): a name band that
// can wrap to 2 lines + one line per shown label (≤3) + an overflow line when
// there are more. ELK must reserve the REAL height or tall pods (3 labels +
// "…+N") overlap their neighbours. We reserve the 2-line-name maximum so a
// wrapping name (e.g. "kube-controller-manager") never overflows; the matching
// CSS clamps the name to 2 lines so it can't exceed the reservation. A 1-line
// name just leaves a little headroom - extra gap, never an overlap.
const POD_NAME_BAND = 46; // padding + border + up to 2 lines of name + margin
const POD_LABEL_LINE = 15; // one rendered label row (10px, line-height 1.25)
// HEP bands are full-width-ish strips, shorter than a pod - they read as the
// node's firewall rather than a workload.
const HEP_WIDTH = 190;
const HEP_HEIGHT = 30;

// Group container node types (laid out as ELK parents); everything else with a
// parentId is a child placed inside its group.
const GROUP_TYPES = new Set(['nsGroup', 'nodeGroup']);

// podHeight mirrors PodNode's layout: name band + one line per shown label
// (capped at 3) + an overflow line when there are extra labels.
function podHeight(labels: Record<string, string> | undefined): number {
  const n = labels ? Object.keys(labels).length : 0;
  const rows = Math.min(3, n) + (n > 3 ? 1 : 0);
  return POD_NAME_BAND + rows * POD_LABEL_LINE;
}

function childSize(node: Node): { width: number; height: number } {
  if (node.type === 'hepNode') return { width: HEP_WIDTH, height: HEP_HEIGHT };
  const labels = (node.data as { labels?: Record<string, string> } | undefined)?.labels;
  return { width: POD_WIDTH, height: podHeight(labels) };
}

// enabled=false bypasses ELK entirely and returns the nodes verbatim - used by
// the tier view, which computes its own deterministic pillar grid (positions +
// sizes already on the nodes), so there's nothing for ELK to solve.
export function useElkLayout(nodes: Node[], edges: Edge[], enabled = true): Node[] {
  const [positions, setPositions] = useState<Map<string, Pos>>(new Map());

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    layout(nodes).then((next) => {
      if (!cancelled) setPositions(next);
    });
    return () => {
      cancelled = true;
    };
    // Recompute positions only on STRUCTURAL change (ids/parents/edges). Node
    // DATA changes (selection, badges, handle side) don't alter the shape, so
    // they must NOT trigger a relayout - the merge below applies them instead.
  }, [enabled, shapeKey(nodes, edges)]);

  // Merge the LATEST node data onto the cached positions, so a data-only change
  // (e.g. selecting a pod) shows immediately. BUT key the result on rendered
  // CONTENT (id/type/parent/position/data), not on the `nodes` array identity:
  // buildGraph rebuilds every node object on each hover (edgeFocus is in its
  // deps) though only the EDGES change. Re-emitting nodes then would strip React
  // Flow's measurements and make the arcs anchored to those handles flicker.
  // Keyed this way, hover leaves the key unchanged -> stable node identities ->
  // no re-measure; selection changes the data -> key changes -> ring appears.
  const contentKey = useMemo(
    () =>
      nodes
        .map((n) => {
          const p = positions.get(n.id);
          const pos = p ? `${p.x},${p.y},${p.w},${p.h}` : '';
          return `${n.id}|${n.type ?? ''}|${n.parentId ?? ''}|${pos}|${JSON.stringify(n.data)}`;
        })
        .join('§'),
    [nodes, positions],
  );
  return useMemo(() => {
    if (!enabled) return nodes;
    return nodes.map((n) => {
      const pos = positions.get(n.id);
      if (!pos) return n; // pre-layout: keep buildGraph's {0,0} placeholder
      return GROUP_TYPES.has(n.type ?? '')
        ? { ...n, position: { x: pos.x, y: pos.y }, style: { ...(n.style ?? {}), width: pos.w, height: pos.h } }
        : { ...n, position: { x: pos.x, y: pos.y } };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, contentKey]);
}

function shapeKey(nodes: Node[], edges: Edge[]): string {
  return (
    nodes.map((n) => `${n.id}@${n.parentId ?? ''}`).join('|') +
    '##' +
    edges.map((e) => `${e.source}->${e.target}`).join('|')
  );
}

async function layout(nodes: Node[]): Promise<Map<string, Pos>> {
  if (nodes.length === 0) return new Map();

  // Index nodes by parent id (undefined => root). Any node can be both a child
  // and a parent, so the ELK tree is built recursively - supporting namespace
  // mode (group → pod), node mode flat (node → pod/HEP) and node mode nested
  // (node → namespace → pod) without per-depth special-casing. rectpacking
  // ignores edges, so none are fed to ELK (focus-driven rendering owns edges).
  const byParent = new Map<string | undefined, Node[]>();
  for (const n of nodes) {
    const key = n.parentId ?? undefined;
    const arr = byParent.get(key);
    if (arr) arr.push(n);
    else byParent.set(key, [n]);
  }
  const isGroup = (n: Node) => GROUP_TYPES.has(n.type ?? '');
  const toElk = (n: Node): ElkNode =>
    isGroup(n)
      ? { id: n.id, layoutOptions: GROUP_OPTIONS, children: (byParent.get(n.id) ?? []).map(toElk) }
      : { id: n.id, ...childSize(n) };

  const elkGraph: ElkNode = {
    id: 'root',
    layoutOptions: ROOT_OPTIONS,
    children: (byParent.get(undefined) ?? []).map(toElk),
  };

  const result = await elk.layout(elkGraph);

  // ELK positions are relative to the immediate parent at every level - exactly
  // what React Flow's extent:'parent' expects, so the hook sets them verbatim.
  const idToPos = new Map<string, Pos>();
  const walk = (e: ElkNode) => {
    for (const c of e.children ?? []) {
      idToPos.set(c.id, { x: c.x ?? 0, y: c.y ?? 0, w: c.width, h: c.height });
      walk(c);
    }
  };
  walk(result);
  return idToPos;
}
