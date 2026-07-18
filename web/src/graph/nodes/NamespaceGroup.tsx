// Namespace group - a labelled bounding box that contains its pods. Pure
// presentation; the layout size is set by ELK in useElkLayout. The label
// sits in the padding band ELK reserves at the top of each group.

import { type NodeProps } from '@xyflow/react';
import { Access, Globe } from './Globe';

// `nested` marks a namespace box that sits INSIDE a node box (node mode's
// node → namespace → pod nesting).
type NSData = {
  label: string;
  system: boolean;
  external?: boolean;
  nested?: boolean;
  internet?: Access; // aggregate internet access of member pods
};

export function NamespaceGroup({ data }: NodeProps) {
  const d = data as NSData;
  const cls =
    'ns-group' +
    (d.system ? ' system' : '') +
    (d.external ? ' external' : '') +
    (d.nested ? ' nested' : '');
  return (
    <div className={cls}>
      <div className="ns-group-label">
        {d.external ? <span className="node-group-icon">🌐</span> : null}
        {d.label}
        {d.internet !== undefined ? <Globe value={d.internet} /> : null}
      </div>
    </div>
  );
}
