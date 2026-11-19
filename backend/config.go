package main

import (
	"bufio"
	"encoding/base64"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// appConfig is everything main needs, parsed and validated from the
// environment. loadConfig is pure (env + probes injected) so the production
// rules are unit-tested.
type appConfig struct {
	Production   bool
	DataDir      string
	AdminPIN     string
	AdminPath    string // secret URL segment of the admin console; "" = admin disabled
	Secret       []byte
	CookieSecure bool
	Storage      string // local | s3
	S3           s3Env
	MaxUploadMB  int

	BackupKey      []byte
	BackupS3       s3Env // Bucket == "" → no remote target
	BackupDir      string
	BackupRetain   int
	BackupInterval time.Duration

	Warnings []string
}

type s3Env struct{ Endpoint, Region, Bucket, AccessKeyID, SecretAccessKey string }

// probes abstracts filesystem facts so tests can simulate containers.
type probes struct {
	InContainer      func() bool
	PersistentVolume func(dir string) bool
}

func defaultProbes() probes {
	return probes{InContainer: inContainer, PersistentVolume: isSeparateMount}
}

func loadConfig(getenv func(string) string, pr probes) (appConfig, error) {
	get := func(k, def string) string {
		if v := strings.TrimSpace(getenv(k)); v != "" {
			return v
		}
		return def
	}
	geti := func(k string, def int) int {
		n, err := strconv.Atoi(get(k, strconv.Itoa(def)))
		if err != nil || n <= 0 {
			return def
		}
		return n
	}
	c := appConfig{
		Production:   get("APP_ENV", "development") == "production",
		DataDir:      get("DATA_DIR", "./data"),
		AdminPIN:     get("ADMIN_PIN", "123456"),
		Secret:       []byte(getenv("APP_SECRET")),
		Storage:      get("STORAGE_DRIVER", "local"),
		MaxUploadMB:  min(geti("MAX_UPLOAD_MB", 10), 10),
		BackupDir:    get("BACKUP_DIR", ""),
		BackupRetain: geti("BACKUP_RETENTION", 28),
	}
	c.BackupInterval = time.Duration(geti("BACKUP_INTERVAL_HOURS", 6)) * time.Hour

	var problems []string
	fail := func(msg string) { problems = append(problems, msg) }
	warn := func(msg string) { c.Warnings = append(c.Warnings, msg) }
	strict := func(msg string) {
		if c.Production {
			fail(msg)
		} else {
			warn(msg)
		}
	}

	switch strings.ToLower(get("COOKIE_SECURE", "true")) {
	case "1", "true", "yes", "on":
		c.CookieSecure = true
	case "0", "false", "no", "off":
		c.CookieSecure = false
	default:
		fail("COOKIE_SECURE harus true atau false")
	}
	if !c.CookieSecure && c.Production {
		fail("COOKIE_SECURE=false tidak diizinkan saat APP_ENV=production")
	}

	if c.AdminPIN == "123456" || len(c.AdminPIN) < 6 {
		strict("ADMIN_PIN masih default/lemah (minimal 6 karakter, bukan 123456)")
	}
	c.AdminPath = getenv("ADMIN_PATH")
	switch {
	case c.AdminPath == "":
		warn("ADMIN_PATH kosong: halaman & API admin dinonaktifkan")
	case !adminPathRe.MatchString(c.AdminPath) || reservedPaths[strings.ToLower(c.AdminPath)]:
		fail("ADMIN_PATH harus 16–64 karakter acak [A-Za-z0-9_-] (openssl rand -hex 12)")
	}
	if len(c.Secret) < 32 {
		strict("APP_SECRET kosong/pendek (minimal 32 karakter acak)")
	}

	c.S3 = s3Env{
		Endpoint: getenv("S3_ENDPOINT"), Region: get("S3_REGION", "auto"), Bucket: getenv("S3_BUCKET"),
		AccessKeyID: getenv("S3_ACCESS_KEY_ID"), SecretAccessKey: getenv("S3_SECRET_ACCESS_KEY"),
	}
	switch c.Storage {
	case "s3", "r2":
		c.Storage = "s3"
	case "local":
		// Photo binaries must live only in private R2/S3 storage in production.
		strict("STORAGE_DRIVER=local: foto wajib disimpan di bucket privat R2/S3 (STORAGE_DRIVER=s3)")
	default:
		fail("STORAGE_DRIVER harus local atau s3")
	}

	// Data must be on a persistent volume, never only in a container's writable layer.
	if pr.InContainer() && !pr.PersistentVolume(c.DataDir) {
		strict(fmt.Sprintf("DATA_DIR=%s bukan volume persisten (berjalan di container): mount volume/bind mount ke path ini", c.DataDir))
	}

	// Backups: encrypted, rotating, off-server.
	if k := getenv("BACKUP_ENCRYPTION_KEY"); k != "" {
		key, err := decodeKey(k)
		if err != nil {
			fail("BACKUP_ENCRYPTION_KEY harus base64 dari tepat 32 byte (openssl rand -base64 32)")
		}
		c.BackupKey = key
	}
	c.BackupS3 = s3Env{
		Endpoint:        get("BACKUP_S3_ENDPOINT", c.S3.Endpoint),
		Region:          get("BACKUP_S3_REGION", c.S3.Region),
		Bucket:          getenv("BACKUP_S3_BUCKET"),
		AccessKeyID:     get("BACKUP_S3_ACCESS_KEY_ID", c.S3.AccessKeyID),
		SecretAccessKey: get("BACKUP_S3_SECRET_ACCESS_KEY", c.S3.SecretAccessKey),
	}
	hasTarget := c.BackupS3.Bucket != "" || c.BackupDir != ""
	switch {
	case c.BackupS3.Bucket == "":
		strict("BACKUP_S3_BUCKET belum diisi: backup off-server terenkripsi wajib di production")
	case c.BackupS3.Bucket == c.S3.Bucket:
		warn("BACKUP_S3_BUCKET sama dengan S3_BUCKET; disarankan bucket terpisah (dengan versioning/object lock)")
	}
	if hasTarget && c.BackupKey == nil {
		fail("BACKUP_ENCRYPTION_KEY wajib diisi jika backup diaktifkan")
	}
	if c.BackupRetain < 2 {
		c.BackupRetain = 2
	}

	if len(problems) > 0 {
		return c, errors.New("konfigurasi ditolak:\n  - " + strings.Join(problems, "\n  - "))
	}
	return c, nil
}

var adminPathRe = regexp.MustCompile(`^[A-Za-z0-9_-]{16,64}$`)

// reservedPaths are top-level routes the admin path must not shadow.
var reservedPaths = map[string]bool{"admin": true, "api": true, "host": true, "gallery": true, "photobooth": true,
	"slideshow": true, "upload": true, "qr": true, "uploads": true, "_next": true}

func decodeKey(s string) ([]byte, error) {
	for _, enc := range []*base64.Encoding{base64.StdEncoding, base64.RawStdEncoding, base64.URLEncoding, base64.RawURLEncoding} {
		if b, err := enc.DecodeString(strings.TrimSpace(s)); err == nil && len(b) == 32 {
			return b, nil
		}
	}
	return nil, errors.New("invalid key")
}

// inContainer detects Docker/Podman/Kubernetes.
func inContainer() bool {
	for _, f := range []string{"/.dockerenv", "/run/.containerenv"} {
		if _, err := os.Stat(f); err == nil {
			return true
		}
	}
	if os.Getenv("KUBERNETES_SERVICE_HOST") != "" {
		return true
	}
	b, err := os.ReadFile("/proc/1/cgroup")
	return err == nil && (strings.Contains(string(b), "docker") || strings.Contains(string(b), "kubepods") || strings.Contains(string(b), "containerd"))
}

// isSeparateMount reports whether dir lives on its own mount (a volume or
// bind mount) rather than on the container's root filesystem. Outside Linux
// (no /proc/self/mountinfo) it returns true: there is no container layer.
func isSeparateMount(dir string) bool {
	abs, err := filepath.Abs(dir)
	if err != nil {
		return false
	}
	if real, err := filepath.EvalSymlinks(abs); err == nil {
		abs = real
	}
	f, err := os.Open("/proc/self/mountinfo")
	if err != nil {
		return true
	}
	defer f.Close()
	best := ""
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		fields := strings.Fields(sc.Text())
		if len(fields) < 5 {
			continue
		}
		mp := strings.ReplaceAll(fields[4], `\040`, " ")
		if (abs == mp || strings.HasPrefix(abs, strings.TrimSuffix(mp, "/")+"/")) && len(mp) > len(best) {
			best = mp
		}
	}
	return best != "" && best != "/"
}
