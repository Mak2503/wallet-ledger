# Wallet Ledger

A PostgreSQL-backed wallet API with a production-oriented Docker Compose baseline. The Compose stack isolates PostgreSQL on a private bridge network, uses separate administrator and API database roles, mounts passwords as secrets, applies schema migrations before starting the API, and runs the Node process as a non-root user in a read-only container.

## Start locally

To reproduce the complete submission from a clone, with isolated generated secrets, an empty database, the demo dataset, and every acceptance check, run this one command (requires Docker Compose, Node.js 22+, npm, and OpenSSL):

```sh
npm run verify
```

It builds the containers, applies migrations from an empty PostgreSQL volume, starts Postgres, API, and the separate worker, seeds 1,000 users / 2,000 wallets / 100,000 balanced transfers, and runs the stampede, idempotency, reconciliation, risk, and statement prompt-injection acceptance scripts. It then removes only its uniquely named Compose project and database volume. CI runs the same command in [`.github/workflows/ci.yml`](.github/workflows/ci.yml).

The standalone additive demo seed is also available as `npm run seed:demo` after setting up `.env` and applying migrations. Each invocation creates another uniquely identified batch; it does not clear existing rows.

For a persistent local development stack, create two random local secret files and your ignored environment file:

```sh
mkdir -p secrets
openssl rand -hex 32 > secrets/postgres_password
openssl rand -hex 32 > secrets/app_db_password
cp .env.example .env
docker compose up --build -d
```

The database listens on the Docker network. A loopback-only host port (`5433`) is available for local scripts and maintenance. The API is similarly bound to `127.0.0.1:8000` by default. Copy `.env.example` to `.env` for host-side scripts; the example already points to the local secret files. The API role password is distinct from the PostgreSQL administrator password. `docker compose up --build -d` starts the `db`, `migrate`, `api`, and `worker` services.

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

## Wallet, risk, and statement API

