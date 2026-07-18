package server

import (
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
)

// newTestHandler builds a Handler wired to a fresh on-disk store and the
// built-in tutorials, with (optionally) a configured auth backend so signed-in
// identity can be exercised.
func newTestHandler(t *testing.T, withAuth bool) *Handler {
	t.Helper()
	path := filepath.Join(t.TempDir(), "results.db")
	var ac AuthConfig
	if withAuth {
		ac = AuthConfig{
			SessionKey: []byte("test-session-key-0123456789"),
			Slack:      ProviderConfig{ClientID: "id", ClientSecret: "secret"},
		}
	}
	return &Handler{
		tutorials: builtinTutorials(),
		results:   newResults(path, 0),
		auth:      newAuthenticator(ac),
	}
}

// feedbackTutorials returns one slug that opted into feedback and one that did
// not, from the built-in track - so the route tests don't hard-code slugs that
// might be re-numbered.
func feedbackTutorials(t *testing.T, h *Handler) (enabled, disabled string) {
	t.Helper()
	for _, tut := range h.tutorials {
		if tut.Feedback && enabled == "" {
			enabled = tut.Name
		}
		if !tut.Feedback && disabled == "" {
			disabled = tut.Name
		}
	}
	if enabled == "" {
		t.Fatal("no built-in tutorial has feedback enabled; expected the CNP track to opt in")
	}
	if disabled == "" {
		t.Fatal("no built-in tutorial without feedback; test needs a non-opted page")
	}
	return enabled, disabled
}

// post drives submitFeedback through the real path-value routing so {name} is
// populated exactly as the mux would.
func (h *Handler) postFeedback(name, body string, cookie *http.Cookie) *httptest.ResponseRecorder {
	r := httptest.NewRequest(http.MethodPost, "/v1/tutorials/"+name+"/feedback", strings.NewReader(body))
	r.SetPathValue("name", name)
	if cookie != nil {
		r.AddCookie(cookie)
	}
	w := httptest.NewRecorder()
	h.submitFeedback(w, r)
	return w
}

// TestSubmitFeedbackStores covers the happy path: a submission on an opted-in
// page is accepted, persisted, and (since this handler has no auth) anonymous.
func TestSubmitFeedbackStores(t *testing.T) {
	h := newTestHandler(t, false)
	enabled, _ := feedbackTutorials(t, h)

	w := h.postFeedback(enabled, `{"rating":"up","comment":"clear and useful","consent":true,"name":"Dana","org":"Acme"}`, nil)
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", w.Code, w.Body.String())
	}
	if !strings.Contains(w.Body.String(), `"recorded":true`) {
		t.Errorf("body = %s, want recorded:true", w.Body.String())
	}

	recs, err := h.results.listFeedback()
	if err != nil {
		t.Fatalf("listFeedback: %v", err)
	}
	if len(recs) != 1 {
		t.Fatalf("stored %d rows, want 1", len(recs))
	}
	got := recs[0]
	if got.Tutorial != enabled || got.Rating != "up" || got.Comment != "clear and useful" {
		t.Errorf("stored row = %+v", got)
	}
	if !got.Consent || got.Name != "Dana" || got.Org != "Acme" {
		t.Errorf("consent fields not stored: %+v", got)
	}
	if got.Sub != "" || got.Provider != "" {
		t.Errorf("anonymous submission carried identity: sub=%q provider=%q", got.Sub, got.Provider)
	}
}

// TestSubmitFeedbackConsentGate verifies name/org are dropped without consent -
// an un-consented row must never carry identifying text.
func TestSubmitFeedbackConsentGate(t *testing.T) {
	h := newTestHandler(t, false)
	enabled, _ := feedbackTutorials(t, h)

	if w := h.postFeedback(enabled, `{"rating":"down","name":"Leak","org":"Should","consent":false}`, nil); w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", w.Code)
	}
	recs, _ := h.results.listFeedback()
	if len(recs) != 1 {
		t.Fatalf("stored %d rows, want 1", len(recs))
	}
	if recs[0].Name != "" || recs[0].Org != "" {
		t.Errorf("name/org stored without consent: %+v", recs[0])
	}
}

