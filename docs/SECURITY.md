# Keamanan & Access Control — Nakha Wedding

Dokumen ini menjelaskan model akses fase awal: **hanya Photobooth yang boleh mengirim foto**, maksimal
**5 foto per perangkat/browser**, hanya saat **event aktif**, pada **jam acara**, dan di dalam **radius lokasi**.
Tidak ada payment gateway pada scope ini.

## 1. Peran & kredensial

| Peran | Cara masuk | Disimpan di server | Cookie | Bisa apa |
| --- | --- | --- | --- | --- |
| Admin | Link rahasia `/<ADMIN_PATH>/` + PIN → `POST /api/admin/login` | hash token sesi | `nk_admin` HttpOnly, Secure, SameSite=Strict, 12 jam | Semua event, host token, jadwal/lokasi/status, audit |
| Host (customer) | Link sekali `GET /host/access?token=…` | **hash** host token + hash token sesi + versi token | `nk_host` HttpOnly, Secure, SameSite=Lax, ≤ 24 jam | Hanya event miliknya: foto, statistik, QR, Live Wall, pause/resume, mode moderasi, hide/restore/delete |
| Layar Live Wall | Link `/slideshow/?k=…` (token HMAC read-only) ditukar ke **sesi display terpisah** | hash token sesi display + `displayVersion` (record `DisplaySession`, bukan `HostSession`) | `nk_display` HttpOnly, Lax | Lihat foto yang tampil di wall + QR aktif. Tidak pernah mewarisi izin host; rotasi link langsung mematikan semua sesi display |
| Tamu | QR cetak (tetap per event) + lokasi valid → `POST /api/guest/checkin` | hash token sesi, hash device ID, jarak & akurasi (dibulatkan) | `nk_guest` HttpOnly, Secure, SameSite=Strict, sampai jendela acara tutup (≤ 12 jam) | Upload ≤ 5 foto untuk event itu saja, lihat galeri event itu (jika visibilitas `GUESTS`/`PUBLIC`) |

* Host token: 32 byte `crypto/rand` (base64url, 43 karakter). Hanya ditampilkan **sekali** (saat event dibuat atau
  token dibuat ulang). Database hanya menyimpan SHA-256-nya.
* `/host/access` menukar token menjadi sesi lalu **redirect 303 ke `/host/`** (token hilang dari address bar/history),
  dengan `Referrer-Policy: no-referrer` dan `Cache-Control: no-store`. Log server tidak pernah mencatat query string.
* Revoke / generate ulang host token menaikkan `hostTokenVersion` → semua sesi host lama langsung tidak valid.
* Semua request yang mengubah data wajib header `X-Nakha-Request: 1` (memaksa preflight CORS) + cek `Origin` → proteksi CSRF.

## 2. Alur QR → geofence → guest session → upload

```
Host dashboard / Live Wall            Tamu (HP)                                   API
──────────────────────────            ─────────                                   ───
GET /api/host/qr ───────────────────────────────────────────────────────────────► selalu tersedia (boleh dicetak sebelum acara)
◄── {url: /photobooth/?qr=<token>, boothOpen, opensAt, closesAt}                   token = HMAC(purpose=guest_checkin, aud,
QR TETAP (bisa dicetak) sampai host “Ganti QR”                                       event_id, qr_version) — tanpa expiry
                                       scan → /photobooth/?qr=…
                                       token dihapus dari URL (history.replaceState)
                                       navigator.geolocation (enableHighAccuracy)
                                       POST /api/guest/checkin ─────────────────► verifikasi signature, purpose, audience,
                                         {qr, deviceId, lat, lng, accuracy, ts}     event & qr_version;
                                                                                    status ACTIVE + jendela waktu;
                                                                                    accuracy ≤ 100 m; Haversine ≤ radius
                                       ◄── Set-Cookie nk_guest ───────────────── buat/rotasi guest_session (event, device)
                                                                                    koordinat mentah dibuang
                                       [ambil foto kamera → bingkai/filter]
                                       POST /api/guest/upload/authorize ─────────► sesi valid, booth terbuka, lokasi segar
                                         {nama, ucapan, filter, type, size,         (lokasi baru dikirim tiap upload; wajib
                                          location}                                 ulang jika > 10 m), rate limit 10/menit;
                                                                                    TRANSAKSI: lepas reservasi kedaluwarsa,
                                                                                    cek uploaded+reserved < 5, reserved++,
                                                                                    reservation (5 m), object key server-side
                                       ◄── presigned PUT (5 m, Content-Type & Content-Length ditandatangani)
                                       PUT foto ──────────────────────────────► bucket privat (R2/S3) / storage lokal
                                       POST /api/guest/upload/complete ──────────► reservasi milik sesi ini? masih PENDING &
                                                                                    belum expired? ukuran sama persis? ≤ 10 MB?
                                                                                    magic bytes = tipe? dimensi wajar? dedup SHA-256
                                                                                    TRANSAKSI: CONFIRMED, reserved--, uploaded++,
                                                                                    foto PROCESSING
                                       ◄── {photo, "3 dari 5 foto telah dikirim"}
                                                                                  worker: validasi ulang, decode, re-encode JPEG
                                                                                  (EXIF/GPS hilang), display 1600 px + thumb 480 px,
                                                                                  hapus file original → READY → SSE photo.published
```

