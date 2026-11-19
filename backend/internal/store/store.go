// Package store keeps wedding data in event-scoped JSON files.
//
// Layout (inside DATA_DIR, which must be a persistent volume):
//
//	db/global.json             default event + admin sessions (tiny)
//	db/events/{event_id}.json  one event: settings, guest sessions, upload
//	                           reservations, photo metadata, host & display sessions
//
// Photo binaries never live here — only object keys pointing into private
// storage (R2/S3).
//
// Concurrency: every event file has its own mutex, so traffic for one event
// never blocks another. A mutation of an event runs under that event's lock
// and is persisted with WriteFileAtomic (tmp → fsync → rename → fsync dir)
// before the method returns, so each method behaves like a serialisable,
// durable transaction for that event. This is what makes the photo quota
// race-free. Store methods never perform network calls; callers must do R2
// requests, image processing and geolocation outside of them.
//
// Lock order: mapMu → shard.mu → gmu. Never acquire mapMu while holding a
// shard lock.
//
// Limitation: one process per DATA_DIR.
package store

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/nakhasolution/weedingnakha/backend/internal/fsutil"
)

var (
	ErrNotFound           = errors.New("not found")
	ErrQuotaExceeded      = errors.New("quota exceeded")
	ErrReservationState   = errors.New("reservation is not pending")
	ErrReservationExpired = errors.New("reservation expired")
	ErrDuplicate          = errors.New("duplicate photo")
	ErrSessionRevoked     = errors.New("session revoked")
)

// ---------- Enums ----------

type EventStatus string

const (
	StatusDraft  EventStatus = "DRAFT"
	StatusActive EventStatus = "ACTIVE"
	StatusPaused EventStatus = "PAUSED"
	StatusEnded  EventStatus = "ENDED"
)

func ValidStatus(s EventStatus) bool {
	return s == StatusDraft || s == StatusActive || s == StatusPaused || s == StatusEnded
}

type ModerationMode string

const (
	AutoPublish    ModerationMode = "AUTO_PUBLISH"
	ManualApproval ModerationMode = "MANUAL_APPROVAL"
)

func ValidModeration(m ModerationMode) bool { return m == AutoPublish || m == ManualApproval }

type GalleryVisibility string

const (
	GalleryPublic  GalleryVisibility = "PUBLIC"  // anyone with the event link
	GalleryGuests  GalleryVisibility = "GUESTS"  // only checked-in guest sessions
	GalleryPrivate GalleryVisibility = "PRIVATE" // host/admin only
)

func ValidVisibility(v GalleryVisibility) bool {
	return v == GalleryPublic || v == GalleryGuests || v == GalleryPrivate
}

type PhotoStatus string

const (
	PhotoProcessing PhotoStatus = "PROCESSING"
	PhotoReady      PhotoStatus = "READY"
	PhotoFailed     PhotoStatus = "FAILED"
)

type Approval string

const (
	Approved        Approval = "APPROVED"
	PendingApproval Approval = "PENDING"
)

type ReservationStatus string

const (
	ResPending   ReservationStatus = "PENDING"
	ResConfirmed ReservationStatus = "CONFIRMED"
	ResReleased  ReservationStatus = "RELEASED"
)

// Themes / filters supported by the frontend.
var Themes = map[string]bool{"maroon": true, "sage": true, "terracotta": true, "navy": true}

const DefaultTheme = "maroon"

// Event types. Weddings are titled by the couple's names; every other type
// by a single event title.
const (
	TypeWedding   = "wedding"
	TypeCampus    = "campus"
	TypeCorporate = "corporate"
)

var EventTypes = map[string]bool{TypeWedding: true, TypeCampus: true, TypeCorporate: true}

// Kind returns the event type; events saved before types existed are weddings.
func (e Event) Kind() string {
	if EventTypes[e.Type] {
		return e.Type
	}
	return TypeWedding
}

// Filters are the photo filter ids accepted on upload ("warm", "film", "mono",
// "soft" are legacy ids kept for older photos and clients).
var Filters = map[string]bool{
	"none": true, "bw": true, "classic": true, "vintage": true, "softflash": true,
	// disposable-camera looks
	"goldenhour": true, "rose": true, "pastel": true, "cool": true, "moody": true, "noir": true,
	"disposable": true, "nightflash": true, "film400": true, "lightleak": true, "disposablebw": true,
	"instant": true, "expired": true, "crossprocess": true, "faded": true,
	"warm": true, "film": true, "mono": true, "soft": true,
}

const (
	DefaultRadiusMeters = 150
	MaxPhotosPerGuest   = 5
)

// ---------- Records ----------

