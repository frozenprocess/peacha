// Read-along feedback widget, shown beneath a tutorial lesson when the page has
// opted in (meta.json "feedback": true, surfaced as Tutorial.feedback). It
// gathers a quick rating plus an optional quotable testimony - the evidence
// trail for graduating the ClusterNetworkPolicy track to GA.
//
// Flow: pick 👍/👎 -> the detail form expands (optional comment, a "you may
// quote me" consent checkbox, and - only once consent is ticked - name/org) ->
// Send. Identity is attached server-side from the session cookie, so this sends
// only what the reader typed. A successful (or previously-sent) submission is
// remembered in localStorage per tutorial slug so a returning reader sees a
// collapsed "thanks" state instead of being re-prompted.

import { useState } from 'react';
import { submitTutorialFeedback } from '../api';

interface Props {
  tutorialName: string;
}

type Rating = 'up' | 'down';

// localStorage key marking a slug as already-submitted (any value = done).
const sentKey = (slug: string) => `peacha-feedback-sent:${slug}`;

export function FeedbackWidget({ tutorialName }: Props) {
  const [rating, setRating] = useState<Rating | null>(null);
  const [comment, setComment] = useState('');
  const [consent, setConsent] = useState(false);
  const [name, setName] = useState('');
  const [org, setOrg] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  // Start in the "done" state if this reader already submitted for this slug.
  const [done, setDone] = useState(() => {
    try {
      return localStorage.getItem(sentKey(tutorialName)) != null;
    } catch {
      return false;
    }
  });

  if (done) {
    return (
      <div className="tutorial-feedback tutorial-feedback-done">
        <span>✓ Thanks for your feedback!</span>
      </div>
    );
  }

  function pick(r: Rating) {
    setRating(r);
    setError('');
  }

  async function send() {
    if (!rating) return;
    setSending(true);
    setError('');
    try {
      await submitTutorialFeedback(tutorialName, {
        rating,
        comment: comment.trim() || undefined,
        consent,
        name: consent ? name.trim() || undefined : undefined,
        org: consent ? org.trim() || undefined : undefined,
      });
      try {
        localStorage.setItem(sentKey(tutorialName), '1');
      } catch {
        // localStorage may be unavailable (private mode); the thank-you still shows.
      }
      setDone(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'could not send feedback');
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="tutorial-feedback">
      <div className="tutorial-feedback-prompt">
        <span>Did this help you understand ClusterNetworkPolicy?</span>
        <div className="tutorial-feedback-rate">
          <button
            type="button"
            className={rating === 'up' ? 'fb-rate active' : 'fb-rate'}
            aria-pressed={rating === 'up'}
            aria-label="yes, this helped"
            onClick={() => pick('up')}
          >
            👍
          </button>
          <button
            type="button"
            className={rating === 'down' ? 'fb-rate active' : 'fb-rate'}
            aria-pressed={rating === 'down'}
            aria-label="no, this did not help"
            onClick={() => pick('down')}
          >
            👎
          </button>
        </div>
      </div>

      {rating ? (
        <div className="tutorial-feedback-detail">
          <textarea
            className="tutorial-feedback-comment"
            placeholder="Would you use ClusterNetworkPolicy in production? What worked, what's missing? (optional)"
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            rows={3}
          />
          <label className="tutorial-feedback-consent">
            <input
              type="checkbox"
              checked={consent}
              onChange={(e) => setConsent(e.target.checked)}
            />
            <span>You may quote my comment publicly (e.g. on the docs or release notes).</span>
          </label>
          {consent ? (
            <div className="tutorial-feedback-attrib">
              <input
                type="text"
                placeholder="Name (optional)"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
              <input
                type="text"
                placeholder="Organisation (optional)"
                value={org}
                onChange={(e) => setOrg(e.target.value)}
              />
            </div>
          ) : null}
          {error ? <p className="tutorial-feedback-error">{error}</p> : null}
          <button
            type="button"
            className="tutorial-feedback-send"
            disabled={sending}
            onClick={send}
          >
            {sending ? 'Sending…' : 'Send feedback'}
          </button>
        </div>
      ) : null}
    </div>
  );
}
