package server

import (
	"crypto/subtle"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/nakhasolution/weedingnakha/backend/internal/audit"
	"github.com/nakhasolution/weedingnakha/backend/internal/security"
	"github.com/nakhasolution/weedingnakha/backend/internal/store"
)

const (
	cookieAdmin   = "nk_admin"
	cookieHost    = "nk_host"
	cookieGuest   = "nk_guest"
	cookieDisplay = "nk_display"
)

// Session cookies are "{event_id}.{random}". The whole value is hashed for
// lookup; the prefix only tells the server which event file to open, and is
// re-checked against the stored session's event.
func newScopedToken(eventID string) string { return eventID + "." + security.RandomToken(32) }

func scopedEvent(tok string) (string, bool) {
	id, rest, ok := strings.Cut(tok, ".")
	if !ok || len(rest) < 40 || !store.ValidEventID(id) {
		return "", false
	}
	return id, true
}

// actor identifies who performs an action (for authorization + audit).
type actor struct {
	Type audit.ActorType
	ID   string
}

func (s *Server) logAudit(a actor, eventID, action, target string, meta map[string]string) {
	if s.audit == nil {
		return
	}
	s.audit.Write(audit.Entry{ActorType: a.Type, ActorID: a.ID, EventID: eventID, Action: action, TargetID: target, Metadata: meta})
}

// ---------- Photobooth availability ----------

type boothState struct {
	Open     bool      `json:"open"`
	Code     string    `json:"code,omitempty"`
	Message  string    `json:"message,omitempty"`
	OpensAt  time.Time `json:"opensAt"`
	ClosesAt time.Time `json:"closesAt"`
}

// booth decides whether guests may check in / upload right now. This is the
// single source of truth used by check-in, upload authorize and complete.
func (s *Server) booth(ev store.Event) boothState {
	now := s.now()
	st := boothState{OpensAt: ev.StartAt.Add(-s.cfg.WindowBefore), ClosesAt: ev.EndAt.Add(s.cfg.WindowAfter)}
	switch {
	case ev.Status == store.StatusPaused:
		st.Code, st.Message = "EVENT_PAUSED", "Photobooth sedang dijeda oleh tuan rumah."
	case ev.Status == store.StatusEnded:
		st.Code, st.Message = "EVENT_ENDED", "Acara telah selesai. Terima kasih!"
	case ev.Status != store.StatusActive:
		st.Code, st.Message = "EVENT_NOT_ACTIVE", "Photobooth belum dibuka untuk acara ini."
	case !ev.LocationSet && !s.cfg.GeofenceOff:
		st.Code, st.Message = "LOCATION_NOT_CONFIGURED", "Lokasi acara belum diatur oleh penyelenggara."
	case now.Before(st.OpensAt):
		st.Code, st.Message = "EVENT_NOT_STARTED", fmt.Sprintf("Photobooth dibuka mulai %s.", st.OpensAt.In(store.EventLocation).Format("02 Jan 2006 15:04"))
	case !now.Before(st.ClosesAt):
		st.Code, st.Message = "EVENT_ENDED", "Waktu photobooth untuk acara ini sudah berakhir."
	default:
		st.Open = true
	}
	return st
}

// ---------- Admin ----------

type attempt struct {
	count int
	until time.Time
}

func (s *Server) adminLogin(w http.ResponseWriter, r *http.Request) {
	ip := s.clientIP(r)
	if ok, wait := s.rl.login.Allow(ip); !ok {
		writeRateLimited(w, wait)
		return
	}
	if blocked, wait := s.tooManyAttempts(ip); blocked {
		writeRateLimited(w, wait)
		return
	}
	var in struct {
		PIN string `json:"pin"`
	}
	if !decodeJSON(w, r, &in, 1024) {
		return
	}
	ipHash := security.HashToken(ip)[:12]
	if subtle.ConstantTimeCompare([]byte(in.PIN), []byte(s.cfg.AdminPIN)) != 1 || in.PIN == "" {
		s.recordAttempt(ip, false)
		s.logAudit(actor{audit.ActorAdmin, "unknown"}, "", "admin.login_failed", "", map[string]string{"ipHash": ipHash})
		writeErr(w, http.StatusUnauthorized, "INVALID_PIN", "PIN salah.")
		return
	}
	s.recordAttempt(ip, true)
	tok := security.RandomToken(32)
	sess := store.AdminSession{ID: store.NewID(), TokenHash: security.HashToken(tok), ExpiresAt: s.now().Add(s.cfg.AdminSessionTTL)}
	if err := s.store.CreateAdminSession(sess); err != nil {
		writeErr(w, http.StatusInternalServerError, "INTERNAL", "Gagal membuat sesi.")
		return
	}
	s.setCookie(w, cookieAdmin, tok, sess.ExpiresAt, http.SameSiteStrictMode)
	s.logAudit(actor{audit.ActorAdmin, sess.ID}, "", "admin.login", "", map[string]string{"ipHash": ipHash})
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "expiresAt": sess.ExpiresAt})
}

