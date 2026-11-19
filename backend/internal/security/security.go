// Package security holds the small crypto helpers shared by the API:
// random tokens, token hashing, HMAC-signed tokens, rate limiting and
// geodesic distance. Everything is stdlib only.
package security

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"math"
	"strings"
	"sync"
	"time"
)

// RandomToken returns n crypto-secure random bytes encoded as base64url.
func RandomToken(n int) string {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		panic("crypto/rand unavailable: " + err.Error())
	}
	return base64.RawURLEncoding.EncodeToString(b)
}

// RandomHex returns n random bytes as lowercase hex (used for IDs and object keys).
func RandomHex(n int) string {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		panic("crypto/rand unavailable: " + err.Error())
	}
	return hex.EncodeToString(b)
}

// HashToken is the only form in which bearer secrets (host tokens, session
// tokens, device IDs) are ever persisted.
func HashToken(tok string) string {
	sum := sha256.Sum256([]byte(tok))
	return hex.EncodeToString(sum[:])
}

// Equal compares two strings in constant time.
func Equal(a, b string) bool {
	return subtle.ConstantTimeCompare([]byte(a), []byte(b)) == 1
}

// ---------- Signed tokens ----------

var ErrBadToken = errors.New("invalid token")

// Signer issues and verifies "<base64url(json)>.<base64url(hmac)>" tokens.
// Each purpose gets its own derived key, so a token minted for one purpose
// (e.g. a display link) can never verify as another (e.g. a guest check-in).
type Signer struct {
	key []byte
}

func NewSigner(secret []byte, purpose string) *Signer {
	m := hmac.New(sha256.New, secret)
	m.Write([]byte("nakha/v1/" + purpose))
	return &Signer{key: m.Sum(nil)}
}

func (s *Signer) mac(data []byte) []byte {
	m := hmac.New(sha256.New, s.key)
	m.Write(data)
	return m.Sum(nil)
}

// MAC signs arbitrary string parts (joined with a separator that cannot appear in them).
func (s *Signer) MAC(parts ...string) string {
	return base64.RawURLEncoding.EncodeToString(s.mac([]byte(strings.Join(parts, "\x1f"))))
}

// CheckMAC verifies a value produced by MAC in constant time.
func (s *Signer) CheckMAC(sig string, parts ...string) bool {
	return hmac.Equal([]byte(sig), []byte(s.MAC(parts...)))
}

func (s *Signer) Sign(payload any) (string, error) {
	b, err := json.Marshal(payload)
	if err != nil {
		return "", err
	}
	body := base64.RawURLEncoding.EncodeToString(b)
	return body + "." + base64.RawURLEncoding.EncodeToString(s.mac([]byte(body))), nil
}

// Verify checks the signature first and only then decodes the payload.
func (s *Signer) Verify(tok string, out any) error {
	if len(tok) > 2048 {
		return ErrBadToken
	}
	body, sig, ok := strings.Cut(tok, ".")
	if !ok || body == "" || sig == "" {
		return ErrBadToken
	}
	got, err := base64.RawURLEncoding.DecodeString(sig)
	if err != nil || !hmac.Equal(got, s.mac([]byte(body))) {
		return ErrBadToken
	}
	raw, err := base64.RawURLEncoding.DecodeString(body)
	if err != nil {
		return ErrBadToken
	}
	if err := json.Unmarshal(raw, out); err != nil {
		return ErrBadToken
	}
	return nil
}

// ---------- Geo ----------

const earthRadiusM = 6371008.8

// HaversineMeters returns the great-circle distance between two WGS84 points.
func HaversineMeters(lat1, lon1, lat2, lon2 float64) float64 {
	rad := math.Pi / 180
	dLat := (lat2 - lat1) * rad
	dLon := (lon2 - lon1) * rad
	a := math.Sin(dLat/2)*math.Sin(dLat/2) +
		math.Cos(lat1*rad)*math.Cos(lat2*rad)*math.Sin(dLon/2)*math.Sin(dLon/2)
	return 2 * earthRadiusM * math.Asin(math.Min(1, math.Sqrt(a)))
}

// ValidCoord reports whether lat/lng are finite and in range.
func ValidCoord(lat, lng float64) bool {
	return !math.IsNaN(lat) && !math.IsNaN(lng) && !math.IsInf(lat, 0) && !math.IsInf(lng, 0) &&
		lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180
}

// ---------- Rate limiting ----------

// RateLimiter is a fixed-window counter per key (IP, session, ...).
type RateLimiter struct {
	mu      sync.Mutex
	limit   int
	window  time.Duration
	now     func() time.Time
	buckets map[string]*bucket
	sweep   time.Time
}

type bucket struct {
	start time.Time
	count int
}

func NewRateLimiter(limit int, window time.Duration, now func() time.Time) *RateLimiter {
	if now == nil {
		now = time.Now
	}
	return &RateLimiter{limit: limit, window: window, now: now, buckets: map[string]*bucket{}}
}

// Allow records a hit and reports whether it is within the limit; when it is
// not, it also returns how long until the window resets.
func (l *RateLimiter) Allow(key string) (bool, time.Duration) {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := l.now()
	if now.Sub(l.sweep) > l.window*4 {
		for k, b := range l.buckets {
			if now.Sub(b.start) > l.window {
				delete(l.buckets, k)
			}
		}
		l.sweep = now
	}
	b := l.buckets[key]
	if b == nil || now.Sub(b.start) >= l.window {
		b = &bucket{start: now}
		l.buckets[key] = b
	}
	b.count++
	if b.count > l.limit {
		return false, b.start.Add(l.window).Sub(now)
	}
	return true, 0
}