// TestSubmitFeedbackRejects covers the refusal paths: unknown tutorial (404),
// a page that didn't opt in (403), and a bad rating (400).
func TestSubmitFeedbackRejects(t *testing.T) {
	h := newTestHandler(t, false)
	enabled, disabled := feedbackTutorials(t, h)

	if w := h.postFeedback("does-not-exist", `{"rating":"up"}`, nil); w.Code != http.StatusNotFound {
		t.Errorf("unknown tutorial: status = %d, want 404", w.Code)
	}
	if w := h.postFeedback(disabled, `{"rating":"up"}`, nil); w.Code != http.StatusForbidden {
		t.Errorf("non-opted tutorial: status = %d, want 403", w.Code)
	}
	if w := h.postFeedback(enabled, `{"rating":"meh"}`, nil); w.Code != http.StatusBadRequest {
		t.Errorf("bad rating: status = %d, want 400", w.Code)
	}
	if recs, _ := h.results.listFeedback(); len(recs) != 0 {
		t.Errorf("a rejected submission was stored: %+v", recs)
	}
}

// TestSubmitFeedbackAttachesIdentity verifies a signed-in submission carries the
// session's opaque sub/provider, attached server-side (never from the body).
func TestSubmitFeedbackAttachesIdentity(t *testing.T) {
	h := newTestHandler(t, true)
	enabled, _ := feedbackTutorials(t, h)

	val, err := h.auth.sign(&SessionUser{Sub: "slack:U42", Provider: "slack"})
	if err != nil {
		t.Fatalf("sign: %v", err)
	}
	cookie := &http.Cookie{Name: sessionCookie, Value: val}

	if w := h.postFeedback(enabled, `{"rating":"up","comment":"prod-ready"}`, cookie); w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", w.Code, w.Body.String())
	}
	recs, _ := h.results.listFeedback()
	if len(recs) != 1 {
		t.Fatalf("stored %d rows, want 1", len(recs))
	}
	if recs[0].Sub != "slack:U42" || recs[0].Provider != "slack" {
		t.Errorf("identity not attached: %+v", recs[0])
	}

	// And forget() must erase that signed-in submission (right-to-erasure).
	if n, err := h.results.forget("slack:U42"); err != nil || n != 1 {
		t.Errorf("forget = %d, %v; want 1, nil", n, err)
	}
	if recs, _ := h.results.listFeedback(); len(recs) != 0 {
		t.Errorf("forget left feedback behind: %+v", recs)
	}
}

// TestDumpFeedbackCLI covers the offline export path (the only way to read stored
// feedback now that there is no HTTP route): a populated store dumps to JSON and
// CSV. DumpFeedback opens the store at a path, so we record against that same path.
func TestDumpFeedbackCLI(t *testing.T) {
	path := filepath.Join(t.TempDir(), "results.db")
	r := newResults(path, 0)
	if err := r.recordFeedback(FeedbackRecord{Tutorial: "demo", Rating: "up", Comment: "great"}); err != nil {
		t.Fatalf("recordFeedback: %v", err)
	}

	js, err := DumpFeedback(path, "json")
	if err != nil {
		t.Fatalf("DumpFeedback json: %v", err)
	}
	if !strings.Contains(js, `"comment": "great"`) {
		t.Errorf("json dump missing the row: %s", js)
	}

	csv, err := DumpFeedback(path, "csv")
	if err != nil {
		t.Fatalf("DumpFeedback csv: %v", err)
	}
	if !strings.HasPrefix(csv, "time,tutorial,rating") {
		t.Errorf("csv dump missing header: %s", csv)
	}
	if !strings.Contains(csv, "great") {
		t.Errorf("csv dump missing the row: %s", csv)
	}
}
