// Self-check for the CRD->schema generation + overlay pipeline. Runs the
// generated output through the invariants that break if crdToSchema /
// applyOverlay / the overlay itself regress. No framework, no validator dep:
//   node scripts/gen-policy-schema.test.ts
// Run `npm run gen:crd` first (or after editing the overlay) so it checks fresh output.

import assert from 'node:assert/strict';
import { buildPolicySchema } from '../src/policySchemas.ts';
import { generatedSchemas as g } from '../src/generatedPolicySchemas.ts';

// 1. Every generated kind is a discriminated, typo-catching resource.
for (const [kind, s] of Object.entries(g)) {
  assert.equal(s.properties.kind.const, kind, `${kind}: kind const`);
  assert.match(s.properties.apiVersion.const, /^projectcalico\.org\//, `${kind}: apiVersion const`);
  assert.equal(s.properties.spec.additionalProperties, false, `${kind}: spec typo-catching`);
  assert.equal(s.properties.metadata.properties.name.type, 'string', `${kind}: metadata.name`);
}

// 2. Structure came from the CRD: action enum has the full Calico set.
const rule = g.NetworkPolicy.properties.spec.properties.ingress.items;
assert.deepEqual(rule.properties.action.enum, ['Allow', 'Deny', 'Log', 'Pass'], 'action enum from CRD');

// 3. Overlay enrichment applied: protocol carries the enum names (not just int-or-string).
const protoEnum = rule.properties.protocol.anyOf.find((b: any) => b.enum)?.enum;
assert.ok(protoEnum?.includes('ICMPv6'), 'protocol enum names from overlay');

// 4. Overlay ADD applied: `domains` is editor-only (absent from the CRD).
assert.equal(rule.properties.source.properties.domains.type, 'array', 'domains added by overlay');

// 5. Overlay enum OVERRIDE applied: stagedAction narrowed to the engine's subset.
assert.deepEqual(g.StagedNetworkPolicy.properties.spec.properties.stagedAction.enum, ['Set', 'Delete'], 'stagedAction subset');

// 6. Overlay title applied: k8s-shaped selectors keep a title (hover-fallthrough fix).
assert.equal(g.StagedKubernetesNetworkPolicy.properties.spec.properties.podSelector.title, 'Label selector', 'podSelector title');

// 7. Descriptions present (the whole point of the overlay).
assert.ok(g.NetworkPolicy.properties.spec.properties.order.description, 'order description');

// 8. buildPolicySchema wires the tier enum in and keeps all 9 branches.
const root: any = buildPolicySchema(['default', 'security']);
assert.equal(root.oneOf.length, 9, 'oneOf branch count');
const calicoNP = root.oneOf.find((b: any) => b.properties?.kind?.const === 'NetworkPolicy' && b.properties?.apiVersion?.const?.startsWith('projectcalico'));
assert.deepEqual(calicoNP.properties.spec.properties.tier.enum, ['default', 'security'], 'live tier enum injected');

console.log('✓ gen-policy-schema self-check passed');
