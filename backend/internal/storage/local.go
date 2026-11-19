package storage

import (
	"context"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/nakhasolution/weedingnakha/backend/internal/fsutil"
	"github.com/nakhasolution/weedingnakha/backend/internal/security"
)

// LocalUploadPath is the API route the local driver's presigned PUTs point to.
const LocalUploadPath = "/api/storage/upload"

// Local stores objects in a private directory. It is meant for development
// and tests; production should use the S3 driver with a private bucket.
type Local struct {
	root   string
	signer *security.Signer
	now    func() time.Time
}

func NewLocal(root string, secret []byte, now func() time.Time) (*Local, error) {
	if err := os.MkdirAll(root, 0o700); err != nil {
		return nil, err
	}
	if now == nil {
		now = time.Now
	}
	return &Local{root: root, signer: security.NewSigner(secret, "local-storage-put"), now: now}, nil
}

func (l *Local) path(key string) (string, error) {
	if !ValidKey(key) {
		return "", ErrInvalidKey
	}
	return filepath.Join(l.root, filepath.FromSlash(key)), nil
}

func (l *Local) PresignPut(key, contentType string, size int64, ttl time.Duration) (PresignedRequest, error) {
	if !ValidKey(key) {
		return PresignedRequest{}, ErrInvalidKey
	}
	exp := strconv.FormatInt(l.now().Add(ttl).Unix(), 10)
	n := strconv.FormatInt(size, 10)
	q := url.Values{}
	q.Set("key", key)
	q.Set("ct", contentType)
	q.Set("len", n)
	q.Set("exp", exp)
	q.Set("sig", l.signer.MAC(key, contentType, n, exp))
	return PresignedRequest{
		URL:     LocalUploadPath + "?" + q.Encode(),
		Method:  http.MethodPut,
		Headers: map[string]string{"Content-Type": contentType},
	}, nil
}

// HandleUpload implements the receiving side of PresignPut. It enforces the
// signature, expiry, content type and exact byte length that were signed.
func (l *Local) HandleUpload(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	key, ct, n, exp, sig := q.Get("key"), q.Get("ct"), q.Get("len"), q.Get("exp"), q.Get("sig")
	if !l.signer.CheckMAC(sig, key, ct, n, exp) {
		http.Error(w, "invalid signature", http.StatusForbidden)
		return
	}
	expUnix, err1 := strconv.ParseInt(exp, 10, 64)
	size, err2 := strconv.ParseInt(n, 10, 64)
	if err1 != nil || err2 != nil || l.now().Unix() > expUnix {
		http.Error(w, "upload URL expired", http.StatusForbidden)
		return
	}
	if r.Header.Get("Content-Type") != ct {
		http.Error(w, "content type mismatch", http.StatusBadRequest)
		return
	}
	if r.ContentLength != size {
		http.Error(w, "content length mismatch", http.StatusBadRequest)
		return
	}
	p, err := l.path(key)
	if err != nil {
		http.Error(w, "invalid key", http.StatusBadRequest)
		return
	}
	body := http.MaxBytesReader(w, r.Body, size)
	data, err := io.ReadAll(body)
	if err != nil || int64(len(data)) != size {
		http.Error(w, "upload incomplete", http.StatusBadRequest)
		return
	}
	if err := l.write(p, data); err != nil {
		http.Error(w, "storage error", http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusOK)
}

func (l *Local) write(p string, data []byte) error {
	return fsutil.WriteFileAtomic(p, data, 0o600)
}

func (l *Local) List(_ context.Context, prefix string) ([]ObjectInfo, error) {
	var out []ObjectInfo
	err := filepath.WalkDir(l.root, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			if errors.Is(err, os.ErrNotExist) {
				return nil
			}
			return err
		}
		if d.IsDir() || strings.HasPrefix(d.Name(), ".") {
			return nil
		}
		rel, err := filepath.Rel(l.root, p)
		if err != nil {
			return nil
		}
		key := filepath.ToSlash(rel)
		if !strings.HasPrefix(key, prefix) {
			return nil
		}
		info, err := d.Info()
		if err != nil {
			return nil
		}
		out = append(out, ObjectInfo{Key: key, Size: info.Size(), LastModified: info.ModTime()})
		return nil
	})
	return out, err
}

func (l *Local) PresignGet(string, time.Duration) (string, error) { return "", nil }

func (l *Local) Stat(_ context.Context, key string) (int64, error) {
	p, err := l.path(key)
	if err != nil {
		return 0, err
	}
	st, err := os.Stat(p)
	if errors.Is(err, os.ErrNotExist) {
		return 0, ErrNotFound
	}
	if err != nil {
		return 0, err
	}
	return st.Size(), nil
}

func (l *Local) Open(_ context.Context, key string) (io.ReadCloser, int64, error) {
	p, err := l.path(key)
	if err != nil {
		return nil, 0, err
	}
	f, err := os.Open(p)
	if errors.Is(err, os.ErrNotExist) {
		return nil, 0, ErrNotFound
	}
	if err != nil {
		return nil, 0, err
	}
	st, err := f.Stat()
	if err != nil {
		f.Close()
		return nil, 0, err
	}
	return f, st.Size(), nil
}

func (l *Local) Put(_ context.Context, key, _ string, data []byte) error {
	p, err := l.path(key)
	if err != nil {
		return err
	}
	return l.write(p, data)
}

func (l *Local) Delete(_ context.Context, key string) error {
	p, err := l.path(key)
	if err != nil {
		return err
	}
	if err := os.Remove(p); err != nil && !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("delete %s: %w", key, err)
	}
	return nil
}
