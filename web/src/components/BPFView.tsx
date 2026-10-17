// eBPF policy-program view: renders the BPF programs Felix would JIT-assemble
// per endpoint × direction × IP family for the current topology + policies.
// Unlike the matrix/graph (which read the debounced /v1/evaluate response),
// this view fetches /v1/bpf on demand with its own filter controls, since the
// programs are per-endpoint disassembly rather than a connectivity verdict.

import { useEffect, useMemo, useRef, useState } from 'react';
import { BPFProgram, BPFRenderOptions, BPFResponse, EditorRequest, renderBPF } from '../api';
import { bpfTreeLines, categorizeBPF, ColoredLine, Origin } from '../coloring';
import { EndpointFilter } from './EndpointFilter';
import { Legend } from './Legend';

interface Props {
  // The merged wire request (topology + policies + resources). The BPF view
  // ignores probes server-side; we send the whole thing for simplicity.
  request: EditorRequest;
  // Selected endpoint id from the matrix/graph, used to seed the filter so the
  // three views stay loosely in sync.
  selected: string | null;
}

const DEBOUNCE_MS = 350;

export function BPFView({ request, selected }: Props) {
  const [direction, setDirection] = useState<'both' | 'ingress' | 'egress'>('both');
  const [ipVersion, setIPVersion] = useState<'' | '4' | '6' | 'both'>('');
  const [endpoint, setEndpoint] = useState('');
  // Concise tier→policy→rule tree by default (à la `calico-node bpf policy
  // dump`); the assembly toggle switches to the full eBPF disassembly.
  const [verbose, setVerbose] = useState(false);
  const [resp, setResp] = useState<BPFResponse | null>(null);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');

  // Seed the endpoint filter from the cross-view selection on first mount /
  // when it changes (only if the user hasn't typed their own filter).
  const userTypedRef = useRef(false);
  useEffect(() => {
    if (!userTypedRef.current && selected) setEndpoint(selected);
  }, [selected]);

  const opts: BPFRenderOptions = useMemo(
    () => ({ direction, ipVersion, endpoint: endpoint.trim() || undefined, verbose }),
    [direction, ipVersion, endpoint, verbose],
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
        const r = await renderBPF(request, opts, ac.signal);
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
          direction{' '}
          <select value={direction} onChange={(e) => setDirection(e.target.value as any)}>
            <option value="both">both</option>
            <option value="ingress">ingress</option>
            <option value="egress">egress</option>
          </select>
        </label>
        <label>
          ip{' '}
          <select value={ipVersion} onChange={(e) => setIPVersion(e.target.value as any)}>
            <option value="">auto</option>
            <option value="4">v4</option>
            <option value="6">v6</option>
            <option value="both">both</option>
          </select>
        </label>
        <EndpointFilter
          value={endpoint}
          onChange={(v) => {
            userTypedRef.current = true;
            setEndpoint(v);
          }}
          endpoints={request.endpoints.map((e) => e.id)}
          listId="bpf-endpoint-list"
        />
        <label title="Show the full eBPF disassembly instead of the concise tier → policy → rule tree (like `calico-node bpf policy dump --asm`).">
          <input type="checkbox" checked={verbose} onChange={(e) => setVerbose(e.target.checked)} /> assembly
        </label>
        <span className={'status' + (error ? ' error' : '')}>{error || status}</span>
        <span className="bpf-note" title="eBPF policy is per-endpoint, per-direction, per-family. This renders only the policy program Felix assembles; the rest of the BPF dataplane (conntrack, NAT, tc plumbing) is precompiled C.">
          ⓘ policy program only
        </span>
      </div>

      {resp?.errors?.length ? <div className="errors">{resp.errors.join('\n')}</div> : null}
      {resp?.warnings?.length ? (
        <div className="warnings">{resp.warnings.map((w, i) => <div key={i}>⚠ {w}</div>)}</div>
      ) : null}

      <Legend origins={bpfOrigins(resp)} />

      <div className="bpf-programs">
        {!resp ? (
          <div className="muted">add pods to see programs</div>
        ) : resp.programs.length === 0 ? (
          <div className="muted">no endpoints matched the filter</div>
        ) : (
          resp.programs.map((p) => (
            <ProgramBlock key={`${p.endpoint}|${p.direction}|${p.ipVersion}`} prog={p} verbose={verbose} />
          ))
        )}
      </div>
    </div>
  );
}

function ProgramBlock({ prog, verbose }: { prog: BPFProgram; verbose: boolean }) {
  // The verbose disassembly can be long (100+ instructions), so collapse it by
  // default to keep the list of (endpoint, direction, family) headers
  // scannable; the concise tree is short, so expand it.
  const [open, setOpen] = useState(!verbose);
  return (
    <div className="bpf-prog">
      <button className="bpf-prog-head" onClick={() => setOpen((o) => !o)}>
        <span className="bpf-tri">{open ? '▾' : '▸'}</span>
        <code>{prog.endpoint}</code>
        <span className={'bpf-dir bpf-dir-' + prog.direction}>{prog.direction}</span>
        <span className="bpf-fam">IPv{prog.ipVersion}</span>
        <span className="muted bpf-meta">
          {prog.instructions ?? 0} insns{(prog.subPrograms ?? 0) > 1 ? ` · ${prog.subPrograms} sub-progs` : ''}
          {prog.error ? ' · error' : ''}
        </span>
      </button>
      {open ? (
        prog.error ? (
          <pre className="bpf-asm error">{prog.error}</pre>
        ) : (
          <pre className="bpf-asm">
            {programLines(prog).map((cl, i) => (
              <div key={i} className={'asm-line origin-' + cl.origin}>
                {cl.text || ' '}
              </div>
            ))}
          </pre>
        )
      ) : null}
    </div>
  );
}

// bpfOrigins collects the origins present across all programs, for the legend.
function bpfOrigins(resp: BPFResponse | null): Origin[] {
  if (!resp) return [];
  const out: Origin[] = [];
  for (const p of resp.programs) {
    if (p.error) continue;
    for (const cl of programLines(p)) out.push(cl.origin);
  }
  return out;
}

// programLines colors whichever form the engine returned: the verbose
// disassembly as text lines, or the concise tree as structured tiers/profiles.
function programLines(p: BPFProgram): ColoredLine[] {
  return p.lines?.length ? categorizeBPF(p.lines) : bpfTreeLines(p.tiers, p.profiles);
}
