#!/bin/sh
set -eu

APP_DB_PASSWORD="$(cat /run/secrets/app_db_password)"
psql --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  --set=ON_ERROR_STOP=1 --set=app_password="$APP_DB_PASSWORD" <<'SQL'
CREATE ROLE wallet_app LOGIN PASSWORD :'app_password';
GRANT CONNECT ON DATABASE wallet TO wallet_app;
GRANT USAGE ON SCHEMA public TO wallet_app;
GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA public TO wallet_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO wallet_app;
ALTER DEFAULT PRIVILEGES FOR ROLE wallet_admin IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE ON TABLES TO wallet_app;
ALTER DEFAULT PRIVILEGES FOR ROLE wallet_admin IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO wallet_app;
SQL
