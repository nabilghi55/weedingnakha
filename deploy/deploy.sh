#!/usr/bin/env bash
# Deploy Nakha Wedding to a Linux VPS without touching other projects on it.
#
#   ./deploy/deploy.sh --check user@host          # read-only inspection, changes nothing
#   ./deploy/deploy.sh user@host [domain]         # build + install / update
#
# Everything lives in its own namespace:
#   user nakhawedding · /opt/nakhawedding · /var/lib/nakhawedding (data)
#   /etc/nakhawedding.env · systemd unit nakhawedding.service
#   listens on 127.0.0.1:<free port> only
# With a domain, ONE new reverse-proxy site file is added (nginx or Caddy),
# validated before reload and removed again if validation fails.
#
# Optional env: PORT (otherwise first free port from 8180), ARCH (amd64|arm64).
# Production needs private R2 storage + off-server encrypted backups. Pass them
# on first install (they are written to /etc/nakhawedding.env, mode 600):
#   S3_ENDPOINT S3_BUCKET S3_ACCESS_KEY_ID S3_SECRET_ACCESS_KEY
#   BACKUP_S3_BUCKET [BACKUP_S3_ACCESS_KEY_ID BACKUP_S3_SECRET_ACCESS_KEY]
# Data (event JSON files + audit log) lives on the host disk in
# /var/lib/nakhawedding — never inside a container layer.
set -euo pipefail

if [ "${1:-}" = "--check" ]; then
  TARGET=${2:?usage: deploy.sh --check user@host}
  ssh "$TARGET" 'bash -s' <<'REMOTE'
echo "== system";   uname -srm; . /etc/os-release 2>/dev/null && echo "$PRETTY_NAME"
echo "== resources"; free -h | head -2; df -h / | tail -1
echo "== listening TCP ports"; (ss -ltnp 2>/dev/null || netstat -ltnp 2>/dev/null) | awk 'NR>1{print $4, $NF}' | sort -u
echo "== proxies";  for b in nginx caddy apache2 httpd traefik certbot docker; do command -v $b >/dev/null && echo "$b: $(command -v $b)"; done
systemctl is-active nginx caddy apache2 2>/dev/null | paste -sd' ' | sed 's/^/active(nginx caddy apache2): /'
echo "== nginx sites"; ls /etc/nginx/sites-enabled /etc/nginx/conf.d 2>/dev/null
echo "== caddy";    [ -f /etc/caddy/Caddyfile ] && grep -E '^[^ #\t].*\{' /etc/caddy/Caddyfile
echo "== running services (custom)"; systemctl list-units --type=service --state=running --no-legend 2>/dev/null | awk '{print $1}' | grep -v -E '^(systemd|dbus|ssh|cron|rsyslog|polkit|snapd|getty|serial|networkd|udisks|unattended|multipathd|irqbalance|ModemManager|packagekit|fwupd|user@|atd|chrony|qemu|containerd|accounts)' || true
echo "== nakhawedding already installed?"; ls -d /opt/nakhawedding /etc/nakhawedding.env 2>/dev/null || echo "no"
REMOTE
  exit 0
fi

TARGET=${1:?usage: deploy.sh user@host [domain]}
DOMAIN=${2:-}
ROOT=$(cd "$(dirname "$0")/.." && pwd)
BUILD=$(mktemp -d)
trap 'rm -rf "$BUILD"' EXIT

ARCH=${ARCH:-$(ssh "$TARGET" uname -m | sed 's/x86_64/amd64/;s/aarch64/arm64/')}
echo "→ building frontend (static export) + Go server for linux/$ARCH"
(cd "$ROOT" && rm -rf out && NEXT_OUTPUT=export npx next build >/dev/null)
(cd "$ROOT/backend" && CGO_ENABLED=0 GOOS=linux GOARCH="$ARCH" go build -trimpath -ldflags='-s -w' -o "$BUILD/nakhawedding-server" .)
cp -r "$ROOT/out" "$BUILD/out"
cp "$ROOT/deploy/nakhawedding.service" "$BUILD/"

echo "→ uploading"
ssh "$TARGET" 'rm -rf /tmp/nakhawedding-upload && mkdir -p /tmp/nakhawedding-upload'
scp -rq "$BUILD/nakhawedding-server" "$BUILD/out" "$BUILD/nakhawedding.service" "$TARGET:/tmp/nakhawedding-upload/"

