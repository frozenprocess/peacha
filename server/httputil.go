package server

import (
	"encoding/json"
	"io/fs"
	"mime"
	"net/http"
	"path"
	"strings"
)

// requireMethod wraps a handler so it only runs for the given HTTP method,
// answering anything else with 405 and a "<METHOD> required" body. Method
// guards are applied at registration in Routes(), composed inside withCORS so
// OPTIONS preflights still short-circuit before the guard.
func requireMethod(method string, next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != method {
			http.Error(w, method+" required", http.StatusMethodNotAllowed)
			return
		}
		next(w, r)
	}
}

// decodeJSON decodes the request body into v, writing a 400 "decode: …" error
// and returning false on failure. Callers bail out with `if !decodeJSON(...) { return }`.
func decodeJSON(w http.ResponseWriter, r *http.Request, v any) bool {
	if err := json.NewDecoder(r.Body).Decode(v); err != nil {
		http.Error(w, "decode: "+err.Error(), http.StatusBadRequest)
		return false
	}
	return true
}

// writeJSONStatus writes v as JSON with an explicit status code.
func writeJSONStatus(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

// writeJSON writes v as a 200 JSON response.
func writeJSON(w http.ResponseWriter, v any) { writeJSONStatus(w, http.StatusOK, v) }

// serveEmbeddedAsset serves a file from an embedded FS, mapping the request path
// (after stripping urlPrefix) to embedPrefix+rel. The path is cleaned and
// re-rooted so it can't escape the embed tree; missing files 404. Shared by the
// tutorial and exam asset routes.
func serveEmbeddedAsset(w http.ResponseWriter, r *http.Request, fsys fs.FS, urlPrefix, embedPrefix string) {
	rel := strings.TrimPrefix(r.URL.Path, urlPrefix)
	// Prefix with "/" before Clean so any leading "../" is clamped to root, then
	// strip it back to a tree-relative path - defends against traversal.
	rel = strings.TrimPrefix(path.Clean("/"+rel), "/")
	if rel == "" {
		http.NotFound(w, r)
		return
	}
	b, err := fs.ReadFile(fsys, embedPrefix+rel)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	if ctype := mime.TypeByExtension(path.Ext(rel)); ctype != "" {
		w.Header().Set("Content-Type", ctype)
	}
	_, _ = w.Write(b)
}
