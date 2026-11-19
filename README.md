# Nakha Wedding

Photobooth pernikahan digital + galeri foto live + layar proyektor, multi-event (tanpa halaman undangan).
Desain editorial terang/gelap (gaya GoSinema): tanpa foto stok, isi foto sampul asli lewat Admin → Pengaturan.

- **Frontend**: Next.js 16 (`src/`)
- **Backend**: Go, tanpa dependency eksternal (`backend/`): event, host access, photobooth check-in (QR cetak +
  geofence), kuota 5 foto/perangkat, storage privat R2/S3, worker gambar, moderasi, audit log, SSE,
  file JSON per event (atomic + fsync), orphan sweep, backup terenkripsi berotasi

Model keamanan lengkap (alur, skema, endpoint, keterbatasan): **[docs/SECURITY.md](docs/SECURITY.md)**.

## Menjalankan di lokal

Butuh Node 20+ dan Go 1.23+. Jalankan di dua terminal:

```bash
# 1. API Go → http://localhost:8080
cd backend
cp .env.example .env            # isi ADMIN_PIN & APP_SECRET (openssl rand -base64 48)
set -a && source .env && set +a
go run .

# 2. Website → http://localhost:3000
npm install
npm run dev
```

Next.js mem-proxy `/api/*` dan `/host/access` ke Go (lihat `next.config.ts`), jadi browser hanya melihat satu origin
dan cookie sesi HttpOnly bekerja. Untuk lokal, `COOKIE_SECURE=false` (Safari tidak mengirim cookie Secure lewat http).

### Mencoba alur lengkap

1. Buka link admin rahasia `http://localhost:3000/<ADMIN_PATH>/` (dicetak di log Go saat start), login PIN → **Acara baru** (isi nama, jadwal, lokasi — tombol “Pakai lokasi saya”).
   Link akses tuan rumah tampil **sekali** di tab *Akses & QR* — salin.
2. Tab *Pengaturan* → status **Aktif** → simpan. Photobooth terbuka 60 menit sebelum mulai s.d. 60 menit setelah selesai.
3. Buka link akses tuan rumah (`/host/access?token=…`) → diarahkan ke `/host` tanpa token di URL.
4. Di `/host` → *QR & Layar*: scan QR dari HP (HP harus di dalam radius; untuk tes di laptop, Chrome DevTools →
   *Sensors* → set lokasi). Kamera & geolocation di HP butuh HTTPS — pakai tunnel (mis. `cloudflared`) atau deploy.
5. Kirim foto: counter “x dari 5 foto telah dikirim”; foto ke-6 ditolak server.

### Test otomatis

```bash
cd backend && go test -race ./...
```

Mencakup: tamu di luar radius ditolak, event belum aktif/sudah selesai ditolak, QR palsu/diganti ditolak, QR cetak hanya berlaku di jendela acara, check-in
sukses, 5 upload sukses & ke-6 ditolak, 10 authorize bersamaan tetap maks 5, isolasi event A/B, host token yang
di-revoke tidak bisa akses, foto privat butuh signed URL valid (hide langsung memutus akses), `/api/photos` lama
mati (410), pause menolak upload baru, plus expiry reservasi, dedup, lokasi basi, approval manual, rate limit,
strip EXIF, migrasi v1→v2, dan presign S3.

## Halaman

| Path | Fungsi |
| --- | --- |
| `/` | Langsung diarahkan ke `/photobooth` (tidak ada halaman undangan) |
| `/photobooth` | **Satu-satunya jalur kirim foto.** Dibuka via QR (boleh dicetak) → izin lokasi → kamera, bingkai, filter → kirim (maks 5) |
| `/gallery` | Galeri live event (sesuai visibilitas: tamu check-in / publik / privat) |
| `/upload` | Halaman info: upload hanya lewat Photobooth (tanpa file picker) |
| `/slideshow` | Live Wall proyektor — hanya via link read-only `/slideshow/?k=…` dari host/admin |
| `/host` | Dashboard tuan rumah: statistik, foto (approve/hide/restore/hapus), QR aktif, link Live Wall, pause/resume, mode publikasi, radius & titik lokasi |
| `/qr` | Kartu QR layar penuh + unduh PNG cetak / video (khusus host; QR tetap, bisa dicetak) |
| `/<ADMIN_PATH>/` | **Admin, di link rahasia** (`/admin` = 404; tanpa kunci ini semua `/api/admin/*` juga 404). Multi-event: buat event, host token (buat ulang/cabut), jadwal, lokasi, status, moderasi, tema, sampul, audit log |

## Konfigurasi

Semua variabel backend + penjelasan: [`backend/.env.example`](backend/.env.example). Frontend: [`.env.example`](.env.example).

Production (`APP_ENV=production`) **menolak start** kecuali: `ADMIN_PIN` kuat, `ADMIN_PATH` valid (kosong = admin mati), `APP_SECRET` ≥ 32 karakter,
`COOKIE_SECURE=true`, `STORAGE_DRIVER=s3` + kredensial R2 (bucket privat + CORS PUT dari domain Anda),
backup off-server terenkripsi (`BACKUP_S3_BUCKET` + `BACKUP_ENCRYPTION_KEY`), dan — jika di container — `DATA_DIR`
berupa volume persisten. Juga set `PUBLIC_BASE_URL=https://domain` dan `TRUST_PROXY=true` di belakang nginx/Caddy.

Data disimpan sebagai file JSON per event (`DATA_DIR/db/events/{id}.json`, tulis atomic + fsync); foto hanya di R2.
Backup/restore: lihat [docs/SECURITY.md](docs/SECURITY.md#backup-terenkripsi-berotasi-off-server).

> Kamera dan geolocation di HP hanya bisa dipakai lewat HTTPS. Untuk acara, deploy dengan HTTPS (`deploy/deploy.sh user@host domain`).
