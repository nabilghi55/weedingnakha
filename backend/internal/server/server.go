// Package server exposes the wedding REST API, realtime stream and the
// photobooth upload flow. Every sensitive endpoint resolves the caller's
// event from a server-side credential (cookie session or signed token);
// event IDs sent by browsers are never trusted on their own.
package server

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"io"
	"log"
	"net/http"
	"net/url"
	"path"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/nakhasolution/weedingnakha/backend/internal/audit"
	"github.com/nakhasolution/weedingnakha/backend/internal/security"
	"github.com/nakhasolution/weedingnakha/backend/internal/storage"
	"github.com/nakhasolution/weedingnakha/backend/internal/store"
)

type Config struct {
	AdminPIN        string
	Secret          []byte
	AllowedOrigins  []string
	MaxUploadBytes  int64
	StaticDir       string // optional: exported Next.js site (out/) served at /
	PublicBaseURL   string // e.g. https://wedding.example.com (used in QR + host links)
	CookieSecure    bool
	TrustProxy      bool   // honour X-Forwarded-For / X-Forwarded-Proto from a local reverse proxy
	LegacyUploadDir string // v1 public uploads dir, only read for one-time migration

	// AdminPath is the secret URL segment of the admin console (https://site/<AdminPath>/).
	// Every /api/admin/* request must carry it in X-Nakha-Admin-Key, otherwise the
	// API answers 404 as if admin did not exist. "" disables admin completely.
	AdminPath string

	WindowBefore    time.Duration // photobooth opens this long before startAt
	WindowAfter     time.Duration // and closes this long after endAt
	MaxGPSAccuracyM float64
	LocationMaxAge  time.Duration // re-validate location after this
	// GeofenceOff skips every location check (check-in and upload): the QR,
	// the event window and the per-device quota still apply.
	GeofenceOff     bool
	ReservationTTL  time.Duration // ≤ 5 min
	MediaURLTTL     time.Duration
	HostSessionTTL  time.Duration // ≤ 24 h
	AdminSessionTTL time.Duration
	GuestSessionTTL time.Duration

	OrphanGrace         time.Duration // unreferenced objects younger than this are kept (in-flight uploads)
	OrphanSweepInterval time.Duration

	Now func() time.Time
}

func (c *Config) defaults() {
	if c.Now == nil {
		c.Now = time.Now
	}
	if c.MaxUploadBytes <= 0 || c.MaxUploadBytes > 10<<20 {
		c.MaxUploadBytes = 10 << 20
	}
	if c.WindowBefore <= 0 {
		c.WindowBefore = 60 * time.Minute
	}
	if c.WindowAfter <= 0 {
		c.WindowAfter = 60 * time.Minute
	}
	if c.MaxGPSAccuracyM <= 0 {
		c.MaxGPSAccuracyM = 100
	}
	if c.LocationMaxAge <= 0 || c.LocationMaxAge > 15*time.Minute {
		c.LocationMaxAge = 10 * time.Minute
	}
	if c.ReservationTTL <= 0 || c.ReservationTTL > 5*time.Minute {
		c.ReservationTTL = 5 * time.Minute
	}
	if c.MediaURLTTL <= 0 {
		c.MediaURLTTL = 15 * time.Minute
	}
	if c.HostSessionTTL <= 0 || c.HostSessionTTL > 24*time.Hour {
		c.HostSessionTTL = 24 * time.Hour
	}
	if c.AdminSessionTTL <= 0 {
		c.AdminSessionTTL = 12 * time.Hour
	}
	if c.GuestSessionTTL <= 0 {
		c.GuestSessionTTL = 12 * time.Hour
	}
	if c.OrphanGrace < c.ReservationTTL*2 {
		c.OrphanGrace = time.Hour
	}
	if c.OrphanSweepInterval <= 0 {
		c.OrphanSweepInterval = 6 * time.Hour
	}
	c.PublicBaseURL = strings.TrimRight(c.PublicBaseURL, "/")
}

