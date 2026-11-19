package backup

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"io"
	"path/filepath"
	"testing"
	"time"
)

func TestEncryptDecrypt(t *testing.T) {
	key := bytes.Repeat([]byte{7}, 32)
	enc, err := Encrypt(key, []byte("secret data"))
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(enc, []byte("secret data")) {
		t.Fatal("plaintext visible")
	}
	if got, err := Decrypt(key, enc); err != nil || string(got) != "secret data" {
		t.Fatalf("roundtrip: %q %v", got, err)
	}
	if _, err := Decrypt(bytes.Repeat([]byte{8}, 32), enc); err == nil {
		t.Fatal("wrong key accepted")
	}
	enc[len(enc)-1] ^= 1
	if _, err := Decrypt(key, enc); err == nil {
		t.Fatal("tampered backup accepted")
	}
}

func TestRotatingBackups(t *testing.T) {
	dir := t.TempDir()
	key := bytes.Repeat([]byte{1}, 32)
	clock := time.Date(2026, 12, 12, 0, 0, 0, 0, time.UTC)
	files := map[string][]byte{"db/global.json": []byte(`{}`), "db/events/aaaaaaaaaaaaaaaa.json": []byte(`{"event":{}}`)}
	b, err := New(Config{Key: key, Retain: 3}, DirTarget{Dir: dir}, func() map[string][]byte { return files }, func() time.Time { return clock })
	if err != nil {
		t.Fatal(err)
	}
	var last string
	for i := 0; i < 5; i++ {
		if last, err = b.RunOnce(context.Background()); err != nil {
			t.Fatal(err)
		}
		clock = clock.Add(time.Hour)
	}
	left, _ := filepath.Glob(filepath.Join(dir, "nakha-*.tar.gz.enc"))
	if len(left) != 3 {
		t.Fatalf("kept %d versions, want 3", len(left))
	}
	// newest backup decrypts to a tar.gz with every file
	data, _ := readFile(filepath.Join(dir, filepath.Base(last)))
	plain, err := Decrypt(key, data)
	if err != nil {
		t.Fatal(err)
	}
	gz, _ := gzip.NewReader(bytes.NewReader(plain))
	tr := tar.NewReader(gz)
	seen := map[string]string{}
	for {
		h, err := tr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			t.Fatal(err)
		}
		b, _ := io.ReadAll(tr)
		seen[h.Name] = string(b)
	}
	if seen["db/events/aaaaaaaaaaaaaaaa.json"] != `{"event":{}}` || len(seen) != 2 {
		t.Fatalf("archive contents: %v", seen)
	}
}
