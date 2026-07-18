// Policy card - one policy inside a tier pillar (see graph/tiers.ts). Shows the
// policy name, a kind badge (GNP / NP / k8s, with a staged marker), the order
// if set, and the selector it applies to. Display only (not selectable).

import { type CSSProperties } from 'react';
import { type NodeProps } from '@xyflow/react';
import { ACTION_COLOR, type ActionKind } from '../../actionColors';

type PolicyData = {
  name: string;
  kind: string;
  namespace?: string;
  selector?: string;
  order?: number;
  flavor: 'k8s' | 'calico' | 'cnp';
  staged: boolean;
  // HEP enforcement hook: preDNAT / doNotTrack / applyOnForward rules fire ahead
  // of the normal tier chain, so a card carrying one is flagged - the pillar's
  // left-to-right tier order does NOT reflect when this policy is evaluated.
  hook?: 'preDNAT' | 'doNotTrack' | 'applyOnForward';
  // How many endpoints this policy selects (its subject footprint), from the
  // engine's tier resolution. undefined when unresolved (no count shown).
  affected?: number;
  // Distinct rule actions (deny→allow→pass→log). Colours the left border from
  // the shared action palette: one action = solid, several = a gradient.
  actions?: ActionKind[];
  // Highlight state when an endpoint is selected: matched = this policy
  // selects it (non-matches are left as-is, not dimmed).
  matched?: boolean;
};

// actionBorderStyle colours the card's left border by the policy's action(s):
// one → solid; several → a top-to-bottom gradient stripe. Empty leaves the CSS
// default border.
function actionBorderStyle(actions?: ActionKind[]): CSSProperties {
  const colors = (actions ?? []).map((a) => ACTION_COLOR[a]);
  if (colors.length === 0) return {};
  if (colors.length === 1) return { borderLeftColor: colors[0] };
  return { borderImage: `linear-gradient(to bottom, ${colors.join(', ')}) 1` };
}

// kindBadge abbreviates the policy kind for the corner tag.
function kindBadge(kind: string, flavor: 'k8s' | 'calico' | 'cnp'): string {
  if (kind === 'ClusterNetworkPolicy') return 'CNP';
  if (flavor === 'k8s') return 'k8s';
  if (kind.includes('Global')) return 'GNP';
  return 'NP';
}

export function PolicyNode({ data }: NodeProps) {
  const d = data as PolicyData;
  // NPA ClusterNetworkPolicy orders by spec.priority; everything else by order.
  const orderLabel = d.flavor === 'cnp' ? 'prio' : 'order';
  const cls =
    'policy-card' +
    (d.staged ? ' staged' : '') +
    (d.matched ? ' matched' : '');
  const hookTitle = d.hook
    ? `${d.hook}: HEP hook - evaluated before the normal tier chain, regardless of this tier's order`
    : undefined;
  return (
    <div
      className={cls}
      style={actionBorderStyle(d.actions)}
      title={hookTitle ?? (d.selector ? `selector: ${d.selector}` : undefined)}
    >
      <div className="policy-card-head">
        <span className="policy-kind">{kindBadge(d.kind, d.flavor)}</span>
        <span className="policy-name">{d.name}</span>
        {d.order !== undefined ? <span className="policy-order">{orderLabel} {d.order}</span> : null}
        {d.staged ? <span className="policy-staged">staged</span> : null}
        {d.hook ? <span className="policy-hook" title={hookTitle}>⤳ {d.hook}</span> : null}
        {d.affected !== undefined ? (
          <span
            className={'policy-affected' + (d.affected === 0 ? ' orphan' : '')}
            title={
              d.affected === 0
                ? 'selects no endpoints (this policy is inactive)'
                : `selects ${d.affected} endpoint${d.affected === 1 ? '' : 's'}`
            }
          >
            ⦿ {d.affected}
          </span>
        ) : null}
      </div>
      {d.selector ? <div className="policy-selector">{d.selector}</div> : null}
    </div>
  );
}
