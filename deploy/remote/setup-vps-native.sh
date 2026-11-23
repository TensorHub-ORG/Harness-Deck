#!/usr/bin/env bash
set -euo pipefail

# Harness-Deck Remote Linux VPS Native (Zero-Docker / Low-RAM 2C2G) Bootstrap Script
# Uses existing Node >= 22 (with built-in node:sqlite) + systemd (~40MB RAM total!)
# Usage: ./setup-vps-native.sh [--with-qq-bridge] [--profile k1]

INSTALL_DIR="$(cd "$(dirname "$0")" && pwd)"
WITH_QQ_BRIDGE=0
WITH_K1=0

for arg in "$@"; do
  case "$arg" in
    --with-qq-bridge) WITH_QQ_BRIDGE=1 ;;
    --profile|k1) WITH_K1=1 ;;
  esac
done

echo "[Harness-Deck Native VPS] Locating Node >= 22 & pnpm..."
export PATH="$PATH:/usr/local/bin"
if [ -d "$HOME/.nvm/versions/node" ]; then
  LATEST_NVM="$(ls -1d "$HOME"/.nvm/versions/node/v2* 2>/dev/null | sort -V | tail -n 1 || true)"
  if [ -n "$LATEST_NVM" ]; then
    export PATH="$LATEST_NVM/bin:$PATH"
  fi
fi

NODE_BIN="$(command -v node || true)"
PNPM_BIN="$(command -v pnpm || true)"
if [ -z "$NODE_BIN" ]; then
  echo "ERROR: node >= 22 not found on VPS."
  exit 1
fi
echo "  Node: $NODE_BIN ($("$NODE_BIN" -v))"

if [ ! -f "$INSTALL_DIR/.env" ]; then
  echo "ERROR: .env not found in $INSTALL_DIR"
  exit 1
fi

set -a
# shellcheck disable=SC1091
source "$INSTALL_DIR/.env"
set +a

RELAY_HOST="${DECK_RELAY_HOST:-127.0.0.1}"
RELAY_PORT="${DECK_RELAY_PORT:-18787}"
DATA_DIR="$INSTALL_DIR/data/mailroom"
mkdir -p "$DATA_DIR"

echo "[Harness-Deck Native VPS] Installing production dependencies..."
cd "$INSTALL_DIR"
if [ -n "$PNPM_BIN" ]; then
  "$PNPM_BIN" install --prod --no-frozen-lockfile || \
    "$PNPM_BIN" install --prod --no-frozen-lockfile --registry=https://registry.npmmirror.com
else
  npm install --omit=dev || npm install --omit=dev --registry=https://registry.npmmirror.com
fi

echo "[Harness-Deck Native VPS] Writing systemd service: harness-deck-relay.service..."
cat > /etc/systemd/system/harness-deck-relay.service <<EOF
[Unit]
Description=Harness-Deck Lightweight Mailroom Relay (HDP v1)
After=network.target

[Service]
Type=simple
WorkingDirectory=$INSTALL_DIR
EnvironmentFile=$INSTALL_DIR/.env
ExecStart=$NODE_BIN --no-warnings $INSTALL_DIR/packages/cli/dist/index.js relay --host $RELAY_HOST --port $RELAY_PORT --data-dir $DATA_DIR
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF

if [ "$WITH_QQ_BRIDGE" -eq 1 ]; then
  echo "[Harness-Deck Native VPS] Writing systemd service: harness-deck-qq-o1.service..."
  cat > /etc/systemd/system/harness-deck-qq-o1.service <<EOF
[Unit]
Description=Harness-Deck QQ Bridge (Kumi O1 - T1 Secretary)
After=network.target harness-deck-relay.service

[Service]
Type=simple
WorkingDirectory=$INSTALL_DIR
EnvironmentFile=$INSTALL_DIR/.env
Environment=DECK_ENDPOINT=http://127.0.0.1:$RELAY_PORT
ExecStart=$NODE_BIN --no-warnings $INSTALL_DIR/packages/cli/dist/index.js qq-bridge --profile o1
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF
fi

systemctl daemon-reload
systemctl enable harness-deck-relay.service
systemctl restart harness-deck-relay.service
if [ "$WITH_QQ_BRIDGE" -eq 1 ]; then
  systemctl enable harness-deck-qq-o1.service
  systemctl restart harness-deck-qq-o1.service
fi

sleep 2
echo "[Harness-Deck Native VPS] Verifying relay health..."
curl -sf "http://127.0.0.1:${RELAY_PORT}/health" && echo ""
systemctl --no-pager --lines=5 status harness-deck-relay.service || true
