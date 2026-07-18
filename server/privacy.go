package server

import "net/http"

// PrivacyHandler serves the static privacy notice at GET /privacy. It documents
// exactly what the exam feature stores (an opaque provider subject id plus which
// exams were passed and when - no name, email, IP, or browsing activity), why,
// how long, and how to exercise GDPR access/erasure rights. main() mounts it on
// the root mux ABOVE the SPA fallback so /privacy resolves here rather than to
// the SPA shell (which is what the sign-in notice's "Privacy Policy" link
// targets). It deliberately has no dependencies on request state - the same
// notice is correct for every visitor.
func PrivacyHandler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Header().Set("Cache-Control", "no-cache")
		_, _ = w.Write([]byte(privacyHTML))
	})
}

const privacyHTML = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Peacha - Privacy Notice</title>
<style>
  body{font-family:system-ui,sans-serif;margin:3rem auto;max-width:46rem;padding:0 1.25rem;line-height:1.6;color:#1c1c1c}
  h1{font-size:1.6rem} h2{font-size:1.15rem;margin-top:2rem}
  code{background:#f3f3f3;padding:0.1em 0.35em;border-radius:3px;font-size:0.9em}
  ul{padding-left:1.25rem} li{margin:0.3rem 0}
  .muted{color:#666;font-size:0.9rem}
  @media (prefers-color-scheme: dark){
    body{background:#16181d;color:#e6e6e6} code{background:#2a2d34}
    .muted{color:#9aa0aa}
  }
</style>
</head><body>
<h1>Peacha - Privacy Notice</h1>
<p>This notice covers the personal data Peacha processes for two features: its
graded <strong>exam</strong> feature, and the optional <strong>feedback</strong>
on some tutorial pages. The rest of the tool (the policy editor, the tutorials
themselves, and the connectivity matrix) runs entirely in your browser against a
stateless API and stores nothing about you.</p>

<h2>What we collect, and what we do not</h2>
<p>Exams are gated behind a sign-in with Slack, Google, or GitHub. When you sign
in and <strong>pass</strong> an exam, we store a single record containing:</p>
<ul>
  <li>an <strong>opaque account identifier</strong> from your login provider
      (e.g. <code>github:1234567</code> or <code>slack:U…</code>);</li>
  <li>which login provider it came from (Slack / Google / GitHub);</li>
  <li>which exam you passed, and the date and time you passed it.</li>
</ul>
<p>We deliberately do <strong>not</strong> request, receive, or store your name,
email address, profile picture, IP address, or any browsing activity. The
sign-in requests the minimum OAuth scope needed to confirm the opaque identifier
and your membership of the permitted workspace/organisation - nothing more.</p>

<h2>Tutorial feedback</h2>
<p>A few tutorial pages show a short feedback widget. Submitting it is entirely
optional and does <strong>not</strong> require signing in. We store which page
the feedback was for, your thumbs up/down, the date and time, and any comment
you type. By default that record carries <strong>no identity</strong> at all.</p>
<p>Two things change only if <em>you choose</em> them: if you happen to be signed
in (for exams), your opaque account identifier is attached so we can follow up;
and if you tick <strong>&ldquo;you may quote me&rdquo;</strong> and fill in your
name/organisation, we store those so we can attribute the quote. We use a
consented comment as a public testimonial only on the basis of that consent,
which you can withdraw at any time (see <em>Your rights</em> below). We never
store your email address, IP address, or browsing activity.</p>

<h2>Why we process it (legal basis)</h2>
<p>We record passes so we can issue you a completion badge and so the exam track
can show which exams you have already cleared. The opaque identifier is resolved
to a real person only out of band, by the workshop organisers using their own
Slack/GitHub administrative access, at the moment a badge is issued - that
mapping is never stored by Peacha. The legal basis is our legitimate interest in
operating the training and issuing the badge you asked for.</p>

<h2>How long we keep it</h2>
<p>Pass records and feedback submissions are both deleted automatically once they
pass the configured retention window (by default <strong>30 days</strong>); the
exact value for this deployment is shown on the sign-in screen. After that, the
record is removed from the database.</p>

<h2>Who it is shared with</h2>
<p>Signing in sends you to your chosen provider (Slack, Google, or GitHub),
whose own privacy policy governs that step. We do not sell or share your pass
records with any third party; they live only in this deployment's database.</p>

<h2>Your rights</h2>
<p>You can ask us to confirm what we hold about you and to erase it (GDPR
Articles 15 and 17). Because everything is keyed on the opaque identifier,
erasure is immediate and complete - the operator runs
<code>editor --forget-sub &lt;your-id&gt;</code>, which deletes every pass record
<em>and every signed-in or consented feedback submission</em> for that
identifier. (Feedback you left while not signed in and without giving your name
carries no identity, so there is nothing to trace back or erase.) To make a
request, contact the workshop organiser who gave you this link.</p>

<p class="muted">This notice describes the data handling built into the Peacha
software. The organisation running this particular deployment is the data
controller and may supplement it.</p>
</body></html>
`