type Event struct {
	ID     string      `json:"id"`
	Slug   string      `json:"slug"`
	Status EventStatus `json:"status"`

	// Invitation content (public).
	Type        string `json:"type,omitempty"`  // wedding (default) | campus | corporate
	Title       string `json:"title,omitempty"` // event name for non-wedding types
	GroomName   string `json:"groomName"`
	BrideName   string `json:"brideName"`
	GroomParent string `json:"groomParent"`
	BrideParent string `json:"brideParent"`
	Venue       string `json:"venue"`
	VenueAddr   string `json:"venueAddress"`
	MapsURL     string `json:"mapsUrl"`
	Hashtag     string `json:"hashtag"`
	Theme       string `json:"theme"`
	CoverKey    string `json:"coverKey,omitempty"`
	FrameKey    string `json:"frameKey,omitempty"` // custom photobooth frame (transparent PNG)

	// Schedule + geofence (private to host/admin).
	StartAt      time.Time `json:"startAt"`
	EndAt        time.Time `json:"endAt"`
	VenueLat     float64   `json:"venueLatitude"`
	VenueLng     float64   `json:"venueLongitude"`
	LocationSet  bool      `json:"locationSet"`
	RadiusMeters int       `json:"radiusMeters"`

	ModerationMode    ModerationMode    `json:"moderationMode"`
	GalleryVisibility GalleryVisibility `json:"galleryVisibility"`

	// Host access: only the SHA-256 of the token is stored.
	HostTokenHash      string     `json:"hostTokenHash,omitempty"`
	HostTokenVersion   int        `json:"hostTokenVersion"`
	HostTokenIssuedAt  *time.Time `json:"hostTokenIssuedAt,omitempty"`
	HostTokenRevokedAt *time.Time `json:"hostTokenRevokedAt,omitempty"`

	QRVersion      int `json:"qrVersion"`      // bump → every outstanding QR token dies
	DisplayVersion int `json:"displayVersion"` // bump → every Live Wall link + session dies

	LegacyCoverFile string    `json:"legacyCoverFile,omitempty"`
	CreatedAt       time.Time `json:"createdAt"`
	UpdatedAt       time.Time `json:"updatedAt"`
}

type GuestSession struct {
	ID                  string     `json:"id"`
	EventID             string     `json:"eventId"`
	DeviceIDHash        string     `json:"deviceIdHash"`
	SessionTokenHash    string     `json:"sessionTokenHash"`
	UploadedCount       int        `json:"uploadedCount"`
	ReservedCount       int        `json:"reservedCount"`
	CheckedInAt         time.Time  `json:"checkedInAt"`
	LastLocationCheckAt time.Time  `json:"lastLocationCheckAt"`
	LastDistanceMeters  int        `json:"lastDistanceMeters"` // rounded; raw coordinates are never stored
	LastAccuracyMeters  int        `json:"lastAccuracyMeters"`
	ExpiresAt           time.Time  `json:"expiresAt"`
	RevokedAt           *time.Time `json:"revokedAt,omitempty"`
}

type Reservation struct {
	ID             string            `json:"id"`
	EventID        string            `json:"eventId"`
	GuestSessionID string            `json:"guestSessionId"`
	ObjectKey      string            `json:"objectKey"`
	ContentType    string            `json:"contentType"`
	Size           int64             `json:"size"`
	GuestName      string            `json:"guestName"`
	Wishes         string            `json:"wishes"`
	Filter         string            `json:"filter"`
	Status         ReservationStatus `json:"status"`
	CreatedAt      time.Time         `json:"createdAt"`
	ExpiresAt      time.Time         `json:"expiresAt"`
	ClosedAt       *time.Time        `json:"closedAt,omitempty"`
}

type Photo struct {
	ID                string      `json:"id"`
	EventID           string      `json:"eventId"`
	GuestSessionID    string      `json:"guestSessionId,omitempty"`
	ReservationID     string      `json:"reservationId,omitempty"`
	GuestName         string      `json:"guestName"`
	Wishes            string      `json:"wishes"`
	Filter            string      `json:"filter"`
	Source            string      `json:"source"`
	Status            PhotoStatus `json:"status"`
	Approval          Approval    `json:"approval"`
	HiddenFromWall    bool        `json:"hiddenFromWall"`
	HiddenFromGallery bool        `json:"hiddenFromGallery"`
	OriginalKey       string      `json:"originalKey,omitempty"`
	OriginalType      string      `json:"originalType,omitempty"`
	DisplayKey        string      `json:"displayKey,omitempty"`
	ThumbKey          string      `json:"thumbKey,omitempty"`
	CleanKey          string      `json:"cleanKey,omitempty"` // display-size copy without the studio watermark (couple download)
	SHA256            string      `json:"sha256,omitempty"`
	SizeBytes         int64       `json:"sizeBytes"`
	Width             int         `json:"width"`
	Height            int         `json:"height"`
	Likes             int         `json:"likes"`
	LegacyFile        string      `json:"legacyFile,omitempty"`
	CreatedAt         time.Time   `json:"createdAt"`
	ReadyAt           *time.Time  `json:"readyAt,omitempty"`
	DeletedAt         *time.Time  `json:"deletedAt,omitempty"`
}

// VisibleOnWall: READY, approved, not hidden, not deleted.
func (p Photo) VisibleOnWall() bool {
	return p.Status == PhotoReady && p.Approval == Approved && !p.HiddenFromWall && p.DeletedAt == nil
}

// VisibleInGallery: READY, approved, not hidden, not deleted.
func (p Photo) VisibleInGallery() bool {
	return p.Status == PhotoReady && p.Approval == Approved && !p.HiddenFromGallery && p.DeletedAt == nil
}

type HostSession struct {
	ID               string    `json:"id"`
	EventID          string    `json:"eventId"`
	TokenHash        string    `json:"tokenHash"`
	HostTokenVersion int       `json:"hostTokenVersion"`
	CreatedAt        time.Time `json:"createdAt"`
	ExpiresAt        time.Time `json:"expiresAt"`
}

// DisplaySession is the read-only Live Wall session. It is a different
// record type from HostSession and is only ever checked by display routes.
type DisplaySession struct {
	ID             string    `json:"id"`
	EventID        string    `json:"eventId"`
	TokenHash      string    `json:"tokenHash"`
	DisplayVersion int       `json:"displayVersion"`
	CreatedAt      time.Time `json:"createdAt"`
	ExpiresAt      time.Time `json:"expiresAt"`
}

type AdminSession struct {
	ID        string    `json:"id"`
	TokenHash string    `json:"tokenHash"`
	CreatedAt time.Time `json:"createdAt"`
	ExpiresAt time.Time `json:"expiresAt"`
}

