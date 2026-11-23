package server

import (
	"context"
	"errors"
	"fmt"
	"math"
	"net/http"
	"net/url"
	"regexp"
	"time"

	"github.com/nakhasolution/weedingnakha/backend/internal/imageproc"
	"github.com/nakhasolution/weedingnakha/backend/internal/security"
	"github.com/nakhasolution/weedingnakha/backend/internal/storage"
	"github.com/nakhasolution/weedingnakha/backend/internal/store"
)

// ---------- Printable check-in QR ----------
//
// The check-in QR is static so it can be printed (banner, table cards). It is
// bound to one event and its QR version; it carries no expiry because the
// real gates are server-side and checked on every request: event ACTIVE,
// inside the event time window, guest inside the geofence, and max photos
// per device. Rotating the QR version (admin/host "Ganti QR") kills every
// printed copy at once.

const (
	qrPurpose  = "guest_checkin"
	qrAudience = "nakha-photobooth"
)

type qrClaims struct {
	P   string `json:"p"`   // purpose
	Aud string `json:"aud"` // audience
	E   string `json:"e"`   // event id
	V   int    `json:"v"`   // event QR version
}

type qrResponse struct {
	Token string `json:"token"`
	URL   string `json:"url"`
	// The QR only works while the photobooth window is open.
	BoothOpen bool      `json:"boothOpen"`
	OpensAt   time.Time `json:"opensAt"`
	ClosesAt  time.Time `json:"closesAt"`
	// Screens poll this often so a rotated QR shows up without a reload.
	RefreshAfterMs int64 `json:"refreshAfterMs"`
}

// qrToken is deterministic per (event, version): the printed QR never changes
// until the version is rotated.
func (s *Server) qrToken(ev store.Event) string {
	tok, _ := s.qrSigner.Sign(qrClaims{P: qrPurpose, Aud: qrAudience, E: ev.ID, V: ev.QRVersion})
	return tok
}

func (s *Server) issueQR(r *http.Request, ev store.Event) qrResponse {
	st := s.booth(ev)
	return qrResponse{
		Token:          s.qrToken(ev),
		URL:            s.baseURL(r) + "/photobooth/?qr=" + url.QueryEscape(s.qrToken(ev)),
		BoothOpen:      st.Open,
		OpensAt:        st.OpensAt,
		ClosesAt:       st.ClosesAt,
		RefreshAfterMs: (5 * time.Minute).Milliseconds(),
	}
}

// writeQR answers a QR request for host, admin or display callers. The QR is
// available any time (to print ahead of the event); it only works for guests
// while the booth is open.
func (s *Server) writeQR(w http.ResponseWriter, r *http.Request, ev store.Event) {
	writeJSON(w, http.StatusOK, s.issueQR(r, ev))
}

// verifyQR strictly validates signature, purpose, audience, event existence
// and QR version. Status, time window and location are checked by the caller.
func (s *Server) verifyQR(tok string) (store.Event, error) {
	var c qrClaims
	if err := s.qrSigner.Verify(tok, &c); err != nil {
		return store.Event{}, err
	}
	if c.P != qrPurpose || c.Aud != qrAudience || c.E == "" {
		return store.Event{}, security.ErrBadToken
	}
	ev, err := s.store.Event(c.E)
	if err != nil || ev.QRVersion != c.V {
		return store.Event{}, security.ErrBadToken
	}
	return ev, nil
}

// ---------- Location ----------

type locationInput struct {
	Latitude  *float64 `json:"latitude"`
	Longitude *float64 `json:"longitude"`
	Accuracy  *float64 `json:"accuracy"`
	Timestamp int64    `json:"timestamp"` // ms since epoch (Geolocation API)
}

type locErr struct {
	status int
	code   string
	msg    string
}

const outsideMsg = "Photobooth hanya dapat digunakan di area acara."

