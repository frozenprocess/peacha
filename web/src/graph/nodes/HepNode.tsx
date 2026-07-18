// HEP band - a HostEndpoint rendered as the node's firewall strip in
// node-grouped mode. It stays a real React Flow node (with handles) because the
// HEP is a real "host/<name>" row/col in the matrix, so allow-edges to/from the
// host must attach somewhere. Visually it's a thin shield-marked band that sits
// inside its node box, so an inter-node flow reads as transiting the firewall.

import { Handle, Position, type NodeProps } from '@xyflow/react';
import { Access, Globe } from './Globe';

// A host endpoint band: a policed HostEndpoint ([HEP], shield) or an
// unprotected/unpoliced host ([HOST], warning) - the latter synthesized for a
// node with no HEP. Always shown so the host's posture is visible per the CLI.
type HepData = {
  label: string;
  selected: boolean;
  system: boolean;
  unprotected?: boolean;
  internet?: Access;
  crossNodes?: string[];
  handleSide?: 'top' | 'bottom'; // set by Graph.tsx - faces the layout middle
};

export function HepNode({ data }: NodeProps) {
  const d = data as HepData;
  const side = d.handleSide === 'bottom' ? Position.Bottom : Position.Top;
  const cls =
    'hep-node' +
    (d.selected ? ' selected' : '') +
    (d.system ? ' system' : '') +
    (d.unprotected ? ' unprotected' : '');
  const tag = d.unprotected ? 'HOST' : 'HEP';
  return (
    <div className={cls} title={`host endpoint [${tag}]`}>
      <Handle type="target" position={side} className="pod-handle in" />
      <span className="hep-node-icon">{d.unprotected ? '⚠' : '🛡'}</span>
      <span className="hep-node-name">{d.label}</span>
      <span className="hep-node-tag">{tag}</span>
      {d.crossNodes?.length ? (
        <span className="xnode" title={`crosses to: ${d.crossNodes.join(', ')}`}>⇄</span>
      ) : null}
      {d.internet !== undefined ? <Globe value={d.internet} /> : null}
      <Handle type="source" position={side} className="pod-handle out" />
    </div>
  );
}