// ---------- On-disk documents ----------

const SchemaVersion = 3

type globalData struct {
	SchemaVersion  int             `json:"schemaVersion"`
	DefaultEventID string          `json:"defaultEventId"`
	AdminSessions  []*AdminSession `json:"adminSessions"`
}

type eventData struct {
	SchemaVersion   int               `json:"schemaVersion"`
	Event           *Event            `json:"event"`
	GuestSessions   []*GuestSession   `json:"guestSessions"`
	Reservations    []*Reservation    `json:"reservations"`
	Photos          []*Photo          `json:"photos"`
	HostSessions    []*HostSession    `json:"hostSessions"`
	DisplaySessions []*DisplaySession `json:"displaySessions"`
}

// shard is one event file with its own lock.
type shard struct {
	mu    sync.Mutex
	path  string
	d     eventData
	saved []byte
}

// commitErr wraps an error whose accompanying state change must be kept
// (e.g. "reservation expired" also releases the slot).
type commitErr struct{ err error }

func (c commitErr) Error() string { return c.err.Error() }

func encode(v any) ([]byte, error) { return json.MarshalIndent(v, "", "  ") }

func (sh *shard) saveLocked() error {
	b, err := encode(sh.d)
	if err != nil {
		return err
	}
	if err := fsutil.WriteFileAtomic(sh.path, b, 0o600); err != nil {
		return err
	}
	sh.saved = b
	return nil
}

func (sh *shard) rollbackLocked() {
	var d eventData
	if sh.saved != nil && json.Unmarshal(sh.saved, &d) == nil {
		sh.d = d
	}
}

// mutate runs fn as one durable transaction on this event.
func (sh *shard) mutate(fn func(d *eventData) error) error {
	sh.mu.Lock()
	defer sh.mu.Unlock()
	return sh.mutateLocked(fn)
}

func (sh *shard) mutateLocked(fn func(d *eventData) error) error {
	err := fn(&sh.d)
	var ce commitErr
	if err != nil && !errors.As(err, &ce) {
		sh.rollbackLocked()
		return err
	}
	if serr := sh.saveLocked(); serr != nil {
		sh.rollbackLocked()
		return serr
	}
	if err != nil {
		return ce.err
	}
	return nil
}

func (sh *shard) read(fn func(d *eventData)) {
	sh.mu.Lock()
	defer sh.mu.Unlock()
	fn(&sh.d)
}

// ---------- Store ----------

type Store struct {
	dir string // DATA_DIR/db
	now func() time.Time

	mapMu  sync.RWMutex // guards shards map membership and slug uniqueness
	shards map[string]*shard

	gmu         sync.Mutex // guards global.json only
	global      globalData
	globalSaved []byte
}

var eventIDRe = regexp.MustCompile(`^[a-z0-9]{8,40}$`)

// ValidEventID reports whether id has the shape of a server-generated ID.
func ValidEventID(id string) bool { return eventIDRe.MatchString(id) }

// Open loads the store from dataDir/db, migrating a legacy single-file
// dataDir/data.json (schema v1 or v2) into event-scoped files on first run.
func Open(dataDir string, now func() time.Time) (*Store, error) {
	if now == nil {
		now = time.Now
	}
	s := &Store{dir: filepath.Join(dataDir, "db"), now: now, shards: map[string]*shard{}}
	eventsDir := filepath.Join(s.dir, "events")
	if err := os.MkdirAll(eventsDir, 0o700); err != nil {
		return nil, err
	}
	fsutil.CleanTemp(s.dir)
	fsutil.CleanTemp(eventsDir)

	globalPath := filepath.Join(s.dir, "global.json")
	legacyPath := filepath.Join(dataDir, "data.json")
	if _, err := os.Stat(globalPath); errors.Is(err, os.ErrNotExist) {
		// global.json is written last, so event files without it are leftovers
		// of an interrupted migration: quarantine (never delete) them.
		if left, _ := filepath.Glob(filepath.Join(eventsDir, "*.json")); len(left) > 0 {
			q := filepath.Join(s.dir, fmt.Sprintf("incomplete-%d", now().Unix()))
			if err := os.MkdirAll(q, 0o700); err != nil {
				return nil, err
			}
			for _, f := range left {
				if err := os.Rename(f, filepath.Join(q, filepath.Base(f))); err != nil {
					return nil, err
				}
			}
		}
		if raw, err := os.ReadFile(legacyPath); err == nil {
			if err := s.importLegacy(raw); err != nil {
				return nil, fmt.Errorf("migrate %s: %w", legacyPath, err)
			}
			// keep the original as a backup, out of the way of future starts
			if err := os.Rename(legacyPath, fmt.Sprintf("%s.pre-v%d-%d", legacyPath, SchemaVersion, now().Unix())); err != nil {
				return nil, err
			}
			_ = fsutil.SyncDir(dataDir)
			return s, nil
		}
		s.global = globalData{SchemaVersion: SchemaVersion}
		return s, s.saveGlobalLocked()
	}

	b, err := os.ReadFile(globalPath)
	if err != nil {
		return nil, err
	}
	if err := json.Unmarshal(b, &s.global); err != nil {
		return nil, fmt.Errorf("parse global.json: %w", err)
	}
	if s.global.SchemaVersion > SchemaVersion {
		return nil, fmt.Errorf("data schema v%d is newer than this server (v%d)", s.global.SchemaVersion, SchemaVersion)
	}
	s.globalSaved = b

	files, err := filepath.Glob(filepath.Join(eventsDir, "*.json"))
	if err != nil {
		return nil, err
	}
	for _, f := range files {
		raw, err := os.ReadFile(f)
		if err != nil {
			return nil, err
		}
		var d eventData
		if err := json.Unmarshal(raw, &d); err != nil {
			return nil, fmt.Errorf("parse %s: %w", f, err)
		}
		if d.Event == nil || !ValidEventID(d.Event.ID) || filepath.Base(f) != d.Event.ID+".json" {
			return nil, fmt.Errorf("%s: event id does not match file name", f)
		}
		s.shards[d.Event.ID] = &shard{path: f, d: d, saved: raw}
	}
	return s, nil
}

