# Milestone 1 — Database schema

PostgreSQL 15+ schema, built from an empty database by applying migrations `001` through `009` in order. Migration `001` defines the core nouns; later migrations add idempotency response state, reconciliation, risk, transfer account references, and API-wide idempotency. Money is stored as whole paise in `BIGINT`; no floating point values are used.

## Noun list and table decisions

| Noun | Table? | Reason |
|---|---|---|
| User | `users` | Stores identity/contact fields and KYC state. |
| Wallet / system account | `accounts` | Both are accounts with balances and ledger activity. `kind` distinguishes user wallets from cash-in, cash-out, and fee revenue accounts. |
| Transfer | `transfers` | Stores the business event, amount, lifecycle status, and optional link to the transfer it reverses. |
| Ledger entry | `ledger_entries` | Stores each immutable debit or credit line for an account and transfer. |
| Idempotency key | `idempotency_keys` | Stores one client key per user, request digest, and the original response/transfer association for retry handling. |
| API idempotency key | `api_idempotency_keys` | Stores request digest and exact response for endpoints whose idempotency scope is an API operation or user. |
| Legacy fraud rule / review | `fraud_rules`, `fraud_reviews` | The original schema's fraud rule table remains for compatibility; reviews can refer to either a legacy rule or a current risk rule. |
| Risk rule / review flag | `risk_rules`, `fraud_reviews`, `risk_flags` | Rules configure deterministic transfer decisions; each firing has a review, and the nightly LLM explanation is persisted separately. |
| Transfer status audit | `transfer_status_audit_logs` | Preserves each status transition with actor and timestamp. |
| Reconciliation report / mismatch | `reconciliation_reports`, `reconciliation_mismatches` | A report groups the nightly run; one row per discrepancy preserves what was found. |
| Scheduled job lock | `job_locks` | A named row serializes scheduled and manual reconciliation runs. |
| Migration history | `schema_migrations` | Infrastructure table recording each applied migration filename. |
| Currency | No separate table | INR is the only supported currency and is enforced as a check on accounts. |
| Statement / balance | No separate table | Statement is a query over ledger rows; balance is cached on accounts for fast reads and reconciled against ledger history. |
| Plain-English question / answer | No table | It is a request/response over the user-authorized statement, not persistent domain state in the requirements. |

## Attributes

Domain tables use generated `BIGINT` primary keys named `id`; `job_locks` and `schema_migrations` use stable text keys.

- `users`: `name`, `email`, `phone`, `kyc_status`, `created_at`.
- `accounts`: nullable `owner_user_id`, `kind`, `name`, `currency`, cached `balance_paise`, `created_at`. Wallet rows require an owner; system account rows forbid one. Wallet balances are constrained nonnegative.
- `transfers`: `type`, `status`, positive `amount_paise`, `created_at`, optional `reversal_of_transfer_id`, `source_account_id`, `destination_account_id`, and a bounded user note. Source/destination were added in migration 008; older transfers can have null references.
- `ledger_entries`: `transfer_id`, `account_id`, `direction`, positive `amount_paise`, `created_at`. Direction is separate from amount so stored values remain positive and easy to validate.
- `idempotency_keys`: `user_id`, UUID-formatted `idempotency_key` (stored as text), SHA-256 `request_hash`, `status`, saved `response_code` and exact serialized `response_body`, nullable `transfer_id`, `processing_token` and `processing_since` while processing, `created_at`.
- `fraud_rules`: `name`, `description`, `disposition`, `enabled`, `created_at`.
- `risk_rules`: unique `rule_key`, `name`, `threshold`, optional velocity window or average period, `action`, `enabled`, and description.
- `fraud_reviews`: `transfer_id`, nullable legacy `fraud_rule_id` or current `risk_rule_id`, review `status`, flag/review timestamps, optional reviewer and note.
- `risk_flags`: unique `fraud_review_id`, `transfer_id`, LLM `label`, two-sentence explanation, model name, and timestamp.
- `api_idempotency_keys`: `scope_key`, UUID key, SHA-256 body hash, processing/completed state, saved status/body, timestamps; unique by `(scope_key,idempotency_key)`.
- `transfer_status_audit_logs`: `transfer_id`, old/new status, actor kind and optional user, `changed_at`.
- `reconciliation_reports`: run start/completion, run status, mismatch count and per-check counts.
- `reconciliation_mismatches`: report, mismatch type, optional affected transfer/account, expected/actual paise, details and detection time.
- `job_locks`: `job_name` primary key and creation timestamp; the nightly reconciliation uses `FOR UPDATE NOWAIT`.

## Cardinalities and foreign keys