// checkLocation validates a browser geolocation fix against the event
// geofence and returns the (rounded) distance and accuracy for audit.
// Raw coordinates are discarded after this call.
func (s *Server) checkLocation(ev store.Event, in *locationInput) (int, int, *locErr) {
	if in == nil || in.Latitude == nil || in.Longitude == nil || in.Accuracy == nil {
		return 0, 0, &locErr{http.StatusBadRequest, "LOCATION_REQUIRED", "Izinkan akses lokasi untuk memakai photobooth."}
	}
	lat, lng, acc := *in.Latitude, *in.Longitude, *in.Accuracy
	if !security.ValidCoord(lat, lng) || math.IsNaN(acc) || acc <= 0 {
		return 0, 0, &locErr{http.StatusBadRequest, "LOCATION_REQUIRED", "Data lokasi tidak valid."}
	}
	if acc > s.cfg.MaxGPSAccuracyM {
		return 0, 0, &locErr{http.StatusForbidden, "LOCATION_INACCURATE", "Sinyal lokasi kurang akurat. Aktifkan GPS / mode akurasi tinggi lalu coba lagi."}
	}
	if in.Timestamp > 0 {
		age := s.now().Sub(time.UnixMilli(in.Timestamp))
		if age > 10*time.Minute || age < -10*time.Minute {
			return 0, 0, &locErr{http.StatusForbidden, "LOCATION_STALE", "Data lokasi sudah kedaluwarsa. Coba lagi."}
		}
	}
	if !ev.LocationSet {
		return 0, 0, &locErr{http.StatusForbidden, "LOCATION_NOT_CONFIGURED", "Lokasi acara belum diatur oleh penyelenggara."}
	}
	dist := security.HaversineMeters(ev.VenueLat, ev.VenueLng, lat, lng)
	if dist > float64(ev.RadiusMeters) {
		return int(math.Round(dist)), int(math.Round(acc)), &locErr{http.StatusForbidden, "OUTSIDE_RADIUS", outsideMsg}
	}
	return int(math.Round(dist)), int(math.Round(acc)), nil
}

// ---------- Check-in ----------

var deviceIDRe = regexp.MustCompile(`^[A-Za-z0-9_-]{16,128}$`)

func (s *Server) guestCheckin(w http.ResponseWriter, r *http.Request) {
	if ok, wait := s.rl.checkin.Allow(s.clientIP(r)); !ok {
		writeRateLimited(w, wait)
		return
	}
	var in struct {
		QR       string `json:"qr"`
		DeviceID string `json:"deviceId"`
		locationInput
	}
	if !decodeJSON(w, r, &in, 8192) {
		return
	}
	if ok, wait := s.rl.checkinDev.Allow("dev:" + security.HashToken(in.DeviceID)); !ok {
		writeRateLimited(w, wait)
		return
	}
	ev, err := s.verifyQR(in.QR)
	if err != nil {
		writeErr(w, http.StatusForbidden, "QR_INVALID", "QR tidak valid atau sudah diganti. Scan QR resmi di lokasi acara.")
		return
	}
	if st := s.booth(ev); !st.Open {
		writeJSON(w, http.StatusForbidden, map[string]any{"error": st.Message, "code": st.Code, "booth": st})
		return
	}
	if !deviceIDRe.MatchString(in.DeviceID) {
		writeErr(w, http.StatusBadRequest, "DEVICE_REQUIRED", "Perangkat tidak dikenali. Muat ulang halaman lalu coba lagi.")
		return
	}
	var dist, acc int
	if !s.cfg.GeofenceOff {
		var lerr *locErr
		if dist, acc, lerr = s.checkLocation(ev, &in.locationInput); lerr != nil {
			writeErr(w, lerr.status, lerr.code, lerr.msg)
			return
		}
	}

	tok := newScopedToken(ev.ID)
	exp := s.now().Add(s.cfg.GuestSessionTTL)
	if closes := s.booth(ev).ClosesAt; closes.Before(exp) {
		exp = closes
	}
	gs, err := s.store.CheckinGuest(ev.ID, security.HashToken(ev.ID+":"+in.DeviceID), security.HashToken(tok), exp, dist, acc)
	if errors.Is(err, store.ErrSessionRevoked) {
		writeErr(w, http.StatusForbidden, "SESSION_REVOKED", "Akses perangkat ini ke photobooth telah dicabut.")
		return
	}
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "INTERNAL", "Gagal membuat sesi tamu.")
		return
	}
	s.setCookie(w, cookieGuest, tok, exp, http.SameSiteStrictMode)
	writeJSON(w, http.StatusOK, s.guestView(gs, ev))
}

type guestSessionView struct {
	Event              publicEvent `json:"event"`
	Booth              boothState  `json:"booth"`
	UploadedCount      int         `json:"uploadedCount"`
	ReservedCount      int         `json:"reservedCount"`
	MaxPhotos          int         `json:"maxPhotos"`
	Remaining          int         `json:"remaining"` // photobooth collages left
	MaxMoments         int         `json:"maxMoments"`
	MomentsRemaining   int         `json:"momentsRemaining"`
	LocationValidUntil time.Time   `json:"locationValidUntil"`
	LocationRequired   bool        `json:"locationRequired"`
	ExpiresAt          time.Time   `json:"expiresAt"`
}

