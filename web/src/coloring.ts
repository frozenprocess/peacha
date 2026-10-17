// Origin attribution for rendered dataplane output. The bpf / iptables /
// nftables views color each chain (iptables/nft) or instruction line (bpf) by
// *why it exists* - so a user can see at a glance which objects were added
// because of a policy vs an endpoint vs a namespace profile vs Felix's static
// scaffolding. Categorisation is purely structural (chain-name prefixes for
// iptables, polprog section comments for bpf), so no engine changes needed.

import type { BPFEntity, BPFICMP, BPFIPSet, BPFPortRange, BPFProfile, BPFRule, BPFTier } from './api';

export type Origin = 'policy' | 'profile' | 'endpoint' | 'dispatch' | 'static';

export const ORIGIN_LABEL: Record<Origin, string> = {
  policy: 'policy',
  profile: 'profile (ns default)',
  endpoint: 'endpoint',
  dispatch: 'dispatch',
  static: 'static / scaffolding',
};

// chainOrigin maps an iptables/nftables chain name to its origin via Felix's
// stable naming convention (felix/rules/rule_defs.go):
//   cali-pi-/cali-po-   policy chains
//   cali-pri-/cali-pro- profile chains
//   cali-tw-/cali-fw-   workload-endpoint chains (cali-th-/fh-/thfw-/fhfw- host)
//   *-dispatch, cali-sm- dispatch chains
//   everything else (cali-INPUT/FORWARD/OUTPUT, cali-wl-to-host, …) static
export function chainOrigin(name: string): Origin {
  if (name.startsWith('cali-pi-') || name.startsWith('cali-po-')) return 'policy';
  if (name.startsWith('cali-pri-') || name.startsWith('cali-pro-')) return 'profile';
  if (
    name.startsWith('cali-tw-') ||
    name.startsWith('cali-fw-') ||
    name.startsWith('cali-th-') ||
    name.startsWith('cali-fh-') ||
    name.startsWith('cali-thfw-') ||
    name.startsWith('cali-fhfw-')
  )
    return 'endpoint';
  if (name.includes('-dispatch') || name.startsWith('cali-sm-')) return 'dispatch';
  return 'static';
}

export interface ColoredLine {
  text: string;
  origin: Origin;
}

// categorizeBPF walks a rendered eBPF policy program and tags each line by
// origin. The program *scaffolding* (header, host checks, allow/deny/exit
// plumbing) exists because the endpoint has a program at all → 'endpoint'.
// Instructions inside a tier (Start of tier … End of tier) are policy-driven;
// the profile rule block (out-of-tier "Start of rule …") is 'profile'.
//
// polprog emits the section markers as instruction comments when policy-debug
// is enabled (felix/bpf/polprog), which the engine sets - so the markers are
// reliable. A few inter-section plumbing lines may be attributed to the
// preceding section; the coloring is a navigation aid, not a proof.
//
// Only the verbose disassembly is text; the concise tree arrives structured
// and is colored by bpfTreeLines instead.
export function categorizeBPF(lines: string[]): ColoredLine[] {
  let cur: Origin = 'endpoint';
  let inTier = false;
  const out: ColoredLine[] = [];
  for (const text of lines) {
    const comment = text.startsWith('  ; ') ? text.slice(4) : '';
    const label = /^[A-Za-z_][\w]*:$/.test(text.trim()) ? text.trim().slice(0, -1) : '';

    if (comment.startsWith('Start of tier ')) {
      cur = 'policy';
      inTier = true;
    } else if (comment.startsWith('End of tier ')) {
      inTier = false; // stays policy through this line; reset happens on next section
    } else if (comment.startsWith('Start of rule ') && !inTier) {
      cur = 'profile';
    }
    // Structural footer labels return to endpoint scaffolding. Kept to a known
    // allow-list so per-rule labels (rule_0_no_match, …) don't trip it.
    if (label === 'allow' || label === 'deny' || label === 'exit' || label === 'exit_program') {
      cur = 'endpoint';
    }

    out.push({ text, origin: cur });
  }
  return out;
}

