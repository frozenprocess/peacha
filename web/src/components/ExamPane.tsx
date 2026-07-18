// Graded-exam track. Exams come from GET /v1/exams already sorted by meta.order;
// each is an Example (loadable starter scenario) plus a markdown prompt (`doc`).
// The learner takes them one at a time: the active exam's starter is loaded into
// the editor (via onSelect → loadExample), they edit policy, watch the live
// matrix/graph, then press "Check my answer" to grade server-side at
// POST /v1/exams/<name>/grade. On a pass, a "Next exam" button advances to the
// next still-unpassed exam - there's no picker and no prev/next, so passed exams
// drop out of the track and can't be revisited or skipped ahead of.
//
// The answer key never reaches the client - grading and the pass/fail verdict
// come back from the server. When login is configured the whole track is gated:
// an anonymous learner sees a sign-in page (a pass is only meaningful attached
// to an identity), and only after signing in do the exams themselves load.

import { useEffect, useRef, useState } from 'react';
import type { AuthConfig, Exam, GradeResult } from '../api';
import { getExamSolution, signInWithPopup } from '../api';
import { LessonDoc } from './LessonDoc';
import badgeImage from '../assets/badge.png';

// Sign-in button labels per OAuth backend (keys match server provider names).
const PROVIDER_LABELS: Record<string, string> = {
  slack: 'Take the exam using Slack',
  google: 'Sign in with Google',
  github: 'Sign in with GitHub',
};

interface Props {
  exams: Exam[];
  activeId: string | null;
  onSelect: (id: string) => void;
  theme: 'light' | 'dark';
  onRunCode: (code: string) => void;
  auth: AuthConfig;
  passed: Set<string>;
  // Admin-set (server's --exam-auto-advance, surfaced via AuthConfig): when true
  // (the default), passing an exam auto-advances to the next unpassed one after a
  // short beat; when false, the learner clicks "Next exam" instead. Read-only here
  // - it's deliberately not a learner-controllable toggle.
  autoAdvance: boolean;
  // Grade the current editor state against the active exam. Resolves with the
  // verdict; rejects with Error('login required') when the gate blocks it.
  onGrade: () => Promise<GradeResult>;
  // Re-fetch auth state after a successful popup sign-in (the full-page redirect
  // used to remount the app and reload this for free; the popup doesn't).
  onSignedIn: () => void;
}

// How long the verdict stays on screen before auto-advance fires - long enough
// to register the ✓, short enough not to feel stuck.
const AUTO_ADVANCE_MS = 1500;