func (s *Server) adminLogout(w http.ResponseWriter, r *http.Request) {
	if tok := cookieValue(r, cookieAdmin); tok != "" {
		s.store.DeleteAdminSession(security.HashToken(tok))
	}
	s.clearCookie(w, cookieAdmin)
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) requireAdmin(next func(http.ResponseWriter, *http.Request, actor)) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if ok, wait := s.rl.admin.Allow(s.clientIP(r)); !ok {
			writeRateLimited(w, wait)
			return
		}
		tok := cookieValue(r, cookieAdmin)
		if tok == "" {
			writeErr(w, http.StatusUnauthorized, "ADMIN_SESSION_REQUIRED", "Sesi admin tidak valid. Silakan login ulang.")
			return
		}
		sess, err := s.store.AdminSessionByHash(security.HashToken(tok))
		if err != nil || !s.now().Before(sess.ExpiresAt) {
			s.clearCookie(w, cookieAdmin)
			writeErr(w, http.StatusUnauthorized, "ADMIN_SESSION_REQUIRED", "Sesi admin tidak valid. Silakan login ulang.")
			return
		}
		next(w, r, actor{audit.ActorAdmin, sess.ID})
	}
}

func (s *Server) tooManyAttempts(ip string) (bool, time.Duration) {
	s.attemptsMu.Lock()
	defer s.attemptsMu.Unlock()
	a := s.attempts[ip]
	if a != nil && s.now().Before(a.until) {
		return true, a.until.Sub(s.now())
	}
	return false, 0
}

// recordAttempt adds an escalating lockout after 5 wrong PINs.
func (s *Server) recordAttempt(ip string, success bool) {
	s.attemptsMu.Lock()
	defer s.attemptsMu.Unlock()
	if success {
		delete(s.attempts, ip)
		return
	}
	a := s.attempts[ip]
	if a == nil || s.now().After(a.until.Add(10*time.Minute)) {
		a = &attempt{}
		s.attempts[ip] = a
	}
	a.count++
	if a.count >= 5 {
		a.until = s.now().Add(time.Duration(a.count-4) * 30 * time.Second)
	}
}

// ---------- Host ----------

// hostAccess exchanges the one-time-shown host token for an HttpOnly session
// cookie, then redirects to a clean URL so the token leaves the address bar,
// browser history and any Referer header.
func (s *Server) hostAccess(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Referrer-Policy", "no-referrer")
	w.Header().Set("Cache-Control", "no-store")
	ip := s.clientIP(r)
	if ok, _ := s.rl.hostAccess.Allow(ip); !ok {
		http.Redirect(w, r, "/host/?error=rate", http.StatusSeeOther)
		return
	}
	tok := r.URL.Query().Get("token")
	if len(tok) < 40 || len(tok) > 128 {
		http.Redirect(w, r, "/host/?error=invalid", http.StatusSeeOther)
		return
	}
	ev, err := s.store.EventByHostTokenHash(security.HashToken(tok))
	if err != nil {
		s.logAudit(actor{audit.ActorHost, "unknown"}, "", "host.access_denied", "", map[string]string{"ipHash": security.HashToken(ip)[:12]})
		http.Redirect(w, r, "/host/?error=invalid", http.StatusSeeOther)
		return
	}
	sessTok := newScopedToken(ev.ID)
	hs := store.HostSession{
		ID:               store.NewID(),
		EventID:          ev.ID,
		TokenHash:        security.HashToken(sessTok),
		HostTokenVersion: ev.HostTokenVersion,
		ExpiresAt:        s.now().Add(s.cfg.HostSessionTTL),
	}
	if err := s.store.CreateHostSession(hs); err != nil {
		http.Redirect(w, r, "/host/?error=server", http.StatusSeeOther)
		return
	}
	s.setCookie(w, cookieHost, sessTok, hs.ExpiresAt, http.SameSiteLaxMode)
	s.logAudit(actor{audit.ActorHost, hs.ID}, ev.ID, "host.login", "", nil)
	http.Redirect(w, r, "/host/", http.StatusSeeOther)
}

func (s *Server) hostLogout(w http.ResponseWriter, r *http.Request) {
	if tok := cookieValue(r, cookieHost); tok != "" {
		if eid, ok := scopedEvent(tok); ok {
			s.store.DeleteHostSession(eid, security.HashToken(tok))
		}
	}
	s.clearCookie(w, cookieHost)
	w.WriteHeader(http.StatusNoContent)
}

var errNoSession = errors.New("no session")

// hostFromRequest validates the host cookie against the event's current
// host-token version, so revoking/regenerating the token kills old sessions.
func (s *Server) hostFromRequest(r *http.Request) (store.HostSession, store.Event, error) {
	eid, ok := scopedEvent(cookieValue(r, cookieHost))
	if !ok {
		return store.HostSession{}, store.Event{}, errNoSession
	}
	hs, err := s.store.HostSessionByHash(eid, security.HashToken(cookieValue(r, cookieHost)))
	if err != nil || hs.EventID != eid || !s.now().Before(hs.ExpiresAt) {
		return store.HostSession{}, store.Event{}, errNoSession
	}
	ev, err := s.store.Event(hs.EventID)
	if err != nil || ev.HostTokenRevokedAt != nil || ev.HostTokenVersion != hs.HostTokenVersion {
		return store.HostSession{}, store.Event{}, errNoSession
	}
	return hs, ev, nil
}

