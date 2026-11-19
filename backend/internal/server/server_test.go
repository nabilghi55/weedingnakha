package server

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"image"
	"image/color"
	"image/jpeg"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/nakhasolution/weedingnakha/backend/internal/audit"
	"github.com/nakhasolution/weedingnakha/backend/internal/security"
	"github.com/nakhasolution/weedingnakha/backend/internal/storage"
	"github.com/nakhasolution/weedingnakha/backend/internal/store"
)

// ---------- harness ----------

const (
	base     = "http://test.local"
	adminPIN = "987654"
	// adminPath is the secret admin URL segment; test clients send it by
	// default so admin tests exercise the PIN/session layer behind the gate.
	adminPath = "kelola-0123456789abcdef"
	venueLat  = -7.9666
	venueLng  = 112.6326
)

type clock struct {
	mu sync.Mutex
	t  time.Time
}

func (c *clock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.t
}

func (c *clock) Advance(d time.Duration) {
	c.mu.Lock()
	c.t = c.t.Add(d)
	c.mu.Unlock()
}

type harness struct {
	t   *testing.T
	srv *Server
	h   http.Handler
	clk *clock
	st  *store.Store
	dir string
}

// The fake "now" is 2026-12-12 10:30 WIB; test events run 10:00–14:00 WIB.
var eventStart = time.Date(2026, 12, 12, 3, 0, 0, 0, time.UTC)

func newHarness(t *testing.T) *harness {
	t.Helper()
	dir := t.TempDir()
	clk := &clock{t: eventStart.Add(30 * time.Minute)}
	st, err := store.Open(dir, clk.Now)
	if err != nil {
		t.Fatal(err)
	}
	secret := []byte("test-secret-test-secret-test-secret!")
	stg, err := storage.NewLocal(filepath.Join(dir, "objects"), secret, clk.Now)
	if err != nil {
		t.Fatal(err)
	}
	srv := New(Config{
		AdminPIN:       adminPIN,
		AdminPath:      adminPath,
		Secret:         secret,
		AllowedOrigins: []string{base},
		PublicBaseURL:  base,
		CookieSecure:   false,
		Now:            clk.Now,
	}, st, stg, audit.Open(filepath.Join(dir, "audit.log"), clk.Now))
	t.Cleanup(srv.WaitIdle) // runs before TempDir removal (LIFO)
	return &harness{t: t, srv: srv, h: srv.Handler(), clk: clk, st: st, dir: dir}
}

// event creates an ACTIVE event with a geofence directly in the store.
func (h *harness) event(slug string, mutate ...func(*store.Event)) store.Event {
	h.t.Helper()
	ev := store.Event{
		ID: store.NewEventID(), Slug: slug, Status: store.StatusActive,
		GroomName: "Groom " + slug, BrideName: "Bride " + slug, Theme: "maroon",
		StartAt: eventStart, EndAt: eventStart.Add(4 * time.Hour),
		VenueLat: venueLat, VenueLng: venueLng, LocationSet: true, RadiusMeters: store.DefaultRadiusMeters,
		ModerationMode: store.AutoPublish, GalleryVisibility: store.GalleryGuests,
		QRVersion: 1, DisplayVersion: 1,
	}
	for _, m := range mutate {
		m(&ev)
	}
	ev, err := h.st.CreateEvent(ev)
	if err != nil {
		h.t.Fatal(err)
	}
	return ev
}

// allData concatenates every persisted JSON file (global + event files).
func (h *harness) allData() []byte {
	var out []byte
	files, _ := filepath.Glob(filepath.Join(h.dir, "db", "events", "*.json"))
	files = append(files, filepath.Join(h.dir, "db", "global.json"))
	for _, f := range files {
		b, _ := os.ReadFile(f)
		out = append(out, b...)
	}
	return out
}

func (h *harness) qr(ev store.Event) string {
	ev, _ = h.st.Event(ev.ID)
	return h.srv.issueQR(httptest.NewRequest("GET", base+"/", nil), ev).Token
}

type client struct {
	h        *harness
	jar      *cookiejar.Jar
	ip       string
	adminKey string
}

var clientN int

func (h *harness) client() *client {
	jar, _ := cookiejar.New(nil)
	clientN++
	return &client{h: h, jar: jar, ip: "10.0.0." + itoa(clientN%250+1), adminKey: adminPath}
}

func (c *client) raw(method, path string, body []byte, contentType string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, base+path, bytes.NewReader(body))
	req.RemoteAddr = c.ip + ":5555"
	if contentType != "" {
		req.Header.Set("Content-Type", contentType)
	}
	req.Header.Set("X-Nakha-Request", "1")
	if c.adminKey != "" {
		req.Header.Set(AdminKeyHeader, c.adminKey)
	}
	u, _ := url.Parse(base)
	for _, ck := range c.jar.Cookies(u) {
		req.AddCookie(ck)
	}
	rec := httptest.NewRecorder()
	c.h.h.ServeHTTP(rec, req)
	c.jar.SetCookies(u, rec.Result().Cookies())
	return rec
}

func (c *client) do(method, path string, body any) *httptest.ResponseRecorder {
	var b []byte
	if body != nil {
		b, _ = json.Marshal(body)
	}
	return c.raw(method, path, b, "application/json")
}

func decode[T any](t *testing.T, rec *httptest.ResponseRecorder) T {
	t.Helper()
	var v T
	if err := json.Unmarshal(rec.Body.Bytes(), &v); err != nil {
		t.Fatalf("decode %q: %v", rec.Body.String(), err)
	}
	return v
}

func errCode(t *testing.T, rec *httptest.ResponseRecorder) string {
	return decode[map[string]any](t, rec)["code"].(string)
}

func expectRec(t *testing.T, rec *httptest.ResponseRecorder, status int) *httptest.ResponseRecorder {
	t.Helper()
	expect(t, rec, status)
	return rec
}

func expect(t *testing.T, rec *httptest.ResponseRecorder, status int) {
	t.Helper()
	if rec.Code != status {
		t.Fatalf("status = %d, want %d; body=%s", rec.Code, status, rec.Body.String())
	}
}

func loc(lat, lng, acc float64, ts time.Time) map[string]any {
	return map[string]any{"latitude": lat, "longitude": lng, "accuracy": acc, "timestamp": ts.UnixMilli()}
}

func (c *client) checkin(qr string, lat, lng float64) *httptest.ResponseRecorder {
	body := loc(lat, lng, 20, c.h.clk.Now())
	body["qr"] = qr
	body["deviceId"] = "device-" + strings.ReplaceAll(c.ip, ".", "-") + "-abcdefgh"
	return c.do("POST", "/api/guest/checkin", body)
}

func (c *client) mustCheckin(ev store.Event) {
	c.h.t.Helper()
	expect(c.h.t, c.checkin(c.h.qr(ev), venueLat+0.0003, venueLng), http.StatusOK) // ~33 m away
}

func testJPEG(seed int) []byte {
	img := image.NewRGBA(image.Rect(0, 0, 160, 120))
	for y := 0; y < 120; y++ {
		for x := 0; x < 160; x++ {
			img.Set(x, y, color.RGBA{uint8(seed * 37), uint8(x + seed), uint8(y), 255})
		}
	}
	var buf bytes.Buffer
	_ = jpeg.Encode(&buf, img, &jpeg.Options{Quality: 90})
	return buf.Bytes()
}

type authorizeResp struct {
	ReservationID string                   `json:"reservationId"`
	Upload        storage.PresignedRequest `json:"upload"`
}

