// Package imageproc validates uploaded photos and produces the sanitised
// variants that are actually shown to people.
//
// Re-encoding from decoded pixels is what strips EXIF/GPS/maker metadata:
// the output JPEG contains only pixel data written by the stdlib encoder.
package imageproc

import (
	"bytes"
	"crypto/sha256"
	_ "embed"
	"encoding/hex"
	"errors"
	"image"
	"image/color"
	"image/draw"
	"image/jpeg"
	"image/png"
)

const (
	MaxPixels = 40_000_000 // decompression-bomb guard
	MaxEdge   = 10_000
	MinEdge   = 64

	DisplayEdge = 1600
	ThumbEdge   = 480
)

// Allowed upload types. WebP is intentionally not accepted: the stdlib has no
// WebP decoder, and the photobooth always produces JPEG.
var AllowedTypes = map[string]string{
	"image/jpeg": "jpg",
	"image/png":  "png",
}

var (
	ErrType       = errors.New("file harus berupa JPEG atau PNG")
	ErrMismatch   = errors.New("isi file tidak sesuai dengan tipe yang dideklarasikan")
	ErrDimensions = errors.New("dimensi foto tidak valid")
	ErrCorrupt    = errors.New("file foto rusak atau tidak dapat dibaca")
)

// Sniff returns the MIME type based on magic bytes only.
func Sniff(b []byte) string {
	switch {
	case len(b) >= 3 && b[0] == 0xFF && b[1] == 0xD8 && b[2] == 0xFF:
		return "image/jpeg"
	case len(b) >= 8 && bytes.Equal(b[:8], []byte{0x89, 'P', 'N', 'G', 0x0D, 0x0A, 0x1A, 0x0A}):
		return "image/png"
	}
	return ""
}

type Info struct {
	Type   string
	Width  int
	Height int
	SHA256 string
}

// Validate checks declared type vs magic bytes and the header dimensions
// without decoding the full image.
func Validate(data []byte, declared string) (Info, error) {
	if _, ok := AllowedTypes[declared]; !ok {
		return Info{}, ErrType
	}
	got := Sniff(data)
	if got == "" {
		return Info{}, ErrType
	}
	if got != declared {
		return Info{}, ErrMismatch
	}
	var cfg image.Config
	var err error
	if got == "image/jpeg" {
		cfg, err = jpeg.DecodeConfig(bytes.NewReader(data))
	} else {
		cfg, err = png.DecodeConfig(bytes.NewReader(data))
	}
	if err != nil {
		return Info{}, ErrCorrupt
	}
	if cfg.Width < MinEdge || cfg.Height < MinEdge || cfg.Width > MaxEdge || cfg.Height > MaxEdge ||
		cfg.Width*cfg.Height > MaxPixels {
		return Info{}, ErrDimensions
	}
	sum := sha256.Sum256(data)
	return Info{Type: got, Width: cfg.Width, Height: cfg.Height, SHA256: hex.EncodeToString(sum[:])}, nil
}

type Result struct {
	Display       []byte // shown in gallery / Live Wall — carries the studio watermark
	Clean         []byte // same pixels without watermark — downloadable by the couple only
	Thumb         []byte
	Width, Height int // of the display variant
}

// Process fully decodes a validated image and returns metadata-free JPEGs.
func Process(data []byte, declared string) (Result, error) {
	if _, err := Validate(data, declared); err != nil {
		return Result{}, err
	}
	var src image.Image
	var err error
	if declared == "image/jpeg" {
		src, err = jpeg.Decode(bytes.NewReader(data))
	} else {
		src, err = png.Decode(bytes.NewReader(data))
	}
	if err != nil {
		return Result{}, ErrCorrupt
	}
	rgba := flatten(src)
	disp := Resize(rgba, DisplayEdge)
	c, err := encode(disp, 90)
	if err != nil {
		return Result{}, err
	}
	marked := Watermark(disp)
	d, err := encode(marked, 86)
	if err != nil {
		return Result{}, err
	}
	t, err := encode(Resize(marked, ThumbEdge), 80)
	if err != nil {
		return Result{}, err
	}
	return Result{Display: d, Clean: c, Thumb: t, Width: disp.Bounds().Dx(), Height: disp.Bounds().Dy()}, nil
}

