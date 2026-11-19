// Command server runs the Nakha Wedding API. See .env.example and
// ../docs/SECURITY.md for every environment variable.
//
//	server                          run the API
//	server backup-now               write one encrypted backup and exit
//	server decrypt-backup IN OUT    decrypt a backup to a .tar.gz (needs BACKUP_ENCRYPTION_KEY)
package main

import (
	"context"
	"crypto/rand"
	"errors"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"
	_ "time/tzdata" // embed tz database so EVENT_TIMEZONE works on minimal hosts

	"github.com/nakhasolution/weedingnakha/backend/internal/audit"
	"github.com/nakhasolution/weedingnakha/backend/internal/backup"
	"github.com/nakhasolution/weedingnakha/backend/internal/server"
	"github.com/nakhasolution/weedingnakha/backend/internal/storage"
	"github.com/nakhasolution/weedingnakha/backend/internal/store"
)

func env(key, def string) string {
	if v := strings.TrimSpace(os.Getenv(key)); v != "" {
		return v
	}
	return def
}

func main() {
	if len(os.Args) > 1 && os.Args[1] == "decrypt-backup" {
		decryptBackup(os.Args[2:])
		return
	}

	cfg, err := loadConfig(os.Getenv, defaultProbes())
	for _, w := range cfg.Warnings {
		log.Printf("WARNING: %s", w)
	}
	if err != nil {
		log.Fatal(err)
	}
	if err := os.MkdirAll(cfg.DataDir, 0o700); err != nil {
		log.Fatalf("create data dir: %v", err)
	}
	if tz, err := time.LoadLocation(env("EVENT_TIMEZONE", "Asia/Jakarta")); err == nil {
		store.EventLocation = tz
	} else {
		log.Printf("WARNING: EVENT_TIMEZONE tidak dikenal, memakai WIB (UTC+7)")
	}
	if len(cfg.Secret) < 32 { // development only (production refused above)
		cfg.Secret = make([]byte, 32)
		_, _ = rand.Read(cfg.Secret)
	}

	st, err := store.Open(cfg.DataDir, nil)
	if err != nil {
		log.Fatalf("open store: %v", err)
	}
	auditLog := audit.Open(filepath.Join(cfg.DataDir, "audit.log"), nil)

	var stg storage.Storage
	if cfg.Storage == "s3" {
		stg, err = storage.NewS3(storage.S3Config{
			Endpoint: cfg.S3.Endpoint, Region: cfg.S3.Region, Bucket: cfg.S3.Bucket,
			AccessKeyID: cfg.S3.AccessKeyID, SecretAccessKey: cfg.S3.SecretAccessKey,
		}, nil)
	} else {
		stg, err = storage.NewLocal(filepath.Join(cfg.DataDir, "objects"), cfg.Secret, nil)
	}
	if err != nil {
		log.Fatalf("storage: %v", err)
	}

	bk := newBackup(cfg, st, auditLog)
	if len(os.Args) > 1 && os.Args[1] == "backup-now" {
		if bk == nil {
			log.Fatal("backup belum dikonfigurasi (BACKUP_S3_BUCKET/BACKUP_DIR + BACKUP_ENCRYPTION_KEY)")
		}
		key, err := bk.RunOnce(context.Background())
		if err != nil {
			log.Fatal(err)
		}
		fmt.Println("backup ok:", key)
		return
	}

	envInt := func(k string, def int) int {
		var n int
		if _, err := fmt.Sscan(env(k, fmt.Sprint(def)), &n); err != nil || n <= 0 {
			return def
		}
		return n
	}
	srv := server.New(server.Config{
		AdminPIN:            cfg.AdminPIN,
		AdminPath:           cfg.AdminPath,
		Secret:              cfg.Secret,
		AllowedOrigins:      strings.Split(env("ALLOWED_ORIGINS", "http://localhost:3000"), ","),
		MaxUploadBytes:      int64(cfg.MaxUploadMB) << 20,
		StaticDir:           os.Getenv("STATIC_DIR"),
		PublicBaseURL:       os.Getenv("PUBLIC_BASE_URL"),
		CookieSecure:        cfg.CookieSecure,
		TrustProxy:          env("TRUST_PROXY", "false") == "true",
		LegacyUploadDir:     filepath.Join(cfg.DataDir, "uploads"),
		WindowBefore:        time.Duration(envInt("EVENT_WINDOW_BEFORE_MINUTES", 60)) * time.Minute,
		WindowAfter:         time.Duration(envInt("EVENT_WINDOW_AFTER_MINUTES", 60)) * time.Minute,
		MaxGPSAccuracyM:     float64(envInt("MAX_GPS_ACCURACY_METERS", 100)),
		LocationMaxAge:      time.Duration(envInt("LOCATION_RECHECK_MINUTES", 10)) * time.Minute,
		GeofenceOff:         env("REQUIRE_LOCATION", "false") != "true",
		HostSessionTTL:      time.Duration(envInt("HOST_SESSION_HOURS", 24)) * time.Hour,
		OrphanSweepInterval: time.Duration(envInt("ORPHAN_SWEEP_HOURS", 6)) * time.Hour,
	}, st, stg, auditLog)

	// Cancelled on shutdown so SSE streams, the janitor and backups end promptly.
	baseCtx, cancelBase := context.WithCancel(context.Background())
	srv.Start(baseCtx)
	if bk != nil {
		go bk.Loop(baseCtx)
	}

	httpSrv := &http.Server{
		Addr:              os.Getenv("HOST") + ":" + env("PORT", "8080"),
		Handler:           srv.Handler(),
		ReadHeaderTimeout: 10 * time.Second,
		BaseContext:       func(net.Listener) context.Context { return baseCtx },
	}
	go func() {
		log.Printf("Nakha Wedding API listening on %s (data: %s, storage: %s)", httpSrv.Addr, cfg.DataDir, cfg.Storage)
		if cfg.AdminPath != "" && !cfg.Production {
			log.Printf("admin (dev): %s/%s/", strings.TrimRight(env("PUBLIC_BASE_URL", "http://localhost:3000"), "/"), cfg.AdminPath)
		}
		if err := httpSrv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Fatalf("listen: %v", err)
		}
	}()

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, os.Interrupt, syscall.SIGTERM)
	<-stop
	log.Println("shutting down...")
	cancelBase()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_ = httpSrv.Shutdown(ctx)
	if bk != nil {
		// final backup so the latest state is off-server after a planned stop
		bctx, bcancel := context.WithTimeout(context.Background(), 30*time.Second)
		if key, err := bk.RunOnce(bctx); err != nil {
			log.Printf("BACKUP FAILED on shutdown: %v", err)
		} else {
			log.Printf("backup ok: %s", key)
		}
		bcancel()
	}
}

