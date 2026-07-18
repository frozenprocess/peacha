// Raw topology editor: the editable workloads layer (an EditorRequest, minus the
// `policies` field which lives in the policy editor) shown as one YAML document.
// Replaces the structured TopologyPane form - advanced users edit here, everyone
// else keeps the injected default topology or uploads their own (toolbar's "load
// topology" / "reset workloads"). Edits parse straight back into the request; a
// parse error is surfaced and the last good request is kept so a half-typed doc
// never wipes state.

import { useEffect, useMemo, useRef, useState } from 'react';
import Editor, { OnMount } from '@monaco-editor/react';
import { parse, stringify } from 'yaml';
import { EditorRequest, TopologyLayer } from '../api';

interface Props {
  request: EditorRequest;
  onChange: (next: EditorRequest) => void;
  // App's color theme; maps to Monaco's 'vs' / 'vs-dark' like PolicyEditor.
  theme: 'light' | 'dark';
  // The provider's system layer (kube-system/calico-system pods, nodes +
  // labels, host endpoints, …). Read-only: merged in at evaluate-time, shown
  // here collapsed so users can see what the workloads layer sits on top of.
  system?: TopologyLayer | null;
}

// HEADER is a commented field reference prepended to the workloads doc. Every
// line is a `#` comment so it never parses as data - it's a cheat-sheet users
// can read, copy from, or delete. Kept in sync with EditorRequest (api.ts).
const HEADER = `# ============================================================================
# EDITABLE TOPOLOGY - workloads layer
# ----------------------------------------------------------------------------
# System pods (kube-system, calico-system, tigera-operator, cluster nodes) are
# injected per-provider and merged in at evaluate-time - see the read-only
# "system baseline" tab. Policies live in the POLICY editor, not this document.
#
# Everything below is a commented example of what this doc accepts. Uncomment
# and edit, or write your own. Empty sections may be omitted entirely.
# ============================================================================
#
# --- namespaces: the namespaces your pods live in -----------------------------
# namespaces:
#   - name: shop
#     labels: { team: payments, env: prod }
#
# --- endpoints: the pods (workloads) to evaluate ------------------------------
# endpoints:
#   - id: shop/frontend           # unique "<namespace>/<name>"
#     namespace: shop
#     name: frontend
#     ip: 10.244.5.10             # any unique IP; routing is not simulated
#     labels: { app: frontend, tier: web }
#     ports:                      # named ports let policies say ports: [http]
#       - { name: http, port: 8080, protocol: tcp }
#     serviceAccountName: frontend-sa   # projects pcsa.* labels for SA selectors
#     node: worker-1              # ties to a HostEndpoint on the same node
#     unpoliced: false            # true = host with no HEP (traffic unpoliced)
#     role: workload              # workload | external | host
#
# --- probes: the connectivity checks the matrix runs (one column set each) ----
# probes:
#   - { name: tcp,   port: 8080, protocol: tcp }
#   - { name: udp,   port: 53,   protocol: udp }
#   - { name: icmp,  port: 0,    protocol: icmp, icmpType: 8, icmpCode: 0 }
#   - { name: "GET /admin", port: 80, protocol: tcp, httpMethod: GET, httpPath: /admin }
#
# --- tiers: extra Calico tiers policies can reference via spec.tier -----------
#     (reserved tiers default/kube-admin/kube-baseline already exist)
# tiers:
#   - { name: security, order: 100, defaultAction: Deny }   # Pass | Deny
#
# --- serviceAccounts: for policies with a serviceAccount selector -------------
# serviceAccounts:
#   - { name: frontend-sa, namespace: shop, labels: { role: web } }
#
# --- hostEndpoints: protect a node's host interface --------------------------
# hostEndpoints:
#   - id: host/worker-1-eth0
#     name: worker-1-eth0
#     node: worker-1
#     interfaceName: eth0
#     expectedIPs: [192.168.1.11]
#     labels: { role: worker }
#
# --- networkSets / globalNetworkSets: named CIDR groups for rules ------------
# networkSets:
#   - { name: partners, namespace: shop, nets: [198.51.100.0/24], labels: { kind: partner } }
# globalNetworkSets:
#   - { name: blocklist, nets: [203.0.113.0/24], labels: { kind: bad } }
#
# --- services + endpointSlices: model a ClusterIP service --------------------
# services:
#   - name: frontend
#     namespace: shop
#     selector: { app: frontend }
#     ports: [{ name: http, port: 80, protocol: tcp, targetPort: "8080" }]
# endpointSlices:
#   - { name: frontend-abc, namespace: shop, serviceName: frontend, addresses: [10.244.5.10] }
#
# --- externalEndpoints: off-cluster destinations (defaults to world/internet) -
# externalEndpoints:
#   - { id: world/partner-api, ip: 198.51.100.7, labels: { scope: partner } }
#
# --- dns: stub resolver so egress rules with a domain selector resolve --------
# dns:
#   api.example.com: [198.51.100.7]
#
# --- evaluation flags --------------------------------------------------------
# evaluateStaged: false   # also evaluate staged policies (preview enforcement)
# strictLint: true        # surface lint warnings as errors
# ============================================================================

`;