func (s *Server) guestView(gs store.GuestSession, ev store.Event) guestSessionView {
	rem := max(0, store.MaxPhotosPerGuest-gs.UploadedCount-gs.ReservedCount)
	momRem := max(0, store.MaxMomentsPerGuest-gs.MomentsUploaded-gs.MomentsReserved)
	locValid := gs.LastLocationCheckAt.Add(s.cfg.LocationMaxAge)
	if s.cfg.GeofenceOff {
		locValid = gs.ExpiresAt
	}
	return guestSessionView{
		Event:              s.publicView(ev),
		Booth:              s.booth(ev),
		UploadedCount:      gs.UploadedCount,
		ReservedCount:      gs.ReservedCount,
		MaxPhotos:          store.MaxPhotosPerGuest,
		Remaining:          rem,
		MaxMoments:         store.MaxMomentsPerGuest,
		MomentsRemaining:   momRem,
		LocationValidUntil: locValid,
		LocationRequired:   !s.cfg.GeofenceOff,
		ExpiresAt:          gs.ExpiresAt,
	}
}

func (s *Server) guestSession(w http.ResponseWriter, r *http.Request) {
	gs, ev, err := s.guestFromRequest(r)
	if err != nil {
		writeErr(w, http.StatusUnauthorized, "SESSION_REQUIRED", "Scan QR di lokasi acara untuk memakai photobooth.")
		return
	}
	writeJSON(w, http.StatusOK, s.guestView(gs, ev))
}

func (s *Server) guestLocation(w http.ResponseWriter, r *http.Request) {
	gs, ev, err := s.guestFromRequest(r)
	if err != nil {
		writeErr(w, http.StatusUnauthorized, "SESSION_REQUIRED", "Scan QR di lokasi acara untuk memakai photobooth.")
		return
	}
	if ok, wait := s.rl.location.Allow(gs.ID); !ok {
		writeRateLimited(w, wait)
		return
	}
	var in locationInput
	if !decodeJSON(w, r, &in, 4096) {
		return
	}
	dist, acc, lerr := s.checkLocation(ev, &in)
	if lerr != nil {
		writeErr(w, lerr.status, lerr.code, lerr.msg)
		return
	}
	gs, err = s.store.TouchGuestLocation(ev.ID, gs.ID, dist, acc)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "INTERNAL", "Gagal menyimpan validasi lokasi.")
		return
	}
	writeJSON(w, http.StatusOK, s.guestView(gs, ev))
}

// ---------- Upload: authorize → PUT to storage → complete ----------

