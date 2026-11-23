package server

import (
	"context"
	"errors"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/nakhasolution/weedingnakha/backend/internal/audit"
	"github.com/nakhasolution/weedingnakha/backend/internal/imageproc"
	"github.com/nakhasolution/weedingnakha/backend/internal/security"
	"github.com/nakhasolution/weedingnakha/backend/internal/store"
)

type adminEvent struct {
	privateEvent
	HostTokenActive    bool       `json:"hostTokenActive"`
	HostTokenIssuedAt  *time.Time `json:"hostTokenIssuedAt,omitempty"`
	HostTokenRevokedAt *time.Time `json:"hostTokenRevokedAt,omitempty"`
	IsDefault          bool       `json:"isDefault"`
}

func (s *Server) adminView(ev store.Event) adminEvent {
	return adminEvent{
		privateEvent:       s.privateView(ev),
		HostTokenActive:    ev.HostTokenHash != "" && ev.HostTokenRevokedAt == nil,
		HostTokenIssuedAt:  ev.HostTokenIssuedAt,
		HostTokenRevokedAt: ev.HostTokenRevokedAt,
		IsDefault:          s.store.DefaultEventID() == ev.ID,
	}
}

// adminEventFor loads {id} from the path.
func (s *Server) adminEventFor(w http.ResponseWriter, r *http.Request) (store.Event, bool) {
	ev, err := s.store.Event(r.PathValue("id"))
	if err != nil {
		writeErr(w, http.StatusNotFound, "EVENT_NOT_FOUND", "Acara tidak ditemukan.")
		return store.Event{}, false
	}
	return ev, true
}

func (s *Server) adminListEvents(w http.ResponseWriter, r *http.Request, _ actor) {
	out := []adminEvent{}
	for _, ev := range s.store.Events() {
		out = append(out, s.adminView(ev))
	}
	writeJSON(w, http.StatusOK, out)
}

func (s *Server) adminGetEvent(w http.ResponseWriter, r *http.Request, _ actor) {
	if ev, ok := s.adminEventFor(w, r); ok {
		writeJSON(w, http.StatusOK, s.adminView(ev))
	}
}

type eventInput struct {
	Slug        string     `json:"slug"`
	Status      string     `json:"status"`
	Type        string     `json:"type"`
	Title       string     `json:"title"`
	GroomName   string     `json:"groomName"`
	BrideName   string     `json:"brideName"`
	GroomParent string     `json:"groomParent"`
	BrideParent string     `json:"brideParent"`
	Venue       string     `json:"venue"`
	VenueAddr   string     `json:"venueAddress"`
	MapsURL     string     `json:"mapsUrl"`
	Hashtag     string     `json:"hashtag"`
	Theme       string     `json:"theme"`
	StartAt     *time.Time `json:"startAt"`
	EndAt       *time.Time `json:"endAt"`
	settingsInput
}

var errInvalid = errors.New("invalid")