Gagal / batal: client memanggil `POST /api/guest/upload/cancel`; file ditolak → slot dilepas & objek dihapus;
reservasi tak selesai → janitor (tiap 30 detik) melepas slot dan menghapus objek parsial; worker gagal → foto
`FAILED` dan kuota dikembalikan.

Kenapa limit atomic: store menjalankan setiap mutasi di bawah satu mutex lalu menulis file secara atomic
(tmp + rename) — setara transaksi serializable. Test `TestConcurrentAuthorizeNeverExceedsQuota` mengirim 10
authorize bersamaan dan memastikan tepat 5 yang berhasil.

## 3. Persistensi JSON (schema v3)

**Tidak ada satu file database global.** Data dipecah per event:

```
DATA_DIR/                      ← WAJIB volume persisten (disk host / Docker volume)
  db/global.json               default event + sesi admin (kecil)
  db/events/{event_id}.json    1 event: setting, guest session, reservasi, metadata foto, sesi host & display
  audit.log                    JSON Lines, append + fsync per entri
```

* **Biner foto tidak pernah masuk JSON** — hanya object key ke bucket privat R2. Production menolak
  `STORAGE_DRIVER=local`.
* **Tulis atomic & durable**: file sementara di folder yang sama → `fsync` file → `rename` atomic → `fsync`
  folder induk (`internal/fsutil`). Setelah crash/mati listrik, file selalu versi lama utuh atau versi baru utuh.
  Sisa file sementara dibersihkan saat startup.
* **Lock per event**: setiap file event punya mutex sendiri; event A tidak pernah menunggu event B. Mutex global
  hanya menjaga `global.json` dan daftar event. **Tidak ada lock yang dipegang selama request R2, pemrosesan
  gambar, geolocation, atau panggilan jaringan** — paket `store` bahkan tidak mengimpor storage/HTTP; worker
  membaca salinan record, bekerja tanpa lock, lalu commit dalam satu transaksi singkat.
* **Reservasi dipersist (fsync) sebelum presigned URL dibuat** (`ReserveUpload` → baru `PresignPut`).
* Cookie sesi berbentuk `{event_id}.{random}` sehingga server langsung membuka file event yang benar; nilai utuh
  di-hash dan event pada record sesi dicek ulang.
* Saat startup: reservasi kedaluwarsa dilepas **sebelum** menerima request, lalu **orphan sweep** berjalan;
  keduanya diulang berkala (reservasi tiap 30 detik, orphan tiap `ORPHAN_SWEEP_HOURS`). Orphan = objek di
  `events/` yang tidak direferensikan foto aktif, cover, atau reservasi PENDING **dan** lebih tua dari 1 jam (upload
  yang sedang berjalan tidak pernah tersentuh). Daftar objek diambil sebelum snapshot referensi.

### Backup (terenkripsi, berotasi, off-server)

* Snapshot konsisten (setiap file event persis seperti terakhir di-fsync + `audit.log`) → tar.gz →
  **AES-256-GCM** (`BACKUP_ENCRYPTION_KEY`, 32 byte) → bucket terpisah `BACKUP_S3_BUCKET` dengan key
  `backups/nakha-<UTC>.tar.gz.enc`.
