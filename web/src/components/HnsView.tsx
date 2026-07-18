// HNS view: renders the Windows HNS (Host Networking Service) ACL policy lists
// Felix would install on a Windows node for the current topology + policies,
// per endpoint × direction. Like the BPF and iptables views it fetches its own
// endpoint (/v1/hns) on demand with filter controls (direction, endpoint),
// rather than riding the debounced /v1/evaluate loop. HNS is IPv4-only, so the
// IP-version knob is omitted (the engine warns if v6 is requested anyway).

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  EditorRequest,
  HNSEndpointPolicy,
  HNSRenderOptions,
  HNSResponse,
  renderHNS,
} from '../api';
import { EndpointFilter } from './EndpointFilter';

interface Props {
  request: EditorRequest;
  // Selected endpoint id from the matrix/graph, used to seed the filter so the
  // views stay loosely in sync (mirrors BPFView/IptablesView).
  selected: string | null;
}

const DEBOUNCE_MS = 350;

export function HnsView({ request, selected }: Props) {
  const [direction, setDirection] = useState<'' | 'ingress' | 'egress' | 'both'>('');
  const [endpoint, setEndpoint] = useState('');
  const [resp, setResp] = useState<HNSResponse | null>(null);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');

  // Seed the endpoint filter from the cross-view selection until the user types
  // their own filter (mirrors IptablesView).
  const userTypedRef = useRef(false);
  useEffect(() => {
    if (!userTypedRef.current && selected) setEndpoint(selected);
  }, [selected]);

  const opts: HNSRenderOptions = useMemo(
    () => ({ direction: direction || undefined, endpoint: endpoint.trim() || undefined }),
    [direction, endpoint],
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
        const r = await renderHNS(request, opts, ac.signal);
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
          dir{' '}
          <select value={direction} onChange={(e) => setDirection(e.target.value as any)}>
            <option value="">both</option>
            <option value="ingress">ingress</option>
            <option value="egress">egress</option>
          </select>
        </label>
        <EndpointFilter
          value={endpoint}
          onChange={(v) => {
            userTypedRef.current = true;
            setEndpoint(v);
          }}
          endpoints={request.endpoints.map((e) => e.id)}
          listId="hns-endpoint-list"
          title="show only the ACL lists for endpoints whose id contains this substring"
        />
        <span className={'status' + (error ? ' error' : '')}>{error || status}</span>
        <span
          className="bpf-note"
          title="The flattened, priority-rewritten HNS ACLPolicy list Felix hands to the Windows Host Networking Service on a Windows node (IPv4 only). Addresses are inlined - HNS has no named IP sets."
        >
          ⓘ HNS ACL render
        </span>
      </div>

      {resp?.errors?.length ? <div className="errors">{resp.errors.join('\n')}</div> : null}
      {resp?.warnings?.length ? (
        <div className="warnings">{resp.warnings.map((w, i) => <div key={i}>⚠ {w}</div>)}</div>
      ) : null}

      <div className="bpf-programs">
        {!resp ? (
          <div className="muted">add pods to see HNS ACLs</div>
        ) : resp.endpoints.length === 0 ? (
          <div className="muted">nothing to render</div>
        ) : (
          resp.endpoints.map((ep) => (
            <EndpointBlock key={`${ep.endpoint}|${ep.direction}`} ep={ep} />
          ))
        )}
      </div>
    </div>
  );
}

function EndpointBlock({ ep }: { ep: HNSEndpointPolicy }) {
  const [open, setOpen] = useState(true);
  return (
    <div className="bpf-prog">
      <button className="bpf-prog-head" onClick={() => setOpen((o) => !o)}>
        <span className="bpf-tri">{open ? '▾' : '▸'}</span>
        <span className={'bpf-dir bpf-dir-' + ep.direction}>{ep.direction}</span>
        <span className="bpf-fam">{ep.endpoint}</span>
        <span className="muted bpf-meta">
          {ep.interface} · IPv{ep.ipVersion} · {ep.rules.length} rules
        </span>
      </button>
      {open ? (
        <>
          {ep.error ? <div className="errors">{ep.error}</div> : null}
          <pre className="bpf-asm hns-acl">
            {ep.rules.length === 0 ? (
              <div className="muted">no rules</div>
            ) : (
              ep.rules.map((r, i) => (
                <div key={i} className="hns-rule">
                  {fmtRule(r)}
                </div>
              ))
            )}
          </pre>
        </>
      ) : null}
    </div>
  );
}

// fmtRule renders one HNS rule as a single compact `Key=value` line. The rule
// IS telepathy's HNSRule, which reproduces hcsshim's ACLPolicy field-for-field
// (the literal blob Felix hands to HNS, in struct/field order), so we render
// whatever keys are present rather than naming them — a field rename or addition
// upstream just shows up, nothing to keep in sync. Empty/absent fields are
// dropped (they carry `omitempty` on the Go side anyway). Protocol 256 is HNS
// for "any".
function fmtRule(r: Record<string, any>): string {
  return Object.entries(r)
    .filter(([, v]) => v !== '' && v != null)
    .map(([k, v]) => `${k}=${k === 'Protocol' && v === 256 ? 'any' : v}`)
    .join('  ');
}
