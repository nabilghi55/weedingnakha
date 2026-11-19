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
	return ev.FrameKey
}
