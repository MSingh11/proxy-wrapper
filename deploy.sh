#!/usr/bin/env bash
set -euo pipefail

# Simple deployment script for an Ubuntu/Debian VPS.
# Run as root (or with sudo) after copying this project to the server.
#
# Usage:
#   TARGET_URL="https://cineby.sc" PORT=3000 ./deploy.sh
#   # Then visit http://<server-ip>:3000 from Firestick/iPhone/etc.

APP_DIR="/opt/ad-clean-proxy"
SERVICE_NAME="ad-clean-proxy"
NODE_VERSION_SETUP="https://deb.nodesource.com/setup_20.x"

TARGET_URL="${TARGET_URL:-https://cineby.sc}"
PORT="${PORT:-3000}"

echo "[1/6] Installing Node.js..."
apt-get update -y
apt-get install -y curl ca-certificates gnupg
if ! command -v node >/dev/null 2>&1; then
  curl -fsSL "$NODE_VERSION_SETUP" | bash -
  apt-get install -y nodejs
fi

echo "[2/6] Placing application in $APP_DIR..."
rm -rf "$APP_DIR"
mkdir -p "$APP_DIR"
cp -R . "$APP_DIR"
cd "$APP_DIR"

echo "[3/6] Installing production dependencies..."
npm install --production

echo "[4/6] Writing environment config..."
cat >/etc/default/$SERVICE_NAME <<EOF
TARGET_URL=$TARGET_URL
PORT=$PORT
NODE_ENV=production
EOF

echo "[5/6] Creating systemd service..."
cat >/etc/systemd/system/$SERVICE_NAME.service <<EOF
[Unit]
Description=Ad-clean reverse proxy
After=network.target
Wants=network-online.target

[Service]
EnvironmentFile=/etc/default/$SERVICE_NAME
WorkingDirectory=$APP_DIR
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=3
User=root

[Install]
WantedBy=multi-user.target
EOF

echo "[6/6] Enabling and starting service..."
systemctl daemon-reload
systemctl enable --now $SERVICE_NAME
systemctl status --no-pager --full $SERVICE_NAME

echo ""
echo "Deployment complete. Access the proxy at: http://$(curl -4s ifconfig.me):$PORT/"
