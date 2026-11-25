package server

import (
	"archive/zip"
	"context"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"path"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/nakhasolution/weedingnakha/backend/internal/imageproc"
	"github.com/nakhasolution/weedingnakha/backend/internal/storage"
	"github.com/nakhasolution/weedingnakha/backend/internal/store"
)

// ---------- Public event view ----------

// publicEvent is everything an invitation page may show. It deliberately
// excludes coordinates, radius, tokens, versions and internal IDs.
type publicEvent struct {
	// Scope tells the site how this event was chosen: "slug" (link/QR),
	// "guest" (checked-in guest) or "default" (no context — the site then
	// shows only the studio brand, not this couple's names or theme).
	Scope              string     `json:"scope,omitempty"`
	Slug               string     `json:"slug"`
	Type               string     `json:"type"`
	Title              string     `json:"title"`
	GroomName          string     `json:"groomName"`
	BrideName          string     `json:"brideName"`
	GroomParent        string     `json:"groomParent"`
	BrideParent        string     `json:"brideParent"`
	EventDate          string     `json:"eventDate"`
	EventTime          string     `json:"eventTime"`
	EndTime            string     `json:"endTime"`
	Venue              string     `json:"venue"`
	VenueAddress       string     `json:"venueAddress"`
	MapsURL            string     `json:"mapsUrl"`
	Hashtag            string     `json:"hashtag"`
	DefaultWishes      string     `json:"defaultWishes"` // what an empty wish becomes
	Theme              string     `json:"theme"`
	CoverURL           string     `json:"coverUrl"`
	FrameURL           string     `json:"frameUrl"` // first frame (older clients)
	Frames             []frameRef `json:"frames"`
	Status             string     `json:"status"`
	PhotoboothOpen     bool       `json:"photoboothOpen"`
	GalleryVisibility  string     `json:"galleryVisibility"`
	MaxPhotosPerGuest  int        `json:"maxPhotosPerGuest"`  // -1 = unlimited
	MaxMomentsPerGuest int        `json:"maxMomentsPerGuest"` // -1 = unlimited
}

func (s *Server) publicView(ev store.Event) publicEvent {
	start := ev.StartAt.In(store.EventLocation)
	cover := ""
	if ev.CoverKey != "" {
		cover = fmt.Sprintf("/api/public/events/%s/cover?v=%d", url.PathEscape(ev.Slug), ev.UpdatedAt.Unix())
	}
	frames := []frameRef{}
	for _, k := range ev.Frames() {
		id := frameID(k)
		frames = append(frames, frameRef{ID: id, URL: fmt.Sprintf("/api/public/events/%s/frames/%s?v=%d", url.PathEscape(ev.Slug), url.PathEscape(id), ev.UpdatedAt.Unix())})
	}
	frame := ""
	if len(frames) > 0 {
		frame = frames[0].URL
	}
	return publicEvent{
		Slug: ev.Slug, Type: ev.Kind(), Title: ev.Title, GroomName: ev.GroomName, BrideName: ev.BrideName,
		GroomParent: ev.GroomParent, BrideParent: ev.BrideParent,
		EventDate: start.Format("2006-01-02"), EventTime: start.Format("15:04"),
		EndTime: ev.EndAt.In(store.EventLocation).Format("15:04"),
		Venue:   ev.Venue, VenueAddress: ev.VenueAddr, MapsURL: ev.MapsURL, Hashtag: ev.Hashtag,
		DefaultWishes: defaultWishes(ev),
		Theme:         ev.Theme, CoverURL: cover, FrameURL: frame, Frames: frames, Status: string(ev.Status),
		PhotoboothOpen:     s.booth(ev).Open,
		GalleryVisibility:  string(ev.GalleryVisibility),
		MaxPhotosPerGuest:  ev.QuotaFor("photobooth"),
		MaxMomentsPerGuest: ev.QuotaFor(store.SourceMoment),
	}
}

func (s *Server) getDefaultEvent(w http.ResponseWriter, r *http.Request) {
	ev, err := s.store.Event(s.store.DefaultEventID())
	if err != nil {
		writeErr(w, http.StatusNotFound, "EVENT_NOT_FOUND", "Belum ada acara.")
		return
	}
	writeJSON(w, http.StatusOK, s.publicView(ev))
}

