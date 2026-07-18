// Command editor is the HTTP front-end for calico-engine. Binary entrypoint
// only - all logic lives in this package's other files.
//
//	editor --addr :8080 --cors '*' --cache-size 256
//	editor --version        # print editor / engine / Calico versions and exit
//
// Routes (see server.Handler.Routes for the full set):
//
//	POST /v1/evaluate              EditorRequest -> EditorResponse
//	GET  /v1/tutorials                           -> []Tutorial
//	GET  /v1/exams                               -> []Exam (answer key stripped)
//	POST /v1/exams/{name}/grade    GradeRequest  -> GradeResult
//	GET  /v1/version                             -> {editor, engine, calico}
//	GET  /v1/auth/{config,me}                    -> login state
//	GET  /v1/auth/login/{provider}               -> OAuth redirect (slack|google|github)
//	GET  /v1/auth/callback/{provider}            -> OAuth callback
//	GET  /healthz                                -> "ok"
//	GET  /*                                       -> embedded SPA (or dev placeholder)
//
// Login is optional: with no provider credentials the auth endpoints report
// disabled and exams grade ungated (dev). Each provider with a client id+secret
// is enabled. See AuthConfig / --slack-* --google-* --github-* flags.
package main

import (
	"crypto/rand"
	"flag"
	"fmt"
	"log"
	"net/http"
	"os"
	"strconv"

	logrus "github.com/sirupsen/logrus"

	"github.com/frozenprocess/peacha/server"
)

// Component versions, stamped at build time via -ldflags "-X main.…". The
// editor value is this repo's `git describe`; engine + Calico come from their
// submodule checkouts. See the Makefile (which computes them) and
// deploy/Dockerfile (which receives them as build args). These defaults apply
// to a plain `go build`/`go run` with no ldflags.
var (
	editorVersion = "dev"
	engineVersion = "unknown"
	calicoVersion = "unknown"
)

// envOr returns the env var value, or fallback when unset.
func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

// envOrInt is envOr for integer settings: the env var parsed as an int, or
// fallback when unset or unparseable.
func envOrInt(key string, fallback int) int {
	if v := os.Getenv(key); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			return n
		}
	}
	return fallback
}

// envOrBool is envOr for boolean settings: the env var parsed as a bool
// (1/t/true/0/f/false…), or fallback when unset or unparseable.
func envOrBool(key string, fallback bool) bool {
	if v := os.Getenv(key); v != "" {
		if b, err := strconv.ParseBool(v); err == nil {
			return b
		}
	}
	return fallback
}

