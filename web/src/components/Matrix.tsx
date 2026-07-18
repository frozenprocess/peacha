// Connectivity grid aggregated across visible probes: rows are source
// endpoints, columns are dest endpoints, cell is allow-on-all (✓ green) /
// deny-on-all (✗ red) / mixed (n/m amber) / self (·). Clicking a cell opens
// a per-probe breakdown popover (scrollable, filterable - works on touch,
// unlike a hover tooltip). When `selectedNode` is set elsewhere (e.g. via
// the Graph view), that node's row/column is highlighted here too so the
// two views stay synced.

import { useEffect, useRef, useState } from 'react';
import { EditorResponse } from '../api';
import { popoverProps, useAnchoredPopover } from '../usePopover';
import peachaImg from '../assets/peacha.png';

interface Props {
  endpoints: string[]; // ordered list of pod IDs ("ns/name")
  systemIds: Set<string>;
  externalIds: Set<string>;
  hostIds: Set<string>;        // host endpoints (HEP or unpoliced host)
  unprotectedIds: Set<string>; // host endpoints with no HEP (unpoliced)
  response: EditorResponse | null;
  selected: string | null;
  onSelect: (id: string | null) => void;
  visibleProbes: Set<string>;
  hideSystem: boolean; // drop baseline/system rows + columns (shared w/ Graph)
}

// One popover shared by every cell: which pair is open + where to place it.
interface OpenCell {
  src: string;
  dst: string;
  x: number;
  y: number;
}

