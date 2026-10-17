// Thin client for the Go server. Same JSON shapes as editor/server/types.go;
// we keep them mirrored here by hand for now (a future schema endpoint can
// generate them, but two structs is the wrong order of magnitude for that).

export interface EndpointPort {
  name: string;
  port: number;
  protocol?: string; // tcp | udp | sctp (case-insensitive); empty -> tcp
}

export interface Endpoint {
  id: string;
  namespace: string;
  name: string;
  ip: string;
  labels: Record<string, string>;
  // Optional engine extensions. Named ports resolve `ports: [http]` rule
  // refs; serviceAccountName projects pcsa.* labels for serviceAccount
  // selectors; node ties the endpoint to HostEndpoint overlays on the
  // same node (applyOnForward / preDNAT).
  ports?: EndpointPort[];
  serviceAccountName?: string;
  node?: string;
  // unpoliced marks a node with no HostEndpoint: Calico doesn't police host
  // traffic until a HEP exists, so the engine treats this endpoint's own
  // egress/ingress as unconditionally allowed (only the peer's policy limits a
  // flow). Surfaces an unprotected node's real posture - e.g. it still reaches
  // the internet under a pod-only deny-all. Mirrors engine.Endpoint.Unpoliced.
  unpoliced?: boolean;
  // role is the caller's semantic intent, echoed back as the matching
  // Actor.kind so the engine - not the SPA - decides [EXT]/[HOST] typing (an
  // external destination and an unpoliced host are otherwise identical
  // unpoliced endpoints). "" → workload. Mirrors engine.Endpoint.Role.
  role?: 'workload' | 'external' | 'host';
}

// Actor is the engine's typed description of one matrix row/col (mirror of
// engine.Actor). It's the single source of endpoint typing the SPA renders
// from - see buildImpact in impact.ts.
export interface Actor {
  id: string;
  kind: 'workload' | 'external' | 'hep' | 'host-unpoliced';
  node?: string;
  internet?: 'allow' | 'deny'; // single-probe; the SPA recomputes across probes
}

export interface NamespaceInput {
  name: string;
  labels: Record<string, string>;
}

export interface PolicyInput {
  flavor: 'k8s' | 'calico';
  yaml: string;
}

// TierInput is one user-defined Calico Tier (mirror of server.TierInput). The
// server renders it into a `kind: Tier` doc and feeds it before the policies.
// order sets precedence (lower applies first); defaultAction is what happens to
// a packet selected by a policy in the tier but matched by no rule.
export interface TierInput {
  name: string;
  order: number;
  defaultAction?: 'Pass' | 'Deny';
}

// ReservedTier describes a tier the engine always pre-creates (not editable).
// Shown read-only in the tiers tab so users see the full evaluation pipeline
// their custom tiers slot into. Orders/actions mirror calico-engine graph.go.
export interface ReservedTier extends TierInput {
  reserved: true;
}

// The three tiers calico-engine/engine/graph.go sends before any policy, in
// precedence order (lower order applies first). kube-admin/kube-baseline hold
// the NPA ClusterNetworkPolicies; default holds k8s NPs + Calico (G)NPs.
export const RESERVED_TIERS: ReservedTier[] = [
  { name: 'kube-admin', order: 1_000, defaultAction: 'Pass', reserved: true },
  { name: 'default', order: 1_000_000, defaultAction: 'Deny', reserved: true },
  { name: 'kube-baseline', order: 10_000_000, defaultAction: 'Pass', reserved: true },
];

// --- Optional engine resources (mirror of engine/types.go input structs) ---

export interface ServiceAccountInput {
  name: string;
  namespace: string;
  labels?: Record<string, string>;
}

export interface HostEndpointInput {
  id: string; // "host/<name>"
  name: string;
  node?: string;
  interfaceName?: string;
  expectedIPs: string[];
  labels?: Record<string, string>;
}

export interface NetworkSetInput {
  name: string;
  namespace: string;
  nets?: string[];
  labels?: Record<string, string>;
}

export interface GlobalNetworkSetInput {
  name: string;
  nets?: string[];
  labels?: Record<string, string>;
}

export interface ServicePort {
  name?: string;
  port: number;
  protocol?: string;
  targetPort?: string;
}