func main() {
	addr := flag.String("addr", ":8080", "listen address")
	cors := flag.String("cors", "*", "CORS origins (comma-separated, or '*')")
	cacheSize := flag.Int("cache-size", 256, "LRU response cache entries")
	showVersion := flag.Bool("version", false, "print component versions (editor, engine, Calico) and exit")
	// OAuth login backends - exam-only login gate. Any provider with a client id
	// + secret is enabled; with none, exams run ungated and the SPA hides the
	// login buttons. Callbacks are built from --auth-base-url (or derived from the
	// request when empty), so each provider's registered redirect URI is
	//   <base>/v1/auth/callback/<provider>
	// Restrict pins membership: Slack team id/domain, Google Workspace domain,
	// GitHub org login. Flags fall back to env so a deploy can inject secrets.
	//
	// Slack note: a team *id* (T0…) also pre-scopes the login screen - Slack
	// skips the workspace picker for users already signed into that workspace.
	// A team *domain* (calicousers) restricts just the same but can't pre-scope
	// the picker, so prefer the id. Either way logged-out users still get
	// Slack's "enter your workspace URL" page; that's unavoidable via OIDC.
	authBaseURL := flag.String("auth-base-url", os.Getenv("AUTH_BASE_URL"), "absolute origin for OAuth callbacks, e.g. https://host (derived from request if empty)")

	slackClientID := flag.String("slack-client-id", os.Getenv("SLACK_CLIENT_ID"), "Slack OIDC app client id")
	slackClientSecret := flag.String("slack-client-secret", os.Getenv("SLACK_CLIENT_SECRET"), "Slack OIDC app client secret")
	slackTeam := flag.String("slack-team", os.Getenv("SLACK_TEAM"), "restrict logins to this Slack workspace; use the team id (T0…) to also skip the workspace picker for signed-in users, or a domain (e.g. calicousers) to only restrict")
	slackWorkspaceURL := flag.String("slack-workspace-url", os.Getenv("SLACK_WORKSPACE_URL"), "optional link shown on the sign-in gate so logged-out users can sign in to (or join) the Slack workspace first, e.g. https://calicousers.slack.com - Slack ignores the team hint until the browser has a session for that workspace")

	googleClientID := flag.String("google-client-id", os.Getenv("GOOGLE_CLIENT_ID"), "Google OIDC client id")
	googleClientSecret := flag.String("google-client-secret", os.Getenv("GOOGLE_CLIENT_SECRET"), "Google OIDC client secret")
	googleDomain := flag.String("google-domain", os.Getenv("GOOGLE_DOMAIN"), "restrict logins to this Google Workspace hosted domain (e.g. tigera.io)")

	githubClientID := flag.String("github-client-id", os.Getenv("GITHUB_CLIENT_ID"), "GitHub OAuth app client id")
	githubClientSecret := flag.String("github-client-secret", os.Getenv("GITHUB_CLIENT_SECRET"), "GitHub OAuth app client secret")
	githubOrg := flag.String("github-org", os.Getenv("GITHUB_ORG"), "restrict logins to members of this GitHub organization")

	sessionSecret := flag.String("session-secret", os.Getenv("SESSION_SECRET"), "HMAC key for signing session cookies (random if empty)")
	resultsFile := flag.String("results-file", envOr("RESULTS_FILE", "exam-results.db"), "SQLite file path or postgres:// URL for the exam-pass store (empty disables persistence)")
	resultsRetention := flag.Int("results-retention-days", envOrInt("RESULTS_RETENTION_DAYS", 30), "delete stored exam-pass / feedback records older than this many days (GDPR storage-limitation; 0 = keep forever)")
	shareFile := flag.String("share-file", envOr("SHARE_FILE", "share-links.db"), "SQLite file path or postgres:// URL for the share short-link store, separate from the exam-results DB (empty disables short links; the SPA then shares the long self-contained URL)")
	shareRetention := flag.Int("share-retention-days", envOrInt("SHARE_RETENTION_DAYS", 0), "delete stored share short links older than this many days (0 = keep forever)")
	examAutoAdvance := flag.Bool("exam-auto-advance", envOrBool("EXAM_AUTO_ADVANCE", true), "after a learner passes an exam, automatically advance them to the next unpassed one (false = show a manual 'Next exam' button)")
	examsDisabled := flag.Bool("exams-disabled", envOrBool("EXAMS_DISABLED", false), "hard off-switch: serve no exams even if the build embeds them (hides the exams tab and 404s every exam route)")
	// Tutorial feedback has no HTTP read path: submissions are write-only over the
	// wire, and stored testimonies are exported offline here - print the stored
	// submissions and exit without starting the server (mirrors --forget-sub).
	dumpFeedback := flag.String("dump-feedback", "", "print all stored tutorial feedback as 'json' (default) or 'csv' to stdout and exit")
	// GDPR Art. 17 erasure tool: delete one subject's stored passes and exit,
	// without starting the server or needing any auth config. The subject id is
	// the provider-namespaced sub (e.g. "github:123", "slack:U…").
	forgetSub := flag.String("forget-sub", "", "erase all stored exam-pass records for this subject id and exit (e.g. github:123)")
	flag.Parse()

	if *showVersion {
		fmt.Printf("peacha editor %s\n", editorVersion)
		fmt.Printf("  engine (telepathy)  %s\n", engineVersion)
		fmt.Printf("  calico                     %s\n", calicoVersion)
		return
	}

	if *forgetSub != "" {
		n, err := server.ForgetSubject(*resultsFile, *forgetSub)
		if err != nil {
			log.Fatalf("forget %q: %v", *forgetSub, err)
		}
		fmt.Printf("erased %d record(s) for %s\n", n, *forgetSub)
		return
	}

	if *dumpFeedback != "" {
		out, err := server.DumpFeedback(*resultsFile, *dumpFeedback)
		if err != nil {
			log.Fatalf("dump-feedback: %v", err)
		}
		fmt.Println(out)
		return
	}

	// Felix libraries log at info level by default; squelch to errors so the
	// editor's per-request output isn't drowned out. Same toggle the CLI uses.
	if os.Getenv("POLICY_ENGINE_DEBUG") == "" {
		logrus.SetLevel(logrus.ErrorLevel)
	}

	// Session signing key: use the provided secret, else mint a random one so
	// cookies are still tamper-proof (the tradeoff is sessions don't survive a
	// restart - fine for a single workshop instance; set --session-secret to
	// persist them across restarts or to share across replicas).
	anyProvider := *slackClientID != "" || *googleClientID != "" || *githubClientID != ""
	sessionKey := []byte(*sessionSecret)
	if len(sessionKey) == 0 && anyProvider {
		sessionKey = make([]byte, 32)
		if _, err := rand.Read(sessionKey); err != nil {
			log.Fatalf("session key: %v", err)
		}
		log.Print("session-secret not set - minted a random key (sessions reset on restart)")
	}

	h := server.NewHandler(server.Config{
		CacheSize:            *cacheSize,
		CORS:                 *cors,
		ResultsFile:          *resultsFile,
		ResultsRetentionDays: *resultsRetention,
		ShareFile:            *shareFile,
		ShareRetentionDays:   *shareRetention,
		ExamAutoAdvance:      *examAutoAdvance,
		ExamsDisabled:        *examsDisabled,
		Versions:             server.Versions{Editor: editorVersion, Engine: engineVersion, Calico: calicoVersion},
		Auth: server.AuthConfig{
			BaseURL:    *authBaseURL,
			SessionKey: sessionKey,
			Slack:      server.ProviderConfig{ClientID: *slackClientID, ClientSecret: *slackClientSecret, Restrict: *slackTeam, WorkspaceURL: *slackWorkspaceURL},
			Google:     server.ProviderConfig{ClientID: *googleClientID, ClientSecret: *googleClientSecret, Restrict: *googleDomain},
			GitHub:     server.ProviderConfig{ClientID: *githubClientID, ClientSecret: *githubClientSecret, Restrict: *githubOrg},
		},
	})

	// API mux first, then SPA fallback for everything else.
	root := http.NewServeMux()
	api := h.Routes()
	root.Handle("/v1/", api)
	root.Handle("/healthz", api)
	// Static privacy notice - mounted above the SPA fallback so /privacy resolves
	// to the notice (the sign-in gate's "Privacy Policy" link target) rather than
	// the SPA shell.
	root.Handle("/privacy", server.PrivacyHandler())
	// Crawler entry points - mounted above the SPA fallback so they resolve to
	// their generators rather than the shell. robots.txt points at the sitemap,
	// which lists the app root + one URL per tutorial deep link.
	root.HandleFunc("/robots.txt", h.Robots)
	root.HandleFunc("/sitemap.xml", h.Sitemap)
	// Tiny share links: GET /s/<code> 302s to the stored /path#fragment. Mounted
	// above the SPA fallback so it resolves to the redirect, not the shell.
	root.HandleFunc("/s/", h.ShortlinkRedirect)
	root.Handle("/", h.SPAHandler())

	log.Printf("editor listening on %s", *addr)
	if err := http.ListenAndServe(*addr, root); err != nil {
		log.Fatal(err)
	}
}
