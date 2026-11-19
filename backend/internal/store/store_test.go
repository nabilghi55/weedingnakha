package store

import (
	"bytes"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"
)

const v1 = `{
  "event": {"groomName":"Ihsan","brideName":"Ara","eventDate":"2026-12-12","eventTime":"10:00",
            "venue":"Graha","theme":"terracotta","coverUrl":"/uploads/0123456789abcdef.jpg"},
  "photos": [{"id":"aaaaaaaaaaaaaaaa","guestName":"Budi","wishes":"Hi","fileName":"aaaaaaaaaaaaaaaa.jpg",
              "filter":"warm","source":"upload","likes":3,"createdAt":"2026-12-12T03:00:00Z"}]
}`

func TestMigrateV1ToEventFiles(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "data.json"), []byte(v1), 0o600); err != nil {
		t.Fatal(err)
	}
	s, err := Open(dir, func() time.Time { return time.Date(2026, 11, 1, 0, 0, 0, 0, time.UTC) })
	if err != nil {
		t.Fatal(err)
	}
	evs := s.Events()
	if len(evs) != 1 {
		t.Fatalf("events = %d", len(evs))
	}
	ev := evs[0]
	if ev.Status != StatusDraft || ev.LocationSet || ev.HostTokenHash != "" || ev.Slug != "ihsan-ara" {
		t.Fatalf("migrated event must be a locked-down draft: %+v", ev)
	}
	if !ev.StartAt.Equal(time.Date(2026, 12, 12, 3, 0, 0, 0, time.UTC)) || ev.RadiusMeters != DefaultRadiusMeters {
		t.Fatalf("schedule/radius: %v %d", ev.StartAt, ev.RadiusMeters)
	}
	if ev.LegacyCoverFile != "0123456789abcdef.jpg" || s.DefaultEventID() != ev.ID {
		t.Fatal("cover / default event not migrated")
	}
	lp := s.LegacyPhotos()
	if len(lp) != 1 || lp[0].EventID != ev.ID || lp[0].Status != PhotoProcessing || lp[0].Likes != 3 {
		t.Fatalf("legacy photos: %+v", lp)
	}
	// event-scoped files exist; the single global data file is gone (kept as backup)
	if _, err := os.Stat(filepath.Join(dir, "db", "events", ev.ID+".json")); err != nil {
		t.Fatal("event file missing")
	}
	if _, err := os.Stat(filepath.Join(dir, "data.json")); err == nil {
		t.Fatal("data.json must be renamed after migration")
	}
	if m, _ := filepath.Glob(filepath.Join(dir, "data.json.pre-v3-*")); len(m) != 1 {
		t.Fatal("legacy backup missing")
	}
	// reopening loads the event files
	s2, err := Open(dir, nil)
	if err != nil || len(s2.Events()) != 1 || len(s2.LegacyPhotos()) != 1 {
		t.Fatalf("reopen: %v", err)
	}
}

