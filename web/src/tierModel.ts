// Single source of truth for "what tiers exist, in what order, and which
// policies live in each". Every view that reasons about tiers - the graph's
// tier pillars (graph/tiers.ts), the tier tab (TopologyPane), and the policy
// editor's spec.tier autocomplete (App.tsx) - derives from the functions here
// rather than re-merging RESERVED_TIERS + request.tiers + pasted Tier docs on
// its own. That kept the three from drifting (e.g. a pasted `kind: Tier`
// showing in the graph but not the tab). This module is pure data + YAML
// parsing - no React, no layout - so it stays the neutral layer the views share.

import { parse } from 'yaml';
import { ActionKind, actionKind } from './actionColors';
import { PolicyInput, RESERVED_TIERS, TierInput } from './api';

// Kinds we treat as policies (Calico + k8s, incl. staged variants and the NPA
// ClusterNetworkPolicy). Anything else in the YAML stream (Tier, NetworkSet, …)
// is not a policy card.
const POLICY_KINDS = new Set([
  'NetworkPolicy',
  'GlobalNetworkPolicy',
  'StagedNetworkPolicy',
  'StagedGlobalNetworkPolicy',
  'StagedKubernetesNetworkPolicy',
  'ClusterNetworkPolicy',
]);

// A Kubernetes NPA ClusterNetworkPolicy's spec.tier (Admin | Baseline) maps onto
// Calico's reserved tiers - the engine places them in kube-admin / kube-baseline
// (see RESERVED_TIERS in api.ts). default holds k8s NPs + Calico (G)NPs.
const CNP_TIER: Record<string, string> = { Admin: 'kube-admin', Baseline: 'kube-baseline' };

export interface ParsedPolicy {
  index: number; // position in the policies array (stable id)
  kind: string;
  name: string;
  namespace?: string;
  tier: string;
  order?: number;
  selector?: string;
  flavor: 'k8s' | 'calico' | 'cnp';
  staged: boolean;
  // HEP enforcement hook (Calico GlobalNetworkPolicy only). preDNAT / doNotTrack
  // / applyOnForward rules are evaluated BEFORE the normal tier chain regardless
  // of the policy's tier order, so the tier pillars (laid out by order) can't
  // convey it - the tier view badges these cards instead. undefined = a normal
  // policy that runs in tier order.
  hook?: 'preDNAT' | 'doNotTrack' | 'applyOnForward';
  // Distinct rule actions this policy carries (ingress ∪ egress), in canonical
  // order deny→allow→pass→log. Drives the policy card's action-coloured left
  // border. A k8s NetworkPolicy is allow-only, so it's always ['allow'].
  actions: ActionKind[];
}

// policyActions collects the distinct rule actions of a Calico/NPA policy spec,
// canonically ordered. k8s NetworkPolicies express allow-lists (no per-rule
// action field), so they report ['allow'].
function policyActions(spec: Record<string, unknown>, isK8s: boolean): ActionKind[] {
  if (isK8s) return ['allow'];
  const rules = [
    ...(Array.isArray(spec.ingress) ? spec.ingress : []),
    ...(Array.isArray(spec.egress) ? spec.egress : []),
  ];
  const kinds = new Set<ActionKind>();
  for (const r of rules) {
    const k = actionKind((r as { action?: string })?.action);
    if (k) kinds.add(k);
  }
  return (['deny', 'allow', 'pass', 'log'] as ActionKind[]).filter((k) => kinds.has(k));
}