type limiters struct {
	checkin    *security.RateLimiter // per IP (generous: venue Wi-Fi / carrier NAT share one IP)
	checkinDev *security.RateLimiter // per device id
	location   *security.RateLimiter // per guest session
	authorize  *security.RateLimiter // per guest session
	hostAccess *security.RateLimiter // per IP
	login      *security.RateLimiter // per IP
	admin      *security.RateLimiter // per IP, all admin endpoints
	host       *security.RateLimiter // per host session
	like       *security.RateLimiter // per IP
	display    *security.RateLimiter // per IP
}

type Server struct {
	cfg     Config
	store   *store.Store
	storage storage.Storage
	local   *storage.Local // non-nil when the local driver is used
	hub     *Hub
	audit   *audit.Log

	qrSigner      *security.Signer
	displaySigner *security.Signer
	mediaSigner   *security.Signer

	rl limiters

	likes likeBuffer // pending like deltas, flushed in batches

	attemptsMu sync.Mutex
	attempts   map[string]*attempt

	queue chan photoRef
	jobs  sync.WaitGroup
}

func New(cfg Config, st *store.Store, stg storage.Storage, auditLog *audit.Log) *Server {
	cfg.defaults()
	now := cfg.Now
	s := &Server{
		cfg:           cfg,
		store:         st,
		storage:       stg,
		hub:           NewHub(),
		audit:         auditLog,
		qrSigner:      security.NewSigner(cfg.Secret, "qr-guest-checkin"),
		displaySigner: security.NewSigner(cfg.Secret, "display-readonly"),
		mediaSigner:   security.NewSigner(cfg.Secret, "media-url"),
		attempts:      map[string]*attempt{},
		queue:         make(chan photoRef, 1024),
		rl: limiters{
			// mobile carriers (CGNAT) put hundreds of guests at one venue behind a
			// few public IPs; the per-device limit below is the real brake
			checkin:    security.NewRateLimiter(1000, time.Minute, now),
			checkinDev: security.NewRateLimiter(10, time.Minute, now),
			location:   security.NewRateLimiter(10, time.Minute, now),
			authorize:  security.NewRateLimiter(10, time.Minute, now),
			hostAccess: security.NewRateLimiter(5, time.Minute, now),
			login:      security.NewRateLimiter(5, time.Minute, now),
			admin:      security.NewRateLimiter(60, time.Minute, now),
			host:       security.NewRateLimiter(120, time.Minute, now),
			like:       security.NewRateLimiter(1500, time.Minute, now),
			display:    security.NewRateLimiter(30, time.Minute, now),
		},
	}
	if l, ok := stg.(*storage.Local); ok {
		s.local = l
	}
	for i := 0; i < 2; i++ {
		go s.worker()
	}
	return s
}

func (s *Server) now() time.Time { return s.cfg.Now() }

// Start runs background maintenance until ctx is cancelled and resumes any
// photo processing interrupted by a restart.
func (s *Server) Start(ctx context.Context) {
	// Stale reservations from before a crash/restart are released first, so
	// guests get their slots back immediately.
	s.ReleaseExpiredReservations()
	// Resume interrupted processing first; legacy photos get their
	// OriginalKey (and are queued) only inside importLegacy.
	for _, p := range s.store.PhotosToProcess() {
		if p.OriginalKey != "" {
			s.enqueue(p.EventID, p.ID)
		}
	}
	s.importLegacy(ctx)
	go func() {
		// like batches: one store write per event every few seconds
		tick := time.NewTicker(likeFlushInterval)
		defer tick.Stop()
		for {
			select {
			case <-ctx.Done():
				s.FlushLikes()
				return
			case <-tick.C:
				s.FlushLikes()
			}
		}
	}()
	go func() {
		// orphan sweep: once at startup, then periodically
		for {
			sctx, cancel := context.WithTimeout(ctx, 10*time.Minute)
			if n, err := s.SweepOrphans(sctx); err != nil {
				log.Printf("orphan sweep failed: %v", err)
			} else if n > 0 {
				log.Printf("orphan sweep: deleted %d unreferenced objects", n)
			}
			cancel()
			select {
			case <-ctx.Done():
				return
			case <-time.After(s.cfg.OrphanSweepInterval):
			}
		}
	}()
	go func() {
		tick := time.NewTicker(30 * time.Second)
		defer tick.Stop()
		n := 0
		for {
			select {
			case <-ctx.Done():
				return
			case <-tick.C:
				s.ReleaseExpiredReservations()
				if n++; n%20 == 0 {
					s.store.PruneSessions()
				}
			}
		}
	}()
}