// dropEmpty strips null/undefined and empty arrays so a serialized doc stays
// readable (shared by the editable request and the read-only system layer).
function dropEmpty(obj: Record<string, unknown>): Record<string, unknown> {
  const clean: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v == null) continue;
    if (Array.isArray(v) && v.length === 0) continue;
    clean[k] = v;
  }
  return clean;
}

// toYaml serializes the request to YAML, dropping the vestigial `policies` field
// (owned by the policy editor) and any empty arrays so the doc stays readable.
function toYaml(req: EditorRequest): string {
  const { policies: _policies, ...rest } = req;
  return HEADER + stringify(dropEmpty(rest));
}

// fromYaml parses the doc back into an EditorRequest. Throws on malformed YAML or
// a non-mapping doc; the caller keeps the last good request on throw. Required
// list fields default to [] so a partial doc still type-checks; policies stays []
// (the policy editor owns it).
function fromYaml(text: string): EditorRequest {
  const doc = parse(text) ?? {};
  if (typeof doc !== 'object' || Array.isArray(doc)) {
    throw new Error('topology must be a YAML mapping');
  }
  return {
    endpoints: [],
    namespaces: [],
    probes: [],
    ...(doc as Partial<EditorRequest>),
    policies: [],
  };
}

export function RawTopologyEditor({ request, onChange, theme, system }: Props) {
  // Read-only view of the injected provider baseline (pods, nodes+labels, host
  // endpoints). Recomputed only when the provider's system layer changes.
  const systemYaml = useMemo(
    () => (system ? stringify(dropEmpty({ ...system })) : ''),
    [system],
  );
  const [text, setText] = useState(() => toYaml(request));
  const [err, setErr] = useState('');
  const [tab, setTab] = useState<'workloads' | 'system'>('workloads');
  // No system layer served (placeholder-only baseline) -> no tab bar, just the
  // editable doc as before.
  const showTabs = !!systemYaml;
  // The request object we last emitted. An external change (upload, reset,
  // example/tutorial switch) hands us a different object -> reserialize the doc.
  // Our own edits set this to the parsed object first, so the round-trip through
  // App's setRequest is reference-equal and does NOT clobber the user's text.
  const emitted = useRef(request);

  useEffect(() => {
    if (request !== emitted.current) {
      emitted.current = request;
      setText(toYaml(request));
      setErr('');
    }
  }, [request]);

  const handleMount: OnMount = (editor) => {
    queueMicrotask(() => editor.layout());
  };

  function handleChange(v: string | undefined) {
    const next = v ?? '';
    setText(next);
    try {
      const parsed = fromYaml(next);
      emitted.current = parsed;
      onChange(parsed);
      setErr('');
    } catch (e: any) {
      setErr(e?.message ?? String(e));
    }
  }

  const workloadsActive = !showTabs || tab === 'workloads';

  return (
    <div className="raw-topology">
      {showTabs ? (
        <div className="raw-topology-tabs">
          <button
            className={workloadsActive ? 'tab active' : 'tab'}
            onClick={() => setTab('workloads')}
          >
            workloads
          </button>
          <button
            className={tab === 'system' ? 'tab active' : 'tab'}
            onClick={() => setTab('system')}
            title="Injected provider baseline — merged in at evaluate-time, not editable"
          >
            system baseline (read-only)
          </button>
          {tab === 'system' ? (
            <span className="raw-topology-tabnote">
              {system!.endpoints.length} pods · {system!.nodes?.length ?? 0} nodes
            </span>
          ) : null}
        </div>
      ) : null}
      {/* Editable doc stays mounted (hidden, not unmounted) so cursor/undo
          survive tab switches. */}
      <div className="raw-topology-edit" style={workloadsActive ? undefined : { display: 'none' }}>
      <Editor
        height="100%"
        defaultLanguage="yaml"
        language="yaml"
        path="inmemory://topology.yaml"
        value={text}
        onChange={handleChange}
        onMount={handleMount}
        theme={theme === 'dark' ? 'vs-dark' : 'vs'}
        options={{
          minimap: { enabled: false },
          fontSize: 12,
          scrollBeyondLastLine: false,
          wordWrap: 'off',
          tabSize: 2,
          renderLineHighlight: 'gutter',
          lineNumbersMinChars: 3,
          folding: true,
          automaticLayout: true,
        }}
      />
      </div>
      {showTabs && tab === 'system' ? (
        <div className="raw-topology-edit">
          <Editor
            height="100%"
            defaultLanguage="yaml"
            language="yaml"
            path="inmemory://system-baseline.yaml"
            value={systemYaml}
            onMount={handleMount}
            theme={theme === 'dark' ? 'vs-dark' : 'vs'}
            options={{
              readOnly: true,
              minimap: { enabled: false },
              fontSize: 12,
              scrollBeyondLastLine: false,
              wordWrap: 'off',
              tabSize: 2,
              folding: true,
              automaticLayout: true,
            }}
          />
        </div>
      ) : null}
      {workloadsActive && err ? <div className="raw-topology-err">⚠ {err}</div> : null}
    </div>
  );
}
