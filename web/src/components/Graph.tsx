// Connectivity graph view. Endpoints become nodes (grouped by namespace);
// flows aggregate across visible probes into one edge per pair - green when
// all probes allow, interleaved green/red n/m when they disagree. Clicking a pod
// pins it as selected - edges touching it stay solid, everything else dims.
// The matrix view stays synced via the shared `selected` state in App.tsx.

import {
  Background,
  Controls,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  useUpdateNodeInternals,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { EditorResponse, Endpoint, HostEndpointInput, NodeInfo, PolicyInput, Probe, TierInput, TierMatchResponse } from '../api';
import { EdgeMode, GroupBy } from '../state';
import { ALLOW_COLOR, EDGE_STYLES, buildGraph } from '../graph/buildGraph';
import { Globe } from '../graph/nodes/Globe';
import { useElkLayout } from '../graph/useElkLayout';
import { PodNode } from '../graph/nodes/PodNode';
import { NamespaceGroup } from '../graph/nodes/NamespaceGroup';
import { NodeGroup } from '../graph/nodes/NodeGroup';
import { HepNode } from '../graph/nodes/HepNode';
import { TierPillar } from '../graph/nodes/TierPillar';
import { PolicyNode } from '../graph/nodes/PolicyNode';
import { DistanceArcEdge } from '../graph/edges/DistanceArcEdge';
import { PolicyWizard } from '../components/PolicyWizard';
import type { PolicyVocabulary } from '../policyCompletions';

const nodeTypes = {
  podNode: PodNode,
  nsGroup: NamespaceGroup,
  nodeGroup: NodeGroup,
  hepNode: HepNode,
  tierGroup: TierPillar,
  policyNode: PolicyNode,
};

const edgeTypes = { distanceArc: DistanceArcEdge };

// Children that represent a selectable matrix endpoint (a row/col): pods and
// HEP bands. Group boxes are not selectable.
const SELECTABLE_TYPES = new Set(['podNode', 'hepNode']);

interface Props {
  endpoints: Endpoint[];
  systemIds: Set<string>;
  externalIds: Set<string>;
  hostIds: Set<string>;
  unprotectedIds: Set<string>;
  response: EditorResponse | null;
  probes: Probe[];               // probe defs - per-port open/closed on pods
  selected: string | null;
  onSelect: (id: string | null) => void;
  visibleProbes: Set<string>;
  onToggleProbe: (probe: string) => void;
  groupBy: GroupBy;
  onGroupByChange: (g: GroupBy) => void;
  edgeMode: EdgeMode;
  onEdgeModeChange: (m: EdgeMode) => void;
  hideSystem: boolean;
  onHideSystemChange: (v: boolean) => void;
  emphasizeNonDefault: boolean;
  onEmphasizeChange: (v: boolean) => void;
  nodes: NodeInfo[];
  hostEndpoints: HostEndpointInput[];
  hostNodeIds: Map<string, string>; // node name -> synthesized unpoliced host id
  policies: PolicyInput[];           // tier view parses these into pillars
  tiers: TierInput[];                // user-defined tiers (name/order/action)
  tierMatches: TierMatchResponse | null; // engine-resolved per-endpoint matches
  tierNames: string[];                   // live tier list -> wizard's Calico spec.tier enum
  vocab: PolicyVocabulary;               // topology values -> wizard comboboxes
  onAddRule?: (yaml: string) => void;    // policy wizard -> append a built doc to the editor
}

export function Graph(props: Props) {
  return (
    <ReactFlowProvider>
      <GraphInner {...props} />
    </ReactFlowProvider>
  );
}

function GraphInner({
  endpoints,
  systemIds,
  externalIds,
  hostIds,
  unprotectedIds,
  response,
  probes,
  selected,
  onSelect,
  visibleProbes,
  onToggleProbe,
  groupBy,
  onGroupByChange,
  edgeMode,
  onEdgeModeChange,
  hideSystem,
  onHideSystemChange,
  emphasizeNonDefault,
  onEmphasizeChange,
  nodes: clusterNodes,
  hostEndpoints,
  hostNodeIds,
  policies,
  tiers,
  tierMatches,
  tierNames,
  vocab,
  onAddRule,
}: Props) {
  const isTier = groupBy === 'tier';
  // Hover-to-peek in focus mode: when nothing is pinned, hovering a node shows
  // its edges. The pinned `selected` still drives the selection ring.
  const [hovered, setHovered] = useState<string | null>(null);
  // Hover-to-peek only on devices that actually hover. On touch, tapping a node
  // fires mouseenter but never a mouseleave, so `hovered` sticks - which kept
  // edges alive after deselecting (selected→null fell back to the stuck hover).
  const canHover = useMemo(() => typeof window !== 'undefined' && window.matchMedia?.('(hover: hover)').matches, []);
  const edgeFocus = selected ?? (canHover ? hovered : null);

  const { nodes: rawNodes, edges, layoutEdges } = useMemo(
    () =>
      buildGraph({
        endpoints,
        systemIds,
        externalIds,
        hostIds,
        unprotectedIds,
        response,
        probes,
        selected,
        edgeFocus,
        visibleProbes,
        groupBy,
        edgeMode,
        hideSystem,
        emphasizeNonDefault,
        nodes: clusterNodes,
        hostEndpoints,
        hostNodeIds,
        policies,
        tiers,
        tierMatches,
      }),
    [endpoints, systemIds, externalIds, hostIds, unprotectedIds, response, probes, selected, edgeFocus, visibleProbes, groupBy, edgeMode, hideSystem, emphasizeNonDefault, clusterNodes, hostEndpoints, hostNodeIds, policies, tiers, tierMatches],
  );
  // Lay out against the STABLE skeleton (layoutEdges), not the rendered subset,
  // so focusing/hovering a node never reshuffles positions. The tier view
  // computes its own deterministic pillar grid, so ELK is disabled there.
  const laidOut = useElkLayout(rawNodes, layoutEdges, !isTier);

  // Face each endpoint's IN/OUT connectors toward the layout's vertical
  // middle: top half -> handles on the bottom, bottom half -> on top. Child
  // positions are parent-relative, so absolute Y walks the parent chain.
  const nodes = useMemo(() => {
    const byId = new Map(laidOut.map((n) => [n.id, n]));
    const absY = (n: (typeof laidOut)[number]): number => {
      let y = n.position?.y ?? 0;
      let p = n.parentId ? byId.get(n.parentId) : undefined;
      while (p) {
        y += p.position?.y ?? 0;
        p = p.parentId ? byId.get(p.parentId) : undefined;
      }
      return y;
    };
    const eps = laidOut.filter((n) => SELECTABLE_TYPES.has(n.type ?? ''));
    if (eps.length === 0) return laidOut;
    const ys = eps.map(absY);
    const mid = (Math.min(...ys) + Math.max(...ys)) / 2;
    return laidOut.map((n) =>
      SELECTABLE_TYPES.has(n.type ?? '')
        ? { ...n, data: { ...n.data, handleSide: absY(n) < mid ? 'bottom' : 'top' } }
        : n,
    );
  }, [laidOut]);

  // When a node's connectors flip sides, React Flow must re-measure that
  // node's handle bounds or edges keep anchoring to the old edge.
  const updateNodeInternals = useUpdateNodeInternals();
  const sidesKey = useMemo(
    () =>
      nodes
        .filter((n) => SELECTABLE_TYPES.has(n.type ?? ''))
        .map((n) => `${n.id}:${n.data.handleSide}`)
        .join('|'),
    [nodes],
  );
  useEffect(() => {
    updateNodeInternals(
      nodes.filter((n) => SELECTABLE_TYPES.has(n.type ?? '')).map((n) => n.id),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sidesKey, updateNodeInternals]);

  // Re-fit when the layout settles. `fitView` (the prop) only fires once on
  // mount, before ELK has placed the nodes. The subtle part is a MEASUREMENT
  // RACE: ELK resolves asynchronously and pushes new positions + resized
  // group-box dimensions, and React Flow re-measures those boxes a frame or two
  // later via its own ResizeObserver. Fitting in a single rAF (the old code) ran
  // before RF had the correct group sizes, so it computed bounds from stale/zero
  // dimensions and left the view zoomed in. So we fit AFTER measurement is
  // likely done - a double rAF for the common case, plus a 120ms safety-net for
  // slower measurements. Keyed on layoutKey, it re-fits only when the layout
  // genuinely changes (never on hover/focus), so it can't fight a pan in
  // progress. The old useNodesInitialized gate was dropped - it suppressed the
  // re-fit instead of timing it.
  const { fitView } = useReactFlow();
  const hostRef = useRef<HTMLDivElement>(null);
  const layoutKey = useMemo(
    () => nodes.map((n) => `${n.id}@${n.position?.x},${n.position?.y}`).join('|'),
    [nodes],
  );
  useEffect(() => {
    let raf1 = 0;
    let raf2 = 0;
    const fit = () => fitView();
    raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(fit);
    });
    const timer = setTimeout(fit, 120);
    return () => {
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
      clearTimeout(timer);
    };
  }, [layoutKey, fitView]);

  // Re-fit when the graph host itself resizes (pane expand/collapse/resize/
  // maximize) - those don't change layoutKey, so the effect above won't catch
  // them. One rAF is enough here since node measurements are already settled.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const ro = new ResizeObserver(() => requestAnimationFrame(() => fitView()));
    ro.observe(host);
    return () => ro.disconnect();
  }, [fitView]);

  const hasMatrices = Object.keys(response?.matrices ?? {}).length > 0;
  // Empty-state hint: focus mode with nothing focused draws no edges on purpose.
  const showFocusHint = edgeMode === 'select' && !edgeFocus && hasMatrices && edges.length === 0;

  return (
    <div className="graph-host" ref={hostRef}>
      <div className="graph-toolbar">
        <div className="graph-toolbar-row">
          <div className="groupby-toggle" role="group" aria-label="group graph by">
            {(['namespace', 'node', 'tier'] as GroupBy[]).map((g) => (
              <button
                key={g}
                className={'groupby-btn' + (groupBy === g ? ' active' : '')}
                onClick={() => onGroupByChange(g)}
                title={g === 'tier' ? 'show policies grouped into tier pillars' : `group by ${g}`}
              >
                {g}
              </button>
            ))}
          </div>
          {/* Edges / system / emphasis are connectivity-only controls - the tier
              view is structural (policies, no flows), so they're hidden there. */}
          {!isTier ? (
            <div className="groupby-toggle" role="group" aria-label="edges">
              {(['select', 'all', 'off'] as EdgeMode[]).map((m) => (
                <button
                  key={m}
                  className={'groupby-btn' + (edgeMode === m ? ' active' : '')}
                  onClick={() => onEdgeModeChange(m)}
                  title={EDGE_MODE_TITLE[m]}
                >
                  {m === 'select' ? 'on-select' : m}
                </button>
              ))}
            </div>
          ) : null}
        </div>
        <div className="graph-toolbar-row">
          {!isTier ? (
            <>
              <label className="graph-check" title="hide kube-system / calico-system / tigera-operator pods">
                <input type="checkbox" checked={hideSystem} onChange={(e) => onHideSystemChange(e.target.checked)} />
                hide system
              </label>
              <label className="graph-check" title="fade plain allows; surface denies (red) + cross-node/external (amber)">
                <input
                  type="checkbox"
                  checked={emphasizeNonDefault}
                  onChange={(e) => onEmphasizeChange(e.target.checked)}
                />
                emphasize
              </label>
            </>
          ) : null}
          {onAddRule ? (
            <PolicyWizard tierNames={tierNames} vocab={vocab} onAdd={onAddRule} hostRef={hostRef} />
          ) : null}
        </div>
      </div>
      {!isTier ? (
        <>
          <Legend probes={Object.keys(response?.matrices ?? {})} visible={visibleProbes} onToggle={onToggleProbe} />
          <ArrowLegend />
        </>
      ) : null}
      {showFocusHint && !isTier ? (
        <div className="graph-hint">click a node to trace its connections · hover to peek</div>
      ) : null}
      {/* Once a selected endpoint actually highlights something, the highlight
          itself is the feedback - the banner only earns its overlay space when
          there's nothing to see (no selection, or no matching policy). The
          engine lists EVERY endpoint in tierMatches, so "matches" means it has
          at least one policy - mere presence in the list proves nothing. */}
      {isTier &&
      !(selected && tierMatches?.endpoints.some((e) => e.endpoint === selected && (e.policies?.length ?? 0) > 0)) ? (
        <div className="graph-hint bottom">
          {!selected
            ? 'select an endpoint (matrix or graph view) to highlight the policies & tiers that apply to it'
            : `${selected} isn't selected by any tier policy (profiles only)`}
        </div>
      ) : null}
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        fitView
        minZoom={0.1}
        proOptions={{ hideAttribution: true }}
        onNodeClick={(_, n) => {
          if (!SELECTABLE_TYPES.has(n.type ?? '')) return;
          onSelect(selected === n.id ? null : n.id);
        }}
        onNodeMouseEnter={(_, n) => {
          if (SELECTABLE_TYPES.has(n.type ?? '')) setHovered(n.id);
        }}
        onNodeMouseLeave={() => setHovered(null)}
        onPaneClick={() => onSelect(null)}
        nodesDraggable
        nodesConnectable={false}
      >
        <Background gap={16} />
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  );
}

