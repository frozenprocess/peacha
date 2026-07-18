package server

import (
	"embed"
	"io/fs"
	"net/http"
	"strings"
)

// staticFS is the built SPA. The vite config in ../web emits into ./dist
// (this package's sibling); `make build` runs that build before `go build`,
// so the dist tree exists when the embed is resolved. Dev path (`make dev`)
// runs the vite dev server on :5173 and proxies /v1/* here on :8080, never
// touching the embed.
//
// The all: prefix keeps dotfiles (vite emits `.vite/manifest.json` in some
// configs); a placeholder file ships in dist/ so the embed succeeds even
// before the first SPA build.
//
//go:embed all:dist
var staticFS embed.FS

// SPAHandler serves the embedded dist tree with HTML5-history fallback -
// any path that doesn't resolve to a file falls back to index.html so the
// SPA's client-side router gets a chance.
//
// When `npm run build` hasn't run yet, dist/ contains only the .placeholder
// file. In that case we serve the dev hint at every path, so the user lands
// on something explanatory instead of a 404 / 301-loop.
func (h *Handler) SPAHandler() http.Handler {
	sub, err := fs.Sub(staticFS, "dist")
	uiBuilt := err == nil
	if uiBuilt {
		if _, statErr := fs.Stat(sub, "index.html"); statErr != nil {
			uiBuilt = false
		}
	}
	if !uiBuilt {
		return http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte(devPlaceholder))
		})
	}
	// Cache index.html bytes once so the root + every SPA-router fallback
	// path can serve them without going through http.FileServer (which
	// 301-redirects "/" to "./" because its directory-listing logic fires
	// on the FS root). Reading once is also marginally cheaper than fs.Stat
	// + Open on every request.
	indexBytes, _ := fs.ReadFile(sub, "index.html")

	// serveShell writes the SPA shell. For a tutorial deep link
	// (GET /tutorials/<slug>) it injects that lesson's prerendered content +
	// per-page SEO tags so crawlers and link unfurlers see real content; every
	// other HTML route gets the home shell. The legacy ?tutorial=<slug> query is
	// 301'd to the clean path so search signals consolidate on one canonical
	// URL. The __SEO_ORIGIN__ token is resolved per request either way (see
	// server/seo.go).
	serveShell := func(w http.ResponseWriter, r *http.Request) {
		origin := h.origin(r)

		// Clean canonical path: /tutorials/<slug>.
		if slug := tutorialSlugFromPath(r.URL.Path); slug != "" {
			out := homeShell(indexBytes, origin)
			if t := h.tutorialByName(slug); t != nil {
				out = tutorialShell(indexBytes, t, origin)
			}
			// An unknown slug still serves the shell (the SPA shows the track),
			// not a 404 - the path is a valid SPA route.
			writeHTML(w, out)
			return
		}

		// Legacy ?tutorial=<slug> deep link -> permanent redirect to the path.
		// The browser carries any #fragment across the 301, so edited-state
		// share links keep working.
		if slug := r.URL.Query().Get("tutorial"); slug != "" {
			if t := h.tutorialByName(slug); t != nil {
				http.Redirect(w, r, tutorialPath(t.Name), http.StatusMovedPermanently)
				return
			}
		}

		writeHTML(w, homeShell(indexBytes, origin))
	}

	files := http.FileServer(http.FS(sub))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		path := strings.TrimPrefix(r.URL.Path, "/")
		if path == "" || isSPARoute(sub, path) {
			serveShell(w, r)
			return
		}
		files.ServeHTTP(w, r)
	})
}

// writeHTML sends a shell response with the SPA's standard headers (no-cache so
// the per-request origin substitution / prerender is never served stale).
func writeHTML(w http.ResponseWriter, body []byte) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-cache")
	_, _ = w.Write(body)
}

// isSPARoute returns true when the requested path doesn't exist on disk - we
// then serve index.html so the SPA's client-side router can take over (the
// share-link fragment route lands here, for example).
func isSPARoute(sub fs.FS, path string) bool {
	_, err := fs.Stat(sub, path)
	return err != nil
}

const devPlaceholder = `<!doctype html>
<html><head><meta charset="utf-8"><title>Peacha - dev</title>
<style>body{font-family:system-ui;margin:4rem auto;max-width:42rem;line-height:1.5;color:#222}code{background:#f3f3f3;padding:0.1em 0.3em;border-radius:3px}</style>
</head><body>
<h1>Peacha - server up, UI not built</h1>
<p>The Go server is running, but no built SPA is embedded yet. Two options:</p>
<ol>
<li>Build the SPA into <code>editor/web/dist</code>:
  <pre>cd editor/web &amp;&amp; npm install &amp;&amp; npm run build</pre>
  Then rebuild the Go binary.</li>
<li>Run the vite dev server alongside (hot reload):
  <pre>cd editor/web &amp;&amp; npm run dev</pre>
  and visit <code>http://localhost:5173</code>. It proxies <code>/v1/*</code> here.</li>
</ol>
<p>The API is live regardless - try
<code>curl -X POST http://localhost:8080/v1/evaluate -d '{}'</code>.</p>
</body></html>
`
