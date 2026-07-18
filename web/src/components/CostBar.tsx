// Policy-efficiency cost, shown in the results header strip next to the
// errors/warnings. Collapsed: a score pill + the structural counts. Expanded
// (native <details>): the hygiene findings (the actionable smells) and the
// engine's real dataplane weight. Cost is a COST - lower is leaner, 0 = no
// policy at all.

import { CostReport, CostDataplane } from '../api';

// ponytail: fixed thresholds, not a percentile. Cost is unbounded; these just
// pick a traffic-light band. Tune the numbers if real policy sets cluster
// differently - the coloring.ts palette is the single source for the hues.
function tier(cost: number): 'lean' | 'ok' | 'heavy' {
  if (cost <= 15) return 'lean';
  if (cost <= 50) return 'ok';
  return 'heavy';
}

// dataplane is the weight for the active view (iptables/nftables/bpf/hns); the
// rest of the report is dataplane-independent, so it doesn't change on view
// switch.
export function CostBar({ cost, dataplane }: { cost: CostReport; dataplane?: CostDataplane }) {
  const s = cost.structural;
  const findings = cost.hygiene ?? [];
  const bits = [
    `${s.policies} pol`,
    `${s.rules} rules`,
    s.cidrs ? `${s.cidrs} cidrs` : '',
    s.ports ? `${s.ports} ports` : '',
    s.negations ? `${s.negations} neg` : '',
  ].filter(Boolean);

  return (
    <details className="costbar" data-tier={tier(cost.cost)}>
      <summary
        title={
          dataplane
            ? `${dataplane.kind}: real compiled weight for this view · Cost is the portable score (same across dataplanes)`
            : 'policy-efficiency cost - lower is leaner (0 = no policy)'
        }
      >
        {dataplane ? (
          // Per-dataplane real weight leads: it's what changes when you switch
          // iptables/nftables/bpf/hns. Cost stays as the portable anchor.
          <span className="cost-score cost-weight">
            💰 {dataplane.rules} {dataplane.rulesUnit}
          </span>
        ) : (
          <span className="cost-score">💰 Cost {cost.cost}</span>
        )}
        {dataplane ? <span className="cost-anchor">Cost {cost.cost}</span> : null}
        <span className="cost-struct">{bits.join(' · ')}</span>
        {findings.length ? (
          <span className="cost-flags">{findings.length} ⚠</span>
        ) : null}
      </summary>
      <div className="costbar-body">
        {findings.length ? (
          <ul className="cost-findings">
            {findings.map((f, i) => (
              <li key={i}>
                <code>{f.code}</code> {f.policy}
                {f.rule != null ? ` rule ${f.rule}` : ''} — {f.detail}
                <span className="cost-penalty">+{f.penalty}</span>
              </li>
            ))}
          </ul>
        ) : (
          <div className="cost-clean">No efficiency smells.</div>
        )}
        {dataplane ? (
          <div className="cost-dataplane">
            {dataplane.kind}: {dataplane.rules} {dataplane.rulesUnit}
            {' · '}
            {dataplane.peerEntries} peer entries
            {dataplane.ipSets ? ` · ${dataplane.ipSets} IP sets` : ''}
          </div>
        ) : null}
      </div>
    </details>
  );
}
