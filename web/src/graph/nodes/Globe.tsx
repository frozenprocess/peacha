// Internet-access indicator. A pod/HEP "has internet access" when it can egress
// to the external world/internet endpoint (matrix src→world == allow); a group
// (namespace / node) aggregates its members. Rendered as a globe that inherits
// currentColor (an emoji 🌐 can't be recoloured), tinted green/red/amber, with a
// native hover tooltip via the title attribute.
//
//   true      → green  "Internet Access"
//   false     → red    "No Internet Access"
//   'partial' → amber  "Partial Internet Access" (a group with a mix of members)

export type Access = boolean | 'partial';

const TITLE: Record<string, string> = {
  true: 'Internet Access',
  false: 'No Internet Access',
  partial: 'Partial Internet Access',
};
const VAR: Record<string, string> = {
  true: 'var(--allow-fg)',
  false: 'var(--deny-fg)',
  partial: 'var(--warning-fg)',
};

export function Globe({ value, size = 12 }: { value: Access; size?: number }) {
  const key = String(value);
  return (
    <span className="globe" style={{ color: VAR[key] }} title={TITLE[key]} aria-label={TITLE[key]}>
      <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3">
        <circle cx="8" cy="8" r="6.5" />
        <ellipse cx="8" cy="8" rx="3" ry="6.5" />
        <line x1="1.5" y1="8" x2="14.5" y2="8" />
      </svg>
    </span>
  );
}