export interface ServiceInput {
  name: string;
  namespace: string;
  selector?: Record<string, string>;
  ports?: ServicePort[];
}

export interface EndpointSliceInput {
  name: string;
  namespace: string;
  serviceName: string;
  addresses: string[];
}

// ExternalEndpointInput is an off-cluster destination (the internet, a partner
// API, …) the editor injects as an `unpoliced` engine endpoint so policies that
// allow/deny egress to its IP (via destination.nets / a GlobalNetworkSet) are
// reflected. id is a free-form "<ns>/<name>" (e.g. "world/internet") so it sorts
// and renders like a pod; ip is the address the engine matches against. Mirrors
// harness.py's DEFAULT_EXTERNAL_ENDPOINTS. unpoliced is implied (the internet
// has no Calico ingress) - the editor sets it when expanding to an engine
// endpoint, so reach is decided solely by the peer pod's policy.
export interface ExternalEndpointInput {
  id: string;
  ip: string;
  labels?: Record<string, string>;
}

// The built-in external object, on by default (mirrors the harness always-on
// world/internet). RFC 5737 TEST-NET-3 - a documentation address that can't
// collide with a real pod/cluster IP, so it cleanly stands in for "the internet".
export const DEFAULT_EXTERNAL_ENDPOINTS: ExternalEndpointInput[] = [
  { id: 'world/internet', ip: '203.0.113.1', labels: { scope: 'internet' } },
];

// Resources groups the optional engine input lists. Mirrors server.Resources
// (embedded into EditorRequest / Topology layers / Example).
export interface Resources {
  serviceAccounts?: ServiceAccountInput[];
  hostEndpoints?: HostEndpointInput[];
  networkSets?: NetworkSetInput[];
  globalNetworkSets?: GlobalNetworkSetInput[];
  services?: ServiceInput[];
  endpointSlices?: EndpointSliceInput[];
}

// The set of probe protocols engine.protocolNumber accepts. Numeric strings
// ("1".."255") are also valid but the UI offers the named ones.
export type ProbeProtocol =
  | 'tcp'
  | 'udp'
  | 'icmp'
  | 'icmpv6'
  | 'sctp'
  | 'udplite';

export interface Probe {
  name: string;
  port: number;
  protocol: ProbeProtocol | string;
  // Per-probe engine knobs. srcPort defaults to 12345 server-side when 0;
  // httpMethod/httpPath drive rule.http matchers (ingress-only); icmpType/
  // icmpCode are null/undefined to mean "don't filter on ICMP type/code".
  srcPort?: number;
  httpMethod?: string;
  httpPath?: string;
  icmpType?: number | null;
  icmpCode?: number | null;
}

export interface EditorRequest extends Resources {
  endpoints: Endpoint[];
  namespaces: NamespaceInput[];
  policies: PolicyInput[];
  probes: Probe[];
  tiers?: TierInput[];
  dns?: Record<string, string[]>;
  evaluateStaged?: boolean;
  strictLint?: boolean;
  // Off-cluster destinations. Editor-only: expanded into unpoliced engine
  // endpoints at evaluate-time (not a distinct wire field), so the matrix/graph
  // show internet-egress posture. Empty/absent = no external object.
  externalEndpoints?: ExternalEndpointInput[];
}

export interface EditorResponse {
  matrices: Record<string, Record<string, 'allow' | 'deny'>>;
  errors?: string[];
  warnings?: string[];
  // Typed row/col directory from the engine - the single source of endpoint
  // typing. Probe-independent (Kind/Node); buildImpact turns it into the
  // [EXT]/[HEP]/[HOST] sets the Matrix + Graph render from.
  actors?: Actor[];
  // Policy-efficiency report for the whole policy set (present only when the
  // request carried policies). Lower cost = leaner. See CostReport.
  cost?: CostReport;
  // Per-dataplane weight for each view the tabs can show, keyed
  // "iptables"|"nftables"|"bpf"|"hns". The cost bar shows the one matching the
  // active view; cost.structural/hygiene/cost are dataplane-independent.
  dataplanes?: Record<string, CostDataplane>;
}

