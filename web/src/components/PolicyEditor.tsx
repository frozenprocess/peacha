// Monaco-backed YAML editor for the policy bundle. We lazy-load via the
// @monaco-editor/react package, which fetches the editor worker on demand and
// gives us syntax highlighting + folding for free. Schema-aware completion,
// hover docs and validation come from monaco-yaml, wired globally in
// ../monacoSetup.ts; the `path` prop below opens the model under the URI that
// setup's schema fileMatch targets.

import Editor, { OnMount } from '@monaco-editor/react';
import { POLICY_MODEL_PATH } from '../monacoSetup';

interface Props {
  value: string;
  onChange: (v: string) => void;
  // App's color theme; maps to Monaco's built-in 'vs' / 'vs-dark' so the
  // editor tracks light/dark with the rest of the UI.
  theme: 'light' | 'dark';
}

export function PolicyEditor({ value, onChange, theme }: Props) {
  // Monaco resizes itself from its container, but only after a layout call.
  // We trigger one on mount so the editor fills the pane immediately rather
  // than initially rendering at 0×0 and snapping later.
  const handleMount: OnMount = (editor, monaco) => {
    queueMicrotask(() => editor.layout());
    // macOS grabs Ctrl+Space (input-source switching) before Monaco sees it, so
    // the default trigger-suggest key is dead there. Bind Option/Alt+Space as a
    // Mac-safe alternate; the default stays for other platforms. quickSuggestions
    // (below) still opens the widget automatically as you type.
    editor.addCommand(monaco.KeyMod.Alt | monaco.KeyCode.Space, () =>
      editor.trigger('keyboard', 'editor.action.triggerSuggest', {}),
    );
  };

  return (
    <Editor
      height="100%"
      defaultLanguage="yaml"
      language="yaml"
      path={POLICY_MODEL_PATH}
      value={value}
      onChange={(v) => onChange(v ?? '')}
      onMount={handleMount}
      theme={theme === 'dark' ? 'vs-dark' : 'vs'}
      options={{
        minimap: { enabled: false },
        fontSize: 12,
        scrollBeyondLastLine: false,
        wordWrap: 'off',
        tabSize: 2,
        renderLineHighlight: 'gutter',
        lineNumbersMinChars: 3,
        folding: true,
        automaticLayout: true,
        quickSuggestions: { other: true, comments: false, strings: true },
      }}
    />
  );
}
