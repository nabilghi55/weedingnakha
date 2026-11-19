// Package backup creates rotating, encrypted, off-server backups of the JSON
// data (event files, global file, audit log).
//
// Each run takes a consistent in-memory snapshot (every event file exactly as
// last fsynced), packs it as tar.gz, encrypts it with AES-256-GCM and uploads
// it to a separate S3-compatible bucket. The newest Retain backups are kept,
// older ones are deleted. Photos are not included: they already live in R2
// (enable bucket versioning / replication there).
package backup

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"errors"
	"fmt"
	"io"
	"log"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/nakhasolution/weedingnakha/backend/internal/fsutil"
	"github.com/nakhasolution/weedingnakha/backend/internal/storage"
)

// KeyPattern is the only key shape the backup client may write/delete.
var KeyPattern = regexp.MustCompile(`^backups/nakha-\d{8}T\d{6}Z\.tar\.gz\.enc$`)

const magic = "NKBK1\n"

// Target is where encrypted archives go.
type Target interface {
	Put(ctx context.Context, key, contentType string, data []byte) error
	List(ctx context.Context, prefix string) ([]storage.ObjectInfo, error)
	Delete(ctx context.Context, key string) error
	// OffServer reports whether data leaves this machine.
	OffServer() bool
}

// S3Target stores backups in an S3/R2 bucket (off-server).
type S3Target struct{ *storage.S3 }

func (S3Target) OffServer() bool { return true }

// NewS3Target builds a backup client restricted to KeyPattern.
func NewS3Target(cfg storage.S3Config) (S3Target, error) {
	cfg.KeyPattern = KeyPattern
	s, err := storage.NewS3(cfg, nil)
	return S3Target{s}, err
}

// DirTarget writes backups to a local directory (development only — it is
// not off-server).
type DirTarget struct{ Dir string }

func (DirTarget) OffServer() bool { return false }

func (t DirTarget) Put(_ context.Context, key, _ string, data []byte) error {
	if !KeyPattern.MatchString(key) {
		return storage.ErrInvalidKey
	}
	return fsutil.WriteFileAtomic(filepath.Join(t.Dir, filepath.Base(key)), data, 0o600)
}

func (t DirTarget) List(_ context.Context, _ string) ([]storage.ObjectInfo, error) {
	matches, err := filepath.Glob(filepath.Join(t.Dir, "nakha-*.tar.gz.enc"))
	var out []storage.ObjectInfo
	for _, m := range matches {
		out = append(out, storage.ObjectInfo{Key: "backups/" + filepath.Base(m)})
	}
	return out, err
}

func (t DirTarget) Delete(_ context.Context, key string) error {
	if !KeyPattern.MatchString(key) {
		return storage.ErrInvalidKey
	}
	err := os.Remove(filepath.Join(t.Dir, filepath.Base(key)))
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	return err
}

type Config struct {
	Key      []byte        // 32 bytes (AES-256)
	Retain   int           // number of versions to keep (≥ 2)
	Interval time.Duration // between runs
}

type Backup struct {
	cfg      Config
	target   Target
	snapshot func() map[string][]byte
	now      func() time.Time
}

func New(cfg Config, target Target, snapshot func() map[string][]byte, now func() time.Time) (*Backup, error) {
	if len(cfg.Key) != 32 {
		return nil, errors.New("backup key must be 32 bytes")
	}
	if cfg.Retain < 2 {
		cfg.Retain = 2
	}
	if cfg.Interval <= 0 {
		cfg.Interval = 6 * time.Hour
	}
	if now == nil {
		now = time.Now
	}
	return &Backup{cfg: cfg, target: target, snapshot: snapshot, now: now}, nil
}

// RunOnce writes one encrypted backup and prunes old versions.
func (b *Backup) RunOnce(ctx context.Context) (string, error) {
	archive, err := pack(b.snapshot(), b.now())
	if err != nil {
		return "", err
	}
	enc, err := Encrypt(b.cfg.Key, archive)
	if err != nil {
		return "", err
	}
	key := "backups/nakha-" + b.now().UTC().Format("20060102T150405Z") + ".tar.gz.enc"
	if err := b.target.Put(ctx, key, "application/octet-stream", enc); err != nil {
		return "", fmt.Errorf("upload backup: %w", err)
	}
	if err := b.prune(ctx); err != nil {
		return key, fmt.Errorf("prune backups: %w", err)
	}
	return key, nil
}

func (b *Backup) prune(ctx context.Context) error {
	objs, err := b.target.List(ctx, "backups/")
	if err != nil {
		return err
	}
	var keys []string
	for _, o := range objs {
		if KeyPattern.MatchString(o.Key) {
			keys = append(keys, o.Key)
		}
	}
	sort.Strings(keys) // timestamped names sort chronologically
	for len(keys) > b.cfg.Retain {
		if err := b.target.Delete(ctx, keys[0]); err != nil {
			return err
		}
		keys = keys[1:]
	}
	return nil
}

// Loop runs a backup immediately and then every Interval until ctx ends.
func (b *Backup) Loop(ctx context.Context) {
	run := func() {
		rctx, cancel := context.WithTimeout(ctx, 5*time.Minute)
		defer cancel()
		if key, err := b.RunOnce(rctx); err != nil {
			log.Printf("BACKUP FAILED: %v", err)
		} else {
			log.Printf("backup ok: %s", key)
		}
	}
	run()
	t := time.NewTicker(b.cfg.Interval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			run()
		}
	}
}

func pack(files map[string][]byte, now time.Time) ([]byte, error) {
	var buf bytes.Buffer
	gz := gzip.NewWriter(&buf)
	tw := tar.NewWriter(gz)
	names := make([]string, 0, len(files))
	for n := range files {
		names = append(names, n)
	}
	sort.Strings(names)
	for _, n := range names {
		if strings.Contains(n, "..") || strings.HasPrefix(n, "/") {
			return nil, fmt.Errorf("unsafe path %q", n)
		}
		data := files[n]
		if err := tw.WriteHeader(&tar.Header{Name: n, Mode: 0o600, Size: int64(len(data)), ModTime: now}); err != nil {
			return nil, err
		}
		if _, err := tw.Write(data); err != nil {
			return nil, err
		}
	}
	if err := tw.Close(); err != nil {
		return nil, err
	}
	if err := gz.Close(); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

// Encrypt seals plain with AES-256-GCM: magic | nonce(12) | ciphertext+tag.
func Encrypt(key, plain []byte) ([]byte, error) {
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	nonce := make([]byte, gcm.NonceSize())
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return nil, err
	}
	out := append([]byte(magic), nonce...)
	return gcm.Seal(out, nonce, plain, []byte(magic)), nil
}

// Decrypt reverses Encrypt (used by `server decrypt-backup`).
func Decrypt(key, data []byte) ([]byte, error) {
	if !bytes.HasPrefix(data, []byte(magic)) {
		return nil, errors.New("not a Nakha backup file")
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	rest := data[len(magic):]
	if len(rest) < gcm.NonceSize() {
		return nil, errors.New("backup file truncated")
	}
	plain, err := gcm.Open(nil, rest[:gcm.NonceSize()], rest[gcm.NonceSize():], []byte(magic))
	if err != nil {
		return nil, errors.New("wrong key or corrupted backup")
	}
	return plain, nil
}
