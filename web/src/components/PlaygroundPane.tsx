// The Playground tab's left pane: a single read-along welcome doc (the
// `00-getting-started` tutorial, flagged `playground: true` in its meta.json and
// pulled out of the tutorials track). Unlike TutorialPane there's no picker or
// Prev/Next - Playground is the free-form sandbox served at "/", so the doc is
// just orientation while the editor stays freely editable and state mirrors into
// the share fragment.
//
// Rendering reuses LessonDoc (and therefore the tutorial asset route) exactly as
// the tutorial track does, so the same markdown/image authoring works.

import type { Tutorial } from '../api';
import { LessonDoc } from './LessonDoc';

interface Props {
  doc: Tutorial | null;
  theme: 'light' | 'dark';
  // Run a code block's content (the `exec` fence flag loads it into the editor).
  onRunCode: (code: string) => void;
}

export function PlaygroundPane({ doc, theme, onRunCode }: Props) {
  if (!doc) {
    return <p className="docs">Welcome to the Peacha playground - edit policies on the right.</p>;
  }
  return (
    <div className="docs">
      <LessonDoc
        doc={doc.doc}
        assetBase={`/v1/tutorials/${doc.dir}`}
        theme={theme}
        onRunCode={onRunCode}
      />
    </div>
  );
}