func (s *Server) getPublicEvent(w http.ResponseWriter, r *http.Request) {
	slug := r.URL.Query().Get("slug")
	var ev store.Event
	var err error
	scope := "default"
	if slug != "" {
		ev, err = s.store.EventBySlug(slug)
		scope = "slug"
	} else if _, gev, gerr := s.guestFromRequest(r); gerr == nil {
		ev = gev // a checked-in guest sees their own event
		scope = "guest"
	} else {
		ev, err = s.store.Event(s.store.DefaultEventID())
	}
	if err != nil {
		writeErr(w, http.StatusNotFound, "EVENT_NOT_FOUND", "Acara tidak ditemukan.")
		return
	}
	view := s.publicView(ev)
	view.Scope = scope
	writeJSON(w, http.StatusOK, view)
}

func (s *Server) getCover(w http.ResponseWriter, r *http.Request) {
	ev, err := s.store.EventBySlug(r.PathValue("slug"))
	if err != nil || ev.CoverKey == "" {
		http.NotFound(w, r)
		return
	}
	s.serveObject(w, r, ev.CoverKey, "public, max-age=3600", false)
}

// getFrame is always proxied (never redirected to the bucket) so the
// photobooth can draw it into a canvas without tainting it cross-origin.
func (s *Server) getFrame(w http.ResponseWriter, r *http.Request) {
	ev, err := s.store.EventBySlug(r.PathValue("slug"))
	if err != nil {
		http.NotFound(w, r)
		return
	}
	keys := ev.Frames()
	key := ""
	if fid := r.PathValue("fid"); fid != "" {
		for _, k := range keys {
			if frameID(k) == fid {
				key = k
			}
		}
	} else if len(keys) > 0 {
		key = keys[0] // legacy URL: the first frame
	}
	if key == "" {
		http.NotFound(w, r)
		return
	}
	s.serveObject(w, r, key, "public, max-age=3600", true)
}

type frameRef struct {
	ID  string `json:"id"`
	URL string `json:"url"`
}

// frameID is a frame's public id: its object key's file name without ".png".
func frameID(key string) string {
	return strings.TrimSuffix(path.Base(key), ".png")
}

// ---------- Gallery access ----------

// galleryEvent determines which event's gallery the caller may read.
// Order: explicit slug, else the caller's own guest/host session event,
// else the default event. Access then depends on the event's visibility.
func (s *Server) galleryEvent(r *http.Request) (store.Event, bool) {
	slug := r.URL.Query().Get("slug")
	var ev store.Event
	var err error
	switch {
	case slug != "":
		ev, err = s.store.EventBySlug(slug)
	default:
		if _, gev, gerr := s.guestFromRequest(r); gerr == nil {
			ev = gev
		} else if _, hev, herr := s.hostFromRequest(r); herr == nil {
			ev = hev
		} else {
			ev, err = s.store.Event(s.store.DefaultEventID())
		}
	}
	if err != nil {
		return store.Event{}, false
	}
	return ev, s.canViewGallery(r, ev)
}

func (s *Server) canViewGallery(r *http.Request, ev store.Event) bool {
	if _, hev, err := s.hostFromRequest(r); err == nil && hev.ID == ev.ID {
		return true
	}
	switch ev.GalleryVisibility {
	case store.GalleryPublic:
		return ev.Status != store.StatusDraft
	case store.GalleryGuests:
		_, gev, err := s.guestFromRequest(r)
		return err == nil && gev.ID == ev.ID
	}
	return false
}

// ---------- Photo views + signed media URLs ----------

type photoView struct {
	ID                string    `json:"id"`
	GuestName         string    `json:"guestName"`
	Wishes            string    `json:"wishes"`
	Filter            string    `json:"filter"`
	Source            string    `json:"source"`
	Likes             int       `json:"likes"`
	CreatedAt         time.Time `json:"createdAt"`
	Width             int       `json:"width,omitempty"`
	Height            int       `json:"height,omitempty"`
	PhotoURL          string    `json:"photoUrl"`
	ThumbURL          string    `json:"thumbUrl"`
	DownloadURL       string    `json:"downloadUrl,omitempty"` // host/admin only: copy without watermark
	Status            string    `json:"status,omitempty"`
	Approval          string    `json:"approval,omitempty"`
	HiddenFromWall    *bool     `json:"hiddenFromWall,omitempty"`
	HiddenFromGallery *bool     `json:"hiddenFromGallery,omitempty"`
}