// SweepOrphans deletes objects under events/ that no record references
// (failed/abandoned uploads, leftovers of deletes that failed mid-way, ...).
// Objects younger than OrphanGrace are always kept so in-flight uploads and
// photos being processed are never touched. The object list is taken
// *before* the reference snapshot, so anything created in between is simply
// not in the list. No store lock is held during R2 calls.
func (s *Server) SweepOrphans(ctx context.Context) (int, error) {
	objs, err := s.storage.List(ctx, "events/")
	if err != nil {
		return 0, err
	}
	keep := s.store.ReferencedKeys()
	cutoff := s.now().Add(-s.cfg.OrphanGrace)
	n := 0
	for _, o := range objs {
		if keep[o.Key] || !storage.ValidKey(o.Key) || o.LastModified.After(cutoff) {
			continue
		}
		if err := s.storage.Delete(ctx, o.Key); err != nil {
			return n, err
		}
		n++
	}
	if n > 0 {
		s.logAudit(actor{audit.ActorSystem, "janitor"}, "", "storage.orphan_sweep", "", map[string]string{"deleted": itoa(n)})
	}
	return n, nil
}

// ReleaseExpiredReservations frees expired upload slots and deletes any
// partially uploaded objects.
func (s *Server) ReleaseExpiredReservations() {
	for _, r := range s.store.ReleaseExpired() {
		_ = s.storage.Delete(context.Background(), r.ObjectKey)
	}
}

