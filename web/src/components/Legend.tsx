// Color legend for the dataplane views: maps each origin color to its label so
// users can read the bpf/iptables/nftables coloring. Renders only the origins
// actually present in the current output.

import { Origin, ORIGIN_LABEL, originsPresent } from '../coloring';

export function Legend({ origins }: { origins: Origin[] }) {
  const present = originsPresent(origins);
  if (present.length === 0) return null;
  return (
    <div className="origin-legend">
      {present.map((o) => (
        <span key={o} className={'origin-key origin-' + o}>
          <span className="origin-swatch" />
          {ORIGIN_LABEL[o]}
        </span>
      ))}
    </div>
  );
}
