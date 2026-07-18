package server

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

// OAuth login backends. Slack and Google are OpenID Connect; GitHub is plain
// OAuth2 (no id_token / userinfo endpoint - we read the REST API instead). All
// three plug into one flow: authorize redirect → code exchange → fetch identity
// → optional restriction → signed session cookie.
const (
	sessionCookie = "peacha_session"
	stateCookie   = "peacha_oauth_state"
	// popupCookie carries the "this login runs in a popup" hint from authLogin
	// (set on ?popup=1) through to authCallback, which can't see the original
	// query. When present the callback returns an HTML closer that messages the
	// opener instead of a full-page redirect.
	popupCookie = "peacha_oauth_popup"
	sessionTTL  = 12 * time.Hour
)

// ProviderConfig holds one backend's app credentials and optional membership
// restriction. Restrict means: Slack → team id or domain; Google → hosted
// (Workspace) domain; GitHub → org login the user must belong to. Empty
// ClientID disables that provider.
type ProviderConfig struct {
	ClientID     string
	ClientSecret string
	Restrict     string
	// WorkspaceURL is an optional link learners can open to sign in to (or join)
	// the provider's workspace *before* the OAuth flow. It exists because Slack
	// can't deep-link a logged-out user to a specific workspace's sign-in: the
	// `team` hint is ignored unless the browser already has a session for that
	// workspace. Surfacing the workspace URL on the gate lets a stranger
	// establish that session first, after which the normal button drops them
	// straight in. Empty = no link shown.
	WorkspaceURL string
}

// AuthConfig groups every login backend plus the session signing key. BaseURL
// is the absolute origin OAuth callbacks are built from (e.g.
// "https://peacha.example"); when empty it's derived per-request from the Host
// header and X-Forwarded-Proto, which works behind a normal reverse proxy.
type AuthConfig struct {
	BaseURL    string
	SessionKey []byte
	Slack      ProviderConfig
	Google     ProviderConfig
	GitHub     ProviderConfig
}

// SessionUser is the identity carried in the signed session cookie and returned
// (in part) by GET /v1/auth/me. To minimise PII we carry NO name/email/picture -
// only Sub, the provider-namespaced subject ("slack:U…", "google:…",
// "github:123"), plus the provider label for the SPA's "signed in" affordance.
// Sub is namespaced so identities can't collide across backends, and it never
// leaves the server (publicUser exposes only the provider).
type SessionUser struct {
	Sub      string `json:"sub"`
	Provider string `json:"provider,omitempty"`
	Exp      int64  `json:"exp"` // unix expiry; checked on read
}

// provider is one configured backend: its OAuth endpoints, the scopes to
// request, and a fetchUser closure that turns an access token into a
// (restriction-checked) SessionUser. The differences between Slack/Google/
// GitHub live entirely in fetchUser.
type provider struct {
	name      string
	cfg       ProviderConfig
	authURL   string
	tokenURL  string
	scopes    string
	fetchUser func(a *Authenticator, accessToken, restrict string) (*SessionUser, error)
}

// Authenticator implements the OAuth login flow for every configured provider
// and a stateless, HMAC-signed session cookie (no server-side session store).
type Authenticator struct {
	cfg       AuthConfig
	client    *http.Client
	providers map[string]*provider
	order     []string // stable provider order for the SPA's login buttons
}

func newAuthenticator(cfg AuthConfig) *Authenticator {
	a := &Authenticator{
		cfg:       cfg,
		client:    &http.Client{Timeout: 10 * time.Second},
		providers: map[string]*provider{},
	}
	// A provider is only enabled when it has credentials AND we have a key to
	// sign sessions with (otherwise the cookie wouldn't be tamper-proof).
	add := func(name string, pc ProviderConfig, authURL, tokenURL, scopes string, fetch func(*Authenticator, string, string) (*SessionUser, error)) {
		if pc.ClientID == "" || pc.ClientSecret == "" || len(cfg.SessionKey) == 0 {
			return
		}
		a.providers[name] = &provider{name: name, cfg: pc, authURL: authURL, tokenURL: tokenURL, scopes: scopes, fetchUser: fetch}
		a.order = append(a.order, name)
	}
	// Scopes are minimised to PII-free: `openid` yields only the subject (+ the
	// team/hosted-domain claims used for the membership gate); we never request
	// `profile`/`email`. GitHub gets only `read:org` (org-membership gate); the
	// numeric user id we key on comes from /user, which needs no scope.
	add("slack", cfg.Slack,
		"https://slack.com/openid/connect/authorize",
		"https://slack.com/api/openid.connect.token",
		"openid", fetchSlackUser)
	add("google", cfg.Google,
		"https://accounts.google.com/o/oauth2/v2/auth",
		"https://oauth2.googleapis.com/token",
		"openid", fetchGoogleUser)
	add("github", cfg.GitHub,
		"https://github.com/login/oauth/authorize",
		"https://github.com/login/oauth/access_token",
		"read:org", fetchGitHubUser)
	return a
}

