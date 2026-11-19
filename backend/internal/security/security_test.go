package security

import (
	"math"
	"testing"
	"time"
)

func TestHaversine(t *testing.T) {
	// 0.001° latitude ≈ 111.2 m
	d := HaversineMeters(-7.9666, 112.6326, -7.9656, 112.6326)
	if math.Abs(d-111.2) > 1 {
		t.Fatalf("distance = %.2f", d)
	}
	if HaversineMeters(1, 1, 1, 1) != 0 {
		t.Fatal("zero distance")
	}
}

func TestSignerPurposeIsolationAndTamper(t *testing.T) {
	secret := []byte("0123456789abcdef0123456789abcdef")
	a, b := NewSigner(secret, "a"), NewSigner(secret, "b")
	tok, _ := a.Sign(map[string]string{"e": "x"})
	var out map[string]string
	if err := a.Verify(tok, &out); err != nil || out["e"] != "x" {
		t.Fatalf("verify: %v", err)
	}
	if b.Verify(tok, &out) == nil {
		t.Fatal("token verified under another purpose")
	}
	if a.Verify("e30."+tok[len(tok)-10:], &out) == nil {
		t.Fatal("tampered token verified")
	}
}

func TestRateLimiter(t *testing.T) {
	now := time.Unix(0, 0)
	l := NewRateLimiter(2, time.Minute, func() time.Time { return now })
	for i, want := range []bool{true, true, false} {
		if ok, _ := l.Allow("k"); ok != want {
			t.Fatalf("hit %d = %v", i, ok)
		}
	}
	now = now.Add(time.Minute)
	if ok, _ := l.Allow("k"); !ok {
		t.Fatal("window should reset")
	}
}

func TestRandomTokenLength(t *testing.T) {
	if len(RandomToken(32)) != 43 {
		t.Fatal("32 random bytes must encode to 43 base64url chars")
	}
}
