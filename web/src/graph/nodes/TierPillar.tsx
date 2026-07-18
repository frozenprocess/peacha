// Tier pillar - a labelled vertical bounding box (one per policy tier) that
// contains its policy cards. Pure presentation; size + position are set in
// graph/tiers.ts. The header band shows the tier name, policy count, and a
// reserved badge; the footer band shows the end-of-tier default action - what
// applies when no rule in the tier matched (Pass = fall through to the next
// tier, Deny = drop). A tier a policy references but that isn't defined is
// flagged so the error is visible.

import { type NodeProps } from '@xyflow/react';
import { useEffect, useRef, useState } from 'react';
import { popoverProps, useAnchoredPopover } from '../../usePopover';

type TierData = {
  label: string;
  order: number;
  defaultAction?: 'Pass' | 'Deny';
  reserved: boolean;
  defined: boolean;
  count: number;
  // How many endpoints this tier's end-of-tier action governs (subject to the
  // tier). Probe-independent (selection only). undefined when unresolved.
  subjectCount?: number;
  // Their names ("ns/name"), for the footer tooltip.
  subjectEndpoints?: string[];
  // Highlight state when an endpoint is selected: subject = its end-of-tier
  // action runs in this tier; subjectEndpoint = which endpoint (tiers not in
  // the path are left as-is, not dimmed).
  subject?: boolean;
  subjectEndpoint?: string;
};

export function TierPillar({ data }: NodeProps) {
  const d = data as TierData;
  // Hover-anchored popover for the footer's subject-endpoint breakdown - a
  // title tooltip can't scroll and is dead on touch. Being a native popover
  // it renders in the top layer, so React Flow's zoom transform can't skew it.
  // Opens on hover (click too, for touch); a short grace timer keeps it open
  // while the pointer crosses the gap from the footer into the popover.
  const [open, setOpen] = useState<{ x: number; y: number } | null>(null);
  const closeTimer = useRef<number | undefined>(undefined);
  const cancelClose = () => window.clearTimeout(closeTimer.current);
  const scheduleClose = () => {
    cancelClose();
    closeTimer.current = window.setTimeout(() => setOpen(null), 150);
  };
  useEffect(() => cancelClose, []);
  const cls =
    'tier-pillar' +
    (d.reserved ? ' reserved' : '') +
    (d.defined ? '' : ' undefined-tier') +
    (d.subject ? ' subject' : '');
  return (
    <div className={cls}>
      <div className="tier-pillar-label">
        <span className="tier-name">{d.label}</span>
        {d.reserved ? <span className="tier-badge">reserved</span> : null}
        {!d.defined ? <span className="tier-badge warn">undefined</span> : null}
        <span className="tier-meta">
          {d.count} {d.count === 1 ? 'policy' : 'policies'}
        </span>
      </div>
      {d.defaultAction ? (
        <div
          className={'tier-pillar-footer ' + d.defaultAction.toLowerCase() + (d.subject ? ' subject' : '')}
          onMouseEnter={(e) => {
            cancelClose();
            if (!open) setOpen({ x: e.clientX, y: e.clientY });
          }}
          onMouseLeave={scheduleClose}
          onClick={(e) => {
            e.stopPropagation(); // don't bubble into React Flow's pane click
            cancelClose();
            if (!open) setOpen({ x: e.clientX, y: e.clientY });
          }}
        >
          {d.subject ? '◆ ' : ''}end of tier · {d.defaultAction}
          {d.subjectCount ? (
            <span className="tier-footer-count"> · {d.subjectCount} ⦿</span>
          ) : null}
        </div>
      ) : null}
      {open && d.defaultAction ? (
        <FooterPopover
          tier={d.label}
          action={d.defaultAction}
          subjectEndpoint={d.subject ? d.subjectEndpoint : undefined}
          endpoints={d.subjectEndpoints ?? []}
          at={open}
          onClose={() => setOpen(null)}
          onEnter={cancelClose}
          onLeave={scheduleClose}
        />
      ) : null}
    </div>
  );
}

// Scrollable, filterable breakdown of the endpoints a tier's end-of-tier
// action governs. Shares the .peek-popover chrome with the matrix cells.
function FooterPopover({
  tier,
  action,
  subjectEndpoint,
  endpoints,
  at,
  onClose,
  onEnter,
  onLeave,
}: {
  tier: string;
  action: 'Pass' | 'Deny';
  subjectEndpoint?: string;
  endpoints: string[];
  at: { x: number; y: number };
  onClose: () => void;
  onEnter: () => void; // hovering the popover cancels the pending close
  onLeave: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [q, setQ] = useState('');
  useAnchoredPopover(ref, at, onClose);
  useEffect(() => setQ(''), [at]);

  const rows = endpoints.filter((e) => e.includes(q));
  return (
    <div
      ref={ref}
      {...popoverProps}
      className="peek-popover"
      style={{ left: at.x + 8, top: at.y + 8 }}
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
    >
      <div className="mp-head">
        <span className="mp-pair">{tier} · end of tier → {action}</span>
        <span className="mp-agg">{endpoints.length} endpoint{endpoints.length === 1 ? '' : 's'}</span>
      </div>
      <div className="mp-note">
        {subjectEndpoint ? `${subjectEndpoint} reaches end of tier here. ` : ''}
        {action === 'Pass'
          ? 'if no rule matches, traffic for these endpoints falls through to the next tier:'
          : 'if no rule matches, traffic for these endpoints drops here:'}
      </div>
      <div className="mp-controls">
        <input placeholder="filter endpoints…" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      <div className="mp-list">
        {rows.map((e) => (
          <div key={e} className="mp-row">
            <span>{e}</span>
          </div>
        ))}
        {rows.length === 0 ? (
          <div className="muted">{endpoints.length === 0 ? 'no endpoints subject to this tier' : 'no endpoints match'}</div>
        ) : null}
      </div>
    </div>
  );
}