const (
	scopeWall    = "wall"
	scopeGallery = "gallery"
	scopeHost    = "host" // host + admin moderation view
)

func (s *Server) mediaURL(eventID, id, variant, scope string) string {
	exp := strconv.FormatInt(s.now().Add(s.cfg.MediaURLTTL).Unix(), 10)
	q := url.Values{}
	q.Set("s", scope)
	q.Set("e", exp)
	q.Set("sig", s.mediaSigner.MAC(eventID, id, variant, scope, exp))
	return "/api/media/" + eventID + "/" + id + "/" + variant + "?" + q.Encode()
}

func (s *Server) viewPhoto(p store.Photo, scope string) photoView {
	v := photoView{
		ID: p.ID, GuestName: p.GuestName, Wishes: p.Wishes, Filter: p.Filter, Source: p.Source,
		Likes: p.Likes, CreatedAt: p.CreatedAt, Width: p.Width, Height: p.Height,
	}
	if p.Status == store.PhotoReady {
		v.PhotoURL = s.mediaURL(p.EventID, p.ID, "display", scope)
		v.ThumbURL = s.mediaURL(p.EventID, p.ID, "thumb", scope)
	}
	if scope == scopeHost {
		if p.Status == store.PhotoReady {
			v.DownloadURL = s.mediaURL(p.EventID, p.ID, "original", scopeHost)
		}
		hw, hg := p.HiddenFromWall, p.HiddenFromGallery
		v.Status, v.Approval, v.HiddenFromWall, v.HiddenFromGallery = string(p.Status), string(p.Approval), &hw, &hg
	}
	return v
}

func (s *Server) viewPhotos(ps []store.Photo, scope string) []photoView {
	out := make([]photoView, 0, len(ps))
	for _, p := range ps {
		out = append(out, s.viewPhoto(p, scope))
	}
	return out
}

// media serves a photo only for a valid, unexpired signature AND only while
// the photo is still visible in the signed scope — so hiding a photo makes
// even freshly issued URLs stop working.
func (s *Server) media(w http.ResponseWriter, r *http.Request) {
	eventID, id, variant := r.PathValue("event"), r.PathValue("id"), r.PathValue("variant")
	q := r.URL.Query()
	scope, exp, sig := q.Get("s"), q.Get("e"), q.Get("sig")
	validVariant := variant == "display" || variant == "thumb" || (variant == "original" && scope == scopeHost)
	if !validVariant || !s.mediaSigner.CheckMAC(sig, eventID, id, variant, scope, exp) {
		writeErr(w, http.StatusForbidden, "MEDIA_FORBIDDEN", "Akses foto ditolak.")
		return
	}
	expUnix, err := strconv.ParseInt(exp, 10, 64)
	if err != nil || s.now().Unix() >= expUnix {
		writeErr(w, http.StatusForbidden, "MEDIA_EXPIRED", "Link foto sudah kedaluwarsa.")
		return
	}
	p, err := s.store.Photo(eventID, id)
	if err != nil || p.DeletedAt != nil || p.Status != store.PhotoReady {
		http.NotFound(w, r)
		return
	}
	switch scope {
	case scopeWall:
		if !p.VisibleOnWall() {
			http.NotFound(w, r)
			return
		}
	case scopeGallery:
		if !p.VisibleInGallery() {
			http.NotFound(w, r)
			return
		}
	case scopeHost:
	default:
		writeErr(w, http.StatusForbidden, "MEDIA_FORBIDDEN", "Akses foto ditolak.")
		return
	}
	key := p.DisplayKey
	switch variant {
	case "thumb":
		key = p.ThumbKey
	case "original":
		// photos processed before the watermark release have no clean copy
		if p.CleanKey != "" {
			key = p.CleanKey
		}
		w.Header().Set("Content-Disposition", `attachment; filename="`+downloadName(p, 0)+`"`)
	}
	remaining := expUnix - s.now().Unix()
	// downloads are proxied so the attachment filename survives (a presigned
	// R2 redirect would just open the image)
	s.serveObject(w, r, key, "private, max-age="+strconv.FormatInt(min(remaining, 600), 10), variant == "original")
}