// enabled reports whether any login backend is configured. When false the
// exam-grade route runs ungated and the SPA hides the login affordance.
func (a *Authenticator) enabled() bool { return len(a.providers) > 0 }

// providerNames returns the enabled providers in a stable order for the SPA.
func (a *Authenticator) providerNames() []string { return a.order }

// workspaceURLs maps each enabled provider that has one configured to its
// pre-OAuth workspace sign-in/join link (see ProviderConfig.WorkspaceURL). The
// SPA renders these on the gate so logged-out users can establish a workspace
// session first. Returns nil when none are set.
func (a *Authenticator) workspaceURLs() map[string]string {
	var m map[string]string
	for _, name := range a.order {
		if u := a.providers[name].cfg.WorkspaceURL; u != "" {
			if m == nil {
				m = map[string]string{}
			}
			m[name] = u
		}
	}
	return m
}

// baseURL is the origin callbacks are built from: the configured BaseURL, else
// derived from the request (Host + scheme, honouring X-Forwarded-Proto).
func (a *Authenticator) baseURL(r *http.Request) string {
	if a.cfg.BaseURL != "" {
		return strings.TrimRight(a.cfg.BaseURL, "/")
	}
	scheme := "http"
	if r.TLS != nil {
		scheme = "https"
	}
	if xf := r.Header.Get("X-Forwarded-Proto"); xf != "" {
		scheme = xf
	}
	return scheme + "://" + r.Host
}

func (a *Authenticator) redirectURL(r *http.Request, providerName string) string {
	return a.baseURL(r) + "/v1/auth/callback/" + providerName
}

func (a *Authenticator) secure(r *http.Request) bool {
	return strings.HasPrefix(a.baseURL(r), "https://")
}

// authConfig - GET /v1/auth/config. Tells the SPA which login buttons to show
// and (when signed in) who the current user is.
func (h *Handler) authConfig(w http.ResponseWriter, r *http.Request) {
	resp := map[string]any{
		"enabled":   h.auth.enabled(),
		"providers": h.auth.providerNames(),
		// Optional per-provider "sign in to the workspace first" links (Slack
		// can't deep-link a logged-out user to a specific workspace). Omitted
		// when none are configured.
		"workspaceUrls": h.auth.workspaceURLs(),
		// Days a recorded pass is retained before automatic deletion (0 = forever).
		// The SPA renders this in the sign-in privacy notice so it can't drift from
		// the server's actual --results-retention-days setting.
		"retentionDays": h.results.retentionDays(),
		// Admin-set: whether the exam pane auto-advances to the next exam after a
		// pass (--exam-auto-advance / EXAM_AUTO_ADVANCE). Not learner-controllable.
		"examAutoAdvance": h.examAutoAdvance,
	}
	if u, _ := h.auth.user(r); u != nil {
		resp["user"] = publicUser(u)
	}
	writeJSON(w, resp)
}

// authMe - GET /v1/auth/me. Returns {authenticated, provider} (no PII).
func (h *Handler) authMe(w http.ResponseWriter, r *http.Request) {
	u, _ := h.auth.user(r)
	if u == nil {
		writeJSON(w, map[string]any{"authenticated": false})
		return
	}
	resp := publicUser(u)
	resp["authenticated"] = true
	writeJSON(w, resp)
}

func publicUser(u *SessionUser) map[string]any {
	return map[string]any{"provider": u.Provider}
}

