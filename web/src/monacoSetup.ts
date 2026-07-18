// One-time Monaco + monaco-yaml wiring. Imported for its side effects by
// main.tsx BEFORE the React tree mounts, so the policy editor comes up with
// schema-backed completion / hover / validation already active.
//
// Two things have to line up for monaco-yaml to take effect:
//
//   1. @monaco-editor/react loads Monaco from a CDN by default. monaco-yaml
//      patches the *local* `monaco-editor` npm instance, so we force the React
//      wrapper onto that same instance via loader.config({ monaco }). As a
//      bonus this drops the runtime CDN dependency - the editor works offline
//      inside the embedded Go binary.
//   2. Monaco needs web workers. We register the editor worker for everything
//      and the dedicated yaml worker for the 'yaml' language (the project-local
//      ./yaml.worker.js shim avoids Vite's worker-URL bug).
//
// The schema list associates our policy JSON Schema with the editor model.
// fileMatch is intentionally broad ('**') - the policy pane owns the only YAML
// model in the app, so there's nothing else to mis-match.

// Import the lean editor API (not the `monaco-editor` barrel, which bundles a
// monarch grammar + mode worker for every language Monaco ships - swift, sql,
// cpp … - bloating the chunk by ~4 MB). We then opt back in to *only* the YAML
// grammar for syntax highlighting; monaco-yaml supplies the language service.
//
// `editor.api` is the bare API - it ships NONE of the editor feature
// contributions, so on its own there is no suggest widget (autocomplete never
// renders), no hover, no folding, regardless of which completion providers are
// registered. `editor.all` registers all of those features (suggest, hover,
// folding, find, bracket matching …) and - crucially - pulls in NO language
// grammars or workers, so it adds the UI we need without the ~4 MB language
// bloat we're avoiding above. Without this import the policy editor is inert.
import * as monaco from 'monaco-editor/esm/vs/editor/editor.api';
import 'monaco-editor/esm/vs/editor/editor.all';
import 'monaco-editor/esm/vs/basic-languages/yaml/yaml.contribution';
// Extra grammars for tutorial code blocks (CodeBlock → colorizeCode). These are
// tiny monarch grammars (NOT the language services), so they only add syntax
// highlighting for the fenced languages tutorials use beyond YAML.
import 'monaco-editor/esm/vs/basic-languages/shell/shell.contribution';
import 'monaco-editor/esm/vs/basic-languages/go/go.contribution';
import 'monaco-editor/esm/vs/basic-languages/dockerfile/dockerfile.contribution';
import { loader } from '@monaco-editor/react';
import { configureMonacoYaml } from 'monaco-yaml';
import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import YamlWorker from './yaml.worker.js?worker';
import { buildPolicySchema } from './policySchemas';
import { registerPolicyCompletions } from './policyCompletions';

// Path the policy editor model is opened under (see PolicyEditor's `path`
// prop). Kept here so the schema fileMatch and the model path can't drift.
export const POLICY_MODEL_PATH = 'peacha-policy.yaml';

window.MonacoEnvironment = {
  getWorker(_workerId, label) {
    return label === 'yaml' ? new YamlWorker() : new EditorWorker();
  },
};

// Point the React wrapper at the bundled Monaco (not the CDN copy).
loader.config({ monaco });

// --- read-only syntax highlighting for tutorial code blocks -----------------
//
// monaco.editor.colorize() tokenizes a string into themed `.mtkN` <span>s using
// the grammars loaded above - no editor instance, no model, no workers. The
// token colors are theme-scoped (Monaco emits `.vs .mtkN` / `.vs-dark .mtkN`
// rules), so the caller must wrap the returned HTML in an element carrying the
// matching theme class (see CodeBlock). We setTheme() here so the active theme's
// rule set is present and token numbering is computed under it; the app keeps a
// single light/dark theme, so this agrees with whatever the policy editor wants.
const MONACO_THEME = { light: 'vs', dark: 'vs-dark' } as const;

// Map common markdown fence languages onto the grammars Monaco has loaded.
// Anything unmapped tokenizes as plaintext (still rendered, just uncolored).
const FENCE_LANG: Record<string, string> = {
  yaml: 'yaml', yml: 'yaml',
  sh: 'shell', bash: 'shell', shell: 'shell', console: 'shell', zsh: 'shell',
  go: 'go', golang: 'go',
  dockerfile: 'dockerfile', docker: 'dockerfile',
};

export function monacoThemeFor(theme: 'light' | 'dark'): string {
  return MONACO_THEME[theme];
}

// Monaco injects its global token-color stylesheet (the `.mtkN { color }` rules
// colorize() output depends on) lazily - only once an editor *container*
// registers. In the common split layout the policy editor mounts and does this,
// but a user can maximize/collapse panes so the editor is absent while a
// tutorial is shown. Creating and immediately disposing a throwaway editor
// forces that stylesheet in; it's persistent (container registration returns a
// no-op disposer), so this is a one-time cost paid only when a code block first
// renders.
let colorStylesEnsured = false;
function ensureColorStyles() {
  if (colorStylesEnsured) return;
  colorStylesEnsured = true;
  try {
    const node = document.createElement('div');
    monaco.editor.create(node, { automaticLayout: false }).dispose();
  } catch {
    /* best-effort: colorize still returns readable (escaped) text without it */
  }
}