| Relationship | Cardinality | Foreign key placement |
|---|---|---|
| User — wallet account | 1:M (a user may have many wallets; each wallet has one owner) | `accounts.owner_user_id`; system accounts leave it null. |
| Transfer — ledger entry | 1:0..M; succeeded transfers have at least two lines | `ledger_entries.transfer_id`. Deferred triggers check minimum line count and matching debit/credit totals for successful transfers at commit; held/failed transfers have no money-moving entries. |
| Account — ledger entry | 1:M | `ledger_entries.account_id`. |
| Transfer — reversal | 1:0..M (an original may be reversed; each reversal points to one original) | `transfers.reversal_of_transfer_id`, constrained to reversal transfers only. |
| User — idempotency key | 1:M | `idempotency_keys.user_id`, unique with `idempotency_key`. |
| Idempotency scope — API key | 1:M | `api_idempotency_keys.scope_key`; each scope/key pair is unique. |
| Transfer — idempotency record | 1:0..M | Nullable `idempotency_keys.transfer_id`; a request can be recorded before its transfer is finalized. |
| Transfer — fraud review | 1:M | `fraud_reviews.transfer_id`. |
| Fraud rule — review | 1:M | `fraud_reviews.fraud_rule_id`; together these form the many-to-many relation between transfers and rules. |
| Risk rule — review | 1:M | `fraud_reviews.risk_rule_id`; each transfer can fire multiple risk rules. |
| Fraud review — explanation flag | 1:0..1 | `risk_flags.fraud_review_id` is unique; a flag is created only after the nightly explanation step. |
| Transfer — status audit event | 1:M | `transfer_status_audit_logs.transfer_id`. |
| User — status audit actor | 1:M, optional for system actor | `transfer_status_audit_logs.actor_user_id`. |
| Reconciliation report — mismatch | 1:M | `reconciliation_mismatches.report_id`. |
| Account/transfer — mismatch | 1:M, optional according to mismatch kind | `reconciliation_mismatches.account_id` / `transfer_id`. |

## ER diagram

```mermaid
erDiagram
    USERS ||--o{ ACCOUNTS : owns_wallets
    USERS ||--o{ IDEMPOTENCY_KEYS : submits
    USERS o|--o{ TRANSFER_STATUS_AUDIT_LOGS : acts
    ACCOUNTS ||--o{ LEDGER_ENTRIES : records
    ACCOUNTS o|--o{ TRANSFERS : source_account
    ACCOUNTS o|--o{ TRANSFERS : destination_account
    TRANSFERS ||--o{ LEDGER_ENTRIES : contains
    TRANSFERS o|--o{ TRANSFERS : reversed_by
    TRANSFERS ||--o{ FRAUD_REVIEWS : flagged_for
    FRAUD_RULES ||--o{ FRAUD_REVIEWS : triggers
    RISK_RULES ||--o{ FRAUD_REVIEWS : evaluates
    FRAUD_REVIEWS ||--o| RISK_FLAGS : explained_as
    TRANSFERS ||--o{ TRANSFER_STATUS_AUDIT_LOGS : changes
    TRANSFERS o|--o{ IDEMPOTENCY_KEYS : created_from
    JOB_LOCKS ||--o{ RECONCILIATION_REPORTS : serializes_runs
    RECONCILIATION_REPORTS ||--o{ RECONCILIATION_MISMATCHES : records
    ACCOUNTS o|--o{ RECONCILIATION_MISMATCHES : account_issue
    TRANSFERS o|--o{ RECONCILIATION_MISMATCHES : transfer_issue
```

## Database protections and query indexes

- Ledger amounts must be positive; debit/credit is an enum column. Deferred constraint triggers reject a successful transfer with fewer than two entries or unequal debit and credit totals; held, pending, and failed transfers may have no entries.
- A wallet account must have an owner and a nonnegative cached balance. System accounts have no owner and may be negative.
- A trigger rejects all ledger entry updates and deletes. The application database role should additionally receive only `SELECT` and `INSERT` on this table.
- Transfer idempotency is unique on `(user_id, idempotency_key)`; other POST operations also persist exact responses under `(scope_key,idempotency_key)` in `api_idempotency_keys`.
- Indexes support account statements ordered newest first, locating transfer lines, user account listing, reversal lookup, audit history, pending fraud reviews, and report mismatch retrieval.
- Status updates automatically append an audit event. For a user actor, the transaction must set `SET LOCAL wallet.actor_user_id = '<user id>'`; otherwise the event is attributed to the system.

## Design answers and assumptions

**Balance storage:** Store `accounts.balance_paise` and derive the authoritative balance from ledger entries during reconciliation. Cached balances make frequent balance reads inexpensive, but every money-moving transaction must update the cache atomically with ledger inserts. The cache costs write complexity and can drift after bugs; nightly comparison detects that. Computing every balance from all ledger lines would simplify stored state but make reads increasingly expensive.

**One account table:** A ledger line references one account regardless of whether it is a customer wallet or platform account, so a single `accounts` table gives each line one unambiguous FK and lets common balance/statement queries work uniformly. Account kind and owner nullability distinguish the roles.

**External identifiers:** Email and phone are user-controlled and can change, be mistyped, recycled, or have normalization/privacy concerns. They are useful unique contact attributes, not stable database identities. Generated `users.id` is the primary key and foreign keys use it.

**Assumptions:** All amounts are positive integer paise and each account is INR. There is one system account per system kind. Email and phone are unique in their stored representation. A reversal is a new transfer and never edits original entries. User-facing transfer requests should have an authenticated user for their idempotency scope; the current learning API accepts caller-supplied IDs and has no authentication. Fraud decisions are represented by review rows, while LLM explanations are separate and cannot make a decision. Status actor identity is supplied transaction-locally by the application.