func (s *Store) eventPath(id string) string { return filepath.Join(s.dir, "events", id+".json") }

func (s *Store) saveGlobalLocked() error {
	b, err := encode(s.global)
	if err != nil {
		return err
	}
	if err := fsutil.WriteFileAtomic(filepath.Join(s.dir, "global.json"), b, 0o600); err != nil {
		return err
	}
	s.globalSaved = b
	return nil
}

func (s *Store) mutateGlobal(fn func(g *globalData) error) error {
	s.gmu.Lock()
	defer s.gmu.Unlock()
	prev := s.global
	prev.AdminSessions = append([]*AdminSession(nil), s.global.AdminSessions...)
	if err := fn(&s.global); err != nil {
		s.global = prev
		return err
	}
	if err := s.saveGlobalLocked(); err != nil {
		s.global = prev
		return err
	}
	return nil
}

// shard returns the event's shard or nil.
func (s *Store) shard(eventID string) *shard {
	s.mapMu.RLock()
	defer s.mapMu.RUnlock()
	return s.shards[eventID]
}

// allShards snapshots the shard list so callers can lock shards one by one
// without holding mapMu.
func (s *Store) allShards() []*shard {
	s.mapMu.RLock()
	defer s.mapMu.RUnlock()
	out := make([]*shard, 0, len(s.shards))
	for _, sh := range s.shards {
		out = append(out, sh)
	}
	return out
}

// mutateEvent runs fn on one event's data as a durable transaction.
func (s *Store) mutateEvent(eventID string, fn func(d *eventData) error) error {
	sh := s.shard(eventID)
	if sh == nil {
		return ErrNotFound
	}
	return sh.mutate(fn)
}

func (s *Store) readEvent(eventID string, fn func(d *eventData)) bool {
	sh := s.shard(eventID)
	if sh == nil {
		return false
	}
	sh.read(fn)
	return true
}

// ---------- Events ----------

var slugRe = regexp.MustCompile(`[^a-z0-9]+`)

func Slugify(s string) string {
	s = slugRe.ReplaceAllString(strings.ToLower(s), "-")
	s = strings.Trim(s, "-")
	if len(s) > 48 {
		s = strings.Trim(s[:48], "-")
	}
	if s == "" {
		s = "acara"
	}
	return s
}

// uniqueSlugLocked requires mapMu held (write) and must not be called while
// holding the shard lock of exceptID.
func (s *Store) uniqueSlugLocked(base, exceptID string) string {
	taken := map[string]bool{}
	for id, sh := range s.shards {
		if id == exceptID {
			continue
		}
		sh.read(func(d *eventData) { taken[d.Event.Slug] = true })
	}
	slug := base
	for i := 2; taken[slug]; i++ {
		slug = fmt.Sprintf("%s-%d", base, i)
	}
	return slug
}

// CreateEvent stores a new event in its own file.
func (s *Store) CreateEvent(e Event) (Event, error) {
	if !ValidEventID(e.ID) {
		return Event{}, fmt.Errorf("invalid event id")
	}
	s.mapMu.Lock()
	if _, exists := s.shards[e.ID]; exists {
		s.mapMu.Unlock()
		return Event{}, fmt.Errorf("event exists")
	}
	e.Slug = s.uniqueSlugLocked(Slugify(e.Slug), "")
	e.CreatedAt = s.now().UTC()
	e.UpdatedAt = e.CreatedAt
	ev := e
	sh := &shard{path: s.eventPath(e.ID), d: eventData{SchemaVersion: SchemaVersion, Event: &ev}}
	sh.mu.Lock()
	err := sh.saveLocked()
	sh.mu.Unlock()
	if err == nil {
		s.shards[e.ID] = sh
	}
	s.mapMu.Unlock()
	if err != nil {
		return Event{}, err
	}
	_ = s.mutateGlobal(func(g *globalData) error {
		if g.DefaultEventID == "" {
			g.DefaultEventID = e.ID
		}
		return nil
	})
	return e, nil
}

func (s *Store) Event(id string) (Event, error) {
	var out Event
	if !s.readEvent(id, func(d *eventData) { out = *d.Event }) {
		return Event{}, ErrNotFound
	}
	return out, nil
}

func (s *Store) EventBySlug(slug string) (Event, error) {
	for _, sh := range s.allShards() {
		var ev Event
		sh.read(func(d *eventData) { ev = *d.Event })
		if ev.Slug == slug {
			return ev, nil
		}
	}
	return Event{}, ErrNotFound
}

// EventByHostTokenHash finds the event whose current (non-revoked) host
// token hashes to h.
func (s *Store) EventByHostTokenHash(h string) (Event, error) {
	for _, sh := range s.allShards() {
		var ev Event
		sh.read(func(d *eventData) { ev = *d.Event })
		if ev.HostTokenHash != "" && ev.HostTokenRevokedAt == nil && ev.HostTokenHash == h {
			return ev, nil
		}
	}
	return Event{}, ErrNotFound
}

func (s *Store) Events() []Event {
	var out []Event
	for _, sh := range s.allShards() {
		sh.read(func(d *eventData) { out = append(out, *d.Event) })
	}
	sort.Slice(out, func(i, j int) bool { return out[i].StartAt.After(out[j].StartAt) })
	return out
}

