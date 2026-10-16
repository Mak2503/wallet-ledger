#!/bin/sh
set -eu
umask 077

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
PROJECT="wallet-ledger-verify-$(date +%s)-$$"
SECRETS_DIR="$ROOT_DIR/.verify-secrets/$PROJECT"
ENV_FILE="$SECRETS_DIR/compose.env"
mkdir -p "$SECRETS_DIR"
openssl rand -hex 32 > "$SECRETS_DIR/postgres_password"
openssl rand -hex 32 > "$SECRETS_DIR/app_db_password"

# Use isolated, randomized loopback ports while test containers communicate over Compose DNS.
BASE_PORT=$((30000 + ($$ % 20000)))
cat > "$ENV_FILE" <<EOF
POSTGRES_PASSWORD_FILE=$SECRETS_DIR/postgres_password
APP_DB_PASSWORD_FILE=$SECRETS_DIR/app_db_password
POSTGRES_HOST_PORT=$BASE_PORT
API_HOST_PORT=$((BASE_PORT + 1))
EOF

cleanup() {
  docker compose --project-name "$PROJECT" --env-file "$ENV_FILE" down --volumes --remove-orphans >/dev/null 2>&1 || true
  rm -f "$SECRETS_DIR/postgres_password" "$SECRETS_DIR/app_db_password" "$ENV_FILE"
  rmdir "$SECRETS_DIR" 2>/dev/null || true
  rmdir "$ROOT_DIR/.verify-secrets" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

cd "$ROOT_DIR"
docker compose --project-name "$PROJECT" --env-file "$ENV_FILE" --profile verify \
  up --build --abort-on-container-exit --exit-code-from verify verify
