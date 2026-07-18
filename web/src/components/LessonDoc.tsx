// Shared markdown renderer for read-along lesson bodies - used by both the
// tutorial track (TutorialPane) and the exam prompts (ExamPane). It renders
// GitHub-flavored markdown with two extensions:
//
//   - Fenced code blocks become Monaco-highlighted CodeBlocks. A fence can carry
//     action flags after the language (```yaml copy exec): `copy` adds a copy
//     button, `exec`/`run` adds a ▶ button that loads the block into the editor.
//   - Images referenced relative to the lesson folder (`![](01.editor.png)`) are
//     rewritten to the Go asset route `<assetBase>/<file>` so the embedded file
//     is served. Absolute/remote srcs pass through untouched.
//
// assetBase is the per-lesson route prefix, e.g. `/v1/tutorials/<dir>` or
// `/v1/exams/<dir>`.

import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { CodeBlock } from './CodeBlock';
import { QuizBlock } from './QuizBlock';

interface Props {
  doc: string;
  assetBase: string;
  theme: 'light' | 'dark';
  onRunCode: (code: string) => void;
}

// Action flags a fence can carry after the language, e.g. ```yaml copy exec
// (space- or comma-separated). `run` is accepted as an alias for `exec`.
const FENCE_FLAGS = new Set(['copy', 'exec', 'run']);

// remark-rehype drops a fenced block's `meta` string (everything after the
// language), so the only way to surface `copy`/`exec` to the renderer is to
// rewrite the mdast `code` node before the hast conversion. We fold the real
// language and any flags into the <code> element's class list - className
// survives the conversion untouched, unlike data-* attributes - as
// `language-<lang>` plus `cb-<flag>` tokens, which the code component parses.
function remarkFenceFlags() {
  return (tree: { children?: unknown[] }) => walk(tree);

  function walk(node: unknown) {
    if (!node || typeof node !== 'object') return;
    const n = node as {
      type?: string;
      lang?: string | null;
      meta?: string | null;
      data?: { hProperties?: Record<string, unknown> };
      children?: unknown[];
    };
    if (n.type === 'code') {
      const tokens = `${n.lang ?? ''} ${n.meta ?? ''}`.split(/[\s,]+/).filter(Boolean);
      const classes: string[] = [];
      let lang = '';
      for (const t of tokens) {
        const low = t.toLowerCase();
        if (FENCE_FLAGS.has(low)) classes.push(`cb-${low === 'run' ? 'exec' : low}`);
        else if (!lang) lang = t;
      }
      if (lang) classes.unshift(`language-${lang}`);
      n.lang = null; // we own the class list now
      n.data = n.data || {};
      n.data.hProperties = { ...(n.data.hProperties || {}), className: classes };
    }
    if (Array.isArray(n.children)) for (const c of n.children) walk(c);
  }
}

export function LessonDoc({ doc, assetBase, theme, onRunCode }: Props) {
  return (
    <Markdown
      remarkPlugins={[remarkGfm, remarkFenceFlags]}
      components={{
        img: ({ src = '', alt, title }) => {
          const resolved = /^(https?:)?\/\//.test(src)
            ? src
            : `${assetBase}/${src.replace(/^\.?\//, '')}`;
          return <img src={resolved} alt={alt} title={title} />;
        },
        // Fenced blocks become a Monaco-highlighted CodeBlock; inline code
        // (no class, single line) keeps the default `.docs code` pill. `pre`
        // is unwrapped because CodeBlock supplies its own <pre>. The class
        // list carries the language (language-x) and fence flags (cb-copy,
        // cb-exec) folded in by remarkFenceFlags.
        pre: ({ children }) => <>{children}</>,
        code: ({ className, children, ...rest }) => {
          const cls = className || '';
          const text = String(children ?? '');
          const lang = /language-(\w+)/.exec(cls)?.[1] ?? '';
          const flags = (cls.match(/cb-(\w+)/g) || []).map((s) => s.slice(3));
          // A ```quiz fence is an inline knowledge check, not source to display.
          if (lang === 'quiz') {
            return <QuizBlock raw={text.replace(/\n$/, '')} />;
          }
          const isBlock = !!lang || flags.length > 0 || text.includes('\n');
          if (isBlock) {
            return (
              <CodeBlock
                code={text.replace(/\n$/, '')}
                lang={lang}
                theme={theme}
                copy={flags.includes('copy')}
                exec={flags.includes('exec')}
                onRun={onRunCode}
              />
            );
          }
          return (
            <code className={className} {...rest}>
              {children}
            </code>
          );
        },
      }}
    >
      {doc}
    </Markdown>
  );
}
