package store

import (
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/nakhasolution/weedingnakha/backend/internal/security"
)

func randHex(n int) string { return security.RandomHex(n) }

// NewEventID returns an ID that also satisfies the storage key pattern.
func NewEventID() string { return randHex(8) }

// NewID returns a random 16-hex-char identifier.
func NewID() string { return randHex(8) }

// EventLocation is the timezone used to turn the legacy "YYYY-MM-DD"+"HH:MM"
// fields into instants. Set by main from EVENT_TIMEZONE.
var EventLocation = time.FixedZone("WIB", 7*3600)

// ---------- Schema migrations ----------
//
// v1: DATA_DIR/data.json = {"event": {...single event...}, "photos": [...]},
//     photo files publicly served from DATA_DIR/uploads.
// v2: DATA_DIR/data.json = one multi-event document (every record has an
//     event_id) — a short-lived intermediate format.
// v3 (current): event-scoped files DATA_DIR/db/events/{id}.json plus a tiny
//     DATA_DIR/db/global.json. See store.go.
//
// On first start with a legacy data.json, Open() converts it, writes all v3
// files durably, then renames data.json to data.json.pre-v3-<unix> (backup).
//
// v1 specifics: the single event becomes a DRAFT event without coordinates
// or host token (photobooth stays closed until an admin reviews it);
// startAt = eventDate+eventTime (EventLocation), endAt = startAt + 6h; each
// legacy photo becomes PROCESSING with LegacyFile set — the server copies it
// into private storage and re-processes it (EXIF strip, thumbnail).

type v1Event struct {
	GroomName   string `json:"groomName"`
	BrideName   string `json:"brideName"`
	GroomParent string `json:"groomParent"`
	BrideParent string `json:"brideParent"`
	EventDate   string `json:"eventDate"`
	EventTime   string `json:"eventTime"`
	Venue       string `json:"venue"`
	VenueAddr   string `json:"venueAddress"`
	MapsURL     string `json:"mapsUrl"`
	Hashtag     string `json:"hashtag"`
	Theme       string `json:"theme"`
	CoverURL    string `json:"coverUrl"`
}

type v1Photo struct {
	ID        string    `json:"id"`
	GuestName string    `json:"guestName"`
	Wishes    string    `json:"wishes"`
	FileName  string    `json:"fileName"`
	Filter    string    `json:"filter"`
	Source    string    `json:"source"`
	Likes     int       `json:"likes"`
	CreatedAt time.Time `json:"createdAt"`
}

type v1Data struct {
	Event  *v1Event  `json:"event"`
	Photos []v1Photo `json:"photos"`
}

// v2Data is the intermediate single-file multi-event document.
type v2Data struct {
	SchemaVersion  int             `json:"schemaVersion"`
	DefaultEventID string          `json:"defaultEventId"`
	Events         []*Event        `json:"events"`
	GuestSessions  []*GuestSession `json:"guestSessions"`
	Reservations   []*Reservation  `json:"reservations"`
	Photos         []*Photo        `json:"photos"`
	HostSessions   []*HostSession  `json:"hostSessions"`
	AdminSessions  []*AdminSession `json:"adminSessions"`
}

