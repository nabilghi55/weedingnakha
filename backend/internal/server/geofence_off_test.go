package server

import (
	"github.com/nakhasolution/weedingnakha/backend/internal/store"
	"net/http"
	"testing"
)

// With REQUIRE_LOCATION=false the QR alone checks a guest in and photos are
// sent without any location; QR validity and the quota still apply.
func TestGeofenceOffNoLocationNeeded(t *testing.T) {
	h := newHarness(t)
	h.srv.cfg.GeofenceOff = true
	ev := h.event("nogeo")
	g := h.client()

	rec := g.do("POST", "/api/guest/checkin", map[string]any{"qr": h.qr(ev), "deviceId": "device-nogeo-abcdefgh1234"})
	expect(t, rec, http.StatusOK)
	if decode[map[string]any](t, rec)["locationRequired"] != false {
		t.Fatal("session must report locationRequired=false")
	}

	// far away / no location at all: upload still accepted
	auth := g.do("POST", "/api/guest/upload/authorize", map[string]any{
		"guestName": "Tamu", "wishes": "Selamat", "filter": "none",
		"contentType": "image/jpeg", "size": len(testJPEG(1)),
	})
	expect(t, auth, http.StatusOK)

	for i := 0; i < 4; i++ {
		expect(t, g.upload(testJPEG(i+10)), http.StatusCreated)
	}

	// a forged QR is still rejected
	bad := h.client()
	rec = bad.do("POST", "/api/guest/checkin", map[string]any{"qr": "forged.token", "deviceId": "device-nogeo-forged-12345"})
	expect(t, rec, http.StatusForbidden)
}

// With location checks off, an event that never had a venue point set still
// opens; with them on, it stays closed.
func TestGeofenceOffNoVenuePointNeeded(t *testing.T) {
	h := newHarness(t)
	noLoc := func(e *store.Event) { e.LocationSet, e.VenueLat, e.VenueLng = false, 0, 0 }

	ev := h.event("noloc-on", noLoc)
	rec := h.client().do("POST", "/api/guest/checkin", map[string]any{"qr": h.qr(ev), "deviceId": "device-noloc-on-abcdefgh12"})
	expect(t, rec, http.StatusForbidden)

	h.srv.cfg.GeofenceOff = true
	ev = h.event("noloc-off", noLoc)
	rec = h.client().do("POST", "/api/guest/checkin", map[string]any{"qr": h.qr(ev), "deviceId": "device-noloc-off-abcdefgh1"})
	expect(t, rec, http.StatusOK)
}
