package server

import (
	"database/sql"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"

	_ "github.com/lib/pq"   // PostgreSQL driver (postgres:// DSN)
	_ "modernc.org/sqlite"  // pure-Go SQLite driver (CGO-free; build stays static)
)

// PassRecord is one graded pass: who passed which exam, when. Persisted in the
// SQLite `passes` table keyed by (sub, exam) so a re-pass updates the row in
// place rather than appending duplicate history.
//
// We deliberately store NO direct PII (no name, no email) - only `sub`, the
// provider-namespaced subject (e.g. "github:123", "slack:U…"), which is the
// stable identity key. Because login is gated to a GitHub org / Slack workspace
// we administer, a `sub` is resolved back to a real person OUT OF BAND at
// badge-issuing time via that admin access, not from anything kept here. This is
// GDPR data-minimisation: the app's persistent store holds an opaque id, not an
// identity. ExamTitle is denormalised for readable reporting and is not PII.
//
// Even so, a `sub` + timestamp is re-identifiable by design, so it's pseudonymous
// PERSONAL data under the GDPR, not anonymous: the storage-limitation and
// erasure obligations still apply. They're met by Results.purgeExpired (a
// configurable retention window, see newResults) and Results.forget (Art. 17
// right-to-erasure, driven by the editor's --forget-sub CLI tool).
type PassRecord struct {
	Time      string `json:"time"`               // RFC3339, stamped at record time
	Sub       string `json:"sub"`                // provider-namespaced subject (stable per user)
	Provider  string `json:"provider,omitempty"` // slack | google | github
	Exam      string `json:"exam"`
	ExamTitle string `json:"examTitle"`
}

// Results is the exam-pass store, backed by SQLite (local dev) or PostgreSQL
// (production). A nil db disables persistence: record() reports an error so
// the grader leaves Recorded=false, and passedBy() returns nothing.
type Results struct {
	db        *sql.DB
	pg        bool          // true when connected to PostgreSQL (affects DDL and placeholders)
	retention time.Duration // how long a pass / feedback row is kept; 0 = forever
}

// q rebinds a query's ? placeholders to $1, $2, ... when connected to
// PostgreSQL; returns the query unchanged for SQLite.
func (r *Results) q(query string) string {
	if !r.pg {
		return query
	}
	return rebindQuery(query)
}

// rebindQuery converts ? placeholders to $1, $2, ... for PostgreSQL.
func rebindQuery(query string) string {
	n := 0
	var b strings.Builder
	for i := 0; i < len(query); i++ {
		if query[i] == '?' {
			n++
			b.WriteByte('$')
			b.WriteString(strconv.Itoa(n))
		} else {
			b.WriteByte(query[i])
		}
	}
	return b.String()
}

