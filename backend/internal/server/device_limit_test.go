package server

import (
	"testing"
	"time"

	"github.com/nakhasolution/weedingnakha/backend/internal/store"
)

// Admins pick a per-device limit from the fixed choices; anything else is refused.
func TestDeviceLimitInput(t *testing.T) {
	start := time.Now()
	end := start.Add(time.Hour)
	in := func(photo, moment int) eventInput {
		return eventInput{Type: store.TypeCampus, Title: "Wisuda", StartAt: &start, EndAt: &end, PhotoLimit: &photo, MomentLimit: &moment}
	}
	e := store.Event{Theme: store.DefaultTheme, Status: store.StatusDraft}
	if _, err := applyEventInput(&e, in(store.Unlimited, 30)); err != nil {
		t.Fatal(err.msg)
	}
	if e.QuotaFor("photobooth") != store.Unlimited || e.QuotaFor(store.SourceMoment) != 30 {
		t.Fatalf("limits = %d / %d", e.PhotoLimit, e.MomentLimit)
	}
	if _, err := applyEventInput(&e, in(7, 10)); err == nil || err.code != "BAD_LIMIT" {
		t.Fatalf("7 accepted: %+v", err)
	}
	// default values stay "default" (0) so a later default change still applies
	e2 := store.Event{Theme: store.DefaultTheme, Status: store.StatusDraft}
	_, _ = applyEventInput(&e2, in(store.MaxPhotosPerGuest, store.MaxMomentsPerGuest))
	if e2.PhotoLimit != 0 || e2.MomentLimit != 0 {
		t.Fatalf("defaults stored explicitly: %d / %d", e2.PhotoLimit, e2.MomentLimit)
	}
}
