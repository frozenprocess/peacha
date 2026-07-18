// Inline knowledge-check quiz, rendered in place of a ```quiz fenced block in a
// lesson body (see LessonDoc's code renderer). A lesson can carry one or two of
// these between prose sections; each is fully self-contained and graded in the
// browser - the answer key lives right in the fence, so there is no server call
// and no anti-cheat (these are formative checks, not the graded exams).
//
// Fence payload is JSON: a single question object or an array of them.
//
//   ```quiz
//   {
//     "question": "Which tier is evaluated first?",
//     "options": ["Application", "Admin", "Baseline"],
//     "answer": 1,
//     "explain": "The Admin tier is highest-priority, so it runs before the rest."
//   }
//   ```
//
// `answer` is a single option index (radio, pick one) or an array of indices
// (checkboxes, pick all). `explain` is optional and shown after checking.

import { useState } from 'react';

interface Question {
  question: string;
  options: string[];
  answer: number | number[];
  explain?: string;
}

// Normalize an answer (number | number[]) to a Set of indices for comparison,
// and remember whether it was authored as multi-select.
function answerSet(answer: number | number[]): Set<number> {
  return new Set(Array.isArray(answer) ? answer : [answer]);
}

function sameSet(a: Set<number>, b: Set<number>): boolean {
  return a.size === b.size && [...a].every((x) => b.has(x));
}

function QuizQuestion({ q }: { q: Question }) {
  const multiple = Array.isArray(q.answer);
  const correct = answerSet(q.answer);
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [checked, setChecked] = useState(false);

  function toggle(i: number) {
    if (checked) return; // locked once checked; use Try again to reset
    setPicked((prev) => {
      if (!multiple) return new Set([i]);
      const next = new Set(prev);
      next.has(i) ? next.delete(i) : next.add(i);
      return next;
    });
  }

  const isCorrect = checked && sameSet(picked, correct);

  return (
    <div className="quiz-question">
      <p className="quiz-prompt">{q.question}</p>
      <ul className="quiz-options">
        {q.options.map((opt, i) => {
          // After checking, mark each option: the right answers and any wrong
          // pick the learner made.
          let state = '';
          if (checked) {
            if (correct.has(i)) state = ' quiz-opt-correct';
            else if (picked.has(i)) state = ' quiz-opt-wrong';
          }
          return (
            <li key={i}>
              <label className={`quiz-option${state}`}>
                <input
                  type={multiple ? 'checkbox' : 'radio'}
                  checked={picked.has(i)}
                  disabled={checked}
                  onChange={() => toggle(i)}
                />
                <span>{opt}</span>
              </label>
            </li>
          );
        })}
      </ul>

      {checked ? (
        <div className={`quiz-result ${isCorrect ? 'quiz-correct' : 'quiz-wrong'}`}>
          <span className="quiz-verdict">{isCorrect ? '✓ Correct' : '✗ Not quite'}</span>
          {q.explain ? <span className="quiz-explain">{q.explain}</span> : null}
          <button type="button" className="quiz-retry" onClick={() => { setChecked(false); setPicked(new Set()); }}>
            Try again
          </button>
        </div>
      ) : (
        <button
          type="button"
          className="quiz-check"
          disabled={picked.size === 0}
          onClick={() => setChecked(true)}
        >
          Check answer
        </button>
      )}
    </div>
  );
}

// Parse the fence payload into one or more questions. Returns null on anything
// malformed so the caller can fall back to showing the raw block.
function parseQuiz(raw: string): Question[] | null {
  try {
    const data = JSON.parse(raw);
    const list = Array.isArray(data) ? data : [data];
    for (const q of list) {
      if (
        !q ||
        typeof q.question !== 'string' ||
        !Array.isArray(q.options) ||
        (typeof q.answer !== 'number' && !Array.isArray(q.answer))
      ) {
        return null;
      }
    }
    return list as Question[];
  } catch {
    return null;
  }
}

export function QuizBlock({ raw }: { raw: string }) {
  const questions = parseQuiz(raw);
  if (!questions) {
    // Malformed payload: surface it as a plain block so the author sees what
    // they wrote rather than a silently-empty lesson.
    return (
      <pre className="quiz-error">
        <code>{raw}</code>
      </pre>
    );
  }
  return (
    <div className="quiz">
      {questions.map((q, i) => (
        <QuizQuestion key={i} q={q} />
      ))}
    </div>
  );
}