func TestMigrateSingleFileV2(t *testing.T) {
	dir := t.TempDir()
	v2 := `{"schemaVersion":2,"defaultEventId":"aaaaaaaaaaaaaaaa",
	  "events":[{"id":"aaaaaaaaaaaaaaaa","slug":"a"},{"id":"bbbbbbbbbbbbbbbb","slug":"b"}],
	  "photos":[{"id":"p1p1p1p1p1p1p1p1","eventId":"bbbbbbbbbbbbbbbb","status":"READY"}],
	  "guestSessions":[{"id":"g1","eventId":"aaaaaaaaaaaaaaaa","uploadedCount":2}],
	  "adminSessions":[{"id":"x","tokenHash":"h","expiresAt":"2099-01-01T00:00:00Z"}]}`
	_ = os.WriteFile(filepath.Join(dir, "data.json"), []byte(v2), 0o600)
	s, err := Open(dir, nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(s.EventPhotos("bbbbbbbbbbbbbbbb", nil)) != 1 || len(s.EventPhotos("aaaaaaaaaaaaaaaa", nil)) != 0 {
		t.Fatal("photos not routed to their event file")
	}
	if g, err := s.GuestSession("aaaaaaaaaaaaaaaa", "g1"); err != nil || g.UploadedCount != 2 {
		t.Fatal("guest session not migrated")
	}
	if _, err := s.AdminSessionByHash("h"); err != nil {
		t.Fatal("admin session not migrated")
	}
	a, _ := os.ReadFile(filepath.Join(dir, "db", "events", "aaaaaaaaaaaaaaaa.json"))
	if bytes.Contains(a, []byte("p1p1p1p1p1p1p1p1")) {
		t.Fatal("event B photo written into event A file")
	}
}

func TestInterruptedMigrationLeftoversQuarantined(t *testing.T) {
	dir := t.TempDir()
	_ = os.MkdirAll(filepath.Join(dir, "db", "events"), 0o700)
	_ = os.WriteFile(filepath.Join(dir, "db", "events", "cccccccccccccccc.json"), []byte(`{"event":{"id":"cccccccccccccccc"}}`), 0o600)
	_ = os.WriteFile(filepath.Join(dir, "data.json"), []byte(v1), 0o600)
	s, err := Open(dir, nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(s.Events()) != 1 || s.Events()[0].ID == "cccccccccccccccc" {
		t.Fatal("leftover event file from an interrupted migration was loaded")
	}
	if m, _ := filepath.Glob(filepath.Join(dir, "db", "incomplete-*", "cccccccccccccccc.json")); len(m) != 1 {
		t.Fatal("leftover not quarantined")
	}
}

func TestNoTempFilesLeftAndFilesPrivate(t *testing.T) {
	dir := t.TempDir()
	s, _ := Open(dir, nil)
	ev, err := s.CreateEvent(Event{ID: NewEventID(), Slug: "x"})
	if err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 5; i++ {
		_, _ = s.UpdateEvent(ev.ID, func(e *Event) error { e.Hashtag = "#x"; return nil })
	}
	tmp, _ := filepath.Glob(filepath.Join(dir, "db", "events", ".*"))
	if len(tmp) != 0 {
		t.Fatalf("temp files left: %v", tmp)
	}
	st, _ := os.Stat(filepath.Join(dir, "db", "events", ev.ID+".json"))
	if st.Mode().Perm() != 0o600 {
		t.Fatalf("event file mode %v, want 0600", st.Mode().Perm())
	}
}

func TestReserveUploadQuotaConcurrent(t *testing.T) {
	s, _ := Open(t.TempDir(), nil)
	ev, _ := s.CreateEvent(Event{ID: NewEventID(), Slug: "x"})
	gs, _ := s.CheckinGuest(ev.ID, "dev", "tok", time.Now().Add(time.Hour), 1, 1)
	var wg sync.WaitGroup
	var mu sync.Mutex
	ok := 0
	for i := 0; i < 20; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if _, _, _, err := s.ReserveUpload(ev.ID, gs.ID, Reservation{ID: NewID(), ObjectKey: "k"}, time.Minute, MaxPhotosPerGuest); err == nil {
				mu.Lock()
				ok++
				mu.Unlock()
			}
		}()
	}
	wg.Wait()
	if ok != MaxPhotosPerGuest {
		t.Fatalf("granted %d", ok)
	}
	// durable: a fresh store sees the same counters
	s2, _ := Open(filepath.Dir(filepath.Dir(filepath.Dir(s.eventPath(ev.ID)))), nil)
	g, _ := s2.GuestSession(ev.ID, gs.ID)
	if g.ReservedCount != MaxPhotosPerGuest {
		t.Fatalf("reserved on disk = %d", g.ReservedCount)
	}
}

func TestUpdateEventDoesNotLoseConcurrentChanges(t *testing.T) {
	s, _ := Open(t.TempDir(), nil)
	ev, _ := s.CreateEvent(Event{ID: NewEventID(), Slug: "x"})
	var wg sync.WaitGroup
	for i := 0; i < 50; i++ {
		wg.Add(2)
		go func() {
			defer wg.Done()
			_, _ = s.UpdateEvent(ev.ID, func(e *Event) error { e.QRVersion++; return nil })
		}()
		go func() { defer wg.Done(); _, _ = s.RotateDisplay(ev.ID) }()
	}
	wg.Wait()
	got, _ := s.Event(ev.ID)
	if got.QRVersion != 50 || got.DisplayVersion != 50 {
		t.Fatalf("lost updates: qr=%d display=%d", got.QRVersion, got.DisplayVersion)
	}
}

func TestReferencedKeys(t *testing.T) {
	s, _ := Open(t.TempDir(), nil)
	ev, _ := s.CreateEvent(Event{ID: NewEventID(), Slug: "x", CoverKey: "c"})
	gs, _ := s.CheckinGuest(ev.ID, "dev", "tok", time.Now().Add(time.Hour), 1, 1)
	_, _, _, _ = s.ReserveUpload(ev.ID, gs.ID, Reservation{ID: "r1", ObjectKey: "pending-key"}, time.Minute, 5)
	keys := s.ReferencedKeys()
	if !keys["c"] || !keys["pending-key"] {
		t.Fatalf("keys: %v", keys)
	}
}