// applyEventInput validates admin-editable fields and returns audit changes.
func applyEventInput(e *store.Event, in eventInput) (map[string]map[string]string, *locErr) {
	bad := func(code, msg string) (map[string]map[string]string, *locErr) {
		return nil, &locErr{http.StatusBadRequest, code, msg}
	}
	if in.Type == "" {
		in.Type = e.Kind()
	}
	if !store.EventTypes[in.Type] {
		return bad("BAD_TYPE", "Jenis acara tidak dikenal.")
	}
	in.Title = clean(in.Title, 80)
	in.GroomName, in.BrideName = clean(in.GroomName, 40), clean(in.BrideName, 40)
	if in.Type == store.TypeWedding {
		if in.GroomName == "" || in.BrideName == "" {
			return bad("NAMES_REQUIRED", "Nama mempelai wajib diisi.")
		}
	} else {
		if in.Title == "" {
			return bad("TITLE_REQUIRED", "Nama acara wajib diisi.")
		}
		in.GroomName, in.BrideName, in.GroomParent, in.BrideParent = "", "", "", ""
	}
	in.MapsURL = strings.TrimSpace(in.MapsURL)
	if in.MapsURL != "" {
		if u, err := url.Parse(in.MapsURL); err != nil || (u.Scheme != "https" && u.Scheme != "http") {
			return bad("BAD_MAPS_URL", "Link Google Maps harus diawali http(s)://")
		}
	}
	if in.Theme == "" {
		in.Theme = e.Theme
	}
	if !store.Themes[in.Theme] {
		return bad("BAD_THEME", "Tema tidak dikenal.")
	}
	if in.StartAt == nil || in.EndAt == nil {
		return bad("SCHEDULE_REQUIRED", "Jadwal mulai dan selesai wajib diisi.")
	}
	if !in.EndAt.After(*in.StartAt) || in.EndAt.Sub(*in.StartAt) > 5*24*time.Hour {
		return bad("BAD_SCHEDULE", "Jam selesai harus setelah jam mulai (maksimal 5 hari).")
	}
	status := store.EventStatus(in.Status)
	if in.Status == "" {
		status = e.Status
	}
	if !store.ValidStatus(status) {
		return bad("BAD_STATUS", "Status acara tidak dikenal.")
	}

	changes, lerr := applySettings(e, in.settingsInput)
	if lerr != nil {
		return nil, lerr
	}
	if !e.StartAt.Equal(*in.StartAt) || !e.EndAt.Equal(*in.EndAt) {
		changes["event.schedule_change"] = map[string]string{
			"fromStart": e.StartAt.Format(time.RFC3339), "fromEnd": e.EndAt.Format(time.RFC3339),
			"toStart": in.StartAt.UTC().Format(time.RFC3339), "toEnd": in.EndAt.UTC().Format(time.RFC3339),
		}
	}
	if status != e.Status {
		changes["event.status_change"] = map[string]string{"from": string(e.Status), "to": string(status)}
	}
	if in.Slug != "" {
		e.Slug = in.Slug
	}
	e.Status = status
	e.Type, e.Title = in.Type, in.Title
	e.GroomName, e.BrideName = in.GroomName, in.BrideName
	e.GroomParent, e.BrideParent = clean(in.GroomParent, 120), clean(in.BrideParent, 120)
	e.Venue, e.VenueAddr = clean(in.Venue, 120), clean(in.VenueAddr, 200)
	e.MapsURL, e.Hashtag, e.Theme = in.MapsURL, clean(in.Hashtag, 40), in.Theme
	e.StartAt, e.EndAt = in.StartAt.UTC(), in.EndAt.UTC()
	return changes, nil
}

func (s *Server) newHostToken(r *http.Request, ev store.Event) (string, string, store.Event, error) {
	tok := security.RandomToken(32) // 256-bit, crypto/rand
	updated, err := s.store.SetHostToken(ev.ID, security.HashToken(tok))
	if err != nil {
		return "", "", store.Event{}, err
	}
	return tok, s.baseURL(r) + "/host/access?token=" + tok, updated, nil
}

func (s *Server) adminCreateEvent(w http.ResponseWriter, r *http.Request, a actor) {
	var in eventInput
	if !decodeJSON(w, r, &in, 1<<16) {
		return
	}
	ev := store.Event{
		ID:                store.NewEventID(),
		Status:            store.StatusDraft,
		Theme:             store.DefaultTheme,
		RadiusMeters:      store.DefaultRadiusMeters,
		ModerationMode:    store.AutoPublish,
		GalleryVisibility: store.GalleryGuests,
		QRVersion:         1,
		DisplayVersion:    1,
	}
	if in.Slug == "" {
		in.Slug = in.GroomName + "-" + in.BrideName
		if in.Type != "" && in.Type != store.TypeWedding {
			in.Slug = in.Title
		}
	}
	if _, lerr := applyEventInput(&ev, in); lerr != nil {
		writeErr(w, lerr.status, lerr.code, lerr.msg)
		return
	}
	ev, err := s.store.CreateEvent(ev)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "INTERNAL", "Gagal membuat acara.")
		return
	}
	s.logAudit(a, ev.ID, "event.create", ev.ID, map[string]string{"slug": ev.Slug})
	tok, link, ev, err := s.newHostToken(r, ev)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "INTERNAL", "Acara dibuat, tetapi gagal membuat host token.")
		return
	}
	s.logAudit(a, ev.ID, "host_token.generate", ev.ID, nil)
	writeJSON(w, http.StatusCreated, map[string]any{
		"event":         s.adminView(ev),
		"hostToken":     tok, // shown exactly once
		"hostAccessUrl": link,
	})
}