// CostReport mirrors telepathy api.CostReport. cost is the headline score
// (lower = leaner, 0 = no policy); structural + hygiene are engine-independent;
// dataplane is the engine's real compiled weight (absent for engines that
// can't render offline).
export interface CostReport {
  engine?: string;
  structural: CostStructural;
  hygiene?: CostFinding[];
  dataplane?: CostDataplane;
  cost: number;
  formulaVersion: number;
}

export interface CostStructural {
  policies: number;
  rules: number;
  cidrs: number;
  ports: number;
  negations: number;
  resolvedPeers?: number;
  maxStack?: number;
}

export interface CostFinding {
  policy: string;
  rule?: number;
  code: string; // e.g. "broad-selector", "duplicate-rule", "inline-ports"
  detail: string;
  penalty: number;
}

export interface CostDataplane {
  kind: string; // "iptables" | "nftables" | "ebpf" | "hns" | "policy-map"
  rules: number;
  rulesUnit: string; // "rules" | "acl-rules" | "instructions"
  peerEntries: number;
  ipSets: number;
  byEndpoint?: Record<string, number>;
}

export interface Example extends Resources {
  name: string;
  description: string;
  // May be null/absent: a policy-less lesson (e.g. the intro tour) carries none.
  policies: PolicyInput[] | null;
  probes?: Probe[];
  externalEndpoints?: ExternalEndpointInput[];
  dns?: Record<string, string[]>;
  evaluateStaged?: boolean;
}

/**
 * A read-along tutorial (mirror of server.Tutorial). It IS an Example - the
 * server flattens the embedded Example into the same shape loadExample()
 * already consumes - plus the lesson prose (`doc`, markdown) and the ordering
 * metadata the learning track renders from.
 */
export interface Tutorial extends Example {
  title: string;
  track?: string;
  order: number;
  summary?: string;
  // Embed folder name (may differ from `name`); used to build asset URLs:
  // GET /v1/tutorials/<dir>/<file> for images a lesson references.
  dir: string;
  doc: string;
  // When true, the page shows the read-along feedback widget (opted in via
  // meta.json "feedback": true). Absent/false on most pages.
  feedback?: boolean;
  // When true, this is the free-form Playground sandbox doc, not a track lesson
  // (meta.json "playground": true). The SPA filters it out of the tutorials list
  // and renders it under the standalone Playground tab served at "/".
  playground?: boolean;
}

/**
 * Reader-entered fields posted to POST /v1/tutorials/<name>/feedback. Identity
 * (the signed-in subject, if any) is attached server-side from the session
 * cookie - never sent from here - so this carries only what the reader typed.
 */
export interface TutorialFeedback {
  rating: 'up' | 'down';
  comment?: string;
  consent?: boolean;
  name?: string;
  org?: string;
}

/**
 * A graded exam (mirror of server.Exam). Like a Tutorial it IS an Example - the
 * server flattens the embedded Example so selecting an exam loads its starter
 * scenario via loadExample() - plus the prompt prose (`doc`) and ordering
 * metadata. The answer key (expected flows + guardrail constraints) is NEVER
 * sent to the client: grading happens server-side at POST /v1/exams/<name>/grade.
 */
export interface Exam extends Example {
  title: string;
  track?: string;
  order: number;
  summary?: string;
  dir: string;
  doc: string;
}

/** One line of a grade report (mirror of server.CheckResult). */
export interface GradeCheck {
  kind: 'flow' | 'constraint';
  description: string;
  passed: boolean;
  detail?: string;
}

/** The grade verdict (mirror of server.GradeResult). */
export interface GradeResult {
  exam: string;
  passed: boolean;
  checks: GradeCheck[];
  errors?: string[];
  recorded: boolean; // whether the pass was persisted (auth configured + signed in)
}

/**
 * The signed-in identity surfaced to the SPA. PII-free by design: the server
 * exposes only which provider the session came from (no name/email/picture).
 */
export interface AuthUser {
  provider?: string;
}

/**
 * GET /v1/auth/config - whether login is configured, which OAuth backends are
 * enabled (slack | google | github, in display order), and the current user.
 */
