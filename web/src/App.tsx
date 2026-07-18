// Top-level orchestrator. Two-layer model:
//
//   - System layer:    loaded once from /v1/topology, never edited. Always
//                      present in evaluations so policies see kube-system /
//                      calico-system pods. Rendered in the graph + matrix
//                      but de-emphasised. Invisible in the topology pane.
//   - Workloads layer: user-editable. Seeded from /v1/topology's workloads
//                      (parsed from workloads/topology.yaml). Shown in the
//                      topology pane; share-link fragment encodes it.
//
// Every /v1/evaluate POST sends the merged union of the two so policies
// resolve correctly; the matrix and graph render the same union with a
// `system` flag the renderers use to dim/style appropriately.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AuthConfig,
  Capability,
  DEFAULT_EXTERNAL_ENDPOINTS,
  EditorRequest,
  EditorResponse,
  Endpoint,
  Exam,
  Example,
  NamespaceInput,
  NodeInfo,
  PolicyInput,
  Probe,
  Resources,
  TierMatchResponse,
  Topology,
  TopologyLayer,
  Tutorial,
  Versions,
  createShareLink,
  evaluate,
  getAuthConfig,
  getCapabilities,
  getPassedExams,
  getTopology,
  getVersion,
  gradeExam,
  listExams,
  listTutorials,
  logout,
  resolveTierMatches,
} from './api';
import { buildImpact } from './impact';
import { mergeHostEndpoints, parsePastedResources } from './resourceModel';
import { tierNames } from './tierModel';
import { updatePolicyTiers, subscribePolicyValidity, getPolicyHasErrors } from './monacoSetup';
import { updatePolicyCompletions, buildVocabulary } from './policyCompletions';
import { RawTopologyEditor } from './components/RawTopologyEditor';
import { TutorialPane } from './components/TutorialPane';
import { PlaygroundPane } from './components/PlaygroundPane';
import { ExamPane } from './components/ExamPane';
import { PolicyEditor } from './components/PolicyEditor';
import { Matrix } from './components/Matrix';
import { Graph } from './components/Graph';
import { BPFView } from './components/BPFView';
import { IptablesView } from './components/IptablesView';
import { CostBar } from './components/CostBar';
import { HnsView } from './components/HnsView';
import logoImg from './assets/logo.png';
import ebpfLogo from './assets/ebpf-horizontal.svg';
import ebpfLogoDark from './assets/ebpf-horizontal-dark.png';
import windowsLogo from './assets/windows-logo.svg';
import windowsLogoDark from './assets/windows-logo-dark.svg';
import {
  AppState,
  DEFAULT_LAYOUT,
  EdgeMode,
  GroupBy,
  LayoutPrefs,
  PaneId,
  ViewMode,
  clearDraft,
  encodeState,
  loadDraft,
  normalizeLayout,
  readFragment,
  readTutorialSlug,
  saveDraft,
  writeUrl,
} from './state';
import { parseSnapshot } from './snapshot';

const DEBOUNCE_MS = 300;

const clamp = (n: number, min: number, max: number) => Math.max(min, Math.min(max, n));