// parsePolicies extracts the structural fields the tier view needs from each
// policy's raw YAML. Invalid/partial docs (mid-edit) and non-policy kinds are
// dropped.
export function parsePolicies(policies: PolicyInput[]): ParsedPolicy[] {
  const out: ParsedPolicy[] = [];
  policies.forEach((p, index) => {
    let doc: any;
    try {
      doc = parse(p.yaml);
    } catch {
      return;
    }
    if (!doc || typeof doc !== 'object') return;
    const kind: string = typeof doc.kind === 'string' ? doc.kind : '';
    if (!POLICY_KINDS.has(kind)) return;

    const meta = (doc.metadata ?? {}) as Record<string, unknown>;
    const spec = (doc.spec ?? {}) as Record<string, unknown>;
    const name = typeof meta.name === 'string' ? meta.name : '(unnamed)';

    // NPA ClusterNetworkPolicy: cluster-scoped, tier from Admin/Baseline,
    // ordered by spec.priority, subject = namespace/pod selectors.
    if (kind === 'ClusterNetworkPolicy') {
      const t = typeof spec.tier === 'string' ? (spec.tier as string) : 'Admin';
      out.push({
        index,
        kind,
        tier: CNP_TIER[t] ?? 'kube-admin',
        name,
        order: typeof spec.priority === 'number' ? (spec.priority as number) : undefined,
        selector: npaSubjectSummary(spec.subject),
        flavor: 'cnp',
        staged: false,
        actions: policyActions(spec, false),
      });
      return;
    }

    const isK8s = p.flavor === 'k8s' || kind === 'StagedKubernetesNetworkPolicy';
    // k8s NetworkPolicies always enforce in the default tier; a Calico policy
    // names its tier in spec.tier (default "default").
    const tier = isK8s
      ? 'default'
      : typeof spec.tier === 'string' && spec.tier
        ? (spec.tier as string)
        : 'default';
    const selector = isK8s
      ? labelSelectorSummary(spec.podSelector) ?? 'all()'
      : typeof spec.selector === 'string'
        ? (spec.selector as string)
        : undefined;

    // HEP enforcement hook (Calico only). preDNAT and doNotTrack both imply
    // applyOnForward; preDNAT is the earliest-firing hook, so it wins the label,
    // then doNotTrack, then a plain applyOnForward.
    const hook = isK8s
      ? undefined
      : spec.preDNAT === true
        ? 'preDNAT'
        : spec.doNotTrack === true
          ? 'doNotTrack'
          : spec.applyOnForward === true
            ? 'applyOnForward'
            : undefined;

    out.push({
      index,
      kind,
      name,
      namespace: typeof meta.namespace === 'string' ? meta.namespace : undefined,
      tier,
      order: typeof spec.order === 'number' ? spec.order : undefined,
      selector,
      flavor: isK8s ? 'k8s' : 'calico',
      staged: kind.startsWith('Staged'),
      hook,
      actions: policyActions(spec, isK8s),
    });
  });
  return out;
}

export interface ParsedTier {
  name: string;
  order: number;
  defaultAction: 'Pass' | 'Deny';
}

// parseTiers extracts user-defined Tier definitions pasted into the policy
// stream (kind: Tier). The engine already consumes these - feedPolicy's Tier
// case feeds them to the calc graph. Invalid/partial docs (mid-edit) and
// unnamed tiers are skipped, mirroring parsePolicies. defaultAction defaults to
// Deny - Calico's CRD default, matching the server's tierYAML rendering.
export function parseTiers(policies: PolicyInput[]): ParsedTier[] {
  const out: ParsedTier[] = [];
  for (const p of policies) {
    let doc: any;
    try {
      doc = parse(p.yaml);
    } catch {
      continue;
    }
    if (!doc || typeof doc !== 'object' || doc.kind !== 'Tier') continue;
    const meta = (doc.metadata ?? {}) as Record<string, unknown>;
    const spec = (doc.spec ?? {}) as Record<string, unknown>;
    const name = typeof meta.name === 'string' ? meta.name : '';
    if (!name) continue;
    out.push({
      name,
      order: typeof spec.order === 'number' ? (spec.order as number) : 1_000_000,
      defaultAction: spec.defaultAction === 'Pass' ? 'Pass' : 'Deny',
    });
  }
  return out;
}

// labelSelectorSummary renders a k8s-style {matchLabels} object as a Calico-like
// selector string ("k == v && …"), or undefined when there are no matchLabels.
function labelSelectorSummary(sel: unknown): string | undefined {
  if (!sel || typeof sel !== 'object') return undefined;
  const ml = (sel as Record<string, unknown>).matchLabels;
  if (ml && typeof ml === 'object') {
    const parts = Object.entries(ml as Record<string, unknown>).map(
      ([k, v]) => `${k} == "${v}"`,
    );
    if (parts.length) return parts.join(' && ');
  }
  return undefined;
}