// colorizeCode returns Monaco-highlighted HTML for `code`. `lang` is the raw
// markdown fence tag (may be empty/unknown). Resolves to escaped, uncolored
// HTML on any failure so a code block never breaks the tutorial render.
export function colorizeCode(
  code: string,
  lang: string,
  theme: 'light' | 'dark',
): Promise<string> {
  ensureColorStyles();
  monaco.editor.setTheme(MONACO_THEME[theme]);
  const langId = FENCE_LANG[lang.toLowerCase()] ?? 'plaintext';
  return monaco.editor.colorize(code, langId, {}).catch(() => escapeHtml(code));
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// The set of tier names a Calico policy's spec.tier may reference. Rebuilt and
// pushed via updatePolicyTiers() whenever the user adds/removes a custom tier
// in the topology pane, so completion/validation tracks the live tier list.
function yamlOptions(tierNames: string[]) {
  return {
    enableSchemaRequest: false, // schema is inlined; never hit the network
    validate: true,
    hover: true,
    hoverSchemaSource: false, // drop the "Source: network-policy.json" line from hover/suggest docs
    completion: true,
    schemas: [
      {
        uri: 'https://peacha.frozenspace.eu/schemas/network-policy.json',
        fileMatch: ['**', POLICY_MODEL_PATH],
        schema: buildPolicySchema(tierNames) as object,
      },
    ],
  };
}

const monacoYaml = configureMonacoYaml(monaco, yamlOptions(['default']));

// Second YAML completion provider: topology-aware value completion, selector
// IntelliSense, and document snippets. Reads a live snapshot App pushes via
// updatePolicyCompletions; Monaco merges its suggestions with monaco-yaml's.
registerPolicyCompletions(monaco);

// Dev-only: expose the Monaco instance for headless/manual debugging of the
// editor (completion providers, models). Tree-shaken out of production builds.
if (import.meta.env.DEV) (window as unknown as { monaco: typeof monaco }).monaco = monaco;

// updatePolicyTiers re-pushes the schema with a fresh spec.tier enum. Cheap and
// idempotent - monaco-yaml diff-applies the schema to the live language worker.
export function updatePolicyTiers(tierNames: string[]) {
  void monacoYaml.update(yamlOptions(tierNames));
}

// --- policy validity (drives "only evaluate valid YAML") --------------------
//
// monaco-yaml validates the policy model in its worker and publishes Error-
// severity markers for syntax + schema violations. App gates /v1/evaluate on
// this so a half-typed/invalid bundle isn't sent to the backend every keystroke
// (see the evaluate effect). We expose the validity as a tiny observable rather
// than leaking the monaco instance into App: monacoSetup is the only module
// that knows the policy model's URI (POLICY_MODEL_PATH) and the monaco handle.

function isPolicyResource(uri: monaco.Uri): boolean {
  // @monaco-editor/react opens the model under POLICY_MODEL_PATH; match loosely
  // on the path so we don't depend on how the URI scheme is normalised.
  return uri.path.includes(POLICY_MODEL_PATH);
}

// hasPolicyErrors reads the live marker set for every policy model (there's only
// one, but getModels is cheap) and reports whether any marker is blocking.
//
// NOTE on severity: monaco-yaml surfaces SCHEMA violations (unknown property,
// wrong enum, missing required field) at WARNING severity, and only raw YAML
// PARSE failures at Error. Every marker it emits is a real "this isn't a valid
// policy" signal - there are no stylistic warnings - so we block on Warning or
// worse (>= Warning), not Error alone. Info/Hint (e.g. completion hints) don't
// block.
function hasPolicyErrors(): boolean {
  for (const model of monaco.editor.getModels()) {
    if (!isPolicyResource(model.uri)) continue;
    const markers = monaco.editor.getModelMarkers({ resource: model.uri });
    if (markers.some((m) => m.severity >= monaco.MarkerSeverity.Warning)) return true;
  }
  return false;
}

let policyHasErrors = false;
const validityListeners = new Set<(hasErrors: boolean) => void>();

monaco.editor.onDidChangeMarkers((resources) => {
  if (!resources.some(isPolicyResource)) return;
  const next = hasPolicyErrors();
  if (next === policyHasErrors) return;
  policyHasErrors = next;
  for (const cb of validityListeners) cb(next);
});

// monaco-yaml's worker short-circuits a blank document: it neither validates it
// nor publishes a cleared diagnostic set. So when a user hand-deletes the last
// policy, the error markers from the transiently-invalid half-deleted YAML are
// never withdrawn - hasPolicyErrors() keeps returning true and the evaluate gate
// stays stuck on the deleted policy's matrix. We close that gap ourselves:
// whenever a policy model goes blank (whitespace only), drop the stale yaml-owned
// markers. setModelMarkers fires onDidChangeMarkers above, which recomputes the
// validity flag to false and re-runs the evaluate effect (→ default-allow).
function clearStaleMarkersOnBlank(model: monaco.editor.ITextModel) {
  if (!isPolicyResource(model.uri)) return;
  model.onDidChangeContent(() => {
    if (model.getValue().trim() === '') {
      monaco.editor.setModelMarkers(model, 'yaml', []);
    }
  });
}
monaco.editor.getModels().forEach(clearStaleMarkersOnBlank);
monaco.editor.onDidCreateModel(clearStaleMarkersOnBlank);

// getPolicyHasErrors is the synchronous read used at send-time, so the debounced
// evaluate can re-check the freshest marker state right before firing.
export function getPolicyHasErrors(): boolean {
  return policyHasErrors;
}

// subscribePolicyValidity registers a listener (invoked immediately with the
// current state) and returns a disposer. App mirrors this into React state so
// the evaluate effect re-runs the moment the YAML goes valid/invalid.
export function subscribePolicyValidity(cb: (hasErrors: boolean) => void): () => void {
  validityListeners.add(cb);
  cb(policyHasErrors);
  return () => {
    validityListeners.delete(cb);
  };
}
