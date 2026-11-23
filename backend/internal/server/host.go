package server

import (
	"net/http"
	"strconv"
	"time"

	"github.com/nakhasolution/weedingnakha/backend/internal/security"
	"github.com/nakhasolution/weedingnakha/backend/internal/store"
)

// privateEvent is what the event's own host (and admins) can see.
type privateEvent struct {
	publicEvent
	ID             string     `json:"id"`
	StartAt        time.Time  `json:"startAt"`
	EndAt          time.Time  `json:"endAt"`
	VenueLatitude  *float64   `json:"venueLatitude"`
	VenueLongitude *float64   `json:"venueLongitude"`
	RadiusMeters   int        `json:"radiusMeters"`
	ModerationMode string     `json:"moderationMode"`
	Booth          boothState `json:"booth"`
	CustomWishes   string     `json:"customWishes"` // organiser's own default wish ("" = built-in greeting)
}

func (s *Server) privateView(ev store.Event) privateEvent {
	v := privateEvent{
		publicEvent:    s.publicView(ev),
		ID:             ev.ID,
		StartAt:        ev.StartAt,
		EndAt:          ev.EndAt,
		RadiusMeters:   ev.RadiusMeters,
		ModerationMode: string(ev.ModerationMode),
		Booth:          s.booth(ev),
		CustomWishes:   ev.Wishes,
	}
	if ev.LocationSet {
		lat, lng := ev.VenueLat, ev.VenueLng
		v.VenueLatitude, v.VenueLongitude = &lat, &lng
	}
	return v
}

func (s *Server) hostMe(w http.ResponseWriter, r *http.Request, _ actor, ev store.Event) {
	writeJSON(w, http.StatusOK, s.privateView(ev))
}

func (s *Server) hostStats(w http.ResponseWriter, r *http.Request, _ actor, ev store.Event) {
	writeJSON(w, http.StatusOK, s.statsPayload(ev))
}

func (s *Server) hostPhotos(w http.ResponseWriter, r *http.Request, _ actor, ev store.Event) {
	photos := s.store.EventPhotos(ev.ID, func(p store.Photo) bool { return p.Status != store.PhotoFailed })
	writeJSON(w, http.StatusOK, map[string]any{"photos": s.viewPhotos(photos, scopeHost)})
}

// hostDownloadZip: the couple downloads all photos without the watermark.
func (s *Server) hostDownloadZip(w http.ResponseWriter, r *http.Request, a actor, ev store.Event) {
	s.writePhotosZip(w, r, a, ev)
}

func (s *Server) hostModerate(w http.ResponseWriter, r *http.Request, a actor, ev store.Event) {
	s.moderate(w, r, a, ev, r.PathValue("id"), r.PathValue("action"))
}

func (s *Server) hostDeletePhoto(w http.ResponseWriter, r *http.Request, a actor, ev store.Event) {
	s.deletePhoto(w, r, a, ev, r.PathValue("id"))
}

// setStatus moves an event between states with an audit entry.
func (s *Server) setStatus(w http.ResponseWriter, a actor, ev store.Event, from, to store.EventStatus, action string) {
	updated, err := s.store.UpdateEvent(ev.ID, func(e *store.Event) error {
		if e.Status != from {
			return errBadAction
		}
		e.Status = to
		return nil
	})
	if err != nil {
		writeErr(w, http.StatusConflict, "BAD_STATE", "Status acara saat ini tidak mengizinkan aksi ini.")
		return
	}
	s.logAudit(a, ev.ID, action, ev.ID, map[string]string{"from": string(from), "to": string(to)})
	s.hub.Publish(ev.ID, "event.updated", nil)
	writeJSON(w, http.StatusOK, s.privateView(updated))
}

func (s *Server) hostPause(w http.ResponseWriter, r *http.Request, a actor, ev store.Event) {
	s.setStatus(w, a, ev, store.StatusActive, store.StatusPaused, "event.pause")
}

func (s *Server) hostResume(w http.ResponseWriter, r *http.Request, a actor, ev store.Event) {
	s.setStatus(w, a, ev, store.StatusPaused, store.StatusActive, "event.resume")
}

type settingsInput struct {
	ModerationMode    *string  `json:"moderationMode"`
	GalleryVisibility *string  `json:"galleryVisibility"`
	RadiusMeters      *int     `json:"radiusMeters"`
	VenueLatitude     *float64 `json:"venueLatitude"`
	VenueLongitude    *float64 `json:"venueLongitude"`
}

