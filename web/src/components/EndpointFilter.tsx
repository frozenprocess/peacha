// Shared endpoint filter used by the BPF and iptables/nftables views. It's a
// free-text substring box (the server still matches by substring) backed by a
// native <datalist> so the current topology's endpoint ids autocomplete as you
// type - pick one for an exact match, or type a fragment to match several.

interface Props {
  value: string;
  onChange: (v: string) => void;
  // Candidate endpoint ids ("<ns>/<name>") to suggest. Deduped + sorted here.
  endpoints: string[];
  // Unique <datalist> id; must differ per mounted instance.
  listId: string;
  title?: string;
}

export function EndpointFilter({ value, onChange, endpoints, listId, title }: Props) {
  const options = Array.from(new Set(endpoints)).sort();
  return (
    <label title={title}>
      endpoint{' '}
      <input
        list={listId}
        value={value}
        placeholder="all (substring)"
        onChange={(e) => onChange(e.target.value)}
      />
      <datalist id={listId}>
        {options.map((id) => (
          <option key={id} value={id} />
        ))}
      </datalist>
    </label>
  );
}