export function ExamPane({
  exams,
  activeId,
  onSelect,
  theme,
  onRunCode,
  auth,
  passed,
  autoAdvance,
  onGrade,
  onSignedIn,
}: Props) {
  const [result, setResult] = useState<GradeResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  // Sign-in popup: which provider is mid-flow (disables its button) and the last
  // failure to echo under the buttons (restriction rejection, cancel, etc.).
  const [signingIn, setSigningIn] = useState('');
  const [loginErr, setLoginErr] = useState('');
  // The verdict box renders below the prompt + actions, so on a tall pane it can
  // land below the fold - the learner presses "Check my answer" and sees nothing
  // move. Scroll it into view once a fresh verdict arrives.
  const resultRef = useRef<HTMLDivElement | null>(null);

  function startLogin(provider: string) {
    setLoginErr('');
    setSigningIn(provider);
    signInWithPopup(provider)
      .then(() => onSignedIn())
      .catch((e: unknown) => {
        const msg = e instanceof Error ? e.message : String(e);
        // A user-initiated cancel isn't worth a scary message.
        if (msg !== 'sign in cancelled') setLoginErr(msg);
      })
      .finally(() => setSigningIn(''));
  }

  // A new verdict only makes sense for the exam it was graded against - clear it
  // when the learner switches exams.
  useEffect(() => {
    setResult(null);
    setErr('');
  }, [activeId]);

  // Bring the verdict into view whenever one appears (smooth so the motion is
  // legible). Guard on `result` so switching exams - which clears it - doesn't
  // scroll, and so the scroll fires on the render after the box has mounted.
  useEffect(() => {
    if (result) resultRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, [result]);

  // One-at-a-time flow: the learner works through the unpassed exams in order,
  // one by one. Passed exams drop out of the track entirely - there's
  // deliberately no picker and no prev/next, so they can't revisit a pass or
  // skip ahead. `remaining` is the still-unpassed set (the just-passed active
  // exam is already excluded once App records it). These are computed before the
  // early returns below so the auto-advance hook can run unconditionally.
  const remaining = exams.filter((e) => !passed.has(e.name));
  // The exam on screen: the active one (which, right after a pass, is no longer
  // in `remaining`), else the first unpassed one.
  const active = exams.find((e) => e.name === activeId) ?? remaining[0];
  // The exam to advance to once this one's passed: the first still-unpassed exam
  // that isn't the one on screen. Undefined when this was the last one.
  const next = remaining.find((e) => !active || e.name !== active.name);

  // Auto-advance: once the active exam is passed and the setting is on, move to
  // the next unpassed exam after a beat (long enough to register the ✓). The
  // last exam has no `next`, so it just shows the completion note; manual mode
  // shows a "Next exam →" button instead.
  useEffect(() => {
    if (!autoAdvance || !result?.passed || !next) return;
    const id = window.setTimeout(() => onSelect(next.name), AUTO_ADVANCE_MS);
    return () => window.clearTimeout(id);
    // onSelect is recreated each App render; capturing the current one is correct
    // and avoids the timer resetting on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoAdvance, result, next?.name]);

  const needLogin = auth.enabled && !auth.user;
  const providers = auth.providers ?? [];

  // Login gate: when login is configured but nobody's signed in, the whole
  // track is a sign-in page - the exams (and the answer-grading route) stay
  // out of reach until there's an identity to attach a pass to.
  if (needLogin) {
    return (
      <div className="tutorial exam exam-login-gate">
        <div className="exam-badge-container">
          <img
            src={badgeImage}
            alt="Credly badge"
            className="exam-login-badge"
          />
          <p className="exam-badge-teaser">This could be your badge</p>
        </div>
        <div className="exam-login-card">
          {providers.map((p) => {
            const wsUrl = auth.workspaceUrls?.[p];
            if (!wsUrl) return null;
            const name = p.charAt(0).toUpperCase() + p.slice(1);
            // Slack can't deep-link a logged-out user to a specific workspace, so
            // offer the workspace sign-in/join link as a prominent callout: once
            // they have a session there, the button above drops them straight in
            // (the team hint applies). Kept visually distinct from the primary
            // sign-in button so it's hard to miss but doesn't compete with it.
            return (
              <div key={p} className="exam-login-workspace">
                <span className="exam-login-workspace-title">First time here?</span>
                <span className="exam-login-workspace-text">
                  Signing in with {name} only works once you’re a member of the workspace.
                  Use the button below to join the {name} workspace, then come back up to sign in and start the exam.
                </span>
                <a
                  className="btn exam-login-workspace-btn"
                  href={wsUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Join or login to the {name} workspace ↗
                </a>
              </div>
            );
          })}
          <h2 className="exam-login-title">Take the exam, and claim your badge</h2>
          <p className="exam-login-body">
            Taking the exam is a great way to show off your skills and earn a shareable badge for your profile.
          </p>
          <div className="exam-login-providers">
            {providers.map((p) => (
              <button
                key={p}
                type="button"
                className={`btn oauth-btn ${p}-btn`}
                disabled={!!signingIn}
                onClick={() => startLogin(p)}
              >
                {signingIn === p ? 'Signing in…' : (PROVIDER_LABELS[p] ?? p)}
              </button>
            ))}
          </div>
          {loginErr && <p className="exam-login-error">{loginErr}</p>}
          <p className="exam-login-notice">
            When you sign in, we record an opaque account identifier from your login provider
            and which exams you passed, so we can issue your Credly badge.
            {auth.retentionDays ? ` These records are deleted automatically after ${auth.retentionDays} days.` : ''}
          </p>
          <p className="exam-login-notice">
            By signing in you agree to our{' '}
            <a href="/privacy" target="_blank" rel="noopener noreferrer">
              Privacy Policy
            </a>
            .
          </p>
        </div>
      </div>
    );
  }

  if (!exams.length) {
    return <p className="docs">No exams available.</p>;
  }

  // Nothing left to take: show the completion screen and nothing else. This
  // fires the instant the last exam is passed too (App records the pass, so
  // `remaining` empties on the same render) - the verdict box and prompt are
  // cleared away in favour of the single "all complete" card. On reload there's
  // no verdict either, so this is also what greets a finished learner.
  if (!remaining.length) {
    return (
      <div className="tutorial exam">
        <div className="exam-complete">
          <h2 className="exam-complete-title">✓ All exams complete</h2>
          <p>You&rsquo;ve passed every exam in the track. Nice work.</p>
        </div>
      </div>
    );
  }

  if (!active) {
    return <p className="docs">No exams available.</p>;
  }

  async function check() {
    setBusy(true);
    setErr('');
    try {
      setResult(await onGrade());
    } catch (e: any) {
      if (String(e?.message) === 'login required') {
        setErr('Please sign in with Slack to submit your answer.');
      } else {
        setErr(String(e?.message ?? e));
      }
    } finally {
      setBusy(false);
    }
  }

  // Load the reference solution into the editor. Dev-only: the button is hidden
  // unless auth is disabled, and the server's /solution route 404s when it's on -
  // so this can't reveal the answer on a real, login-gated deployment.
  async function showSolution() {
    setErr('');
    try {
      onRunCode(await getExamSolution(active.name));
    } catch (e: any) {
      setErr(`Couldn't load solution: ${String(e?.message ?? e)}`);
    }
  }

  return (
    <div className="tutorial exam">
      <div className="tutorial-meta">
        {active.track ? <span className="tutorial-track">{active.track}</span> : null}
        {passed.has(active.name) ? <span className="exam-passed-badge">✓ passed</span> : null}
        <span className="tutorial-count">
          {remaining.length} {remaining.length === 1 ? 'exam' : 'exams'} left
        </span>
      </div>
      <h2 className="exam-title">{active.title}</h2>

      <div className="docs">
        <LessonDoc doc={active.doc} assetBase={`/v1/exams/${active.dir}`} theme={theme} onRunCode={onRunCode} />
      </div>

      <div className="exam-actions">
        <button className="btn primary" onClick={check} disabled={busy}>
          {busy ? 'Checking…' : 'Check my answer'}
        </button>
        {/* Dev only (auth disabled): load the reference solution into the editor.
            Hidden on real deployments, where the route 404s anyway. */}
        {!auth.enabled ? (
          <button className="btn" onClick={showSolution} title="dev only - load the reference solution">
            Show solution
          </button>
        ) : null}
        {err ? <div className="exam-error">{err}</div> : null}
      </div>

      {result ? <GradeReport result={result} reportRef={resultRef} /> : null}

      {/* After a pass, the only way forward is on. With auto-advance on we move to
          the next unpassed exam after a short beat (effect above) and just note
          it here; with it off, an explicit "Next exam" button. There's no way
          back to the one just passed. Passing the *last* exam never reaches here -
          `remaining` empties and the completion screen returns early above - so
          `next` is always defined when this renders. */}
      {result?.passed && next ? (
        <div className="exam-advance">
          {autoAdvance ? (
            <p className="exam-advancing">Advancing to the next exam&hellip;</p>
          ) : (
            <button className="btn primary" onClick={() => onSelect(next.name)}>
              Next exam →
            </button>
          )}
        </div>
      ) : null}
    </div>
  );
}

function GradeReport({
  result,
  reportRef,
}: {
  result: GradeResult;
  reportRef: React.Ref<HTMLDivElement>;
}) {
  return (
    <div ref={reportRef} className={`exam-result ${result.passed ? 'pass' : 'fail'}`}>
      <div className="exam-verdict">
        {result.passed ? '✓ Passed' : '✗ Not yet'}
        {result.passed && result.recorded ? <span className="exam-recorded"> - recorded</span> : null}
      </div>
      {result.errors?.length ? (
        <div className="exam-error">
          Policy didn't evaluate:
          {result.errors.map((e, i) => (
            <div key={i}>• {e}</div>
          ))}
        </div>
      ) : null}
      <ul className="exam-checks">
        {result.checks.map((c, i) => (
          <li key={i} className={c.passed ? 'ok' : 'bad'}>
            <span className="exam-check-mark">{c.passed ? '✓' : '✗'}</span>
            <span className="exam-check-desc">
              {c.description}
              {!c.passed && c.detail ? <span className="exam-check-detail"> - {c.detail}</span> : null}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