// Responsive mode. The desktop layout is a four-pane splitter workspace that
// only works above ~1024px; below that we switch to space-restricted layouts:
//   - phone  (<=720px):  one pane at a time, switched via a bottom tab bar.
//   - tablet (<=1024px): one column (two stacked panes) at a time, switched
//                        via a bottom toggle between the docs/topology pair and
//                        the policy/view pair.
// Breakpoints are in px (matched to where the four-pane layout actually breaks),
// not rem, so a user zoom that grows the rem doesn't flip the layout underfoot.
type ViewportMode = 'phone' | 'tablet' | 'desktop';
const PHONE_MAX = 720;
const TABLET_MAX = 1024;
function modeForWidth(w: number): ViewportMode {
  if (w <= PHONE_MAX) return 'phone';
  if (w <= TABLET_MAX) return 'tablet';
  return 'desktop';
}
function useViewportMode(): ViewportMode {
  const [mode, setMode] = useState<ViewportMode>(() => modeForWidth(window.innerWidth));
  useEffect(() => {
    const onResize = () => setMode(modeForWidth(window.innerWidth));
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  return mode;
}

// A draggable seam. `axis` is the direction the pointer travels: 'x' for the
// vertical bar between the two top panes, 'y' for the horizontal bar between
// the top row and the view pane. onResize gets the relevant client coordinate
// each move; the parent turns it into a split fraction. Double-click resets.
function Splitter({
  axis,
  onResize,
  onReset,
}: {
  axis: 'x' | 'y';
  onResize: (clientPos: number) => void;
  onReset: () => void;
}) {
  function onPointerDown(e: React.PointerEvent) {
    e.preventDefault();
    const move = (ev: PointerEvent) => onResize(axis === 'x' ? ev.clientX : ev.clientY);
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
    };
    // Lock selection + cursor for the whole drag so text doesn't highlight and
    // the resize cursor doesn't flicker as the pointer crosses child elements.
    document.body.style.userSelect = 'none';
    document.body.style.cursor = axis === 'x' ? 'col-resize' : 'row-resize';
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }
  return (
    <div
      className={'splitter ' + (axis === 'x' ? 'splitter-col' : 'splitter-row')}
      onPointerDown={onPointerDown}
      onDoubleClick={onReset}
      title="drag to resize · double-click to reset"
    />
  );
}

// EMPTY_REQUEST holds the user-editable workloads layer; system pods live
// outside this and merge in at evaluate-time.
const EMPTY_REQUEST: EditorRequest = {
  endpoints: [],
  namespaces: [],
  policies: [],
  // Default probe set (mirrors the server's defaultProbes): one per protocol
  // family, so a fresh topology exercises TCP/UDP/ICMP/SCTP out of the box.
  probes: [
    { name: 'tcp', port: 8080, protocol: 'tcp' },
    { name: 'udp', port: 53, protocol: 'udp' },
    { name: 'icmp', port: 0, protocol: 'icmp' }, // portless - 0 matches the Go zero value
    { name: 'sctp', port: 0, protocol: 'sctp' },
  ],
  externalEndpoints: DEFAULT_EXTERNAL_ENDPOINTS,
};

function defaultProbeFilter(probes: { name: string }[]): Record<string, boolean> {
  const m: Record<string, boolean> = {};
  for (const p of probes) m[p.name] = true;
  return m;
}

// probesFromEndpoints derives the default probe set from the ports the loaded
// workloads actually declare: one probe per distinct (protocol, port), named by
// its tuple ("tcp:5432"). This is what makes the engine evaluate the cluster's
// REAL listening ports - the per-port matrix the pod hover-tooltip reads -
// instead of a lone placeholder. Returns [] when no endpoint declares a port,
// so the caller can fall back to the topology's / built-in default probe.
function probesFromEndpoints(endpoints: Endpoint[]): Probe[] {
  const seen = new Map<string, Probe>();
  for (const ep of endpoints) {
    for (const p of ep.ports ?? []) {
      const protocol = (p.protocol || 'tcp').toLowerCase();
      const name = `${protocol}:${p.port}`;
      if (!seen.has(name)) seen.set(name, { name, port: p.port, protocol });
    }
  }
  return [...seen.values()].sort((a, b) =>
    a.protocol === b.protocol ? a.port - b.port : (a.protocol ?? '').localeCompare(b.protocol ?? ''),
  );
}

// The optional resource list keys shared by EditorRequest / TopologyLayer /
// Example. Centralised so seeding, merging and example-application all agree.
const RESOURCE_KEYS = [
  'serviceAccounts',
  'hostEndpoints',
  'networkSets',
  'globalNetworkSets',
  'services',
  'endpointSlices',
] as const;

// workloadsRequest builds the editable workloads-layer request from a freshly
// loaded topology: endpoints + namespaces + probes + any seeded resources +
// the global DNS stub. System pods/resources live in baseTopology and merge
// in at evaluate-time, so they're deliberately absent here.
function workloadsRequest(topo: Topology): EditorRequest {
  // Prefer probes derived from the declared ports across BOTH layers (the real
  // listening ports - in practice most live on the system/baseline pods, which
  // merge in at evaluate-time); fall back to whatever the topology shipped, then
  // the built-in tcp:8080 placeholder when nothing declares a port.
  const derived = probesFromEndpoints([...topo.system.endpoints, ...topo.workloads.endpoints]);
  return {
    endpoints: topo.workloads.endpoints,
    namespaces: topo.workloads.namespaces,
    policies: [],
    probes: derived.length > 0 ? derived : topo.probes.length > 0 ? topo.probes : EMPTY_REQUEST.probes,
    externalEndpoints: DEFAULT_EXTERNAL_ENDPOINTS,
    ...pickResources(topo.workloads),
    ...(topo.dns ? { dns: topo.dns } : {}),
  };
}

// pickResources copies just the resource lists off any object carrying them
// (a topology layer, an example), dropping empty/absent ones.
function pickResources(src: Resources): Resources {
  const out: Resources = {};
  for (const k of RESOURCE_KEYS) {
    const v = src[k];
    if (Array.isArray(v) && v.length) (out as Record<string, unknown>)[k] = v;
  }
  return out;
}

// mergeResources concatenates two resource bundles (system + workloads). The
// engine dedupes by object identity itself, so a plain concat is fine.
function mergeResources(a: Resources, b: Resources): Resources {
  const out: Resources = {};
  for (const k of RESOURCE_KEYS) {
    const merged = [...((a[k] as unknown[]) ?? []), ...((b[k] as unknown[]) ?? [])];
    if (merged.length) (out as Record<string, unknown>)[k] = merged;
  }
  return out;
}

// The slice of editor state a single track owns: the policy bundle plus the
// scenario `loadExample` resets (workloads/resources layer, probes, and the
// probe filter). Snapshotted on tab switch so each track survives a round trip.
interface TrackSnapshot {
  policyText: string;
  request: EditorRequest;
  probeFilter: Record<string, boolean>;
}

export function App() {
  const [tutorials, setTutorials] = useState<Tutorial[]>([]);
  // The free-form Playground tab's welcome doc - the tutorial flagged
  // `playground: true` (00-getting-started), pulled out of the track list above.
  // Null until tutorials load (or if none is flagged).
  const [playgroundDoc, setPlaygroundDoc] = useState<Tutorial | null>(null);
  // activeTutorial is the selected lesson's name (null = none picked yet, so the
  // pane shows the opening lesson without loading any policy).
  const [activeTutorial, setActiveTutorial] = useState<string | null>(null);
  // Exam track: the graded counterpart to tutorials. leftTab switches the docs
  // pane between the read-along tutorials and the graded exams. auth tells us
  // whether Slack login is configured + who's signed in; passedExams drives the
  // ✓ checkmarks (only populated when signed in).
  const [exams, setExams] = useState<Exam[]>([]);
  const [activeExam, setActiveExam] = useState<string | null>(null);
  // Persisted like `theme` below: the OAuth login flow is a full-page redirect
  // that wipes React state, so remembering the tab is what brings a learner who
  // signed in from the exams tab back to it (rather than the default playground).
  // The free-form Playground is the default landing (it owns "/"); tutorials and
  // exams are the guided/graded tracks.
  const [leftTab, setLeftTab] = useState<'playground' | 'tutorials' | 'exams'>(() => {
    const v = localStorage.getItem('peacha-left-tab');
    return v === 'exams' || v === 'tutorials' ? v : 'playground';
  });
  useEffect(() => {
    try {
      localStorage.setItem('peacha-left-tab', leftTab);
    } catch {
      /* private mode / storage disabled - the in-memory tab still works */
    }
  }, [leftTab]);
  // No exams shipped (empty embedded exams/ tree) hides the tab; a stale
  // persisted 'exams' tab would otherwise show an empty pane, so fall back.
  useEffect(() => {
    if (leftTab === 'exams' && !exams.length) setLeftTab('playground');
  }, [leftTab, exams.length]);
  const [auth, setAuth] = useState<AuthConfig>({ enabled: false });
  const [passedExams, setPassedExams] = useState<Set<string>>(new Set());
  const [baseTopology, setBaseTopology] = useState<Topology | null>(null);
  // Cluster provider whose system baseline is active, plus every provider the
  // server discovered (for the toolbar switcher). Both come from /v1/topology.
  const [provider, setProvider] = useState<string>('');
  const [providers, setProviders] = useState<string[]>([]);
  // `request` represents the user-editable workloads layer only. System
  // namespaces/endpoints aren't stored here - they live in baseTopology.
  const [request, setRequest] = useState<EditorRequest>(EMPTY_REQUEST);
  // Gates the draft-persist effect: until the async hydrate has populated
  // `request` from the fetched topology, `request` is still EMPTY_REQUEST, and
  // a debounced save would overwrite the stored draft with an empty topology
  // (then the next load restores that empty draft, bypassing the default). Set
  // true at the end of hydrate so only real state is ever persisted.
  const hydrated = useRef(false);
  const [policyText, setPolicyText] = useState<string>('');
  const [view, setView] = useState<ViewMode>('graph');
  const [groupBy, setGroupBy] = useState<GroupBy>('namespace');
  // Graph declutter prefs (a default-allow matrix is ~N² edges). Focus mode +
  // hide-system + emphasis turn the hairball into an explorer; see buildGraph.
  const [edgeMode, setEdgeMode] = useState<EdgeMode>('select');
  const [hideSystem, setHideSystem] = useState(true);
  const [emphasizeNonDefault, setEmphasizeNonDefault] = useState(true);
  // Cluster nodes carried by an imported snapshot (the baseline's nodes come
  // from baseTopology). Lets the node-grouped graph box pod-less nodes.
  const [snapshotNodes, setSnapshotNodes] = useState<NodeInfo[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [probeFilter, setProbeFilter] = useState<Record<string, boolean>>({});
  // One editor snapshot per track. `policyText`/`request`/`probeFilter` are a
  // single shared buffer, so switching tracks would otherwise show the OTHER
  // track's last-loaded scenario in the editor. We snapshot the track we're
  // leaving and restore the one we're entering, so each track keeps its own
  // in-progress work and the editor always matches the docs pane.
  const trackBuffers = useRef<{
    playground: TrackSnapshot | null;
    tutorials: TrackSnapshot | null;
    exams: TrackSnapshot | null;
  }>({ playground: null, tutorials: null, exams: null });
  const [response, setResponse] = useState<EditorResponse | null>(null);
  // Per-endpoint tier/policy matches (engine-resolved), fetched only while the
  // tier view is open; drives its highlight-on-select.
  const [tierMatches, setTierMatches] = useState<TierMatchResponse | null>(null);
  const [status, setStatus] = useState<string>('loading…');
  const [error, setError] = useState<string>('');
  // Boot gate: the whole app needs the baseline topology from the Go backend.
  // 'loading' until hydrate resolves, then 'ready' on success or 'down' if the
  // backend is unreachable - the latter two render full-page screens below.
  const [boot, setBoot] = useState<'loading' | 'ready' | 'down'>('loading');
  // Tracks whether monaco-yaml has flagged the policy bundle invalid. Mirrors
  // the editor's marker state into React so the evaluate effect can gate on it.
  const [policyHasErrors, setPolicyHasErrors] = useState(false);
  const [capabilities, setCapabilities] = useState<Capability[]>([]);
  const [versions, setVersions] = useState<Versions | null>(null);
  const [showCaps, setShowCaps] = useState(false);
  const [layout, setLayout] = useState<LayoutPrefs>(DEFAULT_LAYOUT);

  // Responsive layout state. `mode` is derived from the viewport width; the two
  // selectors below are only consulted in their respective modes:
  //   - mobilePane: which single pane the phone layout shows (bottom tab bar).
  //   - tabletCol:  which column-pair the tablet layout shows ('editor' =
  //                 policy+view, 'docs' = docs+topology).
  //   - menuOpen:   the compact toolbar's "⋯" overflow dropdown.
  // These are intentionally NOT persisted to the fragment/localStorage: the
  // desktop split prefs stay untouched and restore intact when the window grows
  // back, and a share-link opened on a phone shouldn't pin the recipient's
  // desktop session to a single pane.
  const mode = useViewportMode();
  const [mobilePane, setMobilePane] = useState<PaneId>('view');
  const [tabletCol, setTabletCol] = useState<'editor' | 'docs'>('editor');
  const [menuOpen, setMenuOpen] = useState(false);
  // Close the overflow menu when the viewport grows to desktop (where the "⋯"
  // button is hidden), so a menu opened on a tablet can't strand an invisible-
  // trigger dropdown / backdrop after a resize.
  useEffect(() => {
    if (mode === 'desktop') setMenuOpen(false);
  }, [mode]);

  // Theme is seeded from the attribute index.html already set before paint
  // (localStorage, else OS preference). Toggling mirrors it back to both the
  // <html> attribute the CSS reads and localStorage so it sticks across loads.
  const [theme, setTheme] = useState<'light' | 'dark'>(
    () => (document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light'),
  );
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    try {
      localStorage.setItem('peacha-theme', theme);
    } catch {
      /* private mode / storage disabled - the in-memory toggle still works */
    }
  }, [theme]);

  // Refs to the workspace + each column so a drag can convert a client
  // coordinate into a fraction of that container's own box (independent of zoom
  // / chrome). The workspace box drives the column-width split; each column box
  // drives its own top|bottom height split.
  const layoutRef = useRef<HTMLDivElement>(null);
  const leftColRef = useRef<HTMLDivElement>(null);
  const rightColRef = useRef<HTMLDivElement>(null);

  // The vertical seam between the two columns: pointer X as a fraction of the
  // workspace width sets the LEFT column's width.
  const onColResize = (clientX: number) => {
    const r = layoutRef.current?.getBoundingClientRect();
    if (!r) return;
    const rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
    setLayout((l) => ({ ...l, colSplit: clamp((clientX - r.left) / rem, 16, 64) }));
  };
  // The horizontal seam inside a column: pointer Y as a fraction of that
  // column's height sets the TOP pane's height (docs in the left column,
  // policy in the right).
  const onLeftSplit = (clientY: number) => {
    const r = leftColRef.current?.getBoundingClientRect();
    if (r) setLayout((l) => ({ ...l, leftSplit: clamp((clientY - r.top) / r.height, 0.12, 0.88) }));
  };
  const onRightSplit = (clientY: number) => {
    const r = rightColRef.current?.getBoundingClientRect();
    if (r) setLayout((l) => ({ ...l, rightSplit: clamp((clientY - r.top) / r.height, 0.12, 0.88) }));
  };
  // Per-column collapse rules:
  //   - Left (docs/topology): mutually exclusive - toggling one flips the other
  //     so exactly one is ever open (it behaves like a two-way switch).
  //   - Right (policy/view): at least one must stay open, so a request to
  //     collapse the last open pane is ignored (the UI also hides that button -
  //     see canCollapse).
  const toggleCollapse = (id: PaneId) =>
    setLayout((l) => {
      if (id === 'docs' || id === 'topology') {
        const other = id === 'docs' ? 'topology' : 'docs';
        const next = !l.collapsed[id];
        return { ...l, collapsed: { ...l.collapsed, [id]: next, [other]: !next } };
      }
      const other = id === 'policy' ? 'view' : 'policy';
      const next = !l.collapsed[id];
      if (next && l.collapsed[other]) return l; // would empty the right column
      return { ...l, collapsed: { ...l.collapsed, [id]: next } };
    });
  // Whether a pane's collapse control should be offered. Left panes always can
  // (collapsing just switches to the sibling); a right pane can't collapse when
  // it's the only one open there.
  const canCollapse = (id: PaneId) =>
    id === 'policy' ? !layout.collapsed.view : id === 'view' ? !layout.collapsed.policy : true;
  const setMaximized = (id: PaneId | null) => setLayout((l) => ({ ...l, maximized: id }));

  // Hydrate: baseline topology + tutorials in parallel; URL fragment wins for
  // workloads + policies if present (so share-links still restore state).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      // Read the share-link first: it names which provider's baseline to fetch
      // (so a shared link restores the same cluster), falling back to default.
      const frag = await readFragment();
      const [topo, tuts, caps, exs, authCfg, vers] = await Promise.all([
        getTopology(frag?.provider).catch((e) => {
          if (!cancelled) setError(`topology: ${String(e)}`);
          return null;
        }),
        listTutorials().catch(() => [] as Tutorial[]),
        getCapabilities().catch(() => [] as Capability[]),
        listExams().catch(() => [] as Exam[]),
        getAuthConfig().catch(() => ({ enabled: false }) as AuthConfig),
        getVersion().catch(() => null),
      ]);
      if (cancelled) return;
      if (topo) {
        setBaseTopology(topo);
        setProviders(topo.providers ?? []);
        setProvider(topo.provider ?? '');
      }
      // Split the Playground sandbox doc out of the tutorials track: it owns its
      // own tab (served at "/"), so it must not appear in the lesson picker.
      const playgroundTut = tuts.find((t) => t.playground) ?? null;
      const trackTuts = tuts.filter((t) => !t.playground);
      setPlaygroundDoc(playgroundTut);
      setTutorials(trackTuts);
      setCapabilities(caps);
      setVersions(vers);
      setExams(exs);
      setAuth(authCfg);
      // Passed exams are filtered out of the track (the learner takes the
      // unpassed ones one by one), so resolve them up front - the landing below
      // needs them to skip straight to the first still-unpassed exam.
      let passed = new Set<string>();
      if (authCfg.user) {
        passed = new Set(await getPassedExams().catch(() => [] as string[]));
        if (cancelled) return;
        setPassedExams(passed);
      }

      // A /tutorials/<slug> deep link (or the legacy ?tutorial=<slug> query)
      // opens that lesson directly and loads its canonical policy. It can ride
      // alongside a #fragment: the fragment then carries the sender's edits,
      // which win over the lesson's pristine policy.
      const tutSlug = readTutorialSlug();
      const tutFromUrl = tutSlug ? trackTuts.find((t) => t.name === tutSlug) : null;
      const draft = loadDraft();

      if (frag) {
        // Recipient of a share link: the sender's exact state rode in the fragment
        // (the server /s/<code> 302'd us to /path#<blob>). Open the right tab, apply
        // it, and persist it as the local draft so a refresh keeps it - the mirror
        // effect then strips the fragment so this URL goes clean too.
        if (tutFromUrl) {
          setLeftTab('tutorials');
          setActiveTutorial(tutFromUrl.name);
        } else {
          setLeftTab('playground');
        }
        applyAppState(frag);
        saveDraft({ tutorial: tutFromUrl?.name ?? null, state: frag });
      } else if (tutFromUrl) {
        // Deep link to a lesson. Restore the reader's own saved edits for THIS
        // lesson if they have any; otherwise load the pristine canonical policy
        // (loadExample's functional setRequest sees the just-seeded request as its
        // `prev`, so endpoints survive).
        setLeftTab('tutorials');
        setActiveTutorial(tutFromUrl.name);
        if (draft && draft.tutorial === tutFromUrl.name) {
          applyAppState(draft.state);
        } else if (topo) {
          setRequest(workloadsRequest(topo));
          loadExample(tutFromUrl);
        }
      } else if (draft) {
        // Returning visitor, no link: reopen exactly where they left off. A draft is
        // only ever saved for the Playground or an edited lesson (never exams), so
        // restoring it is safe.
        if (draft.tutorial && trackTuts.some((t) => t.name === draft.tutorial)) {
          setLeftTab('tutorials');
          setActiveTutorial(draft.tutorial);
        } else {
          setLeftTab('playground');
        }
        // Self-heal a degenerate draft (e.g. one saved empty by the old mount
        // race): an endpoint-less topology is never something a user meant to
        // keep, so reload the default workloads while preserving their policies.
        let state = draft.state;
        if (draft.state.request.endpoints.length === 0 && topo) {
          const req = { ...workloadsRequest(topo), policies: draft.state.request.policies };
          // The reloaded topology derives its own probes; recompute the filter
          // from them (the draft's filter keyed the old, empty probe set).
          state = { ...draft.state, request: req, probeFilter: defaultProbeFilter(req.probes) };
        }
        applyAppState(state);
      } else if (topo) {
        const req = workloadsRequest(topo);
        setRequest(req);
        setProbeFilter(defaultProbeFilter(req.probes));
        // Post-login landing: the OAuth callback returns to "/", remounting with
        // the persisted tab restored from localStorage but no exam selected. If
        // that tab is exams (and a sign-in isn't still required), load the first
        // exam so its starter shows immediately - the same flush+load a tab click
        // would do. Only reached without a share link, so a shared policy is
        // never clobbered. Exams-only on mount: the no-policy intro tutorial
        // would otherwise reset the default per-port probes on first paint.
        const loginBlocking = authCfg.enabled && !authCfg.user;
        if (leftTab === 'exams' && !loginBlocking && exs.length) {
          const first = exs.find((e) => !passed.has(e.name));
          if (first) {
            setActiveExam(first.name);
            loadExample(first);
          }
        }
      }
      setStatus('');
      // No baseline = the backend never answered /v1/topology; show the "down"
      // screen instead of a half-empty editor.
      setBoot(topo ? 'ready' : 'down');
      // Hydration done: request now reflects the fetched topology (or a restored
      // draft/share link). Safe to start persisting - the setRequest calls above
      // re-run the persist effect, which now sees the real state, not EMPTY.
      hydrated.current = true;
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function applyAppState(s: AppState) {
    setRequest(s.request);
    setPolicyText(s.request.policies.map((p) => p.yaml).join('\n---\n'));
    setView(s.view ?? 'graph');
    setSelected(s.selectedNode ?? null);
    setProbeFilter(s.probeFilter ?? defaultProbeFilter(s.request.probes));
    setLayout(normalizeLayout(s.layout));
    setGroupBy(s.groupBy ?? 'namespace');
    setEdgeMode(s.edgeMode ?? 'select');
    setHideSystem(s.hideSystem ?? true);
    setEmphasizeNonDefault(s.emphasizeNonDefault ?? true);
  }

  // Loading an example replaces the policy editor's text. If the example also
  // carries a scenario (probes / resources / DNS / staged flag), apply those
  // onto the workloads layer so the feature actually lights up - otherwise the
  // topology stays put. Picking the empty example clears policies only.
  function loadExample(ex: Example) {
    // A lesson can carry no policy (e.g. the intro "getting-started" tour, whose
    // policies come back null) - that case clears the editor rather than crashing.
    setPolicyText((ex.policies ?? []).map((p) => p.yaml).join('\n---\n'));
    // Reset the scenario to exactly this example's: clear any resources / probes
    // / external / dns / staged flag from a previously-loaded example (otherwise
    // a HEP or NetworkSet from one testcase would leak into the next), then
    // apply the example's. Topology (endpoints/namespaces) is preserved.
    const probes = ex.probes?.length ? ex.probes : EMPTY_REQUEST.probes;
    setRequest((prev) => ({
      ...prev,
      serviceAccounts: undefined,
      hostEndpoints: undefined,
      networkSets: undefined,
      globalNetworkSets: undefined,
      services: undefined,
      endpointSlices: undefined,
      ...pickResources(ex),
      probes,
      externalEndpoints: ex.externalEndpoints?.length
        ? ex.externalEndpoints
        : DEFAULT_EXTERNAL_ENDPOINTS,
      dns: ex.dns,
      evaluateStaged: ex.evaluateStaged,
    }));
    setProbeFilter(defaultProbeFilter(probes));
  }

  // Selecting a tutorial loads its policy + scenario into the editor (a Tutorial
  // IS an Example, so loadExample applies it) and marks it active so the lesson
  // renders. Read-along: the graph/matrix update as the learner reads. Loading
  // replaces the editor's current policy text.
  function selectTutorial(name: string) {
    const t = tutorials.find((x) => x.name === name);
    if (!t) return;
    setActiveTutorial(name);
    // Always flush + load: the editor reflects exactly the selected lesson's
    // scenario. A lesson with no policy (e.g. the intro tour) carries none, so
    // loadExample clears the editor - switching lessons never leaves stale
    // policy behind.
    loadExample(t);
  }

  // Selecting an exam loads its starter scenario (an Exam IS an Example) and
  // marks it active. The learner edits the loaded starter; the live matrix/graph
  // reflect their work-in-progress until they submit.
  function selectExam(name: string) {
    const ex = exams.find((x) => x.name === name);
    if (!ex) return;
    setActiveExam(name);
    loadExample(ex); // always: an exam's starter (even empty) defines its scenario
  }

  // Post-popup-login refresh. The old full-page OAuth redirect remounted the app
  // and reran the initial load; the popup flow keeps the app mounted, so we
  // re-fetch auth + passed exams here and (mirroring the on-mount landing) open
  // the first exam if the learner is sitting on an empty exam track.
  async function refreshAfterLogin() {
    const cfg = await getAuthConfig().catch(() => null);
    if (!cfg) return;
    setAuth(cfg);
    if (!cfg.user) return;
    const passed = new Set(await getPassedExams().catch(() => [] as string[]));
    setPassedExams(passed);
    if (leftTab === 'exams' && exams.length && !activeExam) {
      const first = exams.find((e) => !passed.has(e.name));
      if (first) {
        setActiveExam(first.name);
        loadExample(first);
      }
    }
  }

  // Switching to a track tab flushes + loads its first item when nothing is
  // selected yet, so the editor immediately matches what the docs pane shows
  // (both panes fall back to displaying item[0] when none is active). Done on
  // the explicit tab click - NOT on mount - so a share link's restored policy
  // and the default per-port probe set survive the initial load. Re-clicking a
  // tab that already has an active item leaves the learner's work in place.
  function showTab(tab: 'playground' | 'tutorials' | 'exams') {
    // Only a real track change snapshots/restores; re-clicking the current tab
    // keeps its same-tab semantics below (advance off a passed exam, leave
    // in-progress work alone) and must NOT clobber the buffer with itself.
    const switching = tab !== leftTab;
    if (switching) {
      trackBuffers.current[leftTab] = { policyText, request, probeFilter };
    }
    setLeftTab(tab);
    if (tab === 'exams') {
      // Don't flush the editor when the exams tab is just the sign-in gate - the
      // learner can't see an exam yet, and the post-login reload loads it anyway.
      const needLogin = auth.enabled && !auth.user;
      if (needLogin || !exams.length) return;
      // Land on (or re-land on) the first still-unpassed exam. Not just when none
      // is active: if the active exam was passed in this session, returning to the
      // tab must advance off it - otherwise the prompt would show a passed exam
      // while the editor holds its old policy. selectExam reloads the starter so
      // the two stay in sync.
      const activeIsUnpassed =
        !!activeExam && !passedExams.has(activeExam) && exams.some((e) => e.name === activeExam);
      if (activeIsUnpassed) {
        // The active exam is still in play. On a real switch, restore the work we
        // saved when we last left this track (else reload its starter); on a
        // same-tab re-click, leave the learner's in-progress edits untouched.
        if (switching) {
          const saved = trackBuffers.current.exams;
          if (saved) restoreTrack(saved);
          else selectExam(activeExam!);
        }
      } else {
        const first = exams.find((e) => !passedExams.has(e.name));
        if (first) selectExam(first.name);
      }
    } else if (tab === 'playground') {
      // The free-form sandbox. On a real switch in, restore the work we saved
      // when we last left it; the first time (no buffer yet) load the playground
      // doc as its starter, which clears the editor to a blank canvas (its
      // policy.yaml is empty) rather than leaking the prior track's policy. A
      // same-tab re-click leaves the sandbox untouched.
      if (switching) {
        const saved = trackBuffers.current.playground;
        if (saved) restoreTrack(saved);
        else if (playgroundDoc) loadExample(playgroundDoc);
      }
    } else if (activeTutorial) {
      // Same as the exam branch: restore the tutorial track's buffer on a real
      // switch, leave work alone on a same-tab re-click.
      if (switching) {
        const saved = trackBuffers.current.tutorials;
        if (saved) restoreTrack(saved);
        else selectTutorial(activeTutorial);
      }
    } else if (tutorials.length) {
      selectTutorial(tutorials[0].name);
    }
  }

  // Restore a previously-snapshotted track into the editor + scenario. The
  // mirror of loadExample, but replaying saved work rather than an example's
  // starter - so switching back to a track returns to exactly where you left it.
  function restoreTrack(s: TrackSnapshot) {
    setPolicyText(s.policyText);
    setRequest(s.request);
    setProbeFilter(s.probeFilter);
  }

  // Grade the current editor state against the active exam. The server is
  // authoritative - it reconstructs the topology and runs the engine itself, so
  // we only send the learner's policies + tiers. On a recorded pass, refresh the
  // checkmarks so the ✓ appears immediately.
  async function gradeActiveExam() {
    const name = activeExam ?? exams[0]?.name;
    if (!name) throw new Error('no exam selected');
    const result = await gradeExam(name, {
      provider,
      policies: requestForServer.policies,
      tiers: requestForServer.tiers,
    });
    if (result.passed) {
      setPassedExams((prev) => new Set(prev).add(name));
    }
    return result;
  }

  // Merge user workloads with the system baseline for evaluation + rendering.
  // De-duped by ID; user wins on conflict so renaming a workload to collide
  // with a system pod is at worst a no-op (you can't shadow kube-apiserver).
  // Resources pasted as manifests in the policy editor (kind: HostEndpoint,
  // NetworkSet, …). The engine already reads these from the policy stream; we
  // parse them here too so the graph/matrix/Resources tab can show them beside
  // the typed request.* fields. Display-only - never merged back into the engine
  // request (that would double-feed). See resourceModel.
  const pastedResources = useMemo(
    () => parsePastedResources(splitPolicies(policyText)),
    [policyText],
  );

  const merged = useMemo(() => {
    const sys: TopologyLayer | null = baseTopology?.system ?? null;
    const epById = new Map<string, Endpoint>();
    if (sys) for (const e of sys.endpoints) epById.set(e.id, e);
    for (const e of request.endpoints) epById.set(e.id, e);
    const nsByName = new Map<string, NamespaceInput>();
    if (sys) for (const n of sys.namespaces) nsByName.set(n.name, n);
    for (const n of request.namespaces) nsByName.set(n.name, n);

    // Union system-layer resources with the user's; the engine sees both.
    const resources = mergeResources(sys ? pickResources(sys) : {}, pickResources(request));
    const dns = { ...(baseTopology?.dns ?? {}), ...(request.dns ?? {}) };

    // System endpoint IDs + system HEP IDs are rendered dimmed and aren't
    // editable in the topology pane.
    const systemIds = new Set<string>(sys?.endpoints.map((e) => e.id) ?? []);
    for (const hep of sys?.hostEndpoints ?? []) systemIds.add(hep.id);

    // HostEndpoints surface as host/<name> rows/cols in the matrix; synthesise
    // a pseudo-endpoint per HEP so the renderers have an object to place. These
    // are display-only - they're sent to the engine via hostEndpoints, NOT as
    // workload endpoints, so they live outside `realEndpoints`.
    // External (off-cluster) endpoints expand into unpoliced engine endpoints:
    // the internet has no Calico ingress, so reach is decided solely by the
    // peer pod's policy (mirrors harness.py external_endpoints). They're real
    // engine endpoints (IP-matched by egress rules) and full matrix rows/cols.
    const externalEndpoints: Endpoint[] = (request.externalEndpoints ?? []).map((x) => {
      const [ns, name] = x.id.includes('/') ? x.id.split('/') : ['world', x.id];
      return {
        id: x.id,
        namespace: ns || 'world',
        name: name || x.id,
        ip: x.ip,
        labels: x.labels ?? {},
        unpoliced: true,
        role: 'external' as const,
      };
    });

    const realEndpoints = [...epById.values(), ...externalEndpoints];
    // Host endpoints to render as host/<name> rows: the typed ones (request.
    // hostEndpoints) plus any pasted into the policy editor. Engine-bound
    // `resources` stays typed-only - pasted HEPs reach the engine via policies.
    const displayHostEndpoints = mergeHostEndpoints(
      resources.hostEndpoints ?? [],
      pastedResources.hostEndpoints,
    );
    const hepEndpoints: Endpoint[] = displayHostEndpoints.map((hep) => ({
      id: hep.id,
      namespace: 'host',
      name: hep.name,
      ip: hep.expectedIPs?.[0] ?? '',
      labels: hep.labels ?? {},
    }));

    // Known k8s nodes for the node-grouped graph: the baseline's cluster nodes
    // + any from an imported snapshot. buildGraph also folds in nodes named by
    // an endpoint/HEP, so this only needs to add pod-less nodes (e.g. a
    // control-plane running only host-network components). Deduped by name.
    const nodeByName = new Map<string, NodeInfo>();
    for (const n of [
      ...(sys?.nodes ?? []),
      ...(baseTopology?.workloads.nodes ?? []),
      ...snapshotNodes,
    ]) {
      if (n.name && !nodeByName.has(n.name)) nodeByName.set(n.name, n);
    }

    // Unpoliced-host model: a node with NO HostEndpoint isn't policed by Calico
    // (NetworkPolicy/GNP govern pods, not the host), so its own egress is
    // unconditional. Synthesise an `unpoliced` host/<node> endpoint per HEP-less
    // node and feed it to the ENGINE so the node-level globe reflects the host's
    // real posture (green under a pod-only deny-all), not the pods'. Mirrors
    // harness.py's Unpoliced host. Engine-only: kept out of displayEndpoints so
    // it isn't rendered as a row/node - it exists purely to be evaluated.
    const hepNodeSet = new Set(
      displayHostEndpoints.map((h) => h.node).filter(Boolean) as string[],
    );
    const unpolicedHosts: Endpoint[] = [];
    const hostNodeIds = new Map<string, string>(); // node name -> host endpoint id
    for (const n of nodeByName.values()) {
      if (hepNodeSet.has(n.name)) continue; // a HEP already represents this host
      const id = `host/${n.name}`;
      hostNodeIds.set(n.name, id);
      unpolicedHosts.push({
        id,
        namespace: 'host',
        name: n.name,
        ip: n.ip ?? '',
        labels: {},
        node: n.name,
        unpoliced: true,
        role: 'host' as const,
      });
    }

    // Host endpoints - both user/snapshot HEPs and the synthesized unpoliced
    // hosts - are ALWAYS surfaced as host/<name> rows/cols (matching the CLI's
    // always-on [HEP]/[HOST] endpoint types), no config required. Their typing
    // ([HEP] vs [HOST]) and the external/internet typing now come from the
    // engine's actor directory (see `impact` below), not re-derived here - the
    // `role` set on externalEndpoints/unpolicedHosts above is what the engine
    // echoes back as Actor.kind. systemIds stays local: "system" is a baseline-
    // membership display concern the engine has no notion of.
    return {
      endpoints: [...realEndpoints, ...unpolicedHosts],
      displayEndpoints: [...realEndpoints, ...hepEndpoints, ...unpolicedHosts],
      namespaces: Array.from(nsByName.values()),
      resources,
      displayHostEndpoints,
      dns,
      systemIds,
      nodes: Array.from(nodeByName.values()),
      hostNodeIds,
    };
  }, [baseTopology, request.endpoints, request.namespaces, request, snapshotNodes, pastedResources]);

  // Endpoint typing - the [EXT]/[HEP]/[HOST] sets the Matrix + Graph render
  // from - comes from the engine's actor directory, not re-derived here. One
  // projection, so the two views can't disagree. Empty until the first
  // response; the views show nothing without a response anyway.
  const impact = useMemo(() => buildImpact(response), [response]);

  // The wire-shape request: merged topology + user policies (parsed from
  // Monaco's text) + the user's probes + resources + flags. Resources and the
  // DNS stub are shared across probes; flags ride along from `request`.
  const requestForServer = useMemo<EditorRequest>(() => {
    return {
      endpoints: merged.endpoints,
      namespaces: merged.namespaces,
      policies: splitPolicies(policyText),
      probes: request.probes,
      ...(request.tiers?.length ? { tiers: request.tiers } : {}),
      ...merged.resources,
      ...(Object.keys(merged.dns).length ? { dns: merged.dns } : {}),
      ...(request.evaluateStaged ? { evaluateStaged: true } : {}),
      ...(request.strictLint ? { strictLint: true } : {}),
    };
  }, [merged, policyText, request.probes, request.tiers, request.evaluateStaged, request.strictLint]);

  // ---------------------------------------------------------------------
  // Re-evaluate when the WIRE request changes. Deliberately depends only on
  // requestForServer - UI state (view, selected, probeFilter) doesn't change
  // what the server computes, so including those would re-fire the network
  // call for free.
  //
  // setProbeFilter inside this effect MUST bail out (return prev) when there
  // are no new/removed probes, otherwise the new object reference cascades
  // back into a re-render → effect re-fires → infinite eval loop at
  // ~1/DEBOUNCE_MS req/sec. That bug was the symptom the user reported as
  // "UI DDoSing the backend".
  // ---------------------------------------------------------------------
  // Mirror the editor's validation state into React. subscribePolicyValidity
  // fires immediately with the current value and again whenever monaco-yaml's
  // markers cross the error threshold, so flipping valid/invalid re-runs the
  // evaluate effect below (which depends on policyHasErrors).
  useEffect(() => subscribePolicyValidity(setPolicyHasErrors), []);

  const abortRef = useRef<AbortController | null>(null);
  useEffect(() => {
    // Don't send a bundle the editor knows is broken. The matrix/graph keep
    // showing the last good result; the status line says why. Re-checked from
    // the live marker state inside the timer too, since markers settle slightly
    // after the keystroke that scheduled this run.
    //
    // Zero policy documents is the ONE state the marker gate must NOT block:
    // there's nothing to be invalid, so "no policies → default-allow" must
    // always re-evaluate. Without this, hand-deleting the last policy can strand
    // the matrix on the deleted policy's flows - monaco-yaml flags the
    // transiently-invalid half-deleted YAML, then never clears those markers
    // when the doc goes empty (it short-circuits blank docs), so policyHasErrors
    // stays true and the gate keeps early-returning the stale result.
    const noPolicies = requestForServer.policies.length === 0;
    if (policyHasErrors && !noPolicies) {
      setStatus('⚠ YAML has errors — not evaluated');
      return;
    }
    const timer = setTimeout(async () => {
      if (requestForServer.endpoints.length === 0) {
        setResponse(null);
        return;
      }
      if (getPolicyHasErrors() && requestForServer.policies.length > 0) {
        setStatus('⚠ YAML has errors — not evaluated');
        return;
      }
      abortRef.current?.abort();
      const ac = new AbortController();
      abortRef.current = ac;
      setStatus('evaluating…');
      try {
        const r = await evaluate(requestForServer, ac.signal);
        setResponse(r);
        setStatus('');
        setError('');
        setProbeFilter((prev) => syncProbeFilter(prev, Object.keys(r.matrices)));
      } catch (e: any) {
        if (e?.name === 'AbortError') return;
        setError(String(e));
        setStatus('');
      }
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [requestForServer, policyHasErrors]);

  // Tier-view matches: only fetched while the tier view is open (it's the only
  // consumer), debounced + abortable like /v1/evaluate. Cleared otherwise so a
  // stale highlight can't linger after editing in another view.
  const tierAbortRef = useRef<AbortController | null>(null);
  const tierViewActive = view === 'graph' && groupBy === 'tier';
  useEffect(() => {
    if (!tierViewActive || requestForServer.endpoints.length === 0) {
      setTierMatches(null);
      return;
    }
    // Same gate as /v1/evaluate: don't resolve tier matches for invalid YAML.
    // The last good highlight stays until the bundle parses again.
    if (policyHasErrors) return;
    const timer = setTimeout(async () => {
      if (getPolicyHasErrors()) return;
      tierAbortRef.current?.abort();
      const ac = new AbortController();
      tierAbortRef.current = ac;
      try {
        setTierMatches(await resolveTierMatches(requestForServer, ac.signal));
      } catch (e: any) {
        if (e?.name !== 'AbortError') setTierMatches(null);
      }
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [requestForServer, tierViewActive, policyHasErrors]);

  // buildShareState snapshots the current editor into the AppState shape used by
  // both the local draft and a share link (the request plus the UI fields that
  // make a restored view match the sender's). Memoised so it can sit in the
  // mirror effect's dependency list without re-triggering it every render.
  const buildShareState = useCallback(
    (): AppState => ({
      request: { ...request, policies: splitPolicies(policyText) },
      provider,
      view,
      selectedNode: selected,
      probeFilter,
      layout,
      groupBy,
      edgeMode,
      hideSystem,
      emphasizeNonDefault,
    }),
    [request, policyText, provider, view, selected, probeFilter, layout, groupBy, edgeMode, hideSystem, emphasizeNonDefault],
  );

  // ---------------------------------------------------------------------
  // Keep the URL clean and persist a local draft. State is NEVER mirrored into
  // the address bar (that's what made share links huge) - the bar carries only
  // the clean path, and the working state is stashed in localStorage so a
  // refresh restores it. Sharing is the explicit Share button (copyShareLink),
  // which mints a server-side /s/<code> link. Pure local; debounced to keep
  // history.replaceState + the localStorage write off the hot path.
  // ---------------------------------------------------------------------
  useEffect(() => {
    // Don't persist until hydration has populated `request`; otherwise the first
    // debounced tick would save EMPTY_REQUEST over the stored draft (see the
    // `hydrated` ref). The setRequest in hydrate re-runs this effect once ready.
    if (!hydrated.current) return;
    const timer = setTimeout(() => {
      // The exam track has no persisted/shareable state - a draft would just hold
      // the learner's in-progress answer - so we keep the URL clean, drop any draft,
      // and skip persistence (the share button is disabled to match). The clean "/"
      // path also stops a /tutorials/<slug> deep link from lingering.
      if (leftTab === 'exams') {
        writeUrl({ tutorial: null });
        clearDraft();
        return;
      }
      if (leftTab === 'playground') {
        // The Playground owns "/": clean path, full state persisted locally.
        writeUrl({ tutorial: null });
        saveDraft({ tutorial: null, state: buildShareState() });
        return;
      }
      // Tutorials tab: the canonical URL is the clean /tutorials/<slug> path. While
      // the editor still holds the lesson's pristine policy (pure read-along) we
      // keep no draft; the moment the learner edits away from it, persist their work
      // locally so a refresh keeps it (sharing still travels via the short link).
      // loadExample sets the same joined text we compare against.
      const activeTut = activeTutorial ? tutorials.find((t) => t.name === activeTutorial) : null;
      const pristine =
        activeTut != null &&
        policyText === (activeTut.policies ?? []).map((p) => p.yaml).join('\n---\n');
      writeUrl({ tutorial: activeTut?.name ?? null });
      if (pristine) clearDraft();
      else saveDraft({ tutorial: activeTut?.name ?? null, state: buildShareState() });
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [leftTab, activeTutorial, tutorials, policyText, buildShareState]);

  // Push the live tier list into the policy editor's schema so a Calico
  // policy's spec.tier completes/validates against tiers that actually exist.
  // tierNames is the shared resolver, so this enum covers reserved + custom +
  // pasted `kind: Tier` docs - the same ladder the graph and tiers tab show.
  // Re-runs on a tier edit OR a policy-text change (a pasted tier affects it).
  useEffect(() => {
    updatePolicyTiers(tierNames(splitPolicies(policyText), request.tiers ?? []));
  }, [request.tiers, policyText]);

  // Feed the same live topology into the editor's topology-aware completion
  // provider (selector label keys/values, namespace/service names, CIDRs,
  // FQDNs). Resources are the typed lists UNION the ones pasted into the policy
  // YAML, so completion offers a resource whether it was typed or pasted -
  // matching what the graph/matrix render. Mirrors the tier push above.
  // The topology snapshot the editor completion AND the policy wizard both read
  // from. Built once here so the two can't drift; the wizard gets it as a prop
  // (reactive) while Monaco's provider gets it pushed into its module snapshot.
  const completionInputs = useMemo(() => {
    const r = merged.resources;
    return {
      tierNames: tierNames(splitPolicies(policyText), request.tiers ?? []),
      namespaces: merged.namespaces,
      endpoints: merged.displayEndpoints,
      serviceAccounts: [...(r.serviceAccounts ?? []), ...pastedResources.serviceAccounts],
      services: [...(r.services ?? []), ...pastedResources.services],
      networkSets: [...(r.networkSets ?? []), ...pastedResources.networkSets],
      globalNetworkSets: [...(r.globalNetworkSets ?? []), ...pastedResources.globalNetworkSets],
      hostEndpoints: merged.displayHostEndpoints,
      domains: Object.keys(merged.dns),
    };
  }, [merged, pastedResources, request.tiers, policyText]);
  const policyVocabulary = useMemo(() => buildVocabulary(completionInputs), [completionInputs]);
  useEffect(() => {
    updatePolicyCompletions(completionInputs);
  }, [completionInputs]);

  // Live tier list for the policy wizard's Calico spec.tier enum - same
  // resolver the editor completion uses, so both agree on what tiers exist.
  const wizardTierNames = useMemo(
    () => tierNames(splitPolicies(policyText), request.tiers ?? []),
    [policyText, request.tiers],
  );

  const visibleProbes = useMemo(
    () => new Set(Object.entries(probeFilter).filter(([, v]) => v).map(([k]) => k)),
    [probeFilter],
  );

  async function copyShareLink() {
    // The address bar no longer carries state, so build the shareable target
    // ourselves: the clean path + the current editor state encoded into a
    // fragment. POST it for a tiny "<origin>/s/<code>" link, falling back to the
    // full self-contained URL when no link store is configured (dev) or the
    // request fails - so Share always copies *something* shareable.
    const slug = leftTab === 'tutorials' ? (activeTutorial ?? null) : null;
    const path = slug ? '/tutorials/' + encodeURIComponent(slug) : '/';
    const params = new URLSearchParams(window.location.search);
    params.delete('tutorial');
    const qs = params.toString();
    const target = path + (qs ? '?' + qs : '') + '#' + (await encodeState(buildShareState()));
    const short = await createShareLink(target);
    const url = short ?? window.location.origin + target;
    navigator.clipboard?.writeText(url).then(
      () => setStatus(short ? 'short link copied' : 'link copied'),
      () => setStatus('select the URL bar to copy'),
    );
    setTimeout(() => setStatus(''), 1500);
  }

  // Save the editor's policy YAML to a file. Client-side only: build a Blob
  // from the current text and click a synthetic <a download>. The text is the
  // raw multi-doc bundle the user typed (--- separated), so it round-trips
  // straight back into the editor or `kubectl apply -f`.
  function downloadPolicies() {
    const text = policyText.trim();
    if (!text) {
      setStatus('no policy to download');
      setTimeout(() => setStatus(''), 1500);
      return;
    }
    const blob = new Blob([text + '\n'], { type: 'application/x-yaml' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'policies.yaml';
    a.click();
    URL.revokeObjectURL(url);
    setStatus('downloaded policies.yaml');
    setTimeout(() => setStatus(''), 1500);
  }

  // Upload replaces only the workloads layer; system stays. The merge step
  // will continue to fold the system pods into the evaluation.
  const fileInputRef = useRef<HTMLInputElement>(null);
  async function handleUpload(file: File) {
    setError('');
    try {
      const text = await file.text();
      const snap = parseSnapshot(text);
      setRequest((prev) => ({
        ...prev,
        namespaces: snap.namespaces,
        endpoints: snap.endpoints,
        ...pickResources(snap.resources),
        ...(snap.dns ? { dns: snap.dns } : {}),
      }));
      setSnapshotNodes(snap.nodes);
      setSelected(null);
      setStatus(`loaded ${file.name} (${snap.summary})`);
      setTimeout(() => setStatus(''), 3000);
    } catch (e: any) {
      setError(`upload: ${e?.message ?? String(e)}`);
    }
  }

  function resetWorkloads() {
    if (!baseTopology) return;
    setRequest(workloadsRequest(baseTopology));
    setSnapshotNodes([]);
    setSelected(null);
  }

  // Swap the active cluster provider. Re-fetches that provider's baseline and
  // replaces only the system layer - the user's workloads edits and policies
  // are kept (switching is "same scenario, different cluster backdrop"). The
  // share-link effect persists the new provider automatically.
  async function switchProvider(next: string) {
    if (next === provider) return;
    setProvider(next);
    setError('');
    setStatus(`loading ${next}…`);
    try {
      const topo = await getTopology(next);
      setBaseTopology(topo);
      if (topo.providers) setProviders(topo.providers);
      setSelected(null);
      setStatus(`provider: ${topo.provider}`);
      setTimeout(() => setStatus(''), 1500);
    } catch (e: any) {
      setError(`provider: ${e?.message ?? String(e)}`);
      setStatus('');
    }
  }

  const { collapsed, maximized, colSplit, leftSplit, rightSplit } = layout;

  // A pane collapsed to a thin horizontal bar within its column; click to
  // restore it. (Maximize still floats over the whole workspace separately.)
  const collapsedBar = (id: PaneId, label: string) => (
    <div className="pane-bar">
      <button className="strip-btn" title={`expand ${label}`} onClick={() => toggleCollapse(id)}>+</button>
      <span>{label}</span>
    </div>
  );

  // Pane contents, defined once so the maximized branch reuses them verbatim
  // (no duplicated JSX between the split layout and the full-screen layout).
  const topologyBody = (
    <>
      <div className="pane-head">
        <h2>topology (YAML)</h2>
      </div>
      <div className="monaco-host">
        <RawTopologyEditor request={request} onChange={setRequest} theme={theme} system={baseTopology?.system} />
      </div>
    </>
  );
  // Clear the session cookie, then drop the in-memory identity so the exam
  // track falls back to its sign-in gate and any recorded-pass marks (tied to
  // the old identity) are cleared.
  async function signOut() {
    try {
      await logout();
    } finally {
      setAuth((a) => ({ ...a, user: undefined }));
      setPassedExams(new Set());
    }
  }
  const docsBody = (
    <>
      <div className="pane-head">
        <button
          className={leftTab === 'playground' ? 'tab active' : 'tab'}
          onClick={() => showTab('playground')}
        >
          playground
        </button>
        <button
          className={leftTab === 'tutorials' ? 'tab active' : 'tab'}
          onClick={() => showTab('tutorials')}
        >
          tutorials
        </button>
        {exams.length ? (
          <button
            className={leftTab === 'exams' ? 'tab active' : 'tab'}
            onClick={() => showTab('exams')}
          >
            exams
          </button>
        ) : null}
        {auth.user ? (
          <span className="user-chip pane-action-end" title="signed in">
            ✓ signed in{auth.user.provider ? ` · ${auth.user.provider}` : ''}
            <button className="signout-btn" onClick={signOut} title="sign out">
              sign out
            </button>
          </span>
        ) : null}
      </div>
      <div className="docs-scroll">
        {leftTab === 'playground' ? (
          <PlaygroundPane doc={playgroundDoc} theme={theme} onRunCode={setPolicyText} />
        ) : leftTab === 'tutorials' ? (
          <TutorialPane
            tutorials={tutorials}
            activeId={activeTutorial}
            onSelect={selectTutorial}
            theme={theme}
            onRunCode={setPolicyText}
          />
        ) : (
          <ExamPane
            exams={exams}
            activeId={activeExam}
            onSelect={selectExam}
            theme={theme}
            onRunCode={setPolicyText}
            auth={auth}
            passed={passedExams}
            autoAdvance={auth.examAutoAdvance ?? true}
            onGrade={gradeActiveExam}
            onSignedIn={refreshAfterLogin}
          />
        )}
      </div>
    </>
  );
  const policyBody = (
    <>
      <div className="pane-head">
        <h2>policies (YAML, multi-doc separated by ---)</h2>
        <button
          className="pane-icon-btn pane-action-end"
          onClick={downloadPolicies}
          title="download the policy YAML as policies.yaml"
          disabled={!policyText.trim()}
          aria-label="download policies"
        >
          Download ⤓
        </button>
      </div>
      <div className="monaco-host">
        <PolicyEditor
          value={policyText}
          onChange={setPolicyText}
          theme={theme}
        />
      </div>
    </>
  );
  const viewBody = (
    <>
      <div className="pane-head">
        {(['matrix', 'graph', 'bpf', 'hns', 'iptables', 'nftables'] as ViewMode[]).map((v) => (
          <button key={v} className={view === v ? 'tab active' : 'tab'} onClick={() => setView(v)}>
            {v === 'bpf' ? (
              <img
                className="tab-logo"
                // The active tab's background is the accent --primary in both themes,
                // so a selected tab flips the variant from its theme default (XOR):
                // light-text logo on dark bg (dark theme unselected, or light theme
                // selected), dark-text logo otherwise - keeps the wordmark legible.
                src={(theme === 'dark') !== (view === v) ? ebpfLogoDark : ebpfLogo}
                alt="eBPF"
              />
            ) : v === 'hns' ? (
              <img
                className="tab-logo"
                // Same XOR rule as the eBPF wordmark: the active tab's background is
                // the accent --primary in both themes, so a selected tab flips the
                // variant from its theme default to stay legible.
                src={(theme === 'dark') !== (view === v) ? windowsLogoDark : windowsLogo}
                alt="HNS (Windows)"
                title="Windows HNS"
              />
            ) : (
              v
            )}
          </button>
        ))}
        {selected ? (
          <span className="selected-hint">
            selected: <code>{selected}</code>
            <button className="link" onClick={() => setSelected(null)}>clear</button>
          </span>
        ) : null}
      </div>
      {response?.errors?.length ? <div className="errors">{response.errors.join('\n')}</div> : null}
      {response?.warnings?.length ? (
        <div className="warnings" title="lint findings - evaluation still ran">
          {response.warnings.map((w, i) => (
            <div key={i}>⚠ {w}</div>
          ))}
        </div>
      ) : null}
      {response?.cost ? (
        // On a dataplane view, lead with that dataplane's real weight (it
        // changes per view); matrix/graph have no dataplane, so pass none and
        // the bar shows only the portable Cost score.
        <CostBar
          cost={response.cost}
          dataplane={
            view === 'bpf'
              ? response.dataplanes?.bpf
              : view === 'hns'
                ? response.dataplanes?.hns
                : view === 'nftables'
                  ? response.dataplanes?.nftables
                  : view === 'iptables'
                    ? response.dataplanes?.iptables
                    : undefined
          }
        />
      ) : null}
      <div className="view-body">
        {view === 'matrix' ? (
          <Matrix
            endpoints={merged.displayEndpoints.map((e) => e.id)}
            systemIds={merged.systemIds}
            externalIds={impact.externalIds}
            hostIds={impact.hostIds}
            unprotectedIds={impact.unprotectedIds}
            response={response}
            selected={selected}
            onSelect={setSelected}
            visibleProbes={visibleProbes}
            hideSystem={hideSystem}
          />
        ) : view === 'bpf' ? (
          <BPFView request={requestForServer} selected={selected} />
        ) : view === 'hns' ? (
          <HnsView request={requestForServer} selected={selected} />
        ) : view === 'iptables' ? (
          <IptablesView request={requestForServer} backend="iptables" selected={selected} />
        ) : view === 'nftables' ? (
          <IptablesView request={requestForServer} backend="nftables" selected={selected} />
        ) : (
          <Graph
            endpoints={merged.displayEndpoints}
            systemIds={merged.systemIds}
            externalIds={impact.externalIds}
            hostIds={impact.hostIds}
            unprotectedIds={impact.unprotectedIds}
            response={response}
            probes={requestForServer.probes}
            selected={selected}
            onSelect={setSelected}
            visibleProbes={visibleProbes}
            onToggleProbe={(p) => setProbeFilter((prev) => ({ ...prev, [p]: !prev[p] }))}
            groupBy={groupBy}
            onGroupByChange={setGroupBy}
            edgeMode={edgeMode}
            onEdgeModeChange={setEdgeMode}
            hideSystem={hideSystem}
            onHideSystemChange={setHideSystem}
            emphasizeNonDefault={emphasizeNonDefault}
            onEmphasizeChange={setEmphasizeNonDefault}
            nodes={merged.nodes}
            hostEndpoints={merged.displayHostEndpoints}
            hostNodeIds={merged.hostNodeIds}
            policies={requestForServer.policies}
            tiers={requestForServer.tiers ?? []}
            tierMatches={tierMatches}
            tierNames={wizardTierNames}
            vocab={policyVocabulary}
            onAddRule={(yaml) => {
              setPolicyText((prev) => (prev.trim() ? `${prev.trimEnd()}\n---\n${yaml}` : yaml));
              setStatus('added policy from graph');
            }}
          />
        )}
      </div>
    </>
  );

  // Per-pane control cluster: collapse + maximize, or just restore when this
  // pane is the maximized one.
  const paneCtl = (id: PaneId) =>
    maximized === id ? (
      <div className="pane-ctl">
        <button title="restore layout" onClick={() => setMaximized(null)}>⤡</button>
      </div>
    ) : (
      <div className="pane-ctl">
        {canCollapse(id) ? (
          <button title="collapse" onClick={() => toggleCollapse(id)}>–</button>
        ) : null}
        <button title="maximize" onClick={() => setMaximized(id)}>⤢</button>
      </div>
    );

  // One full-height column: a top pane stacked over a bottom pane with a
  // draggable seam between them. `split` is the fraction of the column height
  // the TOP pane takes (only meaningful while both are open); when either pane
  // is collapsed it renders as a bar and its sibling fills the column.
  const renderColumn = (
    colRef: React.RefObject<HTMLDivElement>,
    colStyle: React.CSSProperties,
    top: { id: PaneId; body: React.ReactNode; label: string; isView?: boolean },
    bottom: { id: PaneId; body: React.ReactNode; label: string; isView?: boolean },
    split: number,
    onSplit: (clientPos: number) => void,
    onSplitReset: () => void,
  ) => {
    const topOpen = !collapsed[top.id];
    const botOpen = !collapsed[bottom.id];
    return (
      <div className="layout-col" ref={colRef} style={colStyle}>
        {topOpen ? (
          <div
            className={top.isView ? 'view-pane' : 'pane'}
            style={botOpen ? { flex: `0 0 ${split * 100}%`, minHeight: 0 } : { flex: '1 1 auto', minHeight: 0 }}
          >
            {paneCtl(top.id)}
            {top.body}
          </div>
        ) : (
          collapsedBar(top.id, top.label)
        )}

        {topOpen && botOpen ? <Splitter axis="y" onResize={onSplit} onReset={onSplitReset} /> : null}

        {botOpen ? (
          <div
            className={bottom.isView ? 'view-pane' : 'pane'}
            style={{ flex: '1 1 auto', minHeight: 0 }}
          >
            {paneCtl(bottom.id)}
            {bottom.body}
          </div>
        ) : (
          collapsedBar(bottom.id, bottom.label)
        )}
      </div>
    );
  };

  // Map a pane id to its body. Used by the phone single-pane and tablet
  // column-pair renderers, which reuse the same body JSX the desktop columns do.
  const bodyFor = (id: PaneId): React.ReactNode =>
    id === 'topology' ? topologyBody : id === 'docs' ? docsBody : id === 'policy' ? policyBody : viewBody;

  // Maximize-only pane control for the tablet layout: collapsing a pane there
  // would break the visible pair, but maximizing one to full-screen is still
  // useful (and the existing `maximized` branch handles the restore button).
  const paneCtlMax = (id: PaneId) => (
    <div className="pane-ctl">
      <button title="maximize" onClick={() => setMaximized(id)}>⤢</button>
    </div>
  );

  // Phone: a single pane filling the workspace; the bottom tab bar swaps which.
  // No collapse/maximize controls - the bottom bar is the only navigation.
  const renderSinglePane = (id: PaneId) => (
    <div className={(id === 'view' ? 'view-pane' : 'pane') + ' mobile-pane'}>{bodyFor(id)}</div>
  );

  // Tablet: one full-width column of two stacked panes with a draggable seam,
  // mirroring a desktop column but always showing both panes (collapse state is
  // ignored here). `which` picks the pair: 'editor' = policy/view (reusing the
  // right column's split + ref), 'docs' = docs/topology (the left column's).
  const renderTabletColumn = (which: 'editor' | 'docs') => {
    const isEditor = which === 'editor';
    const top: { id: PaneId; body: React.ReactNode } = isEditor
      ? { id: 'policy', body: policyBody }
      : { id: 'docs', body: docsBody };
    const bottom: { id: PaneId; body: React.ReactNode; isView?: boolean } = isEditor
      ? { id: 'view', body: viewBody, isView: true }
      : { id: 'topology', body: topologyBody };
    const split = isEditor ? rightSplit : leftSplit;
    const onSplit = isEditor ? onRightSplit : onLeftSplit;
    const onReset = () =>
      setLayout((l) => ({
        ...l,
        ...(isEditor
          ? { rightSplit: DEFAULT_LAYOUT.rightSplit }
          : { leftSplit: DEFAULT_LAYOUT.leftSplit }),
      }));
    return (
      <div className="layout-col tablet-col" ref={isEditor ? rightColRef : leftColRef}>
        <div className="pane" style={{ flex: `0 0 ${split * 100}%`, minHeight: 0 }}>
          {paneCtlMax(top.id)}
          {top.body}
        </div>
        <Splitter axis="y" onResize={onSplit} onReset={onReset} />
        <div
          className={bottom.isView ? 'view-pane' : 'pane'}
          style={{ flex: '1 1 auto', minHeight: 0 }}
        >
          {paneCtlMax(bottom.id)}
          {bottom.body}
        </div>
      </div>
    );
  };

  // Full-page boot screens: same centered layout as main.tsx's crash page, but
  // driven by whether the backend answered. 'ready' falls through to the app.
  if (boot !== 'ready') {
    return (
      <div className={'app app-' + mode}>
        <div className="boot-screen">
          <img className="boot-logo" src={logoImg} alt="" />
          {boot === 'loading' ? (
            <>
              <div className="boot-spinner" aria-hidden="true" />
              <p>Waking Peacha up…</p>
            </>
          ) : (
            <>
              <h1>Peacha can't reach the backend</h1>
              <p>The editor loaded, but the server isn't answering. It may be starting up or briefly down.</p>
              <button onClick={() => location.reload()}>Retry</button>
              {error ? <pre className="boot-detail">{error}</pre> : null}
            </>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className={'app app-' + mode}>
      <header className="toolbar">
        <div className="tb-brand">
          <img className="toolbar-logo" src={logoImg} alt="" />
          <span className="tb-wordmark">Peacha</span>
        </div>

        {/* The middle action clusters. On desktop this is an inline row; below
            1024px the .tb-actions block becomes a dropdown panel revealed by the
            "⋯" overflow button (see .open). Selecting an action closes it. */}
        <div className={'tb-actions' + (menuOpen ? ' open' : '')}>
          <div className="tb-group">
            <button
              onClick={() => {
                void copyShareLink();
                setMenuOpen(false);
              }}
              disabled={leftTab === 'exams'}
              title={
                leftTab === 'exams'
                  ? 'sharing is off during exams'
                  : 'copy a URL that restores this state'
              }
            >
              share
            </button>
          </div>

          <span className="tb-divider" aria-hidden="true" />

          <div className="tb-group">
            <input
              ref={fileInputRef}
              type="file"
              accept="application/json,.json"
              style={{ display: 'none' }}
              onChange={async (e) => {
                const file = e.target.files?.[0];
                if (file) await handleUpload(file);
                e.target.value = '';
              }}
            />
            <button
              onClick={() => {
                fileInputRef.current?.click();
                setMenuOpen(false);
              }}
              title="load a workloads/*-snapshot.json - replaces the workloads layer (system stays)"
            >
              load topology
            </button>
            <button
              onClick={() => {
                resetWorkloads();
                setMenuOpen(false);
              }}
              title="reset the workloads layer to the embedded topology.yaml"
              disabled={!baseTopology}
            >
              reset workloads
            </button>
          </div>

          {providers.length > 1 || baseTopology ? (
            <>
              <span className="tb-divider" aria-hidden="true" />
              <div className="tb-group">
              <span className="tb-label">Providers</span>
                {providers.length > 1 ? (
                  <select
                    className="provider-select"
                    value={provider}
                    onChange={(e) => switchProvider(e.target.value)}
                    title="cluster provider - swaps the system baseline (your workloads + policies stay)"
                  >
                    {providers.map((p) => (
                      <option key={p} value={p}>
                        {p}
                      </option>
                    ))}
                  </select>
                ) : null}
                {baseTopology ? (
                  <span
                    className="baseline-info"
                    title="system pods loaded from embedded cluster snapshots"
                  >
                    baseline: {baseTopology.system.endpoints.length} system pods across{' '}
                    {baseTopology.system.namespaces.length} ns
                  </span>
                ) : null}
              </div>
            </>
          ) : null}

          {capabilities.length || versions ? (
            <>
              <span className="tb-divider" aria-hidden="true" />
              <div className="tb-group">
                <button
                  onClick={() => {
                    setShowCaps((s) => !s);
                    setMenuOpen(false);
                  }}
                  title="what policy features this engine honours (and its caveats), plus build versions"
                >
                  capabilities
                </button>
              </div>
            </>
          ) : null}
        </div>

        <div className="tb-right">
          <span className={'status' + (error || status.startsWith('⚠') ? ' error' : '')}>{error || status}</span>
          <a
            className="nav-icon"
            href="https://github.com/frozenprocess/peacha"
            target="_blank"
            rel="noopener noreferrer"
            title="view this project on GitHub"
            aria-label="project on GitHub"
          >
            <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false">
              <path
                fill="currentColor"
                d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"
              />
            </svg>
          </a>
          <button
            className="theme-toggle"
            onClick={() => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))}
            title={theme === 'dark' ? 'switch to light theme' : 'switch to dark theme'}
            aria-label="toggle color theme"
          >
            {theme === 'dark' ? '☀' : '☾'}
          </button>
          {/* Overflow trigger - hidden on desktop via CSS; reveals .tb-actions
              as a dropdown on phone/tablet. */}
          <button
            className="tb-overflow"
            onClick={() => setMenuOpen((o) => !o)}
            aria-label="more actions"
            aria-expanded={menuOpen}
            title="more actions"
          >
            ⋯
          </button>
        </div>
      </header>

      {/* Click-catcher that closes the overflow dropdown. Only rendered in
          compact modes where the menu can actually open. */}
      {menuOpen && mode !== 'desktop' ? (
        <div className="tb-menu-backdrop" onClick={() => setMenuOpen(false)} />
      ) : null}

      {showCaps ? (
        <CapabilitiesModal
          capabilities={capabilities}
          versions={versions}
          onClose={() => setShowCaps(false)}
        />
      ) : null}

      <div className="layout" ref={layoutRef}>
        {mode === 'phone' ? (
          // Phone: exactly one pane, chosen by the bottom tab bar. `maximized`
          // is ignored here (the layout is already single-pane), so a restored
          // desktop maximize can't strand the phone on the wrong pane.
          renderSinglePane(mobilePane)
        ) : maximized ? (
          // Full-screen: render only the maximized pane below the toolbar.
          <div className={(maximized === 'view' ? 'view-pane' : 'pane') + ' maximized'}>
            {paneCtl(maximized)}
            {maximized === 'topology'
              ? topologyBody
              : maximized === 'docs'
                ? docsBody
                : maximized === 'policy'
                  ? policyBody
                  : viewBody}
          </div>
        ) : mode === 'tablet' ? (
          // Tablet: one stacked column-pair at a time, swapped by the bottom toggle.
          renderTabletColumn(tabletCol)
        ) : (
          <>
            {/* Left column: docs stacked over topology. */}
            {renderColumn(
              leftColRef,
              { flex: `0 0 ${colSplit}rem`, minWidth: 0 },
              { id: 'docs', body: docsBody, label: 'tutorials' },
              { id: 'topology', body: topologyBody, label: 'topology' },
              leftSplit,
              onLeftSplit,
              () => setLayout((l) => ({ ...l, leftSplit: DEFAULT_LAYOUT.leftSplit })),
            )}

            {/* Vertical seam between the two columns. */}
            <Splitter
              axis="x"
              onResize={onColResize}
              onReset={() => setLayout((l) => ({ ...l, colSplit: DEFAULT_LAYOUT.colSplit }))}
            />

            {/* Right column: policy stacked over the dataplane view. */}
            {renderColumn(
              rightColRef,
              { flex: '1 1 auto', minWidth: 0 },
              { id: 'policy', body: policyBody, label: 'policy' },
              { id: 'view', body: viewBody, label: 'dataplane view', isView: true },
              rightSplit,
              onRightSplit,
              () => setLayout((l) => ({ ...l, rightSplit: DEFAULT_LAYOUT.rightSplit })),
            )}
          </>
        )}
      </div>

      {/* Phone: bottom tab bar switching the single visible pane. */}
      {mode === 'phone' ? (
        <nav className="mobile-tabbar" aria-label="panes">
          {([
            { id: 'docs', label: 'Docs' },
            { id: 'topology', label: 'Topology' },
            { id: 'policy', label: 'Policy' },
            { id: 'view', label: 'View' },
          ] as { id: PaneId; label: string }[]).map((t) => (
            <button
              key={t.id}
              className={mobilePane === t.id ? 'active' : ''}
              aria-current={mobilePane === t.id}
              onClick={() => setMobilePane(t.id)}
            >
              {t.label}
            </button>
          ))}
        </nav>
      ) : mode === 'tablet' ? (
        // Tablet: toggle between the two column-pairs.
        <nav className="mobile-tabbar tablet-toggle" aria-label="workspace">
          <button
            className={tabletCol === 'docs' ? 'active' : ''}
            aria-current={tabletCol === 'docs'}
            onClick={() => setTabletCol('docs')}
          >
            Docs · Topology
          </button>
          <button
            className={tabletCol === 'editor' ? 'active' : ''}
            aria-current={tabletCol === 'editor'}
            onClick={() => setTabletCol('editor')}
          >
            Policy · View
          </button>
        </nav>
      ) : null}
    </div>
  );
}

// CapabilitiesModal lists what the engine honours. Unsupported features are
// flagged so a green matrix for one of them isn't taken at face value; the
// Notes carry the caveats (e.g. named ports deny, FQDN needs the DNS stub). A
// footer shows the build versions of the components behind the evaluation so a
// reported behaviour can be pinned to a specific engine / Calico build.
//
// Rendered as a centered modal over a dimmed backdrop: click-outside or Escape
// dismisses it (the toolbar button also toggles it).
function CapabilitiesModal({
  capabilities,
  versions,
  onClose,
}: {
  capabilities: Capability[];
  versions: Versions | null;
  onClose: () => void;
}) {
  // Escape closes the modal from anywhere; the listener is torn down on unmount.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const githubLink = (href: string, label: string) => (
    <a
      className="version-gh-link"
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={label}
      title={label}
    >
      <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true" focusable="false">
        <path
          fill="currentColor"
          d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"
        />
      </svg>
    </a>
  );

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal caps-modal"
        role="dialog"
        aria-modal="true"
        aria-label="engine info"
        // Clicks inside the panel must not bubble to the backdrop's close handler.
        onClick={(e) => e.stopPropagation()}
      >
        <div className="caps-head">
          <strong>engine info</strong>
          <button className="link" onClick={onClose} aria-label="close">
            close
          </button>
        </div>
        {versions ? (
          <div className="caps-section">
            <div className="caps-section-head">versions</div>
            <dl className="caps-version-list">
              <dt>Editor (Peacha):</dt>
              <dd>
                <span>{versions.editor}</span>
                {githubLink('https://github.com/frozenprocess/peacha', 'Peacha on GitHub')}
              </dd>
              <dt>Simulation Engine (Telepathy):</dt>
              <dd>
                <span>{versions.engine}</span>
                {githubLink('https://github.com/frozenprocess/telepathy', 'Telepathy on GitHub')}
              </dd>
              <dt>Policy Engine (Project Calico):</dt>
              <dd>
                <span>{versions.calico}</span>
                {githubLink('https://github.com/projectcalico/calico', 'Project Calico on GitHub')}
              </dd>
            </dl>
          </div>
        ) : null}
        <div className="caps-section">
          <div className="caps-section-head">engine capabilities</div>
          <table className="caps-table">
            <tbody>
              {capabilities.map((c) => (
                <tr key={c.name} className={c.supported ? 'cap-ok' : 'cap-no'}>
                  <td className="cap-mark">{c.supported ? '✓' : '✗'}</td>
                  <td className="cap-name">{c.name}</td>
                  <td className="cap-notes">{c.notes ?? ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

// Reconcile the per-probe visibility map with whatever probes the latest
// evaluation actually returned. Returns the SAME reference (`prev`) when no
// keys were added or removed - that lets React's setState bailout skip the
// re-render and breaks the eval -> setProbeFilter -> render -> eval loop.
//
// New probes start visible (true); removed probes drop out of the map so we
// don't leak stale state when the user removes a probe from the topology.
function syncProbeFilter(
  prev: Record<string, boolean>,
  current: string[],
): Record<string, boolean> {
  const have = new Set(current);
  let changed = false;
  const next: Record<string, boolean> = {};
  for (const k of Object.keys(prev)) {
    if (have.has(k)) next[k] = prev[k];
    else changed = true; // dropped
  }
  for (const k of current) {
    if (!(k in prev)) {
      next[k] = true;
      changed = true; // new
    }
  }
  return changed ? next : prev;
}

// Split the policy YAML bundle into [{flavor, yaml}]. Same logic as M2,
// lifted out so the requestForServer memo is cleaner.
function splitPolicies(text: string): PolicyInput[] {
  const out: PolicyInput[] = [];
  for (const raw of text.split(/^---\s*$/m)) {
    const yaml = raw.trim();
    if (!yaml) continue;
    const m = yaml.match(/^apiVersion:\s*(\S+)/m);
    const flavor: 'k8s' | 'calico' =
      m && m[1].startsWith('networking.k8s.io') ? 'k8s' : 'calico';
    out.push({ yaml, flavor });
  }
  return out;
}