echo "→ installing"
ssh "$TARGET" WANT_PORT="${PORT:-}" DOMAIN="$DOMAIN" \
  R2_EP="${S3_ENDPOINT:-}" R2_BUCKET="${S3_BUCKET:-}" R2_KEY="${S3_ACCESS_KEY_ID:-}" R2_SECRET="${S3_SECRET_ACCESS_KEY:-}" \
  BK_BUCKET="${BACKUP_S3_BUCKET:-}" BK_KEY="${BACKUP_S3_ACCESS_KEY_ID:-}" BK_SECRET="${BACKUP_S3_SECRET_ACCESS_KEY:-}" \
  'bash -s' <<'REMOTE'
set -euo pipefail
SUDO=$([ "$(id -u)" = 0 ] && echo "" || echo sudo)
U=/tmp/nakhawedding-upload

port_free() { ! (ss -ltn 2>/dev/null || netstat -ltn) | awk '{print $4}' | grep -qE "[:.]$1\$"; }

id nakhawedding >/dev/null 2>&1 || $SUDO useradd --system --home /var/lib/nakhawedding --shell /usr/sbin/nologin nakhawedding
$SUDO mkdir -p /opt/nakhawedding /var/lib/nakhawedding
$SUDO chown nakhawedding:nakhawedding /var/lib/nakhawedding
$SUDO chmod 750 /var/lib/nakhawedding

$SUDO rm -rf /opt/nakhawedding/out.old
$SUDO install -m 644 $U/nakhawedding.service /etc/systemd/system/nakhawedding.service

if [ ! -f /etc/nakhawedding.env ]; then
  P=${WANT_PORT:-}
  if [ -z "$P" ]; then P=8180; while ! port_free $P; do P=$((P+1)); done; fi
  port_free "$P" || { echo "✗ port $P is already in use"; exit 1; }
  PIN=$(( $(od -An -N4 -tu4 /dev/urandom) % 900000 + 100000 ))
  SECRET=$(head -c 48 /dev/urandom | base64 | tr -dc 'A-Za-z0-9')
  BACKUP_KEY=$(head -c 32 /dev/urandom | base64)
  ADMIN_PATH=$(head -c 12 /dev/urandom | od -An -tx1 | tr -d ' \n')
  BASE=""; [ -n "$DOMAIN" ] && BASE="https://$DOMAIN"
  $SUDO tee /etc/nakhawedding.env >/dev/null <<ENV
APP_ENV=production
HOST=127.0.0.1
PORT=$P
DATA_DIR=/var/lib/nakhawedding
STATIC_DIR=/opt/nakhawedding/out
ADMIN_PIN=$PIN
# secret admin console URL: https://domain/<ADMIN_PATH>/ (/admin does not exist)
ADMIN_PATH=$ADMIN_PATH
APP_SECRET=$SECRET
MAX_UPLOAD_MB=10
PUBLIC_BASE_URL=$BASE
ALLOWED_ORIGINS=$BASE
COOKIE_SECURE=true
TRUST_PROXY=true
EVENT_TIMEZONE=Asia/Jakarta
# Photos live only in a private R2 bucket (production refuses local storage).
STORAGE_DRIVER=s3
S3_ENDPOINT=$R2_EP
S3_REGION=auto
S3_BUCKET=$R2_BUCKET
S3_ACCESS_KEY_ID=$R2_KEY
S3_SECRET_ACCESS_KEY=$R2_SECRET
# Encrypted, rotating, off-server backups of the JSON data. KEEP A COPY of
# BACKUP_ENCRYPTION_KEY outside this server — without it backups are unreadable.
BACKUP_S3_BUCKET=$BK_BUCKET
BACKUP_S3_ACCESS_KEY_ID=${BK_KEY:-$R2_KEY}
BACKUP_S3_SECRET_ACCESS_KEY=${BK_SECRET:-$R2_SECRET}
BACKUP_ENCRYPTION_KEY=$BACKUP_KEY
BACKUP_RETENTION=28
BACKUP_INTERVAL_HOURS=6
ORPHAN_SWEEP_HOURS=6
ENV
  $SUDO chmod 600 /etc/nakhawedding.env
  echo "★ ADMIN PIN: $PIN   (tersimpan di /etc/nakhawedding.env)"
  echo "★ ADMIN URL: ${BASE:-http://<server>}/$ADMIN_PATH/   (/admin sengaja 404 — simpan link ini)"
  echo "★ BACKUP_ENCRYPTION_KEY dibuat di /etc/nakhawedding.env — simpan salinannya di password manager."