* Saat startup, tiap `BACKUP_INTERVAL_HOURS` (default 6), dan saat shutdown normal. Menyimpan
  `BACKUP_RETENTION` versi terbaru (default 28 ≈ 7 hari); yang lebih lama dihapus.
* Production menolak start tanpa bucket backup + kunci. Simpan salinan kunci di luar server (password manager);
  aktifkan versioning/object lock di bucket backup. Foto sendiri sudah di R2 (aktifkan versioning/replikasi di sana).
* Backup manual: `server backup-now`. Restore:
  ```bash
  BACKUP_ENCRYPTION_KEY=… ./server decrypt-backup nakha-20261212T030000Z.tar.gz.enc restore.tar.gz
  systemctl stop nakhawedding && tar -xzf restore.tar.gz -C /var/lib/nakhawedding && systemctl start nakhawedding
  ```

### Volume persisten

systemd (`deploy/deploy.sh`) menyimpan data di `/var/lib/nakhawedding` pada disk host. Bila dijalankan di
container, `DATA_DIR` **harus** di-mount sebagai volume — server mendeteksi container (`/.dockerenv`, cgroup,
Kubernetes) dan, di production, menolak start jika `DATA_DIR` bukan mount point tersendiri:

```yaml
services:
  api:
    image: nakhawedding
    environment: [APP_ENV=production, DATA_DIR=/data]
    volumes: ["nakha-data:/data"]   # atau bind mount: /srv/nakha:/data
volumes: { nakha-data: {} }
```

## 3b. Skema record

```
events
  id, slug, status DRAFT|ACTIVE|PAUSED|ENDED,
  groomName, brideName, groomParent, brideParent, venue, venueAddress, mapsUrl, hashtag, theme, coverKey,
  startAt, endAt, venueLatitude, venueLongitude, locationSet, radiusMeters (default 150),
  moderationMode AUTO_PUBLISH|MANUAL_APPROVAL, galleryVisibility GUESTS|PUBLIC|PRIVATE,
  hostTokenHash, hostTokenVersion, hostTokenIssuedAt, hostTokenRevokedAt,
  qrVersion, displayVersion, createdAt, updatedAt
guestSessions
  id, eventId, deviceIdHash, sessionTokenHash, uploadedCount, reservedCount,
  checkedInAt, lastLocationCheckAt, lastDistanceMeters, lastAccuracyMeters, expiresAt, revokedAt
reservations   (upload_reservation)
  id, eventId, guestSessionId, objectKey, contentType, size, guestName, wishes, filter,
  status PENDING|CONFIRMED|RELEASED, createdAt, expiresAt, closedAt
photos
  id, eventId, guestSessionId, reservationId, guestName, wishes, filter, source,
  status PROCESSING|READY|FAILED, approval APPROVED|PENDING, hiddenFromWall, hiddenFromGallery,
  originalKey, originalType, displayKey, thumbKey, sha256, sizeBytes, width, height, likes,
  createdAt, readyAt, deletedAt
hostSessions     id, eventId, tokenHash, hostTokenVersion, createdAt, expiresAt      (di file event)
displaySessions  id, eventId, tokenHash, displayVersion, createdAt, expiresAt        (di file event)
adminSessions    id, tokenHash, createdAt, expiresAt                                  (global.json)
defaultEventId   event yang tampil di "/" tanpa ?e=slug                               (global.json)
```

`DATA_DIR/audit.log` (JSON Lines, append-only): `id, actorType, actorId, eventId, action, targetId, metadata, createdAt`.
Aksi tercatat: `admin.login`, `admin.login_failed`, `host.login`, `host.access_denied`, `event.create`, `event.update`,
`event.status_change`, `event.schedule_change`, `event.location_change`, `event.radius_change`,
`event.moderation_change`, `event.visibility_change`, `event.pause`, `event.resume`, `event.cover_change`,
`event.set_default`, `host_token.generate`, `host_token.revoke`, `qr.rotate`, `display.rotate`,
`photo.hide`, `photo.restore`, `photo.approve`, `photo.delete`, `migration.cover_import`, `storage.orphan_sweep`.
Metadata tidak pernah berisi token, PIN, atau koordinat tamu (IP disimpan sebagai potongan hash).

