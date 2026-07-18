package server

import (
	"crypto/rand"
	"database/sql"
	"encoding/base64"
	"errors"
	"net/http"
	"strings"
	"time"
)

// Short-link store. The SPA already encodes the full editor state into a URL
// (path + a compressed "#fragment"); a share link is otherwise self-contained
// and needs no backend. This trades that for a *tiny* link: the SPA POSTs the
// relative URL it would have shared, gets back an opaque code, and shares
// "/s/<code>" instead. Visiting it 302s straight to the stored path#fragment,
// so the existing on-mount hydrate path restores the state unchanged.
//
// Share links get their OWN SQLite DB (--share-file), separate from the exam
// passes/feedback store: a share link isn't personal data, has its own lifetime
// (--share-retention-days), and sharing should work even on a deployment that
// keeps no exam results at all. When no DB is configured minting fails with a
// clear error and the SPA falls back to the long self-contained #fragment link -
// tiny links are an enhancement, never a dependency.

const (
	// maxShareTarget caps the stored relative URL. A compressed Playground
	// fragment is a few hundred chars; this leaves generous room while keeping a
	// single POST from wedging the DB.
	maxShareTarget = 64 * 1024
	// shareCodeBytes random bytes per code; base64url of 6 bytes is 8 chars and
	// ~2.8e14 values - collision-proof at workshop scale (and we retry on clash).
	shareCodeBytes = 6
)

// Links is the share short-link store, backed by SQLite (local dev) or
// PostgreSQL (production). A nil db disables minting (record errors so the SPA
// falls back to the long link) and resolution (resolve returns ""), matching
// the rest of the handler's best-effort startup.
type Links struct {
	db        *sql.DB
	pg        bool          // true when connected to PostgreSQL
	retention time.Duration // how long a link is kept; 0 = forever
}

// q rebinds ? placeholders to $1, $2, ... when connected to PostgreSQL.
func (l *Links) q(query string) string {
	if !l.pg {
		return query
	}
	return rebindQuery(query)
}

// newLinks opens (creating if absent) the share-link store at dsn (file path
// or postgres:// URL) and ensures the schema. An empty dsn disables the store.
// retentionDays > 0 bounds how long a link is kept; 0 keeps links forever.
func newLinks(dsn string, retentionDays int) *Links {
	if dsn == "" {
		return &Links{}
	}
	pg := strings.HasPrefix(dsn, "postgres://") || strings.HasPrefix(dsn, "postgresql://")
	var db *sql.DB
	var err error
	if pg {
		db, err = sql.Open("postgres", dsn)
	} else {
		sqliteDSN := "file:" + dsn + "?_pragma=journal_mode(WAL)&_pragma=busy_timeout(5000)&_pragma=foreign_keys(on)"
		db, err = sql.Open("sqlite", sqliteDSN)
		db.SetMaxOpenConns(1) // single open conn serialises writes - plenty at workshop scale
	}
	if err != nil {
		return &Links{}
	}
	if _, err := db.Exec(`
		CREATE TABLE IF NOT EXISTS shortlinks (
			code       TEXT PRIMARY KEY,
			target     TEXT NOT NULL,
			created_at TEXT NOT NULL
		);`); err != nil {
		_ = db.Close()
		return &Links{}
	}
	if _, err := db.Exec(`CREATE INDEX IF NOT EXISTS idx_shortlinks_created_at ON shortlinks(created_at);`); err != nil {
		_ = db.Close()
		return &Links{}
	}
	l := &Links{db: db, pg: pg}
	if retentionDays > 0 {
		l.retention = time.Duration(retentionDays) * 24 * time.Hour
	}
	_, _ = l.purgeExpired() // drop anything already past the window at startup
	return l
}

// purgeExpired deletes links older than the retention window. A disabled store
// or a zero retention (keep forever) is a no-op. Returns the rows deleted.
func (l *Links) purgeExpired() (int64, error) {
	if l.db == nil || l.retention <= 0 {
		return 0, nil
	}
	// created_at is always RFC3339 UTC (trailing "Z"), so a lexical "<" compare is
	// a correct chronological compare.
	cutoff := time.Now().Add(-l.retention).UTC().Format(time.RFC3339)
	res, err := l.db.Exec(l.q(`DELETE FROM shortlinks WHERE created_at < ?;`), cutoff)
	if err != nil {
		return 0, err
	}
	n, _ := res.RowsAffected()
	return n, nil
}