export interface AuthConfig {
  enabled: boolean;
  providers?: string[];
  /** Optional per-provider link to sign in to (or join) the provider's workspace
   *  before OAuth - keyed by provider name (e.g. { slack: 'https://…' }). Slack
   *  can't deep-link a logged-out user to a specific workspace, so the gate
   *  offers this so they can establish a session first. */
  workspaceUrls?: Record<string, string>;
  user?: AuthUser;
  /** Days a recorded exam pass is retained before automatic deletion (0 = kept
   *  indefinitely). Surfaced so the sign-in privacy notice stays accurate to the
   *  server's actual --results-retention-days setting. */
  retentionDays?: number;
  /** Admin-set (--exam-auto-advance / EXAM_AUTO_ADVANCE): whether the exam pane
   *  auto-advances to the next exam after a pass. Not learner-controllable; the
   *  SPA only reads it. Absent (e.g. config fetch failed) → treated as true. */
  examAutoAdvance?: boolean;
}

/** Mirror of engine.Capability - the engine's self-described feature list. */
export interface Capability {
  name: string;
  supported: boolean;
  notes?: string;
}

// --- eBPF policy-program render (mirror of engine.BPFProgram/BPFResponse) ---

// The concise render is structured (tiers/profiles); only the verbose
// disassembly comes back as text lines. Go omitempty drops whichever is unused.
export interface BPFProgram {
  endpoint: string;
  interface: string;
  direction: string;
  ipVersion: number;
  subPrograms?: number;
  instructions?: number; // total eBPF instructions across sub-programs
  tiers?: BPFTier[];
  profiles?: BPFProfile[];
  lines?: string[]; // verbose only
  error?: string;
}

export interface BPFTier {
  name: string;
  defaultAction?: string; // "deny" | "pass"
  policies?: BPFPolicy[];
}

export interface BPFPolicy {
  kind?: string;
  namespace?: string; // empty for cluster-scoped kinds
  name: string;
  rules?: BPFRule[];
}

/** A workload's default profile, evaluated after every tier passes. */
export interface BPFProfile {
  name: string;
  rules?: BPFRule[];
}

export interface BPFRule {
  action: string;
  matchID: number; // uint64 hash: exceeds 2^53, so lossy in JS - don't key on it
  protocol?: string;
  notProtocol?: string;
  source?: BPFEntity;
  destination?: BPFEntity;
  icmp?: BPFICMP;
  notICMP?: BPFICMP;
}

export interface BPFEntity {
  nets?: string[];
  notNets?: string[];
  ipSets?: BPFIPSet[];
  notIPSets?: BPFIPSet[];
  ports?: BPFPortRange[];
  notPorts?: BPFPortRange[];
  namedPorts?: string[];
  notNamedPorts?: string[];
}

/** An IP set's ID plus the members the calc graph resolved it to. */
export interface BPFIPSet {
  id: string;
  members?: string[];
}

export interface BPFPortRange {
  first: number;
  last: number; // == first for a single port
}

export interface BPFICMP {
  type: number;
  code?: number;
}

export interface BPFResponse {
  programs: BPFProgram[];
  warnings?: string[];
  errors?: string[];
}

/** Render filters posted alongside the topology to /v1/bpf. */
export interface BPFRenderOptions {
  endpoint?: string; // substring filter; empty = all endpoints
  direction?: 'ingress' | 'egress' | 'both';
  ipVersion?: '4' | '6' | 'both' | ''; // '' = inferred from endpoints
  verbose?: boolean; // true = full eBPF disassembly; false (default) = concise tree
}

// --- iptables/nftables render (mirror of engine.Iptables* response types) ---

export interface RenderedChain {
  name: string;
  lines: string[];
}

export interface RenderedTable {
  table: string;
  chains: RenderedChain[];
}

export interface RenderedDataplane {
  backend: string; // "iptables" | "nftables"
  ipVersion: number;
  tables: RenderedTable[];
}

export interface IptablesResponse {
  dataplanes: RenderedDataplane[];
  warnings?: string[];
  errors?: string[];
}

/** Render filters posted alongside the topology to /v1/iptables. */
export interface IptablesRenderOptions {
  backend?: 'iptables' | 'nftables' | 'both';
  ipVersion?: '4' | '6' | 'both' | ''; // '' = inferred from endpoints
  includeStatic?: boolean;
  endpoint?: string; // substring filter; empty = all endpoints' chains
}