func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()

	mux.HandleFunc("GET /api/health", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, map[string]any{"ok": true})
	})

	// Public (read-only, event-scoped)
	mux.HandleFunc("GET /api/event", s.getDefaultEvent) // backwards compatible alias
	mux.HandleFunc("GET /api/public/event", s.getPublicEvent)
	mux.HandleFunc("GET /api/public/events/{slug}/cover", s.getCover)
	mux.HandleFunc("GET /api/public/events/{slug}/frame", s.getFrame)
	mux.HandleFunc("GET /api/gallery/photos", s.galleryPhotos)
	mux.HandleFunc("GET /api/gallery/photos/{id}", s.galleryPhoto)
	mux.HandleFunc("POST /api/gallery/photos/{id}/like", s.likePhoto)
	mux.HandleFunc("GET /api/stream", s.stream)
	mux.HandleFunc("GET /api/media/{event}/{id}/{variant}", s.media)

	// Old open upload + public files: permanently disabled.
	mux.HandleFunc("POST /api/photos", s.uploadDisabled)
	mux.HandleFunc("GET /api/photos", s.uploadDisabled)
	mux.HandleFunc("GET /uploads/{name}", func(w http.ResponseWriter, r *http.Request) { http.NotFound(w, r) })

	// Guest photobooth flow
	mux.HandleFunc("POST /api/guest/checkin", s.guestCheckin)
	mux.HandleFunc("GET /api/guest/session", s.guestSession)
	mux.HandleFunc("POST /api/guest/location", s.guestLocation)
	mux.HandleFunc("POST /api/guest/upload/authorize", s.uploadAuthorize)
	mux.HandleFunc("POST /api/guest/upload/complete", s.uploadComplete)
	mux.HandleFunc("POST /api/guest/upload/cancel", s.uploadCancel)
	if s.local != nil {
		mux.HandleFunc("PUT "+storage.LocalUploadPath, s.local.HandleUpload)
	}

	// Host (customer) — token exchange, then HttpOnly session
	mux.HandleFunc("GET /host/access", s.hostAccess)
	mux.HandleFunc("GET /api/host/access", s.hostAccess)
	mux.HandleFunc("GET /api/host/me", s.requireHost(s.hostMe))
	mux.HandleFunc("POST /api/host/logout", s.hostLogout)
	mux.HandleFunc("GET /api/host/stats", s.requireHost(s.hostStats))
	mux.HandleFunc("GET /api/host/photos", s.requireHost(s.hostPhotos))
	mux.HandleFunc("GET /api/host/photos/download", s.requireHost(s.hostDownloadZip))
	mux.HandleFunc("POST /api/host/photos/{id}/{action}", s.requireHost(s.hostModerate))
	mux.HandleFunc("DELETE /api/host/photos/{id}", s.requireHost(s.hostDeletePhoto))
	mux.HandleFunc("POST /api/host/event/pause", s.requireHost(s.hostPause))
	mux.HandleFunc("POST /api/host/event/resume", s.requireHost(s.hostResume))
	mux.HandleFunc("PUT /api/host/event/settings", s.requireHost(s.hostSettings))
	mux.HandleFunc("GET /api/host/qr", s.requireHost(s.hostQR))
	mux.HandleFunc("POST /api/host/qr/rotate", s.requireHost(s.hostRotateQR))
	mux.HandleFunc("GET /api/host/display-link", s.requireHost(s.hostDisplayLink))
	mux.HandleFunc("POST /api/host/display-link/rotate", s.requireHost(s.hostRotateDisplay))

	// Live Wall / slideshow — read-only display credential, never the host token
	mux.HandleFunc("POST /api/display/session", s.displaySession)
	mux.HandleFunc("GET /api/display/event", s.requireDisplay(s.displayEvent))
	mux.HandleFunc("GET /api/display/photos", s.requireDisplay(s.displayPhotos))
	mux.HandleFunc("GET /api/display/qr", s.requireDisplay(s.displayQR))

	// Admin
	mux.HandleFunc("POST /api/admin/login", s.adminLogin)
	mux.HandleFunc("POST /api/admin/logout", s.adminLogout)
	mux.HandleFunc("GET /api/admin/me", s.requireAdmin(func(w http.ResponseWriter, r *http.Request, _ actor) {
		writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
	}))
	mux.HandleFunc("GET /api/admin/events", s.requireAdmin(s.adminListEvents))
	mux.HandleFunc("POST /api/admin/events", s.requireAdmin(s.adminCreateEvent))
	mux.HandleFunc("GET /api/admin/events/{id}", s.requireAdmin(s.adminGetEvent))
	mux.HandleFunc("PUT /api/admin/events/{id}", s.requireAdmin(s.adminUpdateEvent))
	mux.HandleFunc("POST /api/admin/events/{id}/default", s.requireAdmin(s.adminSetDefault))
	mux.HandleFunc("POST /api/admin/events/{id}/host-token", s.requireAdmin(s.adminRegenerateHostToken))
	mux.HandleFunc("DELETE /api/admin/events/{id}/host-token", s.requireAdmin(s.adminRevokeHostToken))
	mux.HandleFunc("POST /api/admin/events/{id}/cover", s.requireAdmin(s.adminUploadCover))
	mux.HandleFunc("DELETE /api/admin/events/{id}/cover", s.requireAdmin(s.adminDeleteCover))
	mux.HandleFunc("POST /api/admin/events/{id}/frame", s.requireAdmin(s.adminUploadFrame))
	mux.HandleFunc("DELETE /api/admin/events/{id}/frame", s.requireAdmin(s.adminDeleteFrame))
	mux.HandleFunc("GET /api/admin/events/{id}/photos", s.requireAdmin(s.adminPhotos))
	mux.HandleFunc("GET /api/admin/events/{id}/photos/download", s.requireAdmin(s.adminDownloadZip))
	mux.HandleFunc("POST /api/admin/events/{id}/photos/{pid}/{action}", s.requireAdmin(s.adminModerate))
	mux.HandleFunc("DELETE /api/admin/events/{id}/photos/{pid}", s.requireAdmin(s.adminDeletePhoto))
	mux.HandleFunc("GET /api/admin/events/{id}/stats", s.requireAdmin(s.adminStats))
	mux.HandleFunc("GET /api/admin/events/{id}/qr", s.requireAdmin(s.adminQR))
	mux.HandleFunc("POST /api/admin/events/{id}/qr/rotate", s.requireAdmin(s.adminRotateQR))
	mux.HandleFunc("GET /api/admin/events/{id}/display-link", s.requireAdmin(s.adminDisplayLink))
	mux.HandleFunc("POST /api/admin/events/{id}/display-link/rotate", s.requireAdmin(s.adminRotateDisplay))
	mux.HandleFunc("GET /api/admin/audit", s.requireAdmin(s.adminAudit))

	// Single fallback: unknown /api/* → JSON 404, everything else → static site (if any).
	var static http.Handler = http.NotFoundHandler()
	if s.cfg.StaticDir != "" {
		static = s.staticSite()
	}
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/api/") {
			writeErr(w, http.StatusNotFound, "NOT_FOUND", "Endpoint tidak ditemukan.")
			return
		}
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		static.ServeHTTP(w, r)
	})

	return s.withSecurityHeaders(s.withCORS(s.withCSRF(s.withLogging(s.withAdminGate(mux)))))
}

