package main

import (
	"strings"
	"testing"
)

func envMap(m map[string]string) func(string) string { return func(k string) string { return m[k] } }

var noContainer = probes{InContainer: func() bool { return false }, PersistentVolume: func(string) bool { return true }}

func goodProd() map[string]string {
	return map[string]string{
		"APP_ENV": "production", "ADMIN_PIN": "a-long-admin-pin", "ADMIN_PATH": "kelola-0123456789abcdef", "APP_SECRET": strings.Repeat("s", 40),
		"COOKIE_SECURE": "true", "STORAGE_DRIVER": "s3",
		"S3_ENDPOINT": "https://x.r2.cloudflarestorage.com", "S3_BUCKET": "photos", "S3_ACCESS_KEY_ID": "a", "S3_SECRET_ACCESS_KEY": "b",
		"BACKUP_S3_BUCKET": "backups", "BACKUP_ENCRYPTION_KEY": "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=",
	}
}

func TestProductionConfigAccepted(t *testing.T) {
	if _, err := loadConfig(envMap(goodProd()), noContainer); err != nil {
		t.Fatal(err)
	}
}

func TestProductionRefusals(t *testing.T) {
	cases := map[string]func(m map[string]string){
		"COOKIE_SECURE=false":   func(m map[string]string) { m["COOKIE_SECURE"] = "false" },
		"STORAGE_DRIVER":        func(m map[string]string) { m["STORAGE_DRIVER"] = "local" },
		"BACKUP_S3_BUCKET":      func(m map[string]string) { delete(m, "BACKUP_S3_BUCKET") },
		"BACKUP_ENCRYPTION_KEY": func(m map[string]string) { delete(m, "BACKUP_ENCRYPTION_KEY") },
		"ADMIN_PIN":             func(m map[string]string) { m["ADMIN_PIN"] = "123456" },
		"APP_SECRET":            func(m map[string]string) { m["APP_SECRET"] = "short" },
		"ADMIN_PATH":            func(m map[string]string) { m["ADMIN_PATH"] = "admin" },
	}
	for want, mutate := range cases {
		m := goodProd()
		mutate(m)
		_, err := loadConfig(envMap(m), noContainer)
		if err == nil || !strings.Contains(err.Error(), want) {
			t.Fatalf("%s: expected refusal, got %v", want, err)
		}
	}
	bad := goodProd()
	bad["BACKUP_ENCRYPTION_KEY"] = "dG9vLXNob3J0"
	if _, err := loadConfig(envMap(bad), noContainer); err == nil {
		t.Fatal("short backup key accepted")
	}
}

func TestProductionRefusesEphemeralContainerData(t *testing.T) {
	ephemeral := probes{InContainer: func() bool { return true }, PersistentVolume: func(string) bool { return false }}
	if _, err := loadConfig(envMap(goodProd()), ephemeral); err == nil || !strings.Contains(err.Error(), "volume") {
		t.Fatalf("expected refusal, got %v", err)
	}
	mounted := probes{InContainer: func() bool { return true }, PersistentVolume: func(string) bool { return true }}
	if _, err := loadConfig(envMap(goodProd()), mounted); err != nil {
		t.Fatal(err)
	}
}

func TestDevelopmentOnlyWarns(t *testing.T) {
	c, err := loadConfig(envMap(map[string]string{"COOKIE_SECURE": "false"}), noContainer)
	if err != nil {
		t.Fatal(err)
	}
	if len(c.Warnings) == 0 {
		t.Fatal("expected warnings in development")
	}
}