// applySettings validates and applies the settings both hosts and admins may
// change, returning audit entries (action → metadata) for what changed.
func applySettings(e *store.Event, in settingsInput) (map[string]map[string]string, *locErr) {
	changes := map[string]map[string]string{}
	if in.ModerationMode != nil {
		m := store.ModerationMode(*in.ModerationMode)
		if !store.ValidModeration(m) {
			return nil, &locErr{http.StatusBadRequest, "BAD_MODERATION", "Mode moderasi tidak dikenal."}
		}
		if m != e.ModerationMode {
			changes["event.moderation_change"] = map[string]string{"from": string(e.ModerationMode), "to": string(m)}
			e.ModerationMode = m
		}
	}
	if in.GalleryVisibility != nil {
		v := store.GalleryVisibility(*in.GalleryVisibility)
		if !store.ValidVisibility(v) {
			return nil, &locErr{http.StatusBadRequest, "BAD_VISIBILITY", "Visibilitas galeri tidak dikenal."}
		}
		if v != e.GalleryVisibility {
			changes["event.visibility_change"] = map[string]string{"from": string(e.GalleryVisibility), "to": string(v)}
			e.GalleryVisibility = v
		}
	}
	if in.RadiusMeters != nil {
		if *in.RadiusMeters < 25 || *in.RadiusMeters > 5000 {
			return nil, &locErr{http.StatusBadRequest, "BAD_RADIUS", "Radius harus antara 25 dan 5000 meter."}
		}
		if *in.RadiusMeters != e.RadiusMeters {
			changes["event.radius_change"] = map[string]string{"from": strconv.Itoa(e.RadiusMeters), "to": strconv.Itoa(*in.RadiusMeters)}
			e.RadiusMeters = *in.RadiusMeters
		}
	}
	if (in.VenueLatitude == nil) != (in.VenueLongitude == nil) {
		return nil, &locErr{http.StatusBadRequest, "BAD_LOCATION", "Latitude dan longitude harus diisi bersamaan."}
	}
	if in.VenueLatitude != nil {
		if !security.ValidCoord(*in.VenueLatitude, *in.VenueLongitude) || (*in.VenueLatitude == 0 && *in.VenueLongitude == 0) {
			return nil, &locErr{http.StatusBadRequest, "BAD_LOCATION", "Koordinat lokasi tidak valid."}
		}
		if !e.LocationSet || e.VenueLat != *in.VenueLatitude || e.VenueLng != *in.VenueLongitude {
			// coordinates of the venue are not personal data, but keep the log terse
			changes["event.location_change"] = map[string]string{"previouslySet": strconv.FormatBool(e.LocationSet)}
			e.VenueLat, e.VenueLng, e.LocationSet = *in.VenueLatitude, *in.VenueLongitude, true
		}
	}
	return changes, nil
}

func (s *Server) hostSettings(w http.ResponseWriter, r *http.Request, a actor, ev store.Event) {
	var in settingsInput
	if !decodeJSON(w, r, &in, 4096) {
		return
	}
	var changes map[string]map[string]string
	var verr *locErr
	updated, err := s.store.UpdateEvent(ev.ID, func(e *store.Event) error {
		changes, verr = applySettings(e, in)
		if verr != nil {
			return errBadAction
		}
		return nil
	})
	if verr != nil {
		writeErr(w, verr.status, verr.code, verr.msg)
		return
	}
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "INTERNAL", "Gagal menyimpan pengaturan.")
		return
	}
	for action, meta := range changes {
		s.logAudit(a, ev.ID, action, ev.ID, meta)
	}
	s.hub.Publish(ev.ID, "event.updated", nil)
	s.hub.Publish(ev.ID, "photos.changed", nil)
	writeJSON(w, http.StatusOK, s.privateView(updated))
}

func (s *Server) hostQR(w http.ResponseWriter, r *http.Request, _ actor, ev store.Event) {
	s.writeQR(w, r, ev)
}

func (s *Server) rotateQR(w http.ResponseWriter, a actor, ev store.Event) {
	updated, err := s.store.UpdateEvent(ev.ID, func(e *store.Event) error {
		e.QRVersion++
		return nil
	})
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "INTERNAL", "Gagal memperbarui QR.")
		return
	}
	s.logAudit(a, ev.ID, "qr.rotate", ev.ID, nil)
	writeJSON(w, http.StatusOK, map[string]int{"qrVersion": updated.QRVersion})
}

func (s *Server) hostRotateQR(w http.ResponseWriter, r *http.Request, a actor, ev store.Event) {
	s.rotateQR(w, a, ev)
}

func (s *Server) displayLink(w http.ResponseWriter, r *http.Request, ev store.Event) {
	writeJSON(w, http.StatusOK, map[string]string{"url": s.baseURL(r) + "/slideshow/?k=" + s.displayToken(ev)})
}

func (s *Server) rotateDisplay(w http.ResponseWriter, r *http.Request, a actor, ev store.Event) {
	updated, err := s.store.RotateDisplay(ev.ID) // also deletes every display session
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "INTERNAL", "Gagal membuat link baru.")
		return
	}
	s.logAudit(a, ev.ID, "display.rotate", ev.ID, nil)
	s.displayLink(w, r, updated)
}

func (s *Server) hostDisplayLink(w http.ResponseWriter, r *http.Request, _ actor, ev store.Event) {
	s.displayLink(w, r, ev)
}

func (s *Server) hostRotateDisplay(w http.ResponseWriter, r *http.Request, a actor, ev store.Event) {
	s.rotateDisplay(w, r, a, ev)
}

// ---------- Display (read-only Live Wall) ----------

func (s *Server) displayEvent(w http.ResponseWriter, r *http.Request, ev store.Event) {
	writeJSON(w, http.StatusOK, s.publicView(ev))
}

func (s *Server) displayPhotos(w http.ResponseWriter, r *http.Request, ev store.Event) {
	// the wall cycles through recent photos; newest 150 is plenty
	photos, _ := paginate(s.store.EventPhotos(ev.ID, store.Photo.VisibleOnWall), r, 150, 300)
	writeJSON(w, http.StatusOK, map[string]any{"photos": s.viewPhotos(photos, scopeWall)})
}

func (s *Server) displayQR(w http.ResponseWriter, r *http.Request, ev store.Event) {
	if ok, wait := s.rl.display.Allow("qr:" + ev.ID + ":" + s.clientIP(r)); !ok {
		writeRateLimited(w, wait)
		return
	}
	s.writeQR(w, r, ev)
}