func (s *Store) DefaultEventID() string {
	s.gmu.Lock()
	defer s.gmu.Unlock()
	return s.global.DefaultEventID
}

func (s *Store) SetDefaultEvent(id string) error {
	if s.shard(id) == nil {
		return ErrNotFound
	}
	return s.mutateGlobal(func(g *globalData) error {
		g.DefaultEventID = id
		return nil
	})
}

// UpdateEvent applies fn to the event inside a transaction. Slug changes are
// made unique across events.
func (s *Store) UpdateEvent(id string, fn func(e *Event) error) (Event, error) {
	s.mapMu.Lock() // serialises slug changes; acquired before the shard lock
	defer s.mapMu.Unlock()
	sh := s.shards[id]
	if sh == nil {
		return Event{}, ErrNotFound
	}
	var out Event
	// Read-modify-write entirely under this event's lock so concurrent
	// mutations (e.g. a host-token revoke) can never be overwritten. The
	// slug check reads other shards while holding this one; that is
	// deadlock-free because only mapMu holders (one at a time) nest locks.
	err := sh.mutate(func(d *eventData) error {
		next := *d.Event
		if err := fn(&next); err != nil {
			return err
		}
		if next.Slug != d.Event.Slug {
			next.Slug = s.uniqueSlugLocked(Slugify(next.Slug), id)
		}
		next.ID = id
		next.UpdatedAt = s.now().UTC()
		d.Event = &next
		out = next
		return nil
	})
	return out, err
}

// SetHostToken stores a new host token hash and invalidates every existing
// host session for that event (version bump + delete), in one transaction.
func (s *Store) SetHostToken(eventID, hash string) (Event, error) {
	return s.replaceHostToken(eventID, hash)
}

// RevokeHostToken clears the token and deletes every host session of the
// event in the same transaction.
func (s *Store) RevokeHostToken(eventID string) (Event, error) {
	return s.replaceHostToken(eventID, "")
}

func (s *Store) replaceHostToken(eventID, hash string) (Event, error) {
	var out Event
	err := s.mutateEvent(eventID, func(d *eventData) error {
		now := s.now().UTC()
		e := d.Event
		e.HostTokenHash = hash
		e.HostTokenVersion++
		if hash == "" {
			e.HostTokenRevokedAt = &now
		} else {
			e.HostTokenIssuedAt = &now
			e.HostTokenRevokedAt = nil
		}
		e.UpdatedAt = now
		d.HostSessions = nil
		out = *e
		return nil
	})
	return out, err
}

// ---------- Host / display / admin sessions ----------

func (s *Store) CreateHostSession(hs HostSession) error {
	return s.mutateEvent(hs.EventID, func(d *eventData) error {
		hs.CreatedAt = s.now().UTC()
		d.HostSessions = append(d.HostSessions, &hs)
		return nil
	})
}

func (s *Store) HostSessionByHash(eventID, h string) (HostSession, error) {
	var out HostSession
	err := ErrNotFound
	s.readEvent(eventID, func(d *eventData) {
		for _, hs := range d.HostSessions {
			if hs.TokenHash == h {
				out, err = *hs, nil
				return
			}
		}
	})
	return out, err
}

func (s *Store) DeleteHostSession(eventID, h string) {
	_ = s.mutateEvent(eventID, func(d *eventData) error {
		keep := d.HostSessions[:0]
		for _, hs := range d.HostSessions {
			if hs.TokenHash != h {
				keep = append(keep, hs)
			}
		}
		d.HostSessions = keep
		return nil
	})
}

func (s *Store) CreateDisplaySession(ds DisplaySession) error {
	return s.mutateEvent(ds.EventID, func(d *eventData) error {
		ds.CreatedAt = s.now().UTC()
		d.DisplaySessions = append(d.DisplaySessions, &ds)
		return nil
	})
}

func (s *Store) DisplaySessionByHash(eventID, h string) (DisplaySession, error) {
	var out DisplaySession
	err := ErrNotFound
	s.readEvent(eventID, func(d *eventData) {
		for _, ds := range d.DisplaySessions {
			if ds.TokenHash == h {
				out, err = *ds, nil
				return
			}
		}
	})
	return out, err
}

// RotateDisplay invalidates every Live Wall link and session of the event.
func (s *Store) RotateDisplay(eventID string) (Event, error) {
	var out Event
	err := s.mutateEvent(eventID, func(d *eventData) error {
		d.Event.DisplayVersion++
		d.Event.UpdatedAt = s.now().UTC()
		d.DisplaySessions = nil
		out = *d.Event
		return nil
	})
	return out, err
}

func (s *Store) CreateAdminSession(as AdminSession) error {
	return s.mutateGlobal(func(g *globalData) error {
		as.CreatedAt = s.now().UTC()
		g.AdminSessions = append(g.AdminSessions, &as)
		return nil
	})
}

func (s *Store) AdminSessionByHash(h string) (AdminSession, error) {
	s.gmu.Lock()
	defer s.gmu.Unlock()
	for _, as := range s.global.AdminSessions {
		if as.TokenHash == h {
			return *as, nil
		}
	}
	return AdminSession{}, ErrNotFound
}

func (s *Store) DeleteAdminSession(h string) {
	_ = s.mutateGlobal(func(g *globalData) error {
		keep := []*AdminSession{}
		for _, as := range g.AdminSessions {
			if as.TokenHash != h {
				keep = append(keep, as)
			}
		}
		g.AdminSessions = keep
		return nil
	})
}

// ---------- Guest sessions ----------

