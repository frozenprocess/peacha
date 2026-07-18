// Editor state is NOT mirrored into the URL bar - the address bar stays clean
// (`/` or `/tutorials/<slug>`). State persists two ways instead:
//
//   - locally, as a `Draft` in localStorage (saveDraft/loadDraft), so a refresh
//     or reopen restores the working copy without a huge URL; and
//   - for *sharing*, via encodeState into a compact blob the SPA POSTs to the
//     server (POST /v1/links), which returns a tiny `/s/<code>` link. Opening it
//     302s back to `/path#<blob>`, and decodeState/readFragment restore it on
//     mount (then the mirror effect strips the fragment so the URL goes clean).
//
// The shared blob is the same shape the server consumes (EditorRequest) plus a
// few UI fields (view, selectedNode, probeFilter, layout, …) so a shared link
// restores the exact view the sender saw. Encoding: JSON -> trimmed -> utf-8 ->
// deflate-raw -> base64url, with a legacy raw-base64 fallback (see encodeState).

import { EditorRequest } from './api';

export type ViewMode = 'matrix' | 'graph' | 'bpf' | 'iptables' | 'nftables' | 'hns';

// How the graph view boxes things. 'namespace' (default) and 'node' box
// endpoints (by namespace, or by the k8s node each pod/HEP lands on - node mode
// renders HEPs as the node's firewall band). 'tier' switches to a policy-
// structure view: one vertical pillar per policy tier (ordered by tier order),
// each containing the policies it holds - no endpoints/edges. See
// graph/buildGraph.ts and graph/tiers.ts.
export type GroupBy = 'namespace' | 'node' | 'tier';

// How many edges the graph draws - the main declutter lever for a default-allow
// matrix (~N² allows). 'select' (default): only the focused node's flows;
// 'all': every flow (the old behaviour); 'off': none.
export type EdgeMode = 'all' | 'select' | 'off';

// The resizable regions of the workspace. The layout is two full-height
// columns: the LEFT column stacks `docs` over `topology`, the RIGHT column
// stacks `policy` over `view` (the dataplane pane - matrix / graph / bpf /
// iptables). `docs` is static read-only reference content.
export type PaneId = 'topology' | 'docs' | 'policy' | 'view';

// LayoutPrefs captures the adjustable workspace: the split fractions, which
// panes are collapsed to a bar, and which (if any) is maximised. Persisted in
// the fragment alongside the data so a shared link restores the sender's
// layout too. All fields optional-friendly via DEFAULT_LAYOUT merging.
export interface LayoutPrefs {
  colSplit: number; // width in REM of the LEFT column (fixed-width, drag-resizable)
  leftSplit: number; // fraction [0..1] of the LEFT column height the DOCS pane (top) takes
  rightSplit: number; // fraction [0..1] of the RIGHT column height the POLICY pane (top) takes
  collapsed: Record<PaneId, boolean>;
  maximized: PaneId | null;
}

export const DEFAULT_LAYOUT: LayoutPrefs = {
  colSplit: 28,
  leftSplit: 0.5,
  rightSplit: 0.5,
  // Left column opens on docs with topology collapsed to a bar (they're mutually
  // exclusive - see toggleCollapse). Right column opens with both panes shown.
  collapsed: { topology: true, docs: false, policy: false, view: false },
  maximized: null,
};

// normalizeLayout fills any missing fields from the default so an older / hand-
// edited fragment can't leave the layout in a half-defined state (e.g. a link
// shared from before the two-column layout, which carried rowSplit/docsSplit
// that no longer exist - those are simply dropped and the new fields default).
// It also enforces the two column invariants a shared/edited fragment must obey:
//   - Left: exactly one of docs/topology open (both-open or both-collapsed
//     resolves to docs open).
//   - Right: at least one of policy/view open (if a fragment collapsed both,
//     reopen the view pane).
export function normalizeLayout(l: Partial<LayoutPrefs> | undefined): LayoutPrefs {
  const merged = {
    ...DEFAULT_LAYOUT,
    ...(l ?? {}),
    collapsed: { ...DEFAULT_LAYOUT.collapsed, ...(l?.collapsed ?? {}) },
  };
  const c = merged.collapsed;
  if (c.docs === c.topology) {
    c.docs = false;
    c.topology = true;
  }
  if (c.policy && c.view) c.view = false;
  // colSplit changed from a fraction [0..1] to a REM width; a value <= 1 is a
  // stale fraction from an older link/persisted prefs - fall back to the default.
  if (merged.colSplit <= 1) merged.colSplit = DEFAULT_LAYOUT.colSplit;
  return merged;
}

