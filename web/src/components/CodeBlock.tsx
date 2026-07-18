// Read-only, syntax-highlighted code block for tutorial markdown. Instead of
// pulling in a separate highlighter, it reuses the Monaco that already powers
// the policy editor: colorizeCode() tokenizes the snippet into themed `.mtkN`
// spans (no editor instance, no workers). Those token colors are theme-scoped,
// so we tag the <pre> with Monaco's theme class (vs / vs-dark) for the colors
// to resolve. Re-colorizes when the code or app theme changes.
//
// A small header tab shows the language and, when the fence opts in, action
// buttons (see TutorialPane's fence-flag parsing): `copy` adds a clipboard
// button, `exec` adds a Run button that loads the snippet into the policy
// editor on the right via onRun.
//
// On dangerouslySetInnerHTML: safe here on two counts. (1) The source is
// first-party tutorial markdown embedded into the Go binary at build time, not
// user input. (2) Monaco's colorizer HTML-escapes the snippet text before
// wrapping it in <span class="mtkN"> tokens - it never reflects raw markup from
// the input - so the only HTML in `html` is Monaco's own token spans.

import { useEffect, useRef, useState } from 'react';
import { colorizeCode, monacoThemeFor } from '../monacoSetup';

interface Props {
  code: string;
  lang: string;
  theme: 'light' | 'dark';
  copy?: boolean;
  exec?: boolean;
  onRun?: (code: string) => void;
}

export function CodeBlock({ code, lang, theme, copy, exec, onRun }: Props) {
  // Start with the raw text so the block is readable before colorize resolves
  // (and as the permanent fallback if Monaco can't tokenize the language).
  const [html, setHtml] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let alive = true;
    colorizeCode(code, lang, theme).then((out) => {
      if (alive) setHtml(out);
    });
    return () => {
      alive = false;
    };
  }, [code, lang, theme]);

  // Clear the pending "Copied!" reset if the block unmounts mid-flash.
  useEffect(() => () => {
    if (copiedTimer.current) clearTimeout(copiedTimer.current);
  }, []);

  function handleCopy() {
    void navigator.clipboard?.writeText(code).then(() => {
      setCopied(true);
      if (copiedTimer.current) clearTimeout(copiedTimer.current);
      copiedTimer.current = setTimeout(() => setCopied(false), 1200);
    });
  }

  return (
    <div className="code-block-wrap">
      <div className="code-block-head">
        <span className="code-block-lang">{lang || 'text'}</span>
        <div className="code-block-actions">
          {copy ? (
            <button
              type="button"
              className="code-block-btn"
              onClick={handleCopy}
              title="copy to clipboard"
            >
              {copied ? 'Copied!' : 'Copy'}
            </button>
          ) : null}
          {exec ? (
            <button
              type="button"
              className="code-block-btn code-block-run"
              onClick={() => onRun?.(code)}
              title="load into the policy editor"
            >
              ▶ Run
            </button>
          ) : null}
        </div>
      </div>
      <pre className={`code-block ${monacoThemeFor(theme)}`} data-lang={lang || undefined}>
        {html === null ? (
          <code>{code}</code>
        ) : (
          <code dangerouslySetInnerHTML={{ __html: html }} />
        )}
      </pre>
    </div>
  );
}