// CheckinGuest creates a guest session for (event, device), or rotates the
// token of the existing one. Re-checking in never resets the photo counters,
// so clearing cookies alone does not grant a fresh quota.
func (s *Store) CheckinGuest(eventID, deviceHash, tokenHash string, exp time.Time, distM, accM int) (GuestSession, error) {
	var out GuestSession
	err := s.mutateEvent(eventID, func(d *eventData) error {
		now := s.now().UTC()
		var gs *GuestSession
		for _, g := range d.GuestSessions {
			if g.DeviceIDHash == deviceHash {
				gs = g
				break
			}
		}
		if gs != nil && gs.RevokedAt != nil {
			return ErrSessionRevoked
		}
		if gs == nil {
			gs = &GuestSession{ID: NewID(), EventID: eventID, DeviceIDHash: deviceHash, CheckedInAt: now}
			d.GuestSessions = append(d.GuestSessions, gs)
		}
		gs.SessionTokenHash = tokenHash
		gs.LastLocationCheckAt = now
		gs.LastDistanceMeters = distM
		gs.LastAccuracyMeters = accM
		gs.ExpiresAt = exp
		out = *gs
		return nil
	})
	return out, err
}

func findGuest(d *eventData, id string) *GuestSession {
	for _, g := range d.GuestSessions {
		if g.ID == id {
			return g
		}
	}
	return nil
}

func (s *Store) GuestSessionByHash(eventID, h string) (GuestSession, error) {
	var out GuestSession
	err := ErrNotFound
	s.readEvent(eventID, func(d *eventData) {
		for _, g := range d.GuestSessions {
			if g.SessionTokenHash == h {
				out, err = *g, nil
				return
			}
		}
	})
	return out, err
}

func (s *Store) GuestSession(eventID, id string) (GuestSession, error) {
	var out GuestSession
	err := ErrNotFound
	s.readEvent(eventID, func(d *eventData) {
		if g := findGuest(d, id); g != nil {
			out, err = *g, nil
		}
	})
	return out, err
}

func (s *Store) TouchGuestLocation(eventID, id string, distM, accM int) (GuestSession, error) {
	var out GuestSession
	err := s.mutateEvent(eventID, func(d *eventData) error {
		g := findGuest(d, id)
		if g == nil {
			return ErrNotFound
		}
		g.LastLocationCheckAt = s.now().UTC()
		g.LastDistanceMeters = distM
		g.LastAccuracyMeters = accM
		out = *g
		return nil
	})
	return out, err
}

// ---------- Upload reservations (quota) ----------

func releaseLocked(d *eventData, r *Reservation, now time.Time) {
	if r.Status != ResPending {
		return
	}
	r.Status = ResReleased
	r.ClosedAt = &now
	if g := findGuest(d, r.GuestSessionID); g != nil && g.ReservedCount > 0 {
		g.ReservedCount--
	}
}

// ReserveUpload atomically and durably grants one upload slot if
// uploaded_count + reserved_count < max. The reservation is on disk (fsynced)
// before this returns, i.e. before any presigned URL can be issued.
// Expired reservations of the same session are released first.
func (s *Store) ReserveUpload(eventID, sessionID string, r Reservation, ttl time.Duration, max int) (Reservation, GuestSession, []Reservation, error) {
	var out Reservation
	var gsOut GuestSession
	var expired []Reservation
	err := s.mutateEvent(eventID, func(d *eventData) error {
		now := s.now().UTC()
		g := findGuest(d, sessionID)
		if g == nil {
			return ErrNotFound
		}
		if g.RevokedAt != nil {
			return ErrSessionRevoked
		}
		for _, res := range d.Reservations {
			if res.GuestSessionID == g.ID && res.Status == ResPending && !now.Before(res.ExpiresAt) {
				releaseLocked(d, res, now)
				expired = append(expired, *res)
			}
		}
		if g.UploadedCount+g.ReservedCount >= max {
			if len(expired) > 0 {
				return commitErr{ErrQuotaExceeded}
			}
			return ErrQuotaExceeded
		}
		r.EventID = eventID
		r.GuestSessionID = g.ID
		r.Status = ResPending
		r.CreatedAt = now
		r.ExpiresAt = now.Add(ttl)
		res := r
		d.Reservations = append(d.Reservations, &res)
		g.ReservedCount++
		out, gsOut = res, *g
		return nil
	})
	return out, gsOut, expired, err
}

func (s *Store) Reservation(eventID, id string) (Reservation, error) {
	var out Reservation
	err := ErrNotFound
	s.readEvent(eventID, func(d *eventData) {
		for _, r := range d.Reservations {
			if r.ID == id {
				out, err = *r, nil
				return
			}
		}
	})
	return out, err
}

// ConfirmUpload turns a pending reservation owned by sessionID into a photo.
// On expiry or duplicate content the slot is released (and that release is
// persisted) before the error is returned.
func (s *Store) ConfirmUpload(eventID, resID, sessionID string, p Photo) (Photo, GuestSession, error) {
	var out Photo
	var gsOut GuestSession
	err := s.mutateEvent(eventID, func(d *eventData) error {
		now := s.now().UTC()
		var r *Reservation
		for _, x := range d.Reservations {
			if x.ID == resID && x.GuestSessionID == sessionID {
				r = x
				break
			}
		}
		if r == nil {
			return ErrNotFound
		}
		if r.Status != ResPending {
			return ErrReservationState
		}
		if !now.Before(r.ExpiresAt) {
			releaseLocked(d, r, now)
			return commitErr{ErrReservationExpired}
		}
		if p.SHA256 != "" {
			for _, x := range d.Photos {
				if x.SHA256 == p.SHA256 && x.DeletedAt == nil && x.Status != PhotoFailed {
					releaseLocked(d, r, now)
					return commitErr{ErrDuplicate}
				}
			}
		}
		g := findGuest(d, sessionID)
		if g == nil {
			return ErrNotFound
		}
		r.Status = ResConfirmed
		r.ClosedAt = &now
		if g.ReservedCount > 0 {
			g.ReservedCount--
		}
		g.UploadedCount++

		p.EventID = eventID
		p.GuestSessionID = g.ID
		p.ReservationID = r.ID
		p.GuestName = r.GuestName
		p.Wishes = r.Wishes
		p.Filter = r.Filter
		p.Source = "photobooth"
		p.OriginalKey = r.ObjectKey
		p.OriginalType = r.ContentType
		p.Status = PhotoProcessing
		p.CreatedAt = now
		ph := p
		d.Photos = append(d.Photos, &ph)
		out, gsOut = ph, *g
		return nil
	})
	return out, gsOut, err
}

