package server

import (
	"net/http"
	"testing"
	"time"
)

// Campus/corporate events are titled by a single event name instead of the
// couple; weddings stay the default and still require both names.
func TestEventTypes(t *testing.T) {
	h := newHarness(t)
	adm := h.admin()
	start := eventStart.Format(time.RFC3339)
	end := eventStart.Add(4 * time.Hour).Format(time.RFC3339)
	type view struct {
		Event struct {
			Slug  string `json:"slug"`
			Type  string `json:"type"`
			Title string `json:"title"`
		} `json:"event"`
	}

	// campus: title required, couple names not needed (and dropped)
	expect(t, adm.do("POST", "/api/admin/events", map[string]any{"type": "campus", "startAt": start, "endAt": end}), http.StatusBadRequest)
	rec := adm.do("POST", "/api/admin/events", map[string]any{
		"type": "campus", "title": "Wisuda FEB 2026", "groomName": "X", "startAt": start, "endAt": end,
	})
	expect(t, rec, http.StatusCreated)
	v := decode[view](t, rec)
	if v.Event.Type != "campus" || v.Event.Title != "Wisuda FEB 2026" || v.Event.Slug != "wisuda-feb-2026" {
		t.Fatalf("campus event: %+v", v.Event)
	}
	pub := h.client().do("GET", "/api/public/event?slug=wisuda-feb-2026", nil)
	expect(t, pub, http.StatusOK)
	p := decode[map[string]any](t, pub)
	if p["type"] != "campus" || p["title"] != "Wisuda FEB 2026" || p["groomName"] != "" {
		t.Fatalf("public view: %v", p)
	}

	// unknown type rejected
	expect(t, adm.do("POST", "/api/admin/events", map[string]any{"type": "party", "title": "x", "startAt": start, "endAt": end}), http.StatusBadRequest)

	// no type = wedding: names still required
	expect(t, adm.do("POST", "/api/admin/events", map[string]any{"title": "x", "startAt": start, "endAt": end}), http.StatusBadRequest)
	rec = adm.do("POST", "/api/admin/events", map[string]any{"groomName": "Ihsan", "brideName": "Ara", "startAt": start, "endAt": end})
	expect(t, rec, http.StatusCreated)
	if v := decode[view](t, rec); v.Event.Type != "wedding" {
		t.Fatalf("default type: %+v", v.Event)
	}
}