// --- HNS render (mirror of engine.HNS* response types) ---

/** One rendered HNS ACL policy (rule); mirror of engine.HNSRule. */
export interface HNSRule {
  id?: string;
  action: string;
  direction: string;
  ruleType: string;
  protocol: number;
  localAddresses?: string;
  remoteAddresses?: string;
  localPorts?: string;
  remotePorts?: string;
  priority: number;
}

/** The flattened ACL list for one (endpoint, direction); mirror of
 *  engine.HNSEndpointPolicy. */
export interface HNSEndpointPolicy {
  endpoint: string;
  interface: string;
  direction: string;
  ipVersion: number;
  rules: HNSRule[];
  error?: string;
}

export interface HNSResponse {
  endpoints: HNSEndpointPolicy[];
  warnings?: string[];
  errors?: string[];
}

/** Render filters posted alongside the topology to /v1/hns. */
export interface HNSRenderOptions {
  endpoint?: string; // substring filter; empty = all endpoints
  direction?: 'ingress' | 'egress' | 'both';
  ipVersion?: '4' | '6' | 'both' | ''; // '' = IPv4 (HNS is IPv4-only)
}

/** NodeInfo mirrors server.NodeInfo - one k8s node, used by the node-grouped
 *  graph view to draw a box per node (incl. nodes with no sampled endpoint).
 *  Display only; not part of an engine request. */
export interface NodeInfo {
  name: string;
  ip?: string;
  interfaceName?: string;
  labels?: Record<string, string>;
}

/** Mirror of server/baseline.go Topology. The SPA renders System as a
 *  fixed (non-editable) baseline; Workloads is the initial editable layer.
 *  Both layers embed the optional Resources lists. */
export interface TopologyLayer extends Resources {
  namespaces: NamespaceInput[];
  endpoints: Endpoint[];
  nodes?: NodeInfo[];
}

export interface Topology {
  system: TopologyLayer;
  workloads: TopologyLayer;
  probes: Probe[];
  dns?: Record<string, string[]>;
  /** Provider this topology was built from (e.g. "kind", "gke"). */
  provider?: string;
  /** Every provider the server discovered, for the toolbar switcher. */
  providers?: string[];
}

/** GET /v1/topology - optionally for a specific provider. An empty/unknown
 *  provider falls back to the server's default; the response echoes which
 *  provider was served plus the full provider list. */
export async function getTopology(provider?: string): Promise<Topology> {
  const q = provider ? `?provider=${encodeURIComponent(provider)}` : '';
  const res = await fetch(`/v1/topology${q}`);
  if (!res.ok) throw new Error(`topology ${res.status}`);
  return res.json();
}

/**
 * POST /v1/evaluate. Accepts an AbortSignal so a superseding edit cancels the
 * in-flight call (the Go side serialises Evaluate anyway, so cancelling a
 * stale call frees the next request from waiting in line).
 */
export async function evaluate(
  req: EditorRequest,
  signal?: AbortSignal,
): Promise<EditorResponse> {
  const res = await fetch('/v1/evaluate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(req),
    signal,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`evaluate ${res.status}: ${text}`);
  }
  return res.json();
}

export async function listTutorials(): Promise<Tutorial[]> {
  const res = await fetch('/v1/tutorials');
  if (!res.ok) throw new Error(`tutorials ${res.status}`);
  return res.json();
}

export async function listExams(): Promise<Exam[]> {
  const res = await fetch('/v1/exams');
  if (!res.ok) throw new Error(`exams ${res.status}`);
  return res.json();
}

/**
 * POST /v1/exams/<name>/grade. Submits the learner's policies (+ tiers) - the
 * server reconstructs the topology, runs the engine on the exam's fixed probes,
 * and returns the per-check verdict. A 401 means login is required (auth is
 * configured but no valid session); the caller surfaces the Slack login.
 */
export async function gradeExam(
  name: string,
  body: { provider?: string; policies: PolicyInput[]; tiers?: TierInput[] },
): Promise<GradeResult> {
  const res = await fetch(`/v1/exams/${encodeURIComponent(name)}/grade`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (res.status === 401) throw new Error('login required');
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`grade ${res.status}: ${text}`);
  }
  return res.json();
}