// authLogin - GET /v1/auth/login/{provider}. Mints a random state, stashes it in
// a short-lived cookie (CSRF defense), and redirects to the provider.
func (h *Handler) authLogin(w http.ResponseWriter, r *http.Request) {
	p := h.auth.providers[r.PathValue("provider")]
	if p == nil {
		http.Error(w, "unknown or unconfigured login provider", http.StatusNotFound)
		return
	}
	state, err := randToken()
	if err != nil {
		http.Error(w, "state: "+err.Error(), http.StatusInternalServerError)
		return
	}
	http.SetCookie(w, &http.Cookie{
		Name:     stateCookie,
		Value:    state,
		Path:     "/v1/auth/",
		MaxAge:   600,
		HttpOnly: true,
		Secure:   h.auth.secure(r),
		SameSite: http.SameSiteLaxMode,
	})
	// Remember a popup login so the callback (which only sees its own URL) knows
	// to return the postMessage closer instead of redirecting the whole page.
	if r.URL.Query().Get("popup") == "1" {
		http.SetCookie(w, &http.Cookie{
			Name:     popupCookie,
			Value:    "1",
			Path:     "/v1/auth/",
			MaxAge:   600,
			HttpOnly: true,
			Secure:   h.auth.secure(r),
			SameSite: http.SameSiteLaxMode,
		})
	}
	q := url.Values{}
	q.Set("response_type", "code")
	q.Set("scope", p.scopes)
	q.Set("client_id", p.cfg.ClientID)
	q.Set("redirect_uri", h.auth.redirectURL(r, p.name))
	q.Set("state", state)
	// Provider-specific hints that pre-scope the consent screen to the
	// configured workspace/domain (best-effort; the callback enforces for real).
	switch p.name {
	case "slack":
		// Slack's `team` hint must be a workspace *id* (T0…), not a subdomain;
		// passing a subdomain does nothing. And when a valid id is sent for a
		// workspace the browser is already signed into, Slack skips the picker
		// and logs the user straight in - so someone in several workspaces can't
		// switch to the right one. Forward it only when Restrict is a team id;
		// otherwise omit it so Slack shows the workspace chooser (the callback
		// still enforces Restrict server-side either way).
		if strings.HasPrefix(p.cfg.Restrict, "T") {
			q.Set("team", p.cfg.Restrict)
		}
	case "google":
		if p.cfg.Restrict != "" {
			q.Set("hd", p.cfg.Restrict)
		}
	}
	http.Redirect(w, r, p.authURL+"?"+q.Encode(), http.StatusFound)
}

// authCallback - GET /v1/auth/callback/{provider}. Verifies state, exchanges the
// code, fetches + restriction-checks the identity, sets the session cookie, and
// redirects back to the SPA.
func (h *Handler) authCallback(w http.ResponseWriter, r *http.Request) {
	p := h.auth.providers[r.PathValue("provider")]
	if p == nil {
		http.Error(w, "unknown or unconfigured login provider", http.StatusNotFound)
		return
	}
	// A popup login is finished by messaging the opener rather than redirecting;
	// the hint rides a cookie set by authLogin (the callback URL is opaque here).
	popup := false
	if c, err := r.Cookie(popupCookie); err == nil && c.Value == "1" {
		popup = true
	}

	st, err := r.Cookie(stateCookie)
	if err != nil || st.Value == "" || subtle.ConstantTimeCompare([]byte(st.Value), []byte(r.URL.Query().Get("state"))) != 1 {
		h.auth.finishLogin(w, r, popup, http.StatusBadRequest, "invalid oauth state")
		return
	}
	clearCookie(w, stateCookie, "/v1/auth/", h.auth.secure(r))

	code := r.URL.Query().Get("code")
	if code == "" {
		h.auth.finishLogin(w, r, popup, http.StatusBadRequest, "missing code")
		return
	}
	token, err := h.auth.exchange(r, p, code)
	if err != nil {
		h.auth.finishLogin(w, r, popup, http.StatusBadGateway, "login failed: "+err.Error())
		return
	}
	user, err := p.fetchUser(h.auth, token, p.cfg.Restrict)
	if err != nil {
		h.auth.finishLogin(w, r, popup, http.StatusForbidden, "login failed: "+err.Error())
		return
	}
	user.Provider = p.name
	user.Exp = time.Now().Add(sessionTTL).Unix()

	cookieVal, err := h.auth.sign(user)
	if err != nil {
		h.auth.finishLogin(w, r, popup, http.StatusInternalServerError, "session: "+err.Error())
		return
	}
	http.SetCookie(w, &http.Cookie{
		Name:     sessionCookie,
		Value:    cookieVal,
		Path:     "/",
		MaxAge:   int(sessionTTL.Seconds()),
		HttpOnly: true,
		Secure:   h.auth.secure(r),
		SameSite: http.SameSiteLaxMode,
	})
	h.auth.finishLogin(w, r, popup, 0, "")
}

