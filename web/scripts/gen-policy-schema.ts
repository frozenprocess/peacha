// Generates web/src/generatedPolicySchemas.ts from the upstream Calico CRD
// manifest (../../third_party/calico/manifests/v3_projectcalico_org.yaml), so
// the editor's projectcalico.org/v3 policy schemas mirror the real CRD
// structure and enums instead of being hand-maintained.
//
// The CRD gives STRUCTURE (fields, types, required, enums) but its policy kinds
// carry no field descriptions, and the editor deliberately diverges in a few
// spots (enriched protocol enum, the editor-only `domains` field, the
// stagedAction subset). Both are supplied by the DESCRIPTION OVERLAY in
// ../src/policySchemaOverlay.ts, deep-merged onto the generated tree.
//
// Two modes (Node 24 strips TS types natively, so this runs as `node`):
//   node scripts/gen-policy-schema.ts            -> write generatedPolicySchemas.ts
//   node scripts/gen-policy-schema.ts --seed     -> (re)bootstrap the overlay by
//        diffing the current hand-written buildPolicySchema() against the CRD;
//        prints a paste-ready overlay. Run once when adopting this, then curate
//        the overlay by hand. Does NOT overwrite the overlay file.

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { parseAllDocuments } from 'yaml';
import { overlay } from '../src/policySchemaOverlay.ts';

const here = dirname(fileURLToPath(import.meta.url));
const CRD_PATH = resolve(here, '../../third_party/calico/manifests/v3_projectcalico_org.yaml');
const OUT_PATH = resolve(here, '../src/generatedPolicySchemas.ts');
const SEED = process.argv.includes('--seed');

// projectcalico.org/v3 kinds the editor models, with a friendly hover title.
// k8s NetworkPolicy and NPA ClusterNetworkPolicy are NOT in this manifest and
// stay hand-written in policySchemas.ts.
const KINDS: Record<string, string> = {
  NetworkPolicy: 'Calico NetworkPolicy',
  GlobalNetworkPolicy: 'Calico GlobalNetworkPolicy',
  StagedNetworkPolicy: 'Calico StagedNetworkPolicy',
  StagedGlobalNetworkPolicy: 'Calico StagedGlobalNetworkPolicy',
  StagedKubernetesNetworkPolicy: 'Calico StagedKubernetesNetworkPolicy',
  Tier: 'Calico Tier',
  HostEndpoint: 'Calico HostEndpoint',
};

// --- CRD (openAPIV3Schema) -> JSON Schema draft-07 --------------------------
//
// The dialects overlap heavily; the only real work is: collapse int-or-string
// to an anyOf, drop x-kubernetes-* keywords (json-languageservice ignores them
// anyway), and set additionalProperties:false on structural objects so a typo'd
// key gets a squiggle. Maps (additionalProperties is itself a schema) are kept
// as maps. No `preserve-unknown-fields` appears in these specs (asserted below).
const KEEP = new Set([
  'type', 'enum', 'required', 'minimum', 'maximum', 'minLength', 'maxLength',
  'minItems', 'maxItems', 'pattern', 'format', 'description', 'default',
]);

function crdToSchema(node: any): any {
  if (!node || typeof node !== 'object') return node;
  if (node['x-kubernetes-preserve-unknown-fields']) {
    throw new Error('preserve-unknown-fields in a policy spec: additionalProperties:false would be wrong here');
  }
  if (node['x-kubernetes-int-or-string']) {
    return { anyOf: [{ type: 'integer' }, { type: 'string' }] };
  }
  const out: any = {};
  for (const k of Object.keys(node)) if (KEEP.has(k)) out[k] = node[k];

  if (node.properties && typeof node.properties === 'object') {
    out.type = 'object';
    out.additionalProperties = false; // typo-catching on structural objects
    out.properties = {};
    for (const [key, child] of Object.entries(node.properties)) out.properties[key] = crdToSchema(child);
  } else if (node.additionalProperties && typeof node.additionalProperties === 'object') {
    out.type = 'object';
    out.additionalProperties = crdToSchema(node.additionalProperties); // a map
  }
  if (node.items) out.items = crdToSchema(node.items);
  return out;
}

