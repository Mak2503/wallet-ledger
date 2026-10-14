# Wallet Ledger

A PostgreSQL-backed wallet API with a production-oriented Docker Compose baseline. The Compose stack isolates PostgreSQL on a private bridge network, uses separate administrator and API database roles, mounts passwords as secrets, applies schema migrations before starting the API, and runs the Node process as a non-root user in a read-only container.

## Start locally

Create two random local secret files and your ignored environment file:

```sh
mkdir -p secrets
openssl rand -hex 32 > secrets/postgres_password
openssl rand -hex 32 > secrets/app_db_password
cp .env.example .env
docker compose up --build -d
```

The database listens on the Docker network. A loopback-only host port (`5433`) is available for local scripts and maintenance. The API is similarly bound to `127.0.0.1:8000` by default. Copy `.env.example` to `.env` for host-side scripts; the example already points to the local secret files. The API role password is distinct from the PostgreSQL administrator password.

This stack uses a new `pgdata_prod` volume so it cannot silently reuse the previous development volume and its old credentials. Existing development data is left untouched and is not copied into the new volume. Back up and migrate data deliberately before switching an existing installation.

Check startup with:

```sh
docker compose ps
docker compose logs migrate api
curl http://127.0.0.1:8000/health
```

The PostgreSQL database volume persists across container recreation. Schema changes belong in a new numbered SQL file under `migrations/`; the migration service records applied filenames in `schema_migrations` and runs before the API. Back up the database before applying migrations to valuable data. The Compose secret files are local plaintext files protected by `.gitignore`; for a real deployment, supply secrets through the orchestrator or an external secret manager instead.

## API

`POST /transfers` accepts `user_id`, `source_account_id`, `destination_account_id`, and positive integer `amount_paise`; send a unique `Idempotency-Key` header. It returns the original response for a retry with the same body and rejects reuse with a different body.

The transfer service runs at PostgreSQL `READ COMMITTED`. It commits a processing claim first so concurrent retries can observe it, then performs the money movement and saves the final response in one transaction. That transaction locks both account rows in ascending ID order using `SELECT ... FOR UPDATE`, rechecks the source balance, inserts the transfer, updates both balances, and inserts balanced debit and credit entries. The database commits all money movement and completion writes together or rolls them back together. Row locks cover this two-account invariant without Serializable's broader conflict detection and serialization retries. See [docs/isolation.md](docs/isolation.md).

The server follows MVC with a service layer: `app/routes/` maps URLs to controllers, `app/controllers/` validates HTTP input, `app/services/` coordinates transfer and idempotency workflows, `app/models/` owns database queries, `app/views/` formats HTTP responses, and `app/types/` holds shared interfaces. `app/main.ts` only configures Fastify, health checks, route registration, and shutdown.

Every `POST /transfers` requires an `Idempotency-Key` UUID. The user/key pair is unique, and the database stores a SHA-256 hash plus the first HTTP response code and exact serialized body. A new successful request returns 201 Created. Same-key/same-body retries replay that result; a retry while the key is processing returns 409; reusing the key with a different body returns 422. Deterministic business failures are saved too, so retrying an insufficient-funds request does not later perform a transfer under the same key. Processing claims use a fencing token and a one-minute lease so an abandoned claim can be recovered without allowing an old worker to move money afterward.

## Nightly reconciliation

The API schedules a reconciliation run for 02:00 UTC every day. `POST /admin/reconciliation/run` starts one manually and returns 409 if the database lock is held by another run. Each run locks the `nightly_reconciliation` row in `job_locks` with `FOR UPDATE NOWAIT`, then performs all checks and persists the report in one `REPEATABLE READ` transaction. It only records discrepancies; it never changes ledger entries or account balances. Report metadata is in `reconciliation_reports` and one row per finding is stored in `reconciliation_mismatches` with its check, subject ID, expected value, and actual value.

The million-row `EXPLAIN ANALYZE` run used a parallel sequential scan for global totals, an index scan on `ledger_transfer_idx` for per-transfer totals, and an index-only probe on that same index for transfers without entries. Cached-balance and overdraft aggregation, plus finding entries without a transfer, used full ledger scans; those scans are acceptable nightly and an account index does not help when aggregating every account. The orphan-entry check scans the ledger and probes the transfer primary key. These checks read the full history to prove the books, so indexes help the per-transfer and anti-join lookups without eliminating all scans.

The corruption acceptance scenario inserts 10,000 transfers and intentionally updates/deletes ledger rows. It requires the admin database credentials from `.env`, access to the local API, and is guarded because it uses replication-role trigger bypass while preparing test corruption:

```sh
RECONCILIATION_ACCEPTANCE=1 npm run acceptance:reconciliation
```

Run `RECONCILIATION_EXPLAIN_SEED=1 npm run reconciliation:explain` to temporarily insert one million synthetic ledger entries when needed, execute `EXPLAIN ANALYZE` for each reconciliation query, print the plans and buffer statistics, and remove the benchmark rows. This uses the admin database credentials from `.env` and bypasses ledger triggers only for the temporary fixture.

Run the idempotency acceptance scenarios against a running stack:

```sh
npm run acceptance:idempotency
```

This checks missing/malformed keys, five sequential retries with byte-identical response bodies, ten simultaneous retries, an in-flight 409, and amount mismatch without duplicate ledger entries.

## Concurrency acceptance check

After the Compose services are healthy, run the 20-trial stampede test from the host:

```sh
npm ci
npm run build
npm run stampede
```

It makes 100 concurrent ₹10 sends from a ₹500 wallet per trial and checks for exactly 50 successes, a zero source balance, and equal ledger totals. Host tools load connection settings from `.env`. The deliberately unsafe lost-update demonstration is `npm run broken-transfer`; use it only with a disposable database.

## Reset development data

This clears all wallet rows and resets identity sequences while preserving schema and migration history. It uses the admin secret and requires explicit confirmation:

```sh
RESET_DATABASE=1 npm run reset-db
```

Inspect `.env` first and confirm the configured database is disposable. Never run this against production data.

## Deployment notes

The Compose file is a hardened container baseline, not a complete public payments deployment. The API currently accepts `user_id` in the request body and has no authentication or authorization layer; do not expose it to the internet until that is replaced with verified identity and ownership checks. Terminate TLS at a trusted reverse proxy, expose only the API through that proxy, and keep the database network-private. Add managed backups, restore drills, monitoring, and a migration approval process before handling real funds. For direct external API binding, set `API_HOST_BIND` deliberately and provide TLS at the edge.

## Design decisions

- Cached `accounts.balance_paise` makes balance reads cheap. Ledger entries remain the source used during reconciliation; atomic balance updates are fast but can drift if a write path is wrong.
- Wallets and system accounts share `accounts`, so every ledger entry has one account foreign key. `kind` and nullable owner distinguish the roles.
- Email and phone can change or be recycled, so generated `users.id` is the stable primary key.
- Amounts are whole paise and INR is the only currency. Client writes are idempotent per user.