// AdminKeyHeader carries the secret admin path on every admin API call.
const AdminKeyHeader = "X-Nakha-Admin-Key"

// withAdminGate hides the whole admin API unless the request carries the
// secret admin path: without it /api/admin/* is indistinguishable from an
// unknown endpoint (same 404 body), so the PIN login is not even reachable.
func (s *Server) withAdminGate(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(path.Clean("/"+r.URL.Path)+"/", "/api/admin/") && !s.adminKeyOK(r) {
			if ok, wait := s.rl.admin.Allow(s.clientIP(r)); !ok {
				writeRateLimited(w, wait)
				return
			}
			writeErr(w, http.StatusNotFound, "NOT_FOUND", "Endpoint tidak ditemukan.")
			return
		}
		next.ServeHTTP(w, r)
	})
}

func (s *Server) adminKeyOK(r *http.Request) bool {
	key := r.Header.Get(AdminKeyHeader)
	return s.cfg.AdminPath != "" && key != "" && subtle.ConstantTimeCompare([]byte(key), []byte(s.cfg.AdminPath)) == 1
}

// isAdminAsset reports whether p is any exported file of the /admin page
// (HTML or RSC payload); those are only served under the secret path.
func isAdminAsset(p string) bool {
	if p == "/admin" || strings.HasPrefix(p, "/admin/") || strings.HasPrefix(p, "/admin.") {
		return true
	}
	return strings.Contains(path.Base(p), "__next.admin")
}

func (s *Server) uploadDisabled(w http.ResponseWriter, r *http.Request) {
	writeErr(w, http.StatusGone, "UPLOAD_DISABLED", "Upload bebas sudah dinonaktifkan. Foto hanya dapat dikirim melalui Photobooth di lokasi acara.")
}

