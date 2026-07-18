// Tier view: a policy-structure layout (not a connectivity graph). One vertical
// pillar per policy tier, ordered left→right by tier order (lower order = higher
// precedence = leftmost), each pillar holding the policies it includes, sorted
// by policy order. Positions are computed deterministically here - the tier
// view bypasses ELK (see Graph.tsx / useElkLayout) since pillars are a fixed
// grid, not a packed topology.
//
// This module is the VIEW: it lays out React-Flow nodes. The data it lays out -
// which tiers exist, their order/defaultAction, and how policies parse into
// them - comes from ../tierModel, the single source of truth shared with the
// tier tab and the editor's spec.tier autocomplete.

import { type Node } from '@xyflow/react';
import { PolicyInput, TierInput, TierMatchResponse } from '../api';
import { engineKey, ParsedPolicy, parsePolicies, resolveTiers } from '../tierModel';
import { BuiltGraph } from './buildGraph';

// --- pillar layout ---------------------------------------------------------

const HEADER_H = 40; // tier label band at the top of a pillar
const CARD_H = 56;
const CARD_GAP = 8;
const CARD_W = 200;
const PAD_X = 12;
const PAD_BOTTOM = 12;
const FOOTER_H = 24; // end-of-tier default-action band at the bottom
const PILLAR_W = CARD_W + 2 * PAD_X;
const PILLAR_GAP = 28;
const EMPTY_BODY = 34; // body height for a tier with no policies

interface TierMeta {
  order: number;
  defaultAction?: 'Pass' | 'Deny';
  reserved: boolean;
  defined: boolean; // false when a policy references a tier that isn't defined
}