// Standard metadata node (the CRD leaves metadata as a bare `type: object`).
const objectMeta = (namespaced: boolean) => ({
  type: 'object',
  additionalProperties: false,
  required: ['name'],
  properties: {
    name: { type: 'string', description: 'Resource name (DNS-1123 subdomain).' },
    ...(namespaced ? { namespace: { type: 'string', description: 'Namespace this policy applies in.' } } : {}),
    labels: { type: 'object', additionalProperties: { type: 'string' } },
    annotations: { type: 'object', additionalProperties: { type: 'string' } },
  },
});

// --- overlay apply (deep-merge fragments at dotted resource paths) -----------
//
// Path convention matches check-crd-drift.ts: property keys extend the path,
// arrays collapse (descend into `.items` without a segment). A string value
// sets `.description`; an object value is deep-merged (adds fields / overrides
// enums). Adding a field: the parent object must exist; the leaf is created.
function deepMerge(target: any, patch: any): any {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) return patch;
  if (typeof target !== 'object' || target === null || Array.isArray(target)) target = {};
  for (const [k, v] of Object.entries(patch)) target[k] = deepMerge(target[k], v);
  return target;
}

// Resolve dotted path to the node it addresses, creating the final property if
// its parent object exists. Returns the parent's `properties` bag + leaf key so
// the caller can create-or-merge. null if the path can't be reached.
function locate(root: any, path: string): { bag: any; key: string } | null {
  const segs = path.split('.');
  let node = root;
  for (let i = 0; i < segs.length; i++) {
    while (node && node.type === 'array' && node.items) node = node.items; // collapse
    if (!node || node.type !== 'object' || !node.properties) return null;
    const key = segs[i];
    if (i === segs.length - 1) return { bag: node.properties, key };
    node = node.properties[key];
  }
  return null;
}

function applyOverlay(resource: any, patches: Record<string, string | object>) {
  // Root ("") describes the resource itself.
  if (patches['']) deepMerge(resource, typeof patches[''] === 'string' ? { description: patches[''] } : patches['']);
  // Apply shallower paths first so parents exist before children are added.
  for (const path of Object.keys(patches).filter(Boolean).sort((a, b) => a.split('.').length - b.split('.').length)) {
    const at = locate(resource, path);
    if (!at) { console.warn(`! overlay path not reachable, skipped: ${path}`); continue; }
    const val = patches[path];
    const frag = typeof val === 'string' ? { description: val } : val;
    at.bag[at.key] = deepMerge(at.bag[at.key], frag);
  }
}

// --- build one resource schema from its CRD ---------------------------------

function buildResource(crd: any, kind: string): any {
  const version = (crd.spec.versions || []).find((v: any) => v.name === 'v3') ?? crd.spec.versions[0];
  const root = version.schema.openAPIV3Schema;
  const namespaced = crd.spec.scope === 'Namespaced';
  const resource: any = {
    type: 'object',
    additionalProperties: false,
    required: ['apiVersion', 'kind', 'metadata', 'spec'],
    title: KINDS[kind],
    properties: {
      apiVersion: { const: `${crd.spec.group}/${version.name}` },
      kind: { const: kind },
      metadata: objectMeta(namespaced),
      spec: crdToSchema(root.properties.spec), // status et al. dropped
    },
  };
  applyOverlay(resource, overlay[kind] ?? {});
  return resource;
}

// --- load CRDs --------------------------------------------------------------

function loadCrds(): Map<string, any> {
  const text = readFileSync(CRD_PATH, 'utf8');
  const byKind = new Map<string, any>();
  for (const doc of parseAllDocuments(text)) {
    const j: any = doc.toJSON();
    if (j?.kind !== 'CustomResourceDefinition' || j.spec?.group !== 'projectcalico.org') continue;
    const kind = j.spec?.names?.kind;
    if (kind in KINDS) byKind.set(kind, j);
  }
  return byKind;
}