// staticSite serves the exported frontend with clean URLs (/gallery → gallery/index.html).
func (s *Server) staticSite() http.Handler {
	root := http.Dir(s.cfg.StaticDir)
	fs := http.FileServer(root)
	exists := func(p string) bool {
		f, err := root.Open(p)
		if err != nil {
			return false
		}
		defer f.Close()
		st, err := f.Stat()
		return err == nil && !st.IsDir()
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p := path.Clean("/" + r.URL.Path)
		if s.cfg.AdminPath != "" && (p == "/"+s.cfg.AdminPath) {
			// the admin console lives only at its secret URL
			if !strings.HasSuffix(r.URL.Path, "/") {
				http.Redirect(w, r, r.URL.Path+"/", http.StatusMovedPermanently)
				return
			}
			w.Header().Set("X-Robots-Tag", "noindex, nofollow")
			w.Header().Set("Referrer-Policy", "no-referrer")
			w.Header().Set("Cache-Control", "no-store")
			if f, err := root.Open("/admin/index.html"); err == nil {
				defer f.Close()
				w.Header().Set("Content-Type", "text/html; charset=utf-8")
				_, _ = io.Copy(w, f)
				return
			}
			p = "/__missing__"
		}
		if isAdminAsset(p) {
			p = "/__missing__" // the public /admin URL does not exist
		}
		if strings.HasPrefix(p, "/_next/static/") {
			w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
		} else {
			// pages & public files: always revalidate (cheap 304 via Last-Modified),
			// so a deploy shows up on the next load instead of a stale cached page
			w.Header().Set("Cache-Control", "no-cache")
		}
		switch {
		case exists(p):
		case exists(p + "/index.html"):
			if !strings.HasSuffix(r.URL.Path, "/") {
				target := r.URL.Path + "/"
				if r.URL.RawQuery != "" {
					target += "?" + r.URL.RawQuery
				}
				http.Redirect(w, r, target, http.StatusMovedPermanently)
				return
			}
		case exists(p + ".html"):
			r.URL.Path = p + ".html"
		default:
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			w.WriteHeader(http.StatusNotFound)
			if f, err := root.Open("/404.html"); err == nil {
				defer f.Close()
				_, _ = io.Copy(w, f)
			}
			return
		}
		fs.ServeHTTP(w, r)
	})
}

// ---------- Middleware ----------

func (s *Server) withSecurityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("X-Frame-Options", "DENY")
		h.Set("Referrer-Policy", "strict-origin-when-cross-origin")
		h.Set("Permissions-Policy", "camera=(self), geolocation=(self), microphone=()")
		if s.cfg.CookieSecure {
			h.Set("Strict-Transport-Security", "max-age=15552000")
		}
		if strings.HasPrefix(r.URL.Path, "/api/") {
			h.Set("Cache-Control", "no-store")
		}
		next.ServeHTTP(w, r)
	})
}

func (s *Server) withCORS(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		origin := r.Header.Get("Origin")
		if origin != "" && s.originAllowed(origin) {
			h := w.Header()
			h.Set("Access-Control-Allow-Origin", origin)
			h.Set("Access-Control-Allow-Credentials", "true")
			h.Add("Vary", "Origin")
			h.Set("Access-Control-Allow-Headers", "Content-Type, X-Nakha-Request, "+AdminKeyHeader)
			h.Set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
		}
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func (s *Server) originAllowed(origin string) bool {
	for _, o := range s.cfg.AllowedOrigins {
		if strings.TrimSpace(o) == origin {
			return true
		}
	}
	if s.cfg.PublicBaseURL != "" && origin == s.cfg.PublicBaseURL {
		return true
	}
	return false
}

// withCSRF protects cookie-authenticated state changes: a custom header
// (which forces a CORS preflight cross-origin) plus an Origin check.
func (s *Server) withCSRF(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodGet, http.MethodHead, http.MethodOptions:
			next.ServeHTTP(w, r)
			return
		}
		if !strings.HasPrefix(r.URL.Path, "/api/") || r.URL.Path == storage.LocalUploadPath {
			next.ServeHTTP(w, r)
			return
		}
		if r.Header.Get("X-Nakha-Request") != "1" {
			writeErr(w, http.StatusForbidden, "CSRF", "Permintaan ditolak.")
			return
		}
		if origin := r.Header.Get("Origin"); origin != "" && !s.originAllowed(origin) && !sameHost(origin, r.Host) {
			writeErr(w, http.StatusForbidden, "CSRF", "Origin tidak diizinkan.")
			return
		}
		next.ServeHTTP(w, r)
	})
}

func sameHost(origin, host string) bool {
	u, err := url.Parse(origin)
	return err == nil && u.Host != "" && strings.EqualFold(u.Host, host)
}

type statusRecorder struct {
	http.ResponseWriter
	status int
}

func (r *statusRecorder) WriteHeader(code int) {
	r.status = code
	r.ResponseWriter.WriteHeader(code)
}

// Flush keeps SSE working through the logging wrapper.
func (r *statusRecorder) Flush() {
	if f, ok := r.ResponseWriter.(http.Flusher); ok {
		f.Flush()
	}
}