func (s *Server) adminUpdateEvent(w http.ResponseWriter, r *http.Request, a actor) {
	ev, ok := s.adminEventFor(w, r)
	if !ok {
		return
	}
	var in eventInput
	if !decodeJSON(w, r, &in, 1<<16) {
		return
	}
	var changes map[string]map[string]string
	var verr *locErr
	updated, err := s.store.UpdateEvent(ev.ID, func(e *store.Event) error {
		changes, verr = applyEventInput(e, in)
		if verr != nil {
			return errInvalid
		}
		return nil
	})
	if verr != nil {
		writeErr(w, verr.status, verr.code, verr.msg)
		return
	}
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "INTERNAL", "Gagal menyimpan acara.")
		return
	}
	for action, meta := range changes {
		s.logAudit(a, ev.ID, action, ev.ID, meta)
	}
	s.logAudit(a, ev.ID, "event.update", ev.ID, nil)
	s.hub.Publish(ev.ID, "event.updated", nil)
	writeJSON(w, http.StatusOK, s.adminView(updated))
}

func (s *Server) adminSetDefault(w http.ResponseWriter, r *http.Request, a actor) {
	ev, ok := s.adminEventFor(w, r)
	if !ok {
		return
	}
	if err := s.store.SetDefaultEvent(ev.ID); err != nil {
		writeErr(w, http.StatusInternalServerError, "INTERNAL", "Gagal menyimpan.")
		return
	}
	s.logAudit(a, ev.ID, "event.set_default", ev.ID, nil)
	writeJSON(w, http.StatusOK, s.adminView(ev))
}

func (s *Server) adminRegenerateHostToken(w http.ResponseWriter, r *http.Request, a actor) {
	ev, ok := s.adminEventFor(w, r)
	if !ok {
		return
	}
	tok, link, updated, err := s.newHostToken(r, ev)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "INTERNAL", "Gagal membuat host token.")
		return
	}
	s.logAudit(a, ev.ID, "host_token.generate", ev.ID, map[string]string{"version": itoa(updated.HostTokenVersion)})
	writeJSON(w, http.StatusOK, map[string]any{"event": s.adminView(updated), "hostToken": tok, "hostAccessUrl": link})
}

func (s *Server) adminRevokeHostToken(w http.ResponseWriter, r *http.Request, a actor) {
	ev, ok := s.adminEventFor(w, r)
	if !ok {
		return
	}
	updated, err := s.store.RevokeHostToken(ev.ID)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "INTERNAL", "Gagal mencabut host token.")
		return
	}
	s.logAudit(a, ev.ID, "host_token.revoke", ev.ID, nil)
	writeJSON(w, http.StatusOK, s.adminView(updated))
}

func (s *Server) adminUploadCover(w http.ResponseWriter, r *http.Request, a actor) {
	ev, ok := s.adminEventFor(w, r)
	if !ok {
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, s.cfg.MaxUploadBytes+(1<<20))
	if err := r.ParseMultipartForm(8 << 20); err != nil {
		writeErr(w, http.StatusRequestEntityTooLarge, "TOO_LARGE", "Ukuran foto maksimal 10 MB.")
		return
	}
	defer r.MultipartForm.RemoveAll()
	f, _, err := r.FormFile("photo")
	if err != nil {
		writeErr(w, http.StatusBadRequest, "PHOTO_REQUIRED", "Foto wajib diunggah.")
		return
	}
	defer f.Close()
	data, err := io.ReadAll(io.LimitReader(f, s.cfg.MaxUploadBytes+1))
	if err != nil || int64(len(data)) > s.cfg.MaxUploadBytes {
		writeErr(w, http.StatusRequestEntityTooLarge, "TOO_LARGE", "Ukuran foto maksimal 10 MB.")
		return
	}
	jpg, err := imageproc.EncodeCover(data, imageproc.Sniff(data))
	if err != nil {
		writeErr(w, http.StatusUnprocessableEntity, "INVALID_IMAGE", "File harus berupa foto JPEG atau PNG yang valid.")
		return
	}
	key := "events/" + ev.ID + "/covers/" + store.NewID() + ".jpg"
	if err := s.storage.Put(r.Context(), key, "image/jpeg", jpg); err != nil {
		writeErr(w, http.StatusBadGateway, "STORAGE", "Gagal menyimpan foto sampul.")
		return
	}
	s.setCover(w, r, a, ev, key)
}

