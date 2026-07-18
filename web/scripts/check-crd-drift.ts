// Drift check: compares the editor's hand-curated policy schemas
// (../src/policySchemas) against the upstream Calico CRDs
// (../../third_party/calico/manifests/v3_projectcalico_org.yaml).
//
// WHY this exists rather than generating the schema from the CRD: the editor
// schema is a deliberate, engine-aligned SUBSET with hover docs, enum
// enrichments (e.g. protocol names), `additionalProperties:false` typo-catching,
// and intentional divergences (e.g. `domains`). See policySchemas.ts's header.
// Auto-generation would throw all of that away. What the CRD IS good for is
// catching DRIFT after a Calico bump: a field the upstream added that we now
// silently reject, or an enum whose members changed. This script surfaces
// exactly those two cases and nothing else.
//
// Two modes:
//   `npm run check:crd`  (check)   - exits non-zero on drift; for CI. Drift is
//                                     either a CRD spec field we don't model
//                                     (would red-squiggle a valid policy) or an
//                                     enum where both sides define members but
//                                     disagree. Editor-only fields and enums we
//                                     deliberately subset are INFO, never fail.
//   `make crd-sync` (= --suggest)  - advisory; prints paste-ready TS snippets
//                                     for each missing field / drifted enum so a
//                                     human applies them to policySchemas.ts.
//                                     Always exits 0. Does NOT edit the schema:
//                                     curation (descriptions, additionalProps,
//                                     intentional subsets) stays in human hands.
//
// Node 24 strips TS types natively, so this runs as `node scripts/...ts` with
// no extra tooling. It imports the live schema object, not a text copy of it.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { parseAllDocuments } from 'yaml';
import { buildPolicySchema } from '../src/policySchemas.ts';

const here = dirname(fileURLToPath(import.meta.url));
const CRD_PATH = resolve(here, '../../third_party/calico/manifests/v3_projectcalico_org.yaml');

// The CRD kinds whose spec we mirror in the editor, mapped to the schema
// branch (by kind const) we compare them against. Kinds not listed here (the
// operator CRDs, BGP*, etc.) are out of the editor's scope and ignored.
const COMPARED_KINDS = [
  'NetworkPolicy',
  'GlobalNetworkPolicy',
  'StagedNetworkPolicy',
  'StagedGlobalNetworkPolicy',
  'Tier',
  'HostEndpoint',
] as const;

// Editor-only fields we model on purpose because the engine honours them even
// though this CRD version's structural schema omits them. Matched by exact path
// or `.suffix` so e.g. `domains` covers source/destination on every rule list.
const INTENTIONAL_EXTRAS = ['domains'] as const;

// Enums where we deliberately model a SUBSET of the CRD's members because the
// topology engine only honours those. Matched by exact path or `.suffix`. Enum
// drift on any path NOT listed here still fails the check. Keep the reason
// current so a reviewer knows the divergence is intentional, not stale.
const INTENTIONAL_ENUM_SUBSETS: { suffix: string; reason: string }[] = [
  { suffix: 'stagedAction', reason: 'engine previews Set/Delete only; CRD also accepts Ignore/Learn' },
];

// `--suggest`: instead of pass/fail, emit paste-ready TS snippets for what's
// missing/drifted and exit 0 (advisory). `make crd-sync` runs this mode.
const SUGGEST = process.argv.includes('--suggest');

// A flat view of a schema subtree: every reachable field as a dotted path
// (array nesting collapses, so `egress[].source.selector` -> `egress.source.selector`),
// plus the sorted enum members at any path that defines an `enum`. `nodes` keeps
// the raw CRD subtree at each path so --suggest can render it back to TS.
interface Flat {
  fields: Set<string>;
  enums: Map<string, string[]>;
  nodes: Map<string, any>;
}

// --- walk the upstream CRD (openAPIV3Schema dialect) ------------------------

// CRD nodes carry `.properties` (object), `.items` (array element), and `.enum`.
function flattenCrd(node: any, path: string, out: Flat) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node.enum)) out.enums.set(path, [...node.enum].map(String).sort());
  if (node.properties && typeof node.properties === 'object') {
    for (const [key, child] of Object.entries(node.properties)) {
      const childPath = path ? `${path}.${key}` : key;
      out.fields.add(childPath);
      out.nodes.set(childPath, child);
      flattenCrd(child, childPath, out);
    }
  }
  if (node.items) flattenCrd(node.items, path, out); // collapse array nesting
}

// --- walk our editor schema (JSON Schema draft-07) --------------------------

// Our nodes additionally use `oneOf`/`anyOf` (e.g. protocol = enum | integer);
// we union their branches so an enum inside an anyOf still registers.
function flattenOurs(node: any, path: string, out: Flat) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node.enum)) out.enums.set(path, [...node.enum].map(String).sort());
  for (const branchKey of ['oneOf', 'anyOf', 'allOf'] as const) {
    if (Array.isArray(node[branchKey])) for (const b of node[branchKey]) flattenOurs(b, path, out);
  }
  if (node.properties && typeof node.properties === 'object') {
    for (const [key, child] of Object.entries(node.properties)) {
      const childPath = path ? `${path}.${key}` : key;
      out.fields.add(childPath);
      flattenOurs(child, childPath, out);
    }
  }
  if (node.items) flattenOurs(node.items, path, out);
}

