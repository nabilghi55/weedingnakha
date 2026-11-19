package imageproc

import (
	"bytes"
	"image"
	"image/color"
	"image/jpeg"
	"testing"
)

func sample(w, h int) []byte {
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	for i := range img.Pix {
		img.Pix[i] = uint8(i)
	}
	img.Set(0, 0, color.White)
	var buf bytes.Buffer
	_ = jpeg.Encode(&buf, img, nil)
	return buf.Bytes()
}

// withExif injects an APP1 Exif segment containing fake GPS data after SOI.
func withExif(j []byte) []byte {
	payload := append([]byte("Exif\x00\x00"), []byte("GPSLatitude=-7.96;GPSLongitude=112.63")...)
	seg := []byte{0xFF, 0xE1, byte((len(payload) + 2) >> 8), byte(len(payload) + 2)}
	out := append([]byte{}, j[:2]...)
	out = append(out, seg...)
	out = append(out, payload...)
	return append(out, j[2:]...)
}

func TestProcessStripsMetadataAndResizes(t *testing.T) {
	src := withExif(sample(2400, 1200))
	if !bytes.Contains(src, []byte("GPSLatitude")) {
		t.Fatal("fixture should contain GPS metadata")
	}
	res, err := Process(src, "image/jpeg")
	if err != nil {
		t.Fatal(err)
	}
	for _, b := range [][]byte{res.Display, res.Clean, res.Thumb} {
		if bytes.Contains(b, []byte("Exif")) || bytes.Contains(b, []byte("GPS")) {
			t.Fatal("metadata survived processing")
		}
	}
	if res.Width != DisplayEdge || res.Height != 800 {
		t.Fatalf("display size %dx%d", res.Width, res.Height)
	}
	cfg, err := jpeg.DecodeConfig(bytes.NewReader(res.Thumb))
	if err != nil || cfg.Width != ThumbEdge {
		t.Fatalf("thumb %v %v", cfg, err)
	}
}

func TestValidateRejectsMismatchAndGarbage(t *testing.T) {
	j := sample(200, 200)
	if _, err := Validate(j, "image/png"); err != ErrMismatch {
		t.Fatalf("want mismatch, got %v", err)
	}
	if _, err := Validate([]byte("<html><script>alert(1)</script>"), "image/jpeg"); err != ErrType {
		t.Fatalf("want type error, got %v", err)
	}
	if _, err := Validate(j, "image/webp"); err != ErrType {
		t.Fatalf("webp must be rejected, got %v", err)
	}
	if _, err := Validate(sample(32, 32), "image/jpeg"); err != ErrDimensions {
		t.Fatalf("tiny image must be rejected, got %v", err)
	}
	trunc := j[:len(j)/3]
	if _, err := Process(trunc, "image/jpeg"); err == nil {
		t.Fatal("truncated file must fail")
	}
}

func solidRGBA(w, h int, c color.RGBA) *image.RGBA {
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	for i := 0; i < len(img.Pix); i += 4 {
		img.Pix[i], img.Pix[i+1], img.Pix[i+2], img.Pix[i+3] = c.R, c.G, c.B, c.A
	}
	return img
}

// The watermark lands in the bottom-right corner only, and picks light text
// on dark photos and dark text on light (paper) areas.
func TestWatermarkBottomRightAdaptive(t *testing.T) {
	for _, tc := range []struct {
		name    string
		bg      color.RGBA
		lighter bool // watermark pixels brighter than the background
	}{
		{"dark photo", color.RGBA{30, 30, 30, 255}, true},
		{"light paper", color.RGBA{243, 239, 230, 255}, false},
	} {
		src := solidRGBA(1000, 1300, tc.bg)
		out := Watermark(src)
		if !bytes.Equal(src.Pix, solidRGBA(1000, 1300, tc.bg).Pix) {
			t.Fatalf("%s: Watermark must not modify its input", tc.name)
		}
		changedCorner, changedElsewhere := 0, 0
		var brighter, darker int
		for y := 0; y < 1300; y += 3 {
			for x := 0; x < 1000; x += 3 {
				i := out.PixOffset(x, y)
				if out.Pix[i] == tc.bg.R && out.Pix[i+1] == tc.bg.G && out.Pix[i+2] == tc.bg.B {
					continue
				}
				if x > 700 && y > 1150 {
					changedCorner++
					if out.Pix[i] > tc.bg.R {
						brighter++
					} else {
						darker++
					}
				} else {
					changedElsewhere++
				}
			}
		}
		if changedCorner == 0 || changedElsewhere != 0 {
			t.Fatalf("%s: corner=%d elsewhere=%d", tc.name, changedCorner, changedElsewhere)
		}
		if tc.lighter != (brighter > darker) {
			t.Fatalf("%s: wrong watermark tone (brighter=%d darker=%d)", tc.name, brighter, darker)
		}
	}
}

func TestProcessKeepsCleanCopyWithoutWatermark(t *testing.T) {
	res, err := Process(sample(1200, 1600), "image/jpeg")
	if err != nil {
		t.Fatal(err)
	}
	clean, _ := jpeg.Decode(bytes.NewReader(res.Clean))
	disp, _ := jpeg.Decode(bytes.NewReader(res.Display))
	if clean.Bounds() != disp.Bounds() {
		t.Fatalf("clean %v vs display %v", clean.Bounds(), disp.Bounds())
	}
	// top-left area is identical (modulo JPEG noise); bottom-right differs (watermark)
	diff := func(x0, y0, x1, y1 int) float64 {
		var d, n float64
		for y := y0; y < y1; y += 2 {
			for x := x0; x < x1; x += 2 {
				r1, g1, b1, _ := clean.At(x, y).RGBA()
				r2, g2, b2, _ := disp.At(x, y).RGBA()
				d += absf(float64(r1)-float64(r2)) + absf(float64(g1)-float64(g2)) + absf(float64(b1)-float64(b2))
				n++
			}
		}
		return d / n / 257
	}
	w, h := clean.Bounds().Dx(), clean.Bounds().Dy()
	if top, corner := diff(0, 0, w/3, h/3), diff(w*4/5, h*19/20, w-20, h-8); corner < top+15 {
		t.Fatalf("watermark not detectable: top=%.1f corner=%.1f", top, corner)
	}
}

func absf(v float64) float64 {
	if v < 0 {
		return -v
	}
	return v
}
