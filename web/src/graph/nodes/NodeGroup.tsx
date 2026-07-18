// Node group - a labelled bounding box for one k8s node (node-grouped graph
// mode). Pods and the node's HEP band (hepNode) are parented to it and placed
// by ELK; this component is just the box chrome + posture cue:
//   - has a HostEndpoint  → shield badge, solid border ("policed")
//   - no HostEndpoint     → dashed "unprotected" border + hint (Calico doesn't
//                            police host traffic until a HEP exists)
//   - unscheduled holding box for pods/HEPs with no node → neutral, no posture.

import { type NodeProps } from '@xyflow/react';
import { Access, Globe } from './Globe';

type NodeData = {
  label: string;
  heps: { id: string; name: string; system: boolean }[];
  unprotected: boolean;
  unscheduled: boolean;
  external: boolean;
  system: boolean;
  internet?: Access; // aggregate internet access of pods/HEPs on this node
  zone?: 'hosts'; // namespace view's aggregate "cluster hosts" box - styled as
                  // infrastructure, not as a node/namespace
};

export function NodeGroup({ data }: NodeProps) {
  const d = data as NodeData;
  const policed = d.heps.length > 0;
  const cls =
    'node-group' +
    (d.system ? ' system' : '') +
    (d.unprotected ? ' unprotected' : '') +
    (d.unscheduled ? ' unscheduled' : '') +
    (d.external ? ' external' : '') +
    (d.zone ? ` zone-${d.zone}` : '');
  // Icon: internet zone -> globe; hosts zone -> machine; policed node ->
  // shield; unprotected -> warn; unscheduled holding box -> none.
  const icon = d.external ? '🌐' : d.zone === 'hosts' ? '🖥' : d.unscheduled ? '' : policed ? '🛡' : '⚠';
  return (
    <div className={cls}>
      <div className="node-group-label">
        {icon ? <span className="node-group-icon">{icon}</span> : null}
        <span>{d.label}</span>
      </div>
      {d.unprotected || d.internet !== undefined ? (
        <div className="node-group-badges">
          {d.unprotected ? (
            <span
              className="node-group-tag"
              title="Your host and host processes are not protected. Use a HostEndpoint (HEP) to turn on Calico's host firewall features."
            >
              unprotected
            </span>
          ) : null}
          {d.internet !== undefined ? <Globe value={d.internet} /> : null}
        </div>
      ) : null}
    </div>
  );
}