// serveObject streams from the local driver or redirects to a 60-second
// presigned URL on S3/R2 (the bucket itself stays private).
func (s *Server) serveObject(w http.ResponseWriter, r *http.Request, key, cache string, proxy bool) {
	if u, err := s.storage.PresignGet(key, time.Minute); !proxy && err == nil && u != "" {
		w.Header().Set("Cache-Control", "no-store")
		http.Redirect(w, r, u, http.StatusFound)
		return
	}
	rc, size, err := s.storage.Open(r.Context(), key)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	defer rc.Close()
	ctype := "image/jpeg"
	if strings.HasSuffix(key, ".png") {
		ctype = "image/png"
	}
	w.Header().Set("Content-Type", ctype)
	w.Header().Set("Content-Length", strconv.FormatInt(size, 10))
	w.Header().Set("Cache-Control", cache)
	w.Header().Set("Content-Security-Policy", "default-src 'none'")
	_, _ = io.Copy(w, rc)
}

// ---------- Gallery endpoints ----------

func (s *Server) galleryPhotos(w http.ResponseWriter, r *http.Request) {
	ev, ok := s.galleryEvent(r)
	if !ok {
		writeErr(w, http.StatusForbidden, "GALLERY_FORBIDDEN", "Galeri hanya untuk tamu yang sudah check-in di Photobooth.")
		return
	}
	all := s.store.EventPhotos(ev.ID, store.Photo.VisibleInGallery) // newest first
	page, hasMore := paginate(all, r, 60, 300)
	guests := map[string]bool{}
	likes := 0
	for _, p := range all {
		guests[strings.ToLower(p.GuestName)] = true
		likes += p.Likes + s.likes.pendingFor(p.EventID, p.ID)
	}
	views := s.viewPhotos(page, scopeGallery)
	for i := range views {
		views[i].Likes = max(0, views[i].Likes+s.likes.pendingFor(ev.ID, views[i].ID))
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"photos": views, "hasMore": hasMore, "event": s.publicView(ev),
		"stats": map[string]int{"photos": len(all), "guests": len(guests), "likes": likes},
	})
}

// paginate returns at most `limit` photos (query ?limit=, default def, max
// max) after the photo id given in ?before= (lists are newest first).
func paginate(all []store.Photo, r *http.Request, def, maxLimit int) ([]store.Photo, bool) {
	limit := def
	if n, err := strconv.Atoi(r.URL.Query().Get("limit")); err == nil && n > 0 {
		limit = min(n, maxLimit)
	}
	start := 0
	if before := r.URL.Query().Get("before"); before != "" {
		start = len(all) // unknown cursor → empty page
		for i, p := range all {
			if p.ID == before {
				start = i + 1
				break
			}
		}
	}
	end := min(start+limit, len(all))
	if start >= end {
		return []store.Photo{}, false
	}
	return all[start:end], end < len(all)
}

// galleryPhoto returns one photo, so clients add a newly published photo
// without re-downloading the whole gallery.
func (s *Server) galleryPhoto(w http.ResponseWriter, r *http.Request) {
	p, err := s.store.FindPhoto(r.PathValue("id"))
	if err != nil || !p.VisibleInGallery() {
		writeErr(w, http.StatusNotFound, "PHOTO_NOT_FOUND", "Foto tidak ditemukan.")
		return
	}
	ev, err := s.store.Event(p.EventID)
	if err != nil || !s.canViewGallery(r, ev) {
		writeErr(w, http.StatusNotFound, "PHOTO_NOT_FOUND", "Foto tidak ditemukan.")
		return
	}
	v := s.viewPhoto(p, scopeGallery)
	v.Likes = max(0, v.Likes+s.likes.pendingFor(p.EventID, p.ID))
	writeJSON(w, http.StatusOK, v)
}

func (s *Server) likePhoto(w http.ResponseWriter, r *http.Request) {
	if ok, wait := s.rl.like.Allow(s.clientIP(r)); !ok {
		writeRateLimited(w, wait)
		return
	}
	p, err := s.store.FindPhoto(r.PathValue("id"))
	if err != nil || !p.VisibleInGallery() {
		writeErr(w, http.StatusNotFound, "PHOTO_NOT_FOUND", "Foto tidak ditemukan.")
		return
	}
	ev, err := s.store.Event(p.EventID)
	if err != nil || !s.canViewGallery(r, ev) {
		writeErr(w, http.StatusNotFound, "PHOTO_NOT_FOUND", "Foto tidak ditemukan.")
		return
	}
	delta := 1
	if r.URL.Query().Get("undo") == "1" {
		delta = -1
	}
	// buffered: persisted in one batch per event every few seconds
	likes := max(0, p.Likes+s.likes.add(p.EventID, p.ID, delta))
	s.hub.Publish(p.EventID, "photo.liked", map[string]any{"id": p.ID, "likes": likes})
	writeJSON(w, http.StatusOK, map[string]any{"id": p.ID, "likes": likes})
}

