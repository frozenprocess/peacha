// iptables / nftables view: renders the filter-table chains Felix would
// program for the current topology + policies, for a single backend (the tab
// fixes which - see App.tsx). Like the BPF view it fetches its own endpoint
// (/v1/iptables) on demand with filter controls (IP version, whether to
// include the static cali-INPUT/FORWARD/OUTPUT boilerplate), rather than
// riding the debounced /v1/evaluate loop.

import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import {
  EditorRequest,
  IptablesRenderOptions,
  IptablesResponse,
  RenderedDataplane,
  renderIptables,
} from '../api';
import { chainOrigin, Origin, splitJumpTargets } from '../coloring';
import { EndpointFilter } from './EndpointFilter';
import { Legend } from './Legend';

interface Props {
  request: EditorRequest;
  backend: 'iptables' | 'nftables';
  // Selected endpoint id from the matrix/graph, used to seed the filter so the
  // views stay loosely in sync (mirrors BPFView).
  selected: string | null;
}

const DEBOUNCE_MS = 350;

export function IptablesView({ request, backend, selected }: Props) {
  const [ipVersion, setIPVersion] = useState<'' | '4' | '6' | 'both'>('');
  const [includeStatic, setIncludeStatic] = useState(false);
  const [endpoint, setEndpoint] = useState('');
  const [resp, setResp] = useState<IptablesResponse | null>(null);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');

  // Seed the endpoint filter from the cross-view selection until the user types
  // their own filter (mirrors BPFView).
  const userTypedRef = useRef(false);
  useEffect(() => {
    if (!userTypedRef.current && selected) setEndpoint(selected);
  }, [selected]);

  const opts: IptablesRenderOptions = useMemo(
    () => ({ backend, ipVersion, includeStatic, endpoint: endpoint.trim() || undefined }),
    [backend, ipVersion, includeStatic, endpoint],
  );

  const abortRef = useRef<AbortController | null>(null);
  useEffect(() => {
    if (request.endpoints.length === 0) {
      abortRef.current?.abort(); // else a fetch already past debounce repopulates after flush
      setResp(null);
      return;
    }
    const timer = setTimeout(async () => {
      abortRef.current?.abort();
      const ac = new AbortController();
      abortRef.current = ac;
      setStatus('rendering…');
      try {
        const r = await renderIptables(request, opts, ac.signal);
        setResp(r);
        setStatus('');
        setError('');
      } catch (e: any) {
        if (e?.name === 'AbortError') return;
        setError(String(e));
        setStatus('');
      }
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [request, opts]);

  return (
    <div className="bpf-view">
      <div className="bpf-controls">
        <label>
          ip{' '}
          <select value={ipVersion} onChange={(e) => setIPVersion(e.target.value as any)}>
            <option value="">auto</option>
            <option value="4">v4</option>
            <option value="6">v6</option>
            <option value="both">both</option>
          </select>
        </label>
        <label title="include Felix's static cali-INPUT/FORWARD/OUTPUT entry chains (policy-independent boilerplate)">
          <input
            type="checkbox"
            checked={includeStatic}
            onChange={(e) => setIncludeStatic(e.target.checked)}
          />{' '}
          static chains
        </label>
        <EndpointFilter
          value={endpoint}
          onChange={(v) => {
            userTypedRef.current = true;
            setEndpoint(v);
          }}
          endpoints={request.endpoints.map((e) => e.id)}
          listId="ipt-endpoint-list"
          title="show only the chains that enforce endpoints whose id contains this substring (their per-endpoint + dispatch chains plus the policy/profile chains they reference)"
        />
        <span className={'status' + (error ? ' error' : '')}>{error || status}</span>
        <span
          className="bpf-note"
          title="What Felix programs into the filter table - distinct from the matrix verdict (which comes from the app-policy checker). Named ports / icmp type+code render natively here."
        >
          ⓘ dataplane render
        </span>
      </div>

      {resp?.errors?.length ? <div className="errors">{resp.errors.join('\n')}</div> : null}
      {resp?.warnings?.length ? (
        <div className="warnings">{resp.warnings.map((w, i) => <div key={i}>⚠ {w}</div>)}</div>
      ) : null}

      <Legend origins={iptOrigins(resp)} />

      <div className="bpf-programs">
        {!resp ? (
          <div className="muted">add pods to see chains</div>
        ) : resp.dataplanes.length === 0 ? (
          <div className="muted">nothing to render</div>
        ) : (
          resp.dataplanes.map((dp) => (
            <DataplaneBlock key={`${dp.backend}|${dp.ipVersion}`} dp={dp} />
          ))
        )}
      </div>
    </div>
  );
}

function DataplaneBlock({ dp }: { dp: RenderedDataplane }) {
  const [open, setOpen] = useState(true);
  const chainCount = dp.tables.reduce((n, t) => n + t.chains.length, 0);
  return (
    <div className="bpf-prog">
      <button className="bpf-prog-head" onClick={() => setOpen((o) => !o)}>
        <span className="bpf-tri">{open ? '▾' : '▸'}</span>
        <span className={'bpf-dir bpf-dir-' + dp.backend}>{dp.backend}</span>
        <span className="bpf-fam">IPv{dp.ipVersion}</span>
        <span className="muted bpf-meta">{chainCount} chains</span>
      </button>
      {open ? (
        // Each chain is its own block, left-bordered by its origin (policy /
        // endpoint / profile / dispatch / static), so it reads like an
        // iptables-restore file but color-attributes every chain. Within a
        // chain, --jump/--goto targets are tinted by the origin they point at.
        <div className="ipt-tables">
          {dp.tables.map((t) => (
            <Fragment key={t.table}>
              <div className="ipt-frame">*{t.table}</div>
              {t.chains.map((c) => {
                const origin = chainOrigin(c.name);
                return (
                  <pre key={c.name} className={'bpf-asm ipt-chain origin-' + origin}>
                    {c.lines.map((line, i) => (
                      <div key={i} className="ipt-line">
                        {splitJumpTargets(line).map((seg, j) =>
                          seg.refOrigin ? (
                            <span key={j} className={'origin-ref origin-' + seg.refOrigin}>
                              {seg.text}
                            </span>
                          ) : (
                            <Fragment key={j}>{seg.text}</Fragment>
                          ),
                        )}
                      </div>
                    ))}
                  </pre>
                );
              })}
              <div className="ipt-frame">COMMIT</div>
            </Fragment>
          ))}
        </div>
      ) : null}
    </div>
  );
}

// iptOrigins collects the chain origins present across all dataplanes, plus
// any origin referenced by a jump target, for the legend.
function iptOrigins(resp: IptablesResponse | null): Origin[] {
  if (!resp) return [];
  const out: Origin[] = [];
  for (const dp of resp.dataplanes) {
    for (const t of dp.tables) {
      for (const c of t.chains) {
        out.push(chainOrigin(c.name));
        for (const line of c.lines) {
          for (const seg of splitJumpTargets(line)) {
            if (seg.refOrigin) out.push(seg.refOrigin);
          }
        }
      }
    }
  }
  return out;
}