func (c *client) authorize(size int) *httptest.ResponseRecorder {
	return c.do("POST", "/api/guest/upload/authorize", map[string]any{
		"guestName": "Tamu", "wishes": "Selamat", "filter": "warm",
		"contentType": "image/jpeg", "size": size,
		"location": loc(venueLat, venueLng, 15, c.h.clk.Now()),
	})
}

// upload runs the full authorize → PUT → complete flow.
func (c *client) upload(data []byte) *httptest.ResponseRecorder {
	c.h.t.Helper()
	rec := c.authorize(len(data))
	if rec.Code != http.StatusOK {
		return rec
	}
	a := decode[authorizeResp](c.h.t, rec)
	put := c.raw("PUT", a.Upload.URL, data, a.Upload.Headers["Content-Type"])
	expect(c.h.t, put, http.StatusOK)
	return c.do("POST", "/api/guest/upload/complete", map[string]string{"reservationId": a.ReservationID})
}

func (h *harness) admin() *client {
	c := h.client()
	expect(h.t, c.do("POST", "/api/admin/login", map[string]string{"pin": adminPIN}), http.StatusOK)
	return c
}

// hostFor generates a host token through the admin API and exchanges it.
func (h *harness) hostFor(ev store.Event) (*client, string) {
	adm := h.admin()
	rec := adm.do("POST", "/api/admin/events/"+ev.ID+"/host-token", nil)
	expect(h.t, rec, http.StatusOK)
	tok := decode[map[string]any](h.t, rec)["hostToken"].(string)
	host := h.client()
	res := host.do("GET", "/host/access?token="+tok, nil)
	expect(h.t, res, http.StatusSeeOther)
	return host, tok
}

// ---------- 1. outside radius ----------

func TestCheckinOutsideRadiusRejected(t *testing.T) {
	h := newHarness(t)
	ev := h.event("a")
	g := h.client()
	rec := g.checkin(h.qr(ev), venueLat+0.01, venueLng) // ~1.1 km away
	expect(t, rec, http.StatusForbidden)
	if code := errCode(t, rec); code != "OUTSIDE_RADIUS" {
		t.Fatalf("code = %s", code)
	}
	if msg := decode[map[string]string](t, rec)["error"]; msg != outsideMsg {
		t.Fatalf("message = %q", msg)
	}
	if rec.Result().Cookies() != nil && len(rec.Result().Cookies()) > 0 {
		t.Fatal("no session cookie may be issued outside the geofence")
	}

	// inaccurate GPS is rejected too
	body := loc(venueLat, venueLng, 500, h.clk.Now())
	body["qr"], body["deviceId"] = h.qr(ev), "device-inaccurate-123456"
	rec = g.do("POST", "/api/guest/checkin", body)
	expect(t, rec, http.StatusForbidden)
	if code := errCode(t, rec); code != "LOCATION_INACCURATE" {
		t.Fatalf("code = %s", code)
	}
}

// ---------- 2. event not active / not started / ended ----------

func TestCheckinRejectedOutsideEventWindowOrStatus(t *testing.T) {
	cases := []struct {
		name    string
		mutate  func(*store.Event)
		advance time.Duration
		code    string
	}{
		{"draft", func(e *store.Event) { e.Status = store.StatusDraft }, 0, "EVENT_NOT_ACTIVE"},
		{"ended status", func(e *store.Event) { e.Status = store.StatusEnded }, 0, "EVENT_ENDED"},
		{"before window", func(e *store.Event) {
			e.StartAt = eventStart.Add(3 * time.Hour)
			e.EndAt = eventStart.Add(6 * time.Hour)
		}, 0, "EVENT_NOT_STARTED"},
		{"after window", nil, 4*time.Hour + 61*time.Minute, "EVENT_ENDED"},
		{"no location", func(e *store.Event) { e.LocationSet = false }, 0, "LOCATION_NOT_CONFIGURED"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			h := newHarness(t)
			var muts []func(*store.Event)
			if tc.mutate != nil {
				muts = append(muts, tc.mutate)
			}
			ev := h.event("e", muts...)
			h.clk.Advance(tc.advance)
			// QR is minted at the (advanced) current time, so it is valid;
			// only the status / schedule rule can reject the check-in.
			rec := h.client().checkin(h.qr(ev), venueLat, venueLng)
			expect(t, rec, http.StatusForbidden)
			if code := errCode(t, rec); code != tc.code {
				t.Fatalf("code = %s, want %s", code, tc.code)
			}
		})
	}
}

// ---------- 3. expired / forged QR ----------

func TestExpiredQRRejected(t *testing.T) {
	h := newHarness(t)
	ev := h.event("a")
	qr := h.qr(ev)

	// the printable QR is stable: same token every time, still valid hours later inside the window
	if again := h.qr(ev); again != qr {
		t.Fatal("printable QR must not change between requests")
	}
	h.clk.Advance(3 * time.Hour) // 13:30 WIB, event ends 14:00
	expect(t, h.client().checkin(qr, venueLat, venueLng), http.StatusOK)

	// ...but dead once the event window closes (end + 60 min)
	h.clk.Advance(2 * time.Hour)
	rec := h.client().checkin(qr, venueLat, venueLng)
	expect(t, rec, http.StatusForbidden)
	if code := errCode(t, rec); code == "QR_INVALID" || code == "" {
		t.Fatalf("closed window code = %s", code)
	}
	h.clk.Advance(-5 * time.Hour)

	// the QR can be fetched ahead of time to print, even while the booth is closed
	draft := h.event("draft", func(e *store.Event) { e.Status = store.StatusDraft })
	host, _ := h.hostFor(draft)
	qrInfo := decode[qrResponse](t, expectRec(t, host.do("GET", "/api/host/qr", nil), http.StatusOK))
	if qrInfo.BoothOpen || qrInfo.Token == "" {
		t.Fatalf("draft qr = %+v", qrInfo)
	}
	rec = h.client().checkin(qrInfo.Token, venueLat, venueLng)
	expect(t, rec, http.StatusForbidden) // printed early, but useless until ACTIVE

	// tampered payload / signature
	fresh := h.qr(ev)
	rec = h.client().checkin(fresh[:len(fresh)-2]+"xx", venueLat, venueLng)
	expect(t, rec, http.StatusForbidden)
	if code := errCode(t, rec); code != "QR_INVALID" {
		t.Fatalf("code = %s", code)
	}

	// a display token can never be used as a QR token (purpose-bound keys)
	rec = h.client().checkin(h.srv.displayToken(ev), venueLat, venueLng)
	expect(t, rec, http.StatusForbidden)

	// rotating the QR version kills outstanding QR tokens
	old := h.qr(ev)
	if _, err := h.st.UpdateEvent(ev.ID, func(e *store.Event) error { e.QRVersion++; return nil }); err != nil {
		t.Fatal(err)
	}
	expect(t, h.client().checkin(old, venueLat, venueLng), http.StatusForbidden)
}

// ---------- 4. successful check-in ----------

