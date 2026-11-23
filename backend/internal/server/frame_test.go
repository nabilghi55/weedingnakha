package server

import (
	"bytes"
	"image"
	"image/color"
	"image/png"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/nakhasolution/weedingnakha/backend/internal/store"
)

// framePNG draws a w×h frame: an opaque border of `border` px around a
// transparent window.
func framePNG(w, h, border int) []byte {
	img := image.NewNRGBA(image.Rect(0, 0, w, h))
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			if x < border || y < border || x >= w-border || y >= h-border {
				img.Set(x, y, color.NRGBA{91, 34, 38, 255})
			}
		}
	}
	var buf bytes.Buffer
	_ = png.Encode(&buf, img)
	return buf.Bytes()
}

func (c *client) uploadFrame(evID string, data []byte) *httptest.ResponseRecorder {
	var body bytes.Buffer
	mw := multipart.NewWriter(&body)
	fw, _ := mw.CreateFormFile("frame", "frame.png")
	_, _ = fw.Write(data)
	_ = mw.Close()
	return c.raw("POST", "/api/admin/events/"+evID+"/frame", body.Bytes(), mw.FormDataContentType())
}

func TestCustomFrame(t *testing.T) {
	h := newHarness(t)
	ev := h.event("frame")
	adm := h.admin()

	// rejected: JPEG, fully opaque PNG, landscape, too small; guests cannot upload
	expect(t, adm.uploadFrame(ev.ID, testJPEG(1)), http.StatusUnprocessableEntity)
	expect(t, adm.uploadFrame(ev.ID, framePNG(1080, 1350, 600)), http.StatusUnprocessableEntity)
	expect(t, adm.uploadFrame(ev.ID, framePNG(1350, 1080, 60)), http.StatusUnprocessableEntity)
	expect(t, adm.uploadFrame(ev.ID, framePNG(400, 500, 20)), http.StatusUnprocessableEntity)
	expect(t, h.client().uploadFrame(ev.ID, framePNG(1080, 1350, 60)), http.StatusUnauthorized)

	rec := adm.uploadFrame(ev.ID, framePNG(1080, 1350, 60))
	expect(t, rec, http.StatusOK)
	url, _ := decode[map[string]any](t, rec)["frameUrl"].(string)
	if url == "" {
		t.Fatal("frameUrl missing after upload")
	}

	// public view exposes it; served same-origin as PNG with alpha intact
	pub := decode[map[string]any](t, h.client().do("GET", "/api/public/event?slug=frame", nil))
	if pub["frameUrl"] != url {
		t.Fatalf("public frameUrl = %v, want %s", pub["frameUrl"], url)
	}
	got := h.client().raw("GET", url, nil, "")
	expect(t, got, http.StatusOK)
	if ct := got.Header().Get("Content-Type"); ct != "image/png" {
		t.Fatalf("content-type = %s", ct)
	}
	img, err := png.Decode(bytes.NewReader(got.Body.Bytes()))
	if err != nil {
		t.Fatal(err)
	}
	if _, _, _, a := img.At(540, 675).RGBA(); a != 0 {
		t.Fatal("transparent window lost its alpha")
	}
	if !h.st.ReferencedKeys()[frameKey(h, ev.ID)] {
		t.Fatal("frame would be removed by the orphan sweep")
	}

	// delete
	rec = adm.do("DELETE", "/api/admin/events/"+ev.ID+"/frame", nil)
	expect(t, rec, http.StatusOK)
	if decode[map[string]any](t, rec)["frameUrl"] != "" {
		t.Fatal("frameUrl still set after delete")
	}
	expect(t, h.client().raw("GET", url, nil, ""), http.StatusNotFound)
}

func frameKey(h *harness, id string) string {
	ev, _ := h.st.Event(id)
	if k := ev.Frames(); len(k) > 0 {
		return k[0]
	}
	return ""
}

// greenFramePNG is an opaque frame whose photo window is painted green
// (a greenscreen export, e.g. from Canva) instead of being transparent.
func greenFramePNG(w, h, border int, green color.NRGBA) []byte {
	img := image.NewNRGBA(image.Rect(0, 0, w, h))
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			c := color.NRGBA{31, 78, 138, 255}
			if x >= border && y >= border && x < w-border && y < h-border {
				c = green
			}
			img.Set(x, y, c)
		}
	}
	var buf bytes.Buffer
	_ = png.Encode(&buf, img)
	return buf.Bytes()
}

func TestGreenscreenFrame(t *testing.T) {
	h := newHarness(t)
	ev := h.event("green")
	adm := h.admin()
	for _, g := range []color.NRGBA{{0, 255, 0, 255}, {95, 192, 110, 255}} {
		rec := adm.uploadFrame(ev.ID, greenFramePNG(1080, 1920, 120, g))
		expect(t, rec, http.StatusOK)
	}
	pub := decode[map[string]any](t, h.client().do("GET", "/api/public/event?slug=green", nil))
	frames, _ := pub["frames"].([]any)
	if len(frames) != 2 {
		t.Fatalf("frames = %v, want 2", pub["frames"])
	}
	for _, f := range frames {
		got := h.client().raw("GET", f.(map[string]any)["url"].(string), nil, "")
		expect(t, got, http.StatusOK)
		img, err := png.Decode(bytes.NewReader(got.Body.Bytes()))
		if err != nil {
			t.Fatal(err)
		}
		if _, _, _, a := img.At(540, 960).RGBA(); a != 0 {
			t.Fatal("green window was not keyed out")
		}
		if _, _, _, a := img.At(10, 10).RGBA(); a != 0xffff {
			t.Fatal("blue border lost its opacity")
		}
	}
}

func TestFrameLimit(t *testing.T) {
	h := newHarness(t)
	ev := h.event("limit")
	adm := h.admin()
	for i := 0; i < store.MaxFrames; i++ {
		expect(t, adm.uploadFrame(ev.ID, framePNG(1080, 1350, 60)), http.StatusOK)
	}
	expect(t, adm.uploadFrame(ev.ID, framePNG(1080, 1350, 60)), http.StatusConflict)

	pub := decode[map[string]any](t, h.client().do("GET", "/api/public/event?slug=limit", nil))
	frames, _ := pub["frames"].([]any)
	if len(frames) != store.MaxFrames {
		t.Fatalf("frames = %d, want %d", len(frames), store.MaxFrames)
	}
	first := frames[0].(map[string]any)
	if pub["frameUrl"] != first["url"] {
		t.Fatal("frameUrl should be the first frame")
	}

	// delete one by id: two left, its URL gone, a new upload fits again
	rec := adm.do("DELETE", "/api/admin/events/"+ev.ID+"/frames/"+first["id"].(string), nil)
	expect(t, rec, http.StatusOK)
	if n := len(decode[map[string]any](t, rec)["frames"].([]any)); n != store.MaxFrames-1 {
		t.Fatalf("frames after delete = %d, want %d", n, store.MaxFrames-1)
	}
	expect(t, h.client().raw("GET", first["url"].(string), nil, ""), http.StatusNotFound)
	expect(t, adm.do("DELETE", "/api/admin/events/"+ev.ID+"/frames/nope", nil), http.StatusNotFound)
	expect(t, adm.uploadFrame(ev.ID, framePNG(1080, 1350, 60)), http.StatusOK)
	if n := len(h.st.ReferencedKeys()); n < 3 {
		t.Fatalf("referenced keys = %d", n)
	}
}
