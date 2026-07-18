// Topology-aware autocomplete for the policy editor. monaco-yaml (wired in
// monacoSetup.ts) already gives schema-driven completion for KEYS and ENUMS via
// ../policySchemas - `action:` offers Allow/Deny, `spec:` offers selector/
// ingress/…, and so on. What a JSON Schema can't do is suggest VALUES that only
// exist in the live topology: the namespaces, label key=value pairs, service
// names, CIDRs and FQDNs the user actually has on the canvas. Those fields are
// modelled as free-form `type: 'string'`, so the schema has nothing to offer
// there.
//
// This module registers a SECOND Monaco completion provider for the 'yaml'
// language that fills exactly those gaps, plus two things the schema is the
// wrong tool for:
//
//   - whole-document SNIPPETS - the four policy skeletons from ../policyTemplates
//     offered at the top of a blank document (or just after a `---` separator),
//     so a user can scaffold a policy by typing rather than reaching for the
//     "+ Policy" buttons;
//   - Calico SELECTOR-language IntelliSense - label keys, the ==/!=/in/has()/
//     all() operators, and quoted label values - inside `selector:`,
//     `namespaceSelector:` and `serviceAccountSelector:` strings.
//
// Monaco MERGES suggestions from every registered provider, so this coexists
// with monaco-yaml rather than replacing it. Each branch below fires only in a
// context the schema leaves as a free-form string (or in the snippet/selector
// cases the schema can't model), so there are no duplicate items in the widget.
//
// The provider reads from a module-level `ctx` snapshot, NOT React state: it's
// registered once, before the React tree mounts, and App pushes a fresh
// snapshot via updatePolicyCompletions() whenever the topology changes - exactly
// how updatePolicyTiers keeps the schema's tier enum live (see monacoSetup).

import type * as monacoNS from 'monaco-editor/esm/vs/editor/editor.api';
import { POLICY_TEMPLATES } from './policyTemplates';
import type {
  Endpoint,
  GlobalNetworkSetInput,
  HostEndpointInput,
  NamespaceInput,
  NetworkSetInput,
  ServiceAccountInput,
  ServiceInput,
} from './api';

// What App hands us each time the topology changes. Raw resource lists rather
// than pre-built maps - the indexing (label key→values, dedup, sort) lives here
// so App stays a thin pass-through of its `merged` memo.
export interface CompletionInputs {
  tierNames: string[];
  namespaces: NamespaceInput[];
  endpoints: Endpoint[];
  serviceAccounts: ServiceAccountInput[];
  services: ServiceInput[];
  networkSets: NetworkSetInput[];
  globalNetworkSets: GlobalNetworkSetInput[];
  hostEndpoints: HostEndpointInput[];
  domains: string[]; // FQDN keys from the DNS stub, for domains:/domainNames:
}

// The indexed snapshot the provider reads. Label maps are split by selector
// DOMAIN because the three selector keys resolve against different label sets:
// `selector` matches workload (endpoint) labels, `namespaceSelector` matches
// namespace labels, `serviceAccountSelector` matches ServiceAccount labels.
interface Ctx {
  tierNames: string[];
  namespaces: string[];
  serviceNames: string[];
  serviceAccountNames: string[];
  cidrs: string[];
  domains: string[];
  workloadLabels: Map<string, Set<string>>;
  namespaceLabels: Map<string, Set<string>>;
  serviceAccountLabels: Map<string, Set<string>>;
}

const emptyCtx = (): Ctx => ({
  tierNames: [],
  namespaces: [],
  serviceNames: [],
  serviceAccountNames: [],
  cidrs: [],
  domains: [],
  workloadLabels: new Map(),
  namespaceLabels: new Map(),
  serviceAccountLabels: new Map(),
});

let ctx: Ctx = emptyCtx();

// The indexed topology vocabulary, shared with non-Monaco surfaces (the policy
// wizard's comboboxes) so both offer the identical set of real namespaces /
// labels / CIDRs / FQDNs. Built via buildVocabulary (below).
export type PolicyVocabulary = Ctx;

function uniqSort(xs: string[]): string[] {
  return [...new Set(xs.filter(Boolean))].sort();
}