// --- seed mode: bootstrap the overlay from the current hand schema ----------
//
// Diffs the existing buildPolicySchema() against a raw (overlay-free) CRD
// generation and prints the delta as an overlay literal: descriptions for
// shared fields, full fragments for editor-only additions, enum/anyOf overrides
// where they differ. Run once when adopting; then hand-curate the overlay.
async function seed() {
  const { buildPolicySchema } = await import('../src/policySchemas.ts');
  const crds = loadCrds();
  const root: any = buildPolicySchema(['default']);
  const oldByKind = new Map<string, any>();
  for (const b of root.oneOf ?? []) {
    const k = b?.properties?.kind?.const;
    if (k in KINDS && String(b?.properties?.apiVersion?.const).startsWith('projectcalico.org')) oldByKind.set(k, b);
  }

  const out: Record<string, Record<string, any>> = {};
  for (const kind of Object.keys(KINDS)) {
    const old = oldByKind.get(kind);
    const crd = crds.get(kind);
    if (!old || !crd) continue;
    const version = (crd.spec.versions || []).find((v: any) => v.name === 'v3') ?? crd.spec.versions[0];
    // Diff only the spec subtree; apiVersion/kind/metadata are injected by
    // buildResource(), never overlaid.
    const genSpec = crdToSchema(version.schema.openAPIV3Schema.properties.spec);
    const patches: Record<string, any> = {};
    diff(old.properties?.spec, genSpec, 'spec', patches);
    if (Object.keys(patches).length) out[kind] = patches;
  }
  console.log('// paste into web/src/policySchemaOverlay.ts (then curate):');
  console.log(JSON.stringify(out, null, 2));
}

// Walk old (curated) tree; for each path emit what the raw CRD lacks/differs.
function diff(oldNode: any, genNode: any, path: string, out: Record<string, any>) {
  if (!oldNode || typeof oldNode !== 'object') return;
  const gen = genNode && typeof genNode === 'object' ? genNode : undefined;

  if (!gen) {
    // Field absent from the CRD -> emit the whole curated node as an addition.
    if (path) out[path] = stripConst(oldNode);
    return;
  }
  // Shared field: capture description and enum/anyOf enrichment deltas.
  const frag: any = {};
  // title matters: an untitled object node under the root oneOf can borrow a
  // wrong branch's title in hover (see the labelSelector fix in policySchemas.ts).
  if (oldNode.title && oldNode.title !== gen.title) frag.title = oldNode.title;
  if (oldNode.description && oldNode.description !== gen.description) frag.description = oldNode.description;
  if (oldNode.enum && JSON.stringify(oldNode.enum) !== JSON.stringify(gen.enum)) frag.enum = oldNode.enum;
  if (oldNode.anyOf && JSON.stringify(oldNode.anyOf) !== JSON.stringify(gen.anyOf)) frag.anyOf = oldNode.anyOf;
  if (path && Object.keys(frag).length) {
    out[path] = 'description' in frag && Object.keys(frag).length === 1 ? frag.description : frag;
  }
  // Recurse (collapse arrays, mirroring locate()).
  const o = collapse(oldNode), g = collapse(gen);
  if (o.properties) for (const [k, child] of Object.entries(o.properties)) diff(child, g.properties?.[k], path ? `${path}.${k}` : k, out);
}

const collapse = (n: any) => { while (n && n.type === 'array' && n.items) n = n.items; return n ?? {}; };
const stripConst = (n: any) => { const c = structuredClone(n); return c; };

// --- generate mode ----------------------------------------------------------

function generate() {
  const crds = loadCrds();
  const schemas: Record<string, any> = {};
  for (const kind of Object.keys(KINDS)) {
    const crd = crds.get(kind);
    if (!crd) { console.warn(`! ${kind}: not found in CRD manifest`); continue; }
    schemas[kind] = buildResource(crd, kind);
  }
  const banner =
    '// GENERATED by scripts/gen-policy-schema.ts from the Calico CRD manifest +\n' +
    '// the description overlay (src/policySchemaOverlay.ts). DO NOT EDIT BY HAND.\n' +
    '// Regenerate: npm run gen:crd\n\n';
  writeFileSync(OUT_PATH, banner + 'export const generatedSchemas = ' + JSON.stringify(schemas, null, 2) + ' as const;\n');
  console.log(`✓ wrote ${OUT_PATH} (${Object.keys(schemas).length} kinds)`);
}

if (SEED) await seed();
else generate();
