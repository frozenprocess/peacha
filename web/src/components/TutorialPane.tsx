// Read-along tutorial track. Tutorials come from GET /v1/tutorials already
// sorted by meta.order; each is an Example (loadable scenario) plus a markdown
// lesson (`doc`) and ordering metadata. Selecting one loads its policy +
// scenario into the editor (via the parent's onSelect → loadExample) and shows
// its lesson here - the learner reads while the graph/matrix reflect the policy.
//
// Rendering reuses the `.docs` styles. A lesson may reference an image relative
// to its own folder (e.g. `![](01.editor.png)`); the custom `img` renderer
// rewrites that to the Go asset route GET /v1/tutorials/<dir>/<file> so the
// embedded file is served. Absolute/remote srcs pass through untouched.

import type { Tutorial } from '../api';
import { LessonDoc } from './LessonDoc';
import { FeedbackWidget } from './FeedbackWidget';

interface Props {
  tutorials: Tutorial[];
  activeId: string | null;
  onSelect: (id: string) => void;
  theme: 'light' | 'dark';
  // Run a code block's content (the `exec` fence flag loads it into the editor).
  onRunCode: (code: string) => void;
}

export function TutorialPane({ tutorials, activeId, onSelect, theme, onRunCode }: Props) {
  if (!tutorials.length) {
    return <p className="docs">No tutorials available.</p>;
  }

  // Server order is the track order; index drives Prev/Next.
  const idx = Math.max(
    0,
    tutorials.findIndex((t) => t.name === activeId),
  );
  const active = tutorials[idx];

  // Group by track for the picker, preserving first-seen (order-sorted) order.
  const tracks: { track: string; items: Tutorial[] }[] = [];
  for (const t of tutorials) {
    const name = t.track || 'Tutorials';
    let g = tracks.find((x) => x.track === name);
    if (!g) {
      g = { track: name, items: [] };
      tracks.push(g);
    }
    g.items.push(t);
  }

  return (
    <div className="tutorial">
      <div className="tutorial-nav tutorial-nav-top">
        <button
          className="tutorial-step"
          disabled={idx <= 0}
          onClick={() => onSelect(tutorials[idx - 1].name)}
          title="previous tutorial"
          aria-label="previous tutorial"
        >
          ◀
        </button>
        <select
          className="tutorial-select"
          value={active.name}
          onChange={(e) => onSelect(e.target.value)}
        >
          {tracks.map((g) => (
            <optgroup key={g.track} label={g.track}>
              {g.items.map((t) => (
                <option key={t.name} value={t.name}>
                  {t.title}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
        <button
          className="tutorial-step"
          disabled={idx >= tutorials.length - 1}
          onClick={() => onSelect(tutorials[idx + 1].name)}
          title="next tutorial"
          aria-label="next tutorial"
        >
          ▶
        </button>
      </div>
      <div className="tutorial-meta">
        {active.track ? <span className="tutorial-track">{active.track}</span> : null}
        <span className="tutorial-count">
          {idx + 1} / {tutorials.length}
        </span>
      </div>
      <div className="docs">
        <LessonDoc
          doc={active.doc}
          assetBase={`/v1/tutorials/${active.dir}`}
          theme={theme}
          onRunCode={onRunCode}
        />
      </div>
      {/* Opted-in pages (meta.json "feedback": true) gather GA testimonies.
          Rendered as the last element in the scroll region (after the bottom
          nav) so the sticky footer settles flush at the very end instead of
          floating over the nav below it. Keyed by slug so switching lessons
          resets the widget's local state. */}
      {active.feedback ? (
        <FeedbackWidget key={active.name} tutorialName={active.name} />
      ) : null}
    </div>
  );
}
