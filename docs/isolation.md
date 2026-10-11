# Milestone 2 — Isolation levels lab

Start the database with `docker compose up --build`, then open two terminals and connect both with `docker compose exec db psql -U wallet_admin -d wallet`. Run each case from a clean pair of sessions; `BEGIN` transactions explicitly. The outputs below describe PostgreSQL 16 behavior. These are reproducible observations/instructions; this environment had no running PostgreSQL server, so the commands have not been executed here.

Prepare a user and wallet in either session and note its ID:

```sql
INSERT INTO users(name,email,phone) VALUES ('Isolation demo','iso@example.test','+15550000001') RETURNING id;
INSERT INTO accounts(owner_user_id,kind,name,balance_paise) VALUES (1,'wallet','isolation wallet',50000) RETURNING id;
```

## 1. Read Committed

Session A:

```sql
BEGIN ISOLATION LEVEL READ COMMITTED;
SELECT balance_paise FROM accounts WHERE id = 1;
-- 50000
```

Session B:

```sql
UPDATE accounts SET balance_paise = 40000 WHERE id = 1;
COMMIT;
```

Session A:

```sql
SELECT balance_paise FROM accounts WHERE id = 1;
-- 40000: each statement sees a fresh committed snapshot.
COMMIT;
```

## 2. Repeatable Read

Reset to 50000, then session A:

```sql
BEGIN ISOLATION LEVEL REPEATABLE READ;
SELECT balance_paise FROM accounts WHERE id = 1;
-- 50000
```

Session B updates it to 40000 and commits. Session A repeats the SELECT and still sees 50000, then commits. Repeatable Read keeps one transaction snapshot.

## 3. Serializable

Reset to 50000. In session A:

```sql
BEGIN ISOLATION LEVEL SERIALIZABLE;
SELECT balance_paise FROM accounts WHERE id = 1;
-- 50000
```

In session B, begin Serializable and read the same value. Then have A update the balance to 40000 and commit; have B update it to 30000 and commit. PostgreSQL detects the read/write dependency cycle and aborts one transaction with SQLSTATE `40001`, `could not serialize access due to read/write dependencies among transactions`. Retry the entire aborted transaction.

## 4. Repeatable Read with a join

Reset the wallet balance to 50000 and ensure its owner exists. Session A:

```sql
BEGIN ISOLATION LEVEL REPEATABLE READ;
SELECT a.balance_paise, u.name FROM accounts a JOIN users u ON u.id=a.owner_user_id WHERE a.id=1;
```

Session B updates the account balance and commits. Re-run the join in session A: it still sees the original balance and the same user row. The snapshot applies across all tables in the joined statement and across subsequent statements in this transaction.

## Why the transfer uses Read Committed plus row locks

The API sets `READ COMMITTED` explicitly. It locks both account rows with `SELECT ... WHERE id = ANY(...) ORDER BY id FOR UPDATE`, so concurrent transfers touching either wallet wait. It checks the source balance only after acquiring the locks, updates both cached balances, and inserts transfer and ledger rows in the same transaction. The fixed ascending order avoids the common A→B/B→A deadlock cycle. PostgreSQL's row locks provide the needed serialization for this invariant without Serializable's broader predicate tracking and higher serialization-failure/retry rate. Serializable can reduce throughput under contention and requires retrying the whole transaction on SQLSTATE `40001`; it is not needed for this two-row invariant.

The deliberately unsafe stale-read example is `scripts/broken_transfer.ts`; run it only against a disposable database. It demonstrates a lost update: two requests read 500 paise, both approve a 400 paise send, both write 100, while ledger debits total 800. The guarded TypeScript transfer implementation is `app/main.ts`; see the 20-run acceptance check in `scripts/stampede.ts`.