export interface AppState {
  request: EditorRequest;
  // Cluster provider whose system baseline was active (e.g. "kind"). Absent in
  // older links - the receiver falls back to the server default.
  provider?: string;
  view: ViewMode;
  selectedNode: string | null;
  probeFilter: Record<string, boolean>; // probe name -> visible (true)
  layout?: LayoutPrefs;
  groupBy?: GroupBy; // graph grouping; defaults to 'namespace' when absent
  // Graph declutter prefs (defaults applied when absent - see App):
  edgeMode?: EdgeMode;            // 'select'
  hideSystem?: boolean;           // true (drop dimmed baseline pods)
  emphasizeNonDefault?: boolean;  // true (fade allows, surface denies/amber)
}

// The fragment carries one of two encodings; decodeState reads both so a link
// minted by either path - or before compression existed - still opens:
//   legacy : base64url(JSON)                       (older shared links)
//   v1     : "~" + base64url(deflate-raw(JSON))     (compressed)
// The "~" sentinel isn't a base64url character, so the two are told apart
// unambiguously. encodeState always tries to compress (browsers ship
// CompressionStream); if the API is missing it falls back to the legacy form.
const COMPRESSED_PREFIX = '~';

export async function encodeState(s: AppState): Promise<string> {
  const json = JSON.stringify(trimState(s));
  const bytes = new TextEncoder().encode(json);
  const packed = await deflate(bytes);
  // deflate-raw(JSON) is base64url-encoded, then tagged so decode can spot it.
  if (packed) return COMPRESSED_PREFIX + base64UrlEncode(packed);
  return base64UrlEncode(bytes); // no CompressionStream: legacy uncompressed form
}

export async function decodeState(fragment: string): Promise<AppState | null> {
  if (!fragment) return null;
  try {
    let bytes: Uint8Array;
    if (fragment.startsWith(COMPRESSED_PREFIX)) {
      const inflated = await inflate(base64UrlDecode(fragment.slice(1)));
      if (!inflated) return null;
      bytes = inflated;
    } else {
      bytes = base64UrlDecode(fragment);
    }
    const json = new TextDecoder().decode(bytes);
    const s = JSON.parse(json) as AppState;
    // Minimal shape check - bad (or forged) fragments shouldn't crash the app.
    if (!s || typeof s !== 'object' || !s.request) return null;
    return s;
  } catch {
    return null;
  }
}

// trimState drops every field that applyAppState (the restore side, in App.tsx)
// defaults when absent, so the common case - default layout/flags, nothing
// hidden - serializes to just { request }. Compression already shrinks repeated
// default keys to near-nothing; trimming also keeps the uncompressed fallback
// small and the decoded JSON readable. KEEP IN SYNC with applyAppState's `??`
// defaults: a field trimmed here must restore to the same value there.
function trimState(s: AppState): Partial<AppState> {
  const out: Partial<AppState> = { request: s.request };
  if (s.provider) out.provider = s.provider;
  if (s.view && s.view !== 'graph') out.view = s.view;
  if (s.selectedNode != null) out.selectedNode = s.selectedNode;
  // Default probe filter is all-visible (defaultProbeFilter), so only carry it
  // when the sender actually hid a probe.
  if (s.probeFilter && Object.values(s.probeFilter).some((v) => !v)) {
    out.probeFilter = s.probeFilter;
  }
  if (s.groupBy && s.groupBy !== 'namespace') out.groupBy = s.groupBy;
  if (s.edgeMode && s.edgeMode !== 'select') out.edgeMode = s.edgeMode;
  if (s.hideSystem === false) out.hideSystem = false;
  if (s.emphasizeNonDefault === false) out.emphasizeNonDefault = false;
  if (s.layout && !isDefaultLayout(s.layout)) out.layout = s.layout;
  return out;
}

// isDefaultLayout reports whether a layout is field-for-field DEFAULT_LAYOUT, so
// trimState can omit it (normalizeLayout rebuilds the default when absent).
function isDefaultLayout(l: LayoutPrefs): boolean {
  const d = DEFAULT_LAYOUT;
  const c = l.collapsed ?? ({} as LayoutPrefs['collapsed']);
  return (
    l.colSplit === d.colSplit &&
    l.leftSplit === d.leftSplit &&
    l.rightSplit === d.rightSplit &&
    l.maximized === d.maximized &&
    c.topology === d.collapsed.topology &&
    c.docs === d.collapsed.docs &&
    c.policy === d.collapsed.policy &&
    c.view === d.collapsed.view
  );
}