// buildTierGraph turns the policies + tier definitions into pillar + card
// nodes. No edges - the tier view is structural, not a connectivity map. When
// an endpoint is selected (and the engine resolved its matches), cards it
// matches and tiers it's subject to are flagged so the view can highlight them
// and dim the rest.
export function buildTierGraph(
  policies: PolicyInput[],
  tiers: TierInput[],
  selected: string | null,
  tierMatches: TierMatchResponse | null,
  labelsById: Map<string, Record<string, string>> = new Map(),
): BuiltGraph {
  // "prod/backend (app=backend)" - tierMatches only carries endpoint ids, so
  // labels come from the topology the SPA already holds.
  const withLabels = (id: string) => {
    const l = Object.entries(labelsById.get(id) ?? {});
    return l.length ? `${id} (${l.map(([k, v]) => `${k}=${v}`).join(',')})` : id;
  };
  const parsed = parsePolicies(policies);

  // Resolve the selected endpoint's footprint. HEPs now resolve (host/<name>);
  // undefined only for an external selection (not a policy subject) or none.
  const sel =
    selected && tierMatches ? tierMatches.endpoints.find((e) => e.endpoint === selected) : undefined;
  const selectionActive = !!sel;
  const matchedKeys = new Set((sel?.policies ?? []).map((r) => `${r.kind}|${r.namespace}|${r.name}`));
  const subjectTiers = new Set(sel?.tiers ?? []);

  // Per-policy endpoint footprint: invert tierMatches (endpoint → policies it
  // selects) into policy → count of endpoints it selects. Keyed the same way as
  // engineKey so cards can look themselves up. Only when the engine resolved
  // matches (tier view active, valid YAML); undefined otherwise so cards show no
  // stale count. Includes whatever endpoints the engine returns (workloads, and
  // HostEndpoints once the engine reports them).
  const affectedByKey = new Map<string, number>();
  for (const e of tierMatches?.endpoints ?? []) {
    for (const r of e.policies ?? []) {
      const k = `${r.kind}|${r.namespace}|${r.name}`;
      affectedByKey.set(k, (affectedByKey.get(k) ?? 0) + 1);
    }
  }
  // Per-tier subject count: how many endpoints each tier's end-of-tier action
  // GOVERNS - i.e. a policy in the tier selects them, so the tier's default
  // action is in their evaluation path. This is selection only (probe-
  // independent), unlike a flow count: the matrix probes a single (protocol,
  // port), so a flow tally silently omits traffic on other ports. It does NOT
  // exclude endpoints a rule may decide - that's traffic-specific and needs a
  // probe - so it reads as "governed by this tier", not "dropped here".
  const subjectsByTier = new Map<string, string[]>();
  for (const e of tierMatches?.endpoints ?? []) {
    for (const tn of e.tiers ?? []) {
      const arr = subjectsByTier.get(tn);
      if (arr) arr.push(e.endpoint);
      else subjectsByTier.set(tn, [e.endpoint]);
    }
  }

  // The tier ladder (reserved + custom + pasted + referenced-undefined) comes
  // from the shared resolver, projected into the layout's TierMeta shape.
  const meta = new Map<string, TierMeta>();
  for (const t of resolveTiers(policies, tiers)) {
    meta.set(t.name, {
      order: t.order,
      defaultAction: t.defaultAction,
      reserved: t.source === 'reserved',
      defined: t.source !== 'referenced',
    });
  }

  // Group policies by tier (sorted within a tier by order then name).
  const byTier = new Map<string, ParsedPolicy[]>();
  for (const p of parsed) {
    const arr = byTier.get(p.tier);
    if (arr) arr.push(p);
    else byTier.set(p.tier, [p]);
  }
  for (const arr of byTier.values()) {
    arr.sort((a, b) => (a.order ?? Infinity) - (b.order ?? Infinity) || a.name.localeCompare(b.name));
  }

  // Show a pillar for every tier: the three reserved tiers (which always
  // exist on the cluster), every user-defined tier, and any tier a policy
  // references - empty or not. This mirrors the TIERS pane so the tier ladder
  // is visible even before policies are added. Ordered by tier order (lower =
  // higher precedence = leftmost).
  const shown = Array.from(meta.entries()).sort(
    (a, b) => a[1].order - b[1].order || a[0].localeCompare(b[0]),
  );

  const pillars: Node[] = [];
  const cards: Node[] = [];
  shown.forEach(([name, m], col) => {
    const pols = byTier.get(name) ?? [];
    const bodyH = pols.length > 0 ? pols.length * (CARD_H + CARD_GAP) : EMPTY_BODY;
    // Reserve a bottom band for the end-of-tier default action (only tiers that
    // declare one - a referenced-but-undefined tier has none).
    const footerH = m.defaultAction ? FOOTER_H : 0;
    const height = HEADER_H + bodyH + PAD_BOTTOM + footerH;
    const subject = selectionActive ? subjectTiers.has(name) : undefined;
    pillars.push({
      id: `tier:${name}`,
      type: 'tierGroup',
      position: { x: col * (PILLAR_W + PILLAR_GAP), y: 0 },
      style: { width: PILLAR_W, height },
      selectable: false,
      draggable: false,
      data: {
        label: name,
        order: m.order,
        defaultAction: m.defaultAction,
        reserved: m.reserved,
        defined: m.defined,
        count: pols.length,
        // Endpoints this tier's end-of-tier action governs (subject to the tier).
        // undefined when matches are unresolved, so no stale count shows.
        subjectCount: tierMatches ? (subjectsByTier.get(name)?.length ?? 0) : undefined,
        // Their names + labels, for the footer tooltip ("who is about to drop here").
        subjectEndpoints: tierMatches ? (subjectsByTier.get(name) ?? []).map(withLabels) : undefined,
        // Highlight state for the selected endpoint: subject = its end-of-tier
        // action runs here. No dimming - absence of highlight already reads as
        // "not in the path", and greying the ladder made it look disabled.
        subject,
        subjectEndpoint: subject ? selected : undefined,
      },
    });
    pols.forEach((p, row) => {
      const matched = selectionActive ? matchedKeys.has(engineKey(p)) : undefined;
      cards.push({
        id: `pol:${p.index}`,
        type: 'policyNode',
        parentId: `tier:${name}`,
        extent: 'parent',
        position: { x: PAD_X, y: HEADER_H + row * (CARD_H + CARD_GAP) },
        style: { width: CARD_W, height: CARD_H },
        selectable: false,
        draggable: false,
        data: {
          name: p.name,
          kind: p.kind,
          namespace: p.namespace,
          selector: p.selector,
          order: p.order,
          flavor: p.flavor,
          staged: p.staged,
          hook: p.hook,
          actions: p.actions,
          affected: tierMatches ? (affectedByKey.get(engineKey(p)) ?? 0) : undefined,
          // Highlight state for the selected endpoint: matched = this policy
          // selects it. No dimming (see the pillar note above).
          matched,
        },
      });
    });
  });

  return { nodes: [...pillars, ...cards], edges: [], layoutEdges: [] };
}