func (s *Server) withLogging(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		rec := &statusRecorder{ResponseWriter: w, status: http.StatusOK}
		next.ServeHTTP(rec, r)
		if r.URL.Path != "/api/stream" {
			// Never log query strings: they can carry host/QR/display tokens.
			p := r.URL.Path
			if s.cfg.AdminPath != "" && strings.Contains(p, s.cfg.AdminPath) {
				p = "/<admin>/" // the secret admin URL never goes into logs
			}
			log.Printf("%s %s %d %s", r.Method, p, rec.status, time.Since(start).Round(time.Millisecond))
		}
	})
}

// ---------- Helpers ----------

func clean(s string, max int) string {
	s = strings.TrimSpace(strings.ToValidUTF8(s, ""))
	s = strings.Map(func(r rune) rune {
		if r == '\n' || r == '\t' {
			return r
		}
		if r < 32 || r == 127 {
			return -1
		}
		return r
	}, s)
	if utf8.RuneCountInString(s) > max {
		s = string([]rune(s)[:max])
	}
	return s
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeError(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]string{"error": msg})
}

func writeErr(w http.ResponseWriter, status int, code, msg string) {
	writeJSON(w, status, map[string]string{"error": msg, "code": code})
}

func writeRateLimited(w http.ResponseWriter, wait time.Duration) {
	secs := int(wait.Seconds()) + 1
	w.Header().Set("Retry-After", itoa(secs))
	writeErr(w, http.StatusTooManyRequests, "RATE_LIMITED", "Terlalu banyak permintaan. Coba lagi dalam "+itoa(secs)+" detik.")
}

func decodeJSON(w http.ResponseWriter, r *http.Request, v any, limit int64) bool {
	if err := json.NewDecoder(io.LimitReader(r.Body, limit)).Decode(v); err != nil && !errors.Is(err, io.EOF) {
		writeErr(w, http.StatusBadRequest, "BAD_REQUEST", "Format data tidak valid.")
		return false
	}
	return true
}

func (s *Server) clientIP(r *http.Request) string {
	if s.cfg.TrustProxy {
		// The proxy appends the real client address as the last hop.
		if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
			parts := strings.Split(xff, ",")
			if ip := strings.TrimSpace(parts[len(parts)-1]); ip != "" {
				return ip
			}
		}
	}
	host := r.RemoteAddr
	if i := strings.LastIndex(host, ":"); i > 0 {
		host = host[:i]
	}
	return strings.Trim(host, "[]")
}

// baseURL is the absolute site URL used in QR codes and host/display links.
func (s *Server) baseURL(r *http.Request) string {
	if s.cfg.PublicBaseURL != "" {
		return s.cfg.PublicBaseURL
	}
	scheme := "http"
	if r.TLS != nil || (s.cfg.TrustProxy && r.Header.Get("X-Forwarded-Proto") == "https") {
		scheme = "https"
	}
	if origin := r.Header.Get("Origin"); origin != "" && s.originAllowed(origin) {
		return origin
	}
	return scheme + "://" + r.Host
}

func (s *Server) setCookie(w http.ResponseWriter, name, value string, exp time.Time, ss http.SameSite) {
	http.SetCookie(w, &http.Cookie{
		Name:     name,
		Value:    value,
		Path:     "/",
		Expires:  exp,
		MaxAge:   int(time.Until(exp).Seconds()),
		HttpOnly: true,
		Secure:   s.cfg.CookieSecure,
		SameSite: ss,
	})
}

func (s *Server) clearCookie(w http.ResponseWriter, name string) {
	http.SetCookie(w, &http.Cookie{Name: name, Value: "", Path: "/", MaxAge: -1, HttpOnly: true, Secure: s.cfg.CookieSecure, SameSite: http.SameSiteLaxMode})
}

func cookieValue(r *http.Request, name string) string {
	c, err := r.Cookie(name)
	if err != nil || len(c.Value) > 512 {
		return ""
	}
	return c.Value
}

func itoa(n int) string { return strconv.Itoa(n) }