// newResults opens (creating if absent) the store at dsn and ensures the
// schema. dsn is either a SQLite file path or a postgres:// URL. An empty dsn
// disables persistence. An open/migrate error returns a disabled store - we
// never make a bad DB fatal, matching the rest of the handler's best-effort
// startup.
//
// retentionDays bounds how long a pass is kept (GDPR storage-limitation): >0
// deletes rows older than that on startup and after each write; 0 keeps them
// indefinitely. The window is enforced inline (purgeExpired) rather than by a
// scheduler - fine at workshop scale and one fewer moving part.
func newResults(dsn string, retentionDays int) *Results {
	if dsn == "" {
		return &Results{}
	}
	pg := strings.HasPrefix(dsn, "postgres://") || strings.HasPrefix(dsn, "postgresql://")
	var db *sql.DB
	var err error
	if pg {
		db, err = sql.Open("postgres", dsn)
	} else {
		// WAL + busy timeout so concurrent goroutines don't trip over "database is
		// locked". Single open conn serialises writes - more than enough at workshop
		// scale and the simplest way to avoid writer contention.
		sqliteDSN := "file:" + dsn + "?_pragma=journal_mode(WAL)&_pragma=busy_timeout(5000)&_pragma=foreign_keys(on)"
		db, err = sql.Open("sqlite", sqliteDSN)
		db.SetMaxOpenConns(1)
	}
	if err != nil {
		return &Results{}
	}

	r := &Results{db: db, pg: pg}

	// passes: (sub, exam) primary key ensures a re-pass updates the row, not appends.
	passesDDL := `CREATE TABLE IF NOT EXISTS passes (
		sub        TEXT NOT NULL,
		exam       TEXT NOT NULL,
		provider   TEXT,
		exam_title TEXT,
		passed_at  TEXT NOT NULL,
		PRIMARY KEY (sub, exam)
	);`
	// feedback: every submission is its own row (no dedup). autoincrement id
	// syntax differs between SQLite and PostgreSQL.
	var feedbackDDL string
	if pg {
		feedbackDDL = `CREATE TABLE IF NOT EXISTS feedback (
			id         BIGSERIAL PRIMARY KEY,
			tutorial   TEXT NOT NULL,
			rating     TEXT NOT NULL,
			comment    TEXT,
			consent    INTEGER NOT NULL DEFAULT 0,
			name       TEXT,
			org        TEXT,
			sub        TEXT,
			provider   TEXT,
			created_at TEXT NOT NULL
		);`
	} else {
		feedbackDDL = `CREATE TABLE IF NOT EXISTS feedback (
			id         INTEGER PRIMARY KEY AUTOINCREMENT,
			tutorial   TEXT NOT NULL,
			rating     TEXT NOT NULL,
			comment    TEXT,
			consent    INTEGER NOT NULL DEFAULT 0,
			name       TEXT,
			org        TEXT,
			sub        TEXT,
			provider   TEXT,
			created_at TEXT NOT NULL
		);`
	}
	for _, ddl := range []string{
		passesDDL,
		feedbackDDL,
		`CREATE INDEX IF NOT EXISTS idx_passes_passed_at ON passes(passed_at);`,
		`CREATE INDEX IF NOT EXISTS idx_feedback_created_at ON feedback(created_at);`,
	} {
		if _, err := db.Exec(ddl); err != nil {
			_ = db.Close()
			return &Results{}
		}
	}

	if retentionDays > 0 {
		r.retention = time.Duration(retentionDays) * 24 * time.Hour
	}
	_, _ = r.purgeExpired() // drop anything already past the window at startup
	return r
}

// retentionDays reports the configured retention window in whole days (0 when
// persistence is disabled or records are kept forever). The SPA surfaces it in
// the sign-in privacy notice so the stated retention always matches reality.
func (r *Results) retentionDays() int {
	if r.retention <= 0 {
		return 0
	}
	return int(r.retention / (24 * time.Hour))
}

// purgeExpired deletes pass records older than the retention window - the GDPR
// storage-limitation primitive (Art. 5(1)(e)). A disabled store or a zero
// retention is a no-op. Returns the number of rows deleted.
func (r *Results) purgeExpired() (int64, error) {
	if r.db == nil || r.retention <= 0 {
		return 0, nil
	}
	// passed_at / created_at are always RFC3339 UTC (trailing "Z"), so a lexical
	// "<" compare is a correct chronological compare.
	cutoff := time.Now().Add(-r.retention).UTC().Format(time.RFC3339)
	res, err := r.db.Exec(r.q(`DELETE FROM passes WHERE passed_at < ?;`), cutoff)
	if err != nil {
		return 0, err
	}
	n, _ := res.RowsAffected()
	// Feedback ages out under the same window (storage-limitation, uniform with
	// passes). Consented testimonies are GA evidence, so admins should export them
	// before they expire, or widen --results-retention-days. Best-effort: a feedback
	// purge error doesn't undo the (successful) passes purge above.
	if fres, ferr := r.db.Exec(r.q(`DELETE FROM feedback WHERE created_at < ?;`), cutoff); ferr == nil {
		fn, _ := fres.RowsAffected()
		n += fn
	}
	return n, nil
}

