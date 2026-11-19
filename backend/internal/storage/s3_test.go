package storage

import (
	"net/url"
	"strings"
	"testing"
	"time"
)

func TestS3PresignPutSignsTypeAndLength(t *testing.T) {
	s, err := NewS3(S3Config{Endpoint: "https://acc.r2.cloudflarestorage.com", Bucket: "photos", AccessKeyID: "AK", SecretAccessKey: "SK"},
		func() time.Time { return time.Date(2026, 12, 12, 3, 0, 0, 0, time.UTC) })
	if err != nil {
		t.Fatal(err)
	}
	req, err := s.PresignPut("events/aaaaaaaaaaaaaaaa/uploads/bbbbbbbbbbbbbbbb.jpg", "image/jpeg", 1234, 5*time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	u, _ := url.Parse(req.URL)
	q := u.Query()
	if u.Host != "acc.r2.cloudflarestorage.com" || !strings.HasPrefix(u.Path, "/photos/events/") {
		t.Fatalf("url %s", req.URL)
	}
	if q.Get("X-Amz-Expires") != "300" || q.Get("X-Amz-SignedHeaders") != "content-length;content-type;host" || len(q.Get("X-Amz-Signature")) != 64 {
		t.Fatalf("query %v", q)
	}
	if strings.Contains(req.URL, "SK") {
		t.Fatal("secret leaked into URL")
	}
	if _, err := s.PresignPut("../../etc/passwd", "image/jpeg", 1, time.Minute); err != ErrInvalidKey {
		t.Fatal("client-like key must be rejected")
	}
}