fi
P=$(grep '^PORT=' /etc/nakhawedding.env | cut -d= -f2)
# upgrade older env files with the settings the access-control release needs
if ! grep -q '^ADMIN_PATH=' /etc/nakhawedding.env; then
  echo "ADMIN_PATH=$(head -c 12 /dev/urandom | od -An -tx1 | tr -d ' \n')" | $SUDO tee -a /etc/nakhawedding.env >/dev/null
fi
grep -q '^TRUST_PROXY=' /etc/nakhawedding.env || echo 'TRUST_PROXY=true' | $SUDO tee -a /etc/nakhawedding.env >/dev/null
if [ -n "$DOMAIN" ] && ! grep -q '^PUBLIC_BASE_URL=' /etc/nakhawedding.env; then
  echo "PUBLIC_BASE_URL=https://$DOMAIN" | $SUDO tee -a /etc/nakhawedding.env >/dev/null
fi

# R2 / backup settings passed on an upgrade are added if the env file lacks them
add_env() { [ -n "$2" ] && ! $SUDO grep -qE "^$1=.+" /etc/nakhawedding.env && echo "$1=$2" | $SUDO tee -a /etc/nakhawedding.env >/dev/null || true; }
add_env STORAGE_DRIVER "$([ -n "$R2_BUCKET" ] && echo s3)"
add_env S3_ENDPOINT "$R2_EP"; add_env S3_REGION "$([ -n "$R2_BUCKET" ] && echo auto)"; add_env S3_BUCKET "$R2_BUCKET"
add_env S3_ACCESS_KEY_ID "$R2_KEY"; add_env S3_SECRET_ACCESS_KEY "$R2_SECRET"
add_env BACKUP_S3_BUCKET "$BK_BUCKET"; add_env BACKUP_S3_ACCESS_KEY_ID "${BK_KEY:-$R2_KEY}"; add_env BACKUP_S3_SECRET_ACCESS_KEY "${BK_SECRET:-$R2_SECRET}"
if [ -n "$BK_BUCKET" ] && ! $SUDO grep -qE '^BACKUP_ENCRYPTION_KEY=.+' /etc/nakhawedding.env; then
  echo "BACKUP_ENCRYPTION_KEY=$(head -c 32 /dev/urandom | base64)" | $SUDO tee -a /etc/nakhawedding.env >/dev/null
  echo "★ BACKUP_ENCRYPTION_KEY dibuat di /etc/nakhawedding.env — simpan salinannya di password manager."
fi

# Checked BEFORE touching the installed site: a refused config leaves the running version untouched.
if $SUDO grep -q '^APP_ENV=production' /etc/nakhawedding.env; then
  # the API refuses to start in production without R2 + off-server backups
  for k in S3_ENDPOINT S3_BUCKET S3_ACCESS_KEY_ID S3_SECRET_ACCESS_KEY BACKUP_S3_BUCKET BACKUP_ENCRYPTION_KEY; do
    if ! $SUDO grep -qE "^$k=.+" /etc/nakhawedding.env; then
      echo "✗ $k kosong di /etc/nakhawedding.env — isi dulu (lihat backend/.env.example), lalu jalankan ulang deploy."
      MISSING=1
    fi
  done
  [ -z "${MISSING:-}" ] || { rm -rf $U; exit 1; }
else
  echo "! MODE UJI (APP_ENV bukan production): foto disimpan privat di disk server ($($SUDO grep -E '^DATA_DIR=' /etc/nakhawedding.env | cut -d= -f2)), TANPA backup off-server."
  echo "  Untuk acara sungguhan: set APP_ENV=production + R2 + backup (lihat backend/.env.example)."
fi

# atomic-ish swap of site + binary
$SUDO rm -rf /opt/nakhawedding/out.new
$SUDO cp -r $U/out /opt/nakhawedding/out.new
$SUDO install -m 755 $U/nakhawedding-server /opt/nakhawedding/nakhawedding-server.new
$SUDO rm -rf /opt/nakhawedding/out.old
[ -d /opt/nakhawedding/out ] && $SUDO mv /opt/nakhawedding/out /opt/nakhawedding/out.old
$SUDO mv /opt/nakhawedding/out.new /opt/nakhawedding/out
$SUDO mv /opt/nakhawedding/nakhawedding-server.new /opt/nakhawedding/nakhawedding-server