### Migrasi ke v3 (otomatis saat start)

`internal/store/migrate.go`. `DATA_DIR/data.json` lama (v1 single-event atau v2 single-file) dipecah menjadi file
per event; `global.json` ditulis paling akhir sebagai penanda migrasi selesai, lalu `data.json` di-rename menjadi
`data.json.pre-v3-<unix>`. Jika migrasi terputus, file event setengah jadi dipindah ke `db/incomplete-<unix>/`
(tidak dihapus) dan migrasi diulang. Khusus v1: data lama (`{event, photos}`) menjadi satu event dengan ID baru, status **DRAFT**,
tanpa koordinat dan tanpa host token, sehingga photobooth terkunci sampai admin mengatur jadwal, lokasi, lalu
mengaktifkan. Foto lama dari `DATA_DIR/uploads/`
disalin ke storage privat dan diproses ulang (EXIF dibuang). Folder `uploads/` **tidak lagi disajikan**; hapus
manual setelah migrasi terverifikasi.

## 4. Storage & file

* Bucket privat S3-compatible (Cloudflare R2 direkomendasikan). Object key selalu dibuat server:
  `events/{event_id}/uploads/{reservation}.jpg` (original, dihapus setelah diproses),
  `events/{event_id}/photos/{photo}.jpg`, `events/{event_id}/thumbs/{photo}.jpg`, `events/{event_id}/covers/{id}.jpg`.
* Presigned PUT 5 menit, `Content-Type` dan `Content-Length` ikut ditandatangani.
* Tipe diizinkan: **JPEG dan PNG** (WebP sengaja ditolak — stdlib Go tidak punya decoder WebP, dan photobooth selalu
  menghasilkan JPEG). Maks 10 MB, cek magic bytes, dimensi 64–10.000 px, ≤ 40 MP.
* Tampil/unduh foto lewat `/api/media/{event_id}/{id}/{display|thumb}?s=&e=&sig=` (HMAC, 15 menit). Setiap request mengecek
  ulang status foto: foto yang di-hide/hapus langsung 404 walau URL-nya masih “segar”. Driver S3 meredirect ke
  presigned GET 60 detik.
* CORS bucket R2 (wajib agar browser bisa PUT):

```json
[{ "AllowedOrigins": ["https://domain-anda"], "AllowedMethods": ["PUT"], "AllowedHeaders": ["content-type"], "MaxAgeSeconds": 600 }]
```

## 5. Endpoint