// indexLabels folds one resource's label map into `target` (key → observed
// values). Empty-valued labels still register the KEY (so `has(key)` and bare
// key completion work) but contribute no value suggestion.
function indexLabels(target: Map<string, Set<string>>, labels?: Record<string, string>) {
  if (!labels) return;
  for (const [k, v] of Object.entries(labels)) {
    let set = target.get(k);
    if (!set) {
      set = new Set();
      target.set(k, set);
    }
    if (v) set.add(v);
  }
}

// buildVocabulary indexes one topology snapshot into the read model. Pure, so
// both the editor completion (via updatePolicyCompletions) and the policy
// wizard (via a prop) share the exact same vocabulary from the same code.
export function buildVocabulary(input: CompletionInputs): Ctx {
  const next = emptyCtx();
  next.tierNames = uniqSort(input.tierNames);
  next.namespaces = uniqSort(input.namespaces.map((n) => n.name));
  next.serviceNames = uniqSort(input.services.map((s) => s.name));
  next.serviceAccountNames = uniqSort(input.serviceAccounts.map((s) => s.name));
  next.domains = uniqSort(input.domains);

  const cidrs: string[] = [];
  for (const n of input.networkSets) cidrs.push(...(n.nets ?? []));
  for (const g of input.globalNetworkSets) cidrs.push(...(g.nets ?? []));
  next.cidrs = uniqSort(cidrs);

  for (const e of input.endpoints) indexLabels(next.workloadLabels, e.labels);
  for (const h of input.hostEndpoints) indexLabels(next.workloadLabels, h.labels);
  for (const sa of input.serviceAccounts) indexLabels(next.serviceAccountLabels, sa.labels);
  for (const ns of input.namespaces) indexLabels(next.namespaceLabels, ns.labels);
  // Calico/k8s project an implicit `kubernetes.io/metadata.name == <ns>` label
  // on every namespace; surface it so namespaceSelector completion offers the
  // canonical "select one namespace by name" form even for unlabelled ns.
  const nameKey = 'kubernetes.io/metadata.name';
  let nameSet = next.namespaceLabels.get(nameKey);
  if (!nameSet) {
    nameSet = new Set();
    next.namespaceLabels.set(nameKey, nameSet);
  }
  for (const name of next.namespaces) nameSet.add(name);

  return next;
}

// updatePolicyCompletions rebuilds the snapshot the Monaco provider reads. Cheap
// and idempotent - App calls it from an effect on every topology change, same
// cadence as updatePolicyTiers.
export function updatePolicyCompletions(input: CompletionInputs) {
  ctx = buildVocabulary(input);
}

// --- context detection ------------------------------------------------------
//
// We classify the cursor position with a few small regexes against the current
// line plus a light indentation walk for the enclosing key path. This is
// deliberately heuristic, not a full YAML parse: the document is usually
// mid-edit (and therefore unparseable), and the cost of a wrong guess is one
// irrelevant suggestion the user ignores, not a crash.

// A `key:` (or `- key:`) line. Captures leading whitespace, an optional list
// dash, the key, and whatever follows the colon.
const KEY_LINE = /^(\s*)(-\s+)?([A-Za-z][\w./-]*)\s*:(.*)$/;

// The three Calico keys whose value is a selector STRING (vs k8s's object-shaped
// selectors, which the schema + matchLabels branch handle).
const SELECTOR_KEYS = new Set(['selector', 'notSelector', 'serviceAccountSelector', 'namespaceSelector']);

function leadingSpaces(s: string): number {
  return s.length - s.replace(/^ */, '').length;
}

// docStartLine: the first content line of the `---`-separated document the
// cursor sits in (1-based). Lets multi-document models be classified per-doc.
function docStartLine(model: monacoNS.editor.ITextModel, lineNumber: number): number {
  for (let ln = lineNumber - 1; ln >= 1; ln--) {
    if (model.getLineContent(ln).trim() === '---') return ln + 1;
  }
  return 1;
}

// docApiVersion scans the current document (start → next `---`/EOF) for its
// apiVersion, so selector IntelliSense only fires on Calico kinds (a pasted k8s
// Service also has a `selector:` key, but it's an object map, not a string).
function docApiVersion(model: monacoNS.editor.ITextModel, lineNumber: number): string {
  const start = docStartLine(model, lineNumber);
  const total = model.getLineCount();
  for (let ln = start; ln <= total; ln++) {
    const t = model.getLineContent(ln);
    if (ln !== start && t.trim() === '---') break;
    const m = /^apiVersion:\s*(\S+)/.exec(t);
    if (m) return m[1];
  }
  return '';
}

