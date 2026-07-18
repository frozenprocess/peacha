package server

import (
	"bytes"
	"encoding/json"
	"html"
	"net/http"
	"net/url"
	"strings"

	"github.com/yuin/goldmark"
	"github.com/yuin/goldmark/extension"
	gmhtml "github.com/yuin/goldmark/renderer/html"
)

// SEO / prerendering.
//
// The SPA ships a single empty shell (#root filled in by React), which is fine
// for users but invisible to search crawlers and link unfurlers that don't run
// JS. The content actually worth indexing is the read-along tutorial track -
// plain markdown already living on the server. So for a tutorial deep link
// (GET /tutorials/<slug>) we render that lesson's markdown to HTML on the
// server and inject it - plus per-lesson <title>, description, canonical,
// Open Graph/Twitter, and JSON-LD - into the shell before sending it. React
// then mounts over #root (createRoot().render replaces its children), so users
// still get the full interactive app; crawlers get real content.
//
// The shell carries an `__SEO_ORIGIN__` token and a `<!-- seo:start -->`..
// `<!-- seo:end -->` region (see web/index.html). We substitute the origin on
// every HTML response and swap the whole region for the home or tutorial tags.

// mdRenderer renders tutorial markdown the same way the SPA does (GitHub
// flavoured markdown). WithUnsafe mirrors react-markdown's raw-HTML passthrough;
// tutorial.md is trusted, in-repo content, so this is not an injection surface.
var mdRenderer = goldmark.New(
	goldmark.WithExtensions(extension.GFM),
	goldmark.WithRendererOptions(gmhtml.WithUnsafe()),
)

const (
	seoStart = "<!-- seo:start -->"
	seoEnd   = "<!-- seo:end -->"
	seoToken = "__SEO_ORIGIN__"
	rootDiv  = `<div id="root"></div>`
)

// renderMarkdown converts a tutorial.md body to an HTML fragment. On error it
// falls back to the escaped source wrapped in a <pre> so prerendering never
// fails the request.
func renderMarkdown(src string) string {
	var buf bytes.Buffer
	if err := mdRenderer.Convert([]byte(src), &buf); err != nil {
		return "<pre>" + html.EscapeString(src) + "</pre>"
	}
	return buf.String()
}

// homeShell returns the shell with the origin token resolved - the default
// HTML for the app root and any client-side route that isn't a tutorial deep
// link. The baseline SEO tags from web/index.html stay as-is.
//
// origin is derived from the request Host (see Handler.origin), so it's
// attacker-influenced and lands in HTML attribute contexts (canonical href,
// og:url, og:image) - it MUST be HTML-escaped here, or a crafted Host header
// breaks out of the attribute (reflected XSS).
func homeShell(shell []byte, origin string) []byte {
	return []byte(strings.ReplaceAll(string(shell), seoToken, attr(origin)))
}

// tutorialShell returns the shell prerendered for one lesson: the seo:start..
// seo:end region swapped for lesson-specific tags + JSON-LD, the <title>
// rewritten, and the rendered lesson body injected into #root. origin is the
// request's absolute origin (scheme://host) used to build canonical/OG URLs.
func tutorialShell(shell []byte, t *Tutorial, origin string) []byte {
	s := string(shell)
	canonical := origin + tutorialPath(t.Name)
	ogImage := origin + "/og-card.png"

	title := t.Title
	if title == "" {
		title = t.Name
	}
	desc := t.Summary
	if desc == "" {
		desc = "A guided, in-browser lesson on Kubernetes and Calico network policy - part of the Peacha playground."
	}

	// Per-lesson head tags replacing the shell's seo:start..seo:end region.
	var head strings.Builder
	writeMeta := func(s string) { head.WriteString("  " + s + "\n") }
	head.WriteString(seoStart + "\n")
	writeMeta(`<meta name="description" content="` + attr(desc) + `" />`)
	writeMeta(`<link rel="canonical" href="` + attr(canonical) + `" />`)
	writeMeta(`<meta property="og:type" content="article" />`)
	writeMeta(`<meta property="og:site_name" content="Peacha" />`)
	writeMeta(`<meta property="og:title" content="` + attr(title) + `" />`)
	writeMeta(`<meta property="og:description" content="` + attr(desc) + `" />`)
	writeMeta(`<meta property="og:url" content="` + attr(canonical) + `" />`)
	writeMeta(`<meta property="og:image" content="` + attr(ogImage) + `" />`)
	writeMeta(`<meta name="twitter:card" content="summary_large_image" />`)
	writeMeta(`<meta name="twitter:title" content="` + attr(title) + `" />`)
	writeMeta(`<meta name="twitter:description" content="` + attr(desc) + `" />`)
	writeMeta(`<meta name="twitter:image" content="` + attr(ogImage) + `" />`)
	writeMeta(jsonLD(t, canonical, ogImage))
	head.WriteString("  " + seoEnd)

	s = replaceRegion(s, seoStart, seoEnd, head.String())
	s = replaceTitle(s, title+" - Peacha")

	// Prerendered, crawler-visible body. React clears #root on mount, so this
	// is for crawlers / no-JS readers only; it's never shown alongside the app.
	body := `<div id="root"><article class="prerender" data-tutorial="` + attr(t.Name) + `">` +
		"<h1>" + html.EscapeString(title) + "</h1>" +
		renderMarkdown(t.Doc) +
		`</article></div>`
	s = strings.Replace(s, rootDiv, body, 1)

	// Resolve any origin tokens left outside the region (none expected, since
	// the seo region is gone). HTML-escaped for the same reason as homeShell.
	return []byte(strings.ReplaceAll(s, seoToken, attr(origin)))
}

