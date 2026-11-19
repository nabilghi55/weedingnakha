// Package storage abstracts the private object store that holds every photo.
//
// Two drivers exist:
//   - S3: any S3-compatible bucket (Cloudflare R2, AWS S3, MinIO). Browsers
//     upload with short-lived presigned PUT URLs; the bucket stays private.
//   - Local: a private directory on disk for development and tests. It mimics
//     presigned URLs with HMAC-signed links handled by the API itself; files
//     are never served from a public static path.
package storage

import (
	"context"
	"errors"
	"io"
	"regexp"
	"time"
)

var (
	ErrNotFound   = errors.New("object not found")
	ErrInvalidKey = errors.New("invalid object key")
)

// Object keys are always generated server-side and must match this shape:
// events/{event_id}/{kind}/{id}.{ext}
var keyRe = regexp.MustCompile(`^events/[a-z0-9]{8,40}/(uploads|photos|thumbs|covers|frames)/[a-z0-9]{8,64}\.(jpg|png)$`)

func ValidKey(key string) bool { return keyRe.MatchString(key) }

// ObjectInfo describes a stored object (used for orphan cleanup / backups).
type ObjectInfo struct {
	Key          string
	Size         int64
	LastModified time.Time
}

// PresignedRequest is what the browser needs to upload directly to storage.
type PresignedRequest struct {
	URL     string            `json:"url"`
	Method  string            `json:"method"`
	Headers map[string]string `json:"headers"`
}

type Storage interface {
	// PresignPut returns a URL valid for ttl that accepts exactly one object of
	// the given content type and byte size at key.
	PresignPut(key, contentType string, size int64, ttl time.Duration) (PresignedRequest, error)
	// PresignGet returns a short-lived download URL, or "" if the driver wants
	// the API to stream the object itself (local driver).
	PresignGet(key string, ttl time.Duration) (string, error)
	Stat(ctx context.Context, key string) (int64, error)
	Open(ctx context.Context, key string) (io.ReadCloser, int64, error)
	Put(ctx context.Context, key, contentType string, data []byte) error
	Delete(ctx context.Context, key string) error
	// List returns every object whose key starts with prefix.
	List(ctx context.Context, prefix string) ([]ObjectInfo, error)
}

// ReadAll reads an object fully, refusing anything larger than max bytes.
func ReadAll(ctx context.Context, s Storage, key string, max int64) ([]byte, error) {
	rc, size, err := s.Open(ctx, key)
	if err != nil {
		return nil, err
	}
	defer rc.Close()
	if size > max {
		return nil, errTooLarge
	}
	b, err := io.ReadAll(io.LimitReader(rc, max+1))
	if err != nil {
		return nil, err
	}
	if int64(len(b)) > max {
		return nil, errTooLarge
	}
	return b, nil
}

var errTooLarge = errors.New("object too large")

func IsTooLarge(err error) bool { return errors.Is(err, errTooLarge) }