// bpfTreeLines flattens the concise tier→policy→rule tree into indented lines,
// the same shape `telepathy bpf` prints (mirroring `calico-node bpf policy
// dump`). Tier lines are 'policy', profile lines 'profile'.
export function bpfTreeLines(tiers: BPFTier[] = [], profiles: BPFProfile[] = []): ColoredLine[] {
  const out: ColoredLine[] = [];
  for (const t of tiers) {
    const push = (text: string) => out.push({ text, origin: 'policy' });
    push(`Tier: ${t.name}`);
    for (const p of t.policies ?? []) {
      const name = p.namespace ? `${p.namespace}/${p.name}` : p.name;
      push(`  Policy: ${p.kind ? p.kind + ' ' : ''}${name}`);
      for (const l of bpfRuleLines(p.rules, '    ')) push(l);
    }
    if (t.defaultAction) push(`  End Tier: ${t.name}  (action: ${t.defaultAction})`);
  }
  for (const p of profiles) {
    out.push({ text: `Profile: ${p.name}`, origin: 'profile' });
    for (const l of bpfRuleLines(p.rules, '  ')) out.push({ text: l, origin: 'profile' });
  }
  return out;
}

function bpfRuleLines(rules: BPFRule[] = [], indent: string): string[] {
  const out: string[] = [];
  for (const r of rules) {
    let head = `${indent}Rule: Action: ${r.action}`;
    if (r.protocol) head += `  Protocol: ${r.protocol}`;
    if (r.notProtocol) head += `  NotProtocol: ${r.notProtocol}`;
    if (r.icmp) head += `  ICMP: ${icmpText(r.icmp)}`;
    if (r.notICMP) head += `  NotICMP: ${icmpText(r.notICMP)}`;
    out.push(head);
    const src = entityText(r.source);
    if (src) out.push(`${indent}  Source:${src}`);
    const dst = entityText(r.destination);
    if (dst) out.push(`${indent}  Destination:${dst}`);
  }
  return out;
}

const icmpText = (i: BPFICMP) => (i.code !== undefined ? `type=${i.type} code=${i.code}` : `type=${i.type}`);

const portsText = (ps: BPFPortRange[]) => ps.map((p) => (p.first === p.last ? `${p.first}` : `${p.first}-${p.last}`)).join(',');

// An IP set reads as its resolved members; the synthetic ID is only shown when
// the request captured none.
const ipSetText = (s: BPFIPSet) => (s.members?.length ? `{${s.members.join(',')}}` : `ipSet(${s.id})`);

function entityText(e?: BPFEntity): string {
  if (!e) return '';
  let s = '';
  if (e.nets?.length) s += ` nets=${e.nets.join(',')}`;
  if (e.notNets?.length) s += ` !nets=${e.notNets.join(',')}`;
  for (const set of e.ipSets ?? []) s += ` ${ipSetText(set)}`;
  for (const set of e.notIPSets ?? []) s += ` !${ipSetText(set)}`;
  if (e.ports?.length) s += ` ports=${portsText(e.ports)}`;
  if (e.notPorts?.length) s += ` !ports=${portsText(e.notPorts)}`;
  if (e.namedPorts?.length) s += ` namedPorts=${e.namedPorts.join(',')}`;
  if (e.notNamedPorts?.length) s += ` !namedPorts=${e.notNamedPorts.join(',')}`;
  return s;
}

export interface Segment {
  text: string;
  // When set, this segment is a jump/goto target chain reference; refOrigin is
  // the origin of the chain being jumped into (so a rule inside an endpoint
  // chain visibly points at the policy/profile chain it activates).
  refOrigin?: Origin;
}

// splitJumpTargets breaks an iptables/nftables rule line into segments,
// flagging the chain name that follows a --jump/--goto/-j/-g (iptables) or
// jump/goto (nftables). Lets a view tint the target by its origin.
export function splitJumpTargets(line: string): Segment[] {
  const re = /((?:--jump|--goto|-j|-g|jump|goto)\s+)(cali-[\w./-]+)/g;
  const segs: Segment[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line)) !== null) {
    const targetStart = m.index + m[1].length;
    if (targetStart > last) segs.push({ text: line.slice(last, targetStart) });
    segs.push({ text: m[2], refOrigin: chainOrigin(m[2]) });
    last = targetStart + m[2].length;
  }
  if (last < line.length) segs.push({ text: line.slice(last) });
  if (segs.length === 0) segs.push({ text: line });
  return segs;
}

// originsPresent returns the distinct origins in a list, in legend order.
const ORDER: Origin[] = ['policy', 'profile', 'endpoint', 'dispatch', 'static'];
export function originsPresent(origins: Origin[]): Origin[] {
  const seen = new Set(origins);
  return ORDER.filter((o) => seen.has(o));
}
