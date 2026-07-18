// The single source of endpoint typing for the rendered views.
//
// Policy evaluation already has one oracle (the engine, via /v1/evaluate). The
// SECOND thing every view needs - "is this row the internet? a host? a HEP?" -
// used to be re-derived independently in App.tsx, Matrix.tsx and buildGraph.ts
// (and again, differently, in harness.py), which is how the Matrix and Graph
// drifted apart. The engine now returns that typing alongside the matrix
// (EditorResponse.actors); buildImpact projects it into the id-Sets the Matrix
// and Graph consume, so both render from one authoritative classification.
//
// systemIds is deliberately NOT here: "system" means "belongs to the embedded
// baseline layer", a display concern (dimming) the engine has no notion of. It
// stays computed in App.tsx from baseline membership.

import { EditorResponse, Endpoint, Probe } from './api';

export interface ImpactModel {
  externalIds: Set<string>; // kind === 'external'        → [EXT]
  hostIds: Set<string>; // kind === 'hep' | 'host-unpoliced' → bands + [HEP]/[HOST]
  unprotectedIds: Set<string>; // kind === 'host-unpoliced'   → [HOST] (no HEP)
}

const EMPTY: ImpactModel = {
  externalIds: new Set(),
  hostIds: new Set(),
  unprotectedIds: new Set(),
};

export function buildImpact(response: EditorResponse | null): ImpactModel {
  const actors = response?.actors;
  if (!actors || actors.length === 0) return EMPTY;

  const externalIds = new Set<string>();
  const hostIds = new Set<string>();
  const unprotectedIds = new Set<string>();
  for (const a of actors) {
    switch (a.kind) {
      case 'external':
        externalIds.add(a.id);
        break;
      case 'hep':
        hostIds.add(a.id);
        break;
      case 'host-unpoliced':
        hostIds.add(a.id);
        unprotectedIds.add(a.id);
        break;
    }
  }
  return { externalIds, hostIds, unprotectedIds };
}

// --- per-port reachability (hover tooltip) ---------------------------------

export interface PortStatus {
  /** Display label: the declared port name when present, else just the tuple
   *  (e.g. "http · tcp:8080" or "tcp:5432"). */
  label: string;
  state: 'open' | 'closed' | 'unprobed';
}

// probeKey is the (protocol, port) tuple both a declared EndpointPort and a
// Probe reduce to - the join key between "ports a workload exposes" and "ports
// the engine evaluated". Empty protocol means tcp (engine default).
function probeKey(protocol: string | undefined, port: number): string {
  return `${(protocol || 'tcp').toLowerCase()}:${port}`;
}

// probeIndex maps each probe's (proto, port) tuple to its matrix key (the probe
// NAME). Built from the probe set rather than assuming name===tuple, so a
// user-renamed probe still resolves. First writer wins on a duplicate tuple.
export function probeIndex(probes: Probe[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const p of probes) {
    const k = probeKey(p.protocol, p.port);
    if (!m.has(k)) m.set(k, p.name);
  }
  return m;
}

// portStatusFor - pure read: an endpoint's DECLARED ports × the engine's
// matrices → per-port ingress reachability for the hover tooltip. It computes
// nothing about allow/deny itself; it only looks up verdicts the engine already
// returned (matrices is the single connectivity oracle), so it can't drift from
// the Matrix/Graph. Like buildImpact, this is a projection, not a second oracle.
//   open     - ≥1 source has an allowed flow INTO this endpoint on the probe
//              matching the port (protocol + number).
//   closed   - a probe covers the port but every source is denied.
//   unprobed - no probe covers the port, so the engine produced no verdict
//              (shown rather than guessed, to keep the single-oracle rule).
// Matrix visibility is deliberately ignored: a port's reachability is a fact of
// the policy, not of which probes the user is currently viewing.
export function portStatusFor(
  response: EditorResponse | null,
  endpoint: Endpoint,
  probeByKey: Map<string, string>,
): PortStatus[] {
  const ports = endpoint.ports ?? [];
  if (ports.length === 0) return [];
  return ports.map((p) => {
    const tuple = probeKey(p.protocol, p.port);
    const label = p.name ? `${p.name} · ${tuple}` : tuple;
    const probe = response ? probeByKey.get(tuple) : undefined;
    const matrix = probe ? response!.matrices[probe] : undefined;
    if (!matrix) return { label, state: 'unprobed' as const };
    // Scan the dest COLUMN: any allowed `src->endpoint.id` (excluding self) ⇒ open.
    const suffix = `->${endpoint.id}`;
    let open = false;
    for (const [pair, result] of Object.entries(matrix)) {
      if (result !== 'allow' || !pair.endsWith(suffix)) continue;
      if (pair.slice(0, -suffix.length) === endpoint.id) continue; // self
      open = true;
      break;
    }
    return { label, state: open ? ('open' as const) : ('closed' as const) };
  });
}