func (s *Server) adminDeleteCover(w http.ResponseWriter, r *http.Request, a actor) {
	if ev, ok := s.adminEventFor(w, r); ok {
		s.setCover(w, r, a, ev, "")
	}
}

func (s *Server) setCover(w http.ResponseWriter, r *http.Request, a actor, ev store.Event, key string) {
	old := ev.CoverKey
	updated, err := s.store.UpdateEvent(ev.ID, func(e *store.Event) error {
		e.CoverKey = key
		return nil
	})
	if err != nil {
		if key != "" {
			_ = s.storage.Delete(r.Context(), key)
		}
		writeErr(w, http.StatusInternalServerError, "INTERNAL", "Gagal menyimpan foto sampul.")
		return
	}
	if old != "" && old != key {
		_ = s.storage.Delete(r.Context(), old)
	}
	s.logAudit(a, ev.ID, "event.cover_change", ev.ID, map[string]string{"removed": itoa(boolInt(key == ""))})
	s.hub.Publish(ev.ID, "event.updated", nil)
	writeJSON(w, http.StatusOK, s.adminView(updated))
}

func (s *Server) adminUploadFrame(w http.ResponseWriter, r *http.Request, a actor) {
	ev, ok := s.adminEventFor(w, r)
	if !ok {
		return
	}
	if len(ev.Frames()) >= store.MaxFrames {
		writeErr(w, http.StatusConflict, "FRAMES_FULL", framesFullMsg)
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, s.cfg.MaxUploadBytes+(1<<20))
	if err := r.ParseMultipartForm(8 << 20); err != nil {
		writeErr(w, http.StatusRequestEntityTooLarge, "TOO_LARGE", "Ukuran bingkai maksimal 10 MB.")
		return
	}
	defer r.MultipartForm.RemoveAll()
	f, _, err := r.FormFile("frame")
	if err != nil {
		writeErr(w, http.StatusBadRequest, "FRAME_REQUIRED", "File bingkai wajib diunggah.")
		return
	}
	defer f.Close()
	data, err := io.ReadAll(io.LimitReader(f, s.cfg.MaxUploadBytes+1))
	if err != nil || int64(len(data)) > s.cfg.MaxUploadBytes {
		writeErr(w, http.StatusRequestEntityTooLarge, "TOO_LARGE", "Ukuran bingkai maksimal 10 MB.")
		return
	}
	out, err := imageproc.EncodeFrame(data)
	if err != nil {
		msg := "File harus berupa PNG yang valid."
		switch {
		case errors.Is(err, imageproc.ErrFrameShape):
			msg = "Bingkai harus potret atau persegi (rasio 1:1 sampai 9:16), sisi terpendek minimal 600 px."
		case errors.Is(err, imageproc.ErrFrameOpaque):
			msg = "Bingkai harus punya area transparan (bolong) atau hijau (greenscreen) tempat foto tamu terlihat."
		case errors.Is(err, imageproc.ErrFrameType):
			msg = "Bingkai harus berupa file PNG."
		}
		writeErr(w, http.StatusUnprocessableEntity, "INVALID_FRAME", msg)
		return
	}
	key := "events/" + ev.ID + "/frames/" + store.NewID() + ".png"
	if err := s.storage.Put(r.Context(), key, "image/png", out); err != nil {
		writeErr(w, http.StatusBadGateway, "STORAGE", "Gagal menyimpan bingkai.")
		return
	}
	s.changeFrames(w, r, a, ev, func(keys []string) ([]string, error) {
		if len(keys) >= store.MaxFrames {
			return nil, errFramesFull
		}
		return append(keys, key), nil
	}, key)
}