// importLegacy converts a legacy data.json and writes the v3 files.
func (s *Store) importLegacy(raw []byte) error {
	var probe struct {
		SchemaVersion int `json:"schemaVersion"`
	}
	if err := json.Unmarshal(raw, &probe); err != nil {
		return fmt.Errorf("parse data file: %w", err)
	}
	var v2 v2Data
	switch probe.SchemaVersion {
	case 0:
		d, err := migrateV1(raw, s.now())
		if err != nil {
			return err
		}
		v2 = d
	case 2:
		if err := json.Unmarshal(raw, &v2); err != nil {
			return err
		}
	default:
		return fmt.Errorf("unsupported legacy schema v%d", probe.SchemaVersion)
	}

	shards := map[string]*eventData{}
	for _, e := range v2.Events {
		if !ValidEventID(e.ID) {
			return fmt.Errorf("invalid event id %q", e.ID)
		}
		shards[e.ID] = &eventData{SchemaVersion: SchemaVersion, Event: e}
	}
	for _, g := range v2.GuestSessions {
		if d := shards[g.EventID]; d != nil {
			d.GuestSessions = append(d.GuestSessions, g)
		}
	}
	for _, r := range v2.Reservations {
		if d := shards[r.EventID]; d != nil {
			d.Reservations = append(d.Reservations, r)
		}
	}
	for _, p := range v2.Photos {
		if d := shards[p.EventID]; d != nil {
			d.Photos = append(d.Photos, p)
		}
	}
	for _, h := range v2.HostSessions {
		if d := shards[h.EventID]; d != nil {
			d.HostSessions = append(d.HostSessions, h)
		}
	}

	s.mapMu.Lock()
	defer s.mapMu.Unlock()
	for id, d := range shards {
		sh := &shard{path: s.eventPath(id), d: *d}
		if err := sh.saveLocked(); err != nil {
			return err
		}
		s.shards[id] = sh
	}
	s.gmu.Lock()
	defer s.gmu.Unlock()
	s.global = globalData{SchemaVersion: SchemaVersion, DefaultEventID: v2.DefaultEventID, AdminSessions: v2.AdminSessions}
	// global.json is written last: its presence marks a completed migration.
	return s.saveGlobalLocked()
}

func migrateV1(raw []byte, now time.Time) (v2Data, error) {
	var v1 v1Data
	if err := json.Unmarshal(raw, &v1); err != nil {
		return v2Data{}, fmt.Errorf("parse v1 data: %w", err)
	}
	d := v2Data{SchemaVersion: 2}
	if v1.Event == nil {
		return d, nil
	}
	e := v1.Event
	start, err := time.ParseInLocation("2006-01-02 15:04", e.EventDate+" "+orDefault(e.EventTime, "10:00"), EventLocation)
	if err != nil {
		start = now.Add(30 * 24 * time.Hour)
	}
	theme := e.Theme
	if !Themes[theme] {
		theme = DefaultTheme
	}
	ev := &Event{
		ID:                NewEventID(),
		Slug:              Slugify(e.GroomName + "-" + e.BrideName),
		Status:            StatusDraft,
		GroomName:         e.GroomName,
		BrideName:         e.BrideName,
		GroomParent:       e.GroomParent,
		BrideParent:       e.BrideParent,
		Venue:             e.Venue,
		VenueAddr:         e.VenueAddr,
		MapsURL:           e.MapsURL,
		Hashtag:           e.Hashtag,
		Theme:             theme,
		StartAt:           start.UTC(),
		EndAt:             start.Add(6 * time.Hour).UTC(),
		RadiusMeters:      DefaultRadiusMeters,
		ModerationMode:    AutoPublish,
		GalleryVisibility: GalleryGuests,
		QRVersion:         1,
		DisplayVersion:    1,
		CreatedAt:         now.UTC(),
		UpdatedAt:         now.UTC(),
	}
	if f, ok := strings.CutPrefix(e.CoverURL, "/uploads/"); ok {
		ev.LegacyCoverFile = f
	}
	d.Events = []*Event{ev}
	d.DefaultEventID = ev.ID

	for _, p := range v1.Photos {
		if p.FileName == "" {
			continue
		}
		filter := p.Filter
		if !Filters[filter] {
			filter = "none"
		}
		d.Photos = append(d.Photos, &Photo{
			ID:         strings.ToLower(p.ID),
			EventID:    ev.ID,
			GuestName:  p.GuestName,
			Wishes:     p.Wishes,
			Filter:     filter,
			Source:     orDefault(p.Source, "upload"),
			Status:     PhotoProcessing,
			Approval:   Approved,
			Likes:      p.Likes,
			LegacyFile: p.FileName,
			CreatedAt:  p.CreatedAt,
		})
	}
	return d, nil
}

func orDefault(s, def string) string {
	if strings.TrimSpace(s) == "" {
		return def
	}
	return s
}
