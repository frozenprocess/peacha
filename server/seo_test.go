package server

import (
	"net/http/httptest"
	"strings"
	"testing"
)

// shell mirrors the relevant parts of web/index.html: a <title>, the
// seo:start..seo:end region with an origin token, and the empty #root div.
const shell = `<!doctype html><html><head>
<title>Peacha - The Network Policy Playground</title>
<!-- seo:start -->
<meta name="description" content="home" />
<link rel="canonical" href="__SEO_ORIGIN__/" />
<meta property="og:image" content="__SEO_ORIGIN__/og-card.png" />
<!-- seo:end -->
</head><body><div id="root"></div></body></html>`

func sampleTutorial() *Tutorial {
	return &Tutorial{
		Example: Example{Name: "deny-all-ingress"},
		Title:   "Deny all ingress",
		Summary: "Lock a namespace down with a default-deny ingress policy.",
		Doc:     "# Deny all\n\nThis lesson shows a **default deny**.\n",
	}
}

func TestHomeShellResolvesOrigin(t *testing.T) {
	out := string(homeShell([]byte(shell), "https://peacha.example"))
	if strings.Contains(out, seoToken) {
		t.Fatalf("origin token not resolved: %q", out)
	}
	if !strings.Contains(out, `href="https://peacha.example/"`) {
		t.Fatalf("canonical not rewritten to origin: %q", out)
	}
}

func TestTutorialShellInjectsContentAndMeta(t *testing.T) {
	out := string(tutorialShell([]byte(shell), sampleTutorial(), "https://peacha.example"))

	checks := []string{
		// Title rewritten.
		"<title>Deny all ingress - Peacha</title>",
		// Per-lesson description + canonical (origin-absolute, clean path).
		`content="Lock a namespace down with a default-deny ingress policy."`,
		`href="https://peacha.example/tutorials/deny-all-ingress"`,
		// Open Graph as an article + image on the origin.
		`property="og:type" content="article"`,
		`content="https://peacha.example/og-card.png"`,
		// JSON-LD present.
		`<script type="application/ld+json">`,
		`"@type":"TechArticle"`,
		// Rendered markdown body inside #root (goldmark output).
		`data-tutorial="deny-all-ingress"`,
		"<strong>default deny</strong>",
	}
	for _, c := range checks {
		if !strings.Contains(out, c) {
			t.Errorf("prerendered shell missing %q", c)
		}
	}
	// No leftover origin token, no empty root div.
	if strings.Contains(out, seoToken) {
		t.Error("origin token left unresolved")
	}
	if strings.Contains(out, rootDiv) {
		t.Error("#root was not filled with prerendered content")
	}
}

func TestTutorialShellEscapesContent(t *testing.T) {
	tut := &Tutorial{
		Example: Example{Name: "x"},
		Title:   `Quotes "and" <tags>`,
		Summary: `Desc with "quotes" & <html>`,
		Doc:     "ok",
	}
	out := string(tutorialShell([]byte(shell), tut, "https://h"))
	// The title text in <title> and attribute values must be escaped so they
	// can't break out of the tag / attribute.
	if strings.Contains(out, `content="Desc with "quotes"`) {
		t.Error("description attribute not escaped")
	}
	if !strings.Contains(out, "&amp;") {
		t.Error("expected HTML-escaped ampersand somewhere in output")
	}
}

// TestShellEscapesMaliciousOrigin guards the reflected-XSS sink: origin is
// derived from the attacker-controllable Host header and substituted into HTML
// attribute contexts, so it must be escaped on the way in.
func TestShellEscapesMaliciousOrigin(t *testing.T) {
	evil := `https://x"><script>alert(1)</script>`
	for _, out := range []string{
		string(homeShell([]byte(shell), evil)),
		string(tutorialShell([]byte(shell), sampleTutorial(), evil)),
	} {
		if strings.Contains(out, "<script>alert(1)</script>") {
			t.Errorf("origin not escaped - XSS payload survived: %q", out)
		}
		if !strings.Contains(out, "&lt;script&gt;") {
			t.Errorf("expected escaped payload in output: %q", out)
		}
	}
}

// TestOriginSchemeAllowlist confirms a spoofed X-Forwarded-Proto can't inject
// an arbitrary scheme; only http/https are honored.
func TestOriginSchemeAllowlist(t *testing.T) {
	h := &Handler{auth: newAuthenticator(AuthConfig{})}
	req := httptest.NewRequest("GET", "http://host.example/", nil)
	req.Header.Set("X-Forwarded-Proto", `javascript:alert(1)//`)
	if got := h.origin(req); got != "http://host.example" {
		t.Errorf("spoofed scheme honored: origin = %q", got)
	}
	req.Header.Set("X-Forwarded-Proto", "https")
	if got := h.origin(req); got != "https://host.example" {
		t.Errorf("valid forwarded proto dropped: origin = %q", got)
	}
}

func TestTutorialSlugFromPath(t *testing.T) {
	cases := map[string]string{
		"/tutorials/deny-all-ingress":  "deny-all-ingress",
		"/tutorials/deny-all-ingress/": "deny-all-ingress",
		"/tutorials/a%2Fb":             "a/b", // percent-decoded single segment
		"/tutorials/":                  "",    // no slug
		"/tutorials/a/b":               "",    // nested, not a lesson
		"/":                            "",
		"/v1/tutorials/x/y":            "", // API asset subtree, not a deep link
	}
	for in, want := range cases {
		if got := tutorialSlugFromPath(in); got != want {
			t.Errorf("tutorialSlugFromPath(%q) = %q, want %q", in, got, want)
		}
	}
	if got := tutorialPath("getting-started"); got != "/tutorials/getting-started" {
		t.Errorf("tutorialPath = %q", got)
	}
}

func TestRobotsAndSitemap(t *testing.T) {
	h := &Handler{
		auth:      newAuthenticator(AuthConfig{}),
		tutorials: []Tutorial{*sampleTutorial()},
	}

	rec := httptest.NewRecorder()
	req := httptest.NewRequest("GET", "https://peacha.example/robots.txt", nil)
	req.Header.Set("X-Forwarded-Proto", "https")
	h.Robots(rec, req)
	robots := rec.Body.String()
	if !strings.Contains(robots, "Disallow: /v1/") {
		t.Errorf("robots.txt should disallow the API: %q", robots)
	}
	if !strings.Contains(robots, "Sitemap: https://peacha.example/sitemap.xml") {
		t.Errorf("robots.txt should point at the sitemap: %q", robots)
	}

	rec = httptest.NewRecorder()
	req = httptest.NewRequest("GET", "https://peacha.example/sitemap.xml", nil)
	req.Header.Set("X-Forwarded-Proto", "https")
	h.Sitemap(rec, req)
	sm := rec.Body.String()
	for _, want := range []string{
		"<loc>https://peacha.example/</loc>",
		"<loc>https://peacha.example/tutorials/deny-all-ingress</loc>",
	} {
		if !strings.Contains(sm, want) {
			t.Errorf("sitemap missing %q in %q", want, sm)
		}
	}
}