// recordLink stores target under a freshly minted code and returns the code. A
// disabled store errors so the caller can tell the SPA to fall back to the long
// #fragment link. A UNIQUE clash on the random code retries with a fresh one;
// any other error is fatal.
func (l *Links) recordLink(target string) (string, error) {
	if l.db == nil {
		return "", errors.New("no share-link store configured")
	}
	now := time.Now().UTC().Format(time.RFC3339)
	for attempt := 0; attempt < 5; attempt++ {
		code, err := shareCode()
		if err != nil {
			return "", err
		}
		_, err = l.db.Exec(l.q(`INSERT INTO shortlinks (code, target, created_at) VALUES (?, ?, ?);`), code, target, now)
		if err == nil {
			// Keep the retention window enforced as links arrive. Best-effort: a
			// failed sweep mustn't fail the (successful) insert.
			_, _ = l.purgeExpired()
			return code, nil
		}
		// SQLite: "UNIQUE constraint failed"; PostgreSQL: "duplicate key value
		// violates unique constraint". Both contain "unique" (case-insensitive).
		if !strings.Contains(strings.ToLower(err.Error()), "unique") {
			return "", err
		}
	}
	return "", errors.New("could not allocate a unique short code")
}

// resolveLink returns the stored relative target for code, or "" if unknown
// (never minted, or aged out under the retention window).
func (l *Links) resolveLink(code string) string {
	if l.db == nil || code == "" {
		return ""
	}
	var target string
	if err := l.db.QueryRow(l.q(`SELECT target FROM shortlinks WHERE code = ?;`), code).Scan(&target); err != nil {
		return ""
	}
	return target
}

func shareCode() (string, error) {
	b := make([]byte, shareCodeBytes)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}

// createLinkRequest is the wire-shape posted to POST /v1/links: the relative URL
// the SPA would otherwise have shared (path + optional "#<fragment>").
type createLinkRequest struct {
	Target string `json:"target"`
}

// createLink - POST /v1/links. Mints a short code for a relative same-origin URL
// and returns { code, url } where url is "/s/<code>". Returns 503 when the store
// isn't configured so the SPA falls back to the long self-contained link.
func (h *Handler) createLink(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, maxShareTarget+1024)
	var req createLinkRequest
	if !decodeJSON(w, r, &req) {
		return
	}
	target := strings.TrimSpace(req.Target)
	// Same-origin relative only - this is the open-redirect guard. /s/<code> 302s
	// to whatever we stored, so we store only paths that can't leave our origin.
	if !isSafeRelTarget(target) {
		writeJSONStatus(w, http.StatusBadRequest, map[string]string{"error": "target must be a relative path"})
		return
	}
	if len(target) > maxShareTarget {
		writeJSONStatus(w, http.StatusRequestEntityTooLarge, map[string]string{"error": "target too large"})
		return
	}
	code, err := h.links.recordLink(target)
	if err != nil {
		// No store configured (dev / no --results-file): the SPA copies the long
		// #fragment link instead. 503 = "this enhancement is off here", not a bug.
		writeJSONStatus(w, http.StatusServiceUnavailable, map[string]string{"error": "short links not available"})
		return
	}
	writeJSON(w, map[string]string{"code": code, "url": "/s/" + code})
}

// ShortlinkRedirect - GET /s/{code}. 302s to the stored relative target so the
// browser loads the SPA at the full path#fragment the sender shared. An unknown
// or expired code falls back to "/" (the app still opens) rather than a dead 404.
// Exported so main can mount it on the root mux, alongside Robots/Sitemap.
func (h *Handler) ShortlinkRedirect(w http.ResponseWriter, r *http.Request) {
	code := strings.TrimPrefix(r.URL.Path, "/s/")
	// A code is one base64url token: no slashes, no traversal. Anything else is a
	// malformed link - send it to the app root.
	if code == "" || strings.ContainsAny(code, "/") {
		http.Redirect(w, r, "/", http.StatusFound)
		return
	}
	target := h.links.resolveLink(code)
	if target == "" {
		http.Redirect(w, r, "/", http.StatusFound)
		return
	}
	http.Redirect(w, r, target, http.StatusFound)
}

// isSafeRelTarget reports whether t is a same-origin, absolute-path reference
// safe to store and 302 to. It must start with a single "/" (so it can't carry a
// scheme/host) and the second char must be neither "/" nor "\": browsers
// normalise backslashes to slashes, so "//host", "/\host" and "/\/host" are all
// read as protocol-relative (off-origin) URLs. Any backslash anywhere, and CR/LF,
// are rejected defensively (header smuggling / further normalisation tricks).
func isSafeRelTarget(t string) bool {
	if t == "" || t[0] != '/' {
		return false
	}
	if len(t) >= 2 && (t[1] == '/' || t[1] == '\\') {
		return false
	}
	if strings.ContainsAny(t, "\\\r\n") {
		return false
	}
	return true
}
