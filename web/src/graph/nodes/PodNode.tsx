// Pod node - shows the short pod name + a couple of labels (truncated). The
// outline ring is selection state; React Flow handles the click that toggles
// it (forwarded from Graph.tsx). Handles are labelled IN / OUT boxes, both on
// the top edge, so ingress and egress read directly off the node.

import { Handle, Position, type NodeProps } from '@xyflow/react';
import { PortStatus } from '../../impact';
import { Access, Globe } from './Globe';

type PodData = {
  label: string;
  labels: Record<string, string>;
  selected: boolean;
  system: boolean;
  external?: boolean; // off-cluster destination - tagged [EXT]
  internet?: Access;  // can egress to world/internet - globe badge
  crossNodes?: string[]; // other nodes this endpoint talks to - ⇄ badge
  // The workload's declared ports + whether each is reachable (ingress) on the
  // engine's matrices - rendered as an open/total chip with a per-port tooltip.
  ports?: PortStatus[];
  // Which edge the IN/OUT connectors sit on - Graph.tsx points them at the
  // layout's vertical middle after ELK places the node. Default: top.
  handleSide?: 'top' | 'bottom';
};

// Glyphs mirror the matrix's vocabulary: filled = reachable, hollow = blocked,
// dash = no probe covers it.
const PORT_GLYPH: Record<PortStatus['state'], string> = {
  open: '●',
  closed: '○',
  unprobed: '–',
};

// Multi-line title listing every declared port and its reachability. The badge
// itself only shows the open/total count; the detail lives in the tooltip.
function portsTitle(ports: PortStatus[]): string {
  const lines = ports.map((p) => `  ${PORT_GLYPH[p.state]} ${p.label} - ${p.state}`);
  return ['ingress ports (reachable from any source):', ...lines].join('\n');
}

// 'open' if any reachable; 'closed' if some are probed but none open; else
// 'mixed' - drives the chip tint so a fully-open vs fully-closed pod reads at a
// glance without opening the tooltip.
function portsTone(ports: PortStatus[]): 'open' | 'closed' | 'mixed' {
  const open = ports.filter((p) => p.state === 'open').length;
  if (open === 0) return 'closed';
  if (open === ports.length) return 'open';
  return 'mixed';
}

export function PodNode({ data }: NodeProps) {
  const d = data as PodData;
  const side = d.handleSide === 'bottom' ? Position.Bottom : Position.Top;
  // WORLD/off-cluster endpoints aren't pods - no labels, no declared ports -
  // so they render as a compact globe pill instead of pod-chip chrome.
  if (d.external) {
    return (
      <div className={'world-node' + (d.selected ? ' selected' : '')} title="off-cluster destination">
        <Handle type="target" position={side} className="pod-handle in" />
        <span className="world-node-icon">🌐</span>
        {d.label}
        <Handle type="source" position={side} className="pod-handle out" />
      </div>
    );
  }
  const labelEntries = Object.entries(d.labels).slice(0, 3);
  const openPorts = d.ports?.filter((p) => p.state === 'open').length ?? 0;
  const cls =
    'pod-node' +
    (d.selected ? ' selected' : '') +
    (d.system ? ' system' : '') +
    (d.external ? ' external' : '');
  return (
    <div className={cls}>
      <Handle type="target" position={side} className="pod-handle in" />
      <div className="pod-node-name">
        {d.internet !== undefined ? <Globe value={d.internet} /> : null}
        {d.crossNodes?.length ? (
          <span className="xnode" title={`crosses to: ${d.crossNodes.join(', ')}`}>⇄</span>
        ) : null}
        {d.external ? <span className="pod-node-ext" title="off-cluster destination">EXT</span> : null}
        {d.label}
        {d.ports?.length ? (
          <span className={`pod-node-ports ${portsTone(d.ports)}`} title={portsTitle(d.ports)}>
            ⊟ {openPorts}/{d.ports.length}
          </span>
        ) : null}
      </div>
      <div className="pod-node-labels">
        {labelEntries.map(([k, v]) => (
          <div key={k} className="pod-node-label">
            <span className="k">{k}</span>=<span className="v">{v}</span>
          </div>
        ))}
        {Object.keys(d.labels).length > 3 ? (
          <div className="pod-node-label muted">…+{Object.keys(d.labels).length - 3}</div>
        ) : null}
      </div>
      <Handle type="source" position={side} className="pod-handle out" />
    </div>
  );
}