func (s *Server) uploadAuthorize(w http.ResponseWriter, r *http.Request) {
	gs, ev, err := s.guestFromRequest(r)
	if err != nil {
		writeErr(w, http.StatusUnauthorized, "SESSION_REQUIRED", "Sesi photobooth tidak valid. Scan QR di lokasi acara.")
		return
	}
	if ok, wait := s.rl.authorize.Allow(gs.ID); !ok {
		writeRateLimited(w, wait)
		return
	}
	var in struct {
		GuestName   string         `json:"guestName"`
		Wishes      string         `json:"wishes"`
		Filter      string         `json:"filter"`
		Mode        string         `json:"mode"` // "photobooth" (framed collage) or "moment" (plain photo)
		ContentType string         `json:"contentType"`
		Size        int64          `json:"size"`
		Location    *locationInput `json:"location"`
	}
	if !decodeJSON(w, r, &in, 8192) {
		return
	}
	if st := s.booth(ev); !st.Open {
		writeJSON(w, http.StatusForbidden, map[string]any{"error": st.Message, "code": st.Code, "booth": st})
		return
	}
	// Location must be fresh: either supplied now or validated recently.
	if s.cfg.GeofenceOff {
		// location checks disabled for this deployment
	} else if in.Location != nil {
		dist, acc, lerr := s.checkLocation(ev, in.Location)
		if lerr != nil {
			writeErr(w, lerr.status, lerr.code, lerr.msg)
			return
		}
		if gs, err = s.store.TouchGuestLocation(ev.ID, gs.ID, dist, acc); err != nil {
			writeErr(w, http.StatusInternalServerError, "INTERNAL", "Gagal menyimpan validasi lokasi.")
			return
		}
	} else if s.now().Sub(gs.LastLocationCheckAt) > s.cfg.LocationMaxAge {
		writeErr(w, http.StatusPreconditionRequired, "LOCATION_STALE", "Validasi lokasi diperlukan ulang sebelum mengirim foto.")
		return
	}

	guest := clean(in.GuestName, 60)
	wishes := clean(in.Wishes, 500)
	if guest == "" {
		writeErr(w, http.StatusBadRequest, "NAME_REQUIRED", "Nama tamu wajib diisi.")
		return
	}
	if wishes == "" {
		wishes = defaultWishes(ev)
	}
	filter := in.Filter
	if !store.Filters[filter] {
		filter = "none"
	}
	ext, ok := imageproc.AllowedTypes[in.ContentType]
	if !ok {
		writeErr(w, http.StatusUnsupportedMediaType, "TYPE_NOT_ALLOWED", "Format foto harus JPEG atau PNG.")
		return
	}
	if in.Size <= 0 || in.Size > s.cfg.MaxUploadBytes {
		writeErr(w, http.StatusRequestEntityTooLarge, "TOO_LARGE", "Ukuran foto maksimal 10 MB.")
		return
	}

	resID := store.NewID() + store.NewID()
	// The reservation is durably persisted (fsync) inside ReserveUpload,
	// before a presigned URL exists. No store lock is held while presigning
	// or touching R2.
	res, gs, expired, err := s.store.ReserveUpload(ev.ID, gs.ID, store.Reservation{
		ID:          resID,
		ObjectKey:   "events/" + gs.EventID + "/uploads/" + resID + "." + ext,
		ContentType: in.ContentType,
		Size:        in.Size,
		GuestName:   guest,
		Wishes:      wishes,
		Filter:      filter,
		Source:      photoSource(in.Mode),
	}, s.cfg.ReservationTTL, store.QuotaFor(photoSource(in.Mode)))
	for _, x := range expired {
		_ = s.storage.Delete(r.Context(), x.ObjectKey)
	}
	if errors.Is(err, store.ErrQuotaExceeded) {
		msg := fmt.Sprintf("Batas %d kolase photobooth per perangkat sudah tercapai. Terima kasih sudah ikut meramaikan!", store.MaxPhotosPerGuest)
		if photoSource(in.Mode) == store.SourceMoment {
			msg = fmt.Sprintf("Batas %d foto momen per perangkat sudah tercapai. Terima kasih sudah berbagi momen!", store.MaxMomentsPerGuest)
		}
		writeErr(w, http.StatusConflict, "QUOTA_EXCEEDED", msg)
		return
	}
	if err != nil {
		writeErr(w, http.StatusUnauthorized, "SESSION_REQUIRED", "Sesi photobooth tidak valid. Scan QR di lokasi acara.")
		return
	}
	put, err := s.storage.PresignPut(res.ObjectKey, res.ContentType, res.Size, s.cfg.ReservationTTL)
	if err != nil {
		_, _ = s.store.ReleaseReservation(ev.ID, res.ID, gs.ID)
		writeErr(w, http.StatusInternalServerError, "INTERNAL", "Gagal menyiapkan upload.")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"reservationId": res.ID,
		"upload":        put,
		"expiresAt":     res.ExpiresAt,
		"maxBytes":      s.cfg.MaxUploadBytes,
		"session":       s.guestView(gs, ev),
	})
}

