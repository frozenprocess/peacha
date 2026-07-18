package server

import (
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// TestShortlinkStore round-trips a link through the SQLite store: a minted code
// resolves back to its target, distinct mints get distinct codes, an unknown
// code resolves to "", and a disabled store (empty path) refuses to mint.
func TestShortlinkStore(t *testing.T) {
	path := filepath.Join(t.TempDir(), "share.db")
	l := newLinks(path, 0) // keep forever so retention can't perturb assertions
	if l.db == nil {
		t.Fatal("newLinks: db is nil for a valid path")
	}

	target := "/tutorials/10-knp-first-policy#~AbCdEf"
	code, err := l.recordLink(target)
	if err != nil {
		t.Fatalf("recordLink: %v", err)
	}
	if code == "" {
		t.Fatal("recordLink returned an empty code")
	}
	if got := l.resolveLink(code); got != target {
		t.Errorf("resolveLink(%q) = %q, want %q", code, got, target)
	}

	// A second mint of the same target still gets its own distinct code.
	code2, err := l.recordLink(target)
	if err != nil {
		t.Fatalf("recordLink (2nd): %v", err)
	}
	if code2 == code {
		t.Errorf("two mints collided on code %q", code)
	}

	if got := l.resolveLink("does-not-exist"); got != "" {
		t.Errorf("resolveLink(unknown) = %q, want empty", got)
	}
	if got := l.resolveLink(""); got != "" {
		t.Errorf("resolveLink(empty) = %q, want empty", got)
	}

	// A disabled store (no path) must refuse to mint so the SPA falls back.
	if _, err := newLinks("", 0).recordLink(target); err == nil {
		t.Error("recordLink on a disabled store should error")
	}
}

// TestShareRetention proves the share-link store enforces its own retention
// window: a link older than the window is purged, a fresh one survives, and a
// zero window keeps everything.
func TestShareRetention(t *testing.T) {
	dir := t.TempDir()
	l := newLinks(filepath.Join(dir, "share.db"), 7) // 7-day window
	old := time.Now().Add(-10 * 24 * time.Hour).UTC().Format(time.RFC3339)
	fresh := time.Now().UTC().Format(time.RFC3339)
	if _, err := l.db.Exec(`INSERT INTO shortlinks (code, target, created_at) VALUES (?, ?, ?), (?, ?, ?);`,
		"oldcode", "/old", old, "newcode", "/new", fresh); err != nil {
		t.Fatalf("seed: %v", err)
	}
	if _, err := l.purgeExpired(); err != nil {
		t.Fatalf("purgeExpired: %v", err)
	}
	if got := l.resolveLink("oldcode"); got != "" {
		t.Errorf("link past the window survived: %q", got)
	}
	if got := l.resolveLink("newcode"); got != "/new" {
		t.Errorf("fresh link wrongly purged: %q", got)
	}

	// A zero window keeps links forever - the old row stays put.
	keep := newLinks(filepath.Join(dir, "keep.db"), 0)
	if _, err := keep.db.Exec(`INSERT INTO shortlinks (code, target, created_at) VALUES (?, ?, ?);`, "old2", "/x", old); err != nil {
		t.Fatalf("seed keep: %v", err)
	}
	if _, err := keep.purgeExpired(); err != nil {
		t.Fatalf("purgeExpired (keep): %v", err)
	}
	if got := keep.resolveLink("old2"); got != "/x" {
		t.Errorf("zero-retention store purged a link: %q", got)
	}
}

// TestIsSafeRelTarget pins the open-redirect guard: only same-origin
// absolute-path references pass; anything that could leave the origin is rejected.
func TestIsSafeRelTarget(t *testing.T) {
	ok := []string{"/", "/#~abc", "/tutorials/foo#~abc", "/?provider=kind#x"}
	bad := []string{
		"", "relative", "//evil.com", "https://evil.com", "http://x",
		"javascript:alert(1)", "/path\nLocation: x", "\t/x",
		// Backslash variants: browsers normalise "\" to "/", so these resolve
		// off-origin despite the leading "/".
		"/\\evil.com", "/\\/evil.com", "/a\\b", "\\/evil.com",
	}
	for _, s := range ok {
		if !isSafeRelTarget(s) {
			t.Errorf("isSafeRelTarget(%q) = false, want true", s)
		}
	}
	for _, s := range bad {
		if isSafeRelTarget(s) {
			t.Errorf("isSafeRelTarget(%q) = true, want false", s)
		}
	}
}

// TestShortlinkRedirect drives the HTTP redirect: a known code 302s to its
// stored target, an unknown code falls back to "/" (never a dead 404).
func TestShortlinkRedirect(t *testing.T) {
	path := filepath.Join(t.TempDir(), "share.db")
	h := &Handler{links: newLinks(path, 0)}

	target := "/tutorials/foo#~payload"
	code, err := h.links.recordLink(target)
	if err != nil {
		t.Fatalf("recordLink: %v", err)
	}

	rec := httptest.NewRecorder()
	h.ShortlinkRedirect(rec, httptest.NewRequest(http.MethodGet, "/s/"+code, nil))
	if rec.Code != http.StatusFound {
		t.Fatalf("known code: status = %d, want 302", rec.Code)
	}
	if loc := rec.Header().Get("Location"); loc != target {
		t.Errorf("known code: Location = %q, want %q", loc, target)
	}

	rec = httptest.NewRecorder()
	h.ShortlinkRedirect(rec, httptest.NewRequest(http.MethodGet, "/s/nope", nil))
	if rec.Code != http.StatusFound || rec.Header().Get("Location") != "/" {
		t.Errorf("unknown code: status=%d loc=%q, want 302 -> /", rec.Code, rec.Header().Get("Location"))
	}
}

// TestCreateLinkHandler covers the POST path: a valid target mints a /s/<code>
// url, an off-origin target is rejected 400, and a disabled store returns 503 so
// the SPA falls back to the long link.
func TestCreateLinkHandler(t *testing.T) {
	path := filepath.Join(t.TempDir(), "share.db")
	h := &Handler{links: newLinks(path, 0)}

	rec := httptest.NewRecorder()
	h.createLink(rec, httptest.NewRequest(http.MethodPost, "/v1/links", strings.NewReader(`{"target":"/#~abc"}`)))
	if rec.Code != http.StatusOK {
		t.Fatalf("valid target: status = %d body = %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), `"/s/`) {
		t.Errorf("valid target: body %s missing /s/ url", rec.Body.String())
	}

	rec = httptest.NewRecorder()
	h.createLink(rec, httptest.NewRequest(http.MethodPost, "/v1/links", strings.NewReader(`{"target":"//evil.com"}`)))
	if rec.Code != http.StatusBadRequest {
		t.Errorf("off-origin target: status = %d, want 400", rec.Code)
	}

	disabled := &Handler{links: newLinks("", 0)}
	rec = httptest.NewRecorder()
	disabled.createLink(rec, httptest.NewRequest(http.MethodPost, "/v1/links", strings.NewReader(`{"target":"/#~abc"}`)))
	if rec.Code != http.StatusServiceUnavailable {
		t.Errorf("disabled store: status = %d, want 503", rec.Code)
	}
}