func (s *Server) adminDeleteFrame(w http.ResponseWriter, r *http.Request, a actor) {
	ev, ok := s.adminEventFor(w, r)
	if !ok {
		return
	}
	fid := r.PathValue("fid") // empty on the legacy route: remove every frame
	s.changeFrames(w, r, a, ev, func(keys []string) ([]string, error) {
		out := []string{}
		for _, k := range keys {
			if fid != "" && frameID(k) != fid {
				out = append(out, k)
			}
		}
		if fid != "" && len(out) == len(keys) {
			return nil, store.ErrNotFound
		}
		return out, nil
	}, "")
}

const framesFullMsg = "Maksimal 4 bingkai per acara. Hapus salah satu dulu."

var errFramesFull = errors.New("frames full")

// changeFrames rewrites the event's frame list with fn (under the event lock),
// then deletes the objects of frames that were dropped. `added` is a freshly
// stored object, removed again if the change fails.
func (s *Server) changeFrames(w http.ResponseWriter, r *http.Request, a actor, ev store.Event, fn func([]string) ([]string, error), added string) {
	var dropped []string
	updated, err := s.store.UpdateEvent(ev.ID, func(e *store.Event) error {
		old := e.Frames()
		next, err := fn(append([]string(nil), old...))
		if err != nil {
			return err
		}
		keep := map[string]bool{}
		for _, k := range next {
			keep[k] = true
		}
		dropped = dropped[:0]
		for _, k := range old {
			if !keep[k] {
				dropped = append(dropped, k)
			}
		}
		e.FrameKey = ""
		e.FrameKeys = next
		return nil
	})
	if err != nil {
		if added != "" {
			_ = s.storage.Delete(r.Context(), added)
		}
		switch {
		case errors.Is(err, errFramesFull):
			writeErr(w, http.StatusConflict, "FRAMES_FULL", framesFullMsg)
		case errors.Is(err, store.ErrNotFound):
			writeErr(w, http.StatusNotFound, "FRAME_NOT_FOUND", "Bingkai tidak ditemukan.")
		default:
			writeErr(w, http.StatusInternalServerError, "INTERNAL", "Gagal menyimpan bingkai.")
		}
		return
	}
	for _, k := range dropped {
		_ = s.storage.Delete(r.Context(), k)
	}
	s.logAudit(a, ev.ID, "event.frame_change", ev.ID, map[string]string{"frames": itoa(len(updated.Frames())), "removed": itoa(len(dropped))})
	s.hub.Publish(ev.ID, "event.updated", nil)
	writeJSON(w, http.StatusOK, s.adminView(updated))
}

func boolInt(b bool) int {
	if b {
		return 1
	}
	return 0
}

func (s *Server) adminPhotos(w http.ResponseWriter, r *http.Request, _ actor) {
	ev, ok := s.adminEventFor(w, r)
	if !ok {
		return
	}
	photos := s.store.EventPhotos(ev.ID, func(p store.Photo) bool { return p.Status != store.PhotoFailed })
	writeJSON(w, http.StatusOK, map[string]any{"photos": s.viewPhotos(photos, scopeHost)})
}

func (s *Server) adminDownloadZip(w http.ResponseWriter, r *http.Request, a actor) {
	if ev, ok := s.adminEventFor(w, r); ok {
		s.writePhotosZip(w, r, a, ev)
	}
}

func (s *Server) adminModerate(w http.ResponseWriter, r *http.Request, a actor) {
	if ev, ok := s.adminEventFor(w, r); ok {
		s.moderate(w, r, a, ev, r.PathValue("pid"), r.PathValue("action"))
	}
}

func (s *Server) adminDeletePhoto(w http.ResponseWriter, r *http.Request, a actor) {
	if ev, ok := s.adminEventFor(w, r); ok {
		s.deletePhoto(w, r, a, ev, r.PathValue("pid"))
	}
}

func (s *Server) adminStats(w http.ResponseWriter, r *http.Request, _ actor) {
	if ev, ok := s.adminEventFor(w, r); ok {
		writeJSON(w, http.StatusOK, s.statsPayload(ev))
	}
}