// ReleaseReservation frees a pending reservation owned by sessionID.
func (s *Store) ReleaseReservation(eventID, resID, sessionID string) (Reservation, error) {
	var out Reservation
	err := s.mutateEvent(eventID, func(d *eventData) error {
		for _, r := range d.Reservations {
			if r.ID == resID && r.GuestSessionID == sessionID {
				if r.Status != ResPending {
					return ErrReservationState
				}
				releaseLocked(d, r, s.now().UTC())
				out = *r
				return nil
			}
		}
		return ErrNotFound
	})
	return out, err
}

// ReleaseExpired frees every pending reservation past its expiry (all
// events, one event lock at a time) and prunes closed reservations older
// than a day. It returns the released ones so the caller can delete any
// partially uploaded objects — outside of any lock.
func (s *Store) ReleaseExpired() []Reservation {
	var released []Reservation
	for _, sh := range s.allShards() {
		sh.mu.Lock()
		now := s.now().UTC()
		changed := false
		for _, r := range sh.d.Reservations {
			if (r.Status == ResPending && !now.Before(r.ExpiresAt)) || (r.ClosedAt != nil && now.Sub(*r.ClosedAt) > 24*time.Hour) {
				changed = true
				break
			}
		}
		if changed {
			_ = sh.mutateLocked(func(d *eventData) error {
				keep := d.Reservations[:0]
				for _, r := range d.Reservations {
					if r.Status == ResPending && !now.Before(r.ExpiresAt) {
						releaseLocked(d, r, now)
						released = append(released, *r)
					}
					if r.ClosedAt != nil && now.Sub(*r.ClosedAt) > 24*time.Hour {
						continue
					}
					keep = append(keep, r)
				}
				d.Reservations = keep
				return nil
			})
		}
		sh.mu.Unlock()
	}
	return released
}

// PruneSessions removes expired admin/host/display sessions.
func (s *Store) PruneSessions() {
	now := s.now()
	for _, sh := range s.allShards() {
		_ = sh.mutate(func(d *eventData) error {
			hs := d.HostSessions[:0]
			for _, x := range d.HostSessions {
				if now.Before(x.ExpiresAt) {
					hs = append(hs, x)
				}
			}
			d.HostSessions = hs
			ds := d.DisplaySessions[:0]
			for _, x := range d.DisplaySessions {
				if now.Before(x.ExpiresAt) {
					ds = append(ds, x)
				}
			}
			d.DisplaySessions = ds
			return nil
		})
	}
	_ = s.mutateGlobal(func(g *globalData) error {
		keep := []*AdminSession{}
		for _, x := range g.AdminSessions {
			if now.Before(x.ExpiresAt) {
				keep = append(keep, x)
			}
		}
		g.AdminSessions = keep
		return nil
	})
}

// ---------- Photos ----------

func findPhoto(d *eventData, id string) *Photo {
	for _, p := range d.Photos {
		if p.ID == id {
			return p
		}
	}
	return nil
}

func (s *Store) Photo(eventID, id string) (Photo, error) {
	var out Photo
	err := ErrNotFound
	s.readEvent(eventID, func(d *eventData) {
		if p := findPhoto(d, id); p != nil {
			out, err = *p, nil
		}
	})
	return out, err
}

// FindPhoto locates a photo by ID across events (for routes that only carry
// a photo ID). Authorization must still be checked against p.EventID.
func (s *Store) FindPhoto(id string) (Photo, error) {
	for _, sh := range s.allShards() {
		var out *Photo
		sh.read(func(d *eventData) {
			if p := findPhoto(d, id); p != nil {
				cp := *p
				out = &cp
			}
		})
		if out != nil {
			return *out, nil
		}
	}
	return Photo{}, ErrNotFound
}

// EventPhotos returns the event's non-deleted photos (newest first) that keep(p) accepts.
func (s *Store) EventPhotos(eventID string, keep func(Photo) bool) []Photo {
	out := []Photo{}
	s.readEvent(eventID, func(d *eventData) {
		for _, p := range d.Photos {
			if p.DeletedAt == nil && (keep == nil || keep(*p)) {
				out = append(out, *p)
			}
		}
	})
	sort.SliceStable(out, func(i, j int) bool { return out[i].CreatedAt.After(out[j].CreatedAt) })
	return out
}

// PhotosToProcess lists photos still waiting for the worker (crash recovery).
func (s *Store) PhotosToProcess() []Photo {
	var out []Photo
	for _, sh := range s.allShards() {
		sh.read(func(d *eventData) {
			for _, p := range d.Photos {
				if p.Status == PhotoProcessing && p.DeletedAt == nil {
					out = append(out, *p)
				}
			}
		})
	}
	return out
}