func TestCheckinCreatesGuestSession(t *testing.T) {
	h := newHarness(t)
	ev := h.event("a")
	g := h.client()
	rec := g.checkin(h.qr(ev), venueLat+0.0005, venueLng+0.0005) // ~78 m
	expect(t, rec, http.StatusOK)

	var cookie *http.Cookie
	for _, c := range rec.Result().Cookies() {
		if c.Name == cookieGuest {
			cookie = c
		}
	}
	if cookie == nil || !cookie.HttpOnly || cookie.SameSite != http.SameSiteStrictMode {
		t.Fatalf("guest cookie must be HttpOnly + SameSite: %+v", cookie)
	}
	v := decode[guestSessionView](t, rec)
	if v.UploadedCount != 0 || v.MaxPhotos != 5 || v.Remaining != 5 || !v.Booth.Open {
		t.Fatalf("unexpected session view: %+v", v)
	}
	expect(t, g.do("GET", "/api/guest/session", nil), http.StatusOK)

	// only hashes are persisted; no raw token and no raw coordinates
	raw := h.allData()
	if bytes.Contains(raw, []byte(cookie.Value)) {
		t.Fatal("raw session token stored in database")
	}
	if bytes.Contains(raw, []byte("-7.9661")) || bytes.Contains(raw, []byte("112.6331")) {
		t.Fatal("precise guest coordinates stored in database")
	}
}

// ---------- 5 + 6. five uploads OK, sixth rejected ----------

func TestFivePhotosThenSixthRejected(t *testing.T) {
	h := newHarness(t)
	ev := h.event("a")
	g := h.client()
	g.mustCheckin(ev)
	for i := 1; i <= 5; i++ {
		rec := g.upload(testJPEG(i))
		expect(t, rec, http.StatusCreated)
		if got := decode[struct {
			Session guestSessionView `json:"session"`
		}](t, rec).Session.UploadedCount; got != i {
			t.Fatalf("uploadedCount = %d, want %d", got, i)
		}
	}
	h.srv.WaitIdle()
	if ready := h.st.EventPhotos(ev.ID, func(p store.Photo) bool { return p.Status == store.PhotoReady }); len(ready) != 5 {
		t.Fatalf("ready photos = %d", len(ready))
	}
	rec := g.authorize(len(testJPEG(6)))
	expect(t, rec, http.StatusConflict)
	if code := errCode(t, rec); code != "QUOTA_EXCEEDED" {
		t.Fatalf("code = %s", code)
	}

	// re-checking in with the same device does not reset the quota
	g.mustCheckin(ev)
	expect(t, g.authorize(1000), http.StatusConflict)
}

// ---------- 7. concurrency ----------

func TestConcurrentAuthorizeNeverExceedsQuota(t *testing.T) {
	h := newHarness(t)
	ev := h.event("a")
	g := h.client()
	g.mustCheckin(ev)

	var wg sync.WaitGroup
	codes := make([]int, 10)
	for i := range codes {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			codes[i] = g.authorize(5000).Code
		}(i)
	}
	wg.Wait()
	ok := 0
	for _, c := range codes {
		if c == http.StatusOK {
			ok++
		} else if c != http.StatusConflict {
			t.Fatalf("unexpected status %d", c)
		}
	}
	if ok != 5 {
		t.Fatalf("granted %d slots concurrently, want exactly 5", ok)
	}
	gs := decode[guestSessionView](t, g.do("GET", "/api/guest/session", nil))
	if gs.ReservedCount != 5 || gs.Remaining != 0 {
		t.Fatalf("reserved=%d remaining=%d", gs.ReservedCount, gs.Remaining)
	}
}

func TestConcurrentCompleteSameReservationOnlyOnce(t *testing.T) {
	h := newHarness(t)
	ev := h.event("a")
	g := h.client()
	g.mustCheckin(ev)
	data := testJPEG(1)
	a := decode[authorizeResp](t, g.authorize(len(data)))
	expect(t, g.raw("PUT", a.Upload.URL, data, "image/jpeg"), http.StatusOK)

	var wg sync.WaitGroup
	created := 0
	var mu sync.Mutex
	for i := 0; i < 5; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			rec := g.do("POST", "/api/guest/upload/complete", map[string]string{"reservationId": a.ReservationID})
			if rec.Code == http.StatusCreated {
				mu.Lock()
				created++
				mu.Unlock()
			}
		}()
	}
	wg.Wait()
	if created != 1 {
		t.Fatalf("reservation confirmed %d times", created)
	}
	gs := decode[guestSessionView](t, g.do("GET", "/api/guest/session", nil))
	if gs.UploadedCount != 1 || gs.ReservedCount != 0 {
		t.Fatalf("uploaded=%d reserved=%d", gs.UploadedCount, gs.ReservedCount)
	}
}

// ---------- 8. cross-event isolation ----------

func TestGuestOfEventACannotTouchEventB(t *testing.T) {
	h := newHarness(t)
	evA := h.event("a")
	evB := h.event("b")
	ga, gb := h.client(), h.client()
	ga.mustCheckin(evA)
	gb.mustCheckin(evB)

	expect(t, ga.upload(testJPEG(1)), http.StatusCreated)
	expect(t, gb.upload(testJPEG(2)), http.StatusCreated)
	h.srv.WaitIdle()

	// B's reservation cannot be completed with A's session
	data := testJPEG(3)
	bRes := decode[authorizeResp](t, gb.authorize(len(data)))
	expect(t, gb.raw("PUT", bRes.Upload.URL, data, "image/jpeg"), http.StatusOK)
	rec := ga.do("POST", "/api/guest/upload/complete", map[string]string{"reservationId": bRes.ReservationID})
	expect(t, rec, http.StatusNotFound)

	// an event ID smuggled in the body is ignored: the key is scoped to A
	rec = ga.do("POST", "/api/guest/upload/authorize", map[string]any{
		"eventId": evB.ID, "event_id": evB.ID, "guestName": "x", "contentType": "image/jpeg", "size": 100,
		"location": loc(venueLat, venueLng, 10, h.clk.Now()),
	})
	expect(t, rec, http.StatusOK)
	if u := decode[authorizeResp](t, rec).Upload.URL; !strings.Contains(u, url.QueryEscape("events/"+evA.ID+"/")) {
		t.Fatalf("object key not scoped to own event: %s", u)
	}

	// A cannot read B's gallery (B is GUESTS-only)
	expect(t, ga.do("GET", "/api/gallery/photos?slug=b", nil), http.StatusForbidden)
	// A's own gallery contains only A's photos
	g := decode[struct {
		Photos []photoView `json:"photos"`
	}](t, ga.do("GET", "/api/gallery/photos", nil))
	if len(g.Photos) != 1 {
		t.Fatalf("gallery A has %d photos", len(g.Photos))
	}
	for _, p := range h.st.EventPhotos(evB.ID, nil) {
		if p.ID == g.Photos[0].ID {
			t.Fatal("event B photo leaked into gallery A")
		}
	}

	// host of A cannot moderate a photo of B, nor see it
	hostA, _ := h.hostFor(evA)
	bPhoto := h.st.EventPhotos(evB.ID, nil)[0]
	expect(t, hostA.do("POST", "/api/host/photos/"+bPhoto.ID+"/hide", map[string]string{}), http.StatusNotFound)
	expect(t, hostA.do("DELETE", "/api/host/photos/"+bPhoto.ID, nil), http.StatusNotFound)
	hp := decode[struct {
		Photos []photoView `json:"photos"`
	}](t, hostA.do("GET", "/api/host/photos", nil))
	for _, p := range hp.Photos {
		if p.ID == bPhoto.ID {
			t.Fatal("host A sees event B photo")
		}
	}
	// host session is not an admin session
	expect(t, hostA.do("GET", "/api/admin/events", nil), http.StatusUnauthorized)
}

// ---------- 9. revoked host token ----------