// jsonLD builds a schema.org TechArticle script tag for one lesson. Marshalling
// a map keeps the JSON valid and correctly escaped regardless of the content.
func jsonLD(t *Tutorial, canonical, image string) string {
	title := t.Title
	if title == "" {
		title = t.Name
	}
	doc := map[string]any{
		"@context":   "https://schema.org",
		"@type":      "TechArticle",
		"headline":   title,
		"name":       title,
		"url":        canonical,
		"image":      image,
		"inLanguage": "en",
		"about":      "Kubernetes and Calico network policy",
		"isPartOf": map[string]any{
			"@type":               "WebApplication",
			"name":                "Peacha",
			"applicationCategory": "DeveloperApplication",
		},
		"publisher": map[string]any{
			"@type": "Organization",
			"name":  "Peacha",
		},
	}
	if t.Summary != "" {
		doc["description"] = t.Summary
	}
	b, err := json.Marshal(doc)
	if err != nil {
		return ""
	}
	// </script> can't appear in JSON-LD; escape the closing-tag sequence per
	// the HTML spec so a stray "</script>" in content can't break out.
	safe := strings.ReplaceAll(string(b), "</", `<\/`)
	return `<script type="application/ld+json">` + safe + `</script>`
}

// replaceRegion swaps everything from start to end (inclusive of both markers)
// for repl. If either marker is missing it returns s unchanged.
func replaceRegion(s, start, end, repl string) string {
	i := strings.Index(s, start)
	if i < 0 {
		return s
	}
	j := strings.Index(s[i:], end)
	if j < 0 {
		return s
	}
	j += i + len(end)
	return s[:i] + repl + s[j:]
}

// replaceTitle rewrites the first <title>...</title> element's text.
func replaceTitle(s, title string) string {
	i := strings.Index(s, "<title>")
	if i < 0 {
		return s
	}
	j := strings.Index(s[i:], "</title>")
	if j < 0 {
		return s
	}
	j += i
	return s[:i+len("<title>")] + html.EscapeString(title) + s[j:]
}

// attr escapes a string for use inside a double-quoted HTML attribute.
func attr(s string) string { return html.EscapeString(s) }

// tutorialPath is the clean, canonical deep link for a lesson slug:
// /tutorials/<slug>. The slug is a stable kebab-case meta.name, but it's
// PathEscaped for safety so the result is always a valid single path segment.
func tutorialPath(slug string) string {
	return "/tutorials/" + url.PathEscape(slug)
}

// tutorialSlugFromPath extracts <slug> from a /tutorials/<slug> request path
// (a trailing slash is tolerated). It returns "" for any other path, or when
// the remainder isn't a single segment - so /tutorials/, nested paths, and the
// app root all fall through to the home shell.
func tutorialSlugFromPath(p string) string {
	const prefix = "/tutorials/"
	if !strings.HasPrefix(p, prefix) {
		return ""
	}
	rest := strings.TrimSuffix(strings.TrimPrefix(p, prefix), "/")
	if rest == "" || strings.Contains(rest, "/") {
		return ""
	}
	if unescaped, err := url.PathUnescape(rest); err == nil {
		return unescaped
	}
	return rest
}

// robots serves /robots.txt: crawlers may index the app and tutorial content,
// but not the API, the auth flow, or the gated exam track. It points at the
// dynamically generated sitemap so the tutorial URLs are discoverable.
func (h *Handler) Robots(w http.ResponseWriter, r *http.Request) {
	origin := h.origin(r)
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.Header().Set("Cache-Control", "public, max-age=3600")
	_, _ = w.Write([]byte("User-agent: *\n" +
		"Allow: /$\n" +
		"Disallow: /v1/\n" +
		"Disallow: /healthz\n" +
		"\n" +
		"Sitemap: " + origin + "/sitemap.xml\n"))
}

// sitemap serves /sitemap.xml: the app root plus one entry per tutorial deep
// link, built from the loaded track so it stays in sync as lessons are added.
func (h *Handler) Sitemap(w http.ResponseWriter, r *http.Request) {
	origin := h.origin(r)
	var b strings.Builder
	b.WriteString(`<?xml version="1.0" encoding="UTF-8"?>` + "\n")
	b.WriteString(`<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">` + "\n")
	writeURL := func(loc string) {
		b.WriteString("  <url><loc>" + html.EscapeString(loc) + "</loc></url>\n")
	}
	writeURL(origin + "/")
	for i := range h.tutorials {
		writeURL(origin + tutorialPath(h.tutorials[i].Name))
	}
	b.WriteString("</urlset>\n")
	w.Header().Set("Content-Type", "application/xml; charset=utf-8")
	w.Header().Set("Cache-Control", "public, max-age=3600")
	_, _ = w.Write([]byte(b.String()))
}

// origin returns the request's absolute origin (scheme://host) for building
// canonical/OG URLs. The operator-set base URL (--auth-base-url) is trusted and
// wins when present; otherwise we derive from the request. The derived value is
// attacker-influenced (Host header, X-Forwarded-Proto), so the scheme is pinned
// to an http/https allowlist here and every HTML caller escapes the result -
// see homeShell/tutorialShell. (Mind: a forged Host still skews the canonical
// to an attacker's domain; set --auth-base-url in production to remove that.)
func (h *Handler) origin(r *http.Request) string {
	if h.auth != nil && h.auth.cfg.BaseURL != "" {
		return strings.TrimRight(h.auth.cfg.BaseURL, "/")
	}
	scheme := "http"
	if r.TLS != nil {
		scheme = "https"
	}
	if xf := r.Header.Get("X-Forwarded-Proto"); xf == "http" || xf == "https" {
		scheme = xf
	}
	return scheme + "://" + r.Host
}