// EncodeCover sanitises an admin-uploaded cover photo.
func EncodeCover(data []byte, declared string) ([]byte, error) {
	if _, err := Validate(data, declared); err != nil {
		return nil, err
	}
	var src image.Image
	var err error
	if declared == "image/jpeg" {
		src, err = jpeg.Decode(bytes.NewReader(data))
	} else {
		src, err = png.Decode(bytes.NewReader(data))
	}
	if err != nil {
		return nil, ErrCorrupt
	}
	return encode(Resize(flatten(src), 2400), 86)
}

func encode(img image.Image, q int) ([]byte, error) {
	var buf bytes.Buffer
	if err := jpeg.Encode(&buf, img, &jpeg.Options{Quality: q}); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

// flatten draws onto an opaque white RGBA canvas (PNG transparency → white).
func flatten(src image.Image) *image.RGBA {
	b := src.Bounds()
	dst := image.NewRGBA(image.Rect(0, 0, b.Dx(), b.Dy()))
	draw.Draw(dst, dst.Bounds(), &image.Uniform{C: color.White}, image.Point{}, draw.Src)
	draw.Draw(dst, dst.Bounds(), src, b.Min, draw.Over)
	return dst
}

// Resize downscales with an area-average (box) filter so the longest edge is
// at most maxEdge. Images already small enough are returned unchanged.
func Resize(src *image.RGBA, maxEdge int) *image.RGBA {
	sw, sh := src.Bounds().Dx(), src.Bounds().Dy()
	if sw <= maxEdge && sh <= maxEdge {
		return src
	}
	var dw, dh int
	if sw >= sh {
		dw, dh = maxEdge, max(1, sh*maxEdge/sw)
	} else {
		dh, dw = maxEdge, max(1, sw*maxEdge/sh)
	}
	dst := image.NewRGBA(image.Rect(0, 0, dw, dh))
	for y := 0; y < dh; y++ {
		y0, y1 := y*sh/dh, max((y+1)*sh/dh, y*sh/dh+1)
		for x := 0; x < dw; x++ {
			x0, x1 := x*sw/dw, max((x+1)*sw/dw, x*sw/dw+1)
			var r, g, b, a, n uint32
			for sy := y0; sy < y1; sy++ {
				i := src.PixOffset(x0, sy)
				for sx := x0; sx < x1; sx++ {
					r += uint32(src.Pix[i])
					g += uint32(src.Pix[i+1])
					b += uint32(src.Pix[i+2])
					a += uint32(src.Pix[i+3])
					n++
					i += 4
				}
			}
			j := dst.PixOffset(x, y)
			dst.Pix[j], dst.Pix[j+1], dst.Pix[j+2], dst.Pix[j+3] = uint8(r/n), uint8(g/n), uint8(b/n), uint8(a/n)
		}
	}
	return dst
}

// ---------- Studio watermark ----------

//go:embed watermark_light.png
var watermarkLightPNG []byte

//go:embed watermark_dark.png
var watermarkDarkPNG []byte

var watermarkLight, watermarkDark = mustRGBA(watermarkLightPNG), mustRGBA(watermarkDarkPNG)

func mustRGBA(b []byte) *image.RGBA {
	img, err := png.Decode(bytes.NewReader(b))
	if err != nil {
		panic("imageproc: bad embedded watermark: " + err.Error())
	}
	out := image.NewRGBA(image.Rect(0, 0, img.Bounds().Dx(), img.Bounds().Dy()))
	draw.Draw(out, out.Bounds(), img, img.Bounds().Min, draw.Src)
	return out
}

// Watermark returns a copy of img with "@seribu.lensa" in the bottom-right
// corner, about 20% of the image width; light text on dark areas and dark
// text on light areas (e.g. the paper footer of the newspaper frame).
func Watermark(img *image.RGBA) *image.RGBA {
	w, h := img.Bounds().Dx(), img.Bounds().Dy()
	out := image.NewRGBA(image.Rect(0, 0, w, h))
	draw.Draw(out, out.Bounds(), img, img.Bounds().Min, draw.Src)
	if w < 200 || h < 200 {
		return out
	}
	mark := Resize(watermarkLight, w/5)
	mw, mh := mark.Bounds().Dx(), mark.Bounds().Dy()
	margin := max(8, w/45)
	r := image.Rect(w-margin-mw, h-margin/2-mh, w-margin, h-margin/2)
	if meanLuma(out, r) > 150 {
		mark = Resize(watermarkDark, w/5)
	}
	draw.Draw(out, r, mark, image.Point{}, draw.Over)
	return out
}

func meanLuma(img *image.RGBA, r image.Rectangle) float64 {
	r = r.Intersect(img.Bounds())
	var sum, n float64
	for y := r.Min.Y; y < r.Max.Y; y += 2 {
		for x := r.Min.X; x < r.Max.X; x += 2 {
			i := img.PixOffset(x, y)
			sum += 0.299*float64(img.Pix[i]) + 0.587*float64(img.Pix[i+1]) + 0.114*float64(img.Pix[i+2])
			n++
		}
	}
	if n == 0 {
		return 0
	}
	return sum / n
}

// ---------- Custom photo frames ----------

const (
	FrameMinEdge = 600
	FrameMaxEdge = 2160
)

var (
	ErrFrameType   = errors.New("bingkai harus berupa file PNG")
	ErrFrameShape  = errors.New("bingkai harus potret atau persegi, minimal 600 px")
	ErrFrameOpaque = errors.New("bingkai harus punya area transparan untuk foto")
)

// EncodeFrame sanitises an admin-uploaded frame overlay: a PNG whose
// transparent area is where the guest's photo shows through. The output is a
// freshly encoded PNG (metadata stripped, alpha kept), longest edge at most
// FrameMaxEdge.
func EncodeFrame(data []byte) ([]byte, error) {
	if Sniff(data) != "image/png" {
		return nil, ErrFrameType
	}
	info, err := Validate(data, "image/png")
	if err != nil {
		return nil, err
	}
	// portrait to square (9:16 story … 1:1), so it fits a phone photo
	if min(info.Width, info.Height) < FrameMinEdge || info.Width > info.Height || info.Height > info.Width*2 {
		return nil, ErrFrameShape
	}
	src, err := png.Decode(bytes.NewReader(data))
	if err != nil {
		return nil, ErrCorrupt
	}
	b := src.Bounds()
	rgba := image.NewRGBA(image.Rect(0, 0, b.Dx(), b.Dy()))
	draw.Draw(rgba, rgba.Bounds(), src, b.Min, draw.Src)

	// at least 10% of the frame must be see-through, or the photo is hidden.
	// A frame without transparency may mark its photo windows in green
	// instead (greenscreen, e.g. a Canva export): those become transparent.
	if clearShare(rgba) < 0.1 {
		keyGreen(rgba)
		if clearShare(rgba) < 0.1 {
			return nil, ErrFrameOpaque
		}
	}

	var buf bytes.Buffer
	enc := png.Encoder{CompressionLevel: png.BestCompression}
	if err := enc.Encode(&buf, Resize(rgba, FrameMaxEdge)); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

// clearShare is the fraction of (mostly) transparent pixels.
func clearShare(img *image.RGBA) float64 {
	clear := 0
	for i := 3; i < len(img.Pix); i += 4 {
		if img.Pix[i] < 128 {
			clear++
		}
	}
	return float64(clear) / float64(len(img.Pix)/4)
}

// keyGreen makes green-screen pixels transparent (chroma key). "Green" is
// relative: how far the green channel rises above red and blue, so any
// clearly green fill works (#00FF00, Canva's softer greens, a pattern laid
// over the green). Pixels on the edge of a green area get partial alpha and
// lose their green tint, so no green fringe shows around the guest photo.
func keyGreen(img *image.RGBA) {
	const lo, hi = 20, 45 // green dominance: below lo kept, above hi fully clear
	p := img.Pix
	for i := 0; i+3 < len(p); i += 4 {
		r, g, b := int(p[i]), int(p[i+1]), int(p[i+2])
		d := g - max(r, b)
		if d <= lo || g < 60 {
			continue
		}
		keep := 1.0 - float64(d-lo)/float64(hi-lo)
		if keep < 0 {
			keep = 0
		}
		// RGBA is premultiplied: colour channels scale with alpha
		g = max(r, b) // despill
		p[i] = uint8(float64(r) * keep)
		p[i+1] = uint8(float64(g) * keep)
		p[i+2] = uint8(float64(b) * keep)
		p[i+3] = uint8(float64(p[i+3]) * keep)
	}
}