// UpdatePhoto mutates a non-deleted photo of eventID.
func (s *Store) UpdatePhoto(eventID, id string, fn func(p *Photo) error) (Photo, error) {
	var out Photo
	err := s.mutateEvent(eventID, func(d *eventData) error {
		p := findPhoto(d, id)
		if p == nil || p.DeletedAt != nil {
			return ErrNotFound
		}
		if err := fn(p); err != nil {
			return err
		}
		out = *p
		return nil
	})
	return out, err
}

// FailPhoto marks processing as failed and refunds the guest's quota slot.
func (s *Store) FailPhoto(eventID, id string) (Photo, error) {
	var out Photo
	err := s.mutateEvent(eventID, func(d *eventData) error {
		p := findPhoto(d, id)
		if p == nil {
			return ErrNotFound
		}
		if p.Status != PhotoFailed {
			p.Status = PhotoFailed
			if g := findGuest(d, p.GuestSessionID); g != nil && g.UploadedCount > 0 {
				g.UploadedCount--
			}
		}
		out = *p
		return nil
	})
	return out, err
}

// DeletePhoto soft-deletes (keeps the hash for dedup and the audit trail)
// and returns the record so the caller can remove the stored objects.
func (s *Store) DeletePhoto(eventID, id string) (Photo, error) {
	return s.UpdatePhoto(eventID, id, func(p *Photo) error {
		now := s.now().UTC()
		p.DeletedAt = &now
		return nil
	})
}

// AddLikes applies many like deltas of one event in a single write (the
// server batches likes so a burst of taps is not one 5 MB rewrite each).
// Missing/deleted photos are skipped. Returns the new counts.
func (s *Store) AddLikes(eventID string, deltas map[string]int) (map[string]int, error) {
	out := make(map[string]int, len(deltas))
	err := s.mutateEvent(eventID, func(d *eventData) error {
		for id, delta := range deltas {
			p := findPhoto(d, id)
			if p == nil || p.DeletedAt != nil {
				continue
			}
			p.Likes = max(0, p.Likes+delta)
			out[id] = p.Likes
		}
		return nil
	})
	return out, err
}

func (s *Store) LikePhoto(eventID, id string, delta int) (Photo, error) {
	return s.UpdatePhoto(eventID, id, func(p *Photo) error {
		p.Likes += delta
		if p.Likes < 0 {
			p.Likes = 0
		}
		return nil
	})
}

// ---------- Stats ----------

type Stats struct {
	TotalPhotos     int `json:"totalPhotos"`
	PendingApproval int `json:"pendingApproval"`
	Processing      int `json:"processing"`
	Hidden          int `json:"hidden"`
	TotalGuests     int `json:"totalGuests"`    // checked-in devices
	GuestsUploaded  int `json:"guestsUploaded"` // devices that sent ≥1 photo
	TotalLikes      int `json:"totalLikes"`
	LastHour        int `json:"lastHour"`
}

func (s *Store) Stats(eventID string) Stats {
	var st Stats
	s.readEvent(eventID, func(d *eventData) {
		cutoff := s.now().Add(-time.Hour)
		for _, p := range d.Photos {
			if p.DeletedAt != nil || p.Status == PhotoFailed {
				continue
			}
			switch {
			case p.Status == PhotoProcessing:
				st.Processing++
			case p.Approval == PendingApproval:
				st.PendingApproval++
			default:
				st.TotalPhotos++
				if p.HiddenFromWall || p.HiddenFromGallery {
					st.Hidden++
				}
			}
			st.TotalLikes += p.Likes
			if p.CreatedAt.After(cutoff) {
				st.LastHour++
			}
		}
		for _, g := range d.GuestSessions {
			st.TotalGuests++
			if g.UploadedCount > 0 {
				st.GuestsUploaded++
			}
		}
	})
	return st
}

// ---------- Storage bookkeeping ----------

// LegacyPhotos returns migrated v1 photos whose files still need importing.
func (s *Store) LegacyPhotos() []Photo {
	var out []Photo
	for _, sh := range s.allShards() {
		sh.read(func(d *eventData) {
			for _, p := range d.Photos {
				if p.LegacyFile != "" {
					out = append(out, *p)
				}
			}
		})
	}
	return out
}

// ReferencedKeys returns every object key that must be kept: cover photos, custom frames,
// photo variants of non-deleted photos, originals still being processed and
// objects of pending reservations. Anything else under events/ is an orphan.
func (s *Store) ReferencedKeys() map[string]bool {
	keep := map[string]bool{}
	add := func(k string) {
		if k != "" {
			keep[k] = true
		}
	}
	for _, sh := range s.allShards() {
		sh.read(func(d *eventData) {
			add(d.Event.CoverKey)
			add(d.Event.FrameKey)
			for _, p := range d.Photos {
				if p.DeletedAt == nil && p.Status != PhotoFailed {
					add(p.DisplayKey)
					add(p.ThumbKey)
					add(p.CleanKey)
					add(p.OriginalKey)
				}
			}
			for _, r := range d.Reservations {
				if r.Status == ResPending {
					add(r.ObjectKey)
				}
			}
		})
	}
	return keep
}

// Snapshot returns a consistent copy of every persisted file (as last
// written to disk), keyed by path relative to DATA_DIR. Used for backups.
func (s *Store) Snapshot() map[string][]byte {
	out := map[string][]byte{}
	s.gmu.Lock()
	out["db/global.json"] = append([]byte(nil), s.globalSaved...)
	s.gmu.Unlock()
	for _, sh := range s.allShards() {
		sh.mu.Lock()
		out["db/events/"+filepath.Base(sh.path)] = append([]byte(nil), sh.saved...)
		sh.mu.Unlock()
	}
	return out
}