func TestRevokedHostTokenCannotAccessDashboard(t *testing.T) {
	h := newHarness(t)
	adm := h.admin()
	start := eventStart.Format(time.RFC3339)
	end := eventStart.Add(4 * time.Hour).Format(time.RFC3339)
	rec := adm.do("POST", "/api/admin/events", map[string]any{
		"groomName": "Ihsan", "brideName": "Ara", "startAt": start, "endAt": end,
		"venueLatitude": venueLat, "venueLongitude": venueLng,
	})
	expect(t, rec, http.StatusCreated)
	created := decode[struct {
		Event struct {
			ID string `json:"id"`
		} `json:"event"`
		HostToken     string `json:"hostToken"`
		HostAccessURL string `json:"hostAccessUrl"`
	}](t, rec)
	if len(created.HostToken) < 43 { // 32 bytes base64url
		t.Fatalf("host token too short: %d", len(created.HostToken))
	}
	raw := h.allData()
	if bytes.Contains(raw, []byte(created.HostToken)) {
		t.Fatal("raw host token stored")
	}
	if !bytes.Contains(raw, []byte(security.HashToken(created.HostToken))) {
		t.Fatal("host token hash not stored")
	}

	host := h.client()
	res := host.do("GET", "/host/access?token="+created.HostToken, nil)
	expect(t, res, http.StatusSeeOther)
	if loc := res.Header().Get("Location"); loc != "/host/" {
		t.Fatalf("redirect must drop the token, got %q", loc)
	}
	if res.Header().Get("Referrer-Policy") != "no-referrer" {
		t.Fatal("host access must set Referrer-Policy: no-referrer")
	}
	expect(t, host.do("GET", "/api/host/me", nil), http.StatusOK)

	expect(t, adm.do("DELETE", "/api/admin/events/"+created.Event.ID+"/host-token", nil), http.StatusOK)
	expect(t, host.do("GET", "/api/host/me", nil), http.StatusUnauthorized)

	again := h.client()
	res = again.do("GET", "/host/access?token="+created.HostToken, nil)
	if loc := res.Header().Get("Location"); loc != "/host/?error=invalid" {
		t.Fatalf("revoked token accepted, redirect=%q", loc)
	}
	expect(t, again.do("GET", "/api/host/me", nil), http.StatusUnauthorized)

	// regenerate: new token works, old sessions stay dead
	rec = adm.do("POST", "/api/admin/events/"+created.Event.ID+"/host-token", nil)
	expect(t, rec, http.StatusOK)
	newTok := decode[map[string]any](t, rec)["hostToken"].(string)
	fresh := h.client()
	expect(t, fresh.do("GET", "/host/access?token="+newTok, nil), http.StatusSeeOther)
	expect(t, fresh.do("GET", "/api/host/me", nil), http.StatusOK)
	expect(t, host.do("GET", "/api/host/me", nil), http.StatusUnauthorized)

	// audit log recorded generate + revoke without secrets
	logRaw, _ := os.ReadFile(filepath.Join(h.dir, "audit.log"))
	for _, want := range []string{"host_token.generate", "host_token.revoke", "admin.login", "host.login"} {
		if !bytes.Contains(logRaw, []byte(want)) {
			t.Fatalf("audit log missing %s", want)
		}
	}
	if bytes.Contains(logRaw, []byte(created.HostToken)) || bytes.Contains(logRaw, []byte(newTok)) || bytes.Contains(logRaw, []byte(adminPIN)) {
		t.Fatal("audit log contains a secret")
	}
}

// ---------- 10. private media ----------

func TestPrivatePhotosNeedValidSignedURL(t *testing.T) {
	h := newHarness(t)
	ev := h.event("a")
	g := h.client()
	g.mustCheckin(ev)
	expect(t, g.upload(testJPEG(1)), http.StatusCreated)
	h.srv.WaitIdle()

	gal := decode[struct {
		Photos []photoView `json:"photos"`
	}](t, g.do("GET", "/api/gallery/photos", nil))
	if len(gal.Photos) != 1 {
		t.Fatalf("photos = %d", len(gal.Photos))
	}
	p := gal.Photos[0]
	anon := h.client()

	expect(t, anon.do("GET", p.PhotoURL, nil), http.StatusOK) // valid signature
	rec := anon.do("GET", strings.SplitN(p.PhotoURL, "?", 2)[0], nil)
	expect(t, rec, http.StatusForbidden) // no signature
	tampered := strings.Replace(p.PhotoURL, "s=gallery", "s=host", 1)
	expect(t, anon.do("GET", tampered, nil), http.StatusForbidden) // scope escalation

	// processed variant has no EXIF and is a JPEG
	rec = anon.do("GET", p.PhotoURL, nil)
	if rec.Header().Get("Content-Type") != "image/jpeg" || bytes.Contains(rec.Body.Bytes(), []byte("Exif")) {
		t.Fatal("served image must be a sanitised JPEG")
	}

	// an anonymous visitor cannot list a GUESTS-only gallery
	expect(t, anon.do("GET", "/api/gallery/photos?slug=a", nil), http.StatusForbidden)

	// hiding makes even a fresh gallery URL stop working, host URL still works
	host, _ := h.hostFor(ev)
	expect(t, host.do("POST", "/api/host/photos/"+p.ID+"/hide", map[string]string{"target": "gallery"}), http.StatusOK)
	expect(t, anon.do("GET", p.PhotoURL, nil), http.StatusNotFound)
	hp := decode[struct {
		Photos []photoView `json:"photos"`
	}](t, host.do("GET", "/api/host/photos", nil))
	expect(t, anon.do("GET", hp.Photos[0].PhotoURL, nil), http.StatusOK)
	expect(t, host.do("POST", "/api/host/photos/"+p.ID+"/restore", map[string]string{"target": "gallery"}), http.StatusOK)

	// URLs expire
	h.clk.Advance(16 * time.Minute)
	expect(t, anon.do("GET", p.PhotoURL, nil), http.StatusForbidden)

	// the old public file route and raw storage are not reachable
	expect(t, anon.do("GET", "/uploads/0123456789abcdef.jpg", nil), http.StatusNotFound)
	if rec := anon.do("GET", "/api/storage/upload?key=events/x/photos/y.jpg", nil); rec.Code == http.StatusOK {
		t.Fatal("storage must not be readable")
	}
}

// ---------- 11. open upload route disabled ----------

func TestLegacyUploadEndpointDisabled(t *testing.T) {
	h := newHarness(t)
	h.event("a")
	c := h.client()

	var body bytes.Buffer
	mw := multipart.NewWriter(&body)
	_ = mw.WriteField("guestName", "Spam")
	fw, _ := mw.CreateFormFile("photo", "x.jpg")
	_, _ = fw.Write(testJPEG(1))
	_ = mw.Close()
	rec := c.raw("POST", "/api/photos", body.Bytes(), mw.FormDataContentType())
	expect(t, rec, http.StatusGone)
	if code := errCode(t, rec); code != "UPLOAD_DISABLED" {
		t.Fatalf("code = %s", code)
	}

	// no guest session → every upload step is refused
	expect(t, c.authorize(1000), http.StatusUnauthorized)
	expect(t, c.do("POST", "/api/guest/upload/complete", map[string]string{"reservationId": "abc"}), http.StatusUnauthorized)
	// forged storage PUT
	expect(t, c.raw("PUT", "/api/storage/upload?key=events/aaaaaaaaaaaaaaaa/uploads/bbbbbbbbbbbbbbbb.jpg&ct=image/jpeg&len=10&exp=99999999999&sig=forged", make([]byte, 10), "image/jpeg"), http.StatusForbidden)
	// missing CSRF header
	req := httptest.NewRequest("POST", base+"/api/guest/upload/authorize", strings.NewReader("{}"))
	rr := httptest.NewRecorder()
	h.h.ServeHTTP(rr, req)
	expect(t, rr, http.StatusForbidden)
}