// forget erases every stored pass for one subject id - the GDPR right-to-erasure
// primitive (Art. 17), exposed operationally via the editor's --forget-sub tool
// (see ForgetSubject). Returns the number of rows deleted. A disabled store
// errors; an empty sub is a no-op (so a typo can't wipe the table).
func (r *Results) forget(sub string) (int64, error) {
	if r.db == nil {
		return 0, errors.New("no results store configured")
	}
	if sub == "" {
		return 0, nil
	}
	res, err := r.db.Exec(r.q(`DELETE FROM passes WHERE sub = ?;`), sub)
	if err != nil {
		return 0, err
	}
	n, _ := res.RowsAffected()
	// Erase any consented testimonies the same subject left too - a single
	// right-to-erasure request must clear every store keyed to them. Anonymous
	// feedback (sub IS NULL/"") is untouched: it isn't personal data and isn't
	// attributable to anyone to erase.
	fres, ferr := r.db.Exec(r.q(`DELETE FROM feedback WHERE sub = ?;`), sub)
	if ferr != nil {
		return n, ferr
	}
	fn, _ := fres.RowsAffected()
	return n + fn, nil
}

// ForgetSubject opens the pass store at dsn (file path or postgres:// URL),
// erases every record for sub, and closes it again. It's the entrypoint behind
// the editor's `--forget-sub` flag (GDPR Art. 17 erasure tooling), kept here
// so newResults/forget stay unexported. Returns the number of rows deleted.
func ForgetSubject(dsn, sub string) (int64, error) {
	r := newResults(dsn, 0)
	if r.db == nil {
		return 0, errors.New("no results store at " + dsn)
	}
	defer r.db.Close()
	return r.forget(sub)
}

// record upserts one pass. The (sub, exam) primary key makes a repeat pass a
// no-op on history - we keep the first passed_at and just refresh the
// denormalised provider/title fields. Returns an error when persistence is
// disabled so the grader can leave Recorded=false.
func (r *Results) record(rec PassRecord) error {
	if r.db == nil {
		return errors.New("no results store configured")
	}
	rec.Time = time.Now().UTC().Format(time.RFC3339)
	_, err := r.db.Exec(r.q(`
		INSERT INTO passes (sub, exam, provider, exam_title, passed_at)
		VALUES (?, ?, ?, ?, ?)
		ON CONFLICT(sub, exam) DO UPDATE SET
			provider   = excluded.provider,
			exam_title = excluded.exam_title;`),
		rec.Sub, rec.Exam, rec.Provider, rec.ExamTitle, rec.Time)
	if err == nil {
		// Keep the retention window enforced as new passes arrive, so compliance
		// doesn't depend on a process restart. Best-effort: a failed sweep must
		// not fail the (successful) record.
		_, _ = r.purgeExpired()
	}
	return err
}

// passedBy returns the distinct exam slugs the given user has passed, sorted.
// The (sub, exam) key already guarantees distinctness; ORDER BY gives the SPA a
// stable list for its per-exam checkmarks.
func (r *Results) passedBy(sub string) []string {
	if r.db == nil || sub == "" {
		return nil
	}
	rows, err := r.db.Query(r.q(`SELECT exam FROM passes WHERE sub = ? ORDER BY exam;`), sub)
	if err != nil {
		return nil
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var exam string
		if rows.Scan(&exam) == nil && exam != "" {
			out = append(out, exam)
		}
	}
	return out
}

// resultsMe - GET /v1/exams/results/me. Returns the exam slugs the signed-in
// user has passed, for the SPA's checkmarks. Anonymous/dev → empty list.
func (h *Handler) resultsMe(w http.ResponseWriter, r *http.Request) {
	u, _ := h.auth.user(r)
	passed := []string{}
	if u != nil {
		if p := h.results.passedBy(u.Sub); p != nil {
			passed = p
		}
	}
	writeJSON(w, map[string]any{"passed": passed})
}