func (s *Server) requireHost(next func(http.ResponseWriter, *http.Request, actor, store.Event)) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		hs, ev, err := s.hostFromRequest(r)
		if err != nil {
			s.clearCookie(w, cookieHost)
			writeErr(w, http.StatusUnauthorized, "HOST_SESSION_REQUIRED", "Sesi tuan rumah tidak valid atau sudah dicabut. Buka kembali link akses dari admin.")
			return
		}
		if ok, wait := s.rl.host.Allow(hs.ID); !ok {
			writeRateLimited(w, wait)
			return
		}
		next(w, r, actor{audit.ActorHost, hs.ID}, ev)
	}
}

// ---------- Display (Live Wall) ----------

type displayClaims struct {
	P string `json:"p"`
	E string `json:"e"`
	V int    `json:"v"`
}

func (s *Server) displayToken(ev store.Event) string {
	tok, _ := s.displaySigner.Sign(displayClaims{P: "display", E: ev.ID, V: ev.DisplayVersion})
	return tok
}

func (s *Server) verifyDisplay(tok string) (store.Event, error) {
	var c displayClaims
	if err := s.displaySigner.Verify(tok, &c); err != nil || c.P != "display" {
		return store.Event{}, errNoSession
	}
	ev, err := s.store.Event(c.E)
	if err != nil || ev.DisplayVersion != c.V {
		return store.Event{}, errNoSession
	}
	return ev, nil
}

// displaySession exchanges a Live Wall link token for a separate, server-side
// read-only display session. It never creates or reuses host sessions.
func (s *Server) displaySession(w http.ResponseWriter, r *http.Request) {
	if ok, wait := s.rl.display.Allow(s.clientIP(r)); !ok {
		writeRateLimited(w, wait)
		return
	}
	var in struct {
		K string `json:"k"`
	}
	if !decodeJSON(w, r, &in, 4096) {
		return
	}
	ev, err := s.verifyDisplay(in.K)
	if err != nil {
		writeErr(w, http.StatusUnauthorized, "DISPLAY_INVALID", "Link Live Wall tidak valid atau sudah diganti.")
		return
	}
	exp := ev.EndAt.Add(7 * 24 * time.Hour)
	if max := s.now().Add(30 * 24 * time.Hour); exp.After(max) || exp.Before(s.now()) {
		exp = s.now().Add(24 * time.Hour)
	}
	tok := newScopedToken(ev.ID)
	if err := s.store.CreateDisplaySession(store.DisplaySession{
		ID: store.NewID(), EventID: ev.ID, TokenHash: security.HashToken(tok),
		DisplayVersion: ev.DisplayVersion, ExpiresAt: exp,
	}); err != nil {
		writeErr(w, http.StatusInternalServerError, "INTERNAL", "Gagal membuat sesi layar.")
		return
	}
	s.setCookie(w, cookieDisplay, tok, exp, http.SameSiteLaxMode)
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

// displayFromRequest validates the display cookie: a DisplaySession of the
// current display version. Host cookies are never consulted here.
func (s *Server) displayFromRequest(r *http.Request) (store.Event, error) {
	tok := cookieValue(r, cookieDisplay)
	eid, ok := scopedEvent(tok)
	if !ok {
		return store.Event{}, errNoSession
	}
	ds, err := s.store.DisplaySessionByHash(eid, security.HashToken(tok))
	if err != nil || ds.EventID != eid || !s.now().Before(ds.ExpiresAt) {
		return store.Event{}, errNoSession
	}
	ev, err := s.store.Event(eid)
	if err != nil || ev.DisplayVersion != ds.DisplayVersion {
		return store.Event{}, errNoSession
	}
	return ev, nil
}

func (s *Server) requireDisplay(next func(http.ResponseWriter, *http.Request, store.Event)) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ev, err := s.displayFromRequest(r)
		if err != nil {
			writeErr(w, http.StatusUnauthorized, "DISPLAY_REQUIRED", "Live Wall hanya dapat dibuka dari link layar acara.")
			return
		}
		next(w, r, ev)
	}
}

// ---------- Guest ----------

// guestFromRequest resolves the guest session cookie. It does not check the
// photobooth state; callers that upload must also check s.booth(ev).
func (s *Server) guestFromRequest(r *http.Request) (store.GuestSession, store.Event, error) {
	tok := cookieValue(r, cookieGuest)
	eid, ok := scopedEvent(tok)
	if !ok {
		return store.GuestSession{}, store.Event{}, errNoSession
	}
	gs, err := s.store.GuestSessionByHash(eid, security.HashToken(tok))
	if err != nil || gs.EventID != eid || gs.RevokedAt != nil || !s.now().Before(gs.ExpiresAt) {
		return store.GuestSession{}, store.Event{}, errNoSession
	}
	ev, err := s.store.Event(gs.EventID)
	if err != nil {
		return store.GuestSession{}, store.Event{}, errNoSession
	}
	return gs, ev, nil
}