Publik (read-only):
```
GET  /api/health
GET  /api/public/event?slug=          info undangan (tanpa koordinat/token)
GET  /api/event                       alias event utama (kompatibilitas)
GET  /api/public/events/{slug}/cover  foto sampul
GET  /api/gallery/photos?slug=        sesuai galleryVisibility (GUESTS: wajib guest session event tsb)
POST /api/gallery/photos/{id}/like    hanya jika boleh melihat galeri event foto tsb; 30/IP/menit
GET  /api/stream?scope=gallery|wall|host[&slug=]   SSE per event (payload hanya ID)
GET  /api/media/{event}/{id}/{variant}?s=&e=&sig=  signed URL
POST /api/photos, GET /api/photos     410 UPLOAD_DISABLED (jalur lama dimatikan)
```
Tamu:
```
POST /api/guest/checkin               QR valid + waktu + lokasi; 10/IP/menit
GET  /api/guest/session               kuota & status booth
POST /api/guest/location              validasi ulang lokasi; 10/sesi/menit
POST /api/guest/upload/authorize      10/sesi/menit
POST /api/guest/upload/complete       hanya reservasi milik sesi tsb
POST /api/guest/upload/cancel
PUT  /api/storage/upload?…&sig=       hanya driver lokal (presigned HMAC)
```
Host (cookie `nk_host`, 120 req/sesi/menit):
```
GET  /host/access?token=              tukar token → sesi; 5/IP/menit
GET  /api/host/me | /api/host/stats | /api/host/photos
POST /api/host/photos/{id}/hide|restore|approve   body {target: wall|gallery|both}
DELETE /api/host/photos/{id}
POST /api/host/event/pause | /api/host/event/resume
PUT  /api/host/event/settings         moderationMode, galleryVisibility, radiusMeters, venueLatitude/Longitude
GET  /api/host/qr | POST /api/host/qr/rotate
GET  /api/host/display-link | POST /api/host/display-link/rotate
POST /api/host/logout
```
Live Wall (cookie `nk_display`):
```
POST /api/display/session {k} | GET /api/display/event | /api/display/photos | /api/display/qr
```
Admin (cookie `nk_admin`, login 5/IP/menit + lockout bertahap, endpoint lain 60/IP/menit).
Admin tersembunyi: halaman hanya disajikan di `/<ADMIN_PATH>/` (`noindex`, `no-store`; `/admin` = 404) dan
**setiap** `/api/admin/*` wajib header `X-Nakha-Admin-Key: <ADMIN_PATH>` — tanpa itu jawabannya 404 identik dengan
endpoint yang tidak ada, sehingga form PIN pun tidak bisa dicoba. `ADMIN_PATH` tidak pernah ditulis ke log.
`ADMIN_PATH` kosong = admin mati total. Ini lapisan tambahan; PIN + rate limit tetap berlaku.
```
POST /api/admin/login | /api/admin/logout | GET /api/admin/me
GET|POST /api/admin/events            buat event → hostToken + hostAccessUrl (sekali tampil)
GET|PUT  /api/admin/events/{id}
POST /api/admin/events/{id}/default
POST|DELETE /api/admin/events/{id}/host-token
POST|DELETE /api/admin/events/{id}/cover
GET  /api/admin/events/{id}/photos | stats | qr | display-link
POST /api/admin/events/{id}/photos/{pid}/hide|restore|approve
DELETE /api/admin/events/{id}/photos/{pid}
POST /api/admin/events/{id}/qr/rotate | display-link/rotate
GET  /api/admin/audit?eventId=
```

## 6. Keterbatasan yang perlu diketahui

* **Limit 5 foto adalah per perangkat/browser, bukan per manusia.** Identitas memakai cookie sesi + `device_id`
  acak di localStorage (di-hash per event). Tamu yang menghapus cookie *dan* localStorage, memakai mode
  incognito, atau memakai HP lain akan dianggap perangkat baru. Fingerprinting invasif sengaja tidak dipakai.
* **QR sengaja tetap (tidak berganti) agar bisa dicetak.** Foto QR yang tersebar tetap bisa dibuka, tetapi hanya
  berguna saat event ACTIVE, di dalam jendela waktu acara, dan di dalam radius lokasi; tiap perangkat maks 5 foto.
  Host/admin bisa menekan “Ganti QR” (`qrVersion++`) kapan pun — semua QR cetakan lama langsung mati.
* **Geofence browser bisa dipalsukan** (mock location, emulator). Karena itu digabung dengan jadwal event, status
  event, sesi tamu, kuota, dan rate limit. Ini menaikkan biaya penyalahgunaan, bukan proteksi absolut.
* Link Live Wall dapat mengambil QR aktif agar bisa ditampilkan di proyektor; perlakukan link itu sebagai rahasia
  layar acara dan ganti (`display-link/rotate`) jika tersebar.
* Store JSON (file per event + lock di memori) = **satu instance proses per `DATA_DIR`**. Untuk lebih dari satu
  instance, pindahkan operasi yang sama ke Postgres (`SELECT … FOR UPDATE` pada guest_session) dan rate limit ke Redis.
* Backup hanya mencakup data JSON + audit log; ketahanan foto bergantung pada R2 (aktifkan versioning).
  RPO maksimal = `BACKUP_INTERVAL_HOURS` jika disk server hilang total.
* Rate limit di memori, reset saat restart.
* `COOKIE_SECURE=true` (default) mewajibkan HTTPS — kamera HP juga hanya jalan di HTTPS.
* Galeri `GUESTS` hanya bisa dibuka selama sesi tamu berlaku (sampai jendela acara ditutup). Setelah acara,
  host dapat mengubahnya ke `PUBLIC` bila ingin membagikan galeri.