All `POST` endpoints require an `Idempotency-Key` UUID. The application stores the request hash and exact result in `api_idempotency_keys`; a matching retry replays the original body, while reuse with a different body returns 422. Errors use `{"code":"...","message":"...","request_id":"..."}`.

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/users` | Create a user |
| POST | `/users/{id}/wallets` | Open a wallet |
| GET | `/wallets/{id}/balance` | Read the cached balance |
| GET | `/wallets/{id}/statement` | Read newest-first ledger entries |
| POST | `/transfers/topup` | Cash-in to a wallet |
| POST | `/transfers` | Wallet-to-wallet transfer |
| POST | `/transfers/withdraw` | Cash-out from a wallet |
| POST | `/transfers/{id}/reverse` | Create a linked reversal |
| GET | `/transfers/{id}` | Read transfer, entries, and status history |
| POST | `/admin/reconciliation/run` | Start a reconciliation run (202) |
| GET | `/admin/reconciliation/runs/{id}` | Read a run report |
| GET | `/admin/risk/queue` | List held transfers and unreviewed flags |
| POST | `/admin/risk/{transfer_id}/decision` | Release or reverse a risk-held transfer |
| POST | `/users/{id}/statement/ask` | Ask a supported statement question in plain English |

All transfer amounts are positive integer paise. Reversals create a new transfer with equal and opposite ledger entries; they do not erase the original. The current API takes user IDs from request paths/bodies and has no authentication; keep it local until authorization is added.

### Fraud rules and measurement

The enabled rules and their thresholds are rows in `risk_rules`, seeded by migration 008:

| Rule | Decision | Query/index support |
| --- | --- | --- |
| More than 5 outgoing transfers from a wallet in 10 minutes | Hold | `transfers_source_created_idx` supports wallet/time lookup; legacy rows use `ledger_account_direction_created_idx` |
| Amount greater than 5 times the wallet's 30-day average outgoing transfer amount | Hold | Same source/time index, plus `ledger_account_direction_created_idx` for legacy ledger-only source discovery |
| First transfer to this payee above ₹10,000 (1,000,000 paise) | Allow and flag | `transfers_source_created_idx` and `transfers_destination_created_idx`; legacy relationship lookup uses `ledger_account_transfer_idx` |

Risk rules execute within the transfer's database transaction before any balance or ledger write. Held transfers are stored with no ledger entries and can be released by an admin after locking both accounts in ascending ID order and checking funds again. A new-payee flag permits the transfer and adds it to the review queue. `transfer_service` measures each enabled rule with `performance.now()` and logs its elapsed milliseconds as `rule_key` and `elapsed_ms`; run `RISK_RULES_ACCEPTANCE=1 npm run acceptance:risk-rules` to print the per-rule timings on the local database. On a small local fixture, warmed queries ranged from 0.60–2.45 ms for velocity, 0.50–1.23 ms for amount spike, and 0.39–0.82 ms for new payee. In the full seeded verification run (100,000 transfers), the three calls measured 18–32 ms, 15–17 ms, and 0.3–150 ms respectively; the last reading was a single outlier. These are per-rule query times, not total request overhead, and vary with data distribution, cache, and load.

The separate `worker` service runs reconciliation daily at 02:00 UTC and then asks the configured LLM to explain outstanding risk flags. It sends the fired rule and the wallet's last 10 transfers as JSON, treats note text as untrusted data, and saves a two-sentence explanation plus `likely_ok`, `review`, or `likely_fraud` in `risk_flags`. Rules determine the action; the model's label is explanatory only. Set `LLM_ENDPOINT`, `LLM_API_KEY`, and optionally `LLM_MODEL` for a JSON endpoint that accepts `{model, system_prompt, input, response_format: "json"}` and returns an `output` value or JSON string in `content`. With no endpoint configured, the mock provider makes a deterministic review explanation so local runs need no key. `LlmJsonProvider` is the provider boundary; `MockLlmProvider` supplies fixed JSON in tests.

Statement Q&A accepts `POST /users/{id}/statement/ask` with a `question`. The provider returns JSON containing a supported type (sent-to-person total, received total, largest transfer, or transfer count) and date range. The service validates it and runs its own parameterized SQL scoped to accounts owned by that user; model output is never SQL. Responses contain paise as a decimal string and the transfer IDs used. Notes are not supplied to the question parser. The acceptance script checks 10 sample questions and an injection phrase in a note, and confirms unrelated users' transfers remain excluded:

```sh
npm run acceptance:statement-qa
```

### Statement pagination

`GET /wallets/{id}/statement?limit=20&offset=0` orders by `created_at DESC, id DESC`; it also returns `next_cursor`. Pass that cursor on the next request to use keyset pagination on `(created_at,id)`. Offset remains available for direct page access.

Run `RECONCILIATION_EXPLAIN_SEED=1 npm run reconciliation:explain` to print `EXPLAIN ANALYZE` for OFFSET 100000 and its cursor equivalent after creating temporary ledger fixtures. On the local 1M-entry ledger, OFFSET scanned 100,020 index entries and took 36.3 ms (2,758 shared buffers); the cursor read 20 entries in 0.24 ms (5 buffers). OFFSET must walk past the first 100,000 matching index entries before returning a page, so its work grows with page depth. The cursor predicate seeks from the last `(created_at,id)` pair and reads roughly the requested page, so it stays efficient at deep positions. Both use `ledger_account_statement_idx`. The API carries the timestamp as PostgreSQL text to preserve microseconds in the cursor.

Every `POST /transfers` requires an `Idempotency-Key` UUID. The user/key pair is unique, and the database stores a SHA-256 hash plus the first HTTP response code and exact serialized body. A new successful request returns 201 Created. Same-key/same-body retries replay that result; a retry while the key is processing returns 409; reusing the key with a different body returns 422. Deterministic business failures are saved too, so retrying an insufficient-funds request does not later perform a transfer under the same key. Processing claims use a fencing token and a one-minute lease so an abandoned claim can be recovered without allowing an old worker to move money afterward.

## Nightly reconciliation

The `worker` service schedules a reconciliation run for 02:00 UTC every day. `POST /admin/reconciliation/run` starts one manually and returns 409 if the database lock is held by another run. Each run locks the `nightly_reconciliation` row in `job_locks` with `FOR UPDATE NOWAIT`, then performs all checks and persists the report in one `REPEATABLE READ` transaction. It only records discrepancies; it never changes ledger entries or account balances. Report metadata is in `reconciliation_reports` and one row per finding is stored in `reconciliation_mismatches` with its check, subject ID, expected value, and actual value.

The million-row `EXPLAIN ANALYZE` run used sequential scans for global totals and per-transfer aggregation, an index-only probe on `ledger_transfer_idx` for transfers without entries, and account index scans for cached-balance and overdraft aggregation. Finding entries without transfers scanned the ledger and probed the transfer primary key. Full-history scans are acceptable nightly; the transfer anti-join needs its index lookup, while summary totals cannot avoid reading all relevant ledger rows.

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

## What I would do next

- Add authentication and authorization, then derive caller identity from verified credentials instead of request-supplied user IDs; protect all `/admin` routes with an administrator role.
- Move database credentials into the deployment platform's secret manager, add TLS at the edge, managed backups, and restore drills before exposing the service outside a development network.
- Add production observability for ledger/reconciliation drift, worker health, database saturation, and risk-rule latency; tune alert thresholds from observed traffic.
- Add retention and privacy policies for notes, idempotency records, risk explanations, and audit data, plus reviewed retention jobs.
- Replace the generic LLM HTTP adapter with a provider-specific adapter and contract tests for timeout, rate-limit, malformed-output, and data-minimization behavior.