export function Matrix({ endpoints: allEndpoints, systemIds, externalIds, hostIds, unprotectedIds, response, selected, onSelect, visibleProbes, hideSystem }: Props) {
  const [openCell, setOpenCell] = useState<OpenCell | null>(null);

  if (!response)
    return (
      <div className="matrix-empty">
        <img src={peachaImg} alt="Peacha" className="matrix-empty-img" />
        <div className="muted">write a policy to start</div>
      </div>
    );
  if (allEndpoints.length === 0) return <div className="muted">add pods to see the matrix</div>;

  // The "hide system" lever (set in the Graph toolbar) drops the dimmed baseline
  // pods here too, so the two views show the same endpoint set.
  const endpoints = hideSystem ? allEndpoints.filter((id) => !systemIds.has(id)) : allEndpoints;
  if (endpoints.length === 0) return <div className="muted">all endpoints hidden - uncheck "hide system" in the graph</div>;

  // Per-endpoint kind: external ([EXT]) | host ([HEP]/[HOST]) | system (dimmed).
  const kindClass = (id: string) =>
    externalIds.has(id)
      ? 'external'
      : hostIds.has(id)
        ? 'host' + (unprotectedIds.has(id) ? ' unprotected' : '')
        : systemIds.has(id)
          ? 'system'
          : '';
  // The CLI's endpoint-type tag, shown on row headers (mirrors [HEP]/[HOST]/[EXT]).
  const kindTag = (id: string) =>
    externalIds.has(id)
      ? 'EXT'
      : hostIds.has(id)
        ? unprotectedIds.has(id)
          ? 'HOST'
          : 'HEP'
        : '';

  // One table aggregated across the visible probes (the legend chips in the
  // Graph toolbar pick which), instead of one giant table per probe.
  const matrices = Object.entries(response.matrices).filter(([probe]) => visibleProbes.has(probe));
  if (matrices.length === 0) return <div className="muted">no probes selected - toggle them in the graph legend</div>;

  return (
    <div className="matrices">
          <div className="matrix-block">
            <h3>{matrices.length === 1 ? matrices[0][0] : `${matrices.length} probes (✓/✗ = all probes agree, n/m = mixed)`}</h3>
            <table className="matrix">
              <thead>
                <tr>
                  <th />
                  {endpoints.map((d) => (
                    <th
                      key={d}
                      className={(selected === d ? 'sel ' : '') + kindClass(d)}
                      onClick={() => onSelect(selected === d ? null : d)}
                      title={kindTag(d) ? `${d} [${kindTag(d)}]` : d}
                    >
                      <span className="rotate">{d}</span>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {endpoints.map((s) => (
                  <tr
                    key={s}
                    className={(selected === s ? 'sel ' : '') + kindClass(s)}
                  >
                    <th
                      onClick={() => onSelect(selected === s ? null : s)}
                      className={(selected === s ? 'sel ' : '') + kindClass(s)}
                    >
                      {s}
                      {kindTag(s) ? <span className="kind-tag">{kindTag(s)}</span> : null}
                    </th>
                    {endpoints.map((d) => {
                      if (s === d) return <td key={d} className="self">·</td>;
                      const verdicts = matrices.map(([probe, m]) => [probe, m[`${s}->${d}`]] as const);
                      const allows = verdicts.filter(([, v]) => v === 'allow').length;
                      const cls = allows === verdicts.length ? 'allow' : allows === 0 ? 'deny' : 'mixed';
                      const dim =
                        selected !== null && selected !== s && selected !== d
                          ? ' dim'
                          : '';
                      return (
                        <td
                          key={d}
                          className={cls + dim}
                          title="click for per-probe detail"
                          onClick={(e) => setOpenCell({ src: s, dst: d, x: e.clientX, y: e.clientY })}
                        >
                          {cls === 'allow' ? '✓' : cls === 'deny' ? '✗' : `${allows}/${verdicts.length}`}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
      {openCell ? <CellPopover cell={openCell} matrices={matrices} onClose={() => setOpenCell(null)} /> : null}
    </div>
  );
}

// Per-probe breakdown for one cell. Native popover="auto" gives us the top
// layer + light dismiss (click outside / Esc) for free; a media query turns
// it into a bottom sheet on narrow screens.
function CellPopover({
  cell,
  matrices,
  onClose,
}: {
  cell: OpenCell;
  matrices: [string, Record<string, string>][];
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [q, setQ] = useState('');
  const [verdictFilter, setVerdictFilter] = useState<'all' | 'allow' | 'deny'>('all');

  useAnchoredPopover(ref, cell, onClose);

  // Reset filters whenever a different cell opens.
  useEffect(() => {
    setQ('');
    setVerdictFilter('all');
  }, [cell]);

  const verdicts = matrices.map(([probe, m]) => [probe, m[`${cell.src}->${cell.dst}`]] as const);
  const allows = verdicts.filter(([, v]) => v === 'allow').length;
  const rows = verdicts.filter(
    ([p, v]) => p.includes(q) && (verdictFilter === 'all' || v === verdictFilter),
  );

  // Initial spot next to the click; the effect above clamps it to the
  // viewport once the real size is known, and the mobile bottom-sheet media
  // query overrides both.
  const left = cell.x + 8;
  const top = cell.y + 8;

  return (
    <div ref={ref} {...popoverProps} className="peek-popover" style={{ left, top }}>
      <div className="mp-head">
        <span className="mp-pair">{cell.src} → {cell.dst}</span>
        <span className="mp-agg">{allows}/{verdicts.length} allow</span>
      </div>
      <div className="mp-controls">
        <input
          placeholder="filter probes…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <button
          className={'mp-chip allow' + (verdictFilter === 'allow' ? ' on' : '')}
          onClick={() => setVerdictFilter(verdictFilter === 'allow' ? 'all' : 'allow')}
        >
          ✓ {allows}
        </button>
        <button
          className={'mp-chip deny' + (verdictFilter === 'deny' ? ' on' : '')}
          onClick={() => setVerdictFilter(verdictFilter === 'deny' ? 'all' : 'deny')}
        >
          ✗ {verdicts.length - allows}
        </button>
      </div>
      <div className="mp-list">
        {rows.map(([p, v]) => (
          <div key={p} className={'mp-row ' + (v === 'allow' ? 'allow' : 'deny')}>
            <span>{p}</span>
            <span>{v === 'allow' ? '✓' : '✗'}</span>
          </div>
        ))}
        {rows.length === 0 ? <div className="muted">no probes match</div> : null}
      </div>
    </div>
  );
}