// ---------- Like batching ----------

const likeFlushInterval = 3 * time.Second

type likeBuffer struct {
	mu      sync.Mutex
	pending map[string]map[string]int // event id → photo id → delta
}

func (b *likeBuffer) add(eventID, photoID string, delta int) int {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.pending == nil {
		b.pending = map[string]map[string]int{}
	}
	if b.pending[eventID] == nil {
		b.pending[eventID] = map[string]int{}
	}
	b.pending[eventID][photoID] += delta
	return b.pending[eventID][photoID]
}

func (b *likeBuffer) pendingFor(eventID, photoID string) int {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.pending[eventID][photoID]
}

// FlushLikes writes all pending likes (one store transaction per event).
// The buffer lock is released before touching the store.
func (s *Server) FlushLikes() {
	s.likes.mu.Lock()
	batch := s.likes.pending
	s.likes.pending = nil
	s.likes.mu.Unlock()
	for eventID, deltas := range batch {
		if _, err := s.store.AddLikes(eventID, deltas); err != nil {
			log.Printf("flush likes for %s: %v", eventID, err)
			// put them back so a transient failure does not lose taps
			for id, d := range deltas {
				s.likes.add(eventID, id, d)
			}
		}
	}
}

// ---------- Realtime (Server-Sent Events) ----------

func (s *Server) stream(w http.ResponseWriter, r *http.Request) {
	var ev store.Event
	var err error
	switch r.URL.Query().Get("scope") {
	case "host":
		_, ev, err = s.hostFromRequest(r)
	case "wall":
		ev, err = s.displayFromRequest(r)
	default:
		var ok bool
		if ev, ok = s.galleryEvent(r); !ok {
			err = errNoSession
		}
	}
	if err != nil {
		writeErr(w, http.StatusForbidden, "STREAM_FORBIDDEN", "Akses realtime ditolak.")
		return
	}
	flusher, ok := w.(http.Flusher)
	if !ok {
		writeError(w, http.StatusInternalServerError, "Streaming tidak didukung.")
		return
	}
	h := w.Header()
	h.Set("Content-Type", "text/event-stream")
	h.Set("Cache-Control", "no-cache, no-transform")
	h.Set("Connection", "keep-alive")
	h.Set("X-Accel-Buffering", "no")

	ch := s.hub.Subscribe(ev.ID)
	defer s.hub.Unsubscribe(ev.ID, ch)

	fmt.Fprint(w, "retry: 3000\n\n")
	flusher.Flush()

	ping := time.NewTicker(20 * time.Second)
	defer ping.Stop()
	for {
		select {
		case <-r.Context().Done():
			return
		case msg, ok := <-ch:
			if !ok {
				return
			}
			fmt.Fprintf(w, "data: %s\n\n", msg)
			flusher.Flush()
		case <-ping.C:
			fmt.Fprint(w, ": ping\n\n")
			flusher.Flush()
		}
	}
}

// ---------- Processing worker ----------

type photoRef struct{ eventID, photoID string }

func (s *Server) enqueue(eventID, id string) {
	s.jobs.Add(1)
	ref := photoRef{eventID, id}
	select {
	case s.queue <- ref:
	default:
		go func() { s.queue <- ref }()
	}
}

// WaitIdle blocks until every queued photo has been processed (tests).
func (s *Server) WaitIdle() { s.jobs.Wait() }

func (s *Server) worker() {
	for ref := range s.queue {
		s.process(ref.eventID, ref.photoID)
		s.jobs.Done()
	}
}

