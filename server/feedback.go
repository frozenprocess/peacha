package server

import (
	"database/sql"
	"encoding/csv"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"time"
	"unicode/utf8"
)

// Field caps on free-text feedback - generous enough for a real testimony, small
// enough that a single POST can't wedge the DB or the CSV export.
const (
	maxFeedbackComment = 4000
	maxFeedbackName    = 200
	maxFeedbackOrg     = 200
)

// FeedbackRecord is one tutorial-feedback submission: a quick rating plus an
// optional quotable testimony, captured on a tutorial page that opted in
// (meta.json "feedback": true). It is the GA-graduation evidence trail for the
// ClusterNetworkPolicy track.
//
// Privacy posture (mirrors PassRecord in results.go): the anonymous path stores
// NO personal data - just the page, a thumbs up/down, and maybe a comment. A
// name/org is stored ONLY when the reader explicitly ticked "you may quote me"
// (Consent), processed on the legal basis of consent. Sub/Provider are attached
// from the session cookie when the reader happens to be signed in (the same
// opaque, provider-namespaced id used for exam passes - e.g. "github:123"); they
// are absent for anonymous submissions. Either way a submission is erasable via
// the --forget-sub tool (when it carries a sub) and ages out under the shared
// retention window (Results.purgeExpired).
type FeedbackRecord struct {
	ID       int64  `json:"id,omitempty"`
	Time     string `json:"time"`               // RFC3339, stamped at record time
	Tutorial string `json:"tutorial"`           // tutorial slug (meta.json name)
	Rating   string `json:"rating"`             // "up" | "down"
	Comment  string `json:"comment,omitempty"`  // optional free-text testimony
	Consent  bool   `json:"consent"`            // reader allowed the comment + name/org to be quoted
	Name     string `json:"name,omitempty"`     // only with consent
	Org      string `json:"org,omitempty"`      // only with consent
	Sub      string `json:"sub,omitempty"`      // signed-in subject, if any
	Provider string `json:"provider,omitempty"` // slack | google | github, if signed in
}

// recordFeedback inserts one submission. Unlike record() (exam passes) there is
// no upsert/dedup - each submission is its own row. Returns an error when
// persistence is disabled so the caller can leave Recorded=false, matching the
// grader's contract.
func (r *Results) recordFeedback(rec FeedbackRecord) error {
	if r.db == nil {
		return errors.New("no results store configured")
	}
	rec.Time = time.Now().UTC().Format(time.RFC3339)
	consent := 0
	if rec.Consent {
		consent = 1
	}
	_, err := r.db.Exec(r.q(`
		INSERT INTO feedback (tutorial, rating, comment, consent, name, org, sub, provider, created_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?);`),
		rec.Tutorial, rec.Rating, rec.Comment, consent, rec.Name, rec.Org, rec.Sub, rec.Provider, rec.Time)
	if err == nil {
		// Keep the retention window enforced as feedback arrives (compliance must
		// not depend on a restart). Best-effort: a failed sweep mustn't fail the
		// (successful) insert.
		_, _ = r.purgeExpired()
	}
	return err
}