function emptyFlat(): Flat {
  return { fields: new Set(), enums: new Map(), nodes: new Map() };
}

// --- render a CRD subtree as a hand-schema-style TS literal (suggest mode) ---
//
// Best-effort: mirrors the conventions in policySchemas.ts (additionalProperties
// false on structural objects, a TODO description placeholder for the human to
// fill, int-or-string collapsed to an anyOf). The output is meant to be pasted
// under the right `properties:` and then edited - not committed verbatim.
function renderNode(node: any, indent: string): string {
  const pad = indent + '  ';
  if (!node || typeof node !== 'object') return `{ type: 'string' }`;

  if (Array.isArray(node.enum)) {
    const vals = node.enum.map((v: any) => (typeof v === 'number' ? v : `'${v}'`)).join(', ');
    return `{\n${pad}enum: [${vals}],\n${pad}description: 'TODO: describe.',\n${indent}}`;
  }
  if (node['x-kubernetes-int-or-string'] || Array.isArray(node.anyOf)) {
    return `{ anyOf: [{ type: 'integer' }, { type: 'string' }] }`;
  }
  if (node.type === 'array') {
    return `{\n${pad}type: 'array',\n${pad}items: ${renderNode(node.items, pad)},\n${indent}}`;
  }
  if (node.type === 'object' || node.properties) {
    if (node.properties && typeof node.properties === 'object') {
      const props = Object.entries(node.properties)
        .map(([k, child]) => `${pad}  ${k}: ${renderNode(child, pad + '  ')},`)
        .join('\n');
      return `{\n${pad}type: 'object',\n${pad}additionalProperties: false,\n${pad}description: 'TODO: describe.',\n${pad}properties: {\n${props}\n${pad}},\n${indent}}`;
    }
    // map type (additionalProperties is a schema, not a bool)
    return `{ type: 'object', additionalProperties: { type: 'string' } }`;
  }
  // scalar
  const bits: string[] = [`type: '${node.type ?? 'string'}'`];
  if (typeof node.minimum === 'number') bits.push(`minimum: ${node.minimum}`);
  if (typeof node.maximum === 'number') bits.push(`maximum: ${node.maximum}`);
  bits.push(`description: 'TODO: describe.'`);
  return `{ ${bits.join(', ')} }`;
}

// --- load both sides --------------------------------------------------------

function loadCrdSpecs(): Map<string, any> {
  const text = readFileSync(CRD_PATH, 'utf8');
  const byKind = new Map<string, any>();
  for (const doc of parseAllDocuments(text)) {
    const json: any = doc.toJSON();
    if (json?.kind !== 'CustomResourceDefinition') continue;
    if (json?.spec?.group !== 'projectcalico.org') continue;
    const kind: string = json.spec?.names?.kind;
    const version = (json.spec?.versions ?? []).find((v: any) => v.name === 'v3') ?? json.spec?.versions?.[0];
    const spec = version?.schema?.openAPIV3Schema?.properties?.spec;
    if (kind && spec) byKind.set(kind, spec);
  }
  return byKind;
}

// Pull the `spec` subschema for a given kind const out of our oneOf root.
function loadOurSpecs(): Map<string, any> {
  const root: any = buildPolicySchema(['default']);
  const byKind = new Map<string, any>();
  for (const branch of root.oneOf ?? []) {
    const kindConst = branch?.properties?.kind?.const;
    const apiVersion = branch?.properties?.apiVersion?.const ?? '';
    // Only the projectcalico.org/v3 branches map onto these CRDs.
    if (!kindConst || !String(apiVersion).startsWith('projectcalico.org')) continue;
    const spec = branch?.properties?.spec;
    if (spec) byKind.set(kindConst, spec);
  }
  return byKind;
}

// --- compare ----------------------------------------------------------------

let missingFields = 0;
let enumDrift = 0;
const info: string[] = [];
const suggestions: string[] = []; // paste-ready blocks for --suggest

const crdSpecs = loadCrdSpecs();
const ourSpecs = loadOurSpecs();