// process re-validates the original, strips metadata, writes display and
// thumbnail variants, deletes the original and marks the photo READY.
//
// No store lock is held during R2 reads/writes or image processing: the
// worker reads a copy of the record, works, then commits in one short
// transaction.
func (s *Server) process(eventID, id string) {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	p, err := s.store.Photo(eventID, id)
	if err != nil || p.Status != store.PhotoProcessing || p.DeletedAt != nil || p.OriginalKey == "" {
		return
	}
	fail := func(reason string, err error) {
		log.Printf("photo %s: %s: %v", id, reason, err)
		_ = s.storage.Delete(ctx, p.OriginalKey)
		_, _ = s.store.FailPhoto(eventID, id)
		s.hub.Publish(p.EventID, "photos.changed", nil)
	}
	data, err := storage.ReadAll(ctx, s.storage, p.OriginalKey, s.cfg.MaxUploadBytes)
	if err != nil {
		fail("read original", err)
		return
	}
	res, err := imageproc.Process(data, p.OriginalType)
	if err != nil {
		fail("process", err)
		return
	}
	displayKey := "events/" + p.EventID + "/photos/" + p.ID + ".jpg"
	cleanKey := "events/" + p.EventID + "/photos/" + p.ID + "clean.jpg"
	thumbKey := "events/" + p.EventID + "/thumbs/" + p.ID + ".jpg"
	var written []string
	for _, obj := range []struct {
		key  string
		data []byte
	}{{displayKey, res.Display}, {cleanKey, res.Clean}, {thumbKey, res.Thumb}} {
		if err := s.storage.Put(ctx, obj.key, "image/jpeg", obj.data); err != nil {
			for _, k := range written {
				_ = s.storage.Delete(ctx, k)
			}
			fail("store "+obj.key, err)
			return
		}
		written = append(written, obj.key)
	}
	original := p.OriginalKey
	p, err = s.store.UpdatePhoto(eventID, id, func(x *store.Photo) error {
		now := s.now().UTC()
		x.Status = store.PhotoReady
		x.DisplayKey, x.ThumbKey, x.CleanKey = displayKey, thumbKey, cleanKey
		x.Width, x.Height = res.Width, res.Height
		x.OriginalKey = ""
		x.ReadyAt = &now
		return nil
	})
	if err != nil {
		// deleted while processing
		for _, k := range written {
			_ = s.storage.Delete(ctx, k)
		}
		_ = s.storage.Delete(ctx, original)
		return
	}
	_ = s.storage.Delete(ctx, original) // original still had EXIF/GPS
	if p.VisibleOnWall() || p.VisibleInGallery() {
		s.hub.Publish(p.EventID, "photo.published", map[string]string{"id": p.ID})
	}
	s.hub.Publish(p.EventID, "photos.changed", nil)
}

// ---------- Moderation (shared by host and admin) ----------

var errBadAction = errors.New("bad action")

// moderate applies hide/restore/approve to a photo of eventID only.
func (s *Server) moderate(w http.ResponseWriter, r *http.Request, a actor, ev store.Event, photoID, action string) {
	var in struct {
		Target string `json:"target"` // wall | gallery | both (default both)
	}
	if !decodeJSON(w, r, &in, 1024) {
		return
	}
	wall, gallery := true, true
	switch in.Target {
	case "wall":
		gallery = false
	case "gallery":
		wall = false
	case "", "both":
	default:
		writeErr(w, http.StatusBadRequest, "BAD_TARGET", "Target harus wall, gallery, atau both.")
		return
	}
	p, err := s.store.UpdatePhoto(ev.ID, photoID, func(p *store.Photo) error {
		switch action {
		case "hide":
			if wall {
				p.HiddenFromWall = true
			}
			if gallery {
				p.HiddenFromGallery = true
			}
		case "restore":
			if wall {
				p.HiddenFromWall = false
			}
			if gallery {
				p.HiddenFromGallery = false
			}
		case "approve":
			p.Approval = store.Approved
		default:
			return errBadAction
		}
		return nil
	})
	if errors.Is(err, errBadAction) {
		writeErr(w, http.StatusBadRequest, "BAD_ACTION", "Aksi tidak dikenal.")
		return
	}
	if err != nil {
		writeErr(w, http.StatusNotFound, "PHOTO_NOT_FOUND", "Foto tidak ditemukan.")
		return
	}
	target := in.Target
	if target == "" {
		target = "both"
	}
	s.logAudit(a, ev.ID, "photo."+action, p.ID, map[string]string{"target": target})
	if p.VisibleOnWall() || p.VisibleInGallery() {
		s.hub.Publish(ev.ID, "photo.published", map[string]string{"id": p.ID})
	}
	if wall, gal := p.VisibleOnWall(), p.VisibleInGallery(); !wall || !gal {
		from := "both"
		if wall {
			from = "gallery"
		} else if gal {
			from = "wall"
		}
		s.hub.Publish(ev.ID, "photo.removed", map[string]string{"id": p.ID, "from": from})
	}
	s.hub.Publish(ev.ID, "photos.changed", nil)
	writeJSON(w, http.StatusOK, s.viewPhoto(p, scopeHost))
}