// listFeedback returns every stored submission, newest first, for the admin
// export. A disabled store returns nothing.
func (r *Results) listFeedback() ([]FeedbackRecord, error) {
	if r.db == nil {
		return nil, nil
	}
	rows, err := r.db.Query(`
		SELECT id, tutorial, rating, comment, consent, name, org, sub, provider, created_at
		FROM feedback ORDER BY created_at DESC, id DESC;`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []FeedbackRecord
	for rows.Next() {
		var (
			rec     FeedbackRecord
			consent int
			comment, name, org, sub, provider sql.NullString
		)
		if err := rows.Scan(&rec.ID, &rec.Tutorial, &rec.Rating, &comment, &consent,
			&name, &org, &sub, &provider, &rec.Time); err != nil {
			return nil, err
		}
		rec.Comment, rec.Name, rec.Org = comment.String, name.String, org.String
		rec.Sub, rec.Provider = sub.String, provider.String
		rec.Consent = consent != 0
		out = append(out, rec)
	}
	return out, rows.Err()
}

// feedbackSubmission is the wire-shape posted to POST /v1/tutorials/{name}/feedback.
// The tutorial slug comes from the path, and identity (sub/provider) is taken
// from the session cookie server-side - never trusted from the body - so the
// client sends only the reader-entered fields.
type feedbackSubmission struct {
	Rating  string `json:"rating"`
	Comment string `json:"comment"`
	Consent bool   `json:"consent"`
	Name    string `json:"name"`
	Org     string `json:"org"`
}

// submitFeedback records one tutorial-feedback submission. Registered as
// POST /v1/tutorials/{name}/feedback.
//
// Ungated by design (tutorials are read-along, no login): anyone can submit. If
// the reader happens to be signed in, their opaque sub/provider is attached for
// attribution; otherwise the submission is anonymous. The page must have opted
// in (meta.json "feedback": true) - a submission against a non-opted page is
// refused so the widget can't be driven where it isn't shown.
func (h *Handler) submitFeedback(w http.ResponseWriter, r *http.Request) {
	name := r.PathValue("name")
	t := h.tutorialByName(name)
	if t == nil {
		http.Error(w, "no such tutorial", http.StatusNotFound)
		return
	}
	if !t.Feedback {
		http.Error(w, "feedback not enabled for this tutorial", http.StatusForbidden)
		return
	}

	var sub feedbackSubmission
	if !decodeJSON(w, r, &sub) {
		return
	}
	rating := strings.ToLower(strings.TrimSpace(sub.Rating))
	if rating != "up" && rating != "down" {
		writeJSONStatus(w, http.StatusBadRequest, map[string]string{"error": "rating must be 'up' or 'down'"})
		return
	}

	rec := FeedbackRecord{
		Tutorial: t.Name,
		Rating:   rating,
		Comment:  clip(strings.TrimSpace(sub.Comment), maxFeedbackComment),
		Consent:  sub.Consent,
	}
	// Name/org are only meaningful as an attributable quote - keep them only when
	// the reader consented, so an un-consented row can never carry identifying text.
	if sub.Consent {
		rec.Name = clip(strings.TrimSpace(sub.Name), maxFeedbackName)
		rec.Org = clip(strings.TrimSpace(sub.Org), maxFeedbackOrg)
	}
	// Attach the signed-in identity if there is a session; anonymous otherwise.
	if u, _ := h.auth.user(r); u != nil {
		rec.Sub = u.Sub
		rec.Provider = u.Provider
	}

	recorded := h.results.recordFeedback(rec) == nil
	writeJSON(w, map[string]bool{"recorded": recorded})
}

// writeFeedbackCSV writes the records as CSV with a fixed header row. Used by the
// --dump-feedback CLI (DumpFeedback).
func writeFeedbackCSV(w io.Writer, recs []FeedbackRecord) error {
	cw := csv.NewWriter(w)
	_ = cw.Write([]string{"time", "tutorial", "rating", "consent", "name", "org", "provider", "sub", "comment"})
	for _, r := range recs {
		consent := "false"
		if r.Consent {
			consent = "true"
		}
		_ = cw.Write([]string{r.Time, r.Tutorial, r.Rating, consent, r.Name, r.Org, r.Provider, r.Sub, r.Comment})
	}
	cw.Flush()
	return cw.Error()
}

// clip truncates s to at most n bytes (on a rune boundary), defending the store
// and exports against an oversized submission.
func clip(s string, n int) string {
	if len(s) <= n {
		return s
	}
	// Back up to a rune boundary so we never split a multibyte char.
	for n > 0 && !utf8.RuneStart(s[n]) {
		n--
	}
	return s[:n]
}

// DumpFeedback opens the store at dsn (file path or postgres:// URL), reads
// every submission, and returns it serialised as JSON ("" or "json") or CSV
// ("csv"). It's the entrypoint behind the editor's `--dump-feedback` flag -
// an offline export that needs no server and no auth config, mirroring
// ForgetSubject. Kept here so the store internals stay unexported.
func DumpFeedback(dsn, format string) (string, error) {
	r := newResults(dsn, 0)
	if r.db == nil {
		return "", errors.New("no results store at " + dsn)
	}
	defer r.db.Close()
	recs, err := r.listFeedback()
	if err != nil {
		return "", err
	}
	if format == "csv" {
		var b strings.Builder
		if err := writeFeedbackCSV(&b, recs); err != nil {
			return "", err
		}
		return b.String(), nil
	}
	if recs == nil {
		recs = []FeedbackRecord{}
	}
	out, err := json.MarshalIndent(recs, "", "  ")
	if err != nil {
		return "", err
	}
	return string(out), nil
}
