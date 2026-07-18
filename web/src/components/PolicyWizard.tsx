// Schema-driven policy wizard. NO YAML typing, NO per-kind code: it renders a
// form straight from buildPolicySchema()'s oneOf branches - the same schema
// that drives the editor's validation. Pick a kind, and the fields for that
// kind (and only that kind) appear; nested rules, peers and ports reveal
// themselves as you add them. One recursive <Field> covers every construct the
// schema uses, so every kind and every field is reachable by clicking alone.
//
// The built value is serialized to YAML and appended to the editor via onAdd -
// the wizard never parses YAML back, so there's no round-trip to rot.

import { useMemo, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { stringify } from 'yaml';
import { buildPolicySchema } from '../policySchemas';
import { type PolicyVocabulary } from '../policyCompletions';

// The schemas are plain JSON-schema objects; we walk them structurally.
type Schema = any;
type Vocab = PolicyVocabulary;

interface Props {
  tierNames: string[];              // parameterises the Calico spec.tier enum
  vocab: Vocab;                     // live topology values for the comboboxes
  onAdd: (yaml: string) => void;
  // The overlay portals here so it fills the whole graph pane, not the tiny
  // absolutely-positioned toolbar the trigger button lives in.
  hostRef: RefObject<HTMLElement | null>;
}

const kindOf = (s: Schema): string => s?.properties?.kind?.const ?? '';
const titleOf = (s: Schema): string => s?.title ?? kindOf(s) ?? 'document';

// Kind picker sections: k8s policies, everyday Calico policies, and the advanced
// Calico resources (staged policies, Tier, HostEndpoint).
const kindGroup = (s: Schema): 'k8s' | 'calico' | 'advanced' => {
  const kind = kindOf(s);
  if (kind.startsWith('Staged') || kind === 'Tier' || kind === 'HostEndpoint') return 'advanced';
  const api: string = s?.properties?.apiVersion?.const ?? '';
  return api.includes('k8s.io') ? 'k8s' : 'calico';
};
const KIND_GROUPS = [
  { group: 'k8s' as const, label: 'Kubernetes' },
  { group: 'calico' as const, label: 'Calico' },
  { group: 'advanced' as const, label: 'Calico advanced resources' },
];

// Pre-fill the const leaves (apiVersion, kind) so the doc is valid the moment a
// kind is picked; everything else the user fills in.
function seedConsts(schema: Schema): any {
  if (!schema || typeof schema !== 'object') return undefined;
  if ('const' in schema) return schema.const;
  if (schema.type === 'object' && schema.properties) {
    const o: Record<string, any> = {};
    for (const [k, v] of Object.entries(schema.properties)) {
      const s = seedConsts(v);
      if (s !== undefined) o[k] = s;
    }
    return o;
  }
  return undefined;
}

// A sensible empty value when the user adds an optional field or array item.
function emptyFor(schema: Schema): any {
  if (!schema || typeof schema !== 'object') return undefined;
  if ('const' in schema) return schema.const;
  if (schema.type === 'object') return seedConsts(schema) ?? {};
  if (schema.type === 'array') return [];
  if (schema.type === 'boolean') return false;
  return undefined; // string / number / enum / anyOf -> let the input fill it
}

// Deep-drop empties so the preview is a clean doc (no `namespace: ''` noise).
function prune(v: any): any {
  if (Array.isArray(v)) {
    const a = v.map(prune).filter((x) => x !== undefined);
    return a.length ? a : undefined;
  }
  if (v && typeof v === 'object') {
    const o: Record<string, any> = {};
    for (const [k, val] of Object.entries(v)) {
      const p = prune(val);
      if (p !== undefined) o[k] = p;
    }
    return Object.keys(o).length ? o : undefined;
  }
  return v === '' || v == null ? undefined : v;
}

// anyOf in these schemas is always "scalar with alternatives" (int|string for
// ports, enum|number for protocol). Collapse to one input: suggest any enum
// values, accept free text, and coerce all-digit input to a number.
function coerceScalar(raw: string): any {
  if (raw === '') return undefined;
  return /^\d+$/.test(raw) ? Number(raw) : raw;
}
function enumSuggestions(schema: Schema): string[] {
  if (Array.isArray(schema?.enum)) return schema.enum.map(String);
  if (Array.isArray(schema?.anyOf)) return schema.anyOf.flatMap((b: Schema) => enumSuggestions(b));
  return [];
}

export function PolicyWizard({ tierNames, vocab, onAdd, hostRef }: Props) {
  const [open, setOpen] = useState(false);
  const kinds: Schema[] = useMemo(() => buildPolicySchema(tierNames).oneOf, [tierNames]);
  const [idx, setIdx] = useState<number | null>(null);
  const [value, setValue] = useState<any>({});

  const schema = idx != null ? kinds[idx] : null;
  const doc = useMemo(() => (schema ? prune(value) ?? {} : null), [schema, value]);
  const yaml = doc ? stringify(doc) : '';

  const pickKind = (i: number) => {
    setIdx(i);
    setValue(seedConsts(kinds[i]) ?? {});
  };
  const reset = () => {
    setIdx(null);
    setValue({});
  };

  if (!open) {
    return (
      <button className="graph-check" title="build a policy step by step, no YAML" onClick={() => setOpen(true)}>
        ＋ policy wizard
      </button>
    );
  }

  const overlay = (
    <div className="wizard-overlay" role="dialog" aria-label="policy wizard">
      <div className="wizard">
        <div className="wizard-head">
          <strong>{schema ? titleOf(schema) : 'New policy'}</strong>
          <div className="wizard-head-actions">
            {schema ? <button onClick={reset}>← kind</button> : null}
            <button onClick={() => setOpen(false)}>✕</button>
          </div>
        </div>

        {!schema ? (
          <div className="wizard-kinds">
            {KIND_GROUPS.map(({ label, group }) => {
              const members = kinds.map((k, i) => ({ k, i })).filter(({ k }) => kindGroup(k) === group);
              if (!members.length) return null;
              return (
                <div key={group} className="wizard-kind-group">
                  <div className="wizard-kind-grouplabel">{label}</div>
                  {members.map(({ k, i }) => (
                    <button key={kindOf(k) + i} className="wizard-kind" onClick={() => pickKind(i)}>
                      <span className="wizard-kind-title">{titleOf(k)}</span>
                      <span className="wizard-kind-api">{k.properties?.apiVersion?.const}</span>
                    </button>
                  ))}
                </div>
              );
            })}
          </div>
        ) : (
          <div className="wizard-body">
            <div className="wizard-form">
              <Field schema={schema} value={value} onChange={setValue} required top path={[]} vocab={vocab} />
            </div>
            <div className="wizard-preview">
              <div className="wizard-preview-label">preview</div>
              <pre>{yaml}</pre>
              <button
                className="groupby-btn active wizard-add"
                onClick={() => {
                  onAdd(yaml);
                  setOpen(false);
                  reset();
                }}
              >
                add to editor
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );

  // Portal into the graph pane so the overlay covers the whole graph, not just
  // the toolbar. Falls back to inline if the host isn't mounted yet.
  return hostRef.current ? createPortal(overlay, hostRef.current) : overlay;
}

// Which label set a selector/matchLabels resolves against, from the field path:
// namespace selectors match namespace labels, SA selectors match SA labels,
// everything else matches workload labels. Mirrors policyCompletions' split.
function labelDomain(path: string[], vocab: Vocab): Map<string, Set<string>> {
  if (path.includes('namespaceSelector') || path.includes('namespaces')) return vocab.namespaceLabels;
  if (path.includes('serviceAccountSelector')) return vocab.serviceAccountLabels;
  return vocab.workloadLabels;
}

// Options for a free-form string leaf, from the live topology - the same values
// the editor's completion offers. Empty means "no topology suggestions" (a
// plain text box). The user can always type past the list, so it never traps.
// Calico selector STRING keys get the dedicated SelectorField (operators +
// clause picker); everything else here is a plain value combobox.
const SELECTOR_KEYS = new Set(['selector', 'notSelector', 'namespaceSelector', 'serviceAccountSelector']);

// spec fields that are essential enough to always render (never behind "+ add
// field…"), so the user sees the shape of a policy without hunting for them.
const ESSENTIAL_SPEC_KEYS = new Set(['selector', 'namespaceSelector', 'order', 'ingress', 'egress', 'tier']);

function leafSuggestions(name: string | undefined, path: string[], vocab: Vocab): string[] {
  if (name === 'namespace') return vocab.namespaces;
  const last = path.at(-1);
  if (last === 'nets' || last === 'notNets' || last === 'networks') return vocab.cidrs;
  if (last === 'domains' || last === 'domainNames') return vocab.domains;
  return [];
}

// Calico selector-language operators, appended at the end of the expression.
// The input stays free-text, so anything the buttons don't cover is typable.
const SELECTOR_OPS = ['&&', '||', '!', '==', '!=', 'in {  }', 'not in {  }', 'has()', 'all()', 'global()', '(', ')'];

// A builder for Calico selector strings: a free-text input plus a clause picker
// (real label == value / has(key)) and operator buttons. Compound expressions
// build up by appending - a datalist can't, since picking replaces the whole
// value and would wipe `a == 'x' &&`.
function SelectorField({
  value,
  onChange,
  labels,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  labels: Map<string, Set<string>>;
  placeholder?: string;
}) {
  const append = (tok: string) => {
    const cur = value ?? '';
    const sep = cur && !/\s$/.test(cur) ? ' ' : '';
    onChange((cur + sep + tok).replace(/^\s+/, ''));
  };
  const clauses: string[] = [];
  for (const [k, vs] of labels) {
    if (vs.size === 0) clauses.push(`has(${k})`);
    for (const v of vs) clauses.push(`${k} == '${v}'`);
  }
  return (
    <div className="wizard-selector">
      <input
        className="wizard-sel-input"
        value={value ?? ''}
        placeholder={placeholder ?? "e.g. app == 'frontend' && env != 'test'"}
        onChange={(e) => onChange(e.target.value)}
      />
      <div className="wizard-sel-ops">
        {clauses.length ? (
          <select
            className="wizard-sel-clause"
            value=""
            onChange={(e) => {
              if (e.target.value) append(e.target.value);
            }}
          >
            <option value="">+ label…</option>
            {clauses.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        ) : null}
        {SELECTOR_OPS.map((op) => (
          <button key={op} type="button" className="wizard-sel-op" onClick={() => append(op)}>
            {op.trim()}
          </button>
        ))}
      </div>
    </div>
  );
}

// A combobox: a text input backed by a <datalist> of suggestions. Picks from
// the list OR types a custom value - exactly the "choose or override" behavior.
function Combo({
  value,
  onChange,
  options,
  placeholder,
  idBase,
}: {
  value: string;
  onChange: (v: string) => void;
  options: string[];
  placeholder?: string;
  idBase: string;
}) {
  const id = options.length ? `dl-${idBase}` : undefined;
  return (
    <>
      <input value={value} list={id} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />
      {id ? (
        <datalist id={id}>
          {options.map((o) => <option key={o} value={o} />)}
        </datalist>
      ) : null}
    </>
  );
}

// One recursive renderer for every schema construct. `path` is the ancestor
// property names (drives topology suggestions); `top` skips the outer box.
function Field({
  schema,
  value,
  onChange,
  name,
  required,
  top,
  path,
  vocab,
}: {
  schema: Schema;
  value: any;
  onChange: (v: any) => void;
  name?: string;
  required?: boolean;
  top?: boolean;
  path: string[];
  vocab: Vocab;
}) {
  if (!schema || 'const' in schema) return null; // consts are seeded, not shown
  const idBase = [...path, name ?? ''].join('-').replace(/[^A-Za-z0-9_-]/g, '') || 'f';

  const label = name ? (
    <span className="wizard-label" title={schema.description}>
      {name}
      {required ? <span className="wizard-req">*</span> : null}
    </span>
  ) : null;

  // enum -> dropdown
  if (Array.isArray(schema.enum)) {
    return (
      <label className="wizard-field">
        {label}
        <select value={value ?? ''} onChange={(e) => onChange(e.target.value || undefined)}>
          <option value="">— choose —</option>
          {schema.enum.map((o: any) => (
            <option key={String(o)} value={String(o)}>{String(o)}</option>
          ))}
        </select>
      </label>
    );
  }

  // anyOf -> single scalar combobox (int|string ports, enum|number protocols)
  if (Array.isArray(schema.anyOf)) {
    return (
      <label className="wizard-field">
        {label}
        <Combo
          value={value ?? ''}
          options={enumSuggestions(schema)}
          placeholder={schema.description}
          idBase={idBase}
          onChange={(v) => onChange(coerceScalar(v))}
        />
      </label>
    );
  }

  // object -> fieldset. Two flavors: a free-form map (additionalProperties, e.g.
  // matchLabels/labels), or a set of named properties.
  if (schema.type === 'object') {
    const isMap = schema.additionalProperties && typeof schema.additionalProperties === 'object' && !schema.properties;
    if (isMap) return <MapField label={label} value={value} onChange={onChange} path={[...path, name ?? '']} vocab={vocab} />;

    // "exactly one of" objects (minProperties==maxProperties==1): the NPA
    // peers/subject/protocol/port. A dependent choice - pick the field, then
    // fill it. This is the wizard's "depends on what you picked" in action.
    const props: Record<string, Schema> = schema.properties ?? {};
    const req: string[] = schema.required ?? [];
    const optional = Object.keys(props).filter((k) => !req.includes(k) && !('const' in props[k]));
    const childPath = name ? [...path, name] : path;

    if (schema.minProperties === 1 && schema.maxProperties === 1) {
      const chosen = Object.keys(value ?? {}).find((k) => k in props) ?? '';
      return (
        <div className={top ? '' : 'wizard-nest'}>
          {label}
          <select value={chosen} onChange={(e) => onChange(e.target.value ? { [e.target.value]: emptyFor(props[e.target.value]) } : {})}>
            <option value="">— choose one —</option>
            {Object.keys(props).map((k) => <option key={k} value={k}>{k}</option>)}
          </select>
          {chosen ? (
            <Field schema={props[chosen]} value={value?.[chosen]} onChange={(v) => onChange({ [chosen]: v })} name={chosen} path={childPath} vocab={vocab} />
          ) : null}
        </div>
      );
    }

    // Under spec, essential fields render unconditionally (not hidden behind the
    // "+ add field…" picker) so the policy's shape is always visible.
    const essential = name === 'spec' ? ESSENTIAL_SPEC_KEYS : new Set<string>();
    const present = new Set(Object.keys(value ?? {}));
    const missing = optional.filter((k) => !present.has(k) && !essential.has(k));
    const setKey = (k: string, v: any) => onChange({ ...(value ?? {}), [k]: v });
    const dropKey = (k: string) => {
      const next = { ...(value ?? {}) };
      delete next[k];
      onChange(next);
    };
    return (
      <div className={top ? 'wizard-root' : 'wizard-nest'}>
        {label}
        {Object.keys(props)
          .filter((k) => !('const' in props[k]) && (req.includes(k) || present.has(k) || essential.has(k)))
          .map((k) => (
            <div key={k} className="wizard-prop">
              <Field schema={props[k]} value={value?.[k]} onChange={(v) => setKey(k, v)} name={k} required={req.includes(k)} path={childPath} vocab={vocab} />
              {!req.includes(k) && !essential.has(k) ? (
                <button className="wizard-drop" title={`remove ${k}`} onClick={() => dropKey(k)}>✕</button>
              ) : null}
            </div>
          ))}
        {missing.length ? (
          <select
            className="wizard-addfield"
            value=""
            onChange={(e) => e.target.value && setKey(e.target.value, emptyFor(props[e.target.value]))}
          >
            <option value="">+ add field…</option>
            {missing.map((k) => <option key={k} value={k}>{k}</option>)}
          </select>
        ) : null}
      </div>
    );
  }

  // array -> add/remove rows, each item rendered from items schema
  if (schema.type === 'array') {
    const items: any[] = Array.isArray(value) ? value : [];
    const set = (i: number, v: any) => onChange(items.map((it, j) => (j === i ? v : it)));
    const add = () => onChange([...items, emptyFor(schema.items)]);
    const del = (i: number) => onChange(items.filter((_, j) => j !== i));
    const childPath = name ? [...path, name] : path; // items inherit the array's key
    return (
      <div className="wizard-array">
        {label}
        {items.map((it, i) => (
          <div key={i} className="wizard-item">
            <Field schema={schema.items} value={it} onChange={(v) => set(i, v)} path={childPath} vocab={vocab} />
            <button className="wizard-drop" title="remove" onClick={() => del(i)}>✕</button>
          </div>
        ))}
        <button className="wizard-additem" onClick={add}>+ add {name ?? 'item'}</button>
      </div>
    );
  }

  // boolean -> checkbox
  if (schema.type === 'boolean') {
    return (
      <label className="wizard-field wizard-check">
        <input type="checkbox" checked={!!value} onChange={(e) => onChange(e.target.checked)} />
        {label}
      </label>
    );
  }

  // integer / number
  if (schema.type === 'integer' || schema.type === 'number') {
    return (
      <label className="wizard-field">
        {label}
        <input
          type="number"
          value={value ?? ''}
          min={schema.minimum}
          max={schema.maximum}
          placeholder={schema.description}
          onChange={(e) => onChange(e.target.value === '' ? undefined : Number(e.target.value))}
        />
      </label>
    );
  }

  // Calico selector string -> the operator-aware selector builder.
  if (name && SELECTOR_KEYS.has(name)) {
    return (
      <label className="wizard-field">
        {label}
        <SelectorField
          value={value ?? ''}
          labels={labelDomain([...path, name], vocab)}
          placeholder={schema.description}
          onChange={(v) => onChange(v || undefined)}
        />
      </label>
    );
  }

  // other string -> combobox of live topology values (namespaces, CIDRs, FQDNs),
  // still free-text so any custom value goes straight through.
  return (
    <label className="wizard-field">
      {label}
      <Combo
        value={value ?? ''}
        options={leafSuggestions(name, path, vocab)}
        placeholder={schema.description}
        idBase={idBase}
        onChange={(v) => onChange(v || undefined)}
      />
    </label>
  );
}

// Free-form {key: value} map (matchLabels, labels, annotations). Keys and values
// are comboboxes over the resolved label set; still additive and overridable.
function MapField({
  label,
  value,
  onChange,
  path,
  vocab,
}: {
  label: React.ReactNode;
  value: any;
  onChange: (v: any) => void;
  path: string[];
  vocab: Vocab;
}) {
  const labels = labelDomain(path, vocab);
  const keyOpts = [...labels.keys()].sort();
  // Rows are local state: an object value can't hold a half-typed row with a
  // blank key, so we keep the editable rows here and commit only the non-empty
  // pairs up. Without this the "+ add label" row is pruned before you can type.
  const [rows, setRows] = useState<[string, string][]>(() => Object.entries((value ?? {}) as Record<string, string>));
  const sync = (next: [string, string][]) => {
    setRows(next);
    const o: Record<string, string> = {};
    for (const [k, v] of next) if (k) o[k] = v;
    onChange(o);
  };
  return (
    <div className="wizard-map">
      {label}
      {rows.map(([k, v], i) => (
        <div key={i} className="wizard-map-row">
          <Combo
            value={k}
            options={keyOpts}
            placeholder="key"
            idBase={`${path.join('-')}-k`}
            onChange={(nk) => sync(rows.map((p, j) => (j === i ? [nk, p[1]] : p)))}
          />
          <Combo
            value={v}
            options={[...(labels.get(k) ?? [])].sort()}
            placeholder="value"
            idBase={`${path.join('-')}-v-${k}`.replace(/[^A-Za-z0-9_-]/g, '')}
            onChange={(nv) => sync(rows.map((p, j) => (j === i ? [p[0], nv] : p)))}
          />
          <button className="wizard-drop" title="remove" onClick={() => sync(rows.filter((_, j) => j !== i))}>✕</button>
        </div>
      ))}
      <button className="wizard-additem" onClick={() => setRows([...rows, ['', '']])}>+ add label</button>
    </div>
  );
}