func (s *Server) deletePhoto(w http.ResponseWriter, r *http.Request, a actor, ev store.Event, photoID string) {
	p, err := s.store.DeletePhoto(ev.ID, photoID)
	if err != nil {
		writeErr(w, http.StatusNotFound, "PHOTO_NOT_FOUND", "Foto tidak ditemukan.")
		return
	}
	for _, k := range []string{p.DisplayKey, p.ThumbKey, p.CleanKey, p.OriginalKey} {
		if k != "" {
			_ = s.storage.Delete(r.Context(), k)
		}
	}
	s.logAudit(a, ev.ID, "photo.delete", p.ID, nil)
	s.hub.Publish(ev.ID, "photo.removed", map[string]string{"id": p.ID, "from": "both"})
	s.hub.Publish(ev.ID, "photos.changed", nil)
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) statsPayload(ev store.Event) map[string]any {
	st := s.store.Stats(ev.ID)
	return map[string]any{
		"totalPhotos":       st.TotalPhotos,
		"pendingApproval":   st.PendingApproval,
		"processing":        st.Processing,
		"hidden":            st.Hidden,
		"totalGuests":       st.TotalGuests,
		"guestsUploaded":    st.GuestsUploaded,
		"totalLikes":        st.TotalLikes,
		"lastHour":          st.LastHour,
		"liveViewers":       s.hub.Count(ev.ID),
		"maxPhotosPerGuest": ev.QuotaFor("photobooth"),
	}
}

// ---------- Couple download (no watermark) ----------

var unsafeName = regexp.MustCompile(`[^a-z0-9]+`)

func downloadName(p store.Photo, n int) string {
	name := strings.Trim(unsafeName.ReplaceAllString(strings.ToLower(p.GuestName), "-"), "-")
	if name == "" {
		name = "tamu"
	}
	if len(name) > 40 {
		name = name[:40]
	}
	if n > 0 {
		return fmt.Sprintf("%03d-%s.jpg", n, name)
	}
	return "seribu-lensa-" + name + "-" + p.ID + ".jpg"
}

// writePhotosZip streams every ready photo of the event — the copies without
// the studio watermark — as one ZIP for the couple. Objects are read one by
// one straight from storage; no store lock is held while streaming.
func (s *Server) writePhotosZip(w http.ResponseWriter, r *http.Request, a actor, ev store.Event) {
	photos := s.store.EventPhotos(ev.ID, func(p store.Photo) bool { return p.Status == store.PhotoReady && p.DeletedAt == nil })
	sort.Slice(photos, func(i, j int) bool { return photos[i].CreatedAt.Before(photos[j].CreatedAt) })
	slug := strings.Trim(unsafeName.ReplaceAllString(strings.ToLower(ev.Slug), "-"), "-")
	w.Header().Set("Content-Type", "application/zip")
	w.Header().Set("Content-Disposition", `attachment; filename="seribu-lensa-`+slug+`.zip"`)
	w.Header().Set("Cache-Control", "no-store")
	s.logAudit(a, ev.ID, "photos.download_zip", "", map[string]string{"count": itoa(len(photos))})
	zw := zip.NewWriter(w)
	for i, p := range photos {
		key := p.CleanKey
		if key == "" {
			key = p.DisplayKey
		}
		rc, _, err := s.storage.Open(r.Context(), key)
		if err != nil {
			continue
		}
		fw, err := zw.CreateHeader(&zip.FileHeader{Name: downloadName(p, i+1), Method: zip.Store, Modified: p.CreatedAt})
		if err == nil {
			_, err = io.Copy(fw, rc)
		}
		rc.Close()
		if err != nil {
			return // client went away; the archive is incomplete anyway
		}
	}
	_ = zw.Close()
}