// ---------- 12. host pause blocks uploads ----------

func TestHostPauseRejectsNewUploads(t *testing.T) {
	h := newHarness(t)
	ev := h.event("a")
	g := h.client()
	g.mustCheckin(ev)
	host, _ := h.hostFor(ev)

	expect(t, host.do("POST", "/api/host/event/pause", nil), http.StatusOK)
	rec := g.authorize(1000)
	expect(t, rec, http.StatusForbidden)
	if code := errCode(t, rec); code != "EVENT_PAUSED" {
		t.Fatalf("code = %s", code)
	}
	rec = h.client().checkin(h.qr(ev), venueLat, venueLng)
	expect(t, rec, http.StatusForbidden)
	// the printed QR still exists while paused, it just does not work
	if q := decode[qrResponse](t, expectRec(t, host.do("GET", "/api/host/qr", nil), http.StatusOK)); q.BoothOpen {
		t.Fatal("paused booth reported open")
	}

	expect(t, host.do("POST", "/api/host/event/resume", nil), http.StatusOK)
	expect(t, g.upload(testJPEG(1)), http.StatusCreated)
}

// ---------- extra: reservation expiry, dedupe, location staleness ----------

func TestExpiredReservationReleasesSlot(t *testing.T) {
	h := newHarness(t)
	ev := h.event("a")
	g := h.client()
	g.mustCheckin(ev)
	data := testJPEG(1)
	a := decode[authorizeResp](t, g.authorize(len(data)))
	h.clk.Advance(6 * time.Minute)
	h.srv.ReleaseExpiredReservations()
	gs := decode[guestSessionView](t, g.do("GET", "/api/guest/session", nil))
	if gs.ReservedCount != 0 || gs.Remaining != 5 {
		t.Fatalf("slot not released: %+v", gs)
	}
	expect(t, g.raw("PUT", a.Upload.URL, data, "image/jpeg"), http.StatusForbidden) // presigned URL expired
	expect(t, g.do("POST", "/api/guest/upload/complete", map[string]string{"reservationId": a.ReservationID}), http.StatusConflict)
}

func TestDuplicateFileRejectedAndSlotReturned(t *testing.T) {
	h := newHarness(t)
	ev := h.event("a")
	g := h.client()
	g.mustCheckin(ev)
	expect(t, g.upload(testJPEG(7)), http.StatusCreated)
	rec := g.upload(testJPEG(7))
	expect(t, rec, http.StatusConflict)
	if code := errCode(t, rec); code != "DUPLICATE" {
		t.Fatalf("code = %s", code)
	}
	gs := decode[guestSessionView](t, g.do("GET", "/api/guest/session", nil))
	if gs.UploadedCount != 1 || gs.ReservedCount != 0 {
		t.Fatalf("uploaded=%d reserved=%d", gs.UploadedCount, gs.ReservedCount)
	}
}

func TestStaleLocationRequiresRevalidation(t *testing.T) {
	h := newHarness(t)
	ev := h.event("a")
	g := h.client()
	g.mustCheckin(ev)
	h.clk.Advance(11 * time.Minute)
	rec := g.do("POST", "/api/guest/upload/authorize", map[string]any{"guestName": "x", "contentType": "image/jpeg", "size": 100})
	expect(t, rec, http.StatusPreconditionRequired)
	// a new fix from outside the venue is refused
	rec = g.do("POST", "/api/guest/location", loc(venueLat+0.02, venueLng, 10, h.clk.Now()))
	expect(t, rec, http.StatusForbidden)
	expect(t, g.do("POST", "/api/guest/location", loc(venueLat, venueLng, 10, h.clk.Now())), http.StatusOK)
	expect(t, g.do("POST", "/api/guest/upload/authorize", map[string]any{"guestName": "x", "contentType": "image/jpeg", "size": 100}), http.StatusOK)
}

func TestManualApprovalKeepsPhotoOffWallUntilApproved(t *testing.T) {
	h := newHarness(t)
	ev := h.event("a", func(e *store.Event) { e.ModerationMode = store.ManualApproval })
	g := h.client()
	g.mustCheckin(ev)
	expect(t, g.upload(testJPEG(1)), http.StatusCreated)
	h.srv.WaitIdle()
	gal := decode[struct {
		Photos []photoView `json:"photos"`
	}](t, g.do("GET", "/api/gallery/photos", nil))
	if len(gal.Photos) != 0 {
		t.Fatal("pending photo visible before approval")
	}
	host, _ := h.hostFor(ev)
	id := h.st.EventPhotos(ev.ID, nil)[0].ID
	expect(t, host.do("POST", "/api/host/photos/"+id+"/approve", nil), http.StatusOK)
	gal = decode[struct {
		Photos []photoView `json:"photos"`
	}](t, g.do("GET", "/api/gallery/photos", nil))
	if len(gal.Photos) != 1 {
		t.Fatal("approved photo not visible")
	}
}

func TestRateLimitOnCheckin(t *testing.T) {
	h := newHarness(t)
	ev := h.event("a")
	g := h.client()
	qr := h.qr(ev)
	last := 0
	for i := 0; i < 11; i++ {
		last = g.checkin(qr, venueLat+1, venueLng).Code
	}
	if last != http.StatusTooManyRequests {
		t.Fatalf("11th check-in in a minute returned %d", last)
	}
}

func TestDisplayLinkIsReadOnly(t *testing.T) {
	h := newHarness(t)
	ev := h.event("a")
	d := h.client()
	expect(t, d.do("POST", "/api/display/session", map[string]string{"k": h.srv.displayToken(ev)}), http.StatusOK)
	expect(t, d.do("GET", "/api/display/photos", nil), http.StatusOK)
	expect(t, d.do("GET", "/api/host/me", nil), http.StatusUnauthorized)
	expect(t, d.do("POST", "/api/host/event/pause", nil), http.StatusUnauthorized)
	// rotating invalidates the link
	if _, err := h.st.UpdateEvent(ev.ID, func(e *store.Event) error { e.DisplayVersion++; return nil }); err != nil {
		t.Fatal(err)
	}
	expect(t, d.do("GET", "/api/display/photos", nil), http.StatusUnauthorized)
}

// Regression: registering the static site must not conflict with API routes.
func TestHandlerWithStaticDir(t *testing.T) {
	dir := t.TempDir()
	_ = os.MkdirAll(filepath.Join(dir, "upload"), 0o755)
	_ = os.WriteFile(filepath.Join(dir, "upload", "index.html"), []byte("<p>info</p>"), 0o644)
	st, _ := store.Open(filepath.Join(dir, "data"), nil)
	stg, _ := storage.NewLocal(filepath.Join(dir, "obj"), []byte("0123456789abcdef0123456789abcdef"), nil)
	srv := New(Config{AdminPIN: adminPIN, Secret: []byte("0123456789abcdef0123456789abcdef"), StaticDir: dir}, st, stg, nil)
	h := srv.Handler()
	for path, want := range map[string]int{"/upload/": 200, "/api/nope": 404, "/api/health": 200} {
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, httptest.NewRequest("GET", path, nil))
		if rec.Code != want {
			t.Fatalf("%s = %d, want %d", path, rec.Code, want)
		}
	}
}