const EDGE_MODE_TITLE: Record<EdgeMode, string> = {
  select: 'show edges only for the focused node (click to pin, hover to peek)',
  all: 'show every flow (busy on default-allow topologies)',
  off: 'hide all edges',
};

// The legend doubles as a probe filter. All probes share the same allow-green
// edge colour (a single visual vocabulary for "this is an allowed flow"), so
// the swatch tracks the on/off toggle rather than encoding probe identity.
function Legend({
  probes,
  visible,
  onToggle,
}: {
  probes: string[];
  visible: Set<string>;
  onToggle: (p: string) => void;
}) {
  if (probes.length === 0) return null;
  const onCount = probes.filter((p) => visible.has(p)).length;
  return (
    <div className="legend">
      {probes.length > 0 ? (
        <details className="legend-probes">
          <summary className="legend-item" title="pick which probes feed the matrix/graph">
            <span
              className="legend-swatch"
              style={{ background: onCount ? ALLOW_COLOR : 'transparent', borderColor: onCount ? ALLOW_COLOR : '#bbb' }}
            />
            probes {onCount}/{probes.length} ▾
          </summary>
          <div className="legend-probes-panel">
            <div className="legend-probes-actions">
              <button onClick={() => probes.forEach((p) => !visible.has(p) && onToggle(p))}>all</button>
              <button onClick={() => probes.forEach((p) => visible.has(p) && onToggle(p))}>none</button>
            </div>
            {probes.map((p) => {
              const on = visible.has(p);
              return (
                <button
                  key={p}
                  className={'legend-item' + (on ? '' : ' off')}
                  title={on ? `hide ${p}` : `show ${p}`}
                  onClick={() => onToggle(p)}
                >
                  <span
                    className="legend-swatch"
                    style={{ background: on ? ALLOW_COLOR : 'transparent', borderColor: on ? ALLOW_COLOR : '#bbb' }}
                  />
                  {p}
                </button>
              );
            })}
          </div>
        </details>
      ) : null}
    </div>
  );
}