// deflate/inflate via the browser's native streams - no dependency, no worker.
// Both return null when the API is unavailable (encode falls back to the legacy
// form; decode rejects the fragment) or the stream errors on a corrupt/forged
// payload. Payloads are a few KB, so write-then-drain without awaiting the
// writer can't deadlock on backpressure.
async function deflate(bytes: Uint8Array): Promise<Uint8Array | null> {
  if (typeof CompressionStream === 'undefined') return null;
  try {
    const cs = new CompressionStream('deflate-raw');
    const w = cs.writable.getWriter();
    void w.write(bytes as BufferSource);
    void w.close();
    const buf = await new Response(cs.readable).arrayBuffer();
    return new Uint8Array(buf);
  } catch {
    return null;
  }
}

async function inflate(bytes: Uint8Array): Promise<Uint8Array | null> {
  if (typeof DecompressionStream === 'undefined') return null;
  try {
    const ds = new DecompressionStream('deflate-raw');
    const w = ds.writable.getWriter();
    void w.write(bytes as BufferSource);
    void w.close();
    const buf = await new Response(ds.readable).arrayBuffer();
    return new Uint8Array(buf);
  } catch {
    return null;
  }
}

// base64url = base64 with -_/= replacements, safe in URL fragments.
function base64UrlEncode(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  const b64 = btoa(bin);
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlDecode(s: string): Uint8Array {
  const pad = '='.repeat((4 - (s.length % 4)) % 4);
  const b64 = (s + pad).replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * Read the current fragment (after the '#') into an AppState, or null when
 * absent / unparseable. The fragment is opaque to the browser - it never hits
 * the server - so we can stuff JSON in it without worrying about caching.
 */
export async function readFragment(): Promise<AppState | null> {
  const frag = window.location.hash.replace(/^#/, '');
  return decodeState(frag);
}

// ---------------------------------------------------------------------------
// Local working draft. The editor stashes its state here (debounced) instead of
// in the URL, so a refresh / reopen restores it while the address bar stays
// clean. The draft remembers which track it belongs to (`tutorial` slug, or null
// for the Playground) so restore reopens the right tab/lesson. Best-effort: a
// disabled / full localStorage just means the in-memory state isn't persisted.
// ---------------------------------------------------------------------------
const DRAFT_KEY = 'peacha-draft';

export interface Draft {
  tutorial: string | null; // active lesson slug, or null for the Playground
  state: AppState;
}

export function saveDraft(d: Draft): void {
  try {
    localStorage.setItem(DRAFT_KEY, JSON.stringify(d));
  } catch {
    /* private mode / quota exceeded - in-memory state still works */
  }
}

export function loadDraft(): Draft | null {
  try {
    const raw = localStorage.getItem(DRAFT_KEY);
    if (!raw) return null;
    const d = JSON.parse(raw) as Draft;
    // Same minimal shape check as decodeState - a half-written draft can't crash.
    if (!d || typeof d !== 'object' || !d.state || !d.state.request) return null;
    return d;
  } catch {
    return null;
  }
}

export function clearDraft(): void {
  try {
    localStorage.removeItem(DRAFT_KEY);
  } catch {
    /* ignore */
  }
}

/**
 * Read the active tutorial slug from the URL. The canonical form is the clean
 * path `/tutorials/<slug>` (what writeUrl produces and the server prerenders);
 * the legacy `?tutorial=<slug>` query is still honoured so older shared links
 * keep working. The slug names a server tutorial by its stable `meta.name`, so
 * the lesson loads its own canonical policy. Returns null when neither present.
 */
export function readTutorialSlug(): string | null {
  const m = window.location.pathname.match(/^\/tutorials\/([^/]+)\/?$/);
  if (m) return decodeURIComponent(m[1]);
  return new URLSearchParams(window.location.search).get('tutorial');
}

/**
 * Write the clean URL: the tutorial deep link lives in the path
 * (`/tutorials/<slug>`, or `/` when no lesson is open). State is NEVER put in the
 * bar - it lives in the local draft / share links - so this also strips any
 * leftover `#fragment` (e.g. right after opening a share link). Replaces the
 * current history entry so it doesn't pollute the back button. The legacy
 * `?tutorial=` query is folded into the path so it never lingers. No-op when the
 * resulting URL already matches.
 */
export function writeUrl(opts: { tutorial?: string | null }): void {
  const path = opts.tutorial ? '/tutorials/' + encodeURIComponent(opts.tutorial) : '/';
  // Preserve any non-tutorial query params; drop the legacy tutorial param.
  const params = new URLSearchParams(window.location.search);
  params.delete('tutorial');
  const qs = params.toString();
  const next = path + (qs ? '?' + qs : ''); // no fragment - state lives elsewhere
  const cur = window.location.pathname + window.location.search + window.location.hash;
  if (cur === next) return;
  history.replaceState(null, '', next);
}