// ---------- JSON-store hardening ----------

func TestEventDataIsStoredInSeparateFiles(t *testing.T) {
	h := newHarness(t)
	evA, evB := h.event("a"), h.event("b")
	ga, gb := h.client(), h.client()
	ga.mustCheckin(evA)
	gb.mustCheckin(evB)
	expect(t, ga.upload(testJPEG(1)), http.StatusCreated)
	expect(t, gb.upload(testJPEG(2)), http.StatusCreated)
	h.srv.WaitIdle()

	if _, err := os.Stat(filepath.Join(h.dir, "data.json")); err == nil {
		t.Fatal("no global data.json may exist")
	}
	a, _ := os.ReadFile(filepath.Join(h.dir, "db", "events", evA.ID+".json"))
	b, _ := os.ReadFile(filepath.Join(h.dir, "db", "events", evB.ID+".json"))
	pa, pb := h.st.EventPhotos(evA.ID, nil)[0], h.st.EventPhotos(evB.ID, nil)[0]
	if !bytes.Contains(a, []byte(pa.ID)) || bytes.Contains(a, []byte(pb.ID)) || bytes.Contains(a, []byte(evB.ID)) {
		t.Fatal("event A file must contain only event A data")
	}
	if !bytes.Contains(b, []byte(pb.ID)) || bytes.Contains(b, []byte(pa.ID)) {
		t.Fatal("event B file must contain only event B data")
	}
	// metadata only: no photo bytes in JSON
	if len(a) > 64<<10 {
		t.Fatalf("event file unexpectedly large (%d bytes)", len(a))
	}
}

func TestReservationPersistedBeforePresignedURL(t *testing.T) {
	h := newHarness(t)
	ev := h.event("a")
	g := h.client()
	g.mustCheckin(ev)
	a := decode[authorizeResp](t, g.authorize(1234))
	if a.Upload.URL == "" {
		t.Fatal("no upload URL")
	}
	// The response exists only after the fsynced write: the file on disk
	// already has the pending reservation, and a fresh store sees it.
	raw, _ := os.ReadFile(filepath.Join(h.dir, "db", "events", ev.ID+".json"))
	if !bytes.Contains(raw, []byte(a.ReservationID)) {
		t.Fatal("reservation not on disk when presigned URL was issued")
	}
	reopened, err := store.Open(h.dir, h.clk.Now)
	if err != nil {
		t.Fatal(err)
	}
	r, err := reopened.Reservation(ev.ID, a.ReservationID)
	if err != nil || r.Status != store.ResPending {
		t.Fatalf("reopened store: %+v %v", r, err)
	}
}

func TestStartupReleasesStaleReservations(t *testing.T) {
	h := newHarness(t)
	ev := h.event("a")
	g := h.client()
	g.mustCheckin(ev)
	a := decode[authorizeResp](t, g.authorize(1000))
	h.clk.Advance(10 * time.Minute)

	// simulate a restart: new store + server over the same DATA_DIR
	secret := []byte("test-secret-test-secret-test-secret!")
	st, err := store.Open(h.dir, h.clk.Now)
	if err != nil {
		t.Fatal(err)
	}
	stg, _ := storage.NewLocal(filepath.Join(h.dir, "objects"), secret, h.clk.Now)
	srv := New(Config{AdminPIN: adminPIN, Secret: secret, Now: h.clk.Now}, st, stg, nil)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	srv.Start(ctx) // releases synchronously before serving
	defer srv.WaitIdle()

	r, err := st.Reservation(ev.ID, a.ReservationID)
	if err != nil || r.Status != store.ResReleased {
		t.Fatalf("stale reservation not released at startup: %+v %v", r, err)
	}
	gs, err := st.GuestSession(ev.ID, r.GuestSessionID)
	if err != nil || gs.ReservedCount != 0 {
		t.Fatalf("slot not returned: %+v %v", gs, err)
	}
}