// ancestorKeys returns the enclosing mapping keys above `lineNumber`, outermost
// first, keeping only scopes shallower than `maxIndent` (the current line's
// indent). So for a value under `spec.source.selector` it yields
// ['spec','source']; under matchLabels it yields [...,'matchLabels'].
function ancestorKeys(
  model: monacoNS.editor.ITextModel,
  lineNumber: number,
  maxIndent: number,
): string[] {
  const start = docStartLine(model, lineNumber);
  const stack: { indent: number; key: string }[] = [];
  for (let ln = start; ln < lineNumber; ln++) {
    const text = model.getLineContent(ln);
    const trimmed = text.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const m = KEY_LINE.exec(text);
    if (!m) continue;
    const indent = m[1].length + (m[2] ? m[2].length : 0);
    while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
    stack.push({ indent, key: m[3] });
  }
  return stack.filter((s) => s.indent < maxIndent).map((s) => s.key);
}

// --- the provider ------------------------------------------------------------

export function registerPolicyCompletions(monaco: typeof monacoNS) {
  const Kind = monaco.languages.CompletionItemKind;
  const AsSnippet = monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet;

  monaco.languages.registerCompletionItemProvider('yaml', {
    // `'` / `"` re-trigger so label-value completion pops the moment the user
    // opens a quote after an operator; word characters already re-trigger via
    // the editor's quickSuggestions.strings setting (see PolicyEditor).
    triggerCharacters: ["'", '"', '=', '/', '.'],

    provideCompletionItems(model, position) {
      const lineNum = position.lineNumber;
      const line = model.getLineContent(lineNum);
      const before = line.slice(0, position.column - 1);
      const suggestions: monacoNS.languages.CompletionItem[] = [];

      // A range that replaces the trailing token `tok` ending at the cursor.
      const tokenRange = (tok: string) =>
        new monaco.Range(lineNum, position.column - tok.length, lineNum, position.column);

      // 1. WHOLE-DOCUMENT SNIPPETS. Only at the very start of a line (column 1,
      //    optionally with a typed prefix to filter by) - i.e. top level, where
      //    a new document begins. Returns early so we don't also try to read it
      //    as a key/value line.
      if (/^[A-Za-z]*$/.test(before)) {
        const range = tokenRange(before);
        for (const t of POLICY_TEMPLATES) {
          suggestions.push({
            label: `${t.label.replace(/^\+\s*/, '')} (template)`,
            kind: Kind.Snippet,
            detail: t.title,
            documentation: { value: '```yaml\n' + t.yaml + '```' },
            insertText: t.yaml,
            // Match on kind + label words so "calico", "gnp", "cluster" all hit.
            filterText: `${t.id} ${t.label}`,
            insertTextRules: AsSnippet,
            range,
            sortText: '0',
          });
        }
        return { suggestions };
      }

      const indent = leadingSpaces(before);

      // 2. VALUE POSITION - `key: <here>` (with an optional list dash). group 3
      //    is the key, group 4 the value typed so far (the schema's `\s*` after
      //    the colon means no leading space leaks into it).
      const kv = /^\s*(?:-\s*)?([A-Za-z][\w./-]*)\s*:\s*(.*)$/.exec(before);
      if (kv) {
        const key = kv[1];
        const typed = kv[2];
        const valueRange = tokenRange(typed);

        // 2a. Calico selector strings → selector-language IntelliSense.
        if (SELECTOR_KEYS.has(key) && docApiVersion(model, lineNum).startsWith('projectcalico.org')) {
          const labels =
            key === 'namespaceSelector'
              ? ctx.namespaceLabels
              : key === 'serviceAccountSelector'
                ? ctx.serviceAccountLabels
                : ctx.workloadLabels;

          // Right after an (in)equality operator → suggest VALUES for that key.
          const op = /([A-Za-z][\w./-]*)\s*(==|!=)\s*(['"]?)([\w.\-/]*)$/.exec(typed);
          if (op) {
            const [, lkey, , quote, partial] = op;
            const range = tokenRange(partial);
            for (const v of [...(labels.get(lkey) ?? [])].sort()) {
              suggestions.push({
                label: v,
                kind: Kind.Value,
                detail: `value of ${lkey}`,
                // Wrap in quotes unless the user already opened one.
                insertText: quote ? v : `'${v}'`,
                range,
                sortText: '0',
              });
            }
            return { suggestions };
          }

          // Otherwise we're at the start of an operand → label keys + functions.
          const tok = /[A-Za-z0-9_./-]*$/.exec(typed)?.[0] ?? '';
          const range = tokenRange(tok);
          for (const k of [...labels.keys()].sort()) {
            suggestions.push({
              label: k,
              kind: Kind.Field,
              detail: 'label key',
              insertText: `${k} == '$0'`,
              insertTextRules: AsSnippet,
              range,
              sortText: `1${k}`,
            });
          }
          for (const fn of [
            { label: 'all()', insert: 'all()', doc: 'Match every endpoint in scope.' },
            { label: 'has(key)', insert: 'has($0)', doc: 'Match endpoints that have a given label key.' },
            { label: 'global()', insert: 'global()', doc: 'Match the global network set context.' },
          ]) {
            suggestions.push({
              label: fn.label,
              kind: Kind.Function,
              detail: 'selector function',
              documentation: fn.doc,
              insertText: fn.insert,
              insertTextRules: AsSnippet,
              range,
              sortText: `2${fn.label}`,
            });
          }
          // Logical joiners, only once there's a left-hand expression to join.
          if (/\S\s*$/.test(typed)) {
            for (const opTok of ['&&', '||']) {
              suggestions.push({
                label: opTok,
                kind: Kind.Operator,
                detail: 'combine selectors',
                insertText: `${opTok} `,
                range: tokenRange(''),
                sortText: `3${opTok}`,
              });
            }
          }
          return { suggestions };
        }

        // 2b. namespace: → real namespace names.
        if (key === 'namespace') {
          for (const n of ctx.namespaces)
            suggestions.push({ label: n, kind: Kind.Value, insertText: n, range: valueRange, sortText: `0${n}` });
          return { suggestions };
        }

        // 2c. name: under a `services:` block → real Service names.
        if (key === 'name' && ancestorKeys(model, lineNum, indent).includes('services')) {
          for (const s of ctx.serviceNames)
            suggestions.push({ label: s, kind: Kind.Value, insertText: s, range: valueRange, sortText: `0${s}` });
          return { suggestions };
        }

        // 2d. A `labelKey: <value>` line under matchLabels → values for that key
        //     (union of workload + namespace labels, since the same matchLabels
        //     shape serves podSelector and namespaceSelector).
        const anc = ancestorKeys(model, lineNum, indent);
        if (anc[anc.length - 1] === 'matchLabels') {
          const vals = new Set<string>([
            ...(ctx.workloadLabels.get(key) ?? []),
            ...(ctx.namespaceLabels.get(key) ?? []),
          ]);
          for (const v of [...vals].sort())
            suggestions.push({ label: v, kind: Kind.Value, insertText: v, range: valueRange, sortText: `0${v}` });
          return { suggestions };
        }

        return { suggestions };
      }

      // 3. LIST ITEM - `- <here>`. nets/notNets/networks take CIDRs;
      //    domains/domainNames take FQDNs. Both pull from the live topology.
      const li = /^\s*-\s*(.*)$/.exec(before);
      if (li) {
        const typed = li[1];
        const range = tokenRange(typed);
        const last = ancestorKeys(model, lineNum, indent).at(-1);
        const pool =
          last === 'nets' || last === 'notNets' || last === 'networks'
            ? ctx.cidrs
            : last === 'domains' || last === 'domainNames'
              ? ctx.domains
              : null;
        if (pool) {
          for (const v of pool)
            suggestions.push({ label: v, kind: Kind.Value, insertText: v, range, sortText: `0${v}` });
        }
        return { suggestions };
      }

      // 4. BARE KEY under matchLabels - `<indent><partial>` with no colon yet →
      //    suggest label keys, inserting `key: ` so value completion follows.
      const bare = /^\s+([A-Za-z][\w./-]*)?$/.exec(before);
      if (bare && ancestorKeys(model, lineNum, indent).at(-1) === 'matchLabels') {
        const tok = bare[1] ?? '';
        const range = tokenRange(tok);
        const keys = new Set<string>([...ctx.workloadLabels.keys(), ...ctx.namespaceLabels.keys()]);
        for (const k of [...keys].sort())
          suggestions.push({
            label: k,
            kind: Kind.Field,
            detail: 'label key',
            insertText: `${k}: `,
            range,
            sortText: `0${k}`,
          });
        return { suggestions };
      }

      return { suggestions };
    },
  });
}