for (const kind of COMPARED_KINDS) {
  const crdSpec = crdSpecs.get(kind);
  const ourSpec = ourSpecs.get(kind);
  if (!crdSpec) {
    console.warn(`! ${kind}: not found in CRD manifest (kind renamed or removed upstream?)`);
    continue;
  }
  if (!ourSpec) {
    console.warn(`! ${kind}: no editor schema branch matches this kind`);
    continue;
  }

  const crd = emptyFlat();
  const ours = emptyFlat();
  flattenCrd(crdSpec, '', crd);
  flattenOurs(ourSpec, '', ours);

  // spec.tier is injected by withTier() at a different layer; never flag it.
  crd.fields.delete('tier');
  ours.fields.delete('tier');

  const lines: string[] = [];
  const kindSuggestions: string[] = [];

  // 1. Fields the CRD defines that we don't model -> would falsely red-squiggle.
  //    For --suggest we only render the TOP-MOST missing field (a missing object
  //    subtree is emitted whole; its missing children are implied, not repeated).
  for (const f of [...crd.fields].sort()) {
    if (ours.fields.has(f)) continue;
    missingFields++;
    lines.push(`  MISSING  spec.${f}  (in CRD, not in editor schema)`);

    const dot = f.lastIndexOf('.');
    const parent = dot === -1 ? '' : f.slice(0, dot);
    const key = dot === -1 ? f : f.slice(dot + 1);
    const parentPresent = parent === '' || ours.fields.has(parent);
    if (SUGGEST && parentPresent) {
      const where = parent === '' ? `spec.properties` : `spec.${parent}'s properties`;
      kindSuggestions.push(
        `  + add to ${where}:\n      ${key}: ${renderNode(crd.nodes.get(f), '      ')},`,
      );
    }
  }

  // 2. Enum drift: both define members for the same path but they differ.
  for (const [path, crdVals] of crd.enums) {
    const ourVals = ours.enums.get(path);
    if (!ourVals) continue; // we model it as free string / int-or-string: fine
    if (crdVals.join('|') === ourVals.join('|')) continue;

    // Allowlisted subset divergence: ours must be a strict subset of the CRD's
    // members (a genuinely subset choice), else it's real drift even if listed.
    const allow = INTENTIONAL_ENUM_SUBSETS.find((a) => path === a.suffix || path.endsWith(`.${a.suffix}`));
    const isSubset = ourVals.every((v) => crdVals.includes(v));
    if (allow && isSubset) {
      info.push(`  ${kind}: spec.${path} models [${ourVals.join(', ')}] of CRD [${crdVals.join(', ')}] - ${allow.reason}`);
      continue;
    }

    lines.push(`  ENUM     spec.${path}  CRD=[${crdVals.join(', ')}]  ours=[${ourVals.join(', ')}]`);
    enumDrift++;
    if (SUGGEST) {
      const add = crdVals.filter((v) => !ourVals.includes(v));
      const drop = ourVals.filter((v) => !crdVals.includes(v));
      const parts: string[] = [];
      if (add.length) parts.push(`add member(s) ${add.map((v) => `'${v}'`).join(', ')}`);
      if (drop.length) parts.push(`CRD dropped ${drop.map((v) => `'${v}'`).join(', ')} (remove or allowlist)`);
      kindSuggestions.push(`  ~ enum spec.${path}: ${parts.join('; ')}\n      enum: [${crdVals.map((v) => `'${v}'`).join(', ')}],`);
    }
  }

  // 3. INFO only: fields we add. Known-intentional divergences are allowlisted
  //    (see INTENTIONAL_EXTRAS) so this only surfaces NEW editor-only fields.
  for (const f of [...ours.fields].sort()) {
    if (crd.fields.has(f)) continue;
    if (INTENTIONAL_EXTRAS.some((suffix) => f === suffix || f.endsWith(`.${suffix}`))) continue;
    info.push(`  ${kind}: spec.${f} (editor-only; intentional?)`);
  }

  if (lines.length && !SUGGEST) {
    console.log(`\n### ${kind}`);
    for (const l of lines) console.log(l);
  }
  if (kindSuggestions.length) suggestions.push(`\n### ${kind}\n${kindSuggestions.join('\n')}`);
}

// --- suggest mode: advisory, always exits 0 ---------------------------------
if (SUGGEST) {
  if (suggestions.length === 0) {
    console.log('✓ Nothing to sync: the editor schema already models every compared CRD field and enum.');
  } else {
    console.log('CRD-sync suggestions. Paste each block into the matching spot in web/src/policySchemas.ts,');
    console.log('fill in the TODO descriptions, then run `npm run check:crd` to confirm green.\n');
    console.log("(Reminder: the schema is a deliberate, engine-aligned subset - if a field/enum member");
    console.log(' shouldn\'t be modelled, allowlist it in this script instead of pasting the snippet.)');
    for (const block of suggestions) console.log(block);
  }
  process.exit(0);
}

// --- check mode: pass/fail --------------------------------------------------
if (info.length) {
  console.log('\n--- INFO: editor-only fields (not failures) ---');
  for (const l of info) console.log(l);
}

const problems = missingFields + enumDrift;
if (problems === 0) {
  console.log('\n✓ No drift: every compared CRD spec field and enum is modelled in the editor schema.');
  process.exit(0);
} else {
  console.error(`\n✗ Drift found: ${missingFields} missing field(s), ${enumDrift} enum mismatch(es).`);
  console.error('  Run `make crd-sync` for paste-ready snippets, or add an intentional-divergence note.');
  process.exit(1);
}