func TestOrphanSweepDeletesOnlyUnreferencedOldObjects(t *testing.T) {
	h := newHarness(t)
	ev := h.event("a")
	g := h.client()
	g.mustCheckin(ev)
	expect(t, g.upload(testJPEG(1)), http.StatusCreated)
	h.srv.WaitIdle()
	pending := decode[authorizeResp](t, g.authorize(len(testJPEG(2))))
	expect(t, g.raw("PUT", pending.Upload.URL, testJPEG(2), "image/jpeg"), http.StatusOK)

	// Local objects carry real mtimes. Sweep "2 hours from now": every object
	// written by this test is then older than the 1h grace, so only
	// references can protect them.
	realNow := time.Now()
	h.srv.cfg.Now = func() time.Time { return realNow.Add(2 * time.Hour) }
	h.srv.cfg.OrphanGrace = time.Hour

	ctx := context.Background()
	orphanOld := "events/" + ev.ID + "/uploads/aaaaaaaaaaaaaaaa.jpg"
	orphanYoung := "events/" + ev.ID + "/uploads/bbbbbbbbbbbbbbbb.jpg"
	for _, k := range []string{orphanOld, orphanYoung} {
		if err := h.srv.storage.Put(ctx, k, "image/jpeg", testJPEG(3)); err != nil {
			t.Fatal(err)
		}
	}
	young := realNow.Add(2*time.Hour - 10*time.Minute) // in-flight from the sweeper's view
	_ = os.Chtimes(filepath.Join(h.dir, "objects", filepath.FromSlash(orphanYoung)), young, young)

	n, err := h.srv.SweepOrphans(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if n != 1 {
		t.Fatalf("deleted %d objects, want 1", n)
	}
	if _, err := h.srv.storage.Stat(ctx, orphanOld); err == nil {
		t.Fatal("old orphan not deleted")
	}
	if _, err := h.srv.storage.Stat(ctx, orphanYoung); err != nil {
		t.Fatal("young unreferenced object must be kept (in-flight upload)")
	}
	p := h.st.EventPhotos(ev.ID, nil)[0]
	for _, k := range []string{p.DisplayKey, p.ThumbKey} {
		if _, err := h.srv.storage.Stat(ctx, k); err != nil {
			t.Fatalf("referenced object %s deleted", k)
		}
	}
	r, _ := h.st.Reservation(ev.ID, pending.ReservationID)
	if _, err := h.srv.storage.Stat(ctx, r.ObjectKey); err != nil {
		t.Fatal("object of a pending reservation deleted")
	}
}

func TestLiveWallSessionIsSeparateFromHost(t *testing.T) {
	h := newHarness(t)
	ev := h.event("a")
	host, _ := h.hostFor(ev)

	// a host session alone grants no Live Wall access...
	expect(t, host.do("GET", "/api/display/photos", nil), http.StatusUnauthorized)
	// ...and a Live Wall session grants no host access, even in the same browser
	wall := h.client()
	rec := host.do("GET", "/api/host/display-link", nil)
	link := decode[map[string]string](t, rec)["url"]
	k := link[strings.Index(link, "k=")+2:]
	expect(t, wall.do("POST", "/api/display/session", map[string]string{"k": k}), http.StatusOK)
	expect(t, wall.do("GET", "/api/display/photos", nil), http.StatusOK)
	for _, path := range []string{"/api/host/me", "/api/host/photos", "/api/host/qr", "/api/admin/events"} {
		if c := wall.do("GET", path, nil).Code; c != http.StatusUnauthorized {
			t.Fatalf("display session reached %s (%d)", path, c)
		}
	}
	// the display cookie is an opaque server-side session, not the link token
	u, _ := url.Parse(base)
	for _, ck := range wall.jar.Cookies(u) {
		if ck.Name == cookieDisplay && ck.Value == k {
			t.Fatal("display cookie must not be the link token")
		}
	}
	// wall only sees wall-visible photos: hide one from the wall
	g := h.client()
	g.mustCheckin(ev)
	expect(t, g.upload(testJPEG(1)), http.StatusCreated)
	h.srv.WaitIdle()
	id := h.st.EventPhotos(ev.ID, nil)[0].ID
	expect(t, host.do("POST", "/api/host/photos/"+id+"/hide", map[string]string{"target": "wall"}), http.StatusOK)
	wp := decode[struct {
		Photos []photoView `json:"photos"`
	}](t, wall.do("GET", "/api/display/photos", nil))
	if len(wp.Photos) != 0 {
		t.Fatal("wall shows a photo hidden from the wall")
	}
	// rotating kills the display session; the host is unaffected
	expect(t, host.do("POST", "/api/host/display-link/rotate", nil), http.StatusOK)
	expect(t, wall.do("GET", "/api/display/photos", nil), http.StatusUnauthorized)
	expect(t, host.do("GET", "/api/host/me", nil), http.StatusOK)
}

// ---------- Hidden admin console ----------

func TestAdminHiddenWithoutSecretPath(t *testing.T) {
	h := newHarness(t)
	for _, key := range []string{"", "wrong-key-wrong-key-123", "admin"} {
		c := h.client()
		c.adminKey = key
		for _, p := range []string{"/api/admin/login", "/api/admin/me", "/api/admin/events"} {
			method := "GET"
			if p == "/api/admin/login" {
				method = "POST"
			}
			rec := c.do(method, p, map[string]string{"pin": adminPIN})
			if rec.Code != http.StatusNotFound || errCode(t, rec) != "NOT_FOUND" {
				t.Fatalf("key %q %s = %d %s, want 404 NOT_FOUND", key, p, rec.Code, rec.Body)
			}
		}
		// a valid admin cookie is useless without the key too
		adm := h.admin()
		adm.adminKey = key
		expect(t, adm.do("GET", "/api/admin/events", nil), http.StatusNotFound)
	}
	// the right key reaches the normal PIN check
	c := h.client()
	expect(t, c.do("POST", "/api/admin/login", map[string]string{"pin": "nope00"}), http.StatusUnauthorized)
	expect(t, c.do("POST", "/api/admin/login", map[string]string{"pin": adminPIN}), http.StatusOK)
}

func TestAdminDisabledWhenPathEmpty(t *testing.T) {
	h := newHarness(t)
	h.srv.cfg.AdminPath = ""
	c := h.client()
	expect(t, c.do("POST", "/api/admin/login", map[string]string{"pin": adminPIN}), http.StatusNotFound)
}

func TestAdminPageOnlyAtSecretPath(t *testing.T) {
	dir := t.TempDir()
	_ = os.MkdirAll(filepath.Join(dir, "admin"), 0o755)
	_ = os.WriteFile(filepath.Join(dir, "admin", "index.html"), []byte("<p>admin console</p>"), 0o644)
	_ = os.WriteFile(filepath.Join(dir, "admin", "index.txt"), []byte("rsc"), 0o644)
	_ = os.WriteFile(filepath.Join(dir, "404.html"), []byte("<p>not found</p>"), 0o644)
	st, _ := store.Open(filepath.Join(dir, "data"), nil)
	stg, _ := storage.NewLocal(filepath.Join(dir, "obj"), []byte("0123456789abcdef0123456789abcdef"), nil)
	srv := New(Config{AdminPIN: adminPIN, AdminPath: adminPath, Secret: []byte("0123456789abcdef0123456789abcdef"), StaticDir: dir}, st, stg, nil)
	hd := srv.Handler()
	get := func(p string) *httptest.ResponseRecorder {
		rec := httptest.NewRecorder()
		hd.ServeHTTP(rec, httptest.NewRequest("GET", p, nil))
		return rec
	}
	for _, p := range []string{"/admin", "/admin/", "/admin/index.html", "/admin/index.txt", "/admin.html"} {
		if rec := get(p); rec.Code != http.StatusNotFound || strings.Contains(rec.Body.String(), "admin console") {
			t.Fatalf("%s = %d, admin page must be hidden", p, rec.Code)
		}
	}
	rec := get("/" + adminPath + "/")
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), "admin console") {
		t.Fatalf("secret path = %d %s", rec.Code, rec.Body)
	}
	if rec.Header().Get("X-Robots-Tag") == "" {
		t.Fatal("admin page must be noindex")
	}
	if rec := get("/" + adminPath); rec.Code != http.StatusMovedPermanently {
		t.Fatalf("no-slash = %d", rec.Code)
	}
}

// ---------- Couple download without watermark ----------

func TestCoupleDownloadsPhotosWithoutWatermark(t *testing.T) {
	h := newHarness(t)
	ev := h.event("a")
	g := h.client()
	g.mustCheckin(ev)
	big := image.NewRGBA(image.Rect(0, 0, 600, 800))
	for i := range big.Pix {
		big.Pix[i] = 40 // dark photo
	}
	var jb bytes.Buffer
	_ = jpeg.Encode(&jb, big, &jpeg.Options{Quality: 90})
	expect(t, g.upload(jb.Bytes()), http.StatusCreated)
	h.srv.WaitIdle()

	host, _ := h.hostFor(ev)
	list := decode[struct {
		Photos []photoView `json:"photos"`
	}](t, expectRec(t, host.do("GET", "/api/host/photos", nil), http.StatusOK)).Photos
	if len(list) != 1 || list[0].DownloadURL == "" {
		t.Fatalf("host view = %+v", list)
	}
	p, _ := h.st.Photo(ev.ID, list[0].ID)
	if p.CleanKey == "" || p.CleanKey == p.DisplayKey {
		t.Fatalf("clean copy not stored: %+v", p)
	}

	// host gets the clean copy as an attachment
	rec := host.do("GET", list[0].DownloadURL, nil)
	expect(t, rec, http.StatusOK)
	if !strings.Contains(rec.Header().Get("Content-Disposition"), "attachment") {
		t.Fatal("download must be an attachment")
	}
	clean, _ := os.ReadFile(filepath.Join(h.dir, "objects", filepath.FromSlash(p.CleanKey)))
	display, _ := os.ReadFile(filepath.Join(h.dir, "objects", filepath.FromSlash(p.DisplayKey)))
	if !bytes.Equal(rec.Body.Bytes(), clean) || bytes.Equal(clean, display) {
		t.Fatal("download must be the clean copy, distinct from the watermarked display")
	}
	// the watermark is light text on this dark photo: only the display copy has it
	brightCorner := func(b []byte) int {
		img, _ := jpeg.Decode(bytes.NewReader(b))
		n := 0
		for y := 700; y < 800; y++ {
			for x := 400; x < 600; x++ {
				if r, _, _, _ := img.At(x, y).RGBA(); r>>8 > 150 {
					n++
				}
			}
		}
		return n
	}
	if brightCorner(display) < 100 || brightCorner(clean) != 0 {
		t.Fatalf("watermark pixels: display=%d clean=%d", brightCorner(display), brightCorner(clean))
	}

	// guests never see a download link, and cannot re-sign "original" for gallery/wall
	gal := decode[struct {
		Photos []photoView `json:"photos"`
	}](t, g.do("GET", "/api/gallery/photos", nil)).Photos
	if len(gal) != 1 || gal[0].DownloadURL != "" {
		t.Fatalf("gallery leaked a download link: %+v", gal)
	}
	forged := strings.Replace(strings.Replace(list[0].DownloadURL, "s=host", "s=gallery", 1), "/original?", "/original?", 1)
	expect(t, g.do("GET", forged, nil), http.StatusForbidden)
	stripped := strings.Replace(gal[0].PhotoURL, "/display?", "/original?", 1)
	expect(t, g.do("GET", stripped, nil), http.StatusForbidden)

	// ZIP for the couple holds the clean copy
	rec = host.do("GET", "/api/host/photos/download", nil)
	expect(t, rec, http.StatusOK)
	zr, err := zip.NewReader(bytes.NewReader(rec.Body.Bytes()), int64(rec.Body.Len()))
	if err != nil || len(zr.File) != 1 {
		t.Fatalf("zip: %v files=%d", err, len(zr.File))
	}
	f, _ := zr.File[0].Open()
	got, _ := io.ReadAll(f)
	if !bytes.Equal(got, clean) {
		t.Fatal("zip entry is not the clean copy")
	}
	expect(t, g.do("GET", "/api/host/photos/download", nil), http.StatusUnauthorized)

	// the clean copy is protected from the orphan sweep and removed on delete
	if !h.st.ReferencedKeys()[p.CleanKey] {
		t.Fatal("clean copy must be a referenced key")
	}
	expect(t, host.do("DELETE", "/api/host/photos/"+p.ID, nil), http.StatusNoContent)
	if _, err := os.Stat(filepath.Join(h.dir, "objects", filepath.FromSlash(p.CleanKey))); !os.IsNotExist(err) {
		t.Fatal("clean copy survived delete")
	}
}