/**
 * GET /v1/exams/<name>/solution - the exam's reference solution YAML. The server
 * serves this ONLY in dev (when no login backend is configured) and 404s
 * otherwise, so it can't be fetched on a real, login-gated deployment. The SPA
 * likewise only offers the affordance when auth is disabled.
 */
export async function getExamSolution(name: string): Promise<string> {
  const res = await fetch(`/v1/exams/${encodeURIComponent(name)}/solution`);
  if (!res.ok) throw new Error(`solution ${res.status}`);
  return res.text();
}

/** GET /v1/auth/config - whether Slack login is on and who (if anyone) is in. */
export async function getAuthConfig(): Promise<AuthConfig> {
  const res = await fetch('/v1/auth/config');
  if (!res.ok) throw new Error(`auth config ${res.status}`);
  return res.json();
}

/** GET /v1/exams/results/me - exam slugs the signed-in user has passed. */
export async function getPassedExams(): Promise<string[]> {
  const res = await fetch('/v1/exams/results/me');
  if (!res.ok) return [];
  const j = await res.json();
  return j.passed ?? [];
}

/**
 * POST /v1/tutorials/<name>/feedback - record one read-along feedback
 * submission. Ungated (anyone can submit); the session cookie rides along so the
 * server attaches the signed-in identity when there is one. Returns whether the
 * submission was persisted (false when the deployment has no results store).
 */
export async function submitTutorialFeedback(
  name: string,
  body: TutorialFeedback,
): Promise<{ recorded: boolean }> {
  const res = await fetch(`/v1/tutorials/${encodeURIComponent(name)}/feedback`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`feedback ${res.status}: ${text}`);
  }
  return res.json();
}

/**
 * POST /v1/links - mint a tiny share link for a relative same-origin URL (path +
 * optional "#<fragment>"). Returns the absolute short URL ("<origin>/s/<code>")
 * on success, or null when the server has no link store (dev / no --results-file)
 * or the request fails - the caller then falls back to the long, self-contained
 * #fragment link. Never throws: short links are an enhancement, not a dependency.
 */
export async function createShareLink(target: string): Promise<string | null> {
  try {
    const res = await fetch('/v1/links', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ target }),
    });
    if (!res.ok) return null;
    const j = (await res.json()) as { url?: string };
    return j.url ? window.location.origin + j.url : null;
  } catch {
    return null;
  }
}

/** POST /v1/auth/logout - clear the session cookie. */
export async function logout(): Promise<void> {
  await fetch('/v1/auth/logout', { method: 'POST' });
}

/**
 * Run the OAuth login flow in a centred popup, resolving once the server's
 * callback messages back success. The callback page (reached via ?popup=1)
 * posts {type:'peacha-auth', ok, error} to window.opener; we validate the
 * origin, then resolve (and close the popup) on ok or reject on error. Rejects
 * with 'popup blocked' if the browser refused the window and 'sign in
 * cancelled' if the user closes it before finishing. The session cookie is set
 * on this origin during the flow, so the caller just re-fetches auth state.
 */
export function signInWithPopup(provider: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const w = 480;
    const h = 720;
    const left = window.screenX + Math.max(0, (window.outerWidth - w) / 2);
    const top = window.screenY + Math.max(0, (window.outerHeight - h) / 2);
    const popup = window.open(
      `/v1/auth/login/${encodeURIComponent(provider)}?popup=1`,
      'peacha-oauth',
      `width=${w},height=${h},left=${left},top=${top}`,
    );
    if (!popup) {
      reject(new Error('popup blocked'));
      return;
    }
    let done = false;
    const finish = (fn: () => void) => {
      if (done) return;
      done = true;
      window.removeEventListener('message', onMsg);
      window.clearInterval(poll);
      fn();
    };
    const onMsg = (e: MessageEvent) => {
      if (e.origin !== window.location.origin) return;
      const d = e.data as { type?: string; ok?: boolean; error?: string } | null;
      if (!d || d.type !== 'peacha-auth') return;
      if (d.ok) {
        finish(() => {
          try {
            popup.close();
          } catch {
            /* opener can't always close cross-process popups; harmless */
          }
          resolve();
        });
      } else {
        // Leave the popup open showing the reason; reject so the gate can echo it.
        finish(() => reject(new Error(d.error || 'sign in failed')));
      }
    };
    window.addEventListener('message', onMsg);
    // No success message + a closed popup means the user abandoned the flow.
    // (On success the opener closes the popup, so `done` is already set first.)
    const poll = window.setInterval(() => {
      if (popup.closed) finish(() => reject(new Error('sign in cancelled')));
    }, 500);
  });
}