// Always-on key for every arrow type, bottom-right. Static (all types shown at
// all times) so the vocabulary is a stable reference, not a context-dependent
// one. Every row is driven from EDGE_STYLES (see EdgeKey) so it can't drift from
// what's drawn. ⇄/🌐 glyphs double as the node-grouping badges for those flows.
function ArrowLegend() {
  return (
    <div className="legend arrow-legend">
      <EdgeKey kind="allow" />
      <EdgeKey kind="deny" />
      <EdgeKey kind="mixed" />
      <EdgeKey kind="crossNode" glyph={<span className="xnode">⇄</span>} />
      <EdgeKey kind="external" glyph={<Globe value={true} />} />
    </div>
  );
}

// One legend row per edge type, styled straight from EDGE_STYLES so the swatch
// (colour + dash + marching-ants animation) always matches the arrow drawn.
// The optional glyph is the node-level badge that also stands for this flow
// (⇄ cross-node, 🌐 internet) in node grouping, where those draw no line.
function EdgeKey({ kind, glyph }: { kind: keyof typeof EDGE_STYLES; glyph?: ReactNode }) {
  const s = EDGE_STYLES[kind];
  const dash = 'dash' in s ? s.dash : undefined;
  const march = { animation: 'edge-march 0.6s linear infinite' } as const;
  // Bicolor (mixed) swatch mirrors the arrow: two phase-shifted dashed lines.
  const lines =
    'colors' in s ? (
      <>
        <line x1="1" y1="4" x2="21" y2="4" stroke={s.colors[0]} strokeWidth="2" strokeDasharray={dash} style={march} />
        <line x1="1" y1="4" x2="21" y2="4" stroke={s.colors[1]} strokeWidth="2" strokeDasharray={dash} style={{ ...march, animationDelay: '-0.3s' }} />
      </>
    ) : (
      <line x1="1" y1="4" x2="21" y2="4" stroke={s.color} strokeWidth="2" strokeDasharray={dash} />
    );
  return (
    <span className="legend-item" title={s.title}>
      <svg className="legend-edge" width="22" height="8" aria-hidden>
        {lines}
      </svg>
      {glyph}
      {s.label}
    </span>
  );
}
