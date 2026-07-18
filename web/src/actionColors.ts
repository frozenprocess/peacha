// THE single source of truth for policy/rule ACTION colors across the app.
//   Deny  = red    Allow/Accept = green    Pass = grey    Log = blue
//
// Used directly by TS surfaces (graph edges + legend in buildGraph/Graph, tier
// policy-card borders in PolicyNode) and mirrored into CSS custom properties
// (--act-deny/allow/pass/log) by installActionColorVars() so CSS-styled
// surfaces (the tier end-of-tier footer, …) reference the exact same values.
// Change a colour here and every place that shows these actions follows.

export type ActionKind = 'deny' | 'allow' | 'pass' | 'log';

export const ACTION_COLOR: Record<ActionKind, string> = {
  deny: '#c5221f', // red
  allow: '#137333', // green
  pass: '#5f6368', // grey
  log: '#1a73e8', // blue
};

// actionKind normalises any policy/rule action spelling (Calico v3, the NPA, and
// dataplane synonyms) to its canonical kind, or undefined if unrecognised.
export function actionKind(action: string | undefined): ActionKind | undefined {
  switch ((action ?? '').trim().toLowerCase()) {
    case 'deny':
    case 'drop':
    case 'block':
    case 'reject':
      return 'deny';
    case 'allow':
    case 'accept':
      return 'allow';
    case 'pass':
    case 'next-tier':
      return 'pass';
    case 'log':
      return 'log';
    default:
      return undefined;
  }
}

// installActionColorVars publishes the palette as CSS custom properties on the
// root element so stylesheets can use var(--act-deny) etc. Call once at startup.
export function installActionColorVars(root: HTMLElement = document.documentElement): void {
  for (const k of Object.keys(ACTION_COLOR) as ActionKind[]) {
    root.style.setProperty(`--act-${k}`, ACTION_COLOR[k]);
  }
}