func (s *Server) uploadComplete(w http.ResponseWriter, r *http.Request) {
	gs, ev, err := s.guestFromRequest(r)
	if err != nil {
		writeErr(w, http.StatusUnauthorized, "SESSION_REQUIRED", "Sesi photobooth tidak valid. Scan QR di lokasi acara.")
		return
	}
	var in struct {
		ReservationID string `json:"reservationId"`
	}
	if !decodeJSON(w, r, &in, 1024) {
		return
	}
	res, err := s.store.Reservation(ev.ID, in.ReservationID)
	// A reservation of another session (or another event) is reported as
	// not found, never as forbidden, to avoid leaking its existence.
	if err != nil || res.GuestSessionID != gs.ID || res.EventID != ev.ID {
		writeErr(w, http.StatusNotFound, "RESERVATION_NOT_FOUND", "Slot upload tidak ditemukan.")
		return
	}
	if res.Status != store.ResPending {
		writeErr(w, http.StatusConflict, "RESERVATION_CLOSED", "Slot upload ini sudah dipakai atau dibatalkan.")
		return
	}
	reject := func(status int, code, msg string) {
		_, _ = s.store.ReleaseReservation(ev.ID, res.ID, gs.ID)
		_ = s.storage.Delete(context.Background(), res.ObjectKey)
		writeErr(w, status, code, msg)
	}
	if st := s.booth(ev); !st.Open {
		reject(http.StatusForbidden, st.Code, st.Message)
		return
	}
	if !s.now().Before(res.ExpiresAt) {
		reject(http.StatusGone, "RESERVATION_EXPIRED", "Waktu upload habis. Silakan kirim ulang.")
		return
	}
	size, err := s.storage.Stat(r.Context(), res.ObjectKey)
	if errors.Is(err, storage.ErrNotFound) {
		writeErr(w, http.StatusConflict, "UPLOAD_MISSING", "File belum terunggah. Coba lagi.")
		return
	}
	if err != nil {
		writeErr(w, http.StatusBadGateway, "STORAGE", "Penyimpanan foto tidak dapat dihubungi.")
		return
	}
	if size != res.Size || size > s.cfg.MaxUploadBytes {
		reject(http.StatusUnprocessableEntity, "SIZE_MISMATCH", "Ukuran file tidak sesuai.")
		return
	}
	data, err := storage.ReadAll(r.Context(), s.storage, res.ObjectKey, s.cfg.MaxUploadBytes)
	if err != nil {
		reject(http.StatusUnprocessableEntity, "READ_FAILED", "File foto tidak dapat dibaca.")
		return
	}
	info, err := imageproc.Validate(data, res.ContentType)
	if err != nil {
		reject(http.StatusUnprocessableEntity, "INVALID_IMAGE", "File ditolak: "+err.Error()+".")
		return
	}

	approval := store.Approved
	if ev.ModerationMode == store.ManualApproval {
		approval = store.PendingApproval
	}
	p, gs, err := s.store.ConfirmUpload(ev.ID, res.ID, gs.ID, store.Photo{
		ID:        store.NewID(),
		Approval:  approval,
		SHA256:    info.SHA256,
		SizeBytes: size,
		Width:     info.Width,
		Height:    info.Height,
	})
	switch {
	case errors.Is(err, store.ErrDuplicate):
		_ = s.storage.Delete(context.Background(), res.ObjectKey)
		writeErr(w, http.StatusConflict, "DUPLICATE", "Foto yang sama sudah pernah dikirim.")
		return
	case errors.Is(err, store.ErrReservationExpired):
		_ = s.storage.Delete(context.Background(), res.ObjectKey)
		writeErr(w, http.StatusGone, "RESERVATION_EXPIRED", "Waktu upload habis. Silakan kirim ulang.")
		return
	case errors.Is(err, store.ErrReservationState):
		writeErr(w, http.StatusConflict, "RESERVATION_CLOSED", "Slot upload ini sudah dipakai atau dibatalkan.")
		return
	case err != nil:
		writeErr(w, http.StatusInternalServerError, "INTERNAL", "Gagal menyimpan foto.")
		return
	}
	s.enqueue(ev.ID, p.ID)
	s.hub.Publish(ev.ID, "photos.changed", nil)
	writeJSON(w, http.StatusCreated, map[string]any{
		"photo":          map[string]any{"id": p.ID, "status": p.Status, "approval": p.Approval},
		"moderationMode": ev.ModerationMode,
		"session":        s.guestView(gs, ev),
	})
}

func (s *Server) uploadCancel(w http.ResponseWriter, r *http.Request) {
	gs, ev, err := s.guestFromRequest(r)
	if err != nil {
		writeErr(w, http.StatusUnauthorized, "SESSION_REQUIRED", "Sesi photobooth tidak valid.")
		return
	}
	var in struct {
		ReservationID string `json:"reservationId"`
	}
	if !decodeJSON(w, r, &in, 1024) {
		return
	}
	res, err := s.store.ReleaseReservation(ev.ID, in.ReservationID, gs.ID)
	if err == nil {
		_ = s.storage.Delete(r.Context(), res.ObjectKey)
	}
	gs, _ = s.store.GuestSession(ev.ID, gs.ID)
	writeJSON(w, http.StatusOK, s.guestView(gs, ev))
}

// photoSource records which photobooth mode produced an upload; anything
// unknown counts as the framed photobooth collage.
func photoSource(mode string) string {
	if mode == "moment" {
		return "moment"
	}
	return "photobooth"
}

// defaultWishes fills an empty wish: the organiser's own text, else a
// greeting that fits the event type.
func defaultWishes(ev store.Event) string {
	if ev.Wishes != "" {
		return ev.Wishes
	}
	if ev.Kind() == store.TypeWedding {
		return "Selamat menempuh hidup baru!"
	}
	return "Seru banget acaranya!"
}