// finishLogin terminates the OAuth callback. A normal full-page login redirects
// to the SPA on success or writes an http.Error on failure. A popup login
// (popupCookie set) instead always returns a tiny HTML page that postMessages
// the outcome to window.opener: on success the opener closes the popup; on
// failure the message stays on screen so the user can read why (e.g. a
// workspace-restriction rejection). errMsg == "" means success.
func (a *Authenticator) finishLogin(w http.ResponseWriter, r *http.Request, popup bool, status int, errMsg string) {
	if !popup {
		if errMsg != "" {
			http.Error(w, errMsg, status)
			return
		}
		http.Redirect(w, r, "/", http.StatusFound)
		return
	}
	clearCookie(w, popupCookie, "/v1/auth/", a.secure(r))
	// JSON-encode the message so it's a safe JS string literal; the opener
	// validates event.origin, so location.origin is the correct postMessage
	// target. The text is set via textContent (no HTML injection).
	msgJSON, _ := json.Marshal(errMsg)
	ok := "true"
	if errMsg != "" {
		ok = "false"
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	_, _ = w.Write([]byte(`<!doctype html><html><head><meta charset="utf-8"><title>Sign in</title></head>` +
		`<body style="font:14px system-ui,sans-serif;margin:2.5rem;text-align:center;color:#333">` +
		`<p id="m">Signing you in…</p><script>(function(){var ok=` + ok + `,msg=` + string(msgJSON) + `;` +
		`try{if(window.opener)window.opener.postMessage({type:"peacha-auth",ok:ok,error:msg},location.origin);}catch(e){}` +
		`document.getElementById("m").textContent=ok?"Signed in. You can close this window.":(msg||"Sign in failed.");})();` +
		`</script></body></html>`))
}

// authLogout - POST /v1/auth/logout. Clears the session cookie.
func (h *Handler) authLogout(w http.ResponseWriter, r *http.Request) {
	clearCookie(w, sessionCookie, "/", h.auth.secure(r))
	w.WriteHeader(http.StatusNoContent)
}

// exchange swaps an authorization code for an access token. Sends Accept: JSON
// so GitHub returns JSON (it defaults to urlencoded); Slack/Google ignore it.
func (a *Authenticator) exchange(r *http.Request, p *provider, code string) (string, error) {
	form := url.Values{}
	form.Set("client_id", p.cfg.ClientID)
	form.Set("client_secret", p.cfg.ClientSecret)
	form.Set("code", code)
	form.Set("grant_type", "authorization_code")
	form.Set("redirect_uri", a.redirectURL(r, p.name))

	req, _ := http.NewRequest(http.MethodPost, p.tokenURL, strings.NewReader(form.Encode()))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Accept", "application/json")
	res, err := a.client.Do(req)
	if err != nil {
		return "", err
	}
	defer res.Body.Close()
	var tok struct {
		AccessToken string `json:"access_token"`
		Error       string `json:"error"`
		ErrorDesc   string `json:"error_description"`
	}
	if err := json.NewDecoder(res.Body).Decode(&tok); err != nil {
		return "", err
	}
	if tok.AccessToken == "" {
		msg := tok.ErrorDesc
		if msg == "" {
			msg = tok.Error
		}
		if msg == "" {
			msg = "token exchange returned no access_token"
		}
		return "", errors.New(msg)
	}
	return tok.AccessToken, nil
}

// getJSON does an authorized GET and decodes the JSON body into out.
func (a *Authenticator) getJSON(rawURL, accessToken, accept string, out any) error {
	req, _ := http.NewRequest(http.MethodGet, rawURL, nil)
	req.Header.Set("Authorization", "Bearer "+accessToken)
	if accept != "" {
		req.Header.Set("Accept", accept)
	}
	res, err := a.client.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode/100 != 2 {
		return errors.New(rawURL + ": " + res.Status)
	}
	return json.NewDecoder(res.Body).Decode(out)
}

// --- Per-provider identity fetchers ---------------------------------------

func fetchSlackUser(a *Authenticator, accessToken, restrict string) (*SessionUser, error) {
	// team_id / team_domain ship with the `openid` scope (they're identity-context
	// claims, not the profile/email claims we deliberately don't request).
	var info struct {
		OK         bool   `json:"ok"`
		Error      string `json:"error"`
		Sub        string `json:"sub"`
		TeamID     string `json:"https://slack.com/team_id"`
		TeamDomain string `json:"https://slack.com/team_domain"`
	}
	if err := a.getJSON("https://slack.com/api/openid.connect.userInfo", accessToken, "", &info); err != nil {
		return nil, err
	}
	if !info.OK {
		if info.Error == "" {
			info.Error = "userinfo returned ok=false"
		}
		return nil, errors.New(info.Error)
	}
	if restrict != "" && restrict != info.TeamID && restrict != info.TeamDomain {
		return nil, errors.New("login is restricted to the " + restrict + " Slack workspace")
	}
	return &SessionUser{Sub: "slack:" + info.Sub}, nil
}

func fetchGoogleUser(a *Authenticator, accessToken, restrict string) (*SessionUser, error) {
	var info struct {
		Sub string `json:"sub"`
		HD  string `json:"hd"` // hosted (Workspace) domain
	}
	if err := a.getJSON("https://openidconnect.googleapis.com/v1/userinfo", accessToken, "", &info); err != nil {
		return nil, err
	}
	if restrict != "" && !strings.EqualFold(restrict, info.HD) {
		return nil, errors.New("login is restricted to the " + restrict + " Google Workspace domain")
	}
	return &SessionUser{Sub: "google:" + info.Sub}, nil
}

func fetchGitHubUser(a *Authenticator, accessToken, restrict string) (*SessionUser, error) {
	const accept = "application/vnd.github+json"
	// We read only the numeric id (the stable, PII-free subject). No /user/emails
	// call and no name/avatar - those aren't collected.
	var u struct {
		ID int64 `json:"id"`
	}
	if err := a.getJSON("https://api.github.com/user", accessToken, accept, &u); err != nil {
		return nil, err
	}
	// Org restriction: the user must be a member of the configured org.
	if restrict != "" {
		var orgs []struct {
			Login string `json:"login"`
		}
		if err := a.getJSON("https://api.github.com/user/orgs", accessToken, accept, &orgs); err != nil {
			return nil, err
		}
		member := false
		for _, o := range orgs {
			if strings.EqualFold(o.Login, restrict) {
				member = true
				break
			}
		}
		if !member {
			return nil, errors.New("login is restricted to members of the " + restrict + " GitHub organization")
		}
	}
	return &SessionUser{Sub: "github:" + strconv.FormatInt(u.ID, 10)}, nil
}

// --- Session cookie (HMAC-signed, stateless) ------------------------------

// sign serialises the user to a signed cookie value: base64url(json).base64url(hmac).
func (a *Authenticator) sign(u *SessionUser) (string, error) {
	payload, err := json.Marshal(u)
	if err != nil {
		return "", err
	}
	body := base64.RawURLEncoding.EncodeToString(payload)
	return body + "." + base64.RawURLEncoding.EncodeToString(a.mac(body)), nil
}

// user reads and verifies the session cookie, returning the identity or nil.
// A missing, malformed, tampered, or expired cookie yields (nil, nil).
func (a *Authenticator) user(r *http.Request) (*SessionUser, error) {
	if !a.enabled() {
		return nil, nil
	}
	c, err := r.Cookie(sessionCookie)
	if err != nil || c.Value == "" {
		return nil, nil
	}
	body, sig, ok := strings.Cut(c.Value, ".")
	if !ok {
		return nil, nil
	}
	want, err := base64.RawURLEncoding.DecodeString(sig)
	if err != nil || !hmac.Equal(want, a.mac(body)) {
		return nil, nil
	}
	payload, err := base64.RawURLEncoding.DecodeString(body)
	if err != nil {
		return nil, nil
	}
	var u SessionUser
	if json.Unmarshal(payload, &u) != nil {
		return nil, nil
	}
	if u.Exp != 0 && time.Now().Unix() > u.Exp {
		return nil, nil
	}
	return &u, nil
}

func (a *Authenticator) mac(body string) []byte {
	m := hmac.New(sha256.New, a.cfg.SessionKey)
	m.Write([]byte(body))
	return m.Sum(nil)
}

func clearCookie(w http.ResponseWriter, name, path string, secure bool) {
	http.SetCookie(w, &http.Cookie{
		Name:     name,
		Value:    "",
		Path:     path,
		MaxAge:   -1,
		HttpOnly: true,
		Secure:   secure,
		SameSite: http.SameSiteLaxMode,
	})
}

func randToken() (string, error) {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
}
