// A connectivity edge whose arc height scales with the source→target distance.
//
// Every endpoint's IN/OUT handle sits on one horizontal band (see Graph.tsx
// handleSide), so straight - or fixed-curvature - edges between different pairs
// run along the same line and overlap: you can't tell which flow is which. A
// quadratic arc whose peak grows with the distance between the two endpoints
// lifts long-haul flows (e.g. prod→dev) well clear of the short adjacent ones
// (frontend→backend), so each reads as its own curve. The arc bows AWAY from
// the node body (down when handles face down, up when up), into empty space.

import { BaseEdge, Position, type EdgeProps } from '@xyflow/react';
import { EDGE_STYLES } from '../buildGraph';

export function DistanceArcEdge({
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  markerEnd,
  style,
  label,
  labelStyle,
  labelBgStyle,
  data,
}: EdgeProps) {
  const dist = Math.hypot(targetX - sourceX, targetY - sourceY);
  // Visual arc peak, proportional to distance and clamped so adjacent pods stay
  // a shallow hop and very long flows don't balloon off-screen.
  const peak = Math.min(150, Math.max(16, dist * 0.2));
  // Bow away from the node body: bottom-facing handles arc down, top-facing up.
  const dir = sourcePosition === Position.Top ? -1 : 1;
  // Deterministic per-edge lateral nudge (set in buildGraph from the pair hash)
  // so opposite directions and equal-length parallels don't coincide.
  const jitter = typeof data?.jitter === 'number' ? data.jitter : 0;

  const midX = (sourceX + targetX) / 2 + jitter;
  const midY = (sourceY + targetY) / 2;
  // Quadratic control point is offset 2× the peak (the curve reaches halfway).
  const path = `M ${sourceX},${sourceY} Q ${midX},${midY + dir * 2 * peak} ${targetX},${targetY}`;

  // Mixed pairs (some probes allow, some deny) render as interleaved marching
  // dashes: a green base path plus a red overlay, phase-shifted half a period
  // so the two colours fill each other's gaps. The single stroke React Flow
  // gives an edge can't be two-coloured, hence the overlay. (edge-march keyframe
  // + dash pattern live in EDGE_STYLES / styles.css - single source.)
  const mixed = (data as { mixed?: boolean } | undefined)?.mixed === true;
  const march = { animation: 'edge-march 0.6s linear infinite' } as const;

  return (
    <>
      <BaseEdge
        path={path}
        markerEnd={markerEnd}
        style={mixed ? { ...style, stroke: EDGE_STYLES.mixed.colors[0], ...march } : style}
        label={label}
        labelX={midX}
        labelY={midY + dir * peak - 12}
        labelStyle={labelStyle}
        labelBgStyle={labelBgStyle}
        labelShowBg={!!label}
      />
      {mixed ? (
        <path d={path} fill="none" style={{ ...style, stroke: EDGE_STYLES.mixed.colors[1], ...march, animationDelay: '-0.3s' }} />
      ) : null}
    </>
  );
}