// npaSubjectSummary renders an NPA ClusterNetworkPolicy spec.subject (either a
// namespaces selector or a pods {namespaceSelector, podSelector}).
function npaSubjectSummary(subject: unknown): string | undefined {
  if (!subject || typeof subject !== 'object') return undefined;
  const s = subject as Record<string, unknown>;
  if (s.namespaces !== undefined) {
    return 'ns: ' + (labelSelectorSummary(s.namespaces) ?? 'all()');
  }
  if (s.pods && typeof s.pods === 'object') {
    const p = s.pods as Record<string, unknown>;
    const ns = labelSelectorSummary(p.namespaceSelector);
    const pod = labelSelectorSummary(p.podSelector) ?? 'all()';
    return (ns ? `ns: ${ns} / ` : '') + `pods: ${pod}`;
  }
  return undefined;
}

// engineKey reproduces the engine's policy identity (Kind|Namespace|Name) for a
// parsed policy, so a TierMatch PolicyRef from /v1/tiers can be matched against
// the cards. The engine normalises Kind by flavor; Name is the verbatim
// metadata.name; Namespace is "" for cluster-scoped kinds.
export function engineKey(p: ParsedPolicy): string {
  const kind =
    p.kind === 'ClusterNetworkPolicy'
      ? 'KubernetesClusterNetworkPolicy'
      : p.flavor === 'k8s'
        ? 'KubernetesNetworkPolicy'
        : p.kind;
  return `${kind}|${p.namespace ?? ''}|${p.name}`;
}

// --- tier resolution (the single source of truth) --------------------------

// Where a tier in the resolved ladder came from. Only 'custom' is editable in
// the tier tab; the rest are read-only (reserved = engine built-in, pasted =
// defined in the policy YAML, referenced = named by a policy's spec.tier but
// never defined anywhere - an error state worth surfacing).
export type TierSource = 'reserved' | 'custom' | 'pasted' | 'referenced';

export interface ResolvedTier {
  name: string;
  order: number;
  defaultAction?: 'Pass' | 'Deny';
  source: TierSource;
  // Index into request.tiers for source==='custom', so the tier tab's edit
  // controls map back through the precedence sort. Undefined for other sources.
  customIndex?: number;
}

// Order assigned to a referenced-but-undefined tier so it sorts just ahead of
// "default" (1M) and stays visible as an error rather than vanishing.
const UNDEFINED_TIER_ORDER = 999_000;

// resolveTiers is THE function that answers "what tiers exist and in what
// precedence". It folds the three definition sources plus error-state
// references into one ordered ladder, deduped by name:
//
//   referenced (lowest) → pasted → custom → reserved (highest, never overridden)
//
// Reserved tiers are authoritative - the engine always pre-creates them - so a
// same-named custom/pasted tier doesn't replace one (a degenerate case; the
// engine would ignore the duplicate too). Result is sorted by order then name:
// lower order = higher precedence = leftmost pillar / topmost tab row.
export function resolveTiers(policies: PolicyInput[], userTiers: TierInput[]): ResolvedTier[] {
  const byName = new Map<string, ResolvedTier>();

  // Referenced-but-undefined tiers (lowest precedence): a policy names a tier
  // in spec.tier that nothing defines. Surfaced so the gap is visible.
  for (const p of parsePolicies(policies)) {
    if (!byName.has(p.tier)) {
      byName.set(p.tier, { name: p.tier, order: UNDEFINED_TIER_ORDER, source: 'referenced' });
    }
  }
  // Tiers pasted as `kind: Tier` docs in the policy stream.
  for (const t of parseTiers(policies)) {
    byName.set(t.name, { name: t.name, order: t.order, defaultAction: t.defaultAction, source: 'pasted' });
  }
  // The user's custom tiers (request.tiers), editable in the tier tab.
  userTiers.forEach((t, customIndex) => {
    if (!t.name) return;
    byName.set(t.name, {
      name: t.name,
      order: t.order,
      defaultAction: t.defaultAction,
      source: 'custom',
      customIndex,
    });
  });
  // Reserved tiers last so they win any name collision.
  for (const t of RESERVED_TIERS) {
    byName.set(t.name, { name: t.name, order: t.order, defaultAction: t.defaultAction, source: 'reserved' });
  }

  return [...byName.values()].sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));
}

// tierNames is the deduped list of *defined* tier names (reserved + pasted +
// custom, excluding error-state references), in precedence order - the set a
// Calico policy's spec.tier may legally reference. Drives the editor's
// autocomplete/validation enum.
export function tierNames(policies: PolicyInput[], userTiers: TierInput[]): string[] {
  return resolveTiers(policies, userTiers)
    .filter((t) => t.source !== 'referenced')
    .map((t) => t.name);
}