$SUDO systemctl daemon-reload
$SUDO systemctl enable nakhawedding >/dev/null 2>&1
$SUDO systemctl restart nakhawedding
for i in 1 2 3 4 5; do curl -fsS "http://127.0.0.1:$P/api/health" >/dev/null 2>&1 && break; sleep 1; done
curl -fsS "http://127.0.0.1:$P/api/health" >/dev/null && echo "✓ nakhawedding running on 127.0.0.1:$P" \
  || { $SUDO journalctl -u nakhawedding -n 30 --no-pager; exit 1; }

if [ -n "$DOMAIN" ]; then
  if command -v nginx >/dev/null && systemctl is-active --quiet nginx; then
    if [ -d /etc/nginx/sites-available ]; then CONF=/etc/nginx/sites-available/nakhawedding.conf; LINK=/etc/nginx/sites-enabled/nakhawedding.conf
    else CONF=/etc/nginx/conf.d/nakhawedding.conf; LINK=""; fi
    if [ ! -f "$CONF" ]; then
      if grep -rqs "server_name[^;]*\b$DOMAIN\b" /etc/nginx/; then echo "✗ $DOMAIN is already used by another nginx site — not touching it"; exit 1; fi
      $SUDO tee "$CONF" >/dev/null <<NGINX
# Nakha Wedding — managed by deploy/deploy.sh
server {
    listen 80;
    listen [::]:80;
    server_name $DOMAIN;
    client_max_body_size 15m;

    location /api/stream {
        proxy_pass http://127.0.0.1:$P;
        proxy_http_version 1.1;
        proxy_set_header Connection "";
        proxy_set_header Host \$host;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 1h;
    }

    location / {
        proxy_pass http://127.0.0.1:$P;
        proxy_set_header Host \$host;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }
}
NGINX
      [ -n "$LINK" ] && $SUDO ln -sf "$CONF" "$LINK"
      if $SUDO nginx -t >/dev/null 2>&1; then
        $SUDO systemctl reload nginx && echo "✓ nginx: http://$DOMAIN"
      else
        $SUDO rm -f "$CONF" ${LINK:+"$LINK"}; echo "✗ nginx config test failed — removed our file, nothing else changed"; $SUDO nginx -t || true; exit 1
      fi
      if command -v certbot >/dev/null; then
        $SUDO certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos --register-unsafely-without-email --redirect >/dev/null 2>&1 \
          && echo "✓ HTTPS: https://$DOMAIN" || echo "! certbot gagal (cek DNS $DOMAIN mengarah ke server ini), situs tetap jalan di http"
      fi
    else
      echo "• nginx site already exists ($CONF), left as is"
    fi
  elif command -v caddy >/dev/null && [ -f /etc/caddy/Caddyfile ]; then
    if ! grep -q "^$DOMAIN" /etc/caddy/Caddyfile; then
      $SUDO cp /etc/caddy/Caddyfile /etc/caddy/Caddyfile.bak-nakhawedding
      printf '\n# Nakha Wedding\n%s {\n\tencode gzip\n\trequest_body {\n\t\tmax_size 15MB\n\t}\n\treverse_proxy 127.0.0.1:%s {\n\t\tflush_interval -1\n\t}\n}\n' "$DOMAIN" "$P" | $SUDO tee -a /etc/caddy/Caddyfile >/dev/null
      if $SUDO caddy validate --config /etc/caddy/Caddyfile >/dev/null 2>&1; then
        $SUDO systemctl reload caddy && echo "✓ Caddy: https://$DOMAIN"
      else
        $SUDO mv /etc/caddy/Caddyfile.bak-nakhawedding /etc/caddy/Caddyfile; echo "✗ Caddyfile invalid — restored backup"; exit 1
      fi
    else
      echo "• Caddy block for $DOMAIN already exists, left as is"
    fi
  else
    echo "! no nginx/Caddy found — app is only on 127.0.0.1:$P"
  fi
fi
rm -rf $U
REMOTE
echo "✓ selesai"