func newBackup(cfg appConfig, st *store.Store, auditLog *audit.Log) *backup.Backup {
	var target backup.Target
	switch {
	case cfg.BackupS3.Bucket != "":
		t, err := backup.NewS3Target(storage.S3Config{
			Endpoint: cfg.BackupS3.Endpoint, Region: cfg.BackupS3.Region, Bucket: cfg.BackupS3.Bucket,
			AccessKeyID: cfg.BackupS3.AccessKeyID, SecretAccessKey: cfg.BackupS3.SecretAccessKey,
		})
		if err != nil {
			log.Fatalf("backup target: %v", err)
		}
		target = t
	case cfg.BackupDir != "":
		log.Printf("WARNING: BACKUP_DIR=%s adalah backup lokal (bukan off-server) — hanya untuk development", cfg.BackupDir)
		target = backup.DirTarget{Dir: cfg.BackupDir}
	default:
		return nil
	}
	snapshot := func() map[string][]byte {
		files := st.Snapshot()
		files["audit.log"] = auditLog.Snapshot()
		return files
	}
	b, err := backup.New(backup.Config{Key: cfg.BackupKey, Retain: cfg.BackupRetain, Interval: cfg.BackupInterval}, target, snapshot, nil)
	if err != nil {
		log.Fatalf("backup: %v", err)
	}
	return b
}

func decryptBackup(args []string) {
	if len(args) != 2 {
		log.Fatal("usage: server decrypt-backup <in.tar.gz.enc> <out.tar.gz>")
	}
	key, err := decodeKey(os.Getenv("BACKUP_ENCRYPTION_KEY"))
	if err != nil {
		log.Fatal("BACKUP_ENCRYPTION_KEY tidak valid")
	}
	data, err := os.ReadFile(args[0])
	if err != nil {
		log.Fatal(err)
	}
	plain, err := backup.Decrypt(key, data)
	if err != nil {
		log.Fatal(err)
	}
	if err := os.WriteFile(args[1], plain, 0o600); err != nil {
		log.Fatal(err)
	}
	fmt.Printf("ok: %s (ekstrak dengan: tar -xzf %s -C <DATA_DIR baru>)\n", args[1], args[1])
}