func (s *Server) adminQR(w http.ResponseWriter, r *http.Request, _ actor) {
	if ev, ok := s.adminEventFor(w, r); ok {
		s.writeQR(w, r, ev)
	}
}

func (s *Server) adminRotateQR(w http.ResponseWriter, r *http.Request, a actor) {
	if ev, ok := s.adminEventFor(w, r); ok {
		s.rotateQR(w, a, ev)
	}
}

func (s *Server) adminDisplayLink(w http.ResponseWriter, r *http.Request, _ actor) {
	if ev, ok := s.adminEventFor(w, r); ok {
		s.displayLink(w, r, ev)
	}
}

func (s *Server) adminRotateDisplay(w http.ResponseWriter, r *http.Request, a actor) {
	if ev, ok := s.adminEventFor(w, r); ok {
		s.rotateDisplay(w, r, a, ev)
	}
}

func (s *Server) adminAudit(w http.ResponseWriter, r *http.Request, _ actor) {
	if s.audit == nil {
		writeJSON(w, http.StatusOK, []audit.Entry{})
		return
	}
	writeJSON(w, http.StatusOK, s.audit.Recent(r.URL.Query().Get("eventId"), 200))
}

// ---------- One-time import of v1 public uploads ----------

var legacyFileRe = regexp.MustCompile(`^[a-f0-9]{16}\.(jpg|png|webp)$`)

// importLegacy copies files from the old public uploads dir into private
// storage and queues them for processing (which strips EXIF). Old files are
// left in place; delete DATA_DIR/uploads once the import is verified.
func (s *Server) importLegacy(ctx context.Context) {
	sys := actor{audit.ActorSystem, "migration"}
	for _, ev := range s.store.Events() {
		if ev.LegacyCoverFile == "" {
			continue
		}
		var key string
		if legacyFileRe.MatchString(ev.LegacyCoverFile) && s.cfg.LegacyUploadDir != "" {
			if data, err := os.ReadFile(filepath.Join(s.cfg.LegacyUploadDir, ev.LegacyCoverFile)); err == nil {
				if jpg, err := imageproc.EncodeCover(data, imageproc.Sniff(data)); err == nil {
					key = "events/" + ev.ID + "/covers/" + store.NewID() + ".jpg"
					if s.storage.Put(ctx, key, "image/jpeg", jpg) != nil {
						key = ""
					}
				}
			}
		}
		_, _ = s.store.UpdateEvent(ev.ID, func(e *store.Event) error {
			e.LegacyCoverFile = ""
			if key != "" {
				e.CoverKey = key
			}
			return nil
		})
		s.logAudit(sys, ev.ID, "migration.cover_import", ev.ID, map[string]string{"ok": itoa(boolInt(key != ""))})
	}
	for _, p := range s.store.LegacyPhotos() {
		var data []byte
		var err error = errInvalid
		if legacyFileRe.MatchString(p.LegacyFile) && s.cfg.LegacyUploadDir != "" {
			data, err = os.ReadFile(filepath.Join(s.cfg.LegacyUploadDir, p.LegacyFile))
		}
		ct := imageproc.Sniff(data)
		ext, ok := imageproc.AllowedTypes[ct]
		if err != nil || !ok {
			log.Printf("legacy photo %s: cannot import (%v)", p.ID, err)
			_, _ = s.store.UpdatePhoto(p.EventID, p.ID, func(x *store.Photo) error { x.LegacyFile = ""; return nil })
			_, _ = s.store.FailPhoto(p.EventID, p.ID)
			continue
		}
		key := "events/" + p.EventID + "/uploads/" + p.ID + "." + ext
		if err := s.storage.Put(ctx, key, ct, data); err != nil {
			log.Printf("legacy photo %s: storage: %v", p.ID, err)
			continue // retried on next start
		}
		_, _ = s.store.UpdatePhoto(p.EventID, p.ID, func(x *store.Photo) error {
			x.LegacyFile = ""
			x.OriginalKey, x.OriginalType = key, ct
			return nil
		})
		s.enqueue(p.EventID, p.ID)
	}
}