// ---------- Load hardening ----------

// Guests behind one venue Wi-Fi / carrier NAT share an IP: many devices may
// check in from it, while each single device stays limited.
func TestCheckinLimitIsPerDeviceNotPerSharedIP(t *testing.T) {
	h := newHarness(t)
	ev := h.event("a")
	qr := h.qr(ev)
	for i := 0; i < 40; i++ {
		c := h.client()
		c.ip = "10.9.9.9" // same public IP for everyone
		body := loc(venueLat+0.0003, venueLng, 20, h.clk.Now())
		body["qr"] = qr
		body["deviceId"] = fmt.Sprintf("venue-device-%04d-abcdefgh", i)
		if rec := c.do("POST", "/api/guest/checkin", body); rec.Code != http.StatusOK {
			t.Fatalf("device %d on shared IP: %d %s", i, rec.Code, rec.Body)
		}
	}
}

func TestGalleryIsPaginatedWithTotals(t *testing.T) {
	h := newHarness(t)
	ev := h.event("a")
	var ids []string
	for i := 0; i < 7; i++ {
		g := h.client()
		g.mustCheckin(ev)
		expect(t, g.upload(testJPEG(i+1)), http.StatusCreated)
		h.clk.Advance(time.Second)
	}
	h.srv.WaitIdle()
	g := h.client()
	g.mustCheckin(ev)
	type page struct {
		Photos  []photoView    `json:"photos"`
		HasMore bool           `json:"hasMore"`
		Stats   map[string]int `json:"stats"`
	}
	p1 := decode[page](t, g.do("GET", "/api/gallery/photos?limit=3", nil))
	if len(p1.Photos) != 3 || !p1.HasMore || p1.Stats["photos"] != 7 {
		t.Fatalf("page 1 = %d photos hasMore=%v stats=%v", len(p1.Photos), p1.HasMore, p1.Stats)
	}
	seen := map[string]bool{}
	for _, p := range p1.Photos {
		seen[p.ID] = true
		ids = append(ids, p.ID)
	}
	p2 := decode[page](t, g.do("GET", "/api/gallery/photos?limit=3&before="+ids[2], nil))
	p3 := decode[page](t, g.do("GET", "/api/gallery/photos?limit=3&before="+p2.Photos[2].ID, nil))
	if len(p2.Photos) != 3 || len(p3.Photos) != 1 || p3.HasMore {
		t.Fatalf("pages: %d %d hasMore=%v", len(p2.Photos), len(p3.Photos), p3.HasMore)
	}
	for _, p := range append(p2.Photos, p3.Photos...) {
		if seen[p.ID] {
			t.Fatal("photo repeated across pages")
		}
		seen[p.ID] = true
	}
	// newest first
	if !p1.Photos[0].CreatedAt.After(p3.Photos[0].CreatedAt) {
		t.Fatal("gallery must be newest first")
	}
	// single photo endpoint (for incremental updates), same visibility rules
	one := decode[photoView](t, expectRec(t, g.do("GET", "/api/gallery/photos/"+ids[0], nil), http.StatusOK))
	if one.ID != ids[0] || one.PhotoURL == "" {
		t.Fatalf("single photo = %+v", one)
	}
	outsider := h.client()
	expect(t, outsider.do("GET", "/api/gallery/photos/"+ids[0], nil), http.StatusNotFound)
}

func TestLikesAreBatched(t *testing.T) {
	h := newHarness(t)
	ev := h.event("a")
	g := h.client()
	g.mustCheckin(ev)
	expect(t, g.upload(testJPEG(3)), http.StatusCreated)
	h.srv.WaitIdle()
	id := decode[struct {
		Photos []photoView `json:"photos"`
	}](t, g.do("GET", "/api/gallery/photos", nil)).Photos[0].ID

	before, _ := os.ReadFile(filepath.Join(h.dir, "db", "events", ev.ID+".json"))
	for i := 0; i < 25; i++ {
		c := h.client()
		c.ip = "10.7.7.7" // shared NAT: 25 guests, one IP
		body := loc(venueLat+0.0003, venueLng, 20, h.clk.Now())
		body["qr"] = h.qr(ev)
		body["deviceId"] = fmt.Sprintf("nat-device-%04d-abcdefgh", i)
		expect(t, c.do("POST", "/api/guest/checkin", body), http.StatusOK)
		rec := c.do("POST", "/api/gallery/photos/"+id+"/like", nil)
		expect(t, rec, http.StatusOK)
		if got := decode[map[string]any](t, rec)["likes"].(float64); int(got) != i+1 {
			t.Fatalf("like %d returned %v", i+1, got)
		}
	}
	// counts are visible right away, before any flush
	one := decode[photoView](t, g.do("GET", "/api/gallery/photos/"+id, nil))
	if one.Likes != 25 {
		t.Fatalf("pending likes not reflected: %d", one.Likes)
	}
	p, _ := h.st.Photo(ev.ID, id)
	if p.Likes != 0 {
		t.Fatalf("likes written per tap (%d), want batched", p.Likes)
	}
	h.srv.FlushLikes()
	p, _ = h.st.Photo(ev.ID, id)
	if p.Likes != 25 {
		t.Fatalf("after flush likes=%d", p.Likes)
	}
	after, _ := os.ReadFile(filepath.Join(h.dir, "db", "events", ev.ID+".json"))
	if bytes.Equal(before, after) {
		t.Fatal("flush must persist")
	}
}