export async function getCapabilities(): Promise<Capability[]> {
  const res = await fetch('/v1/capabilities');
  if (!res.ok) throw new Error(`capabilities ${res.status}`);
  return res.json();
}

/** Build-stamped component versions (mirror of server.Versions). */
export interface Versions {
  editor: string;
  engine: string;
  calico: string;
}

/** GET /v1/version - the editor / engine / Calico build versions. */
export async function getVersion(): Promise<Versions> {
  const res = await fetch('/v1/version');
  if (!res.ok) throw new Error(`version ${res.status}`);
  return res.json();
}

/**
 * POST /v1/bpf. Renders the eBPF policy programs Felix would assemble for the
 * topology, filtered by the render options. Accepts an AbortSignal so a
 * superseding edit cancels the in-flight call.
 */
export async function renderBPF(
  req: EditorRequest,
  opts: BPFRenderOptions,
  signal?: AbortSignal,
): Promise<BPFResponse> {
  const res = await fetch('/v1/bpf', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...req, ...opts }),
    signal,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`bpf ${res.status}: ${text}`);
  }
  return res.json();
}

/**
 * POST /v1/iptables. Renders the iptables/nftables filter-table chains Felix
 * would program for the topology. AbortSignal cancels a superseded call.
 */
export async function renderIptables(
  req: EditorRequest,
  opts: IptablesRenderOptions,
  signal?: AbortSignal,
): Promise<IptablesResponse> {
  const res = await fetch('/v1/iptables', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...req, ...opts }),
    signal,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`iptables ${res.status}: ${text}`);
  }
  return res.json();
}

/**
 * POST /v1/hns. Renders the Windows HNS ACL policy lists Felix would install
 * on a Windows node for the topology. AbortSignal cancels a superseded call.
 */
export async function renderHNS(
  req: EditorRequest,
  opts: HNSRenderOptions,
  signal?: AbortSignal,
): Promise<HNSResponse> {
  const res = await fetch('/v1/hns', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...req, ...opts }),
    signal,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`hns ${res.status}: ${text}`);
  }
  return res.json();
}

// --- tier matches: which tiers/policies select each endpoint (mirror of
// engine.TierMatchResponse) - drives the tier view's highlight-on-select. ---

/** A resolved policy as the engine names it (verbatim metadata.name; Kind
 *  normalised to NetworkPolicy / GlobalNetworkPolicy / KubernetesNetworkPolicy
 *  / KubernetesClusterNetworkPolicy; namespace "" for cluster-scoped kinds). */
export interface PolicyRef {
  kind: string;
  namespace: string;
  name: string;
}

export interface TierMatch {
  endpoint: string;
  tiers: string[]; // tiers whose end-of-tier action is in this endpoint's path
  policies: PolicyRef[]; // policies (ingress ∪ egress) that select this endpoint
}

export interface TierMatchResponse {
  endpoints: TierMatch[];
  /** Tier name → number of directional flows (for the probe) that reach that
   *  tier's end-of-tier default action: selected by the tier but no rule in it
   *  decided the flow (a partial match). Absent from older engines. */
  endOfTierFlows?: Record<string, number>;
  warnings?: string[];
  errors?: string[];
}

/**
 * POST /v1/tiers. Resolves, per endpoint, which tiers and policies select it
 * (Calico's own label resolution). AbortSignal cancels a superseded call.
 */
export async function resolveTierMatches(
  req: EditorRequest,
  signal?: AbortSignal,
): Promise<TierMatchResponse> {
  const res = await fetch('/v1/tiers', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(req),
    signal,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`tiers ${res.status}: ${text}`);
  }
  return res.json();
}
